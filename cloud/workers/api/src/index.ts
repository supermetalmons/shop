import bs58 from 'bs58';
import {
  HELIUS_COLLECTION_GROUPING_OPTIONS,
  uniqueAssetGroupingCollectionMint,
} from '../../../../functions/src/shared/dasAssetCollections.js';
import type { DasAsset } from '../../../../functions/src/shared/dasAsset.js';
import {
  HELIUS_SEARCH_ASSETS_MAX_CANDIDATES,
  HELIUS_SEARCH_ASSETS_MAX_CURSOR_PAGES,
  HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES,
  HELIUS_SEARCH_ASSETS_MAX_PROVIDER_CALLS,
  HELIUS_SEARCH_ASSETS_MAX_TOTAL_BYTES,
  HELIUS_SEARCH_ASSETS_PAGE_LIMITS,
  heliusSearchAssetsCursorPageInfo,
  heliusSearchAssetsItems,
} from '../../../../functions/src/shared/heliusDas.js';
import { PENDING_OPEN_BOX_DISCRIMINATOR } from '../../../../functions/src/shared/pendingOpenCodec.js';
import {
  isExactShopInventoryRequest,
  isExactShopInventoryResponse,
  isExactShopPendingOpenBoxesRequest,
  isExactShopPendingOpenBoxesResponse,
  SHOP_API_MAX_RESPONSE_ITEMS,
  type ShopExpectedAssetIds,
  type ShopInventoryRequest,
  type ShopInventoryItem,
  type ShopInventoryResponse,
  type ShopPendingOpenBoxesRequest,
  type ShopPendingOpenBoxesResponse,
} from '../../../../functions/src/shared/shopApi.js';
import {
  decodePendingOpenRecordData,
  listShopCollectionQueryRuntimes,
  listShopPendingOpenProgramScopes,
  resolvePendingOpenDropId,
  shopDropById,
  toShopPendingOpenBox,
  transformShopInventoryItem,
  type PendingOpenRecordCandidate,
  type ShopDropRuntime,
} from '../../../../functions/src/shared/shopDomain.js';
import type { SolanaCluster } from '../../../../functions/src/shared/deploymentCore.js';
import {
  isExactSubscribeToNotificationsRequest,
  normalizeNotificationEmailRecipient,
} from '../../../../functions/src/shared/notificationSubscription.js';
import { isBase58Bytes } from '../../../../functions/src/shared/solanaRpcProxy.js';
import {
  handleRpcPost,
  handleRpcPreflight,
  handleRpcMethodNotAllowed,
  type RpcProviderFetch,
  type RpcProxyDependencies,
  type RpcRequestMetrics,
} from './rpcProxy.js';
import {
  MAX_INVENTORY_RESPONSE_BODY_BYTES,
  MAX_INVENTORY_SERIALIZED_ITEM_BYTES,
} from './inventoryLimits.js';
import {
  fetchFirestorePackStatus,
  FIRESTORE_PACK_STATUS_TIMEOUT_MS,
  isPackStatusRouteDropId,
  type FirestorePackStatusFetch,
} from './firestorePackStatus.js';
import { handleNotificationEnqueue, NOTIFICATION_ENQUEUE_PATH } from './notificationEnqueue.js';
import {
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  applyProfileCors,
  handleProfileCorsPreflight,
  handleProfileReadRequest,
  isProfileRequestOriginAllowed,
  PROFILE_READ_PATHS,
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
  type ProfileReadPath,
} from './profileReads.js';

const HELIUS_BATCH_LIMIT = 1000;
const HELIUS_OVERALL_TIMEOUT_MS = 60_000;
const HELIUS_ATTEMPT_TIMEOUT_MS = 15_000;
const EXPECTED_ASSET_RECOVERY_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BODY_BYTES = 1024;
const MAX_RESEND_RESPONSE_BODY_BYTES = 8 * 1024;
const PROVIDER_CONCURRENCY = 3;
const RESEND_CONTACTS_API_URL = 'https://api.resend.com/contacts';
const RESEND_TIMEOUT_MS = 10_000;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const EXISTING_RESEND_CONTACT_ERROR_NAMES = new Set([
  'contact_already_exists',
  'duplicate_contact',
  'already_exists',
]);
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const BASE_HEADERS = {
  ...CORS_HEADERS,
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Timing-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
};
const PENDING_OPEN_DISCRIMINATOR_BASE58 = bs58.encode(PENDING_OPEN_BOX_DISCRIMINATOR);
const KNOWN_LOG_ROUTES = new Set([
  '/health',
  NOTIFICATION_ENQUEUE_PATH,
  '/inventory',
  '/notifications/subscribe',
  '/pack-status/:dropId',
  '/pending-open-boxes',
  '/rpc/mainnet-beta',
  '/rpc/devnet',
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
]);

export type ProviderFetch = RpcProviderFetch;

type ProviderFailureKind = 'asset-not-found' | 'deadline' | 'timeout' | 'unavailable' | 'page-too-large' | 'limit';

class ProviderFailure extends Error {
  constructor(readonly kind: ProviderFailureKind) {
    super(kind);
    this.name = 'ProviderFailure';
  }
}

type AttemptScope = {
  signal: AbortSignal;
  timedOut: () => boolean;
  pauseTimeout: () => void;
  resumeTimeout: () => void;
  dispose: () => void;
};

class ProviderReadGate {
  private tail = Promise.resolve();

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const queued = previous.then(() => {
      if (signal.aborted) throw signal.reason;
      return operation();
    });
    this.tail = queued.then(() => undefined, () => undefined);
    if (signal.aborted) throw signal.reason;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void queued.then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      ).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }
}

function createAttemptScope(overallSignal: AbortSignal, timeoutMs: number): AttemptScope {
  const controller = new AbortController();
  let attemptTimedOut = false;
  let disposed = false;
  const onOverallAbort = () => {
    if (!controller.signal.aborted) controller.abort(overallSignal.reason);
  };
  if (overallSignal.aborted) onOverallAbort();
  else overallSignal.addEventListener('abort', onOverallAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timeoutStartedAt = 0;
  let remainingTimeoutMs = timeoutMs;
  const pauseTimeout = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      remainingTimeoutMs = Math.max(0, remainingTimeoutMs - (performance.now() - timeoutStartedAt));
    }
    timeout = undefined;
  };
  const resumeTimeout = () => {
    if (disposed || controller.signal.aborted || timeout !== undefined) return;
    if (remainingTimeoutMs <= 0) {
      attemptTimedOut = true;
      controller.abort(new DOMException('Provider attempt timed out', 'TimeoutError'));
      return;
    }
    timeoutStartedAt = performance.now();
    timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      timeout = undefined;
      remainingTimeoutMs = 0;
      attemptTimedOut = true;
      controller.abort(new DOMException('Provider attempt timed out', 'TimeoutError'));
    }, remainingTimeoutMs);
  };
  resumeTimeout();
  return {
    signal: controller.signal,
    timedOut: () => attemptTimedOut,
    pauseTimeout,
    resumeTimeout,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pauseTimeout();
      overallSignal.removeEventListener('abort', onOverallAbort);
    },
  };
}

type WorkerDependencies = RpcProxyDependencies & {
  expectedAssetRecoveryTimeoutMs: number;
  firestoreFetch: FirestorePackStatusFetch;
  firestoreTimeoutMs: number;
  providerMaxResponseBodyBytes: number;
  providerMaxTotalResponseBodyBytes: number;
  inventoryMaxCandidates: number;
  inventoryMaxCursorPages: number;
  inventoryMaxProviderCalls: number;
  inventoryMaxResponseBodyBytes: number;
  log: (entry: Record<string, unknown>) => void;
  resendFetch: ProviderFetch;
  resendTimeoutMs: number;
  validateInventoryResponse: typeof isExactShopInventoryResponse;
  validatePendingOpenBoxesResponse: typeof isExactShopPendingOpenBoxesResponse;
};

type WorkerRequestMetrics = RpcRequestMetrics & {
  expectedAssetIds: number;
  expectedAssetRecoveryFailures: number;
  expectedAssetResolved: number;
};

type ProviderContext = {
  apiKey: string;
  signal: AbortSignal;
  dependencies: WorkerDependencies;
  metrics: WorkerRequestMetrics;
  providerResponseBodyBytes: number;
  inventoryCandidates: number;
  inventoryCursorPages: number;
  inventoryProviderCalls: number;
  providerReadGate: ProviderReadGate;
};

type GroupedInventoryResult = {
  scope: ShopDropRuntime;
  items: ShopInventoryItem[];
  needsFallback: boolean;
};

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

function isExistingResendContactError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const name = (value as Record<string, unknown>).name;
  return typeof name === 'string' && EXISTING_RESEND_CONTACT_ERROR_NAMES.has(name.trim().toLowerCase());
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function inventoryItemWithinLimit(item: ShopInventoryItem): boolean {
  return utf8ByteLength(JSON.stringify(item)) <= MAX_INVENTORY_SERIALIZED_ITEM_BYTES;
}

function compactInventoryItem(item: ShopInventoryItem): ShopInventoryItem {
  const {
    attributes: _attributes,
    ...withoutAttributes
  } = item as ShopInventoryItem & { attributes?: unknown };
  if (inventoryItemWithinLimit(withoutAttributes)) return withoutAttributes;
  const { rawImage: _rawImage, ...withoutImage } = withoutAttributes;
  if (inventoryItemWithinLimit(withoutImage)) return withoutImage;
  const { boxId: _boxId, ...withoutBoxId } = withoutImage;
  if (inventoryItemWithinLimit(withoutBoxId)) return withoutBoxId;
  const withFallbackName = { ...withoutBoxId, name: withoutBoxId.id };
  if (inventoryItemWithinLimit(withFallbackName)) return withFallbackName;
  throw new ProviderFailure('unavailable');
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  createLimitError: () => Error,
  consumeBytes?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      size += value.byteLength;
      consumeBytes?.(value.byteLength);
      if (size > maxBytes) throw createLimitError();
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readBoundedRequestBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) throw new Error('invalid-request');
  if (!request.body) throw new Error('invalid-request');
  return readBoundedText(request.body, MAX_REQUEST_BODY_BYTES, () => new Error('invalid-request'));
}

async function parseJsonRequestBody<T>(
  request: Request,
  validate: (value: unknown) => value is T,
): Promise<T> {
  if (String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('invalid-request');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readBoundedRequestBody(request));
  } catch {
    throw new Error('invalid-request');
  }
  if (!validate(value)) throw new Error('invalid-request');
  return value;
}

async function parseShopRequestBody<T extends ShopInventoryRequest | ShopPendingOpenBoxesRequest>(
  request: Request,
  validate: (value: unknown) => value is T,
): Promise<T> {
  const value = await parseJsonRequestBody(request, validate);
  if (!isBase58Bytes(value.owner, 32)) throw new Error('invalid-request');
  return value;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {}
}

async function readBoundedJsonResponse(
  response: Response,
  context: ProviderContext,
  pageOverflowIsRetryable = false,
  signal?: AbortSignal,
): Promise<unknown> {
  const maxBytes = context.dependencies.providerMaxResponseBodyBytes;
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new ProviderFailure(pageOverflowIsRetryable ? 'page-too-large' : 'unavailable');
  }
  if (
    Number.isFinite(contentLength) &&
    context.providerResponseBodyBytes + contentLength > context.dependencies.providerMaxTotalResponseBodyBytes
  ) {
    await cancelResponseBody(response);
    throw new ProviderFailure('limit');
  }
  if (!response.body) throw new ProviderFailure('unavailable');
  try {
    return JSON.parse(await readBoundedText(
      response.body,
      maxBytes,
      () => new ProviderFailure(pageOverflowIsRetryable ? 'page-too-large' : 'unavailable'),
      (bytes) => {
        context.providerResponseBodyBytes += bytes;
        if (context.providerResponseBodyBytes > context.dependencies.providerMaxTotalResponseBodyBytes) {
          throw new ProviderFailure('limit');
        }
      },
      signal,
    ));
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure('unavailable');
  }
}

function heliusRpcOrigin(cluster: SolanaCluster): string {
  return `https://${cluster === 'mainnet-beta' ? 'mainnet' : cluster}.helius-rpc.com/`;
}

function isTransientRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  if (typeof record.code === 'number' && (record.code === 408 || record.code === 429 || record.code === -32005 || record.code === -32603)) return true;
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  return /timeout|timed out|rate limit|temporar|overload|internal/.test(message);
}

function isAssetBatchNotFoundRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as Record<string, unknown>).code === -32004;
}

function retryDelayMs(dependencies: WorkerDependencies, response?: Response): number {
  const retryAfterHeader = response?.headers.get('Retry-After');
  if (retryAfterHeader !== undefined && retryAfterHeader !== null && retryAfterHeader.trim()) {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(1000, retryAfter * 1000);
  }
  return 100 + (dependencies.randomUint32() % 151);
}

async function heliusRpc<T>(
  context: ProviderContext,
  cluster: SolanaCluster,
  method: string,
  params: unknown,
  options: {
    assetBatchNotFoundIsRecoverable?: boolean;
    attemptTimeoutMs?: number;
    inventoryCall?: boolean;
    maxAttempts?: number;
    pageOverflowIsRetryable?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 2;
  const signal = options.signal ?? context.signal;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal.aborted) throw new ProviderFailure('deadline');
    if (options.inventoryCall) {
      if (context.inventoryProviderCalls >= context.dependencies.inventoryMaxProviderCalls) {
        throw new ProviderFailure('limit');
      }
      context.inventoryProviderCalls += 1;
    }
    const attemptScope = createAttemptScope(
      signal,
      options.attemptTimeoutMs ?? context.dependencies.providerAttemptTimeoutMs,
    );
    let response: Response | undefined;
    const startedAt = performance.now();
    try {
      context.metrics.upstreamCalls += 1;
      const requestId = `${method}-${context.metrics.upstreamCalls}`;
      response = await context.dependencies.providerFetch(
        `${heliusRpcOrigin(cluster)}?api-key=${encodeURIComponent(context.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
          signal: attemptScope.signal,
        },
      );
      if (!response.ok) {
        const retryable = TRANSIENT_HTTP_STATUSES.has(response.status);
        await cancelResponseBody(response);
        if (signal.aborted) throw new ProviderFailure('deadline');
        if (attempt + 1 < maxAttempts && retryable) {
          await context.dependencies.sleep(retryDelayMs(context.dependencies, response), attemptScope.signal);
          continue;
        }
        throw new ProviderFailure(response.status === 408 || response.status === 504 ? 'timeout' : 'unavailable');
      }
      const successfulResponse = response;
      attemptScope.pauseTimeout();
      const payload = await context.providerReadGate.run(attemptScope.signal, () => {
        attemptScope.resumeTimeout();
        if (attemptScope.signal.aborted) throw attemptScope.signal.reason;
        return readBoundedJsonResponse(
          successfulResponse,
          context,
          options.pageOverflowIsRetryable === true,
          attemptScope.signal,
        );
      });
      if (attemptScope.signal.aborted) throw attemptScope.signal.reason;
      if (!payload || typeof payload !== 'object') throw new ProviderFailure('unavailable');
      const rpc = payload as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (rpc.jsonrpc !== '2.0' || rpc.id !== requestId) throw new ProviderFailure('unavailable');
      if (rpc.error) {
        if (options.assetBatchNotFoundIsRecoverable && isAssetBatchNotFoundRpcError(rpc.error)) {
          throw new ProviderFailure('asset-not-found');
        }
        if (attempt + 1 < maxAttempts && isTransientRpcError(rpc.error)) {
          await context.dependencies.sleep(retryDelayMs(context.dependencies), attemptScope.signal);
          continue;
        }
        throw new ProviderFailure('unavailable');
      }
      if (!Object.hasOwn(rpc, 'result')) throw new ProviderFailure('unavailable');
      return rpc.result as T;
    } catch (error) {
      if (signal.aborted) throw new ProviderFailure('deadline');
      if (error instanceof ProviderFailure && error.kind === 'page-too-large') throw error;
      if (attemptScope.timedOut()) {
        if (attempt + 1 < maxAttempts) continue;
        throw new ProviderFailure('timeout');
      }
      if (error instanceof ProviderFailure) throw error;
      if (attempt + 1 < maxAttempts) {
        await context.dependencies.sleep(retryDelayMs(context.dependencies), attemptScope.signal);
        continue;
      }
      throw new ProviderFailure('unavailable');
    } finally {
      attemptScope.dispose();
      context.metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
    }
  }
  throw new ProviderFailure('unavailable');
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseSearchAssetsResult(value: unknown): { raw: unknown; items: DasAsset[] } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) throw new ProviderFailure('unavailable');
  return { raw: value, items: heliusSearchAssetsItems<DasAsset>(value) };
}

function compactInventoryPage(
  context: ProviderContext,
  assets: DasAsset[],
  cluster: SolanaCluster,
  seenIds: Set<string>,
): ShopInventoryItem[] {
  context.inventoryCandidates += assets.length;
  if (context.inventoryCandidates > context.dependencies.inventoryMaxCandidates) {
    throw new ProviderFailure('limit');
  }
  const items: ShopInventoryItem[] = [];
  for (const asset of assets) {
    if (typeof asset?.id !== 'string' || !isBase58Bytes(asset.id, 32) || seenIds.has(asset.id)) {
      throw new ProviderFailure('unavailable');
    }
    seenIds.add(asset.id);
    const item = transformShopInventoryItem(asset, cluster);
    if (!item) continue;
    const drop = shopDropById(item.dropId);
    if (drop?.solanaCluster === cluster) items.push(compactInventoryItem(item));
  }
  return items;
}

function decodePendingOpenRecordCandidate(
  entry: unknown,
  owner: string,
  scope: ReturnType<typeof listShopPendingOpenProgramScopes>[number],
): PendingOpenRecordCandidate {
  if (!entry || typeof entry !== 'object') throw new ProviderFailure('unavailable');
  const record = entry as Record<string, unknown>;
  const pendingPda = typeof record.pubkey === 'string' ? record.pubkey : '';
  const account = record.account && typeof record.account === 'object'
    ? record.account as Record<string, unknown>
    : null;
  const dataField = account?.data;
  const dataBase64 = Array.isArray(dataField) && typeof dataField[0] === 'string'
    ? dataField[0]
    : typeof dataField === 'string' ? dataField : '';
  if (
    !isBase58Bytes(pendingPda, 32) ||
    !dataBase64 ||
    (Array.isArray(dataField) && dataField[1] !== undefined && dataField[1] !== 'base64')
  ) throw new ProviderFailure('unavailable');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0));
  } catch {
    throw new ProviderFailure('unavailable');
  }
  const decoded = decodePendingOpenRecordData(bytes, scope);
  if (!decoded || decoded.owner !== owner) throw new ProviderFailure('unavailable');
  return {
    solanaCluster: scope.solanaCluster,
    pendingPda,
    boxAssetId: decoded.boxAssetId,
    dudeAssetIds: decoded.dudeAssetIds,
    candidateDrops: scope.drops,
    ...(decoded.createdSlot != null ? { createdSlot: decoded.createdSlot } : {}),
    ...(decoded.configPda ? { configPda: decoded.configPda } : {}),
  };
}

async function fetchGroupedInventoryScope(
  context: ProviderContext,
  owner: string,
  scope: ShopDropRuntime,
): Promise<GroupedInventoryResult> {
  const progress = { receivedResult: false };
  try {
    const items = await fetchInventoryCursorChain(
      context,
      owner,
      scope.solanaCluster,
      ['collection', scope.collectionMint],
      progress,
    );
    return { scope, items, needsFallback: false };
  } catch (error) {
    if (
      !progress.receivedResult &&
      !context.signal.aborted &&
      error instanceof ProviderFailure &&
      (error.kind === 'unavailable' || error.kind === 'timeout')
    ) {
      return { scope, items: [], needsFallback: true };
    }
    throw error;
  }
}

async function fetchInventoryCursorChain(
  context: ProviderContext,
  owner: string,
  cluster: SolanaCluster,
  grouping?: ['collection', string],
  progress?: { receivedResult: boolean },
): Promise<ShopInventoryItem[]> {
  const items: ShopInventoryItem[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageLimitIndex = 0;
  let hasPageReservation = false;
  while (true) {
    if (!hasPageReservation) {
      if (context.inventoryCursorPages >= context.dependencies.inventoryMaxCursorPages) {
        throw new ProviderFailure('limit');
      }
      context.inventoryCursorPages += 1;
      hasPageReservation = true;
    }
    const limit = HELIUS_SEARCH_ASSETS_PAGE_LIMITS[pageLimitIndex];
    let parsed: { raw: unknown; items: DasAsset[] };
    try {
      const result = await heliusRpc(
        context,
        cluster,
        'searchAssets',
        {
          ownerAddress: owner,
          ...(grouping ? { grouping } : {}),
          tokenType: 'nonFungible',
          limit,
          ...(cursor ? { cursor } : {}),
          sortBy: { sortBy: 'id', sortDirection: 'asc' },
          burnt: false,
          options: HELIUS_COLLECTION_GROUPING_OPTIONS,
        },
        { inventoryCall: true, pageOverflowIsRetryable: true },
      );
      if (progress) progress.receivedResult = true;
      parsed = parseSearchAssetsResult(result);
    } catch (error) {
      if (error instanceof ProviderFailure && error.kind === 'page-too-large') {
        if (pageLimitIndex + 1 < HELIUS_SEARCH_ASSETS_PAGE_LIMITS.length) {
          pageLimitIndex += 1;
          continue;
        }
        throw new ProviderFailure('unavailable');
      }
      throw error;
    }
    let pageInfo: ReturnType<typeof heliusSearchAssetsCursorPageInfo>;
    try {
      pageInfo = heliusSearchAssetsCursorPageInfo(
        parsed.raw,
        parsed.items.length,
        limit,
        seenCursors,
      );
    } catch {
      throw new ProviderFailure('unavailable');
    }
    items.push(...compactInventoryPage(context, parsed.items, cluster, seenIds));
    if (!pageInfo.hasMore) return items;
    seenCursors.add(pageInfo.cursor);
    cursor = pageInfo.cursor;
    hasPageReservation = false;
  }
}

async function fetchUngroupedInventory(
  context: ProviderContext,
  owner: string,
  cluster: SolanaCluster,
): Promise<ShopInventoryItem[]> {
  return fetchInventoryCursorChain(context, owner, cluster);
}

async function fetchInventory(
  context: ProviderContext,
  requestBody: ShopInventoryRequest,
): Promise<ShopInventoryResponse> {
  const expectedGroups = expectedAssetGroups(requestBody.expectedAssetIds);
  context.metrics.expectedAssetIds = expectedGroups.reduce((total, group) => total + group.ids.length, 0);
  const scopes = listShopCollectionQueryRuntimes(requestBody.includeDevnet === true);
  const grouped = await mapConcurrent(scopes, PROVIDER_CONCURRENCY, (scope) =>
    fetchGroupedInventoryScope(context, requestBody.owner, scope));
  const fallbackClusters = Array.from(new Set(
    grouped.filter((entry) => entry.needsFallback).map((entry) => entry.scope.solanaCluster),
  ));
  const fallbackRows = await mapConcurrent(fallbackClusters, PROVIDER_CONCURRENCY, async (cluster) => ({
    cluster,
    items: await fetchUngroupedInventory(context, requestBody.owner, cluster),
  }));
  const itemsById = new Map<string, ShopInventoryItem>();
  for (const result of grouped) {
    for (const item of result.items) itemsById.set(item.id, item);
  }
  for (const fallback of fallbackRows) {
    for (const item of fallback.items) itemsById.set(item.id, item);
  }
  await mergeExpectedInventoryItems(context, requestBody.owner, expectedGroups, itemsById);
  return { ok: true, items: Array.from(itemsById.values()) };
}

async function fetchPendingProgramScope(
  context: ProviderContext,
  owner: string,
  scope: ReturnType<typeof listShopPendingOpenProgramScopes>[number],
): Promise<PendingOpenRecordCandidate[]> {
  const result = await heliusRpc<unknown>(context, scope.solanaCluster, 'getProgramAccounts', [
    scope.boxMinterProgramId,
    {
      commitment: 'confirmed',
      encoding: 'base64',
      filters: [
        { memcmp: { offset: 0, bytes: PENDING_OPEN_DISCRIMINATOR_BASE58 } },
        { memcmp: { offset: 8, bytes: owner } },
      ],
    },
  ]);
  if (!Array.isArray(result)) throw new ProviderFailure('unavailable');
  return result.map((entry) => decodePendingOpenRecordCandidate(entry, owner, scope));
}

async function fetchAssetBatch(
  context: ProviderContext,
  cluster: SolanaCluster,
  ids: string[],
  options: {
    assetBatchNotFoundIsRecoverable?: boolean;
    attemptTimeoutMs?: number;
    includeUnverifiedCollections?: boolean;
    inventoryCall?: boolean;
    maxAttempts?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Map<string, DasAsset>> {
  const { includeUnverifiedCollections = true, ...rpcOptions } = options;
  const byId = new Map<string, DasAsset>();
  for (let offset = 0; offset < ids.length; offset += HELIUS_BATCH_LIMIT) {
    const batchIds = ids.slice(offset, offset + HELIUS_BATCH_LIMIT);
    const requestedIds = new Set(batchIds);
    const result = await heliusRpc<unknown>(context, cluster, 'getAssetBatch', {
      ids: batchIds,
      ...(includeUnverifiedCollections ? { options: HELIUS_COLLECTION_GROUPING_OPTIONS } : {}),
    }, rpcOptions);
    if (!Array.isArray(result) || result.length > batchIds.length) {
      throw new ProviderFailure('unavailable');
    }
    for (const asset of result) {
      if (asset === null) continue;
      if (!asset || typeof asset !== 'object') throw new ProviderFailure('unavailable');
      const assetId = (asset as DasAsset).id;
      if (typeof assetId !== 'string' || !requestedIds.has(assetId) || byId.has(assetId)) {
        throw new ProviderFailure('unavailable');
      }
      byId.set(assetId, asset as DasAsset);
    }
  }
  return byId;
}

type ExpectedAssetGroup = {
  cluster: SolanaCluster;
  ids: string[];
};

function expectedAssetGroups(expectedAssetIds?: ShopExpectedAssetIds): ExpectedAssetGroup[] {
  if (!expectedAssetIds) return [];
  const groups: ExpectedAssetGroup[] = [];
  if (expectedAssetIds['mainnet-beta']?.length) {
    groups.push({ cluster: 'mainnet-beta', ids: expectedAssetIds['mainnet-beta'] });
  }
  if (expectedAssetIds.devnet?.length) groups.push({ cluster: 'devnet', ids: expectedAssetIds.devnet });
  return groups;
}

function recoveredExpectedInventoryItem(
  asset: DasAsset,
  owner: string,
  cluster: SolanaCluster,
): ShopInventoryItem | null {
  if (asset?.interface !== 'MplCoreAsset' || asset?.burnt !== false) return null;
  const assetOwner = asset?.ownership?.owner;
  if (typeof assetOwner !== 'string' || !isBase58Bytes(assetOwner, 32) || assetOwner !== owner) return null;
  const collectionMint = uniqueAssetGroupingCollectionMint(asset);
  if (!collectionMint) return null;
  const collectionIsRegistered = listShopCollectionQueryRuntimes(true).some((scope) =>
    scope.solanaCluster === cluster && scope.collectionMint === collectionMint);
  if (!collectionIsRegistered) return null;
  const item = transformShopInventoryItem(asset, cluster);
  if (!item) return null;
  const drop = shopDropById(item.dropId);
  if (
    !drop ||
    drop.solanaCluster !== cluster ||
    drop.collectionMint !== collectionMint
  ) return null;
  return compactInventoryItem(item);
}

async function fetchExpectedAssetGroup(
  context: ProviderContext,
  cluster: SolanaCluster,
  ids: string[],
  signal: AbortSignal,
): Promise<{ assetsById: Map<string, DasAsset>; failures: number }> {
  try {
    return {
      assetsById: await fetchAssetBatch(context, cluster, ids, {
        assetBatchNotFoundIsRecoverable: true,
        attemptTimeoutMs: context.dependencies.expectedAssetRecoveryTimeoutMs,
        includeUnverifiedCollections: false,
        inventoryCall: true,
        maxAttempts: 1,
        signal,
      }),
      failures: 0,
    };
  } catch (error) {
    if (context.signal.aborted) throw new ProviderFailure('deadline');
    if (error instanceof ProviderFailure && error.kind === 'asset-not-found' && ids.length > 1) {
      const midpoint = Math.floor(ids.length / 2);
      const left = await fetchExpectedAssetGroup(context, cluster, ids.slice(0, midpoint), signal);
      const right = await fetchExpectedAssetGroup(context, cluster, ids.slice(midpoint), signal);
      for (const [id, asset] of right.assetsById) left.assetsById.set(id, asset);
      return { assetsById: left.assetsById, failures: left.failures + right.failures };
    }
    return { assetsById: new Map(), failures: 1 };
  }
}

async function mergeExpectedInventoryItems(
  context: ProviderContext,
  owner: string,
  groups: ExpectedAssetGroup[],
  itemsById: Map<string, ShopInventoryItem>,
): Promise<void> {
  if (groups.length === 0) return;
  const recoveryScope = createAttemptScope(context.signal, context.dependencies.expectedAssetRecoveryTimeoutMs);
  try {
    const rows = await mapConcurrent(groups, PROVIDER_CONCURRENCY, async ({ cluster, ids }) => {
      const recovery = await fetchExpectedAssetGroup(context, cluster, ids, recoveryScope.signal);
      context.metrics.expectedAssetRecoveryFailures += recovery.failures;
      const items: ShopInventoryItem[] = [];
      for (const asset of recovery.assetsById.values()) {
        const item = recoveredExpectedInventoryItem(asset, owner, cluster);
        if (item) items.push(item);
      }
      return { items, rawAssets: recovery.assetsById.size };
    });
    if (context.signal.aborted) throw new ProviderFailure('deadline');
    for (const row of rows) {
      if (context.inventoryCandidates + row.rawAssets > context.dependencies.inventoryMaxCandidates) {
        context.metrics.expectedAssetRecoveryFailures += 1;
        continue;
      }
      context.inventoryCandidates += row.rawAssets;
      const nextItemsById = new Map(itemsById);
      let resolved = 0;
      for (const item of row.items) {
        if (!nextItemsById.has(item.id)) resolved += 1;
        nextItemsById.set(item.id, item);
      }
      const nextItems = Array.from(nextItemsById.values());
      if (
        nextItems.length > SHOP_API_MAX_RESPONSE_ITEMS ||
        utf8ByteLength(JSON.stringify({ ok: true, items: nextItems })) > context.dependencies.inventoryMaxResponseBodyBytes
      ) {
        context.metrics.expectedAssetRecoveryFailures += 1;
        continue;
      }
      itemsById.clear();
      for (const [id, item] of nextItemsById) itemsById.set(id, item);
      context.metrics.expectedAssetResolved += resolved;
    }
  } finally {
    recoveryScope.dispose();
  }
}

async function fetchPendingOpenBoxes(
  context: ProviderContext,
  requestBody: ShopPendingOpenBoxesRequest,
): Promise<ShopPendingOpenBoxesResponse> {
  const scopes = listShopPendingOpenProgramScopes(requestBody.includeDevnet === true);
  const rows = (await mapConcurrent(scopes, PROVIDER_CONCURRENCY, (scope) =>
    fetchPendingProgramScope(context, requestBody.owner, scope))).flat();
  const deduped = new Map<string, PendingOpenRecordCandidate>();
  for (const row of rows) {
    const key = `${row.solanaCluster}:${row.pendingPda}`;
    if (deduped.has(key)) throw new ProviderFailure('unavailable');
    deduped.set(key, row);
  }
  const records = Array.from(deduped.values());
  const unresolved = records.filter((entry) => resolvePendingOpenDropId(entry) === null && !entry.configPda);
  const assetsByCluster = new Map<SolanaCluster, Map<string, DasAsset>>();
  const unresolvedClusters = Array.from(new Set(unresolved.map((entry) => entry.solanaCluster)));
  await mapConcurrent(unresolvedClusters, PROVIDER_CONCURRENCY, async (cluster) => {
    const ids = Array.from(new Set(unresolved.filter((entry) => entry.solanaCluster === cluster).map((entry) => entry.boxAssetId)));
    assetsByCluster.set(cluster, await fetchAssetBatch(context, cluster, ids));
  });
  const items = records.flatMap((entry) => {
    const resolvedWithoutAsset = resolvePendingOpenDropId(entry);
    if (resolvedWithoutAsset) return [toShopPendingOpenBox(entry, resolvedWithoutAsset)];
    if (entry.configPda) return [];
    const asset = assetsByCluster.get(entry.solanaCluster)?.get(entry.boxAssetId);
    const dropId = resolvePendingOpenDropId(entry, asset);
    if (!dropId) return [];
    return [toShopPendingOpenBox(entry, dropId)];
  });
  items.sort((left, right) => Number(right.createdSlot || 0) - Number(left.createdSlot || 0));
  return { ok: true, items };
}

export function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(new ProviderFailure('deadline'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

const defaultDependencies: WorkerDependencies = {
  expectedAssetRecoveryTimeoutMs: EXPECTED_ASSET_RECOVERY_TIMEOUT_MS,
  firestoreFetch: (input, init) => fetch(input, init),
  firestoreTimeoutMs: FIRESTORE_PACK_STATUS_TIMEOUT_MS,
  providerFetch: (input, init) => fetch(input, init),
  providerTimeoutMs: HELIUS_OVERALL_TIMEOUT_MS,
  providerAttemptTimeoutMs: HELIUS_ATTEMPT_TIMEOUT_MS,
  providerMaxResponseBodyBytes: HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES,
  providerMaxTotalResponseBodyBytes: HELIUS_SEARCH_ASSETS_MAX_TOTAL_BYTES,
  inventoryMaxCandidates: HELIUS_SEARCH_ASSETS_MAX_CANDIDATES,
  inventoryMaxCursorPages: HELIUS_SEARCH_ASSETS_MAX_CURSOR_PAGES,
  inventoryMaxProviderCalls: HELIUS_SEARCH_ASSETS_MAX_PROVIDER_CALLS,
  inventoryMaxResponseBodyBytes: MAX_INVENTORY_RESPONSE_BODY_BYTES,
  randomUint32: () => crypto.getRandomValues(new Uint32Array(1))[0],
  sleep: sleepWithAbort,
  log: (entry) => console.log(entry),
  resendFetch: (input, init) => fetch(input, init),
  resendTimeoutMs: RESEND_TIMEOUT_MS,
  validateInventoryResponse: isExactShopInventoryResponse,
  validatePendingOpenBoxesResponse: isExactShopPendingOpenBoxesResponse,
};

function packStatusDropIdFromPathname(pathname: string): string | null | undefined {
  if (pathname !== '/pack-status' && !pathname.startsWith('/pack-status/')) return undefined;
  const match = pathname.match(/^\/pack-status\/([^/]+)$/);
  const dropId = match?.[1] || '';
  return isPackStatusRouteDropId(dropId) ? dropId : null;
}

async function handlePackStatus(
  dropId: string,
  dependencies: WorkerDependencies,
  metrics: WorkerRequestMetrics,
): Promise<{ response: Response; cacheStatus?: string }> {
  const startedAt = performance.now();
  metrics.upstreamCalls += 1;
  const result = await fetchFirestorePackStatus(
    dropId,
    dependencies.firestoreFetch,
    dependencies.firestoreTimeoutMs,
  );
  metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
  const response = result.ok
    ? jsonResponse({ ok: true, packStatus: result.packStatus }, 200)
    : jsonResponse({ ok: false, error: result.error }, result.error === 'provider-timeout' ? 504 : 502);
  return { response, ...(result.cacheStatus ? { cacheStatus: result.cacheStatus } : {}) };
}

async function handlePost(
  request: Request,
  env: Env,
  pathname: '/inventory' | '/pending-open-boxes',
  dependencies: WorkerDependencies,
  metrics: WorkerRequestMetrics,
): Promise<{ response: Response; includeDevnet: boolean }> {
  let parsedRequest:
    | { kind: 'inventory'; body: ShopInventoryRequest }
    | { kind: 'pending-open-boxes'; body: ShopPendingOpenBoxesRequest };
  try {
    parsedRequest = pathname === '/inventory'
      ? { kind: 'inventory', body: await parseShopRequestBody(request, isExactShopInventoryRequest) }
      : { kind: 'pending-open-boxes', body: await parseShopRequestBody(request, isExactShopPendingOpenBoxesRequest) };
  } catch {
    return { response: jsonResponse({ ok: false, error: 'invalid-request' }, 400), includeDevnet: false };
  }
  const requestBody = parsedRequest.body;
  const apiKey = typeof env.HELIUS_API_KEY === 'string' ? env.HELIUS_API_KEY.trim() : '';
  if (!apiKey) {
    return {
      response: jsonResponse({ ok: false, error: 'provider-unavailable' }, 502),
      includeDevnet: requestBody.includeDevnet === true,
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.providerTimeoutMs);
  const context: ProviderContext = {
    apiKey,
    signal: controller.signal,
    dependencies,
    metrics,
    providerResponseBodyBytes: 0,
    inventoryCandidates: 0,
    inventoryCursorPages: 0,
    inventoryProviderCalls: 0,
    providerReadGate: new ProviderReadGate(),
  };
  try {
    const body = parsedRequest.kind === 'inventory'
      ? await fetchInventory(context, parsedRequest.body)
      : await fetchPendingOpenBoxes(context, parsedRequest.body);
    const valid = parsedRequest.kind === 'inventory'
      ? dependencies.validateInventoryResponse(body)
      : dependencies.validatePendingOpenBoxesResponse(body);
    if (!valid) throw new ProviderFailure('unavailable');
    const text = JSON.stringify(body);
    if (
      pathname === '/inventory' &&
      utf8ByteLength(text) > dependencies.inventoryMaxResponseBodyBytes
    ) throw new ProviderFailure('limit');
    return {
      response: new Response(text, { status: 200, headers: BASE_HEADERS }),
      includeDevnet: requestBody.includeDevnet === true,
    };
  } catch (error) {
    controller.abort();
    const kind = error instanceof ProviderFailure ? error.kind : 'unavailable';
    return {
      response: jsonResponse(
        { ok: false, error: kind === 'timeout' || kind === 'deadline' ? 'provider-timeout' : 'provider-unavailable' },
        kind === 'timeout' || kind === 'deadline' ? 504 : 502,
      ),
      includeDevnet: requestBody.includeDevnet === true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleNotificationSubscription(
  request: Request,
  env: Env,
  dependencies: WorkerDependencies,
  metrics: WorkerRequestMetrics,
): Promise<Response> {
  let rawEmail: string;
  try {
    rawEmail = (await parseJsonRequestBody(
      request,
      isExactSubscribeToNotificationsRequest,
    )).email;
  } catch {
    return jsonResponse({ ok: false, error: 'invalid-request' }, 400);
  }
  const email = normalizeNotificationEmailRecipient(rawEmail);
  if (!email) return jsonResponse({ ok: false, error: 'invalid-email' }, 400);

  const apiKey = typeof env.RESEND_CONTACTS_API_KEY === 'string'
    ? env.RESEND_CONTACTS_API_KEY.trim()
    : '';
  if (!apiKey) return jsonResponse({ ok: false, error: 'provider-unavailable' }, 502);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Resend request timed out', 'TimeoutError')),
    dependencies.resendTimeoutMs,
  );
  const startedAt = performance.now();
  metrics.upstreamCalls += 1;
  try {
    const providerResponse = await dependencies.resendFetch(RESEND_CONTACTS_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, unsubscribed: false }),
      signal: controller.signal,
    });
    if (providerResponse.status === 409) {
      await cancelResponseBody(providerResponse);
      return jsonResponse({ subscribed: true }, 200);
    }
    if (!providerResponse.body) {
      await cancelResponseBody(providerResponse);
      return jsonResponse({ ok: false, error: 'provider-unavailable' }, 502);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readBoundedText(
        providerResponse.body,
        MAX_RESEND_RESPONSE_BODY_BYTES,
        () => new Error('provider-response-too-large'),
        undefined,
        controller.signal,
      ));
    } catch {
      return controller.signal.aborted
        ? jsonResponse({ ok: false, error: 'provider-timeout' }, 504)
        : jsonResponse({ ok: false, error: 'provider-unavailable' }, 502);
    }
    if (!providerResponse.ok) {
      return isExistingResendContactError(payload)
        ? jsonResponse({ subscribed: true }, 200)
        : jsonResponse({ ok: false, error: 'provider-unavailable' }, 502);
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload) ||
      typeof (payload as Record<string, unknown>).id !== 'string' ||
      !(payload as Record<string, unknown>).id
    ) {
      return jsonResponse({ ok: false, error: 'provider-unavailable' }, 502);
    }
    return jsonResponse({ subscribed: true }, 200);
  } catch {
    return controller.signal.aborted
      ? jsonResponse({ ok: false, error: 'provider-timeout' }, 504)
      : jsonResponse({ ok: false, error: 'provider-unavailable' }, 502);
  } finally {
    clearTimeout(timeout);
    metrics.providerDurationMs += performance.now() - startedAt;
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  dependencyOverrides: Partial<WorkerDependencies> = {},
): Promise<Response> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const startedAt = performance.now();
  const metrics: WorkerRequestMetrics = {
    upstreamCalls: 0,
    providerDurationMs: 0,
    expectedAssetIds: 0,
    expectedAssetRecoveryFailures: 0,
    expectedAssetResolved: 0,
  };
  const pathname = new URL(request.url).pathname;
  const packStatusDropId = packStatusDropIdFromPathname(pathname);
  const isPackStatusRoute = packStatusDropId !== undefined;
  let includeDevnet = false;
  let providerCacheStatus: string | undefined;
  let profileAuthOutcome: string | undefined;
  let profileStateSections: { profile: string; shipments: string } | undefined;
  let rpcMethod: string | undefined;
  let response: Response;
  const rpcCluster = pathname === '/rpc/mainnet-beta'
    ? 'mainnet-beta'
    : pathname === '/rpc/devnet' ? 'devnet' : null;
  const profilePath = PROFILE_READ_PATHS.has(pathname) ? pathname as ProfileReadPath : null;
  if (request.method === 'OPTIONS' && profilePath) {
    response = handleProfileCorsPreflight(request);
  } else if (request.method === 'OPTIONS' && rpcCluster) {
    response = handleRpcPreflight(request);
  } else if (request.method === 'OPTIONS' && (
    pathname === '/inventory' ||
    pathname === '/notifications/subscribe' ||
    pathname === '/pending-open-boxes' ||
    (isPackStatusRoute && packStatusDropId !== null)
  )) {
    response = new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', 'Timing-Allow-Origin': '*' } });
  } else if (isPackStatusRoute) {
    if (packStatusDropId === null) {
      response = jsonResponse({ ok: false, error: 'invalid-request' }, 400);
    } else if (request.method !== 'GET') {
      response = jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET, OPTIONS' });
    } else {
      const result = await handlePackStatus(packStatusDropId, dependencies, metrics);
      response = result.response;
      providerCacheStatus = result.cacheStatus;
    }
  } else if (pathname === '/health') {
    response = request.method === 'GET'
      ? jsonResponse({ ok: true }, 200)
      : jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET' });
  } else if (pathname === NOTIFICATION_ENQUEUE_PATH) {
    response = await handleNotificationEnqueue(request, env, { log: dependencies.log });
  } else if (profilePath) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleProfileReadRequest(request, env, profilePath);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      profileStateSections = result.profileStateSections;
      response = applyProfileCors(request, result.response);
    }
  } else if (rpcCluster) {
    if (request.method !== 'POST') {
      response = handleRpcMethodNotAllowed(request);
    } else {
      const result = await handleRpcPost(
        request,
        env,
        rpcCluster,
        dependencies,
        metrics,
      );
      response = result.response;
      rpcMethod = result.rpcMethod;
    }
  } else if (pathname === '/notifications/subscribe') {
    response = request.method === 'POST'
      ? await handleNotificationSubscription(request, env, dependencies, metrics)
      : jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'POST, OPTIONS' });
  } else if (pathname === '/inventory' || pathname === '/pending-open-boxes') {
    if (request.method !== 'POST') {
      response = jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'POST, OPTIONS' });
    } else {
      const result = await handlePost(request, env, pathname, dependencies, metrics);
      response = result.response;
      includeDevnet = result.includeDevnet;
    }
  } else {
    response = jsonResponse({ ok: false, error: 'not-found' }, 404);
  }
  const totalDurationMs = performance.now() - startedAt;
  response.headers.set('Server-Timing', `total;dur=${totalDurationMs.toFixed(1)}, provider;dur=${metrics.providerDurationMs.toFixed(1)}`);
  const logRoute = isPackStatusRoute ? '/pack-status/:dropId' : KNOWN_LOG_ROUTES.has(pathname) ? pathname : 'not-found';
  dependencies.log({
    event: 'shop_api_request',
    route: logRoute,
    method: request.method,
    status: response.status,
    durationMs: Math.round(totalDurationMs),
    providerDurationMs: Math.round(metrics.providerDurationMs),
    upstreamCalls: metrics.upstreamCalls,
    includeDevnet,
    ...(packStatusDropId ? { dropId: packStatusDropId } : {}),
    ...(providerCacheStatus ? { providerCacheStatus } : {}),
    ...(pathname === '/inventory' ? {
      expectedAssetIds: metrics.expectedAssetIds,
      expectedAssetRecoveryFailures: metrics.expectedAssetRecoveryFailures,
      expectedAssetResolved: metrics.expectedAssetResolved,
    } : {}),
    ...(rpcMethod ? { rpcMethod } : {}),
    ...(profileAuthOutcome ? { profileAuthOutcome } : {}),
    ...(profileStateSections ? { profileStateSections } : {}),
  });
  return response;
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
