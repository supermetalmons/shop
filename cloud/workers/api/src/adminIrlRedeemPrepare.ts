import {
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { z } from 'zod';
import {
  getAdminIrlRedeemTargetEligibility,
  isAdminIrlRedeemDropFamily,
  type AdminIrlRedeemTargetKind,
} from '../../../../shared/adminIrlEligibility.js';
import {
  ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER,
  type AdminIrlRedeemPrepareRequest,
  type AdminIrlRedeemPreparedTxResponse,
} from '../../../../shared/contracts.js';
import {
  dasAssetBoxId,
  dasAssetKind,
  dasAssetLooksBurntOrClosed,
  type DasAsset,
} from '../../../../shared/dasAsset.js';
import {
  assetGroupingCollectionMints,
  uniqueAssetGroupingCollectionMint,
} from '../../../../shared/dasAssetCollections.js';
import { normalizeDropId } from '../../../../shared/deploymentCore.js';
import {
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  walletHasAdminIrlRedeemAccess,
} from '../../../../shared/fulfillmentAccess.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import { AdminIrlRedeemPrepareError } from './adminIrlRedeemErrors.js';
import {
  fetchAsset,
  fetchAssetProof,
  loadLatestBlockhash,
  loadLookupTable,
  loadOnchainState,
  loadPendingOpenAccounts,
  parseProof,
  pendingOpenPda,
  receiptDropIdentity,
  type OnchainState,
  type ProviderContext,
} from './adminIrlRedeemOnchain.js';
import {
  type CreateRequestInput,
  createPreparedRequest as createRequest,
  deletePreparedRequestAtRevision,
  loadReceiptMarker,
} from './adminIrlRedeemRequestStore.js';
import { type AdminIrlRedeemRuntime, buildRuntime } from './adminIrlRedeemRuntime.js';
import { classifyAuthenticatedRequestError, withAuthenticatedRequest } from './authenticatedRequest.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';
import {
  isRequestCancellationError,
  isSignalCancellationError,
  raceReadWithSignal,
  readBoundedRequestJson,
  runCriticalRequestOperation,
} from './boundedRequest.js';
import { type ProfileProviderFetch } from './boundedResponse.js';
import { bubblegumTransferV2Ix } from './bubblegum.js';
import { D1CommerceRepository, commerceKeys } from './commerceRepository.js';
import { ProfileReadError, isRecord } from './dataAccess.js';
import { rethrowDeferredWorkRegistrationError, type DeferredWork } from './deferredWork.js';
import { API_DROPS, getApiDrop, type ApiDropConfig } from './dropConfig.js';
import { dropAdminIrlRedeemRequestPath } from './dropPaths.js';
import { apiErrorBody, httpStatusForApiErrorCode, jsonResponse, type ApiErrorLike } from './httpResponse.js';
import { mapWithConcurrency } from './mapWithConcurrency.js';
import {
  assetMatchesReceiptDropIdentity,
  assetMatchesReceiptMetadataIdentity,
  type DecodedReceiptProof,
  receiptMetadataReference,
} from './receiptProof.js';
import {
  type RequestAuthContext,
  isStaffRequestIdentity,
  resolveRequestWallet,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import {
  buildSizedTransaction,
  isTransactionEncodingTooLarge,
  SOLANA_MAX_RAW_TX_BYTES,
} from './solanaTransaction.js';

export const ADMIN_IRL_REDEEM_PREPARE_PATH = '/admin/irl-redeem/prepare';
export { ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER };

const REQUEST_MAX_BYTES = 4096;
const HANDLER_TIMEOUT_MS = 55_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_ITEMS = 32;
const ASSET_FETCH_CONCURRENCY = 4;
const DUMMY_BLOCKHASH = '11111111111111111111111111111111';
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTO_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const AUTO_ID_LENGTH = 20;
const AUTO_ID_RANDOM_LIMIT = 248;
const NAME_POLICY = { metadataNameMode: 'string-only' } as const;
const BURN_POLICY = { missingAssetResult: true, nonBooleanFlagIsBurnt: false } as const;
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);
const ADMIN_IRL_REDEEM_WALLETS = new Set([
  ...FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  ...ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
]);

const requestSchema = z.object({
  owner: z.string().min(1).max(64),
  dropId: z.string().min(1).max(64),
  itemIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_ITEMS),
}).strict();

type AdminIrlRedeemPrepareEnv = Pick<
  Env,
  'HELIUS_API_KEY'
> & Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'OPS_DB'>>;

type CommerceContext = {
  commerceDb?: D1Database;
  nowMs: number;
  repository?: D1CommerceRepository;
  signal: AbortSignal;
  [key: string]: unknown;
};

type PreparedItem = {
  assetId: string;
  kind: 'box' | 'card_receipt';
  refId: number;
};

type AdminIrlRedeemPrepareDependencies = {
  autoId: () => string;
  createCommerceRepository: (db: D1Database) => D1CommerceRepository;
  defer: DeferredWork;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
  getDrop: (dropId: string) => ApiDropConfig | undefined;
  loadBoundWallet: (
    context: CommerceContext,
    db: D1Database | undefined,
    uid: string,
  ) => Promise<string>;
  loadReceiptMarker: (context: CommerceContext, dropId: string, assetId: string) => Promise<boolean>;
  createRequest: (context: CommerceContext, input: CreateRequestInput) => Promise<string>;
  deleteRequest: (context: CommerceContext, path: string, updateTime: string) => Promise<void>;
  fetchAsset: (context: ProviderContext, runtime: AdminIrlRedeemRuntime, assetId: string) => Promise<DasAsset>;
  fetchAssetProof: (context: ProviderContext, runtime: AdminIrlRedeemRuntime, assetId: string) => Promise<Record<string, unknown>>;
  loadOnchainState: (context: ProviderContext, runtime: AdminIrlRedeemRuntime) => Promise<OnchainState>;
  loadPendingOpenAccounts: (context: ProviderContext, runtime: AdminIrlRedeemRuntime, assets: PublicKey[]) => Promise<boolean[]>;
  loadLatestBlockhash: (context: ProviderContext, runtime: AdminIrlRedeemRuntime) => Promise<string>;
  loadLookupTable: (context: ProviderContext, runtime: AdminIrlRedeemRuntime) => Promise<AddressLookupTableAccount[]>;
};

type AdminIrlRedeemPrepareMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type AdminIrlRedeemPrepareResult = {
  response: Response;
  metrics: AdminIrlRedeemPrepareMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
  targetKind?: AdminIrlRedeemTargetKind;
  itemCount?: number;
};

function errorResponse(error: ApiErrorLike): Response {
  return jsonResponse(apiErrorBody(error), httpStatusForApiErrorCode(error.code, 502));
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<AdminIrlRedeemPrepareRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new AdminIrlRedeemPrepareError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Admin IRL redeem request is too large.'
          : 'Invalid Admin IRL redeem request.',
    ),
  });
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new AdminIrlRedeemPrepareError('invalid-argument', 'Invalid Admin IRL redeem request.');
  return parsed.data;
}

function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new AdminIrlRedeemPrepareError('invalid-argument', `Invalid ${label}`);
  }
}

function clusterSharesCollectionMint(runtime: AdminIrlRedeemRuntime): boolean {
  return Object.values(API_DROPS).filter((config) =>
    config.solanaCluster === runtime.cluster && config.collectionMint === runtime.collectionMint.toBase58()
  ).length > 1;
}

function assertSupportedRuntime(runtime: AdminIrlRedeemRuntime): void {
  if (!isAdminIrlRedeemDropFamily(runtime.config.dropFamily)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem is only available for card_nft_2 packs.');
  }
  if (runtime.itemsPerBox < 1) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem requires pack-based drops.');
  }
  if (clusterSharesCollectionMint(runtime)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem cannot be disambiguated for a shared collection mint.');
  }
}

async function loadBoundWallet(
  context: CommerceContext,
  db: D1Database | undefined,
  uid: string,
): Promise<string> {
  try {
    if (!db) {
      throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem preparation is temporarily unavailable.');
    }
    const resolution = await resolveD1AuthWalletBinding(db, uid, context.signal);
    if ('reason' in resolution) throw new AdminIrlRedeemPrepareError('unauthenticated', 'Sign in with your wallet first.');
    return resolution.wallet;
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (
      error instanceof AdminIrlRedeemPrepareError ||
      error instanceof ProfileReadError
    ) throw error;
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem preparation is temporarily unavailable.');
  }
}

async function deleteRequest(context: CommerceContext, path: string, updateTime: string): Promise<void> {
  const match = /^drops\/([^/]+)\/adminIrlRedeemRequests\/([^/]+)$/.exec(path);
  if (!match) throw new AdminIrlRedeemPrepareError('internal', 'Admin IRL redeem preparation failed.');
  await deletePreparedRequestAtRevision(context, commerceKeys.adminIrlRedeemRequest(match[1], match[2]), updateTime);
}

function commerceAutoId(): string {
  let id = '';
  while (id.length < AUTO_ID_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(AUTO_ID_LENGTH * 2));
    for (const byte of bytes) {
      if (byte >= AUTO_ID_RANDOM_LIMIT) continue;
      id += AUTO_ID_ALPHABET[byte % AUTO_ID_ALPHABET.length];
      if (id.length === AUTO_ID_LENGTH) break;
    }
  }
  return id;
}

function coreTransferInstruction(args: {
  asset: PublicKey;
  coreCollection: PublicKey;
  owner: PublicKey;
  admin: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: args.asset, isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
      { pubkey: args.admin, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([14, 0]),
  });
}

function cardReceiptTransferInstruction(
  proof: DecodedReceiptProof,
  owner: PublicKey,
  admin: PublicKey,
  coreCollection: PublicKey,
): TransactionInstruction {
  return bubblegumTransferV2Ix({
    bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
    mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
    mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    treeConfig: PublicKey.findProgramAddressSync([proof.merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0],
    payer: owner,
    authority: owner,
    leafOwner: proof.leafOwner,
    leafDelegate: proof.leafDelegate,
    newLeafOwner: admin,
    merkleTree: proof.merkleTree,
    coreCollection,
    root: proof.root,
    dataHash: proof.dataHash,
    creatorHash: proof.creatorHash,
    assetDataHash: proof.assetDataHash,
    flags: proof.flags,
    nonce: proof.nonce,
    index: proof.index,
    proof: proof.proofAccounts,
  });
}

function buildTransaction(
  instructions: TransactionInstruction[],
  owner: PublicKey,
  blockhash: string,
  lookups: AddressLookupTableAccount[] = [],
): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookups));
}

function serializePackTransaction(
  instructions: TransactionInstruction[],
  owner: PublicKey,
  blockhash: string,
): Uint8Array {
  try {
    const raw = buildTransaction(instructions, owner, blockhash).serialize();
    if (raw.length <= SOLANA_MAX_RAW_TX_BYTES) return raw;
    throw new AdminIrlRedeemPrepareError(
      'failed-precondition',
      `Admin IRL redeem transfer transaction too large (${raw.length} bytes > ${SOLANA_MAX_RAW_TX_BYTES}). Try fewer packs.`,
      { rawBytes: raw.length, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES },
    );
  } catch (error) {
    if (error instanceof AdminIrlRedeemPrepareError) throw error;
    if (!isTransactionEncodingTooLarge(error)) throw error;
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem transfer transaction is too large to encode. Try fewer packs.');
  }
}

async function serializeCardTransaction(args: {
  context: ProviderContext;
  runtime: AdminIrlRedeemRuntime;
  owner: PublicKey;
  blockhash: string;
  instruction: TransactionInstruction;
  loadLookupTable: AdminIrlRedeemPrepareDependencies['loadLookupTable'];
}): Promise<Uint8Array> {
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), args.instruction];
  const { raw } = await buildSizedTransaction({
    build: (lookups) => buildTransaction(instructions, args.owner, args.blockhash, lookups),
    loadLookupTables: () => args.loadLookupTable(args.context, args.runtime),
    signal: args.context.signal,
    encodingError: () => new AdminIrlRedeemPrepareError(
      'failed-precondition',
      'Admin IRL card receipt transfer is too large to encode.',
    ),
    packetSizeError: (rawBytes) => new AdminIrlRedeemPrepareError(
      'failed-precondition',
      `Admin IRL card receipt transfer transaction too large (${rawBytes} bytes > ${SOLANA_MAX_RAW_TX_BYTES}).`,
      { rawBytes, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES },
    ),
  });
  return raw;
}

async function prepareAdminIrlRedeem(args: {
  body: AdminIrlRedeemPrepareRequest;
  db: D1Database | undefined;
  identity: RequestIdentity;
  commerceContext: CommerceContext;
  providerContext: ProviderContext;
  dependencies: AdminIrlRedeemPrepareDependencies;
  runCritical: <T>(start: () => Promise<T>) => Promise<T>;
  runRead: <T>(operation: Promise<T>) => Promise<T>;
  prepareAttemptId?: string;
}): Promise<AdminIrlRedeemPreparedTxResponse> {
  const dropId = normalizeDropId(args.body.dropId);
  const config = args.dependencies.getDrop(dropId);
  if (!config) throw new AdminIrlRedeemPrepareError('invalid-argument', `Unsupported dropId: ${dropId}`);
  const runtime = buildRuntime(config);
  assertSupportedRuntime(runtime);
  const owner = canonicalPublicKey(args.body.owner, 'wallet address');
  const ownerWallet = owner.toBase58();
  const sessionWallet = await resolveRequestWallet(
    args.identity,
    (uid) => args.runRead(args.dependencies.loadBoundWallet(args.commerceContext, args.db, uid)),
  );
  if (!walletHasAdminIrlRedeemAccess(sessionWallet, ADMIN_IRL_REDEEM_WALLETS)) {
    throw new AdminIrlRedeemPrepareError('permission-denied', 'Admin IRL Redeem access denied.');
  }
  if (sessionWallet !== ownerWallet) throw new AdminIrlRedeemPrepareError('permission-denied', 'Owners only');
  const itemIds = args.body.itemIds.map((itemId) => canonicalPublicKey(itemId, 'asset id').toBase58());
  if (new Set(itemIds).size !== itemIds.length) {
    throw new AdminIrlRedeemPrepareError('invalid-argument', 'Duplicate itemIds are not allowed');
  }

  const onchain = await args.dependencies.loadOnchainState(args.providerContext, runtime);
  const assets = await mapWithConcurrency(itemIds, ASSET_FETCH_CONCURRENCY, (assetId, _index, signal) =>
    args.dependencies.fetchAsset({ ...args.providerContext, signal }, runtime, assetId),
  { signal: args.providerContext.signal });
  const kinds = assets.map((asset) => dasAssetKind(asset, NAME_POLICY));
  const targetKind: AdminIrlRedeemTargetKind = kinds.some((kind) => kind === 'certificate')
    ? 'card_receipt'
    : 'pack';
  const eligibility = getAdminIrlRedeemTargetEligibility({ targetKind, itemCount: assets.length });
  if (!eligibility.eligible || (targetKind === 'card_receipt' && kinds[0] !== 'certificate')) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem supports one card receipt at a time and cannot mix item types');
  }

  const preparedItems: PreparedItem[] = assets.map((asset, index) => {
    const assetId = itemIds[index];
    if (dasAssetLooksBurntOrClosed(asset, BURN_POLICY)) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Item is no longer transferable');
    }
    const indexedId = typeof asset.id === 'string' ? asset.id : '';
    const indexedOwner = isRecord(asset.ownership) ? asset.ownership.owner : undefined;
    if (indexedId !== assetId || indexedOwner !== ownerWallet) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Item not owned by wallet');
    }
    const kind = kinds[index];
    if (kind === 'certificate') {
      const reference = receiptMetadataReference(asset);
      const refId = reference?.kind === 'figure' ? reference.id : 0;
      if (
        !assetMatchesReceiptMetadataIdentity(asset, receiptDropIdentity(runtime), { kind: 'figure', id: refId }) ||
        !Number.isInteger(refId) ||
        refId <= 0 ||
        refId > runtime.maxDudeId
      ) {
        throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem receipt must be a card receipt with a valid figure id');
      }
      return { assetId, kind: 'card_receipt', refId };
    }
    if (
      kind !== 'box' ||
      uniqueAssetGroupingCollectionMint(asset) !== runtime.collectionMint.toBase58() ||
      clusterSharesCollectionMint(runtime)
    ) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Item does not belong to the requested drop', {
        assetGroupingCollectionMints: assetGroupingCollectionMints(asset),
        dropId,
      });
    }
    const refId = Number(dasAssetBoxId(asset, NAME_POLICY));
    if (!Number.isInteger(refId) || refId <= 0 || refId > 0xffff_ffff) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Box id missing from metadata');
    }
    return { assetId, kind: 'box', refId };
  });
  if (new Set(preparedItems.map((item) => item.refId)).size !== preparedItems.length) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Duplicate box ids are not allowed');
  }

  let raw: Uint8Array;
  if (targetKind === 'pack') {
    const assetKeys = itemIds.map((assetId) => new PublicKey(assetId));
    const pending = await args.dependencies.loadPendingOpenAccounts(args.providerContext, runtime, assetKeys);
    const pendingIndex = pending.findIndex(Boolean);
    if (pendingIndex >= 0) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Pending reveal packs cannot be redeemed for Admin IRL events', {
        assetId: itemIds[pendingIndex],
        pending: pendingOpenPda(runtime, assetKeys[pendingIndex]).toBase58(),
      });
    }
    const transfers = assetKeys.map((asset) => coreTransferInstruction({
      asset,
      coreCollection: onchain.coreCollection,
      owner,
      admin: onchain.admin,
    }));
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...transfers];
    try {
      const size = buildTransaction(instructions, owner, DUMMY_BLOCKHASH).serialize().length;
      if (size > SOLANA_MAX_RAW_TX_BYTES) {
        let maxFit = 0;
        for (let count = transfers.length - 1; count >= 1; count -= 1) {
          try {
            if (buildTransaction(
              [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...transfers.slice(0, count)],
              owner,
              DUMMY_BLOCKHASH,
            ).serialize().length <= SOLANA_MAX_RAW_TX_BYTES) {
              maxFit = count;
              break;
            }
          } catch {
            continue;
          }
        }
        throw new AdminIrlRedeemPrepareError(
          'failed-precondition',
          `Admin IRL redeem transfer transaction too large (${size} bytes > ${SOLANA_MAX_RAW_TX_BYTES}). Try fewer packs.${maxFit ? ` Estimated max that fits: ${maxFit}.` : ' Try 1 pack.'}`,
          { rawBytes: size, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES, items: transfers.length, maxFit },
        );
      }
    } catch (error) {
      if (error instanceof AdminIrlRedeemPrepareError) throw error;
      if (!isTransactionEncodingTooLarge(error)) throw error;
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem transfer transaction is too large to encode. Try fewer packs.');
    }
    const blockhash = await args.dependencies.loadLatestBlockhash(args.providerContext, runtime);
    raw = serializePackTransaction(instructions, owner, blockhash);
  } else {
    const assetId = itemIds[0];
    if (await args.runRead(args.dependencies.loadReceiptMarker(args.commerceContext, dropId, assetId))) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'This card receipt has already been redeemed for an Admin IRL order');
    }
    const proof = await args.dependencies.fetchAssetProof(args.providerContext, runtime, assetId);
    const expected = { kind: 'figure' as const, id: preparedItems[0].refId };
    if (!assetMatchesReceiptDropIdentity(assets[0], proof, receiptDropIdentity(runtime), expected)) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Receipt does not belong to the configured receipts tree');
    }
    const proofContext = parseProof(assets[0], proof, runtime, ownerWallet);
    const blockhash = await args.dependencies.loadLatestBlockhash(args.providerContext, runtime);
    raw = await serializeCardTransaction({
      context: args.providerContext,
      runtime,
      owner,
      blockhash,
      instruction: cardReceiptTransferInstruction(proofContext, owner, onchain.admin, onchain.coreCollection),
      loadLookupTable: args.dependencies.loadLookupTable,
    });
  }

  const requestId = args.dependencies.autoId();
  const requestPath = dropAdminIrlRedeemRequestPath(dropId, requestId);
  const cleanupCreatedRequest = async (updateTime: string): Promise<void> => {
    try {
      await args.dependencies.deleteRequest({
        ...args.commerceContext,
        nowMs: args.dependencies.nowMs(),
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      }, requestPath, updateTime);
    } catch (cleanupError) {
      rethrowDeferredWorkRegistrationError(cleanupError);
      console.error({
        event: 'admin_irl_redeem_prepare_cleanup_failed',
        dropId,
        requestId,
        error: cleanupError instanceof Error
          ? { name: cleanupError.name, message: cleanupError.message }
          : { name: 'UnknownError' },
      });
    }
  };
  args.commerceContext.signal.throwIfAborted();
  const updateTime = await args.runCritical(async () => {
    const createdAt = await args.dependencies.createRequest(args.commerceContext, {
      requestId,
      dropId,
      owner: ownerWallet,
      targetKind,
      adminWallet: onchain.admin.toBase58(),
      itemIds,
      items: preparedItems,
      ...(args.prepareAttemptId ? { prepareAttemptId: args.prepareAttemptId } : {}),
    });
    if (args.commerceContext.signal.aborted) {
      await cleanupCreatedRequest(createdAt);
      throw args.commerceContext.signal.reason;
    }
    return createdAt;
  });
  if (args.commerceContext.signal.aborted) {
    await cleanupCreatedRequest(updateTime);
    throw args.commerceContext.signal.reason;
  }
  return {
    encodedTx: Buffer.from(raw).toString('base64'),
    requestId,
    dropId,
    adminWallet: onchain.admin.toBase58(),
    itemCount: itemIds.length,
    targetKind,
  };
}

const defaultDependencies: AdminIrlRedeemPrepareDependencies = {
  autoId: commerceAutoId,
  createCommerceRepository: (db) => new D1CommerceRepository(db),
  defer: () => undefined,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
  getDrop: getApiDrop,
  loadBoundWallet,
  loadReceiptMarker,
  createRequest,
  deleteRequest,
  fetchAsset,
  fetchAssetProof,
  loadOnchainState,
  loadPendingOpenAccounts,
  loadLatestBlockhash,
  loadLookupTable,
};

export async function handleAdminIrlRedeemPrepare(
  request: Request,
  env: AdminIrlRedeemPrepareEnv,
  authContext: RequestAuthContext = {},
  overrides: Partial<AdminIrlRedeemPrepareDependencies> = {},
): Promise<AdminIrlRedeemPrepareResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new AdminIrlRedeemPrepareError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { headers: response.headers, status: 405 }),
      metrics: { upstreamCalls: 0, providerDurationMs: 0 },
      authOutcome: 'rejected',
    };
  }
  return withAuthenticatedRequest<AdminIrlRedeemPrepareResult>(request, {
    authContext,
    opsDb: env.OPS_DB,
    timeoutMessage: 'Admin IRL redeem preparation timed out',
    dependencies,
  }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    let identity: RequestIdentity | undefined;
    let dropId: string | undefined;
    let targetKind: AdminIrlRedeemTargetKind | undefined;
    let itemCount: number | undefined;
    try {
      const body = await readRequestBody(request, deadline.signal);
      dropId = normalizeDropId(body.dropId);
      itemCount = body.itemIds.length;
      identity = await authenticate();
      if (!isStaffRequestIdentity(identity)) {
        throw new AdminIrlRedeemPrepareError('unauthenticated', 'Staff wallet authentication is required.');
      }
      const apiKey = String(env.HELIUS_API_KEY || '').trim();
      if (!apiKey) {
        throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem preparation is temporarily unavailable.');
      }
      const prepareAttemptId = request.headers.get(ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER)?.trim();
      if (prepareAttemptId && !ATTEMPT_ID_PATTERN.test(prepareAttemptId)) {
        throw new AdminIrlRedeemPrepareError('invalid-argument', 'Invalid Admin IRL redeem preparation attempt.');
      }
      const nowMs = dependencies.nowMs();
      const response = await prepareAdminIrlRedeem({
        body,
        db: env.OPS_DB,
        identity,
        dependencies,
        runCritical: (start) => runCriticalRequestOperation(start, {
          deadline,
          defer: dependencies.defer,
          ignoreDeferredErrors: true,
        }),
        runRead: (operation) => raceReadWithSignal(operation, deadline.signal),
        ...(prepareAttemptId ? { prepareAttemptId } : {}),
        commerceContext: {
          nowMs,
          repository: dependencies.createCommerceRepository(env.COMMERCE_DB),
          signal: deadline.signal,
        },
        providerContext: {
          apiKey,
          providerFetch: trackedFetch,
          signal: deadline.signal,
        },
      });
      targetKind = response.targetKind;
      return {
        response: jsonResponse(response, 200),
        metrics,
        authOutcome: 'accepted',
        dropId: response.dropId,
        targetKind,
        itemCount: response.itemCount,
      };
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      if (isRequestCancellationError(request, error)) throw error;
      const { error: prepareError, authOutcome, unexpected } = classifyAuthenticatedRequestError(error, {
        authenticated: Boolean(identity),
        timedOut: deadline.timedOut(),
        timeoutPrecedence: 'before-known-errors',
        timeoutMessage: 'Admin IRL redeem preparation timed out.',
        internalMessage: 'Admin IRL redeem preparation failed.',
        mapDomainError: (failure) => failure instanceof AdminIrlRedeemPrepareError ? { error: failure } : undefined,
      });
      if (unexpected) {
        console.error({
          event: 'admin_irl_redeem_prepare_failed',
          error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
        });
      }
      return {
        response: errorResponse(prepareError),
        metrics,
        authOutcome,
        ...(dropId ? { dropId } : {}),
        ...(targetKind ? { targetKind } : {}),
        ...(itemCount === undefined ? {} : { itemCount }),
      };
    }
  });
}

export const adminIrlRedeemPrepareTestHooks = {
  assertSupportedRuntime,
  cardReceiptTransferInstruction,
  coreTransferInstruction,
  createRequest,
  deleteRequest,
  commerceAutoId,
  loadReceiptMarker,
  loadBoundWallet,
  prepareAdminIrlRedeem,
  serializeCardTransaction,
  serializePackTransaction,
};
