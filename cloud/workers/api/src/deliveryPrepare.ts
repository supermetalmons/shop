import bs58 from 'bs58';
import { z } from 'zod';
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
  FUNCTIONS_DROPS,
  getFunctionsDrop,
  type FunctionsDropConfig,
} from '../../../../functions/src/config/deployment.js';
import { dropDeliveryOrderPath } from '../../../../functions/src/dropPaths.js';
import {
  BoxMinterConfigCodecError,
  decodeBoxMinterConfigData,
  type DecodedBoxMinterConfigData,
} from '../../../../functions/src/shared/boxMinterConfigCodec.js';
import {
  BOX_MINTER_CONFIG_SEED,
  isBoxMinterDiscountMintsPerWallet,
  isConfiguredBoxMinterItemsPerBox,
} from '../../../../functions/src/shared/boxMinterProtocol.js';
import type {
  PrepareDeliveryRequest,
  PrepareDeliveryResponse,
} from '../../../../functions/src/shared/contracts.js';
import { DELIVERY_PREPARE_ATTEMPT_HEADER } from '../../../../functions/src/shared/contracts.js';
import { normalizeCountryCode } from '../../../../functions/src/shared/countryNormalization.js';
import {
  boxMinterMetadataBaseMatchesDrop,
  normalizeDropId,
  type SolanaCluster,
} from '../../../../functions/src/shared/deploymentCore.js';
import {
  dasAssetBoxId,
  dasAssetDudeId,
  dasAssetKind,
  type DasAsset,
} from '../../../../functions/src/shared/dasAsset.js';
import {
  HELIUS_COLLECTION_GROUPING_OPTIONS,
  uniqueAssetGroupingCollectionMint,
} from '../../../../functions/src/shared/dasAssetCollections.js';
import { DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS } from '../../../../functions/src/shared/deliveryRecovery.js';
import { HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES } from '../../../../functions/src/shared/heliusDas.js';
import {
  MPL_CORE_PROGRAM_ADDRESS,
  SPL_NOOP_PROGRAM_ADDRESS,
} from '../../../../functions/src/shared/solanaProgramAddresses.js';
import { isTransientShopRpcError } from '../../../../functions/src/shared/solanaRpcProxy.js';
import {
  canDeliverItemKind,
  calculateDeliveryLamports,
  normalizeDeliveryUnitsPerBox,
} from '../../../../functions/src/shared/shipping.js';
import {
  resolveWalletSessionBinding,
  WALLET_SESSION_COLLECTION,
} from '../../../../functions/src/shared/walletLifecycle.js';
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
  firestoreString,
  isRecord,
  readBoundedJson,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
} from './firestoreRest.js';

export const DELIVERY_PREPARE_PATH = '/delivery/prepare';

const REQUEST_MAX_BYTES = 4096;
const PROVIDER_MAX_BYTES = HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES;
const HANDLER_TIMEOUT_MS = 55_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const RECONCILE_TIMEOUT_MS = 5_000;
const PROVIDER_ATTEMPT_TIMEOUT_MS = 8_000;
const PROVIDER_CONCURRENCY = 3;
const ASSET_FETCH_MAX_ATTEMPTS = 6;
const ASSET_FETCH_MAX_WAIT_MS = 12_000;
const ASSET_FETCH_RETRY_BASE_DELAY_MS = 300;
const MAX_DELIVERY_ITEMS = 32;
const MAX_DELIVERY_ID_ATTEMPTS = 16;
const SOLANA_MAX_RAW_TX_BYTES = 1232;
const DUMMY_BLOCKHASH = '11111111111111111111111111111111';
const SERVER_INVALID_DELIVERY_UNITS_POLICY = 'arithmetic' as const;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const NAME_POLICY = { metadataNameMode: 'string-only' } as const;
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IX_DELIVER = Buffer.from('fa83de39d3e5d193', 'hex');
const MPL_CORE_COLLECTION_V1_DISCRIMINATOR = 5;
const MPL_CORE_COLLECTION_V1_MIN_BYTES = 49;
const MPL_CORE_PROGRAM_ID = new PublicKey(MPL_CORE_PROGRAM_ADDRESS);
const SPL_NOOP_PROGRAM_ID = new PublicKey(SPL_NOOP_PROGRAM_ADDRESS);

const requestSchema = z.object({
  owner: z.string().min(32).max(64),
  dropId: z.string().min(1).max(64),
  itemIds: z.array(z.string().min(32).max(64)).min(1).max(MAX_DELIVERY_ITEMS),
  addressId: z.string().regex(/^[A-Za-z0-9]{20}$/),
}).strict();

type DeliveryPrepareEnv = Pick<
  Env,
  'COSIGNER_SECRET' | 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON' | 'HELIUS_API_KEY'
>;

type DeliveryPrepareErrorCode =
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

class DeliveryPrepareError extends Error {
  constructor(
    readonly code: DeliveryPrepareErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DeliveryPrepareError';
  }
}

type DeliveryRuntime = {
  config: FunctionsDropConfig;
  dropId: string;
  cluster: SolanaCluster;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  deliveryLookupTable?: PublicKey;
  itemsPerBox: number;
  maxSupply: number;
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

type AddressDocument = {
  decoded: Record<string, unknown>;
  rawFields: Record<string, unknown>;
};

type OnchainState = {
  admin: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
};

type DeliveryOrderItem = {
  assetId: string;
  kind: 'box' | 'dude';
  refId: number;
};

type DeliveryPrepareDependencies = {
  accessTokenProvider: GoogleAccessTokenProvider;
  attemptId: () => string;
  candidateId: () => number;
  createDeliveryOrder: (
    context: FirestoreContext,
    input: DeliveryOrderCreateInput,
  ) => Promise<string>;
  deleteDeliveryOrder: (
    context: FirestoreContext,
    path: string,
    updateTime: string,
  ) => Promise<void>;
  deliveryPdaExists: (
    context: ProviderContext,
    runtime: DeliveryRuntime,
    deliveryPda: PublicKey,
  ) => Promise<boolean>;
  fetchAsset: (
    context: ProviderContext,
    runtime: DeliveryRuntime,
    assetId: string,
  ) => Promise<DasAsset>;
  getDrop: (dropId: string) => FunctionsDropConfig | undefined;
  loadAddress: (
    context: FirestoreContext,
    wallet: string,
    addressId: string,
  ) => Promise<AddressDocument>;
  loadLatestBlockhash: (context: ProviderContext, runtime: DeliveryRuntime) => Promise<string>;
  loadLookupTable: (
    context: ProviderContext,
    runtime: DeliveryRuntime,
  ) => Promise<AddressLookupTableAccount[]>;
  loadOnchainState: (
    context: ProviderContext,
    runtime: DeliveryRuntime,
  ) => Promise<OnchainState>;
  loadWalletSession: (context: FirestoreContext, uid: string) => Promise<string>;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyIdToken: typeof verifyFirebaseIdToken;
};

type DeliveryPrepareMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type DeliveryPrepareResult = {
  response: Response;
  metrics: DeliveryPrepareMetrics;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  dropId?: string;
};

type DeliveryOrderCreateInput = {
  path: string;
  dropId: string;
  owner: string;
  addressId: string;
  address: AddressDocument;
  addressCountry: string;
  items: DeliveryOrderItem[];
  deliveryId: number;
  deliveryPda: string;
  lookupTable?: string;
  deliveryLamports: number;
  nextPreparedProbeAtMs: number;
  prepareAttemptId: string;
};

function statusForCode(code: DeliveryPrepareErrorCode): number {
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

function errorResponse(error: DeliveryPrepareError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  }, statusForCode(error.code));
}

async function readRequestBody(request: Request, signal: AbortSignal): Promise<PrepareDeliveryRequest> {
  const contentType = String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await request.body?.cancel().catch(() => undefined);
    throw new DeliveryPrepareError('invalid-argument', 'Content-Type must be application/json.');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new DeliveryPrepareError('invalid-argument', 'Delivery preparation request is too large.');
  }
  if (!request.body) throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery preparation request.');
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
        throw new DeliveryPrepareError('invalid-argument', 'Delivery preparation request is too large.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    let value: unknown;
    try {
      value = JSON.parse(chunks.join(''));
    } catch {
      throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery preparation request.');
    }
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery preparation request.');
    return parsed.data;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (signal.aborted) throw signal.reason;
    if (error instanceof DeliveryPrepareError) throw error;
    throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery preparation request.');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function canonicalPublicKey(value: string, label: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error('non-canonical');
    return key;
  } catch {
    throw new DeliveryPrepareError('invalid-argument', `Invalid ${label}`);
  }
}

function configuredPublicKey(label: string, value: string | undefined, required = true): PublicKey | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return undefined;
    throw new DeliveryPrepareError('failed-precondition', `${label} is not configured.`);
  }
  try {
    const key = new PublicKey(normalized);
    if (required && key.equals(PublicKey.default)) {
      throw new DeliveryPrepareError('failed-precondition', `${label} is not configured.`);
    }
    return key;
  } catch (error) {
    if (error instanceof DeliveryPrepareError) throw error;
    throw new DeliveryPrepareError('failed-precondition', `${label} is invalid.`);
  }
}

function buildRuntime(config: FunctionsDropConfig): DeliveryRuntime {
  const dropId = normalizeDropId(config.dropId);
  const itemsPerBox = Number(config.itemsPerBox);
  const maxSupply = Number(config.maxSupply);
  const maxDudeId = maxSupply * itemsPerBox;
  if (
    !isConfiguredBoxMinterItemsPerBox(itemsPerBox) ||
    !Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > 0xffff_ffff ||
    !Number.isSafeInteger(maxDudeId) || maxDudeId > 0xffff
  ) {
    throw new DeliveryPrepareError('failed-precondition', 'Delivery drop configuration is invalid.', { dropId });
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
    deliveryLookupTable: configuredPublicKey('DELIVERY_LOOKUP_TABLE', config.deliveryLookupTable, false),
    itemsPerBox,
    maxSupply,
    maxDudeId,
  };
}

function clusterSharesCollection(runtime: DeliveryRuntime): boolean {
  return Object.values(FUNCTIONS_DROPS).some((candidate) =>
    candidate.dropId !== runtime.dropId &&
    candidate.solanaCluster === runtime.cluster &&
    candidate.collectionMint === runtime.collectionMint.toBase58());
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
    controller.abort(new DOMException('Delivery provider request timed out', 'TimeoutError'));
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
  runtime: DeliveryRuntime,
  method: string,
  params: unknown,
): Promise<unknown> {
  const id = `delivery-prepare-${method}`;
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
        throw new DeliveryPrepareError('unavailable', 'Delivery provider is temporarily unavailable.');
      }
      const payload = await readBoundedJson(response, PROVIDER_MAX_BYTES, attemptScope.signal);
      if (!isRecord(payload) || payload.jsonrpc !== '2.0' || payload.id !== id) {
        throw new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid response.');
      }
      if (isRecord(payload.error)) {
        const upstreamCode = Number(payload.error.code);
        if (attempt === 0 && isTransientShopRpcError(payload.error)) {
          await pause(context.signal);
          continue;
        }
        throw new DeliveryPrepareError('unavailable', 'Delivery provider is temporarily unavailable.', {
          method,
          ...(Number.isFinite(upstreamCode) ? { upstreamCode } : {}),
        });
      }
      if (!Object.hasOwn(payload, 'result')) {
        throw new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid response.');
      }
      return payload.result;
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (attemptScope.timedOut()) {
        if (attempt === 0) {
          await pause(context.signal);
          continue;
        }
        throw new DeliveryPrepareError('deadline-exceeded', 'Delivery provider request timed out.');
      }
      if (error instanceof DeliveryPrepareError) throw error;
      if (attempt === 0) {
        await pause(context.signal);
        continue;
      }
      throw new DeliveryPrepareError('unavailable', 'Delivery provider is temporarily unavailable.');
    } finally {
      attemptScope.dispose();
    }
  }
  throw new DeliveryPrepareError('unavailable', 'Delivery provider is temporarily unavailable.');
}

async function restJson(context: ProviderContext, url: string): Promise<unknown> {
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
        throw new DeliveryPrepareError('unavailable', 'Delivery provider is temporarily unavailable.');
      }
      return await readBoundedJson(response, PROVIDER_MAX_BYTES, attemptScope.signal);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      if (attemptScope.timedOut()) {
        if (attempt === 0) {
          await pause(context.signal);
          continue;
        }
        throw new DeliveryPrepareError('deadline-exceeded', 'Delivery provider request timed out.');
      }
      if (error instanceof DeliveryPrepareError) throw error;
      if (attempt === 0) {
        await pause(context.signal);
        continue;
      }
      throw new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid response.');
    } finally {
      attemptScope.dispose();
    }
  }
  throw new DeliveryPrepareError('unavailable', 'Delivery provider is temporarily unavailable.');
}

async function fetchAsset(
  context: ProviderContext,
  runtime: DeliveryRuntime,
  assetId: string,
): Promise<DasAsset> {
  const startedAt = Date.now();
  let lastError: DeliveryPrepareError | undefined;
  for (
    let attempt = 0;
    attempt < ASSET_FETCH_MAX_ATTEMPTS && Date.now() - startedAt < ASSET_FETCH_MAX_WAIT_MS;
    attempt += 1
  ) {
    try {
      let value: unknown;
      try {
        value = await rpcCall(context, runtime, 'getAsset', {
          id: assetId,
          options: HELIUS_COLLECTION_GROUPING_OPTIONS,
        });
      } catch (error) {
        const upstreamCode = error instanceof DeliveryPrepareError && isRecord(error.details)
          ? Number(error.details.upstreamCode)
          : Number.NaN;
        if (upstreamCode !== -32601 && upstreamCode !== -32602) throw error;
        const cluster = runtime.cluster === 'mainnet-beta' ? '' : `&cluster=${encodeURIComponent(runtime.cluster)}`;
        const payload = await restJson(
          context,
          `https://api.helius.xyz/v0/assets?ids[]=${encodeURIComponent(assetId)}&api-key=${encodeURIComponent(context.apiKey)}${cluster}`,
        );
        value = Array.isArray(payload) ? payload[0] : undefined;
      }
      if (isRecord(value)) return value;
      lastError = new DeliveryPrepareError('not-found', 'Asset not found.');
    } catch (error) {
      if (
        !(error instanceof DeliveryPrepareError) ||
        !['not-found', 'unavailable', 'deadline-exceeded', 'resource-exhausted'].includes(error.code)
      ) throw error;
      lastError = error;
    }
    if (attempt < ASSET_FETCH_MAX_ATTEMPTS - 1) {
      const remainingMs = ASSET_FETCH_MAX_WAIT_MS - (Date.now() - startedAt);
      if (remainingMs > 0) {
        await pause(context.signal, Math.min(ASSET_FETCH_RETRY_BASE_DELAY_MS * 2 ** attempt, remainingMs));
      }
    }
  }
  throw lastError || new DeliveryPrepareError('not-found', 'Asset not found.');
}

function parseRpcAccount(value: unknown, label: string): { owner: PublicKey; data: Uint8Array } {
  if (!isRecord(value) || typeof value.owner !== 'string' || !Array.isArray(value.data)) {
    throw new DeliveryPrepareError('failed-precondition', `${label} is invalid.`);
  }
  const encoded = value.data[0];
  if (typeof encoded !== 'string' || value.data[1] !== 'base64' || encoded.length > PROVIDER_MAX_BYTES) {
    throw new DeliveryPrepareError('unavailable', 'Delivery provider returned invalid account data.');
  }
  try {
    return { owner: new PublicKey(value.owner), data: Buffer.from(encoded, 'base64') };
  } catch {
    throw new DeliveryPrepareError('unavailable', 'Delivery provider returned invalid account data.');
  }
}

function paymentRoutingMatches(config: FunctionsDropConfig, decoded: DecodedBoxMinterConfigData): boolean {
  const paymentRouting = decoded.paymentRouting;
  if (!paymentRouting) return false;
  if (!config.paymentRouting) return paymentRouting.schema === 'legacy';
  if (paymentRouting.schema !== 'split-payments-v1') return false;
  if (
    new PublicKey(paymentRouting.deliveryPaymentReceiver).toBase58() !== config.paymentRouting.deliveryPaymentReceiver ||
    paymentRouting.mintProceeds.length !== config.paymentRouting.mintProceeds.length
  ) return false;
  return config.paymentRouting.mintProceeds.every((expected, index) => {
    const actual = paymentRouting.mintProceeds[index];
    return Boolean(actual) &&
      new PublicKey(actual.address).toBase58() === expected.address &&
      actual.percentage === expected.percentage;
  });
}

async function loadOnchainState(
  context: ProviderContext,
  runtime: DeliveryRuntime,
): Promise<OnchainState> {
  const result = await rpcCall(context, runtime, 'getMultipleAccounts', [
    [runtime.collectionMint.toBase58(), runtime.boxMinterConfigPda.toBase58()],
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== 2) {
    throw new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid account response.');
  }
  if (!result.value[0]) {
    throw new DeliveryPrepareError('failed-precondition', 'Configured collection was not found on-chain.', {
      collection: runtime.collectionMint.toBase58(),
      dropId: runtime.dropId,
    });
  }
  if (!result.value[1]) {
    throw new DeliveryPrepareError('failed-precondition', 'Box minter config PDA not found.', {
      configPda: runtime.boxMinterConfigPda.toBase58(),
      dropId: runtime.dropId,
    });
  }
  const collection = parseRpcAccount(result.value[0], 'COLLECTION_MINT');
  const configAccount = parseRpcAccount(result.value[1], 'BOX_MINTER_CONFIG_PDA');
  if (
    !collection.owner.equals(MPL_CORE_PROGRAM_ID) ||
    collection.data.length < MPL_CORE_COLLECTION_V1_MIN_BYTES ||
    collection.data[0] !== MPL_CORE_COLLECTION_V1_DISCRIMINATOR
  ) {
    throw new DeliveryPrepareError('failed-precondition', 'Configured collection is not an MPL Core collection.');
  }
  if (!configAccount.owner.equals(runtime.boxMinterProgramId)) {
    throw new DeliveryPrepareError('failed-precondition', 'Box minter config PDA has an unexpected owner.');
  }
  let decoded: DecodedBoxMinterConfigData;
  try {
    decoded = decodeBoxMinterConfigData(configAccount.data, {
      validateDiscriminator: true,
      decodeExtensions: true,
    });
  } catch (error) {
    if (error instanceof BoxMinterConfigCodecError) {
      throw new DeliveryPrepareError('failed-precondition', error.message, error.details);
    }
    throw error;
  }
  const admin = new PublicKey(decoded.admin);
  const treasury = new PublicKey(decoded.treasury);
  const coreCollection = new PublicKey(decoded.coreCollection);
  if (
    !coreCollection.equals(runtime.collectionMint) ||
    decoded.itemsPerBox !== runtime.itemsPerBox ||
    decoded.maxSupply !== runtime.maxSupply ||
    decoded.discountMintsPerWallet !== runtime.config.discountMintsPerWallet ||
    !isBoxMinterDiscountMintsPerWallet(decoded.discountMintsPerWallet) ||
    !boxMinterMetadataBaseMatchesDrop(
      decoded.uriBase,
      runtime.config.metadataBase,
      runtime.config.metadataBaseAliases,
    ) ||
    treasury.toBase58() !== runtime.config.treasury ||
    !paymentRoutingMatches(runtime.config, decoded)
  ) {
    throw new DeliveryPrepareError('failed-precondition', 'Committed drop configuration does not match the on-chain config.', {
      dropId: runtime.dropId,
    });
  }
  return { admin, treasury, coreCollection };
}

async function loadLatestBlockhash(context: ProviderContext, runtime: DeliveryRuntime): Promise<string> {
  const result = await rpcCall(context, runtime, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const value = isRecord(result) ? result.value : undefined;
  const blockhash = isRecord(value) && typeof value.blockhash === 'string' ? value.blockhash : '';
  try {
    if (!blockhash || new PublicKey(blockhash).toBytes().length !== 32) throw new Error('invalid');
  } catch {
    throw new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid blockhash.');
  }
  return blockhash;
}

async function loadLookupTable(
  context: ProviderContext,
  runtime: DeliveryRuntime,
): Promise<AddressLookupTableAccount[]> {
  if (!runtime.deliveryLookupTable) return [];
  const result = await rpcCall(context, runtime, 'getAccountInfo', [
    runtime.deliveryLookupTable.toBase58(),
    { commitment: 'confirmed', encoding: 'base64' },
  ]);
  const value = isRecord(result) ? result.value : undefined;
  if (!value) {
    throw new DeliveryPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE not found on-chain.');
  }
  const account = parseRpcAccount(value, 'DELIVERY_LOOKUP_TABLE');
  if (!account.owner.equals(AddressLookupTableProgram.programId)) {
    throw new DeliveryPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE has an unexpected owner.');
  }
  try {
    const lookupTable = new AddressLookupTableAccount({
      key: runtime.deliveryLookupTable,
      state: AddressLookupTableAccount.deserialize(account.data),
    });
    if (!lookupTable.isActive()) {
      throw new DeliveryPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE is inactive.');
    }
    return [lookupTable];
  } catch (error) {
    if (error instanceof DeliveryPrepareError) throw error;
    throw new DeliveryPrepareError('failed-precondition', 'DELIVERY_LOOKUP_TABLE is invalid.');
  }
}

async function deliveryPdaExists(
  context: ProviderContext,
  runtime: DeliveryRuntime,
  deliveryPda: PublicKey,
): Promise<boolean> {
  const result = await rpcCall(context, runtime, 'getAccountInfo', [
    deliveryPda.toBase58(),
    { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 }, encoding: 'base64' },
  ]);
  if (!isRecord(result) || !Object.hasOwn(result, 'value')) {
    throw new DeliveryPrepareError('unavailable', 'Delivery provider returned an invalid account response.');
  }
  return result.value !== null;
}

async function loadWalletSession(context: FirestoreContext, uid: string): Promise<string> {
  const url = new URL(`${FIRESTORE_DOCUMENTS_BASE_URL}/${WALLET_SESSION_COLLECTION}/${encodeURIComponent(uid)}`);
  url.searchParams.append('mask.fieldPaths', 'wallet');
  const document = await authenticatedFirestoreRequest({ ...context, method: 'GET', url: url.toString() });
  const fields = isRecord(document) ? decodeFirestoreFields(document.fields) : null;
  const resolution = resolveWalletSessionBinding({
    uid,
    sessionExists: Boolean(document),
    sessionData: fields,
  });
  if ('reason' in resolution) throw new DeliveryPrepareError('unauthenticated', 'Sign in with your wallet first.');
  return resolution.wallet;
}

async function loadAddress(
  context: FirestoreContext,
  wallet: string,
  addressId: string,
): Promise<AddressDocument> {
  const url = new URL(
    `${FIRESTORE_DOCUMENTS_BASE_URL}/profiles/${encodeURIComponent(wallet)}/addresses/${encodeURIComponent(addressId)}`,
  );
  const document = await authenticatedFirestoreRequest({ ...context, method: 'GET', url: url.toString() });
  if (!isRecord(document)) throw new DeliveryPrepareError('not-found', 'Address not found');
  const rawFields = isRecord(document.fields) ? document.fields : null;
  const decoded = rawFields ? decodeFirestoreFields(rawFields) : null;
  if (!rawFields || !decoded) {
    throw new DeliveryPrepareError('unavailable', 'Delivery address is temporarily unavailable.');
  }
  return { decoded, rawFields };
}

function firestoreInteger(value: number): Record<string, unknown> {
  return { integerValue: String(value) };
}

function firestoreItem(item: DeliveryOrderItem): Record<string, unknown> {
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

async function createDeliveryOrder(
  context: FirestoreContext,
  input: DeliveryOrderCreateInput,
): Promise<string> {
  const reconcile = () => reconcileCreatedDeliveryOrder({
    ...context,
    signal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
  }, input).catch(() => null);
  const snapshotFields: Record<string, unknown> = {
    ...input.address.rawFields,
    id: firestoreString(input.addressId),
    ...(input.addressCountry ? { countryCode: firestoreString(input.addressCountry) } : {}),
  };
  const fields: Record<string, unknown> = {
    dropId: firestoreString(input.dropId),
    status: firestoreString('prepared'),
    owner: firestoreString(input.owner),
    addressId: firestoreString(input.addressId),
    addressSnapshot: { mapValue: { fields: snapshotFields } },
    itemIds: { arrayValue: { values: input.items.map((item) => firestoreString(item.assetId)) } },
    items: { arrayValue: { values: input.items.map(firestoreItem) } },
    deliveryId: firestoreInteger(input.deliveryId),
    deliveryPda: firestoreString(input.deliveryPda),
    ...(input.lookupTable ? { lookupTable: firestoreString(input.lookupTable) } : {}),
    deliveryLamports: firestoreInteger(input.deliveryLamports),
    prepareAttemptId: firestoreString(input.prepareAttemptId),
    receiptRecovery: {
      mapValue: {
        fields: {
          preparedProbeCount: firestoreInteger(0),
          nextPreparedProbeAt: { timestampValue: new Date(input.nextPreparedProbeAtMs).toISOString() },
        },
      },
    },
  };
  let payload: unknown;
  try {
    payload = await authenticatedFirestoreRequest({
      ...context,
      body: JSON.stringify({
        writes: [{
          update: {
            name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${input.path}`,
            fields,
          },
          currentDocument: { exists: false },
          updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
        }],
      }),
      method: 'POST',
      surfaceWriteConflict: true,
      url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
    });
  } catch (error) {
    const reconciled = await reconcile();
    if (reconciled) return reconciled;
    throw error;
  }
  const writeResults = isRecord(payload) ? payload.writeResults : undefined;
  const updateTime = Array.isArray(writeResults) && isRecord(writeResults[0]) &&
    typeof writeResults[0].updateTime === 'string'
    ? writeResults[0].updateTime
    : '';
  if (!updateTime) {
    const reconciled = await reconcile();
    if (reconciled) return reconciled;
    throw new DeliveryPrepareError('unavailable', 'Delivery preparation is temporarily unavailable.');
  }
  return updateTime;
}

async function reconcileCreatedDeliveryOrder(
  context: FirestoreContext,
  input: DeliveryOrderCreateInput,
): Promise<string | null> {
  const document = await authenticatedFirestoreRequest({
    ...context,
    method: 'GET',
    url: `${FIRESTORE_DOCUMENTS_BASE_URL}/${input.path}`,
  });
  if (!isRecord(document) || typeof document.updateTime !== 'string') return null;
  const decoded = decodeFirestoreFields(document.fields);
  if (
    !decoded ||
    decoded.prepareAttemptId !== input.prepareAttemptId ||
    decoded.status !== 'prepared' ||
    decoded.dropId !== input.dropId ||
    decoded.owner !== input.owner ||
    decoded.addressId !== input.addressId ||
    decoded.deliveryId !== input.deliveryId ||
    decoded.deliveryPda !== input.deliveryPda ||
    decoded.deliveryLamports !== input.deliveryLamports ||
    JSON.stringify(decoded.itemIds) !== JSON.stringify(input.items.map((item) => item.assetId))
  ) return null;
  return document.updateTime;
}

async function deleteDeliveryOrder(
  context: FirestoreContext,
  path: string,
  updateTime: string,
): Promise<void> {
  await authenticatedFirestoreRequest({
    ...context,
    body: JSON.stringify({
      writes: [{
        delete: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`,
        currentDocument: { updateTime },
      }],
    }),
    method: 'POST',
    surfaceWriteConflict: true,
    url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
  });
}

function secureDeliveryId(): number {
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while ((values[0] & 0x7fff_ffff) === 0);
  return values[0] & 0x7fff_ffff;
}

function decodeCosigner(secret: string): Keypair {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(secret.trim());
  } catch {
    throw new DeliveryPrepareError('failed-precondition', 'COSIGNER_SECRET is not configured correctly.');
  }
  if (decoded.length !== 64) {
    throw new DeliveryPrepareError('failed-precondition', 'COSIGNER_SECRET is not configured correctly.');
  }
  try {
    return Keypair.fromSecretKey(decoded);
  } catch {
    throw new DeliveryPrepareError('failed-precondition', 'COSIGNER_SECRET is not configured correctly.');
  }
}

function u32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function u64LE(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function maximumDeliveryLamports(runtime: DeliveryRuntime): number {
  const maximumFigures = MAX_DELIVERY_ITEMS * Math.max(
    1,
    normalizeDeliveryUnitsPerBox(runtime.itemsPerBox, SERVER_INVALID_DELIVERY_UNITS_POLICY),
  );
  return Math.max(
    calculateDeliveryLamports(
      Array.from({ length: MAX_DELIVERY_ITEMS }, () => ({ kind: 'box' as const })),
      'US',
      runtime.itemsPerBox,
      runtime.config.dropFamily,
      SERVER_INVALID_DELIVERY_UNITS_POLICY,
    ),
    calculateDeliveryLamports(
      Array.from({ length: maximumFigures }, () => ({ kind: 'dude' as const })),
      'ZZ',
      runtime.itemsPerBox,
      runtime.config.dropFamily,
      SERVER_INVALID_DELIVERY_UNITS_POLICY,
    ),
  );
}

function encodeDeliverArgs(
  runtime: DeliveryRuntime,
  deliveryId: number,
  feeLamports: number,
  deliveryBump: number,
): Buffer {
  if (!Number.isInteger(deliveryId) || deliveryId < 1 || deliveryId > 0xffff_ffff) {
    throw new DeliveryPrepareError('invalid-argument', 'Invalid deliveryId');
  }
  if (
    !Number.isSafeInteger(feeLamports) ||
    feeLamports < 0 ||
    feeLamports > maximumDeliveryLamports(runtime)
  ) {
    throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery_fee_lamports');
  }
  if (!Number.isInteger(deliveryBump) || deliveryBump < 0 || deliveryBump > 255) {
    throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery bump');
  }
  return Buffer.concat([IX_DELIVER, u32LE(deliveryId), u64LE(feeLamports), Buffer.from([deliveryBump])]);
}

function isLegacySingletonConfigPda(programId: PublicKey, configPda: PublicKey): boolean {
  return configPda.equals(PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], programId)[0]);
}

function deriveDeliveryPda(runtime: DeliveryRuntime, deliveryId: number): [PublicKey, number] {
  const seeds: Uint8Array[] = [Buffer.from('delivery')];
  if (!isLegacySingletonConfigPda(runtime.boxMinterProgramId, runtime.boxMinterConfigPda)) {
    seeds.push(runtime.boxMinterConfigPda.toBuffer());
  }
  seeds.push(u32LE(deliveryId));
  return PublicKey.findProgramAddressSync(seeds, runtime.boxMinterProgramId);
}

function buildInstruction(args: {
  runtime: DeliveryRuntime;
  owner: PublicKey;
  signer: PublicKey;
  treasury: PublicKey;
  coreCollection: PublicKey;
  deliveryPda: PublicKey;
  deliveryId: number;
  deliveryBump: number;
  deliveryLamports: number;
  assetPks: PublicKey[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.runtime.boxMinterProgramId,
    keys: [
      { pubkey: args.runtime.boxMinterConfigPda, isSigner: false, isWritable: false },
      { pubkey: args.signer, isSigner: true, isWritable: false },
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: args.treasury, isSigner: false, isWritable: true },
      { pubkey: args.coreCollection, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.deliveryPda, isSigner: false, isWritable: true },
      ...args.assetPks.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: encodeDeliverArgs(args.runtime, args.deliveryId, args.deliveryLamports, args.deliveryBump),
  });
}

function buildTransaction(
  instructions: TransactionInstruction[],
  owner: PublicKey,
  blockhash: string,
  signer: Keypair,
  lookupTables: AddressLookupTableAccount[],
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([signer]);
  return transaction;
}

function transactionEncodingTooLarge(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof RangeError && (
    /encoding overruns Uint8Array/i.test(message) ||
    /offset.*out of range/i.test(message) ||
    String((error as { code?: unknown }).code || '') === 'ERR_OUT_OF_RANGE'
  );
}

function serializedTransactionSize(build: () => VersionedTransaction): number {
  try {
    return build().serialize().length;
  } catch (error) {
    if (!transactionEncodingTooLarge(error)) throw error;
    return SOLANA_MAX_RAW_TX_BYTES + 1;
  }
}

function ensurePacketFits(args: {
  runtime: DeliveryRuntime;
  owner: PublicKey;
  signer: Keypair;
  lookupTables: AddressLookupTableAccount[];
  assetPks: PublicKey[];
  onchain: OnchainState;
  deliveryPda: PublicKey;
  deliveryId: number;
  deliveryBump: number;
  deliveryLamports: number;
}): TransactionInstruction {
  const instruction = buildInstruction({
    runtime: args.runtime,
    owner: args.owner,
    signer: args.signer.publicKey,
    treasury: args.onchain.treasury,
    coreCollection: args.onchain.coreCollection,
    deliveryPda: args.deliveryPda,
    deliveryId: args.deliveryId,
    deliveryBump: args.deliveryBump,
    deliveryLamports: args.deliveryLamports,
    assetPks: args.assetPks,
  });
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction];
  const rawBytes = serializedTransactionSize(() =>
    buildTransaction(instructions, args.owner, DUMMY_BLOCKHASH, args.signer, args.lookupTables));
  if (rawBytes <= SOLANA_MAX_RAW_TX_BYTES) return instruction;
  let maxFit = 0;
  for (let count = args.assetPks.length - 1; count >= 1; count -= 1) {
    const candidateInstruction = buildInstruction({
      runtime: args.runtime,
      owner: args.owner,
      signer: args.signer.publicKey,
      treasury: args.onchain.treasury,
      coreCollection: args.onchain.coreCollection,
      deliveryPda: args.deliveryPda,
      deliveryId: args.deliveryId,
      deliveryBump: args.deliveryBump,
      deliveryLamports: args.deliveryLamports,
      assetPks: args.assetPks.slice(0, count),
    });
    const candidateBytes = serializedTransactionSize(() => buildTransaction(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), candidateInstruction],
      args.owner,
      DUMMY_BLOCKHASH,
      args.signer,
      args.lookupTables,
    ));
    if (candidateBytes <= SOLANA_MAX_RAW_TX_BYTES) {
      maxFit = count;
      break;
    }
  }
  throw new DeliveryPrepareError(
    'failed-precondition',
    `Delivery transaction too large (${rawBytes} bytes > ${SOLANA_MAX_RAW_TX_BYTES}). Try fewer items.` +
      (maxFit ? ` Estimated max that fits: ${maxFit}.` : ' Try 1 item.'),
    { rawBytes, maxRawBytes: SOLANA_MAX_RAW_TX_BYTES, items: args.assetPks.length, maxFit },
  );
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
  onFailure?: (error: unknown) => void,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await map(values[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          onFailure?.(error);
        }
      }
    }
  }));
  if (failed) throw failure;
  return results;
}

function orderItem(asset: DasAsset, assetId: string, runtime: DeliveryRuntime, owner: string): DeliveryOrderItem {
  if (asset.id !== assetId) {
    throw new DeliveryPrepareError('failed-precondition', 'Asset id does not match the requested item');
  }
  const kind = dasAssetKind(asset, NAME_POLICY);
  if (!kind) throw new DeliveryPrepareError('failed-precondition', 'Unsupported asset type');
  if (kind === 'certificate') {
    throw new DeliveryPrepareError('failed-precondition', 'Certificates cannot be delivered');
  }
  if (!canDeliverItemKind(runtime.config.dropFamily, kind)) {
    throw new DeliveryPrepareError('failed-precondition', 'Clear Cards packs must be opened before delivery');
  }
  if (
    clusterSharesCollection(runtime) ||
    uniqueAssetGroupingCollectionMint(asset) !== runtime.collectionMint.toBase58()
  ) {
    throw new DeliveryPrepareError('failed-precondition', 'Item does not belong to the requested drop');
  }
  if (!isRecord(asset.ownership) || asset.ownership.owner !== owner) {
    throw new DeliveryPrepareError('failed-precondition', 'Item not owned by wallet');
  }
  if (kind === 'box') {
    const refId = Number(dasAssetBoxId(asset, NAME_POLICY));
    if (!Number.isInteger(refId) || refId < 1 || refId > 0xffff_ffff) {
      throw new DeliveryPrepareError('failed-precondition', 'Box id missing from metadata');
    }
    return { assetId, kind, refId };
  }
  const refId = Number(dasAssetDudeId(asset));
  if (!Number.isInteger(refId) || refId < 1 || refId > runtime.maxDudeId) {
    throw new DeliveryPrepareError('failed-precondition', 'Dude id missing from metadata');
  }
  return { assetId, kind, refId };
}

async function prepareDelivery(args: {
  body: PrepareDeliveryRequest;
  context: FirestoreContext;
  providerContext: ProviderContext;
  identity: FirebaseIdentity;
  env: DeliveryPrepareEnv;
  dependencies: DeliveryPrepareDependencies;
  prepareAttemptId?: string;
}): Promise<PrepareDeliveryResponse> {
  const sessionWallet = await args.dependencies.loadWalletSession(args.context, args.identity.uid);
  const owner = canonicalPublicKey(args.body.owner, 'wallet address');
  const ownerWallet = owner.toBase58();
  if (sessionWallet !== ownerWallet) throw new DeliveryPrepareError('permission-denied', 'Owners only');
  const dropId = normalizeDropId(args.body.dropId);
  const config = args.dependencies.getDrop(dropId);
  if (!config) throw new DeliveryPrepareError('invalid-argument', `Unsupported dropId: ${dropId}`);
  const runtime = buildRuntime(config);
  const itemIds = args.body.itemIds.map((itemId) => canonicalPublicKey(itemId, 'asset id').toBase58());
  if (new Set(itemIds).size !== itemIds.length) {
    throw new DeliveryPrepareError('invalid-argument', 'Duplicate itemIds are not allowed');
  }
  const address = await args.dependencies.loadAddress(args.context, ownerWallet, args.body.addressId);
  const rawAddressCountry = typeof address.decoded.countryCode === 'string' && address.decoded.countryCode
    ? address.decoded.countryCode
    : typeof address.decoded.country === 'string' ? address.decoded.country : '';
  const addressCountry = normalizeCountryCode(rawAddressCountry) || rawAddressCountry;
  const assetAbort = new AbortController();
  const assetContext = {
    ...args.providerContext,
    signal: AbortSignal.any([args.providerContext.signal, assetAbort.signal]),
  };
  const items = await mapWithConcurrency(itemIds, PROVIDER_CONCURRENCY, async (assetId) =>
    orderItem(
      await args.dependencies.fetchAsset(assetContext, runtime, assetId),
      assetId,
      runtime,
      ownerWallet,
    ), (error) => assetAbort.abort(error));
  const deliveryLamports = calculateDeliveryLamports(
    items,
    addressCountry,
    runtime.itemsPerBox,
    runtime.config.dropFamily,
    SERVER_INVALID_DELIVERY_UNITS_POLICY,
  );
  const onchain = await args.dependencies.loadOnchainState(args.providerContext, runtime);
  const signer = decodeCosigner(String(args.env.COSIGNER_SECRET || ''));
  if (!signer.publicKey.equals(onchain.admin)) {
    throw new DeliveryPrepareError('failed-precondition', 'COSIGNER_SECRET does not match on-chain admin', {
      expectedAdmin: onchain.admin.toBase58(),
      cosigner: signer.publicKey.toBase58(),
    });
  }
  const lookupTables = await args.dependencies.loadLookupTable(args.providerContext, runtime);
  const assetPks = itemIds.map((itemId) => new PublicKey(itemId));
  const prepareAttemptId = args.prepareAttemptId || args.dependencies.attemptId();
  if (!ATTEMPT_ID_PATTERN.test(prepareAttemptId)) {
    throw new DeliveryPrepareError('internal', 'Delivery preparation failed.');
  }
  for (let attempt = 0; attempt < MAX_DELIVERY_ID_ATTEMPTS; attempt += 1) {
    const deliveryId = args.dependencies.candidateId();
    if (!Number.isInteger(deliveryId) || deliveryId < 1 || deliveryId >= 2 ** 31) {
      throw new DeliveryPrepareError('internal', 'Delivery preparation failed.');
    }
    const [deliveryPda, deliveryBump] = deriveDeliveryPda(runtime, deliveryId);
    if (await args.dependencies.deliveryPdaExists(args.providerContext, runtime, deliveryPda)) continue;
    const instruction = ensurePacketFits({
      runtime,
      owner,
      signer,
      lookupTables,
      assetPks,
      onchain,
      deliveryPda,
      deliveryId,
      deliveryBump,
      deliveryLamports,
    });
    const path = dropDeliveryOrderPath(dropId, deliveryId);
    let updateTime: string;
    try {
      updateTime = await args.dependencies.createDeliveryOrder(args.context, {
        path,
        dropId,
        owner: ownerWallet,
        addressId: args.body.addressId,
        address,
        addressCountry,
        items,
        deliveryId,
        deliveryPda: deliveryPda.toBase58(),
        ...(runtime.deliveryLookupTable ? { lookupTable: runtime.deliveryLookupTable.toBase58() } : {}),
        deliveryLamports,
        nextPreparedProbeAtMs: args.dependencies.nowMs() + DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS[0],
        prepareAttemptId,
      });
    } catch (error) {
      if (error instanceof FirestoreWriteConflict) continue;
      throw error;
    }
    try {
      const blockhash = await args.dependencies.loadLatestBlockhash(args.providerContext, runtime);
      const transaction = buildTransaction(
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), instruction],
        owner,
        blockhash,
        signer,
        lookupTables,
      );
      return {
        encodedTx: Buffer.from(transaction.serialize()).toString('base64'),
        deliveryLamports,
        deliveryId,
      };
    } catch (error) {
      try {
        await args.dependencies.deleteDeliveryOrder({
          ...args.context,
          nowMs: args.dependencies.nowMs(),
          signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
        }, path, updateTime);
      } catch (cleanupError) {
        console.error({
          event: 'delivery_prepare_cleanup_failed',
          dropId,
          deliveryId,
          error: cleanupError instanceof Error ? { name: cleanupError.name, message: cleanupError.message } : { name: 'UnknownError' },
        });
      }
      throw error;
    }
  }
  throw new DeliveryPrepareError('unavailable', 'Failed to allocate delivery id. Try again.');
}

const defaultDependencies: DeliveryPrepareDependencies = {
  accessTokenProvider: createGoogleAccessTokenProvider(),
  attemptId: () => crypto.randomUUID(),
  candidateId: secureDeliveryId,
  createDeliveryOrder,
  deleteDeliveryOrder,
  deliveryPdaExists,
  fetchAsset,
  getDrop: getFunctionsDrop,
  loadAddress,
  loadLatestBlockhash,
  loadLookupTable,
  loadOnchainState,
  loadWalletSession,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: HANDLER_TIMEOUT_MS,
  verifyIdToken: verifyFirebaseIdToken,
};

export async function handleDeliveryPrepare(
  request: Request,
  env: DeliveryPrepareEnv,
  overrides: Partial<DeliveryPrepareDependencies> = {},
): Promise<DeliveryPrepareResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics: DeliveryPrepareMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
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
    const response = errorResponse(new DeliveryPrepareError('invalid-argument', 'Method not allowed.'));
    response.headers.set('Allow', 'POST, OPTIONS');
    return {
      response: new Response(response.body, { headers: response.headers, status: 405 }),
      metrics,
      authOutcome: 'rejected',
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Delivery preparation request timed out', 'TimeoutError')),
    dependencies.timeoutMs,
  );
  let identity: FirebaseIdentity | undefined;
  let dropId: string | undefined;
  try {
    identity = await dependencies.verifyIdToken(
      request.headers.get('Authorization'),
      trackedFetch,
      controller.signal,
      dependencies.nowMs(),
    );
    const body = await readRequestBody(request, controller.signal);
    const requestedDropId = normalizeDropId(body.dropId);
    dropId = dependencies.getDrop(requestedDropId) ? requestedDropId : undefined;
    const serviceAccountJson = String(env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON || '').trim();
    const apiKey = String(env.HELIUS_API_KEY || '').trim();
    if (!serviceAccountJson || !apiKey || !String(env.COSIGNER_SECRET || '').trim()) {
      throw new DeliveryPrepareError('unavailable', 'Delivery preparation is temporarily unavailable.');
    }
    const nowMs = dependencies.nowMs();
    const prepareAttemptId = request.headers.get(DELIVERY_PREPARE_ATTEMPT_HEADER)?.trim();
    if (prepareAttemptId && !ATTEMPT_ID_PATTERN.test(prepareAttemptId)) {
      throw new DeliveryPrepareError('invalid-argument', 'Invalid delivery preparation attempt.');
    }
    const response = await prepareDelivery({
      body,
      identity,
      env,
      dependencies,
      ...(prepareAttemptId ? { prepareAttemptId } : {}),
      context: {
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
    return { response: jsonResponse(response, 200), metrics, authOutcome: 'accepted', dropId };
  } catch (error) {
    let deliveryError: DeliveryPrepareError;
    let authOutcome: DeliveryPrepareResult['authOutcome'] = identity ? 'provider-failure' : 'rejected';
    if (error instanceof DeliveryPrepareError) {
      deliveryError = error;
      if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
        authOutcome = 'rejected';
      }
    } else if (error instanceof FirebaseIdTokenError) {
      deliveryError = error.kind === 'invalid-token'
        ? new DeliveryPrepareError('unauthenticated', 'Authentication is required.')
        : error.kind === 'provider-timeout'
          ? new DeliveryPrepareError('deadline-exceeded', 'Delivery preparation request timed out.')
          : new DeliveryPrepareError('unavailable', 'Authentication is temporarily unavailable.');
      authOutcome = error.kind === 'invalid-token' ? 'rejected' : 'provider-failure';
    } else if (error instanceof ProfileReadError) {
      deliveryError = new DeliveryPrepareError(error.code, error.message, error.details);
      if (['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted'].includes(error.code)) {
        authOutcome = 'rejected';
      }
    } else if (error instanceof FirestoreWriteConflict) {
      deliveryError = new DeliveryPrepareError('aborted', 'Delivery preparation conflicted. Try again.');
      authOutcome = 'rejected';
    } else if (controller.signal.aborted) {
      deliveryError = new DeliveryPrepareError('deadline-exceeded', 'Delivery preparation request timed out.');
    } else {
      console.error({
        event: 'delivery_prepare_failed',
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
      });
      deliveryError = new DeliveryPrepareError('internal', 'Delivery preparation failed.');
    }
    if (!identity) await request.body?.cancel().catch(() => undefined);
    return { response: errorResponse(deliveryError), metrics, authOutcome, ...(dropId ? { dropId } : {}) };
  } finally {
    clearTimeout(timeout);
  }
}

export const deliveryPrepareTestHooks = {
  buildInstruction,
  buildRuntime,
  createDeliveryOrder,
  decodeCosigner,
  deriveDeliveryPda,
  encodeDeliverArgs,
  fetchAsset,
  loadLookupTable,
  loadOnchainState,
  orderItem,
  prepareDelivery,
  secureDeliveryId,
};
