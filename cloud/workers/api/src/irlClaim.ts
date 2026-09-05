import bs58 from 'bs58';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  API_DROPS,
  getApiDrop,
  type ApiDropConfig,
} from './dropConfig.js';
import {
  IRL_CLAIM_CODE_DIGITS,
  normalizeIrlClaimCode,
} from './claimCodes.js';
import {
  assetProofTreePublicKey,
  normalizedAssetProofAccounts,
} from './receiptProof.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX,
} from '../../../../shared/boxMinterProtocol.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeBoxMinterMetadataBaseForComparison,
  normalizeDropId,
  type SolanaCluster,
} from '../../../../shared/deploymentCore.js';
import {
  dasAssetBoxId,
  dasAssetDudeId,
  dasAssetKind,
  dasAssetLooksBurntOrClosed,
  type DasAsset,
} from '../../../../shared/dasAsset.js';
import {
  HELIUS_COLLECTION_GROUPING_OPTIONS,
  uniqueAssetGroupingCollectionMint,
} from '../../../../shared/dasAssetCollections.js';
import {
  HELIUS_SEARCH_ASSETS_MAX_CANDIDATES,
  HELIUS_SEARCH_ASSETS_MAX_CURSOR_PAGES,
  HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES,
  HELIUS_SEARCH_ASSETS_PAGE_LIMITS,
  heliusSearchAssetsCursorPageInfo,
} from '../../../../shared/heliusDas.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_CPI_SIGNER_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import { isNonZeroBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import type {
  PrepareIrlClaimRequest,
  PrepareIrlClaimResponse,
} from '../../../../shared/contracts.js';
import { RequestIdentityError, resolveRequestWallet, verifyRequestIdentity, type RequestIdentity } from './requestIdentity.js';
import { type ProfileProviderFetch } from './boundedResponse.js';
import {
  isRequestCancellationError,
  isSignalCancellationError,
  raceReadWithSignal,
  readBoundedRequestJson,
} from './boundedRequest.js';
import { withAuthenticatedRequest } from './authenticatedRequest.js';
import { isRecord, ProfileReadError, type ApiErrorCode } from './dataAccess.js';
import { apiErrorBody, httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';
import {
  createSolanaProvider,
  parseSolanaRpcAccount,
  SolanaProviderError,
  type SolanaRetryPolicy,
} from './solanaProvider.js';
import { D1CommerceRepository, commerceKeys } from './commerceRepository.js';
import { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';

export const IRL_CLAIM_PREPARE_PATH = '/claims/irl/prepare';

const REQUEST_MAX_BYTES = 1024;
const PROVIDER_MAX_BYTES = HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES;
const HANDLER_TIMEOUT_MS = 55_000;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;
const HELIUS_ASSETS_PAGE_LIMIT = HELIUS_SEARCH_ASSETS_PAGE_LIMITS[0];
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const NAME_POLICY = { metadataNameMode: 'string-only' } as const;
const BURN_POLICY = { missingAssetResult: true, nonBooleanFlagIsBurnt: false } as const;
const IX_BURN_V2 = Buffer.from([115, 210, 34, 240, 232, 143, 183, 16]);
const IX_MINT_RECEIPTS = Buffer.from('c7c2556f92996a77', 'hex');
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const MPL_CORE_CPI_SIGNER = new PublicKey(MPL_CORE_CPI_SIGNER_ADDRESS);

type IrlClaimEnv = Pick<
  Env,
  'COSIGNER_SECRET' | 'HELIUS_API_KEY'
> & Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'OPS_DB'>>;

type IrlClaimErrorCode = ApiErrorCode;

class IrlClaimError extends Error {
  constructor(
    readonly code: IrlClaimErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'IrlClaimError';
  }
}

type IrlClaimRuntime = {
  config: ApiDropConfig;
  dropId: string;
  cluster: SolanaCluster;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  receiptsMerkleTree: PublicKey;
  deliveryLookupTable?: PublicKey;
  receiptsTreeMaxDepth?: number;
  receiptsTreeCanopyDepth: number;
  itemsPerBox: number;
  maxDudeId: number;
};

type CommerceReadContext = {
  commerceDb: D1Database;
  repository?: D1CommerceRepository;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
  [key: string]: unknown;
};

type ProviderContext = {
  apiKey: string;
  attemptTimeoutMs?: number;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
};

type OnchainState = {
  config: DecodedBoxMinterConfigData;
  coreCollection: PublicKey;
};

type IrlClaimDependencies = {
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
  getDrop: (dropId: string) => ApiDropConfig | undefined;
  loadBoundWallet: (
    context: CommerceReadContext,
    db: D1Database | undefined,
    uid: string,
  ) => Promise<string>;
  loadClaim: (context: CommerceReadContext, code: string) => Promise<Record<string, unknown> | null>;
  resolveLegacyDropIds: (context: CommerceReadContext, code: string) => Promise<string[]>;
  fetchOwnedAssets: (context: ProviderContext, runtime: IrlClaimRuntime, owner: string) => Promise<DasAsset[]>;
  fetchAssetProof: (context: ProviderContext, runtime: IrlClaimRuntime, assetId: string) => Promise<Record<string, unknown>>;
  loadOnchainState: (context: ProviderContext, runtime: IrlClaimRuntime) => Promise<OnchainState>;
  loadLatestBlockhash: (
    context: ProviderContext,
    runtime: IrlClaimRuntime,
  ) => Promise<{ blockhash: string; blockhashContextSlot: number }>;
  loadLookupTable: (context: ProviderContext, runtime: IrlClaimRuntime) => Promise<AddressLookupTableAccount[]>;
};

type IrlClaimMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type IrlClaimResult = {
  response: Response;
  metrics: IrlClaimMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
};

function errorResponse(error: IrlClaimError): Response {
  return jsonResponse(apiErrorBody(error), httpStatusForApiErrorCode(error.code, 502));
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<PrepareIrlClaimRequest> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: REQUEST_MAX_BYTES,
    signal,
    createError: (failure) => new IrlClaimError(
      'invalid-argument',
      failure === 'unsupported-media-type'
        ? 'Content-Type must be application/json.'
        : failure === 'too-large'
          ? 'Claim request is too large.'
          : 'Invalid claim request.',
    ),
  });
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'code,owner') {
    throw new IrlClaimError('invalid-argument', 'Invalid claim request.');
  }
  if (
    typeof value.owner !== 'string' || value.owner.length < 1 || value.owner.length > 64 ||
    typeof value.code !== 'string' || value.code.length < 1 || value.code.length > 64
  ) {
    throw new IrlClaimError('invalid-argument', 'Invalid claim request.');
  }
  return { owner: value.owner, code: value.code };
}

function canonicalWallet(value: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new IrlClaimError('invalid-argument', 'Invalid wallet address');
  }
}

function publicKey(label: string, value: string | undefined, required = true): PublicKey | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return undefined;
    throw new IrlClaimError('failed-precondition', `${label} is not configured.`);
  }
  try {
    const key = new PublicKey(normalized);
    if (required && key.equals(PublicKey.default)) {
      throw new IrlClaimError('failed-precondition', `${label} is not configured.`);
    }
    return key;
  } catch (error) {
    if (error instanceof IrlClaimError) throw error;
    throw new IrlClaimError('failed-precondition', `${label} is invalid.`);
  }
}

function buildRuntime(config: ApiDropConfig): IrlClaimRuntime {
  const dropId = normalizeDropId(config.dropId);
  const itemsPerBox = Number(config.itemsPerBox);
  const maxSupply = Number(config.maxSupply);
  const maxDudeId = maxSupply * itemsPerBox;
  if (
    itemsPerBox < BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX ||
    !Number.isInteger(maxSupply) || maxSupply < 1 ||
    !Number.isSafeInteger(maxDudeId) || maxDudeId > 0xffff
  ) {
    throw new IrlClaimError('failed-precondition', 'This drop does not use secret claim codes.');
  }
  const boxMinterProgramId = publicKey('BOX_MINTER_PROGRAM_ID', config.boxMinterProgramId)!;
  const boxMinterConfigPda = publicKey('BOX_MINTER_CONFIG_PDA', config.boxMinterConfigPda, false) ||
    PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0];
  return {
    config,
    dropId,
    cluster: config.solanaCluster,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint: publicKey('COLLECTION_MINT', config.collectionMint)!,
    receiptsMerkleTree: publicKey('RECEIPTS_MERKLE_TREE', config.receiptsMerkleTree)!,
    deliveryLookupTable: publicKey('DELIVERY_LOOKUP_TABLE', config.deliveryLookupTable, false),
    ...(config.receiptsTreeMaxDepth == null ? {} : { receiptsTreeMaxDepth: config.receiptsTreeMaxDepth }),
    receiptsTreeCanopyDepth: Number(config.receiptsTreeCanopyDepth || 0),
    itemsPerBox,
    maxDudeId,
  };
}

function collectionScopeKey(config: Pick<ApiDropConfig, 'solanaCluster' | 'collectionMint'>): string {
  return `${config.solanaCluster}:${config.collectionMint}`;
}

function clusterSharesCollection(runtime: IrlClaimRuntime): boolean {
  const key = collectionScopeKey(runtime.config);
  return Object.values(API_DROPS).filter((drop) => collectionScopeKey(drop) === key).length > 1;
}

const PROVIDER_RETRY: SolanaRetryPolicy = {
  attempts: 2,
  delayMs: () => 100,
  shouldRetry: (failure) =>
    failure.kind === 'network' ||
    failure.kind === 'timeout' ||
    failure.kind === 'body' ||
    (failure.kind === 'http' && TRANSIENT_HTTP_STATUSES.has(failure.status || 0)),
};

const PROVIDER_REST_RETRY: SolanaRetryPolicy = {
  attempts: 1,
  delayMs: () => 100,
  shouldRetry: () => false,
};

function provider(context: ProviderContext, runtime: IrlClaimRuntime) {
  return createSolanaProvider({
    apiKey: context.apiKey,
    attemptTimeoutMs: context.attemptTimeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS,
    cluster: runtime.cluster,
    fetch: context.providerFetch,
    maxResponseBytes: PROVIDER_MAX_BYTES,
    requestId: (method) => `irl-claim-${method}`,
    retry: PROVIDER_RETRY,
    signal: context.signal,
  });
}

function translateProviderError(
  context: ProviderContext,
  error: unknown,
  assetId?: string,
): IrlClaimError {
  if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
  if (!(error instanceof SolanaProviderError)) {
    return new IrlClaimError('unavailable', 'Claim provider is temporarily unavailable.');
  }
  if (error.kind === 'timeout') {
    return new IrlClaimError('deadline-exceeded', 'Claim provider request timed out.');
  }
  if ((error.kind === 'network' || error.kind === 'body') && error.method?.endsWith('Rest')) {
    return new IrlClaimError('unavailable', 'Claim provider returned an invalid response.');
  }
  if (error.kind === 'invalid-response') {
    return new IrlClaimError('unavailable', 'Claim provider returned an invalid response.');
  }
  if (error.kind === 'rpc') {
    return new IrlClaimError('unavailable', 'Claim provider is temporarily unavailable.', {
      method: error.method,
      ...(Number.isFinite(error.rpcCode) ? { upstreamCode: error.rpcCode } : {}),
    });
  }
  if (error.kind === 'not-found') {
    return new IrlClaimError(
      'not-found',
      'Asset proof not found',
      error.resource === 'asset-proof' ? { assetId } : undefined,
    );
  }
  return new IrlClaimError('unavailable', 'Claim provider is temporarily unavailable.');
}

async function rpcCall(
  context: ProviderContext,
  runtime: IrlClaimRuntime,
  method: string,
  params: unknown,
): Promise<unknown> {
  try {
    return await provider(context, runtime).rpc(method, params);
  } catch (error) {
    throw translateProviderError(context, error);
  }
}

function searchAssetsResult(value: unknown): DasAsset[] {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > HELIUS_ASSETS_PAGE_LIMIT) {
    throw new IrlClaimError('unavailable', 'Claim provider returned an invalid asset response.');
  }
  if (!value.items.every(isRecord)) {
    throw new IrlClaimError('unavailable', 'Claim provider returned an invalid asset response.');
  }
  return value.items as DasAsset[];
}

async function fetchOwnedAssets(
  context: ProviderContext,
  runtime: IrlClaimRuntime,
  owner: string,
): Promise<DasAsset[]> {
  const scan = async (grouping?: readonly [string, string]) => {
    const assets: DasAsset[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < HELIUS_SEARCH_ASSETS_MAX_CURSOR_PAGES; page += 1) {
      const result = await rpcCall(context, runtime, 'searchAssets', {
        ownerAddress: owner,
        limit: HELIUS_ASSETS_PAGE_LIMIT,
        options: HELIUS_COLLECTION_GROUPING_OPTIONS,
        ...(grouping ? { grouping } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const items = searchAssetsResult(result);
      if (assets.length + items.length > HELIUS_SEARCH_ASSETS_MAX_CANDIDATES) {
        throw new IrlClaimError('resource-exhausted', 'Too many assets to search for receipt; contact support.');
      }
      assets.push(...items);
      let pageInfo;
      try {
        pageInfo = heliusSearchAssetsCursorPageInfo(
          result,
          items.length,
          HELIUS_ASSETS_PAGE_LIMIT,
          cursors,
        );
      } catch {
        throw new IrlClaimError('unavailable', 'Claim provider returned invalid asset pagination.');
      }
      if (!pageInfo.hasMore) return assets;
      cursor = pageInfo.cursor;
      cursors.add(cursor);
    }
    throw new IrlClaimError('resource-exhausted', 'Too many asset pages to search for receipt; contact support.');
  };
  const grouped = await scan(['collection', runtime.collectionMint.toBase58()]);
  if (grouped.length) return grouped;
  return scan();
}

async function fetchAssetProof(
  context: ProviderContext,
  runtime: IrlClaimRuntime,
  assetId: string,
): Promise<Record<string, unknown>> {
  try {
    return await provider(context, runtime).getAssetProof(assetId, {
      restRetry: PROVIDER_REST_RETRY,
    });
  } catch (error) {
    throw translateProviderError(context, error, assetId);
  }
}

function parseRpcAccount(value: unknown, label: string): { owner: PublicKey; data: Uint8Array } {
  try {
    return parseSolanaRpcAccount(value, { maxEncodedBytes: PROVIDER_MAX_BYTES });
  } catch (error) {
    if (error instanceof SolanaProviderError && error.reason === 'account-shape') {
      throw new IrlClaimError('failed-precondition', `${label} is invalid.`);
    }
    throw new IrlClaimError('unavailable', 'Claim provider returned invalid account data.');
  }
}

function configuredRoutingMatches(runtime: IrlClaimRuntime, decoded: DecodedBoxMinterConfigData): boolean {
  const routing = decoded.paymentRouting;
  if (!routing || bs58.encode(decoded.treasury) !== runtime.config.treasury) return false;
  const configured = runtime.config.paymentRouting;
  if (!configured) return routing.schema === 'legacy';
  if (routing.schema !== 'split-payments-v1') return false;
  if (
    bs58.encode(routing.deliveryPaymentReceiver) !== configured.deliveryPaymentReceiver ||
    routing.mintProceeds.length !== configured.mintProceeds.length
  ) return false;
  return configured.mintProceeds.every((expected, index) => {
    const actual = routing.mintProceeds[index];
    return Boolean(actual) && bs58.encode(actual.address) === expected.address && actual.percentage === expected.percentage;
  });
}

function validateOnchainConfig(runtime: IrlClaimRuntime, decoded: DecodedBoxMinterConfigData): PublicKey {
  const coreCollection = new PublicKey(decoded.coreCollection);
  if (
    !coreCollection.equals(runtime.collectionMint) ||
    decoded.itemsPerBox !== runtime.itemsPerBox ||
    decoded.maxSupply !== runtime.config.maxSupply ||
    decoded.discountMintsPerWallet !== runtime.config.discountMintsPerWallet ||
    !boxMinterMetadataBaseMatchesDrop(
      decoded.uriBase,
      runtime.config.metadataBase,
      runtime.config.metadataBaseAliases,
    ) ||
    !configuredRoutingMatches(runtime, decoded)
  ) {
    throw new IrlClaimError('failed-precondition', 'Committed drop configuration does not match the on-chain config.', {
      dropId: runtime.dropId,
      configuredMetadataBase: runtime.config.metadataBase,
      onchainMetadataBase: normalizeBoxMinterMetadataBaseForComparison(decoded.uriBase),
    });
  }
  return coreCollection;
}

async function loadOnchainState(
  context: ProviderContext,
  runtime: IrlClaimRuntime,
): Promise<OnchainState> {
  const result = await rpcCall(context, runtime, 'getMultipleAccounts', [
    [runtime.collectionMint.toBase58(), runtime.boxMinterConfigPda.toBase58()],
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== 2) {
    throw new IrlClaimError('unavailable', 'Claim provider returned an invalid account response.');
  }
  if (!result.value[0] || !result.value[1]) {
    throw new IrlClaimError('failed-precondition', 'On-chain mint configuration is missing.', {
      dropId: runtime.dropId,
    });
  }
  const collection = parseRpcAccount(result.value[0], 'COLLECTION_MINT');
  const config = parseRpcAccount(result.value[1], 'BOX_MINTER_CONFIG_PDA');
  if (!collection.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new IrlClaimError('failed-precondition', 'COLLECTION_MINT is not an MPL Core collection account.');
  }
  if (!config.owner.equals(runtime.boxMinterProgramId)) {
    throw new IrlClaimError('failed-precondition', 'BOX_MINTER_CONFIG_PDA has an unexpected owner.');
  }
  let decoded: DecodedBoxMinterConfigData;
  try {
    decoded = decodeBoxMinterConfigData(config.data, {
      validateDiscriminator: true,
      validateItemsPerBox: true,
      normalizeDiscountMintsPerWallet: true,
      decodeExtensions: true,
    });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new IrlClaimError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
  return { config: decoded, coreCollection: validateOnchainConfig(runtime, decoded) };
}

async function loadLatestBlockhash(
  context: ProviderContext,
  runtime: IrlClaimRuntime,
): Promise<{ blockhash: string; blockhashContextSlot: number }> {
  const result = await rpcCall(context, runtime, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const contextValue = isRecord(result) ? result.context : undefined;
  const value = isRecord(result) ? result.value : undefined;
  const blockhash = isRecord(value) && typeof value.blockhash === 'string' ? value.blockhash : '';
  const lastValidBlockHeight = isRecord(value) ? value.lastValidBlockHeight : undefined;
  if (
    !isRecord(contextValue) ||
    !Number.isSafeInteger(contextValue.slot) ||
    Number(contextValue.slot) < 0 ||
    !Number.isSafeInteger(lastValidBlockHeight) ||
    Number(lastValidBlockHeight) < 0 ||
    !isNonZeroBase58Bytes(blockhash, 32)
  ) {
    throw new IrlClaimError('unavailable', 'Claim provider returned an invalid blockhash.');
  }
  return {
    blockhash,
    blockhashContextSlot: Number(contextValue.slot),
  };
}

async function loadLookupTable(
  context: ProviderContext,
  runtime: IrlClaimRuntime,
): Promise<AddressLookupTableAccount[]> {
  if (!runtime.deliveryLookupTable) return [];
  const result = await rpcCall(context, runtime, 'getAccountInfo', [
    runtime.deliveryLookupTable.toBase58(),
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  const value = isRecord(result) ? result.value : undefined;
  if (!value) return [];
  const account = parseRpcAccount(value, 'DELIVERY_LOOKUP_TABLE');
  if (!account.owner.equals(AddressLookupTableProgram.programId)) {
    throw new IrlClaimError('failed-precondition', 'DELIVERY_LOOKUP_TABLE has an unexpected owner.');
  }
  try {
    return [new AddressLookupTableAccount({
      key: runtime.deliveryLookupTable,
      state: AddressLookupTableAccount.deserialize(account.data),
    })];
  } catch {
    throw new IrlClaimError('failed-precondition', 'DELIVERY_LOOKUP_TABLE is invalid.');
  }
}

async function loadBoundWallet(
  context: CommerceReadContext,
  db: D1Database | undefined,
  uid: string,
): Promise<string> {
  try {
    if (!db) throw new IrlClaimError('unavailable', 'IRL claims are temporarily unavailable.');
    const resolution = await resolveD1AuthWalletBinding(db, uid, context.signal);
    if ('reason' in resolution) throw new IrlClaimError('unauthenticated', 'Sign in with your wallet first.');
    return resolution.wallet;
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    if (
      error instanceof IrlClaimError ||
      error instanceof ProfileReadError
    ) throw error;
    throw new IrlClaimError('unavailable', 'IRL claims are temporarily unavailable.');
  }
}

async function loadClaim(
  context: CommerceReadContext,
  code: string,
): Promise<Record<string, unknown> | null> {
  const document = await (context.repository || new D1CommerceRepository(context.commerceDb))
    .get(commerceKeys.claimCode(code));
  return document?.data || null;
}

async function resolveLegacyDropIds(context: CommerceReadContext, code: string): Promise<string[]> {
  const value = await (context.repository || new D1CommerceRepository(context.commerceDb)).query({
    kind: 'box_assignment',
    filters: [{ field: 'irlClaimCode', op: 'equal', value: code }],
    limit: 2,
  });
  const dropIds = new Set<string>();
  for (const document of value) {
    const dropId = normalizeDropId(document.key.dropId || '');
    if (dropId) dropIds.add(dropId);
  }
  return Array.from(dropIds);
}

function resolveClaimDropId(claim: Record<string, unknown>, legacyDropIds: string[]): string {
  if (typeof claim.dropId === 'string' && claim.dropId.trim()) return normalizeDropId(claim.dropId);
  if (legacyDropIds.length === 1) return legacyDropIds[0];
  if (legacyDropIds.length > 1) {
    throw new IrlClaimError('failed-precondition', 'Claim code is linked to multiple drops; contact support.');
  }
  throw new IrlClaimError('failed-precondition', 'Claim code record is missing dropId and could not be resolved.');
}

function decodeCosigner(secret: string): Keypair {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(secret.trim());
  } catch {
    throw new IrlClaimError('failed-precondition', 'COSIGNER_SECRET is not configured correctly.');
  }
  if (decoded.length !== 64) {
    throw new IrlClaimError('failed-precondition', 'COSIGNER_SECRET is not configured correctly.');
  }
  try {
    return Keypair.fromSecretKey(decoded);
  } catch {
    throw new IrlClaimError('failed-precondition', 'COSIGNER_SECRET is not configured correctly.');
  }
}

function u16LE(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function u64LE(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new IrlClaimError('failed-precondition', 'Invalid burn nonce');
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function borshOption(value?: Buffer | null): Buffer {
  return value ? Buffer.concat([Buffer.from([1]), value]) : Buffer.from([0]);
}

function bytes32(value: string, label: string): Buffer {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new IrlClaimError('failed-precondition', `Invalid ${label}`);
  }
  if (decoded.length !== 32) throw new IrlClaimError('failed-precondition', `Invalid ${label} length`);
  return Buffer.from(decoded);
}

type ProofContext = {
  merkleTree: PublicKey;
  root: Buffer;
  dataHash: Buffer;
  creatorHash: Buffer;
  assetDataHash: Buffer | null;
  flags: number | null;
  nonce: number;
  index: number;
  proofAccounts: PublicKey[];
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
};

function parseProof(
  asset: DasAsset,
  proof: Record<string, unknown>,
  runtime: IrlClaimRuntime,
  owner: string,
): ProofContext {
  const compression = isRecord(asset.compression) ? asset.compression : {};
  const merkleTree = assetProofTreePublicKey(proof);
  const root = typeof proof.root === 'string' ? proof.root : '';
  if (!merkleTree || !root) throw new IrlClaimError('failed-precondition', 'Unable to fetch certificate proof for burn');
  if (!merkleTree.equals(runtime.receiptsMerkleTree)) {
    throw new IrlClaimError('failed-precondition', 'Certificate does not belong to the configured receipts tree', {
      certificateTree: merkleTree.toBase58(),
      receiptsTree: runtime.receiptsMerkleTree.toBase58(),
      dropId: runtime.dropId,
    });
  }
  const nonce = Number(compression.leaf_id ?? compression.leafId);
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new IrlClaimError('failed-precondition', 'Unable to parse certificate leaf id');
  }
  const index = Math.floor(nonce);
  if (index > 0xffff_ffff) throw new IrlClaimError('failed-precondition', 'Certificate leaf index out of range');
  if (!Array.isArray(proof.proof) || proof.proof.length > 64) {
    throw new IrlClaimError('failed-precondition', 'Receipt proof path is invalid');
  }
  let proofAccounts: PublicKey[];
  try {
    proofAccounts = normalizedAssetProofAccounts(proof, {
      maxDepth: runtime.receiptsTreeMaxDepth,
      canopyDepth: runtime.receiptsTreeCanopyDepth,
    });
  } catch (error) {
    throw new IrlClaimError('failed-precondition', error instanceof Error ? error.message : 'Unable to parse receipt proof path');
  }
  const indexedOwner = isRecord(asset.ownership) && typeof asset.ownership.owner === 'string'
    ? asset.ownership.owner
    : '';
  if (indexedOwner !== owner) throw new IrlClaimError('failed-precondition', 'Receipt proof owner does not match the expected wallet');
  let leafOwner: PublicKey;
  let leafDelegate: PublicKey;
  try {
    leafOwner = new PublicKey(indexedOwner);
    leafDelegate = new PublicKey(
      isRecord(asset.ownership) && typeof asset.ownership.delegate === 'string'
        ? asset.ownership.delegate
        : indexedOwner,
    );
  } catch {
    throw new IrlClaimError('failed-precondition', 'Receipt proof owner is invalid');
  }
  const flags = compression.flags == null ? null : Number(compression.flags);
  if (flags != null && (!Number.isInteger(flags) || flags < 0 || flags > 0xff)) {
    throw new IrlClaimError('failed-precondition', 'Invalid burn flags');
  }
  return {
    merkleTree,
    root: bytes32(root, 'assetProof.root'),
    dataHash: bytes32(String(compression.data_hash ?? compression.dataHash ?? ''), 'asset.compression.data_hash'),
    creatorHash: bytes32(String(compression.creator_hash ?? compression.creatorHash ?? ''), 'asset.compression.creator_hash'),
    assetDataHash: compression.asset_data_hash || compression.assetDataHash
      ? bytes32(String(compression.asset_data_hash ?? compression.assetDataHash), 'asset.compression.asset_data_hash')
      : null,
    flags,
    nonce,
    index,
    proofAccounts,
    leafOwner,
    leafDelegate,
  };
}

function deriveTreeConfig(merkleTree: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([merkleTree.toBuffer()], BUBBLEGUM_PROGRAM_ID)[0];
}

function burnInstruction(
  owner: PublicKey,
  coreCollection: PublicKey,
  proof: ProofContext,
): TransactionInstruction {
  const data = Buffer.concat([
    IX_BURN_V2,
    proof.root,
    proof.dataHash,
    proof.creatorHash,
    borshOption(proof.assetDataHash),
    borshOption(proof.flags == null ? null : Buffer.from([proof.flags])),
    u64LE(proof.nonce),
    u32LE(proof.index),
  ]);
  return new TransactionInstruction({
    programId: BUBBLEGUM_PROGRAM_ID,
    keys: [
      { pubkey: deriveTreeConfig(proof.merkleTree), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: proof.leafOwner, isSigner: false, isWritable: false },
      { pubkey: proof.leafDelegate, isSigner: false, isWritable: false },
      { pubkey: proof.merkleTree, isSigner: false, isWritable: true },
      { pubkey: coreCollection, isSigner: false, isWritable: true },
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...proof.proofAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data,
  });
}

function mintReceiptsInstruction(
  runtime: IrlClaimRuntime,
  cosigner: PublicKey,
  owner: PublicKey,
  coreCollection: PublicKey,
  dudeIds: number[],
): TransactionInstruction {
  const data = Buffer.concat([
    IX_MINT_RECEIPTS,
    u32LE(0),
    u32LE(dudeIds.length),
    ...dudeIds.map(u16LE),
  ]);
  return new TransactionInstruction({
    programId: runtime.boxMinterProgramId,
    keys: [
      { pubkey: runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: cosigner, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: runtime.receiptsMerkleTree, isSigner: false, isWritable: true },
      { pubkey: deriveTreeConfig(runtime.receiptsMerkleTree), isSigner: false, isWritable: true },
      { pubkey: coreCollection, isSigner: false, isWritable: true },
      { pubkey: BUBBLEGUM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_CPI_SIGNER, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function transactionEncodingTooLarge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof RangeError && (
    /encoding overruns Uint8Array/i.test(message) ||
    /offset.*out of range/i.test(message) ||
    String((error as { code?: unknown }).code || '') === 'ERR_OUT_OF_RANGE'
  );
}

async function buildPreparedTransaction(args: {
  context: ProviderContext;
  runtime: IrlClaimRuntime;
  instructions: TransactionInstruction[];
  owner: PublicKey;
  cosigner: Keypair;
  blockhash: string;
  loadLookupTable: IrlClaimDependencies['loadLookupTable'];
}): Promise<Uint8Array> {
  const build = (lookups: AddressLookupTableAccount[]) => {
    const message = new TransactionMessage({
      payerKey: args.owner,
      recentBlockhash: args.blockhash,
      instructions: args.instructions,
    }).compileToV0Message(lookups);
    const transaction = new VersionedTransaction(message);
    transaction.sign([args.cosigner]);
    return transaction.serialize();
  };
  const buildWithLookup = (lookups: AddressLookupTableAccount[]) => {
    try {
      return build(lookups);
    } catch (error) {
      if (!transactionEncodingTooLarge(error)) throw error;
      throw new IrlClaimError('failed-precondition', 'Claim transaction is too large to encode.', {
        deliveryLookupTable: args.runtime.deliveryLookupTable?.toBase58() || '',
        receiptsMerkleTree: args.runtime.receiptsMerkleTree.toBase58(),
        dropId: args.runtime.dropId,
      });
    }
  };
  let raw: Uint8Array;
  try {
    raw = build([]);
  } catch (error) {
    if (!transactionEncodingTooLarge(error)) throw error;
    const lookups = await args.loadLookupTable(args.context, args.runtime);
    if (!lookups.length) throw new IrlClaimError('failed-precondition', 'Claim transaction is too large to encode.');
    raw = buildWithLookup(lookups);
  }
  if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    const lookups = await args.loadLookupTable(args.context, args.runtime);
    if (lookups.length) raw = buildWithLookup(lookups);
  }
  if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    throw new IrlClaimError('failed-precondition', `Claim transaction too large (${raw.length} bytes > ${SOLANA_MAX_RAW_TX_BYTES}).`, {
      rawBytes: raw.length,
      maxRawBytes: SOLANA_MAX_RAW_TX_BYTES,
      deliveryLookupTable: args.runtime.deliveryLookupTable?.toBase58() || '',
      receiptsMerkleTree: args.runtime.receiptsMerkleTree.toBase58(),
      dropId: args.runtime.dropId,
    });
  }
  return raw;
}

async function prepareClaim(args: {
  body: PrepareIrlClaimRequest;
  context: CommerceReadContext;
  providerContext: ProviderContext;
  identity: RequestIdentity;
  env: IrlClaimEnv;
  dependencies: IrlClaimDependencies;
}): Promise<PrepareIrlClaimResponse> {
  const sessionWallet = await resolveRequestWallet(
    args.identity,
    (uid) => args.dependencies.loadBoundWallet(args.context, args.env.OPS_DB, uid),
  );
  const owner = canonicalWallet(args.body.owner);
  if (sessionWallet !== owner) throw new IrlClaimError('permission-denied', 'Owners only');
  const normalizedCode = normalizeIrlClaimCode(args.body.code);
  if (!normalizedCode || normalizedCode.length !== IRL_CLAIM_CODE_DIGITS) {
    throw new IrlClaimError('invalid-argument', `Invalid claim code (must be ${IRL_CLAIM_CODE_DIGITS} digits)`);
  }
  const claim = await args.dependencies.loadClaim(args.context, normalizedCode);
  if (!claim) throw new IrlClaimError('not-found', 'Invalid claim code');
  const legacyDropIds = typeof claim.dropId === 'string' && claim.dropId.trim()
    ? []
    : await args.dependencies.resolveLegacyDropIds(args.context, normalizedCode);
  const dropId = resolveClaimDropId(claim, legacyDropIds);
  const drop = args.dependencies.getDrop(dropId);
  if (!drop) throw new IrlClaimError('invalid-argument', `Unsupported dropId: ${dropId}`);
  const runtime = buildRuntime(drop);
  if (clusterSharesCollection(runtime)) {
    throw new IrlClaimError('failed-precondition', 'IRL claim code cannot be disambiguated for a shared collection mint', {
      dropId,
      expectedCollectionMint: runtime.collectionMint.toBase58(),
    });
  }
  const boxId = Number(claim.boxId);
  const boxIdString = claim.boxId == null ? '' : String(claim.boxId);
  if (!Number.isFinite(boxId) || boxId <= 0 || boxId > 0xffff_ffff || !boxIdString) {
    throw new IrlClaimError('failed-precondition', 'Claim code is missing a valid box id');
  }
  const rawDudeIds = claim.dudeIds ?? claim.dude_ids ?? claim.dudes ?? [];
  const dudeIds = Array.isArray(rawDudeIds) ? rawDudeIds.map(Number) : [];
  if (dudeIds.length !== runtime.itemsPerBox) {
    throw new IrlClaimError('failed-precondition', `Claim has invalid dudeIds (expected ${runtime.itemsPerBox})`);
  }
  for (const id of dudeIds) {
    if (!Number.isInteger(id) || id < 1 || id > runtime.maxDudeId) {
      throw new IrlClaimError('failed-precondition', `Invalid dude id: ${id}`);
    }
  }
  if (new Set(dudeIds).size !== dudeIds.length) {
    throw new IrlClaimError('failed-precondition', 'Duplicate dude ids in claim');
  }
  const onchain = await args.dependencies.loadOnchainState(args.providerContext, runtime);
  const cosigner = decodeCosigner(String(args.env.COSIGNER_SECRET || ''));
  const expectedAdmin = new PublicKey(onchain.config.admin);
  if (!cosigner.publicKey.equals(expectedAdmin)) {
    throw new IrlClaimError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: expectedAdmin.toBase58(),
      cosigner: cosigner.publicKey.toBase58(),
    });
  }
  const assets = await args.dependencies.fetchOwnedAssets(args.providerContext, runtime, owner);
  const requestedCertificates = assets.filter((asset) =>
    dasAssetKind(asset, NAME_POLICY) === 'certificate' &&
    uniqueAssetGroupingCollectionMint(asset) === runtime.collectionMint.toBase58());
  const dudeIdSet = new Set(dudeIds);
  if (requestedCertificates.some((asset) => {
    const id = dasAssetDudeId(asset);
    return id != null && dudeIdSet.has(id);
  })) {
    throw new IrlClaimError('failed-precondition', 'This IRL claim code has already been used');
  }
  const certificate = requestedCertificates.find((asset) => dasAssetBoxId(asset, NAME_POLICY) === boxIdString);
  if (!certificate) throw new IrlClaimError('failed-precondition', 'Matching box certificate not found in wallet');
  if (dasAssetLooksBurntOrClosed(certificate, BURN_POLICY)) {
    throw new IrlClaimError('failed-precondition', 'This IRL claim code has already been used');
  }
  const indexedOwner = isRecord(certificate.ownership) ? certificate.ownership.owner : undefined;
  if (indexedOwner !== owner) throw new IrlClaimError('failed-precondition', 'Matching box certificate not found in wallet');
  const certificateId = typeof certificate.id === 'string' ? certificate.id : '';
  if (!certificateId) throw new IrlClaimError('failed-precondition', 'Certificate is missing an asset id');
  try {
    if (new PublicKey(certificateId).toBase58() !== certificateId) throw new Error('invalid');
  } catch {
    throw new IrlClaimError('failed-precondition', 'Certificate asset id is invalid');
  }
  const proof = parseProof(
    certificate,
    await args.dependencies.fetchAssetProof(args.providerContext, runtime, certificateId),
    runtime,
    owner,
  );
  const ownerKey = new PublicKey(owner);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    burnInstruction(ownerKey, onchain.coreCollection, proof),
    mintReceiptsInstruction(runtime, cosigner.publicKey, ownerKey, onchain.coreCollection, dudeIds),
  ];
  const latestBlockhash = await args.dependencies.loadLatestBlockhash(args.providerContext, runtime);
  const raw = await buildPreparedTransaction({
    context: args.providerContext,
    runtime,
    instructions,
    owner: ownerKey,
    cosigner,
    blockhash: latestBlockhash.blockhash,
    loadLookupTable: args.dependencies.loadLookupTable,
  });
  return {
    encodedTx: Buffer.from(raw).toString('base64'),
    blockhashContextSlot: latestBlockhash.blockhashContextSlot,
    dropId,
    certificates: dudeIds,
    certificateId,
    message: 'Sign and send to burn your box receipt and mint your dude receipts.',
  };
}

const defaultDependencies: IrlClaimDependencies = {
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
  getDrop: getApiDrop,
  loadBoundWallet,
  loadClaim,
  resolveLegacyDropIds,
  fetchOwnedAssets,
  fetchAssetProof,
  loadOnchainState,
  loadLatestBlockhash,
  loadLookupTable,
};

export async function handleIrlClaimPrepare(
  request: Request,
  env: IrlClaimEnv,
  overrides: Partial<IrlClaimDependencies> = {},
): Promise<IrlClaimResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new IrlClaimError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { headers: response.headers, status: 405 }),
      metrics: { upstreamCalls: 0, providerDurationMs: 0 },
      authOutcome: 'rejected',
    };
  }
  return withAuthenticatedRequest<IrlClaimResult>(request, {
    opsDb: env.OPS_DB,
    timeoutMessage: 'IRL claim request timed out',
    dependencies,
  }, async ({ deadline, metrics, trackedFetch, authenticate }) => {
    const boundedRead = <T>(operation: Promise<T>) => raceReadWithSignal(operation, deadline.signal);
    let identity: RequestIdentity | undefined;
    let dropId: string | undefined;
    try {
      const body = await readRequestBody(request, deadline.signal);
      identity = await authenticate();
      const apiKey = String(env.HELIUS_API_KEY || '').trim();
      if (!apiKey) {
        throw new IrlClaimError('unavailable', 'IRL claims are temporarily unavailable.');
      }
      const response = await boundedRead(prepareClaim({
        body,
        identity,
        env,
        dependencies,
        context: {
          commerceDb: env.COMMERCE_DB,
          repository: new D1CommerceRepository(env.COMMERCE_DB),
          nowMs: dependencies.nowMs(),
          providerFetch: trackedFetch,
          signal: deadline.signal,
        },
        providerContext: {
          apiKey,
          providerFetch: trackedFetch,
          signal: deadline.signal,
        },
      }));
      dropId = response.dropId;
      return { response: jsonResponse(response, 200), metrics, authOutcome: 'accepted', dropId };
    } catch (error) {
      if (isRequestCancellationError(request, error)) throw error;
      let claimError: IrlClaimError;
      let authOutcome: IrlClaimResult['authOutcome'] = identity ? 'provider-failure' : 'rejected';
      if (error instanceof IrlClaimError) {
        claimError = error;
        if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
          authOutcome = 'rejected';
        }
      } else if (error instanceof RequestIdentityError) {
        claimError = error.kind === 'invalid-token'
          ? new IrlClaimError('unauthenticated', 'Authentication is required.')
          : error.kind === 'provider-timeout'
            ? new IrlClaimError('deadline-exceeded', 'IRL claim request timed out.')
            : new IrlClaimError('unavailable', 'Authentication is temporarily unavailable.');
        authOutcome = error.kind === 'invalid-token' ? 'rejected' : 'provider-failure';
      } else if (error instanceof ProfileReadError) {
        claimError = new IrlClaimError(error.code, error.message, error.details);
        if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
          authOutcome = 'rejected';
        }
      } else if (deadline.timedOut()) {
        claimError = new IrlClaimError('deadline-exceeded', 'IRL claim request timed out.');
      } else {
        console.error({
          event: 'irl_claim_prepare_failed',
          error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
        });
        claimError = new IrlClaimError('internal', 'IRL claim preparation failed.');
      }
      return { response: errorResponse(claimError), metrics, authOutcome, ...(dropId ? { dropId } : {}) };
    }
  });
}

export const irlClaimTestHooks = {
  buildPreparedTransaction,
  buildRuntime,
  burnInstruction,
  fetchAssetProof,
  fetchOwnedAssets,
  loadClaim,
  loadLatestBlockhash,
  loadLookupTable,
  loadOnchainState,
  loadBoundWallet,
  mintReceiptsInstruction,
  parseProof,
  rpcCall,
  resolveLegacyDropIds,
  resolveClaimDropId,
  searchAssetsResult,
  validateOnchainConfig,
};
