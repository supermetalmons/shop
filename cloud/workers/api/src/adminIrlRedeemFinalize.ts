import {
  type FinalizeRequest,
  type AdminIrlRedeemFinalizeResponse,
  type AdminIrlRedeemFinalizeWorkflowExecutionV1,
  type AdminIrlRedeemFinalizeWorkflowPublicationDraftV1,
  type InternalDelivery,
  MAX_DELIVERY_ALLOCATION_ATTEMPTS,
  type PendingFinalizeSubmission,
  type RequestItem,
  type StartedRequest,
  completeResponse,
  finalizeRequestOwner,
  normalizeItems,
  normalizePendingFinalizeSubmission,
  normalizeReceiptTxs,
  validateWorkflowCompletion,
  validateWorkflowDraftForRequest,
} from './adminIrlRedeemRequestState.js';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import { dasAssetBoxId } from '../../../../shared/dasAsset.js';
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../../../../shared/dasAssetCollections.js';
import {
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  walletHasAdminIrlRedeemAccess,
} from '../../../../shared/fulfillmentAccess.js';
import { heliusSearchAssetsHasNextPage, heliusSearchAssetsItems } from '../../../../shared/heliusDas.js';
import {
  MPL_CORE_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import {
  adminIrlCardReceiptProofHasIdentity,
  classifyAdminIrlCardReceiptLookupError,
} from './adminIrlCardReceipt.js';
import { getAdminIrlRedeemUnsupportedReason, type AdminIrlRedeemBoxBaseInput } from './adminIrlRedeem.js';
import { PendingFinalizeSubmissionError } from './adminIrlRedeemErrors.js';
import {
  AdminIrlRedeemFinalizeError,
  WORKFLOW_EXECUTION_FIELD,
  adminIrlRedeemFinalizeOperationIdForWallet,
  canonicalPublicKey,
  canonicalSignature,
  type AdminIrlRedeemFinalizeErrorCode,
  type AdminIrlRedeemFinalizeWorkflowError,
  type AdminIrlRedeemFinalizeWorkflowPayload,
  type AdminIrlRedeemFinalizeWorkflowResultReference,
} from './adminIrlRedeemFinalizeWorkflowState.js';
import {
  receiptDropIdentity as adminIrlRedeemReceiptDropIdentity,
  rpcCall as adminIrlRedeemRpcCall,
  buildRuntime as buildAdminIrlRedeemRuntime,
  fetchAsset as fetchAdminIrlRedeemAsset,
  fetchAssetProof as fetchAdminIrlRedeemAssetProof,
  parseProof as parseAdminIrlRedeemProof,
  type ProviderContext,
} from './adminIrlRedeemOnchain.js';
import {
  completeFromExistingMarkers,
  publishCard,
  publishPack,
  reusableExistingMarkerState,
} from './adminIrlRedeemPublicationStore.js';
import {
  cleanupContext,
  enterWorkflow,
  holdPendingFinalizeSubmission,
  pendingFinalizeSubmissionAlreadySettled,
  persistPendingFinalizeSubmission,
  persistWorkflowDraft,
  persistWorkflowOnchain,
  recordCloseDelivery,
  recordInternalDelivery,
  recordWorkflowFailure,
  settlePendingFinalizeSubmission,
  startFinalize,
} from './adminIrlRedeemRequestStore.js';
import { isSignalCancellationError, readBoundedRequestJson, sleepWithSignal } from './boundedRequest.js';
import { D1CommerceRepository, commerceKeys } from './commerceRepository.js';
import {
  readCommerceRecord,
  requireCommerceKey,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import { ProfileReadError, isRecord } from './dataAccess.js';
import { assignDudesForBox } from './deliveryDudeAssignments.js';
import { projectPendingDeliveryPackStatus } from './deliveryPackStatusOutbox.js';
import { secureRandomInt } from './deliveryRandom.js';
import { mapWithConcurrency } from './mapWithConcurrency.js';
import {
  DeliveryReceiptError,
  buildTransaction as buildDeliveryTransaction,
  closeDeliveryInstruction,
  decodeCosigner,
  deriveDeliveryPda,
  fetchOnchainConfig as fetchDeliveryOnchainConfig,
  mintReceiptsInstruction,
  sendAndConfirmSignedTransaction,
} from './deliveryReceiptOnchain.js';
import { API_DROPS, type ApiDropConfig } from './dropConfig.js';
import { dropAdminIrlRedeemRequestPath } from './dropPaths.js';
import { assetMatchesReceiptDropIdentity, assetMatchesReceiptMetadataIdentity } from './receiptProof.js';
import {
  bubblegumReceiptAssetIds,
  coreTransferAssetIds,
  matchingReceiptTransferCount,
} from './receiptTransferVerification.js';
import { isStaffRequestIdentity, type RequestIdentity } from './requestIdentity.js';
import { createSolanaConnection } from './solanaConnection.js';
import {
  probeTransactionSubmission,
  type TransactionSubmissionOutcome,
} from './transactionSubmissionRecovery.js';

export const ADMIN_IRL_REDEEM_FINALIZE_PATH = '/admin/irl-redeem/finalize';

const REQUEST_MAX_BYTES = 4096;
const RECEIPT_INDEX_MAX_WAIT_MS = 30_000;
const RECEIPT_INDEX_POLL_MS = 2_000;
const HELIUS_ASSET_PAGE_LIMIT = 1000;
const HELIUS_ASSET_MAX_PAGES = 64;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const DUMMY_BLOCKHASH = '11111111111111111111111111111111';
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
const NAME_POLICY = { metadataNameMode: 'string-only' } as const;
const ADMIN_WALLETS = new Set([
  ...FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  ...ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
].map((wallet) => new PublicKey(wallet).toBase58()));

const requestSchema = z.object({
  requestId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
  dropId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  transferSignature: z.string().min(64).max(128).regex(/^[1-9A-HJ-NP-Za-km-z]+$/)
    .refine((value) => canonicalSignature(value) === value),
}).strict();

export type AdminIrlRedeemFinalizeRequest = FinalizeRequest;
type CommerceContext = CommerceRepositoryContext & {
  dataDb?: D1Database;
  providerFetch: typeof fetch;
  [key: string]: unknown;
};
type Runtime = ReturnType<typeof buildAdminIrlRedeemRuntime>;
type OnchainConfig = Awaited<ReturnType<typeof fetchDeliveryOnchainConfig>>;

export type AdminIrlRedeemFinalizeWorkflowPhaseResult = Readonly<{
  status: 'ready' | 'drafted' | 'complete';
}>;

type AdminIrlRedeemFinalizeWorkflowEnv = Pick<
  Env,
  'COMMERCE_DB' | 'COSIGNER_SECRET' | 'HELIUS_API_KEY'
> & Partial<Pick<Env, 'DATA_DB'>>;

export type AdminIrlRedeemFinalizeWorkflowStageArgs = Readonly<{
  env: AdminIrlRedeemFinalizeWorkflowEnv;
  operationId: string;
  payload: AdminIrlRedeemFinalizeWorkflowPayload;
  signal: AbortSignal;
}>;

export type AdminIrlRedeemFinalizeWorkflowReservation =
  | Readonly<{ status: 'complete'; result: AdminIrlRedeemFinalizeResponse }>
  | Readonly<{ status: 'reserved'; payload: AdminIrlRedeemFinalizeWorkflowPayload }>;

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof AdminIrlRedeemFinalizeError) {
    return { kind: error.name, code: error.code };
  }
  if (error instanceof DeliveryReceiptError || error instanceof ProfileReadError) {
    return { kind: error.name, code: error.code };
  }
  if (error instanceof Error) return { kind: error.name };
  return { kind: typeof error };
}

function normalizedError(error: unknown, fallback: string): AdminIrlRedeemFinalizeError {
  if (error instanceof AdminIrlRedeemFinalizeError) return error;
  if (error instanceof DeliveryReceiptError) {
    return new AdminIrlRedeemFinalizeError(error.code, error.message, error.details);
  }
  if (error instanceof ProfileReadError) {
    return new AdminIrlRedeemFinalizeError(error.code, error.message, error.details);
  }
  if (isRecord(error) && typeof error.code === 'string') {
    const code = error.code as AdminIrlRedeemFinalizeErrorCode;
    if ([
      'invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'aborted',
      'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal',
    ].includes(code)) {
      return new AdminIrlRedeemFinalizeError(
        code,
        typeof error.message === 'string' ? error.message : fallback,
        error.details,
      );
    }
  }
  return new AdminIrlRedeemFinalizeError('internal', fallback);
}

function rethrowFinalizeCancellation(signal: AbortSignal, error: unknown): void {
  if (isSignalCancellationError(signal, error)) throw signal.reason;
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<FinalizeRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new AdminIrlRedeemFinalizeError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Admin IRL redeem finalization request is too large.'
          : 'Invalid Admin IRL redeem finalization request.',
    ),
  });
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem finalization request.');
  }
  return parsed.data;
}

export function readAdminIrlRedeemFinalizeRequest(
  request: Request,
  signal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeRequest> {
  return readRequestBody(request, signal);
}

function canonicalWallet(value: unknown): string {
  try {
    const wallet = new PublicKey(String(value || '').trim()).toBase58();
    if (!walletHasAdminIrlRedeemAccess(wallet, ADMIN_WALLETS)) {
      throw new AdminIrlRedeemFinalizeError('permission-denied', 'Admins only.');
    }
    return wallet;
  } catch (error) {
    if (error instanceof AdminIrlRedeemFinalizeError) throw error;
    throw new AdminIrlRedeemFinalizeError('permission-denied', 'Admins only.');
  }
}

export function resolveAdminIrlRedeemFinalizeStaffWallet(identity: RequestIdentity): string {
  if (!isStaffRequestIdentity(identity)) {
    throw new AdminIrlRedeemFinalizeError('unauthenticated', 'Staff wallet authentication is required.');
  }
  return canonicalWallet(identity.wallet);
}

async function adminIrlRedeemFinalizeOperationId(
  body: AdminIrlRedeemFinalizeRequest,
  staffWallet: string,
): Promise<string> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem finalization request.');
  }
  return adminIrlRedeemFinalizeOperationIdForWallet(parsed.data, canonicalWallet(staffWallet));
}

function requestKey(path: string) {
  const key = requireCommerceKey(path);
  if (key.kind !== 'admin_irl_redeem_request' || !key.dropId) throw new Error('Invalid commerce document path.');
  return commerceKeys.adminIrlRedeemRequest(key.dropId, key.documentId);
}

function requestPath(body: FinalizeRequest): string {
  return dropAdminIrlRedeemRequestPath(body.dropId, body.requestId);
}

async function loadTransaction(
  connection: Pick<Connection, 'getTransaction'>,
  signature: string,
): Promise<NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>> {
  const transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!transaction) {
    throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem transfer transaction not found yet; retry shortly.');
  }
  if (transaction.meta?.err) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer transaction failed.', {
      err: transaction.meta.err,
    });
  }
  return transaction;
}

async function verifyPackTransfer(
  connection: Pick<Connection, 'getTransaction'>,
  signature: string,
  owner: string,
  admin: string,
  collection: PublicKey,
  itemIds: string[],
): Promise<void> {
  const transaction = await loadTransaction(connection, signature);
  if (transaction.transaction.message.staticAccountKeys[0]?.toBase58() !== owner) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer payer does not match requester.');
  }
  const transferred = coreTransferAssetIds(transaction, { sender: owner, recipient: admin, collection });
  if (transferred.length !== itemIds.length || transferred.some((asset, index) => asset !== itemIds[index])) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem transfer asset mismatch.', {
      expected: itemIds,
      got: transferred,
    });
  }
}

async function verifyCardTransfer(
  connection: Pick<Connection, 'getTransaction'>,
  runtime: Runtime,
  signature: string,
  owner: string,
  admin: string,
  collection: PublicKey,
  receiptAssetId: string,
): Promise<void> {
  const transaction = await loadTransaction(connection, signature);
  if (transaction.transaction.message.staticAccountKeys[0]?.toBase58() !== owner) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Card receipt transfer payer does not match sender.');
  }
  const matches = matchingReceiptTransferCount(transaction, {
    sender: owner,
    recipient: admin,
    collection,
    merkleTree: runtime.receiptsMerkleTree,
  });
  const ids = bubblegumReceiptAssetIds(transaction);
  if (matches !== 1 || ids.length !== 1 || ids[0] !== receiptAssetId) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Card receipt transfer asset mismatch.', {
      expected: receiptAssetId,
      got: ids,
    });
  }
}

function runtimeSupportsFinalize(runtime: Runtime): void {
  const unsupported = getAdminIrlRedeemUnsupportedReason({
    dropFamily: runtime.config.dropFamily,
    itemsPerBox: runtime.itemsPerBox,
    sharesCollectionMint: Object.values(API_DROPS).filter((drop) =>
      drop.solanaCluster === runtime.cluster && drop.collectionMint === runtime.collectionMint.toBase58()
    ).length > 1,
  });
  if (unsupported) throw new AdminIrlRedeemFinalizeError('failed-precondition', unsupported);
}

function createConnection(provider: ProviderContext, runtime: Runtime): Connection {
  return createSolanaConnection({
    apiKey: provider.apiKey,
    cluster: runtime.cluster,
    fetch: provider.providerFetch,
    signal: provider.signal,
    mapError: (failure) => new AdminIrlRedeemFinalizeError(
      failure.kind === 'timeout' ? 'deadline-exceeded' : 'unavailable',
      failure.kind === 'timeout'
        ? 'Admin IRL redeem provider request timed out.'
        : 'Admin IRL redeem provider is temporarily unavailable.',
    ),
  });
}

function mplCoreBurn(asset: PublicKey, collection: PublicKey, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: collection, isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([12, 0]),
  });
}

function isTombstone(account: Awaited<ReturnType<Connection['getAccountInfo']>>): boolean {
  return !account || account.data.length <= 1;
}

async function probePendingFinalizeSubmission(
  connection: Pick<Connection, 'getSignatureStatuses' | 'getAccountInfoAndContext' | 'getMultipleAccountsInfo' | 'isBlockhashValid'>,
  pending: PendingFinalizeSubmission,
): Promise<TransactionSubmissionOutcome> {
  return probeTransactionSubmission({
    connection,
    signature: pending.signature,
    blockhash: pending.blockhash,
    hasLanded: async () => pending.kind === 'internal_delivery'
      ? Boolean((await connection.getAccountInfoAndContext(new PublicKey(pending.deliveryPda), {
        commitment: 'confirmed', dataSlice: { offset: 0, length: 0 },
      })).value)
      : (await connection.getMultipleAccountsInfo(pending.assetIds.map((assetId) => new PublicKey(assetId)), {
        commitment: 'confirmed', dataSlice: { offset: 0, length: 2 },
      })).every(isTombstone),
  });
}

async function reconcilePendingFinalizeSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: Runtime;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
}): Promise<TransactionSubmissionOutcome> {
  const probeContext = cleanupContext(args.commerce);
  let outcome: TransactionSubmissionOutcome = 'unresolved';
  try {
    outcome = await probePendingFinalizeSubmission(
      createConnection({ ...args.provider, signal: probeContext.signal }, args.runtime),
      args.pending,
    );
  } catch {}
  const persistence = cleanupContext(args.commerce);
  if (outcome === 'unresolved') {
    await holdPendingFinalizeSubmission(persistence, requestKey(args.path), args.attemptId, args.pending);
  } else {
    await settlePendingFinalizeSubmission(
      persistence,
      requestKey(args.path),
      args.attemptId,
      args.pending,
      outcome,
    );
  }
  return outcome;
}

function pendingFinalizeSubmissionError(error: unknown, signal: AbortSignal): PendingFinalizeSubmissionError {
  return new PendingFinalizeSubmissionError(signal.aborted ? signal.reason : error);
}

function isDefinitiveTransactionFailure(error: unknown): boolean {
  return error instanceof DeliveryReceiptError &&
    isRecord(error.details) &&
    error.details.definitiveFailure === true;
}

async function receiptBatchConfirmedByPostState(
  error: unknown,
  connection: Pick<Connection, 'getMultipleAccountsInfo'>,
  assets: PublicKey[],
): Promise<boolean> {
  if (isDefinitiveTransactionFailure(error)) return false;
  const post = await connection.getMultipleAccountsInfo(assets, {
    commitment: 'confirmed', dataSlice: { offset: 0, length: 2 },
  }).catch(() => []);
  return post.length === assets.length && post.every(isTombstone);
}

async function clearDefinitiveFinalizeSubmission(args: {
  commerce: CommerceContext;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
}): Promise<void> {
  try {
    await settlePendingFinalizeSubmission(
      cleanupContext(args.commerce),
      requestKey(args.path),
      args.attemptId,
      args.pending,
      'expired',
    );
  } catch (error) {
    throw pendingFinalizeSubmissionError(error, args.commerce.signal);
  }
}

async function rethrowUnbroadcastFinalizeCancellation(args: {
  broadcastStarted: boolean;
  commerce: CommerceContext;
  error: unknown;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
}): Promise<void> {
  if (args.broadcastStarted || !isSignalCancellationError(args.commerce.signal, args.error)) return;
  await clearDefinitiveFinalizeSubmission(args);
  throw args.commerce.signal.reason;
}

async function executePendingFinalizeSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: Runtime;
  path: string;
  attemptId: string;
  pending: PendingFinalizeSubmission;
  connection: Connection;
  transaction: VersionedTransaction;
  label: string;
}): Promise<void> {
  await persistPendingFinalizeSubmission(args.commerce, requestKey(args.path), args.attemptId, args.pending);
  let broadcastStarted = false;
  try {
    await sendAndConfirmSignedTransaction(
      args.connection,
      args.transaction,
      args.commerce.signal,
      args.label,
      () => { broadcastStarted = true; },
    );
    await settlePendingFinalizeSubmission(args.commerce, requestKey(args.path), args.attemptId, args.pending, 'confirmed');
  } catch (error) {
    await rethrowUnbroadcastFinalizeCancellation({ ...args, broadcastStarted, error });
    if (isDefinitiveTransactionFailure(error)) {
      await clearDefinitiveFinalizeSubmission(args);
      throw error;
    }
    const outcome = await reconcilePendingFinalizeSubmission(args).catch(() => 'unresolved' as const);
    if (outcome === 'unresolved') throw pendingFinalizeSubmissionError(error, args.commerce.signal);
    if (outcome === 'expired') throw error;
  }
}

async function reconcileStartedRequestSubmission(args: {
  commerce: CommerceContext;
  provider: ProviderContext;
  runtime: Runtime;
  path: string;
  attemptId: string;
  request: StartedRequest;
}): Promise<void> {
  const pending = args.request.pendingFinalizeSubmission;
  if (!pending) return;
  let outcome: TransactionSubmissionOutcome;
  try {
    outcome = await reconcilePendingFinalizeSubmission({
      ...args,
      pending,
    });
  } catch (error) {
    throw pendingFinalizeSubmissionError(error, args.commerce.signal);
  }
  if (outcome === 'unresolved') throw pendingFinalizeSubmissionError(undefined, args.commerce.signal);
  if (outcome === 'confirmed') {
    if (pending.kind === 'internal_delivery') {
      args.request.internalDeliveryId = pending.deliveryId;
      args.request.internalDeliveryPda = pending.deliveryPda;
      args.request.internalDeliveryTx = pending.signature;
    } else if (!args.request.receiptTxs.includes(pending.signature)) {
      args.request.receiptTxs.push(pending.signature);
    }
  }
  delete args.request.pendingFinalizeSubmission;
}

async function mintPackReceipts(
  connection: Connection,
  provider: ProviderContext,
  runtime: Runtime,
  signer: Keypair,
  collection: PublicKey,
  items: RequestItem[],
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  existing: string[],
): Promise<string[]> {
  const keys = items.map((item) => new PublicKey(item.assetId));
  const infos = await connection.getMultipleAccountsInfo(keys, { commitment: 'confirmed', dataSlice: { offset: 0, length: 2 } });
  const pending = items.map((item, index) => ({ ...item, asset: keys[index], account: infos[index] }))
    .filter((item) => !isTombstone(item.account));
  const receiptTxs = normalizeReceiptTxs(existing);
  while (pending.length) {
    let batchSize = Math.min(3, pending.length);
    let lastError: unknown;
    while (batchSize >= 1) {
      const batch = pending.slice(0, batchSize);
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ...batch.map((item) => mplCoreBurn(item.asset, collection, signer.publicKey)),
        mintReceiptsInstruction({
          runtime,
          signer: signer.publicKey,
          recipient: signer.publicKey,
          coreCollection: collection,
          boxIds: batch.map((item) => item.refId),
          dudeIds: [],
        }),
      ];
      let completed = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (commerce.signal.aborted) throw commerce.signal.reason;
        try {
          const { blockhash } = (await connection.getLatestBlockhashAndContext('confirmed')).value;
          const transaction = buildDeliveryTransaction(instructions, signer.publicKey, blockhash, signer);
          if (transaction.serialize().length > SOLANA_MAX_RAW_TX_BYTES) throw new RangeError('transaction too large');
          const signature = bs58.encode(transaction.signatures[0]);
          const pendingSubmission: PendingFinalizeSubmission = {
            kind: 'receipt_mint',
            signature,
            blockhash,
            assetIds: batch.map((item) => item.asset.toBase58()),
          };
          await executePendingFinalizeSubmission({
            commerce,
            provider,
            runtime,
            path,
            attemptId,
            pending: pendingSubmission,
            connection,
            transaction,
            label: 'Admin IRL receipt mint',
          });
          if (!receiptTxs.includes(signature)) receiptTxs.push(signature);
          pending.splice(0, batchSize);
          completed = true;
          break;
        } catch (error) {
          if (error instanceof PendingFinalizeSubmissionError) throw error;
          rethrowFinalizeCancellation(commerce.signal, error);
          lastError = error;
          if (await receiptBatchConfirmedByPostState(
            error,
            connection,
            batch.map((item) => item.asset),
          )) {
            pending.splice(0, batchSize);
            completed = true;
            break;
          }
          if (attempt < 2) await sleepWithSignal(Math.min(4_000, 600 * 2 ** attempt), commerce.signal);
        }
      }
      if (completed) break;
      batchSize -= 1;
    }
    if (batchSize < 1) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Unable to mint Admin IRL redeem pack receipts.', {
        lastError: lastError instanceof Error ? lastError.message : String(lastError),
      });
    }
  }
  return receiptTxs;
}

function encodeDeliverArgs(deliveryId: number, deliveryBump: number): Buffer {
  const data = Buffer.alloc(21);
  IX_DELIVER.copy(data, 0);
  data.writeUInt32LE(deliveryId, 8);
  data.writeBigUInt64LE(0n, 12);
  data.writeUInt8(deliveryBump, 20);
  return data;
}

async function buildTransactionWithLookupTables(
  instructions: TransactionInstruction[],
  signer: Keypair,
  blockhash: string,
  lookupTables: AddressLookupTableAccount[],
): Promise<VersionedTransaction> {
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables));
  transaction.sign([signer]);
  return transaction;
}

async function ensureInternalDelivery(
  connection: Connection,
  provider: ProviderContext,
  runtime: Runtime,
  signer: Keypair,
  onchain: OnchainConfig,
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  request: StartedRequest,
): Promise<InternalDelivery> {
  let lookupTables: AddressLookupTableAccount[] = [];
  if (runtime.deliveryLookupTable) {
    const lookup = await connection.getAddressLookupTable(runtime.deliveryLookupTable).catch(() => null);
    if (lookup?.value?.isActive()) lookupTables = [lookup.value];
  }
  const assets = request.items.map((item) => new PublicKey(item.assetId));
  const send = async (deliveryId: number, deliveryPda: PublicKey, bump: number): Promise<InternalDelivery> => {
    if (request.internalDeliveryTx) return { deliveryId, deliveryPda: deliveryPda.toBase58(), deliveryTx: request.internalDeliveryTx };
    const existing = (await connection.getAccountInfoAndContext(deliveryPda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })).value;
    if (existing) return { deliveryId, deliveryPda: deliveryPda.toBase58(), deliveryTx: null };
    const instruction = new TransactionInstruction({
      programId: runtime.boxMinterProgramId,
      keys: [
        { pubkey: runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(onchain.decoded.treasury), isSigner: false, isWritable: true },
        { pubkey: onchain.coreCollection, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: deliveryPda, isSigner: false, isWritable: true },
        ...assets.map((asset) => ({ pubkey: asset, isSigner: false, isWritable: true })),
      ],
      data: encodeDeliverArgs(deliveryId, bump),
    });
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction];
    const sized = await buildTransactionWithLookupTables(instructions, signer, DUMMY_BLOCKHASH, lookupTables);
    if (sized.serialize().length > SOLANA_MAX_RAW_TX_BYTES) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL internal delivery transaction is too large. Try fewer packs.');
    }
    const { blockhash } = (await connection.getLatestBlockhashAndContext('confirmed')).value;
    const transaction = await buildTransactionWithLookupTables(instructions, signer, blockhash, lookupTables);
    const signature = bs58.encode(transaction.signatures[0]);
    const pendingSubmission: PendingFinalizeSubmission = {
      kind: 'internal_delivery',
      signature,
      blockhash,
      deliveryId,
      deliveryPda: deliveryPda.toBase58(),
    };
    await executePendingFinalizeSubmission({
      commerce,
      provider,
      runtime,
      path,
      attemptId,
      pending: pendingSubmission,
      connection,
      transaction,
      label: 'Admin IRL internal delivery',
    });
    const result = { deliveryId, deliveryPda: deliveryPda.toBase58(), deliveryTx: signature };
    return result;
  };
  if (request.internalDeliveryId && request.internalDeliveryPda) {
    const [pda, bump] = deriveDeliveryPda(runtime, request.internalDeliveryId);
    if (pda.toBase58() !== request.internalDeliveryPda) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Stored Admin IRL internal delivery PDA does not match delivery id.');
    }
    return send(request.internalDeliveryId, pda, bump);
  }
  for (let attempt = 0; attempt < MAX_DELIVERY_ALLOCATION_ATTEMPTS; attempt += 1) {
    const deliveryId = secureRandomInt(2 ** 31 - 1) + 1;
    const [pda, bump] = deriveDeliveryPda(runtime, deliveryId);
    if ((await connection.getAccountInfoAndContext(pda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })).value) continue;
    await recordInternalDelivery(commerce, requestKey(path), attemptId, { deliveryId, deliveryPda: pda.toBase58() });
    return send(deliveryId, pda, bump);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Failed to allocate hidden Admin IRL delivery id.');
}

async function closeInternalDelivery(
  connection: Connection,
  runtime: Runtime,
  signer: Keypair,
  commerce: CommerceContext,
  path: string,
  attemptId: string,
  request: StartedRequest,
  internal: InternalDelivery,
): Promise<string | null> {
  try {
    if (request.closeDeliveryTx) return request.closeDeliveryTx;
    const [pda, bump] = deriveDeliveryPda(runtime, internal.deliveryId);
    if (!(await connection.getAccountInfoAndContext(pda, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } })).value) return null;
    const { blockhash } = (await connection.getLatestBlockhashAndContext('confirmed')).value;
    const transaction = buildDeliveryTransaction([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      closeDeliveryInstruction({
        runtime,
        signer: signer.publicKey,
        deliveryPda: pda,
        deliveryId: internal.deliveryId,
        deliveryBump: bump,
      }),
    ], signer.publicKey, blockhash, signer);
    const signature = await sendAndConfirmSignedTransaction(
      connection,
      transaction,
      commerce.signal,
      'Admin IRL internal delivery close',
    );
    await recordCloseDelivery(commerce, requestKey(path), attemptId, signature);
    return signature;
  } catch (error) {
    console.warn({
      event: 'admin_irl_redeem_internal_delivery_close_failed',
      dropId: runtime.dropId,
      requestId: request.requestId,
      deliveryId: internal.deliveryId,
      error: summarizeError(error),
    });
    return null;
  }
}

function receiptMatches(asset: unknown, runtime: Runtime, boxId: number, owner: string): boolean {
  if (!isRecord(asset) || !isRecord(asset.ownership) || asset.ownership.owner !== owner) return false;
  return assetMatchesReceiptMetadataIdentity(
    asset,
    adminIrlRedeemReceiptDropIdentity(runtime),
    { kind: 'box', id: boxId },
  );
}

async function scanAssetsByOwner(
  provider: ProviderContext,
  runtime: Runtime,
  owner: string,
  visit: (asset: unknown) => void,
  grouping?: readonly [string, string],
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<void> {
  for (let page = 1; page <= HELIUS_ASSET_MAX_PAGES; page += 1) {
    if (Date.now() >= deadlineMs) {
      throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem receipt indexing timed out.');
    }
    const params: Record<string, unknown> = {
      ownerAddress: owner,
      page,
      limit: HELIUS_ASSET_PAGE_LIMIT,
      options: HELIUS_COLLECTION_GROUPING_OPTIONS,
      ...(grouping ? { grouping } : {}),
    };
    const result = await adminIrlRedeemRpcCall(provider, runtime, 'searchAssets', params);
    const items = heliusSearchAssetsItems(result);
    items.forEach(visit);
    if (!heliusSearchAssetsHasNextPage(result, page, items, HELIUS_ASSET_PAGE_LIMIT)) return;
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', 'Too many assets to search for Admin IRL receipts.');
}

async function findReceiptAssets(
  connection: Connection,
  provider: ProviderContext,
  runtime: Runtime,
  owner: string,
  items: RequestItem[],
  receiptTxs: string[],
): Promise<Map<number, Record<string, unknown>[]>> {
  const expected = new Set(items.map((item) => item.refId));
  const direct = new Map<number, Record<string, unknown>[]>();
  const add = (asset: unknown) => {
    if (!isRecord(asset)) return;
    const boxId = Number(dasAssetBoxId(asset, NAME_POLICY));
    if (!Number.isSafeInteger(boxId) || !expected.has(boxId) || !receiptMatches(asset, runtime, boxId, owner)) return;
    const list = direct.get(boxId) || [];
    if (!list.some((entry) => entry.id === asset.id)) list.push(asset);
    direct.set(boxId, list);
  };
  try {
    const signatures = normalizeReceiptTxs(receiptTxs);
    const transactions = await connection.getTransactions(signatures, { maxSupportedTransactionVersion: 0 });
    if (transactions.length === signatures.length && transactions.every(Boolean)) {
      const ids = transactions.flatMap((transaction) => transaction ? bubblegumReceiptAssetIds(transaction) : []);
      if (ids.length !== items.length || new Set(ids).size !== ids.length) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem receipt transaction assets do not match the request.');
      }
      const assets = await mapWithConcurrency(ids, 4, (id, _index, signal) =>
        fetchAdminIrlRedeemAsset({ ...provider, signal }, runtime, id), { signal: provider.signal });
      for (const asset of assets) {
        const boxId = isRecord(asset) ? Number(dasAssetBoxId(asset, NAME_POLICY)) : Number.NaN;
        if (!Number.isSafeInteger(boxId) || !expected.has(boxId) || !receiptMatches(asset, runtime, boxId, owner)) {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem indexed receipt does not match the request.');
        }
        add(asset);
      }
      if (!items.every((item) => (direct.get(item.refId) || []).length === 1)) {
        throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem indexed receipts are ambiguous.');
      }
      return direct;
    }
  } catch (error) {
    rethrowFinalizeCancellation(provider.signal, error);
    if (error instanceof AdminIrlRedeemFinalizeError && error.code === 'failed-precondition') throw error;
    console.warn({ event: 'admin_irl_redeem_receipt_transaction_lookup_failed', dropId: runtime.dropId, error: summarizeError(error) });
  }
  const startedAt = Date.now();
  const deadlineMs = startedAt + RECEIPT_INDEX_MAX_WAIT_MS;
  while (Date.now() <= deadlineMs) {
    direct.clear();
    await scanAssetsByOwner(
      provider,
      runtime,
      owner,
      add,
      ['collection', runtime.collectionMint.toBase58()],
      deadlineMs,
    );
    if (!items.every((item) => (direct.get(item.refId) || []).length === 1)) {
      await scanAssetsByOwner(provider, runtime, owner, add, undefined, deadlineMs);
    }
    if (items.every((item) => (direct.get(item.refId) || []).length === 1)) return direct;
    await sleepWithSignal(RECEIPT_INDEX_POLL_MS, provider.signal);
  }
  return direct;
}

async function waitForCardReceipt(
  provider: ProviderContext,
  runtime: Runtime,
  receiptAssetId: string,
  figureId: number,
  admin: string,
): Promise<void> {
  const startedAt = Date.now();
  let lastOwner = '';
  let lastTransient: unknown;
  while (Date.now() - startedAt <= RECEIPT_INDEX_MAX_WAIT_MS) {
    try {
      const asset = await fetchAdminIrlRedeemAsset(provider, runtime, receiptAssetId);
      lastOwner = isRecord(asset.ownership) && typeof asset.ownership.owner === 'string' ? asset.ownership.owner : '';
      if (lastOwner === admin) {
        if (!assetMatchesReceiptMetadataIdentity(asset, adminIrlRedeemReceiptDropIdentity(runtime), { kind: 'figure', id: figureId })) {
          throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem receipt does not belong to the requested drop.');
        }
        const proof = await fetchAdminIrlRedeemAssetProof(provider, runtime, receiptAssetId);
        if (adminIrlCardReceiptProofHasIdentity(proof)) {
          if (!assetMatchesReceiptDropIdentity(asset, proof, adminIrlRedeemReceiptDropIdentity(runtime), { kind: 'figure', id: figureId })) {
            throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem receipt proof belongs to a different drop.');
          }
          parseAdminIrlRedeemProof(asset, proof, runtime, admin);
          return;
        }
      }
      lastTransient = undefined;
    } catch (error) {
      rethrowFinalizeCancellation(provider.signal, error);
      const disposition = classifyAdminIrlCardReceiptLookupError(error);
      if (disposition === 'fatal') throw normalizedError(error, 'Admin IRL card receipt lookup failed.');
      lastTransient = disposition === 'transient' ? error : undefined;
    }
    await sleepWithSignal(RECEIPT_INDEX_POLL_MS, provider.signal);
  }
  throw new AdminIrlRedeemFinalizeError('unavailable', lastTransient
    ? 'Admin IRL card receipt lookup failed while waiting for indexing; retry shortly.'
    : 'Admin IRL card receipt is not indexed under the deployer wallet yet.', {
      receiptAssetId,
      expectedOwner: admin,
      lastOwner,
      ...(lastTransient ? { lastError: summarizeError(lastTransient) } : {}),
    });
}

function workflowCommerceContext(
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>,
  signal: AbortSignal,
  nowMs = Date.now(),
): CommerceContext {
  return {
    repository: new D1CommerceRepository(env.COMMERCE_DB),
    nowMs,
    providerFetch: (input, init) => fetch(input, init),
    signal,
    dataDb: env.DATA_DB,
  };
}

function workflowProviderContext(
  env: Pick<Env, 'HELIUS_API_KEY'>,
  signal: AbortSignal,
): ProviderContext {
  const apiKey = String(env.HELIUS_API_KEY || '').trim();
  if (!apiKey) {
    throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem finalization is temporarily unavailable.');
  }
  return { apiKey, providerFetch: (input, init) => fetch(input, init), signal };
}

function workflowSigner(env: Pick<Env, 'COSIGNER_SECRET'>): Keypair {
  const secret = String(env.COSIGNER_SECRET || '').trim();
  if (!secret) {
    throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem finalization is temporarily unavailable.');
  }
  return decodeCosigner(secret);
}

function workflowResultReference(
  dropId: string,
  requestId: string,
): AdminIrlRedeemFinalizeWorkflowResultReference {
  return { kind: 'admin-irl-redeem-finalize-v1', dropId, requestId };
}

async function projectWorkflowPackStatus(
  commerce: CommerceContext,
  response: AdminIrlRedeemFinalizeResponse,
): Promise<void> {
  const deliveryId = response.deliveryId;
  if (typeof deliveryId !== 'number' || !Number.isSafeInteger(deliveryId) || deliveryId < 1 || response.boxes.length < 1) {
    return;
  }
  try {
    await projectPendingDeliveryPackStatus({
      context: commerce,
      deliveryId,
      dropId: response.dropId,
    });
  } catch (error) {
    console.error({
      event: 'admin_irl_redeem_pack_status_projection_failed',
      dropId: response.dropId,
      deliveryId,
      error: summarizeError(error),
    });
  }
}

type LoadedWorkflowRequest =
  | Readonly<{
      status: 'complete';
      response: AdminIrlRedeemFinalizeResponse;
      body: FinalizeRequest;
      commerce: CommerceContext;
    }>
  | Readonly<{
      status: 'started';
      body: FinalizeRequest;
      commerce: CommerceContext;
      request: StartedRequest;
      execution: AdminIrlRedeemFinalizeWorkflowExecutionV1;
      draft?: AdminIrlRedeemFinalizeWorkflowPublicationDraftV1;
    }>;

async function loadWorkflowRequest(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
  confirmEntry = false,
): Promise<LoadedWorkflowRequest> {
  const commerce = workflowCommerceContext(args.env, args.signal);
  return { ...await enterWorkflow(commerce, args, confirmEntry), commerce };
}

export async function reserveAdminIrlRedeemFinalizeWorkflow(args: Readonly<{
  body: AdminIrlRedeemFinalizeRequest;
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;
  operationId: string;
  signal: AbortSignal;
  staffWallet: string;
  nowMs?: number;
}>): Promise<AdminIrlRedeemFinalizeWorkflowReservation> {
  const parsed = requestSchema.safeParse(args.body);
  if (!parsed.success) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem finalization request.');
  }
  const wallet = canonicalWallet(args.staffWallet);
  if (args.operationId !== await adminIrlRedeemFinalizeOperationId(parsed.data, wallet)) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow operation id.');
  }
  const config = API_DROPS[parsed.data.dropId];
  if (!config) throw new AdminIrlRedeemFinalizeError('invalid-argument', `Unsupported dropId: ${parsed.data.dropId}`);
  const snapshot = JSON.parse(JSON.stringify(config)) as ApiDropConfig;
  runtimeSupportsFinalize(buildAdminIrlRedeemRuntime(snapshot));
  const commerce = workflowCommerceContext(args.env, args.signal, args.nowMs ?? Date.now());
  const prepared = await readCommerceRecord(
    commerce,
    commerceKeys.adminIrlRedeemRequest(parsed.data.dropId, parsed.data.requestId),
  );
  if (!prepared) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem request not found.');
  const owner = finalizeRequestOwner(prepared.data, wallet);
  const adminWallet = canonicalPublicKey(prepared.data.adminWallet);
  if (!adminWallet) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem request admin wallet is invalid.');
  }
  const execution: AdminIrlRedeemFinalizeWorkflowExecutionV1 = {
    version: 1,
    operationId: args.operationId,
    owner,
    transferSignature: parsed.data.transferSignature,
    adminWallet,
    config: snapshot,
    pendingEffect: { kind: 'create', untilMs: 0 },
  };
  const started = await startFinalize(
    commerce,
    parsed.data,
    wallet,
    args.operationId,
    args.nowMs ?? Date.now(),
    execution,
  );
  if (started.status === 'complete') {
    return { status: 'complete', result: completeResponse(parsed.data.dropId, parsed.data.requestId, started.request) };
  }
  return {
    status: 'reserved',
    payload: { version: 1, dropId: parsed.data.dropId, requestId: parsed.data.requestId },
  };
}

export async function resumeAndReconcileAdminIrlRedeemFinalizeWorkflow(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowPhaseResult> {
  const loaded = await loadWorkflowRequest(args, true);
  if (loaded.status === 'complete') return { status: 'complete' };
  if (loaded.draft) return { status: 'drafted' };
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  const provider = workflowProviderContext(args.env, args.signal);
  await reconcileStartedRequestSubmission({
    commerce: loaded.commerce,
    provider,
    runtime,
    path: requestPath(loaded.body),
    attemptId: args.operationId,
    request: loaded.request,
  });
  return { status: 'ready' };
}

export async function validateAdminIrlRedeemFinalizeWorkflow(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowPhaseResult> {
  const loaded = await loadWorkflowRequest(args);
  if (loaded.status === 'complete') return { status: 'complete' };
  if (loaded.draft) return { status: 'drafted' };
  if (loaded.request.pendingFinalizeSubmission) throw new PendingFinalizeSubmissionError();
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  const provider = workflowProviderContext(args.env, args.signal);
  const connection = createConnection(provider, runtime);
  const signer = workflowSigner(args.env);
  const onchain = await fetchDeliveryOnchainConfig(connection, runtime);
  const pinned = {
    adminWallet: onchain.admin.toBase58(),
    coreCollection: onchain.coreCollection.toBase58(),
    treasury: new PublicKey(onchain.decoded.treasury).toBase58(),
  };
  if (pinned.adminWallet !== loaded.request.adminWallet || !signer.publicKey.equals(onchain.admin)) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'COSIGNER_SECRET does not match the prepared on-chain admin.');
  }
  await persistWorkflowOnchain(loaded, pinned);
  if (loaded.request.targetKind === 'card_receipt') {
    const card = loaded.request.items[0];
    if (!card || card.kind !== 'card_receipt') {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL card receipt request is invalid.');
    }
    await verifyCardTransfer(
      connection,
      runtime,
      loaded.body.transferSignature,
      loaded.request.owner,
      pinned.adminWallet,
      onchain.coreCollection,
      card.assetId,
    );
    return { status: 'ready' };
  }
  await verifyPackTransfer(
    connection,
    loaded.body.transferSignature,
    loaded.request.owner,
    pinned.adminWallet,
    onchain.coreCollection,
    loaded.request.itemIds,
  );
  return { status: 'ready' };
}

export async function prepareAdminIrlRedeemFinalizeWorkflowDraft(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowPhaseResult> {
  const loaded = await loadWorkflowRequest(args);
  if (loaded.status === 'complete') return { status: 'complete' };
  if (loaded.draft) return { status: 'drafted' };
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  if (loaded.request.pendingFinalizeSubmission) {
    const provider = workflowProviderContext(args.env, args.signal);
    await reconcileStartedRequestSubmission({
      commerce: loaded.commerce,
      provider,
      runtime,
      path: requestPath(loaded.body),
      attemptId: args.operationId,
      request: loaded.request,
    });
  }
  const markerState = loaded.request.targetKind === 'pack'
    ? await reusableExistingMarkerState(loaded.commerce, loaded.body, args.operationId, loaded.request)
    : { status: 'none' as const };
  if (markerState.status === 'complete') return { status: 'complete' };
  if (markerState.status === 'reuse') {
    await persistWorkflowDraft(loaded, {
      version: 1,
      targetKind: 'pack',
      mode: 'marker_reuse',
      receiptOwner: loaded.request.adminWallet,
      deliveryId: markerState.deliveryId,
      sourceRequestId: markerState.sourceRequestId,
      fingerprint: markerState.fingerprint,
    });
    return { status: 'drafted' };
  }
  const provider = workflowProviderContext(args.env, args.signal);
  const pinned = loaded.execution.onchain;
  if (!pinned) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem Workflow configuration was not validated.');
  }
  const signer = workflowSigner(args.env);
  if (signer.publicKey.toBase58() !== pinned.adminWallet || pinned.adminWallet !== loaded.request.adminWallet) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'COSIGNER_SECRET does not match the prepared on-chain admin.');
  }
  const connection = createConnection(provider, runtime);
  const current = await fetchDeliveryOnchainConfig(connection, runtime);
  if (
    current.admin.toBase58() !== pinned.adminWallet ||
    current.coreCollection.toBase58() !== pinned.coreCollection ||
    new PublicKey(current.decoded.treasury).toBase58() !== pinned.treasury
  ) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem on-chain configuration changed.');
  }
  if (loaded.request.targetKind === 'card_receipt') {
    const card = loaded.request.items[0];
    if (!card || card.kind !== 'card_receipt') {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL card receipt request is invalid.');
    }
    await waitForCardReceipt(provider, runtime, card.assetId, card.refId, pinned.adminWallet);
    await persistWorkflowDraft(loaded, {
      version: 1,
      targetKind: 'card_receipt',
      receiptOwner: pinned.adminWallet,
      card: { figureId: card.refId, receiptAssetId: card.assetId },
    });
    return { status: 'drafted' };
  }
  const internal = await ensureInternalDelivery(
    connection,
    provider,
    runtime,
    signer,
    current,
    loaded.commerce,
    requestPath(loaded.body),
    args.operationId,
    loaded.request,
  );
  const receiptTxs = await mintPackReceipts(
    connection,
    provider,
    runtime,
    signer,
    current.coreCollection,
    loaded.request.items,
    loaded.commerce,
    requestPath(loaded.body),
    args.operationId,
    loaded.request.receiptTxs,
  );
  const assets = await findReceiptAssets(
    connection,
    provider,
    runtime,
    pinned.adminWallet,
    loaded.request.items,
    receiptTxs,
  );
  const boxes: AdminIrlRedeemBoxBaseInput[] = [];
  for (const item of loaded.request.items) {
    const matches = assets.get(item.refId) || [];
    if (matches.length === 0) {
      throw new AdminIrlRedeemFinalizeError('unavailable', 'Admin IRL redeem pack receipt is not indexed yet.');
    }
    const receiptAssetId = matches.length === 1 ? canonicalPublicKey(matches[0].id) : undefined;
    if (matches.length !== 1 || !receiptAssetId) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem pack receipt indexing is ambiguous.');
    }
    const dudeIds = await assignDudesForBox(
      loaded.commerce,
      runtime,
      receiptAssetId,
      secureRandomInt,
    );
    boxes.push({ boxId: item.refId, originalAssetId: item.assetId, receiptAssetId, dudeIds });
  }
  const closeDeliveryTx = await closeInternalDelivery(
    connection,
    runtime,
    signer,
    loaded.commerce,
    requestPath(loaded.body),
    args.operationId,
    loaded.request,
    internal,
  ).catch(() => null);
  await persistWorkflowDraft(loaded, {
    version: 1,
    targetKind: 'pack',
    mode: 'prepared',
    receiptOwner: pinned.adminWallet,
    internalDelivery: internal,
    closeDeliveryTx,
    receiptTxs,
    boxes,
  });
  return { status: 'drafted' };
}

export async function publishAdminIrlRedeemFinalizeWorkflow(
  args: AdminIrlRedeemFinalizeWorkflowStageArgs,
): Promise<AdminIrlRedeemFinalizeWorkflowResultReference> {
  const loaded = await loadWorkflowRequest(args);
  if (loaded.status === 'complete') {
    await projectWorkflowPackStatus(loaded.commerce, loaded.response);
    return workflowResultReference(loaded.body.dropId, loaded.body.requestId);
  }
  const draft = loaded.draft;
  if (!draft) {
    throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem publication draft is missing.');
  }
  const runtime = buildAdminIrlRedeemRuntime(loaded.execution.config);
  validateWorkflowDraftForRequest(draft, loaded.request, runtime);
  if (draft.targetKind === 'card_receipt') {
    await publishCard(
      loaded.commerce,
      runtime,
      loaded.body,
      args.operationId,
      loaded.request,
      draft.receiptOwner,
      draft.card,
    );
  } else if (draft.mode === 'marker_reuse') {
    const completed = await completeFromExistingMarkers(
      loaded.commerce,
      loaded.body,
      args.operationId,
      loaded.request,
      {
        deliveryId: draft.deliveryId,
        sourceRequestId: draft.sourceRequestId,
        fingerprint: draft.fingerprint,
      },
    );
    if (!completed) {
      throw new AdminIrlRedeemFinalizeError('failed-precondition', 'Admin IRL redeem marker reuse state changed.');
    }
    await projectWorkflowPackStatus(loaded.commerce, completed);
  } else {
    const completed = await publishPack(
      loaded.commerce,
      runtime,
      loaded.body,
      args.operationId,
      loaded.request,
      draft.receiptOwner,
      draft.internalDelivery,
      draft.closeDeliveryTx,
      draft.receiptTxs,
      draft.boxes,
    );
    await projectWorkflowPackStatus(loaded.commerce, completed);
  }
  return workflowResultReference(loaded.body.dropId, loaded.body.requestId);
}

export async function cleanupAdminIrlRedeemFinalizeWorkflow(args: Readonly<{
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>;
  error: AdminIrlRedeemFinalizeWorkflowError;
  operationId: string;
  payload: AdminIrlRedeemFinalizeWorkflowPayload;
  signal: AbortSignal;
}>): Promise<{ cleared: boolean }> {
  return recordWorkflowFailure({
    commerce: workflowCommerceContext(args.env, args.signal),
    error: args.error,
    operationId: args.operationId,
    payload: args.payload,
  });
}

export async function loadAdminIrlRedeemFinalizeWorkflowResult(args: Readonly<{
  env: Pick<Env, 'COMMERCE_DB'>;
  operationId: string;
  reference?: AdminIrlRedeemFinalizeWorkflowResultReference;
}>): Promise<AdminIrlRedeemFinalizeResponse> {
  const repository = new D1CommerceRepository(args.env.COMMERCE_DB);
  const document = await repository.getAdminIrlRedeemRequestForWorkflowStatus(args.operationId);
  if (!document) throw new AdminIrlRedeemFinalizeError('not-found', 'Admin IRL redeem Workflow operation not found.');
  const fields = document.data;
  const execution = isRecord(fields[WORKFLOW_EXECUTION_FIELD]) ? fields[WORKFLOW_EXECUTION_FIELD] : null;
  const owner = canonicalPublicKey(fields.owner);
  const transferSignature = canonicalSignature(fields.transferSignature);
  if (
    !execution || execution.version !== 1 || execution.operationId !== args.operationId ||
    !owner || execution.owner !== owner || execution.transferSignature !== transferSignature || !transferSignature
  ) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  const dropId = document.key.dropId || '';
  const requestId = document.key.documentId;
  if (
    args.operationId !== await adminIrlRedeemFinalizeOperationIdForWallet({ dropId, requestId, transferSignature }, owner) ||
    fields.status !== 'complete' || fields.dropId !== dropId ||
    (args.reference && (args.reference.dropId !== dropId || args.reference.requestId !== requestId))
  ) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Stored Admin IRL redeem Workflow result is invalid.');
  }
  return validateWorkflowCompletion(completeResponse(dropId, requestId, fields), fields);
}

export const adminIrlRedeemFinalizeTestHooks = {
  createConnection,
  clearDefinitiveFinalizeSubmission,
  completeResponse,
  ensureInternalDelivery,
  findReceiptAssets,
  normalizeItems,
  normalizePendingFinalizeSubmission,
  isDefinitiveTransactionFailure,
  mintPackReceipts,
  persistPendingFinalizeSubmission: (
    context: Parameters<typeof persistPendingFinalizeSubmission>[0],
    path: string,
    attemptId: string,
    pending: PendingFinalizeSubmission,
  ) =>
    persistPendingFinalizeSubmission(context, requestKey(path), attemptId, pending),
  pendingFinalizeSubmissionAlreadySettled,
  persistWorkflowOnchain,
  probePendingFinalizeSubmission,
  readRequestBody,
  receiptBatchConfirmedByPostState,
  rethrowUnbroadcastFinalizeCancellation,
  runtimeSupportsFinalize,
  scanAssetsByOwner,
  settlePendingFinalizeSubmission: (
    context: Parameters<typeof settlePendingFinalizeSubmission>[0],
    path: string,
    attemptId: string,
    pending: PendingFinalizeSubmission,
    outcome: 'confirmed' | 'expired',
  ) =>
    settlePendingFinalizeSubmission(context, requestKey(path), attemptId, pending, outcome),
  startFinalize,
  verifyCardTransfer,
  verifyPackTransfer,
  waitForCardReceipt,
};

export type { AdminIrlRedeemFinalizeResponse } from './adminIrlRedeemRequestState.js';
