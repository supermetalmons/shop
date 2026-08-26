import bs58 from 'bs58';
import { z } from 'zod';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
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
import { bubblegumTransferV2Ix } from './bubblegum.js';
import {
  dropAdminIrlRedeemReceiptMarkerPath,
  dropAdminIrlRedeemRequestPath,
} from './dropPaths.js';
import {
  assetMatchesReceiptDropIdentity,
  assetMatchesReceiptMetadataIdentity,
  assetProofTreePublicKey,
  normalizedAssetProofAccounts,
  receiptMetadataReference,
} from './receiptProof.js';
import {
  getAdminIrlRedeemTargetEligibility,
  isAdminIrlRedeemDropFamily,
  type AdminIrlRedeemTargetKind,
} from '../../../../shared/adminIrlEligibility.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_PENDING_OPEN_SEED,
  isConfiguredBoxMinterItemsPerBox,
} from '../../../../shared/boxMinterProtocol.js';
import {
  ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER,
  type AdminIrlRedeemPrepareRequest,
  type AdminIrlRedeemPreparedTxResponse,
} from '../../../../shared/contracts.js';
import {
  assetGroupingCollectionMints,
  HELIUS_COLLECTION_GROUPING_OPTIONS,
  uniqueAssetGroupingCollectionMint,
} from '../../../../shared/dasAssetCollections.js';
import {
  dasAssetBoxId,
  dasAssetKind,
  dasAssetLooksBurntOrClosed,
  type DasAsset,
} from '../../../../shared/dasAsset.js';
import {
  normalizeDropId,
  type SolanaCluster,
} from '../../../../shared/deploymentCore.js';
import {
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  walletHasAdminIrlRedeemAccess,
} from '../../../../shared/fulfillmentAccess.js';
import { HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES } from '../../../../shared/heliusDas.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import {
  RequestIdentityError,
  isStaffRequestIdentity,
  resolveRequestWallet,
  verifyRequestIdentity,
  type RequestIdentity,
} from './requestIdentity.js';
import {
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENTS_BASE_URL,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FirestoreWriteConflict,
  ProfileReadError,
  authenticatedFirestoreRequest,
  cancelResponseBody,
  createGoogleAccessTokenProvider,
  decodeFirestoreFields,
  firestoreString,
  isRecord,
  readBoundedJson,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';
import { resolveD1WalletSession } from './walletSessionD1.js';

export const ADMIN_IRL_REDEEM_PREPARE_PATH = '/admin/irl-redeem/prepare';
export { ADMIN_IRL_REDEEM_PREPARE_ATTEMPT_HEADER };

const REQUEST_MAX_BYTES = 4096;
const PROVIDER_MAX_BYTES = HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES;
const HANDLER_TIMEOUT_MS = 55_000;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;
const MAX_ITEMS = 32;
const ASSET_FETCH_CONCURRENCY = 4;
const PREPARED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const DUMMY_BLOCKHASH = '11111111111111111111111111111111';
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
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
  'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON' | 'HELIUS_API_KEY'
> & Partial<Pick<Env, 'COMMERCE_DB' | 'OPS_DB'>>;

type AdminIrlRedeemPrepareErrorCode =
  | 'invalid-argument'
  | 'unauthenticated'
  | 'permission-denied'
  | 'not-found'
  | 'aborted'
  | 'failed-precondition'
  | 'resource-exhausted'
  | 'deadline-exceeded'
  | 'unavailable'
  | 'internal';

class AdminIrlRedeemPrepareError extends Error {
  constructor(
    readonly code: AdminIrlRedeemPrepareErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdminIrlRedeemPrepareError';
  }
}

type AdminIrlRedeemRuntime = {
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
  maxSupply: number;
  maxDudeId: number;
  receiptMaxId: number;
};

type FirestoreContext = {
  accessTokenProvider: GoogleAccessTokenProvider;
  commerceDb?: D1Database;
  nowMs: number;
  providerFetch: ProfileProviderFetch;
  serviceAccountJson: string;
  signal: AbortSignal;
};

type ProviderContext = {
  apiKey: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
  attemptTimeoutMs?: number;
};

type OnchainState = {
  admin: PublicKey;
  coreCollection: PublicKey;
};

type PreparedItem = {
  assetId: string;
  kind: 'box' | 'card_receipt';
  refId: number;
};

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

type CreateRequestInput = {
  adminWallet: string;
  dropId: string;
  itemIds: string[];
  items: PreparedItem[];
  owner: string;
  prepareAttemptId?: string;
  requestId: string;
  targetKind: AdminIrlRedeemTargetKind;
};

type AdminIrlRedeemPrepareDependencies = {
  accessTokenProvider: GoogleAccessTokenProvider;
  autoId: () => string;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
  getDrop: (dropId: string) => ApiDropConfig | undefined;
  loadWalletSession: (
    context: FirestoreContext,
    db: D1Database | undefined,
    uid: string,
  ) => Promise<string>;
  loadReceiptMarker: (context: FirestoreContext, dropId: string, assetId: string) => Promise<boolean>;
  createRequest: (context: FirestoreContext, input: CreateRequestInput) => Promise<void>;
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

function statusForCode(code: AdminIrlRedeemPrepareErrorCode): number {
  if (code === 'invalid-argument') return 400;
  if (code === 'unauthenticated') return 401;
  if (code === 'permission-denied') return 403;
  if (code === 'not-found') return 404;
  if (code === 'aborted' || code === 'failed-precondition') return 409;
  if (code === 'resource-exhausted') return 429;
  if (code === 'deadline-exceeded') return 504;
  if (code === 'unavailable') return 502;
  return 500;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function errorResponse(error: AdminIrlRedeemPrepareError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, statusForCode(error.code));
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<AdminIrlRedeemPrepareRequest> {
  const contentType = String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await request.body?.cancel().catch(() => undefined);
    throw new AdminIrlRedeemPrepareError('invalid-argument', 'Content-Type must be application/json.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new AdminIrlRedeemPrepareError('invalid-argument', 'Admin IRL redeem request is too large.');
  }
  if (!request.body) throw new AdminIrlRedeemPrepareError('invalid-argument', 'Invalid Admin IRL redeem request.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > REQUEST_MAX_BYTES) {
        throw new AdminIrlRedeemPrepareError('invalid-argument', 'Admin IRL redeem request is too large.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    let value: unknown;
    try {
      value = JSON.parse(chunks.join(''));
    } catch {
      throw new AdminIrlRedeemPrepareError('invalid-argument', 'Invalid Admin IRL redeem request.');
    }
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) throw new AdminIrlRedeemPrepareError('invalid-argument', 'Invalid Admin IRL redeem request.');
    return parsed.data;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof AdminIrlRedeemPrepareError) throw error;
    throw new AdminIrlRedeemPrepareError('invalid-argument', 'Invalid Admin IRL redeem request.');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new AdminIrlRedeemPrepareError('invalid-argument', `Invalid ${label}`);
  }
}

function configuredPublicKey(label: string, value: string | undefined, required = true): PublicKey | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return undefined;
    throw new AdminIrlRedeemPrepareError('failed-precondition', `${label} is not configured.`);
  }
  try {
    const key = new PublicKey(normalized);
    if (required && key.equals(PublicKey.default)) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', `${label} is not configured.`);
    }
    return key;
  } catch (error) {
    if (error instanceof AdminIrlRedeemPrepareError) throw error;
    throw new AdminIrlRedeemPrepareError('failed-precondition', `${label} is invalid.`);
  }
}

function buildRuntime(config: ApiDropConfig): AdminIrlRedeemRuntime {
  const dropId = normalizeDropId(config.dropId);
  const maxSupply = Number(config.maxSupply);
  const itemsPerBox = Number(config.itemsPerBox);
  const receiptMaxId = Number(config.receiptMaxId ?? maxSupply);
  const maxDudeId = maxSupply * itemsPerBox;
  const receiptsTreeMaxDepth = Number(config.receiptsTreeMaxDepth);
  const receiptsTreeCanopyDepth = Number(config.receiptsTreeCanopyDepth ?? 0);
  if (
    !Number.isInteger(maxSupply) || maxSupply < 1 ||
    !isConfiguredBoxMinterItemsPerBox(itemsPerBox) ||
    !Number.isInteger(receiptMaxId) || receiptMaxId < maxSupply || receiptMaxId > 0xffff_ffff ||
    !Number.isSafeInteger(maxDudeId) || maxDudeId > 0xffff ||
    !Number.isInteger(receiptsTreeCanopyDepth) || receiptsTreeCanopyDepth < 0 ||
    (Number.isInteger(receiptsTreeMaxDepth) && receiptsTreeCanopyDepth >= receiptsTreeMaxDepth)
  ) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem drop configuration is invalid.', { dropId });
  }
  const boxMinterProgramId = configuredPublicKey('BOX_MINTER_PROGRAM_ID', config.boxMinterProgramId)!;
  const boxMinterConfigPda = configuredPublicKey('BOX_MINTER_CONFIG_PDA', config.boxMinterConfigPda, false) ||
    PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0];
  return {
    config,
    dropId,
    cluster: config.solanaCluster,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint: configuredPublicKey('COLLECTION_MINT', config.collectionMint)!,
    receiptsMerkleTree: configuredPublicKey('RECEIPTS_MERKLE_TREE', config.receiptsMerkleTree)!,
    deliveryLookupTable: configuredPublicKey('DELIVERY_LOOKUP_TABLE', config.deliveryLookupTable, false),
    ...(Number.isInteger(receiptsTreeMaxDepth) && receiptsTreeMaxDepth > 0 ? { receiptsTreeMaxDepth } : {}),
    receiptsTreeCanopyDepth,
    itemsPerBox,
    maxSupply,
    maxDudeId,
    receiptMaxId,
  };
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

function heliusOrigin(cluster: SolanaCluster): string {
  return `https://${cluster === 'mainnet-beta' ? 'mainnet' : cluster}.helius-rpc.com/`;
}

async function pause(signal: AbortSignal, delay = 100): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, delay);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function createProviderAttemptScope(overallSignal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(overallSignal.reason);
  };
  if (overallSignal.aborted) onAbort();
  else overallSignal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Admin IRL redeem provider request timed out', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      overallSignal.removeEventListener('abort', onAbort);
    },
  };
}

async function rpcCall(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = `admin-irl-redeem-${method}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptScope = createProviderAttemptScope(
      context.signal,
      context.attemptTimeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS,
    );
    try {
      const response = await context.providerFetch(
        `${heliusOrigin(runtime.cluster)}?api-key=${encodeURIComponent(context.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          redirect: 'manual',
          signal: attemptScope.signal,
        },
      );
      if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt === 0) {
        await cancelResponseBody(response);
        await pause(context.signal);
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider is temporarily unavailable.');
      }
      const payload = await readBoundedJson(response, PROVIDER_MAX_BYTES, attemptScope.signal);
      if (!isRecord(payload) || payload.jsonrpc !== '2.0' || payload.id !== id) {
        throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid response.');
      }
      if (isRecord(payload.error)) {
        const upstreamCode = Number(payload.error.code);
        throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider is temporarily unavailable.', {
          method,
          ...(Number.isFinite(upstreamCode) ? { upstreamCode } : {}),
        });
      }
      if (!Object.hasOwn(payload, 'result')) {
        throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid response.');
      }
      return payload.result;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (attemptScope.timedOut()) {
        if (attempt === 0) {
          await pause(context.signal);
          continue;
        }
        throw new AdminIrlRedeemPrepareError('deadline-exceeded', 'Admin IRL redeem provider request timed out.');
      }
      if (error instanceof AdminIrlRedeemPrepareError) throw error;
      if (attempt === 0) {
        await pause(context.signal);
        continue;
      }
      throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider is temporarily unavailable.');
    } finally {
      attemptScope.dispose();
    }
  }
  throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider is temporarily unavailable.');
}

async function restJson(context: ProviderContext, url: string, missingMessage: string): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptScope = createProviderAttemptScope(
      context.signal,
      context.attemptTimeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS,
    );
    try {
      const response = await context.providerFetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: attemptScope.signal,
      });
      if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt === 0) {
        await cancelResponseBody(response);
        await pause(context.signal);
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new AdminIrlRedeemPrepareError(
          response.status === 404 ? 'not-found' : 'unavailable',
          response.status === 404 ? missingMessage : 'Admin IRL redeem provider is temporarily unavailable.',
        );
      }
      return await readBoundedJson(response, PROVIDER_MAX_BYTES, attemptScope.signal);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (attemptScope.timedOut()) {
        if (attempt === 0) {
          await pause(context.signal);
          continue;
        }
        throw new AdminIrlRedeemPrepareError('deadline-exceeded', 'Admin IRL redeem provider request timed out.');
      }
      if (error instanceof AdminIrlRedeemPrepareError) throw error;
      if (attempt === 0) {
        await pause(context.signal);
        continue;
      }
      throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid response.');
    } finally {
      attemptScope.dispose();
    }
  }
  throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider is temporarily unavailable.');
}

async function fetchAssetOnce(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
  assetId: string,
): Promise<DasAsset> {
  let value: unknown;
  try {
    value = await rpcCall(context, runtime, 'getAsset', {
      id: assetId,
      options: HELIUS_COLLECTION_GROUPING_OPTIONS,
    });
  } catch (error) {
    const upstreamCode = error instanceof AdminIrlRedeemPrepareError && isRecord(error.details)
      ? Number(error.details.upstreamCode)
      : Number.NaN;
    if (upstreamCode !== -32601 && upstreamCode !== -32602) throw error;
    const cluster = runtime.cluster === 'mainnet-beta' ? '' : `&cluster=${encodeURIComponent(runtime.cluster)}`;
    const payload = await restJson(
      context,
      `https://api.helius.xyz/v0/assets?ids[]=${encodeURIComponent(assetId)}&api-key=${encodeURIComponent(context.apiKey)}${cluster}`,
      'Asset not found.',
    );
    value = Array.isArray(payload) ? payload[0] : undefined;
  }
  if (!isRecord(value)) {
    throw new AdminIrlRedeemPrepareError('not-found', 'Asset not found. If you just transferred or minted it, wait a few seconds and try again.');
  }
  return value;
}

async function fetchAsset(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
  assetId: string,
): Promise<DasAsset> {
  const startedAt = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < 6 && Date.now() - startedAt < 12_000; attempt += 1) {
    try {
      return await fetchAssetOnce(context, runtime, assetId);
    } catch (error) {
      lastError = error;
      if (
        error instanceof AdminIrlRedeemPrepareError &&
        !['not-found', 'unavailable', 'resource-exhausted', 'deadline-exceeded'].includes(error.code)
      ) throw error;
      if (attempt < 5) await pause(context.signal, 300 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider is temporarily unavailable.');
}

async function fetchAssetProof(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
  assetId: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await rpcCall(context, runtime, 'getAssetProof', { id: assetId });
  } catch (error) {
    const upstreamCode = error instanceof AdminIrlRedeemPrepareError && isRecord(error.details)
      ? Number(error.details.upstreamCode)
      : Number.NaN;
    if (upstreamCode !== -32601 && upstreamCode !== -32602) throw error;
    const cluster = runtime.cluster === 'mainnet-beta' ? '' : `&cluster=${encodeURIComponent(runtime.cluster)}`;
    value = await restJson(
      context,
      `https://api.helius.xyz/v0/assets/${encodeURIComponent(assetId)}/proof?api-key=${encodeURIComponent(context.apiKey)}${cluster}`,
      'Asset proof not found',
    );
  }
  if (!isRecord(value)) throw new AdminIrlRedeemPrepareError('not-found', 'Asset proof not found', { assetId });
  return value;
}

function parseRpcAccount(value: unknown, label: string): { owner: PublicKey; data: Uint8Array } {
  if (!isRecord(value) || typeof value.owner !== 'string' || !Array.isArray(value.data)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', `${label} is invalid.`);
  }
  const encoded = value.data[0];
  if (typeof encoded !== 'string' || value.data[1] !== 'base64' || encoded.length > PROVIDER_MAX_BYTES) {
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned invalid account data.');
  }
  try {
    return { owner: new PublicKey(value.owner), data: Buffer.from(encoded, 'base64') };
  } catch {
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned invalid account data.');
  }
}

async function loadOnchainState(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
): Promise<OnchainState> {
  const result = await rpcCall(context, runtime, 'getMultipleAccounts', [
    [runtime.collectionMint.toBase58(), runtime.boxMinterConfigPda.toBase58()],
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== 2) {
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid account response.');
  }
  if (!result.value[0]) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Configured collection was not found on-chain.', {
      collection: runtime.collectionMint.toBase58(),
      dropId: runtime.dropId,
    });
  }
  if (!result.value[1]) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Box minter config PDA not found.', {
      configPda: runtime.boxMinterConfigPda.toBase58(),
      dropId: runtime.dropId,
    });
  }
  const collection = parseRpcAccount(result.value[0], 'COLLECTION_MINT');
  const config = parseRpcAccount(result.value[1], 'BOX_MINTER_CONFIG_PDA');
  if (!collection.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Configured collection is not an MPL Core collection.');
  }
  if (!config.owner.equals(runtime.boxMinterProgramId)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Box minter config PDA has an unexpected owner.', {
      configPda: runtime.boxMinterConfigPda.toBase58(),
      expectedOwner: runtime.boxMinterProgramId.toBase58(),
      actualOwner: config.owner.toBase58(),
      dropId: runtime.dropId,
    });
  }
  let decoded: DecodedBoxMinterConfigData;
  try {
    decoded = decodeBoxMinterConfigData(config.data, {
      validateDiscriminator: true,
      decodeExtensions: true,
    });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
  const coreCollection = new PublicKey(decoded.coreCollection);
  if (!coreCollection.equals(runtime.collectionMint)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'COLLECTION_MINT does not match on-chain config', {
      configured: runtime.collectionMint.toBase58(),
      onchain: coreCollection.toBase58(),
      dropId: runtime.dropId,
    });
  }
  return { admin: new PublicKey(decoded.admin), coreCollection };
}

function pendingOpenPda(runtime: AdminIrlRedeemRuntime, asset: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BOX_MINTER_PENDING_OPEN_SEED), asset.toBuffer()],
    runtime.boxMinterProgramId,
  )[0];
}

async function loadPendingOpenAccounts(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
  assets: PublicKey[],
): Promise<boolean[]> {
  const result = await rpcCall(context, runtime, 'getMultipleAccounts', [
    assets.map((asset) => pendingOpenPda(runtime, asset).toBase58()),
    { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 }, encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== assets.length) {
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid pending-open response.');
  }
  return result.value.map(Boolean);
}

async function loadLatestBlockhash(context: ProviderContext, runtime: AdminIrlRedeemRuntime): Promise<string> {
  const result = await rpcCall(context, runtime, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const value = isRecord(result) ? result.value : undefined;
  const blockhash = isRecord(value) && typeof value.blockhash === 'string' ? value.blockhash : '';
  try {
    if (!blockhash || new PublicKey(blockhash).toBytes().length !== 32) throw new Error('invalid');
  } catch {
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem provider returned an invalid blockhash.');
  }
  return blockhash;
}

async function loadLookupTable(
  context: ProviderContext,
  runtime: AdminIrlRedeemRuntime,
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
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE has an unexpected owner.');
  }
  try {
    const lookup = new AddressLookupTableAccount({
      key: runtime.deliveryLookupTable,
      state: AddressLookupTableAccount.deserialize(account.data),
    });
    return lookup.isActive() ? [lookup] : [];
  } catch {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE is invalid.');
  }
}

async function loadWalletSession(
  context: FirestoreContext,
  db: D1Database | undefined,
  uid: string,
): Promise<string> {
  try {
    if (!db) {
      throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem preparation is temporarily unavailable.');
    }
    const resolution = await resolveD1WalletSession(db, uid, context.signal);
    if ('reason' in resolution) throw new AdminIrlRedeemPrepareError('unauthenticated', 'Sign in with your wallet first.');
    return resolution.wallet;
  } catch (error) {
    if (error instanceof AdminIrlRedeemPrepareError || error instanceof ProfileReadError || context.signal.aborted) throw error;
    throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem preparation is temporarily unavailable.');
  }
}

async function loadReceiptMarker(
  context: FirestoreContext,
  dropId: string,
  assetId: string,
): Promise<boolean> {
  const path = dropAdminIrlRedeemReceiptMarkerPath(dropId, assetId);
  return Boolean(await authenticatedFirestoreRequest({
    ...context,
    method: 'GET',
    url: `${FIRESTORE_DOCUMENTS_BASE_URL}/${path}`,
  }));
}

function firestoreInteger(value: number): Record<string, string> {
  return { integerValue: String(value) };
}

function firestoreItem(item: PreparedItem): Record<string, unknown> {
  return {
    mapValue: {
      fields: {
        assetId: firestoreString(item.assetId),
        kind: firestoreString(item.kind),
        refId: firestoreInteger(item.refId),
      },
    },
  };
}

function requestMatches(value: unknown, input: CreateRequestInput): boolean {
  if (!isRecord(value)) return false;
  const fields = decodeFirestoreFields(value.fields);
  return Boolean(
    fields &&
    fields.status === 'prepared' &&
    fields.dropId === input.dropId &&
    fields.owner === input.owner &&
    fields.adminWallet === input.adminWallet &&
    fields.targetKind === input.targetKind &&
    JSON.stringify(fields.itemIds) === JSON.stringify(input.itemIds) &&
    (input.prepareAttemptId === undefined || fields.prepareAttemptId === input.prepareAttemptId)
  );
}

async function createRequest(context: FirestoreContext, input: CreateRequestInput): Promise<void> {
  const path = dropAdminIrlRedeemRequestPath(input.dropId, input.requestId);
  const fields: Record<string, unknown> = {
    dropId: firestoreString(input.dropId),
    status: firestoreString('prepared'),
    owner: firestoreString(input.owner),
    targetKind: firestoreString(input.targetKind),
    adminWallet: firestoreString(input.adminWallet),
    itemIds: { arrayValue: { values: input.itemIds.map(firestoreString) } },
    items: { arrayValue: { values: input.items.map(firestoreItem) } },
    preparedExpiresAt: { timestampValue: new Date(context.nowMs + PREPARED_TTL_MS).toISOString() },
    ...(input.prepareAttemptId ? { prepareAttemptId: firestoreString(input.prepareAttemptId) } : {}),
  };
  try {
    const payload = await authenticatedFirestoreRequest({
      ...context,
      body: JSON.stringify({
        writes: [{
          update: {
            name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`,
            fields,
          },
          currentDocument: { exists: false },
          updateTransforms: [
            { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        }],
      }),
      method: 'POST',
      surfaceWriteConflict: true,
      url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
    });
    const results = isRecord(payload) ? payload.writeResults : undefined;
    if (!Array.isArray(results) || !isRecord(results[0]) || typeof results[0].updateTime !== 'string') {
      throw new AdminIrlRedeemPrepareError('unavailable', 'Admin IRL redeem preparation is temporarily unavailable.');
    }
  } catch (error) {
    if (error instanceof FirestoreWriteConflict) {
      throw new AdminIrlRedeemPrepareError('aborted', 'Admin IRL redeem request collision. Retry.');
    }
    const reconciled = await authenticatedFirestoreRequest({
      ...context,
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
      url: `${FIRESTORE_DOCUMENTS_BASE_URL}/${path}`,
    }).catch(() => null);
    if (requestMatches(reconciled, input)) return;
    throw error;
  }
}

function firestoreAutoId(): string {
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

function receiptDropIdentity(runtime: AdminIrlRedeemRuntime) {
  return {
    collectionMintStr: runtime.collectionMint.toBase58(),
    metadataBase: runtime.config.metadataBase,
    metadataBaseAliases: runtime.config.metadataBaseAliases,
    receiptsMerkleTree: runtime.receiptsMerkleTree,
    receiptPoolId: runtime.config.receiptPoolId,
    receiptMaxId: runtime.receiptMaxId,
  };
}

function bytes32(value: string, label: string): Buffer {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new AdminIrlRedeemPrepareError('failed-precondition', `Invalid ${label}`);
  }
  if (decoded.length !== 32) throw new AdminIrlRedeemPrepareError('failed-precondition', `Invalid ${label} length`);
  return Buffer.from(decoded);
}

function parseProof(
  asset: DasAsset,
  proof: Record<string, unknown>,
  runtime: AdminIrlRedeemRuntime,
  owner: string,
): ProofContext {
  const compression = isRecord(asset.compression) ? asset.compression : {};
  const merkleTree = assetProofTreePublicKey(proof);
  const root = typeof proof.root === 'string' ? proof.root : '';
  if (!merkleTree || !root) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Unable to fetch receipt proof for transfer');
  }
  if (!merkleTree.equals(runtime.receiptsMerkleTree)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Receipt does not belong to the configured receipts tree');
  }
  const nonce = Number(compression.leaf_id ?? compression.leafId);
  if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce > 0xffff_ffff) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Unable to parse receipt leaf id');
  }
  let proofAccounts: PublicKey[];
  try {
    proofAccounts = normalizedAssetProofAccounts(proof, {
      maxDepth: runtime.receiptsTreeMaxDepth,
      canopyDepth: runtime.receiptsTreeCanopyDepth,
    });
  } catch (error) {
    throw new AdminIrlRedeemPrepareError(
      'failed-precondition',
      error instanceof Error ? error.message : 'Unable to parse receipt proof path',
    );
  }
  const indexedOwner = isRecord(asset.ownership) && typeof asset.ownership.owner === 'string'
    ? asset.ownership.owner
    : '';
  if (indexedOwner !== owner) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Receipt proof owner does not match the expected wallet');
  }
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
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Receipt proof owner is invalid');
  }
  const flags = compression.flags == null ? null : Number(compression.flags);
  if (flags != null && (!Number.isInteger(flags) || flags < 0 || flags > 0xff)) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Receipt proof flags are invalid');
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
    index: nonce,
    proofAccounts,
    leafOwner,
    leafDelegate,
  };
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
  proof: ProofContext,
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

function transactionEncodingTooLarge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof RangeError && (
    /encoding overruns Uint8Array/i.test(message) ||
    /offset.*out of range/i.test(message) ||
    String((error as { code?: unknown }).code || '') === 'ERR_OUT_OF_RANGE'
  );
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
    if (!transactionEncodingTooLarge(error)) throw error;
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
  const build = (lookups: AddressLookupTableAccount[]) => buildTransaction(
    instructions,
    args.owner,
    args.blockhash,
    lookups,
  ).serialize();
  let lookupsPromise: Promise<AddressLookupTableAccount[]> | undefined;
  const loadLookups = () => {
    lookupsPromise ??= args.loadLookupTable(args.context, args.runtime).catch(() => []);
    return lookupsPromise;
  };
  let raw: Uint8Array;
  try {
    raw = build([]);
  } catch (error) {
    if (!transactionEncodingTooLarge(error)) throw error;
    const lookups = await loadLookups();
    if (!lookups.length) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL card receipt transfer is too large to encode.');
    }
    try {
      raw = build(lookups);
    } catch (lookupError) {
      if (!transactionEncodingTooLarge(lookupError)) throw lookupError;
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL card receipt transfer is too large to encode.');
    }
  }
  if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    const lookups = await loadLookups();
    if (lookups.length) raw = build(lookups);
  }
  if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    throw new AdminIrlRedeemPrepareError(
      'failed-precondition',
      `Admin IRL card receipt transfer transaction too large (${raw.length} bytes > ${SOLANA_MAX_RAW_TX_BYTES}).`,
      { rawBytes: raw.length, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES },
    );
  }
  return raw;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function prepareAdminIrlRedeem(args: {
  body: AdminIrlRedeemPrepareRequest;
  db: D1Database | undefined;
  identity: RequestIdentity;
  firestoreContext: FirestoreContext;
  providerContext: ProviderContext;
  dependencies: AdminIrlRedeemPrepareDependencies;
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
    (uid) => args.dependencies.loadWalletSession(args.firestoreContext, args.db, uid),
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
  const assets = await mapWithConcurrency(itemIds, ASSET_FETCH_CONCURRENCY, (assetId) =>
    args.dependencies.fetchAsset(args.providerContext, runtime, assetId)
  );
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
      if (!transactionEncodingTooLarge(error)) throw error;
      throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem transfer transaction is too large to encode. Try fewer packs.');
    }
    const blockhash = await args.dependencies.loadLatestBlockhash(args.providerContext, runtime);
    raw = serializePackTransaction(instructions, owner, blockhash);
  } else {
    const assetId = itemIds[0];
    if (await args.dependencies.loadReceiptMarker(args.firestoreContext, dropId, assetId)) {
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
  await args.dependencies.createRequest(args.firestoreContext, {
    requestId,
    dropId,
    owner: ownerWallet,
    targetKind,
    adminWallet: onchain.admin.toBase58(),
    itemIds,
    items: preparedItems,
    ...(args.prepareAttemptId ? { prepareAttemptId: args.prepareAttemptId } : {}),
  });
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
  accessTokenProvider: createGoogleAccessTokenProvider(),
  autoId: firestoreAutoId,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdentity: verifyRequestIdentity,
  getDrop: getApiDrop,
  loadWalletSession,
  loadReceiptMarker,
  createRequest,
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
  overrides: Partial<AdminIrlRedeemPrepareDependencies> = {},
): Promise<AdminIrlRedeemPrepareResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics: AdminIrlRedeemPrepareMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
  const trackedFetch: ProfileProviderFetch = async (input, init) => {
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    try {
      return await dependencies.providerFetch(input, init);
    } finally {
      metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
    }
  };
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const response = errorResponse(new AdminIrlRedeemPrepareError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { headers: response.headers, status: 405 }),
      metrics,
      authOutcome: 'rejected',
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Admin IRL redeem preparation timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
  let identity: RequestIdentity | undefined;
  let dropId: string | undefined;
  let targetKind: AdminIrlRedeemTargetKind | undefined;
  let itemCount: number | undefined;
  try {
    const body = await readRequestBody(request, controller.signal);
    dropId = normalizeDropId(body.dropId);
    itemCount = body.itemIds.length;
    identity = await dependencies.verifyIdentity(
      request,
      env.OPS_DB,
      controller.signal,
      dependencies.nowMs(),
    );
    if (!isStaffRequestIdentity(identity)) {
      throw new AdminIrlRedeemPrepareError('unauthenticated', 'Staff wallet authentication is required.');
    }
    const serviceAccountJson = String(env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON || '').trim();
    const apiKey = String(env.HELIUS_API_KEY || '').trim();
    if (!serviceAccountJson || !apiKey) {
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
      ...(prepareAttemptId ? { prepareAttemptId } : {}),
      firestoreContext: {
        accessTokenProvider: dependencies.accessTokenProvider,
        commerceDb: env.COMMERCE_DB,
        nowMs,
        providerFetch: trackedFetch,
        serviceAccountJson,
        signal: controller.signal,
      },
      providerContext: {
        apiKey,
        providerFetch: trackedFetch,
        signal: controller.signal,
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
    let prepareError: AdminIrlRedeemPrepareError;
    let authOutcome: AdminIrlRedeemPrepareResult['authOutcome'] = identity ? 'provider-failure' : 'rejected';
    if (controller.signal.aborted) {
      prepareError = new AdminIrlRedeemPrepareError('deadline-exceeded', 'Admin IRL redeem preparation timed out.');
    } else if (error instanceof AdminIrlRedeemPrepareError) {
      prepareError = error;
      if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
        authOutcome = 'rejected';
      }
    } else if (error instanceof RequestIdentityError) {
      prepareError = error.kind === 'invalid-token'
        ? new AdminIrlRedeemPrepareError('unauthenticated', 'Authentication is required.')
        : error.kind === 'provider-timeout'
          ? new AdminIrlRedeemPrepareError('deadline-exceeded', 'Admin IRL redeem preparation timed out.')
          : new AdminIrlRedeemPrepareError('unavailable', 'Authentication is temporarily unavailable.');
      authOutcome = error.kind === 'invalid-token' ? 'rejected' : 'provider-failure';
    } else if (error instanceof ProfileReadError) {
      prepareError = new AdminIrlRedeemPrepareError(error.code, error.message, error.details);
      if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
        authOutcome = 'rejected';
      }
    } else {
      console.error({
        event: 'admin_irl_redeem_prepare_failed',
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
      });
      prepareError = new AdminIrlRedeemPrepareError('internal', 'Admin IRL redeem preparation failed.');
    }
    return {
      response: errorResponse(prepareError),
      metrics,
      authOutcome,
      ...(dropId ? { dropId } : {}),
      ...(targetKind ? { targetKind } : {}),
      ...(itemCount === undefined ? {} : { itemCount }),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const adminIrlRedeemPrepareTestHooks = {
  assertSupportedRuntime,
  buildRuntime,
  cardReceiptTransferInstruction,
  coreTransferInstruction,
  createProviderAttemptScope,
  createRequest,
  fetchAsset,
  fetchAssetProof,
  firestoreAutoId,
  loadLatestBlockhash,
  loadLookupTable,
  loadOnchainState,
  loadPendingOpenAccounts,
  loadReceiptMarker,
  loadWalletSession,
  parseProof,
  prepareAdminIrlRedeem,
  rpcCall,
  serializeCardTransaction,
  serializePackTransaction,
};

export const adminIrlRedeemRuntime = {
  assertSupportedRuntime,
  buildRuntime,
  fetchAsset,
  fetchAssetProof,
  loadLookupTable,
  loadOnchainState,
  loadWalletSession,
  parseProof,
  receiptDropIdentity,
  rpcCall,
};
