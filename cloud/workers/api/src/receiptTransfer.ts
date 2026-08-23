import bs58 from 'bs58';
import { z } from 'zod';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getApiDrop,
  type ApiDropConfig,
} from './dropConfig.js';
import { bubblegumTransferV2Ix } from './bubblegum.js';
import {
  assetGroupingCollectionMints,
  HELIUS_COLLECTION_GROUPING_OPTIONS,
} from '../../../../shared/dasAssetCollections.js';
import {
  dasAssetKind,
  dasAssetLooksBurntOrClosed,
  type DasAsset,
} from '../../../../shared/dasAsset.js';
import {
  normalizeDropId,
  normalizeDropSalesMode,
  type SolanaCluster,
} from '../../../../shared/deploymentCore.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.js';
import {
  BOX_MINTER_CONFIG_SEED,
  isConfiguredBoxMinterItemsPerBox,
} from '../../../../shared/boxMinterProtocol.js';
import {
  BUBBLEGUM_PROGRAM_ADDRESS,
  MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS,
  MPL_CORE_PROGRAM_ADDRESS,
  MPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../shared/solanaProgramAddresses.js';
import {
  HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES,
} from '../../../../shared/heliusDas.js';
import {
  assetMatchesReceiptDropIdentity,
  assetMatchesReceiptMetadataIdentity,
  assetProofTreePublicKey,
  normalizedAssetProofAccounts,
  receiptMetadataReference,
  type ReceiptMetadataReference,
} from './receiptProof.js';
import type {
  PrepareReceiptTransferRequest,
  PrepareReceiptTransferResponse,
} from '../../../../shared/contracts.js';
import {
  RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION,
  evaluateReceiptTransferRateLimit,
  receiptTransferAssetRateLimitBucket,
  receiptTransferCallerRateLimitBucket,
  receiptTransferStoredBucketMatches,
  type ReceiptTransferRateLimitBucket,
} from './receiptTransferRateLimit.js';
import {
  FirebaseIdTokenError,
  verifyFirebaseIdToken,
  type FirebaseIdentity,
} from './firebaseIdToken.js';
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
  isRecord,
  readBoundedJson,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';

export const RECEIPT_TRANSFER_PREPARE_PATH = '/receipts/transfer/prepare';

const REQUEST_MAX_BYTES = 1024;
const PROVIDER_MAX_BYTES = HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES;
const HANDLER_TIMEOUT_MS = 55_000;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;
const FIRESTORE_TRANSACTION_ATTEMPTS = 5;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const NAME_POLICY = { metadataNameMode: 'string-only' } as const;
const BURN_POLICY = { missingAssetResult: true, nonBooleanFlagIsBurnt: false } as const;
const BUBBLEGUM_PROGRAM_ID = new PublicKey(BUBBLEGUM_PROGRAM_ADDRESS);
const MPL_NOOP_PROGRAM_ID = new PublicKey(MPL_NOOP_PROGRAM_ADDRESS);
const MPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(MPL_ACCOUNT_COMPRESSION_PROGRAM_ADDRESS);
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);

const requestSchema = z.object({
  owner: z.string().min(1).max(64),
  dropId: z.string().min(1).max(64),
  receiptAssetId: z.string().min(1).max(64),
  destination: z.string().min(1).max(64),
}).strict();

type ReceiptTransferEnv = Pick<
  Env,
  'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON' | 'HELIUS_API_KEY'
>;

type ReceiptTransferErrorCode =
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

class ReceiptTransferError extends Error {
  constructor(
    readonly code: ReceiptTransferErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ReceiptTransferError';
  }
}

type ReceiptTransferRuntime = {
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
  receiptMaxId: number;
  maxDudeId: number;
};

type FirestoreContext = {
  accessTokenProvider: GoogleAccessTokenProvider;
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
  coreCollection: PublicKey;
};

type ReceiptTransferDependencies = {
  accessTokenProvider: GoogleAccessTokenProvider;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdToken: typeof verifyFirebaseIdToken;
  getDrop: (dropId: string) => ApiDropConfig | undefined;
  enforceRateLimit: (context: FirestoreContext, bucket: ReceiptTransferRateLimitBucket) => Promise<void>;
  fetchAsset: (context: ProviderContext, runtime: ReceiptTransferRuntime, assetId: string) => Promise<DasAsset>;
  fetchAssetProof: (context: ProviderContext, runtime: ReceiptTransferRuntime, assetId: string) => Promise<Record<string, unknown>>;
  loadOnchainState: (context: ProviderContext, runtime: ReceiptTransferRuntime) => Promise<OnchainState>;
  loadLatestBlockhash: (context: ProviderContext, runtime: ReceiptTransferRuntime) => Promise<string>;
  loadLookupTable: (context: ProviderContext, runtime: ReceiptTransferRuntime) => Promise<AddressLookupTableAccount[]>;
};

type ReceiptTransferMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type ReceiptTransferResult = {
  response: Response;
  metrics: ReceiptTransferMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
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

function statusForCode(code: ReceiptTransferErrorCode): number {
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

function errorResponse(error: ReceiptTransferError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, statusForCode(error.code));
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<PrepareReceiptTransferRequest> {
  const contentType = String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await request.body?.cancel().catch(() => undefined);
    throw new ReceiptTransferError('invalid-argument', 'Content-Type must be application/json.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new ReceiptTransferError('invalid-argument', 'Receipt transfer request is too large.');
  }
  if (!request.body) throw new ReceiptTransferError('invalid-argument', 'Invalid receipt transfer request.');
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
      if (size > REQUEST_MAX_BYTES) throw new ReceiptTransferError('invalid-argument', 'Receipt transfer request is too large.');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    let value: unknown;
    try {
      value = JSON.parse(chunks.join(''));
    } catch {
      throw new ReceiptTransferError('invalid-argument', 'Invalid receipt transfer request.');
    }
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) throw new ReceiptTransferError('invalid-argument', 'Invalid receipt transfer request.');
    return parsed.data;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ReceiptTransferError) throw error;
    throw new ReceiptTransferError('invalid-argument', 'Invalid receipt transfer request.');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new ReceiptTransferError('invalid-argument', `Invalid ${label}`);
  }
}

function configuredPublicKey(label: string, value: string | undefined, required = true): PublicKey | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return undefined;
    throw new ReceiptTransferError('failed-precondition', `${label} is not configured.`);
  }
  try {
    const key = new PublicKey(normalized);
    if (required && key.equals(PublicKey.default)) {
      throw new ReceiptTransferError('failed-precondition', `${label} is not configured.`);
    }
    return key;
  } catch (error) {
    if (error instanceof ReceiptTransferError) throw error;
    throw new ReceiptTransferError('failed-precondition', `${label} is invalid.`);
  }
}

function buildRuntime(config: ApiDropConfig): ReceiptTransferRuntime {
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
    throw new ReceiptTransferError('failed-precondition', 'Receipt transfer drop configuration is invalid.', { dropId });
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
    receiptMaxId,
    maxDudeId,
  };
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
    controller.abort(new DOMException('Receipt transfer provider request timed out', 'TimeoutError'));
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
  runtime: ReceiptTransferRuntime,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = `receipt-transfer-${method}`;
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
        throw new ReceiptTransferError('unavailable', 'Receipt transfer provider is temporarily unavailable.');
      }
      const payload = await readBoundedJson(response, PROVIDER_MAX_BYTES, attemptScope.signal);
      if (!isRecord(payload) || payload.jsonrpc !== '2.0' || payload.id !== id) {
        throw new ReceiptTransferError('unavailable', 'Receipt transfer provider returned an invalid response.');
      }
      if (isRecord(payload.error)) {
        const upstreamCode = Number(payload.error.code);
        throw new ReceiptTransferError('unavailable', 'Receipt transfer provider is temporarily unavailable.', {
          method,
          ...(Number.isFinite(upstreamCode) ? { upstreamCode } : {}),
        });
      }
      if (!Object.hasOwn(payload, 'result')) {
        throw new ReceiptTransferError('unavailable', 'Receipt transfer provider returned an invalid response.');
      }
      return payload.result;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (attemptScope.timedOut()) {
        if (attempt === 0) {
          await pause(context.signal);
          continue;
        }
        throw new ReceiptTransferError('deadline-exceeded', 'Receipt transfer provider request timed out.');
      }
      if (error instanceof ReceiptTransferError) throw error;
      if (attempt === 0) {
        await pause(context.signal);
        continue;
      }
      throw new ReceiptTransferError('unavailable', 'Receipt transfer provider is temporarily unavailable.');
    } finally {
      attemptScope.dispose();
    }
  }
  throw new ReceiptTransferError('unavailable', 'Receipt transfer provider is temporarily unavailable.');
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
        throw new ReceiptTransferError(
          response.status === 404 ? 'not-found' : 'unavailable',
          response.status === 404 ? missingMessage : 'Receipt transfer provider is temporarily unavailable.',
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
        throw new ReceiptTransferError('deadline-exceeded', 'Receipt transfer provider request timed out.');
      }
      if (error instanceof ReceiptTransferError) throw error;
      if (attempt === 0) {
        await pause(context.signal);
        continue;
      }
      throw new ReceiptTransferError('unavailable', 'Receipt transfer provider returned an invalid response.');
    } finally {
      attemptScope.dispose();
    }
  }
  throw new ReceiptTransferError('unavailable', 'Receipt transfer provider is temporarily unavailable.');
}

async function fetchAsset(
  context: ProviderContext,
  runtime: ReceiptTransferRuntime,
  assetId: string,
): Promise<DasAsset> {
  let value: unknown;
  try {
    value = await rpcCall(context, runtime, 'getAsset', {
      id: assetId,
      options: HELIUS_COLLECTION_GROUPING_OPTIONS,
    });
  } catch (error) {
    const upstreamCode = error instanceof ReceiptTransferError && isRecord(error.details)
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
    throw new ReceiptTransferError('not-found', 'Asset not found. If you just transferred or minted it, wait a few seconds and try again.');
  }
  return value;
}

async function fetchAssetProof(
  context: ProviderContext,
  runtime: ReceiptTransferRuntime,
  assetId: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await rpcCall(context, runtime, 'getAssetProof', { id: assetId });
  } catch (error) {
    const upstreamCode = error instanceof ReceiptTransferError && isRecord(error.details)
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
  if (!isRecord(value)) throw new ReceiptTransferError('not-found', 'Asset proof not found', { assetId });
  return value;
}

function parseRpcAccount(value: unknown, label: string): { owner: PublicKey; data: Uint8Array } {
  if (!isRecord(value) || typeof value.owner !== 'string' || !Array.isArray(value.data)) {
    throw new ReceiptTransferError('failed-precondition', `${label} is invalid.`);
  }
  const encoded = value.data[0];
  if (typeof encoded !== 'string' || value.data[1] !== 'base64' || encoded.length > PROVIDER_MAX_BYTES) {
    throw new ReceiptTransferError('unavailable', 'Receipt transfer provider returned invalid account data.');
  }
  try {
    return { owner: new PublicKey(value.owner), data: Buffer.from(encoded, 'base64') };
  } catch {
    throw new ReceiptTransferError('unavailable', 'Receipt transfer provider returned invalid account data.');
  }
}

async function loadOnchainState(
  context: ProviderContext,
  runtime: ReceiptTransferRuntime,
): Promise<OnchainState> {
  const result = await rpcCall(context, runtime, 'getMultipleAccounts', [
    [runtime.collectionMint.toBase58(), runtime.boxMinterConfigPda.toBase58()],
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== 2) {
    throw new ReceiptTransferError('unavailable', 'Receipt transfer provider returned an invalid account response.');
  }
  if (!result.value[0]) {
    throw new ReceiptTransferError('failed-precondition', 'Configured receipt collection was not found on-chain.', {
      collection: runtime.collectionMint.toBase58(),
      dropId: runtime.dropId,
    });
  }
  if (!result.value[1]) {
    throw new ReceiptTransferError('failed-precondition', 'Box minter config PDA not found.', {
      configPda: runtime.boxMinterConfigPda.toBase58(),
      dropId: runtime.dropId,
    });
  }
  const collection = parseRpcAccount(result.value[0], 'COLLECTION_MINT');
  const config = parseRpcAccount(result.value[1], 'BOX_MINTER_CONFIG_PDA');
  if (!collection.owner.equals(MPL_CORE_PROGRAM_ID)) {
    throw new ReceiptTransferError('failed-precondition', 'Configured receipt collection is not an MPL Core collection.', {
      collection: runtime.collectionMint.toBase58(),
      expectedOwner: MPL_CORE_PROGRAM_ID.toBase58(),
      actualOwner: collection.owner.toBase58(),
      dropId: runtime.dropId,
    });
  }
  if (!config.owner.equals(runtime.boxMinterProgramId)) {
    throw new ReceiptTransferError('failed-precondition', 'Box minter config PDA has an unexpected owner.', {
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
      throw new ReceiptTransferError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
  const coreCollection = new PublicKey(decoded.coreCollection);
  if (!coreCollection.equals(runtime.collectionMint)) {
    throw new ReceiptTransferError('failed-precondition', 'COLLECTION_MINT does not match on-chain config', {
      configured: runtime.collectionMint.toBase58(),
      onchain: coreCollection.toBase58(),
      dropId: runtime.dropId,
    });
  }
  return { coreCollection };
}

async function loadLatestBlockhash(context: ProviderContext, runtime: ReceiptTransferRuntime): Promise<string> {
  const result = await rpcCall(context, runtime, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const value = isRecord(result) ? result.value : undefined;
  const blockhash = isRecord(value) && typeof value.blockhash === 'string' ? value.blockhash : '';
  try {
    if (!blockhash || new PublicKey(blockhash).toBytes().length !== 32) throw new Error('invalid');
  } catch {
    throw new ReceiptTransferError('unavailable', 'Receipt transfer provider returned an invalid blockhash.');
  }
  return blockhash;
}

async function loadLookupTable(
  context: ProviderContext,
  runtime: ReceiptTransferRuntime,
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
    throw new ReceiptTransferError('failed-precondition', 'DELIVERY_LOOKUP_TABLE has an unexpected owner.');
  }
  try {
    return [new AddressLookupTableAccount({
      key: runtime.deliveryLookupTable,
      state: AddressLookupTableAccount.deserialize(account.data),
    })];
  } catch {
    throw new ReceiptTransferError('failed-precondition', 'DELIVERY_LOOKUP_TABLE is invalid.');
  }
}

function firestoreInteger(value: number): Record<string, string> {
  return { integerValue: String(value) };
}

async function beginFirestoreTransaction(context: FirestoreContext): Promise<string> {
  const value = await authenticatedFirestoreRequest({
    ...context,
    body: JSON.stringify({ options: { readWrite: {} } }),
    method: 'POST',
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:beginTransaction`,
  });
  if (!isRecord(value) || typeof value.transaction !== 'string' || !value.transaction) {
    throw new ProfileReadError('unavailable', 502, 'Receipt transfers are temporarily unavailable.');
  }
  return value.transaction;
}

async function rollbackFirestoreTransaction(context: FirestoreContext, transaction: string): Promise<void> {
  await authenticatedFirestoreRequest({
    ...context,
    body: JSON.stringify({ transaction }),
    method: 'POST',
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:rollback`,
  });
}

async function commitFirestoreTransaction(
  context: FirestoreContext,
  transaction: string,
  bucket: ReceiptTransferRateLimitBucket,
  count: number,
  windowStartedAtMs: number,
): Promise<void> {
  const fields: Record<string, Record<string, string>> = {
    schemaVersion: firestoreInteger(RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION),
    scope: { stringValue: bucket.scope },
    subjectHash: { stringValue: bucket.subjectHash },
    ...Object.fromEntries(Object.entries(bucket.publicFields ?? {}).map(([key, value]) => [key, { stringValue: value }])),
    windowStartedAtMs: firestoreInteger(windowStartedAtMs),
    count: firestoreInteger(count),
    updatedAtMs: firestoreInteger(context.nowMs),
  };
  await authenticatedFirestoreRequest({
    ...context,
    body: JSON.stringify({
      transaction,
      writes: [{
        update: {
          name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${bucket.documentPath}`,
          fields,
        },
      }],
    }),
    method: 'POST',
    surfaceWriteConflict: true,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
  });
}

async function enforceRateLimit(
  context: FirestoreContext,
  bucket: ReceiptTransferRateLimitBucket,
): Promise<void> {
  for (let attempt = 0; attempt < FIRESTORE_TRANSACTION_ATTEMPTS; attempt += 1) {
    let transaction: string | undefined;
    try {
      transaction = await beginFirestoreTransaction(context);
      const url = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/${bucket.documentPath}`);
      url.searchParams.set('transaction', transaction);
      const document = await authenticatedFirestoreRequest({ ...context, method: 'GET', url: url.toString() });
      const rawExisting = isRecord(document) ? decodeFirestoreFields(document.fields) : null;
      if (document && !rawExisting) {
        throw new ProfileReadError('unavailable', 502, 'Receipt transfers are temporarily unavailable.');
      }
      const existing = receiptTransferStoredBucketMatches(rawExisting ?? undefined, bucket)
        ? rawExisting
        : undefined;
      const decision = evaluateReceiptTransferRateLimit(existing, context.nowMs, bucket.limit);
      if (!decision.allowed) {
        await rollbackFirestoreTransaction(context, transaction).catch(() => undefined);
        throw new ReceiptTransferError(
          'resource-exhausted',
          'Too many receipt transfer attempts. Please wait before trying again.',
          { retryAfterMs: decision.retryAfterMs },
        );
      }
      await commitFirestoreTransaction(
        context,
        transaction,
        bucket,
        decision.count,
        decision.windowStartedAtMs,
      );
      return;
    } catch (error) {
      if (error instanceof ReceiptTransferError) throw error;
      if (transaction) await rollbackFirestoreTransaction(context, transaction).catch(() => undefined);
      if (error instanceof FirestoreWriteConflict && attempt + 1 < FIRESTORE_TRANSACTION_ATTEMPTS) {
        await pause(context.signal, Math.min(400, 25 * 2 ** attempt));
        continue;
      }
      throw new ReceiptTransferError('unavailable', 'Receipt transfers are temporarily unavailable.');
    }
  }
  throw new ReceiptTransferError('unavailable', 'Receipt transfers are temporarily unavailable.');
}

function receiptDropIdentity(runtime: ReceiptTransferRuntime) {
  return {
    collectionMintStr: runtime.collectionMint.toBase58(),
    metadataBase: runtime.config.metadataBase,
    metadataBaseAliases: runtime.config.metadataBaseAliases,
    receiptsMerkleTree: runtime.receiptsMerkleTree,
    receiptPoolId: runtime.config.receiptPoolId,
    receiptMaxId: runtime.receiptMaxId,
  };
}

function receiptIdentityExpectation(
  asset: DasAsset,
  runtime: ReceiptTransferRuntime,
): Partial<ReceiptMetadataReference> | undefined {
  const reference = receiptMetadataReference(asset);
  if (!reference) return undefined;
  if (
    (reference.kind === 'box' && reference.id > runtime.receiptMaxId) ||
    (reference.kind === 'figure' && reference.id > runtime.maxDudeId)
  ) {
    return undefined;
  }
  if (normalizeDropSalesMode(runtime.config.salesMode) === 'stripe_receipt_only') {
    return reference.kind === 'box' ? reference : undefined;
  }
  return reference;
}

function bytes32(value: string, label: string): Buffer {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new ReceiptTransferError('failed-precondition', `Invalid ${label}`);
  }
  if (decoded.length !== 32) throw new ReceiptTransferError('failed-precondition', `Invalid ${label} length`);
  return Buffer.from(decoded);
}

function parseProof(
  asset: DasAsset,
  proof: Record<string, unknown>,
  runtime: ReceiptTransferRuntime,
  owner: string,
): ProofContext {
  const compression = isRecord(asset.compression) ? asset.compression : {};
  const merkleTree = assetProofTreePublicKey(proof);
  const root = typeof proof.root === 'string' ? proof.root : '';
  if (!merkleTree || !root) {
    throw new ReceiptTransferError('failed-precondition', 'Unable to fetch receipt proof for transfer');
  }
  if (!merkleTree.equals(runtime.receiptsMerkleTree)) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt does not belong to the configured receipts tree', {
      receiptTree: merkleTree.toBase58(),
      receiptsTree: runtime.receiptsMerkleTree.toBase58(),
      dropId: runtime.dropId,
    });
  }
  const nonce = Number(compression.leaf_id ?? compression.leafId);
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new ReceiptTransferError('failed-precondition', 'Unable to parse receipt leaf id');
  }
  const index = Math.floor(nonce);
  if (index > 0xffff_ffff) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt leaf index out of range');
  }
  let proofAccounts: PublicKey[];
  try {
    proofAccounts = normalizedAssetProofAccounts(proof, {
      maxDepth: runtime.receiptsTreeMaxDepth,
      canopyDepth: runtime.receiptsTreeCanopyDepth,
    });
  } catch (error) {
    throw new ReceiptTransferError(
      'failed-precondition',
      error instanceof Error ? error.message : 'Unable to parse receipt proof path',
      { dropId: runtime.dropId },
    );
  }
  const indexedOwner = isRecord(asset.ownership) && typeof asset.ownership.owner === 'string'
    ? asset.ownership.owner
    : '';
  if (indexedOwner !== owner) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt proof owner does not match the expected wallet');
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
    throw new ReceiptTransferError('failed-precondition', 'Receipt proof owner is invalid');
  }
  const flags = compression.flags == null ? null : Number(compression.flags);
  if (flags != null && (!Number.isInteger(flags) || flags < 0 || flags > 0xff)) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt proof flags are invalid');
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

function buildTransferInstruction(
  proof: ProofContext,
  owner: PublicKey,
  destination: PublicKey,
  coreCollection: PublicKey,
) {
  return bubblegumTransferV2Ix({
    bubblegumProgramId: BUBBLEGUM_PROGRAM_ID,
    mplNoopProgramId: MPL_NOOP_PROGRAM_ID,
    mplAccountCompressionProgramId: MPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    treeConfig: deriveTreeConfig(proof.merkleTree),
    payer: owner,
    authority: owner,
    leafOwner: proof.leafOwner,
    leafDelegate: proof.leafDelegate,
    newLeafOwner: destination,
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
  runtime: ReceiptTransferRuntime;
  owner: PublicKey;
  blockhash: string;
  instruction: ReturnType<typeof buildTransferInstruction>;
  loadLookupTable: ReceiptTransferDependencies['loadLookupTable'];
}): Promise<Uint8Array> {
  const build = (lookups: AddressLookupTableAccount[]) => {
    const message = new TransactionMessage({
      payerKey: args.owner,
      recentBlockhash: args.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), args.instruction],
    }).compileToV0Message(lookups);
    return new VersionedTransaction(message).serialize();
  };
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
      throw new ReceiptTransferError('failed-precondition', 'Receipt transfer transaction is too large to encode.', {
        dropId: args.runtime.dropId,
      });
    }
    try {
      raw = build(lookups);
    } catch (lookupError) {
      if (!transactionEncodingTooLarge(lookupError)) throw lookupError;
      throw new ReceiptTransferError('failed-precondition', 'Receipt transfer transaction is too large to encode.', {
        dropId: args.runtime.dropId,
      });
    }
  }
  if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    const lookups = await loadLookups();
    if (lookups.length) {
      try {
        raw = build(lookups);
      } catch (error) {
        if (!transactionEncodingTooLarge(error)) throw error;
        throw new ReceiptTransferError('failed-precondition', 'Receipt transfer transaction is too large to encode.', {
          dropId: args.runtime.dropId,
        });
      }
    }
  }
  if (raw.length > SOLANA_MAX_RAW_TX_BYTES) {
    throw new ReceiptTransferError(
      'failed-precondition',
      `Receipt transfer transaction too large (${raw.length} bytes > ${SOLANA_MAX_RAW_TX_BYTES}).`,
      { rawBytes: raw.length, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES, dropId: args.runtime.dropId },
    );
  }
  return raw;
}

async function prepareReceiptTransfer(args: {
  body: PrepareReceiptTransferRequest;
  identity: FirebaseIdentity;
  firestoreContext: FirestoreContext;
  providerContext: ProviderContext;
  dependencies: ReceiptTransferDependencies;
}): Promise<PrepareReceiptTransferResponse> {
  const dropId = normalizeDropId(args.body.dropId);
  const config = args.dependencies.getDrop(dropId);
  if (!config) throw new ReceiptTransferError('invalid-argument', `Unsupported dropId: ${dropId}`);
  const runtime = buildRuntime(config);
  const owner = canonicalPublicKey(args.body.owner, 'wallet address');
  const receiptAsset = canonicalPublicKey(args.body.receiptAssetId, 'receipt asset id');
  const destination = canonicalPublicKey(args.body.destination, 'destination address');
  if (receiptAsset.equals(PublicKey.default)) {
    throw new ReceiptTransferError('invalid-argument', 'Invalid receipt asset id');
  }
  if (destination.equals(PublicKey.default)) {
    throw new ReceiptTransferError('invalid-argument', 'The system address cannot receive a receipt');
  }
  if (destination.equals(owner)) {
    throw new ReceiptTransferError('invalid-argument', 'Destination address must be different from the current owner');
  }

  await args.dependencies.enforceRateLimit(
    args.firestoreContext,
    receiptTransferCallerRateLimitBucket(args.identity.uid),
  );

  const receiptAssetId = receiptAsset.toBase58();
  const ownerWallet = owner.toBase58();
  const asset = await args.dependencies.fetchAsset(args.providerContext, runtime, receiptAssetId);
  if (dasAssetLooksBurntOrClosed(asset, BURN_POLICY)) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt is no longer transferable');
  }
  if (dasAssetKind(asset, NAME_POLICY) !== 'certificate') {
    throw new ReceiptTransferError('failed-precondition', 'Provided asset is not a receipt');
  }
  if (String(asset.id || '') !== receiptAssetId) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt asset id does not match the indexed asset');
  }
  const indexedOwner = isRecord(asset.ownership) ? asset.ownership.owner : undefined;
  if (indexedOwner !== ownerWallet) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt is not owned by the requesting wallet');
  }

  const expectedReceipt = receiptIdentityExpectation(asset, runtime);
  const dropIdentity = receiptDropIdentity(runtime);
  if (!expectedReceipt || !assetMatchesReceiptMetadataIdentity(asset, dropIdentity, expectedReceipt)) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt does not belong to the requested drop', {
      dropId,
      expectedCollectionMint: runtime.collectionMint.toBase58(),
      expectedMetadataBase: runtime.config.metadataBase,
      assetGroupingCollectionMints: assetGroupingCollectionMints(asset),
    });
  }

  const proof = await args.dependencies.fetchAssetProof(args.providerContext, runtime, receiptAssetId);
  if (!assetMatchesReceiptDropIdentity(asset, proof, dropIdentity, expectedReceipt)) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt does not belong to the configured receipts tree', {
      dropId,
      receiptAssetId,
      expectedReceiptsTree: runtime.receiptsMerkleTree.toBase58(),
      actualReceiptsTree: assetProofTreePublicKey(proof)?.toBase58() || null,
    });
  }
  const proofContext = parseProof(asset, proof, runtime, ownerWallet);
  if (!proofContext.leafOwner.equals(owner)) {
    throw new ReceiptTransferError('failed-precondition', 'Receipt proof owner does not match the requesting wallet');
  }

  await args.dependencies.enforceRateLimit(
    args.firestoreContext,
    receiptTransferAssetRateLimitBucket({
      uid: args.identity.uid,
      cluster: runtime.cluster,
      ownerWallet,
      receiptAssetId,
    }),
  );

  const onchain = await args.dependencies.loadOnchainState(args.providerContext, runtime);
  const instruction = buildTransferInstruction(proofContext, owner, destination, onchain.coreCollection);
  const blockhash = await args.dependencies.loadLatestBlockhash(args.providerContext, runtime);
  const raw = await buildPreparedTransaction({
    context: args.providerContext,
    runtime,
    owner,
    blockhash,
    instruction,
    loadLookupTable: args.dependencies.loadLookupTable,
  });
  return {
    encodedTx: Buffer.from(raw).toString('base64'),
    dropId,
    certificateId: receiptAssetId,
  };
}

const defaultDependencies: ReceiptTransferDependencies = {
  accessTokenProvider: createGoogleAccessTokenProvider(),
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdToken: verifyFirebaseIdToken,
  getDrop: getApiDrop,
  enforceRateLimit,
  fetchAsset,
  fetchAssetProof,
  loadOnchainState,
  loadLatestBlockhash,
  loadLookupTable,
};

export async function handleReceiptTransferPrepare(
  request: Request,
  env: ReceiptTransferEnv,
  overrides: Partial<ReceiptTransferDependencies> = {},
): Promise<ReceiptTransferResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics: ReceiptTransferMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
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
    const response = errorResponse(new ReceiptTransferError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { headers: response.headers, status: 405 }),
      metrics,
      authOutcome: 'rejected',
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Receipt transfer request timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
  let identity: FirebaseIdentity | undefined;
  let dropId: string | undefined;
  try {
    const body = await readRequestBody(request, controller.signal);
    dropId = normalizeDropId(body.dropId);
    identity = await dependencies.verifyIdToken(
      request.headers.get('Authorization'),
      trackedFetch,
      controller.signal,
      dependencies.nowMs(),
    );
    const serviceAccountJson = String(env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON || '').trim();
    const apiKey = String(env.HELIUS_API_KEY || '').trim();
    if (!serviceAccountJson || !apiKey) {
      throw new ReceiptTransferError('unavailable', 'Receipt transfers are temporarily unavailable.');
    }
    const nowMs = dependencies.nowMs();
    const response = await prepareReceiptTransfer({
      body,
      identity,
      dependencies,
      firestoreContext: {
        accessTokenProvider: dependencies.accessTokenProvider,
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
    return { response: jsonResponse(response, 200), metrics, authOutcome: 'accepted', dropId: response.dropId };
  } catch (error) {
    let transferError: ReceiptTransferError;
    let authOutcome: ReceiptTransferResult['authOutcome'] = identity ? 'provider-failure' : 'rejected';
    if (controller.signal.aborted) {
      transferError = new ReceiptTransferError('deadline-exceeded', 'Receipt transfer request timed out.');
    } else if (error instanceof ReceiptTransferError) {
      transferError = error;
      if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
        authOutcome = 'rejected';
      }
    } else if (error instanceof FirebaseIdTokenError) {
      transferError = error.kind === 'invalid-token'
        ? new ReceiptTransferError('unauthenticated', 'Authentication is required.')
        : error.kind === 'provider-timeout'
          ? new ReceiptTransferError('deadline-exceeded', 'Receipt transfer request timed out.')
          : new ReceiptTransferError('unavailable', 'Authentication is temporarily unavailable.');
      authOutcome = error.kind === 'invalid-token' ? 'rejected' : 'provider-failure';
    } else if (error instanceof ProfileReadError) {
      transferError = new ReceiptTransferError(error.code, error.message, error.details);
      if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
        authOutcome = 'rejected';
      }
    } else {
      console.error({
        event: 'receipt_transfer_prepare_failed',
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
      });
      transferError = new ReceiptTransferError('internal', 'Receipt transfer preparation failed.');
    }
    return { response: errorResponse(transferError), metrics, authOutcome, ...(dropId ? { dropId } : {}) };
  } finally {
    clearTimeout(timeout);
  }
}

export const receiptTransferTestHooks = {
  buildPreparedTransaction,
  buildRuntime,
  buildTransferInstruction,
  createProviderAttemptScope,
  enforceRateLimit,
  fetchAsset,
  fetchAssetProof,
  loadLatestBlockhash,
  loadLookupTable,
  loadOnchainState,
  parseProof,
  prepareReceiptTransfer,
  rpcCall,
};
