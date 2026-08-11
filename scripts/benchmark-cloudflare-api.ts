import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isExactShopInventoryResponse,
  type ShopInventoryItem,
} from '../functions/src/shared/shopApi.ts';
import {
  listShopCollectionQueryRuntimes,
  shopDropById,
  transformShopInventoryItem,
} from '../functions/src/shared/shopDomain.ts';
import { HELIUS_COLLECTION_GROUPING_OPTIONS } from '../functions/src/shared/dasAssetCollections.ts';
import {
  HELIUS_SEARCH_ASSETS_MAX_CANDIDATES,
  HELIUS_SEARCH_ASSETS_MAX_CURSOR_PAGES,
  HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES,
  HELIUS_SEARCH_ASSETS_MAX_PROVIDER_CALLS,
  HELIUS_SEARCH_ASSETS_MAX_TOTAL_BYTES,
  HELIUS_SEARCH_ASSETS_PAGE_LIMITS,
  heliusSearchAssetsCursorPageInfo,
  heliusSearchAssetsItems,
} from '../functions/src/shared/heliusDas.ts';
import type { DasAsset } from '../functions/src/shared/dasAsset.ts';
import type { SolanaCluster } from '../functions/src/shared/deploymentCore.ts';
import { isBase58Bytes } from '../functions/src/shared/solanaRpcProxy.ts';

export type ApiBenchmarkOptions = {
  apiOrigin: string;
  includeDevnet?: boolean;
  owner: string;
  runs: number;
};

export type ApiBenchmarkResult = {
  runs: number;
  workerMedianMs: number;
  legacyMedianMs: number;
};

type ApiBenchmarkDependencies = {
  legacyInventory?: typeof legacyInventory;
  now?: () => number;
  workerInventory?: typeof workerInventory;
};

type BenchmarkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type InventoryNetworkDependencies = {
  clearTimer: (handle: unknown) => void;
  fetch: BenchmarkFetch;
  randomUint32: () => number;
  scheduleTimer: (callback: () => void, milliseconds: number) => unknown;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type LegacyInventoryContext = {
  apiKey: string;
  candidateCount: number;
  cursorPages: number;
  network: InventoryNetworkDependencies;
  overallSignal: AbortSignal;
  providerCalls: number;
  providerResponseBytes: number;
};

const HELIUS_ATTEMPT_TIMEOUT_MS = 15_000;
const LEGACY_INVENTORY_TIMEOUT_MS = 60_000;
const WORKER_INVENTORY_TIMEOUT_MS = 70_000;
const HELIUS_ID_ASCENDING_SORT = { sortBy: 'id', sortDirection: 'asc' } as const;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolvePromise();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      rejectPromise(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

const defaultInventoryNetworkDependencies: InventoryNetworkDependencies = {
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  fetch: (input, init) => fetch(input, init),
  randomUint32: () => Math.floor(Math.random() * 0x1_0000_0000),
  scheduleTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  sleep: sleepWithAbort,
};

export class ApiBenchmarkFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiBenchmarkFailure';
  }
}

type HeliusProviderFailureKind = 'attempt-timeout' | 'deadline' | 'limit' | 'response-too-large' | 'transient' | 'unavailable';

class HeliusProviderFailure extends ApiBenchmarkFailure {
  constructor(
    readonly kind: HeliusProviderFailureKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HeliusProviderFailure';
  }
}

function fail(message: string): never {
  throw new ApiBenchmarkFailure(message);
}

export function parseApiBenchmarkArgs(argv: string[]): ApiBenchmarkOptions {
  let apiOrigin = '';
  let includeDevnet = false;
  let owner = '';
  let runs = 5;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--include-devnet') {
      if (includeDevnet) fail('--include-devnet may only be provided once.');
      includeDevnet = true;
      continue;
    }
    const value = argv[index + 1];
    if (option !== '--api-origin' && option !== '--owner' && option !== '--runs') fail(`Unknown argument: ${option}`);
    if (!value || value.startsWith('--')) fail(`Missing value for ${option}`);
    index += 1;
    if (option === '--api-origin') apiOrigin = value.replace(/\/+$/, '');
    if (option === '--owner') owner = value;
    if (option === '--runs') runs = Number(value);
  }
  if (!apiOrigin) fail('--api-origin is required.');
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(apiOrigin);
  } catch {
    fail('--api-origin must be a valid HTTPS origin.');
  }
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== apiOrigin || parsedOrigin.pathname !== '/') {
    fail('--api-origin must be an HTTPS origin without a path.');
  }
  if (!isBase58Bytes(owner, 32)) fail('--owner must be a valid 32-byte Solana address.');
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) fail('--runs must be an integer from 1 through 10.');
  return { apiOrigin, includeDevnet, owner, runs };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function providerFail(kind: HeliusProviderFailureKind, message: string, retryAfterMs?: number): never {
  throw new HeliusProviderFailure(kind, message, retryAfterMs);
}

function createManagedTimeout(
  network: InventoryNetworkDependencies,
  milliseconds: number,
): { dispose: () => void; signal: AbortSignal; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  const handle = network.scheduleTimer(() => {
    didTimeOut = true;
    controller.abort();
  }, milliseconds);
  return {
    dispose: () => network.clearTimer(handle),
    signal: controller.signal,
    timedOut: () => didTimeOut,
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

function isTransientRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  if (
    typeof record.code === 'number' &&
    (record.code === 408 || record.code === 429 || record.code === -32005 || record.code === -32603)
  ) return true;
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  return /timeout|timed out|rate limit|temporar|overload|internal/.test(message);
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(1000, seconds * 1000) : undefined;
}

function retryDelayMs(context: LegacyInventoryContext, failure: HeliusProviderFailure): number {
  return failure.retryAfterMs ?? 100 + (context.network.randomUint32() % 151);
}

async function readBoundedJsonResponse(
  context: LegacyInventoryContext,
  response: Response,
  method: string,
): Promise<unknown> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES) {
    await cancelResponseBody(response);
    providerFail('response-too-large', `Helius ${method} response exceeded its page data budget.`);
  }
  if (
    Number.isFinite(contentLength) &&
    context.providerResponseBytes + contentLength > HELIUS_SEARCH_ASSETS_MAX_TOTAL_BYTES
  ) {
    await cancelResponseBody(response);
    providerFail('limit', `Helius ${method} response exceeded its cumulative data budget.`);
  }
  if (!response.body) providerFail('unavailable', `Helius ${method} returned an empty body.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let pageBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pageBytes += value.byteLength;
      context.providerResponseBytes += value.byteLength;
      if (context.providerResponseBytes > HELIUS_SEARCH_ASSETS_MAX_TOTAL_BYTES) {
        providerFail('limit', `Helius ${method} response exceeded its cumulative data budget.`);
      }
      if (pageBytes > HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES) {
        providerFail('response-too-large', `Helius ${method} response exceeded its page data budget.`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof HeliusProviderFailure) throw error;
    providerFail('unavailable', `Helius ${method} response could not be read.`);
  }
  try {
    return JSON.parse(chunks.join(''));
  } catch {
    providerFail('unavailable', `Helius ${method} returned invalid JSON.`);
  }
}

async function heliusRpcAttempt(
  context: LegacyInventoryContext,
  cluster: SolanaCluster,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (context.overallSignal.aborted) {
    providerFail('deadline', 'Legacy direct inventory exceeded its overall deadline.');
  }
  if (context.providerCalls >= HELIUS_SEARCH_ASSETS_MAX_PROVIDER_CALLS) {
    providerFail('limit', 'Legacy direct inventory exceeded its provider-call bound.');
  }
  context.providerCalls += 1;
  const attemptTimeout = createManagedTimeout(context.network, HELIUS_ATTEMPT_TIMEOUT_MS);
  const requestId = `${method}-${context.providerCalls}`;
  const subdomain = cluster === 'mainnet-beta' ? 'mainnet' : cluster;
  try {
    const response = await context.network.fetch(
      `https://${subdomain}.helius-rpc.com/?api-key=${encodeURIComponent(context.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.any([context.overallSignal, attemptTimeout.signal]),
      },
    );
    if (!response.ok) {
      const transient = TRANSIENT_HTTP_STATUSES.has(response.status);
      const retryAfter = retryAfterMs(response);
      await cancelResponseBody(response);
      providerFail(
        transient ? 'transient' : 'unavailable',
        `Helius ${method} failed with status ${response.status}.`,
        retryAfter,
      );
    }
    const payload = await readBoundedJsonResponse(context, response, method);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      providerFail('unavailable', `Helius ${method} returned an invalid response.`);
    }
    const rpc = payload as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
    if (rpc.jsonrpc !== '2.0' || rpc.id !== requestId) {
      providerFail('unavailable', `Helius ${method} returned an invalid response envelope.`);
    }
    if (rpc.error) {
      providerFail(
        isTransientRpcError(rpc.error) ? 'transient' : 'unavailable',
        typeof (rpc.error as { message?: unknown }).message === 'string'
          ? String((rpc.error as { message: string }).message)
          : `Helius ${method} failed.`,
      );
    }
    if (!Object.hasOwn(rpc, 'result')) {
      providerFail('unavailable', `Helius ${method} returned an invalid response envelope.`);
    }
    return rpc.result;
  } catch (error) {
    if (context.overallSignal.aborted) {
      providerFail('deadline', 'Legacy direct inventory exceeded its overall deadline.');
    }
    if (attemptTimeout.timedOut()) {
      providerFail('attempt-timeout', `Helius ${method} attempt timed out.`);
    }
    if (error instanceof HeliusProviderFailure) throw error;
    providerFail('transient', `Helius ${method} request failed.`);
  } finally {
    attemptTimeout.dispose();
  }
}

async function heliusRpc(
  context: LegacyInventoryContext,
  cluster: SolanaCluster,
  method: string,
  params: unknown,
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await heliusRpcAttempt(context, cluster, method, params);
    } catch (error) {
      if (!(error instanceof HeliusProviderFailure)) throw error;
      if (
        attempt === 0 &&
        (error.kind === 'transient' || error.kind === 'attempt-timeout') &&
        !context.overallSignal.aborted
      ) {
        if (error.kind === 'transient') {
          try {
            await context.network.sleep(retryDelayMs(context, error), context.overallSignal);
          } catch {
            if (context.overallSignal.aborted) {
              providerFail('deadline', 'Legacy direct inventory exceeded its overall deadline.');
            }
            providerFail('unavailable', 'Legacy direct inventory retry delay failed.');
          }
        }
        continue;
      }
      throw error;
    }
  }
  providerFail('unavailable', `Helius ${method} failed.`);
}

function parseSearchAssetsResult(value: unknown): { raw: unknown; items: DasAsset[] } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) {
    providerFail('unavailable', 'Helius searchAssets returned an invalid result.');
  }
  return { raw: value, items: heliusSearchAssetsItems<DasAsset>(value) };
}

function compactInventoryPage(
  context: LegacyInventoryContext,
  assets: DasAsset[],
  cluster: SolanaCluster,
  seenIds: Set<string>,
): ShopInventoryItem[] {
  context.candidateCount += assets.length;
  if (context.candidateCount > HELIUS_SEARCH_ASSETS_MAX_CANDIDATES) {
    fail('Legacy direct inventory exceeded its candidate bound.');
  }
  const items: ShopInventoryItem[] = [];
  for (const asset of assets) {
    if (!isBase58Bytes(asset?.id, 32) || seenIds.has(asset.id)) {
      fail('Legacy direct inventory returned invalid or duplicate paginated assets.');
    }
    seenIds.add(asset.id);
    const item = transformShopInventoryItem(asset, cluster);
    if (!item) continue;
    const drop = shopDropById(item.dropId);
    if (drop?.solanaCluster === cluster) items.push(item);
  }
  return items;
}

async function fetchCursorInventory(
  context: LegacyInventoryContext,
  owner: string,
  cluster: SolanaCluster,
  grouping?: readonly ['collection', string],
  allowFirstProviderFailure = false,
): Promise<ShopInventoryItem[] | undefined> {
  const items: ShopInventoryItem[] = [];
  const seenAssetIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageLimitIndex = 0;
  let cursorPage = 1;
  let hasPageReservation = false;
  while (true) {
    if (!hasPageReservation) {
      if (context.cursorPages >= HELIUS_SEARCH_ASSETS_MAX_CURSOR_PAGES) {
        fail('Legacy direct inventory exceeded its pagination bound.');
      }
      context.cursorPages += 1;
      hasPageReservation = true;
    }
    let rawResult: unknown;
    while (true) {
      const pageLimit = HELIUS_SEARCH_ASSETS_PAGE_LIMITS[pageLimitIndex];
      try {
        rawResult = await heliusRpc(context, cluster, 'searchAssets', {
          ownerAddress: owner,
          ...(grouping ? { grouping } : {}),
          tokenType: 'nonFungible',
          limit: pageLimit,
          sortBy: HELIUS_ID_ASCENDING_SORT,
          ...(cursor ? { cursor } : {}),
          burnt: false,
          options: HELIUS_COLLECTION_GROUPING_OPTIONS,
        });
        break;
      } catch (error) {
        if (
          error instanceof HeliusProviderFailure &&
          error.kind === 'response-too-large' &&
          pageLimitIndex + 1 < HELIUS_SEARCH_ASSETS_PAGE_LIMITS.length
        ) {
          pageLimitIndex += 1;
          continue;
        }
        if (
          cursorPage === 1 &&
          allowFirstProviderFailure &&
          error instanceof HeliusProviderFailure &&
          error.kind !== 'deadline' &&
          error.kind !== 'limit' &&
          !context.overallSignal.aborted
        ) return undefined;
        throw error;
      }
    }
    const result = parseSearchAssetsResult(rawResult);
    items.push(...compactInventoryPage(context, result.items, cluster, seenAssetIds));
    let pageInfo: ReturnType<typeof heliusSearchAssetsCursorPageInfo>;
    try {
      pageInfo = heliusSearchAssetsCursorPageInfo(
        result.raw,
        result.items.length,
        HELIUS_SEARCH_ASSETS_PAGE_LIMITS[pageLimitIndex],
        seenCursors,
      );
    } catch {
      fail('Legacy direct inventory returned inconsistent cursor metadata.');
    }
    if (!pageInfo.hasMore) return items;
    seenCursors.add(pageInfo.cursor);
    cursor = pageInfo.cursor;
    cursorPage += 1;
    hasPageReservation = false;
  }
}

async function legacyInventory(
  apiKey: string,
  owner: string,
  networkOverrides: Partial<InventoryNetworkDependencies> = {},
  includeDevnet = false,
): Promise<ShopInventoryItem[]> {
  const network = { ...defaultInventoryNetworkDependencies, ...networkOverrides };
  const overallTimeout = createManagedTimeout(network, LEGACY_INVENTORY_TIMEOUT_MS);
  const context: LegacyInventoryContext = {
    apiKey,
    candidateCount: 0,
    cursorPages: 0,
    network,
    overallSignal: overallTimeout.signal,
    providerCalls: 0,
    providerResponseBytes: 0,
  };
  try {
    const itemsById = new Map<string, ShopInventoryItem>();
    const fallbackClusters = new Set<SolanaCluster>();
    for (const scope of listShopCollectionQueryRuntimes(includeDevnet)) {
      const grouped = await fetchCursorInventory(
        context,
        owner,
        scope.solanaCluster,
        ['collection', scope.collectionMint],
        true,
      );
      if (grouped === undefined) {
        fallbackClusters.add(scope.solanaCluster);
        continue;
      }
      for (const item of grouped) itemsById.set(item.id, item);
    }
    for (const cluster of fallbackClusters) {
      const fallback = await fetchCursorInventory(context, owner, cluster);
      if (fallback === undefined) fail('Legacy direct inventory fallback failed.');
      for (const item of fallback) itemsById.set(item.id, item);
    }
    return Array.from(itemsById.values());
  } finally {
    overallTimeout.dispose();
  }
}

async function workerInventory(
  apiOrigin: string,
  owner: string,
  networkOverrides: Partial<InventoryNetworkDependencies> = {},
  includeDevnet = false,
): Promise<ShopInventoryItem[]> {
  const network = { ...defaultInventoryNetworkDependencies, ...networkOverrides };
  const requestTimeout = createManagedTimeout(network, WORKER_INVENTORY_TIMEOUT_MS);
  try {
    const response = await network.fetch(`${apiOrigin}/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(includeDevnet ? { owner, includeDevnet: true } : { owner }),
      cache: 'no-store',
      signal: requestTimeout.signal,
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isExactShopInventoryResponse(payload)) fail(`Worker inventory returned ${response.status} or an invalid body.`);
    return payload.items;
  } finally {
    requestTimeout.dispose();
  }
}

function itemIds(items: ShopInventoryItem[]): string[] {
  return items.map((item) => item.id).sort();
}

export async function benchmarkApi(
  options: ApiBenchmarkOptions,
  apiKeyValue: string,
  dependencies: ApiBenchmarkDependencies = {},
): Promise<ApiBenchmarkResult> {
  const apiKey = apiKeyValue.trim();
  if (!apiKey) fail('HELIUS_API_KEY is required in the invoking shell.');
  const loadLegacyInventory = dependencies.legacyInventory || legacyInventory;
  const loadWorkerInventory = dependencies.workerInventory || workerInventory;
  const now = dependencies.now || (() => performance.now());
  const includeDevnet = options.includeDevnet === true;
  const workerDurations: number[] = [];
  const legacyDurations: number[] = [];
  const warmWorker = await loadWorkerInventory(options.apiOrigin, options.owner, {}, includeDevnet);
  const warmLegacy = await loadLegacyInventory(apiKey, options.owner, {}, includeDevnet);
  if (JSON.stringify(itemIds(warmWorker)) !== JSON.stringify(itemIds(warmLegacy))) {
    fail('Inventory IDs differed during benchmark warmup.');
  }
  for (let index = 0; index < options.runs; index += 1) {
    const measureWorker = async (): Promise<ShopInventoryItem[]> => {
      const startedAt = now();
      const items = await loadWorkerInventory(options.apiOrigin, options.owner, {}, includeDevnet);
      workerDurations.push(now() - startedAt);
      return items;
    };
    const measureLegacy = async (): Promise<ShopInventoryItem[]> => {
      const startedAt = now();
      const items = await loadLegacyInventory(apiKey, options.owner, {}, includeDevnet);
      legacyDurations.push(now() - startedAt);
      return items;
    };
    let worker: ShopInventoryItem[];
    let legacy: ShopInventoryItem[];
    if (index % 2 === 0) {
      worker = await measureWorker();
      legacy = await measureLegacy();
    } else {
      legacy = await measureLegacy();
      worker = await measureWorker();
    }
    if (JSON.stringify(itemIds(worker)) !== JSON.stringify(itemIds(legacy))) {
      fail(`Inventory IDs differed on comparison ${index + 1}.`);
    }
  }
  const workerMedian = median(workerDurations);
  const legacyMedian = median(legacyDurations);
  console.log(`[api-benchmark] Matching IDs across ${options.runs} comparisons.`);
  console.log(`[api-benchmark] Worker median: ${Math.round(workerMedian)}ms`);
  console.log(`[api-benchmark] Legacy median: ${Math.round(legacyMedian)}ms`);
  if (workerMedian >= legacyMedian) fail('Worker median was not lower than the legacy direct median.');
  return { runs: options.runs, workerMedianMs: workerMedian, legacyMedianMs: legacyMedian };
}

export const benchmarkApiTestHooks = {
  heliusAttemptTimeoutMs: HELIUS_ATTEMPT_TIMEOUT_MS,
  legacyInventory,
  legacyInventoryTimeoutMs: LEGACY_INVENTORY_TIMEOUT_MS,
  pageLimits: HELIUS_SEARCH_ASSETS_PAGE_LIMITS,
  workerInventory,
  workerInventoryTimeoutMs: WORKER_INVENTORY_TIMEOUT_MS,
};

async function main(): Promise<void> {
  const options = parseApiBenchmarkArgs(process.argv.slice(2));
  await benchmarkApi(options, String(process.env.HELIUS_API_KEY || ''));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[api-benchmark] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
