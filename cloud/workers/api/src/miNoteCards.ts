import {
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESSES,
  MI_NOTE_CARDS_API_PATH,
  isExactMiNoteCardsResponseV2,
  miNoteAddressFromSearch,
  normalizeMiNoteAddress,
  type MiNoteCardsResponse,
  type MiNoteCardsResponseV2,
  type MiNoteContractAddress,
  type MiNoteTokenIdsByContract,
} from '../../../../shared/miNoteCards.js';
import {
  createRequestDeadline,
  isRequestCancellationError,
  raceWithSignal,
} from './boundedRequest.js';
import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import { registerDeferredWork, type DeferredWork } from './deferredWork.js';
import { jsonResponse } from './httpResponse.js';
import {
  PUBLIC_RATE_LIMITS,
  applyPublicCors,
  observePublicRateLimit,
  publicRequestOrigin,
} from './publicRequestPolicy.js';
import type { WorkerDependencies, WorkerRequestMetrics } from './workerPublicRoutes.js';

const MAX_PAGE_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const MAX_UINT256 = (1n << 256n) - 1n;
const CACHE_TTL_MS = 60_000;
const CACHE_EXPIRY_HEADER = 'X-Mi-Note-Cards-Expires-At';

type MiNoteCardsDependencies = Pick<WorkerDependencies, 'cache' | 'providerFetch' | 'log'> & {
  timeoutMs?: number;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uint256(value: unknown): bigint | null {
  if (
    typeof value !== 'string' || value.length > 78 ||
    !/^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value)
  ) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_UINT256 ? parsed : null;
}

function providerFailure(): Error {
  return new Error('Mi note ownership provider unavailable');
}

function logEvent(dependencies: MiNoteCardsDependencies, event: string): void {
  try {
    dependencies.log({ event, route: MI_NOTE_CARDS_API_PATH });
  } catch {}
}

async function responseWithSignal(
  operation: Promise<Response | undefined>,
  signal: AbortSignal,
): Promise<Response | undefined> {
  return raceWithSignal(operation.then(async (response) => {
    if (response && signal.aborted) {
      await cancelResponseBody(response);
      throw signal.reason;
    }
    return response;
  }), signal);
}

async function readCachedOwnership(
  cacheRequest: Request,
  dependencies: MiNoteCardsDependencies,
  signal: AbortSignal,
  now: () => number,
): Promise<MiNoteCardsResponseV2 | null> {
  if (!dependencies.cache) return null;
  try {
    const cached = await responseWithSignal(dependencies.cache.match(cacheRequest), signal);
    if (!cached) return null;
    const expiresAt = Number(cached.headers.get(CACHE_EXPIRY_HEADER));
    const currentTime = now();
    if (
      cached.status !== 200 || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= currentTime || expiresAt > currentTime + CACHE_TTL_MS
    ) {
      await cancelResponseBody(cached);
      return null;
    }
    const body = await readBoundedResponseJson(cached, {
      maxBytes: MAX_CACHE_BYTES,
      contentType: 'require-json',
      signal,
      createError: providerFailure,
    });
    if (expiresAt <= now()) return null;
    if (isExactMiNoteCardsResponseV2(body)) return body;
    logEvent(dependencies, 'mi_note_cards_cache_invalid');
  } catch {
    if (signal.aborted) throw signal.reason;
    logEvent(dependencies, 'mi_note_cards_cache_read_failed');
  }
  return null;
}

async function fetchOwnership(
  address: string,
  apiKey: string,
  dependencies: MiNoteCardsDependencies,
  metrics: WorkerRequestMetrics,
  signal: AbortSignal,
): Promise<MiNoteCardsResponseV2> {
  const tokenIds: Record<MiNoteContractAddress, Set<string>> = {
    [MI_NOTE_2_CONTRACT_ADDRESS]: new Set(),
    [MI_NOTE_3_CONTRACT_ADDRESS]: new Set(),
  };
  const pageKeys = new Set<string>();
  let pageKey: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (signal.aborted) throw signal.reason;
    const url = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${encodeURIComponent(apiKey)}/getNFTsForOwner`);
    url.searchParams.set('owner', address);
    for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
      url.searchParams.append('contractAddresses[]', contract);
    }
    url.searchParams.set('withMetadata', 'false');
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (pageKey) url.searchParams.set('pageKey', pageKey);
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    let body: unknown;
    try {
      const response = await responseWithSignal(dependencies.providerFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal,
      }), signal);
      if (!response) throw providerFailure();
      if (!response.ok) {
        await cancelResponseBody(response);
        throw providerFailure();
      }
      body = await readBoundedResponseJson(response, {
        maxBytes: MAX_PAGE_BYTES,
        contentType: 'require-json',
        signal,
        createError: providerFailure,
      });
    } finally {
      metrics.providerDurationMs += performance.now() - startedAt;
    }
    if (!isRecord(body) || !Array.isArray(body.ownedNfts) || body.ownedNfts.length > PAGE_SIZE) {
      throw providerFailure();
    }
    for (const nft of body.ownedNfts) {
      if (!isRecord(nft)) throw providerFailure();
      const contract = normalizeMiNoteAddress(nft.contractAddress);
      if (contract !== MI_NOTE_2_CONTRACT_ADDRESS && contract !== MI_NOTE_3_CONTRACT_ADDRESS) {
        throw providerFailure();
      }
      const tokenId = uint256(nft.tokenId);
      const balance = uint256(nft.balance);
      if (tokenId === null || balance === null) throw providerFailure();
      if (balance > 0n) tokenIds[contract].add(tokenId.toString());
    }
    if (body.pageKey === null || body.pageKey === undefined) {
      const tokenIdsByContract: MiNoteTokenIdsByContract = {
        [MI_NOTE_2_CONTRACT_ADDRESS]: [],
        [MI_NOTE_3_CONTRACT_ADDRESS]: [],
      };
      for (const contract of MI_NOTE_CONTRACT_ADDRESSES) {
        tokenIdsByContract[contract] = [...tokenIds[contract]].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
      }
      const result: MiNoteCardsResponseV2 = { ok: true, tokenIdsByContract };
      if (!isExactMiNoteCardsResponseV2(result)) throw providerFailure();
      return result;
    }
    if (
      typeof body.pageKey !== 'string' || body.pageKey.length === 0 ||
      body.pageKey.length > 4096 || pageKeys.has(body.pageKey)
    ) throw providerFailure();
    pageKeys.add(body.pageKey);
    pageKey = body.pageKey;
  }
  throw providerFailure();
}

export async function handleMiNoteCards(
  request: Request,
  env: Pick<Env, 'ALCHEMY_MI_NOTE_API_KEY' | 'PUBLIC_SHOP_RATE_LIMITER'>,
  dependencies: MiNoteCardsDependencies,
  metrics: WorkerRequestMetrics,
  defer: DeferredWork,
): Promise<{ response: Response; cacheStatus?: string }> {
  const origin = publicRequestOrigin(request);
  const result = (response: Response, cacheStatus?: string) => ({
    response: origin ? applyPublicCors(response, origin, 'GET, OPTIONS') : response,
    ...(cacheStatus ? { cacheStatus } : {}),
  });
  if (!origin) return result(jsonResponse({ ok: false, error: 'origin-not-allowed' }, 403));
  const url = new URL(request.url);
  const { address } = miNoteAddressFromSearch(url.search);
  const versions = url.searchParams.getAll('version');
  if (!address || (versions.length > 0 && (versions.length !== 1 || versions[0] !== '2'))) {
    return result(jsonResponse({ ok: false, error: 'invalid-request' }, 400));
  }
  const ownershipResponse = (body: MiNoteCardsResponseV2) => {
    const payload: MiNoteCardsResponse | MiNoteCardsResponseV2 = versions.length === 0
      ? { ok: true, tokenIds: body.tokenIdsByContract[MI_NOTE_2_CONTRACT_ADDRESS] }
      : body;
    return jsonResponse(payload, 200);
  };
  const now = dependencies.now ?? Date.now;
  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.timeoutMs ?? 30_000,
    timeoutMessage: 'Mi note ownership request timed out',
  });
  let cacheWrite: Promise<void> | undefined;
  let body: MiNoteCardsResponseV2;
  try {
    await raceWithSignal(observePublicRateLimit({
      binding: env.PUBLIC_SHOP_RATE_LIMITER,
      keyScope: MI_NOTE_CARDS_API_PATH,
      limit: PUBLIC_RATE_LIMITS.shop,
      log: dependencies.log,
      request,
      route: MI_NOTE_CARDS_API_PATH,
    }), deadline.signal);
    const cacheUrl = new URL(MI_NOTE_CARDS_API_PATH, url.origin);
    cacheUrl.searchParams.set('address', address);
    cacheUrl.searchParams.set('version', '2');
    const cacheRequest = new Request(cacheUrl);
    const cached = await readCachedOwnership(cacheRequest, dependencies, deadline.signal, now);
    if (cached) return result(ownershipResponse(cached), 'HIT');
    const apiKey = typeof env.ALCHEMY_MI_NOTE_API_KEY === 'string' ? env.ALCHEMY_MI_NOTE_API_KEY.trim() : '';
    if (!apiKey) throw providerFailure();
    body = await fetchOwnership(address, apiKey, dependencies, metrics, deadline.signal);
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (dependencies.cache) {
      const cache = dependencies.cache;
      const cacheResponse = jsonResponse(body, 200, {
        headers: {
          'Cache-Control': `public, max-age=${CACHE_TTL_MS / 1000}`,
          [CACHE_EXPIRY_HEADER]: String(now() + CACHE_TTL_MS),
        },
      });
      cacheWrite = Promise.resolve().then(() => cache.put(cacheRequest, cacheResponse)).catch(() => {
        logEvent(dependencies, 'mi_note_cards_cache_write_failed');
      });
    }
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    const timedOut = deadline.timedOut();
    logEvent(dependencies, timedOut ? 'mi_note_cards_provider_timeout' : 'mi_note_cards_provider_unavailable');
    return result(jsonResponse({
      ok: false,
      error: timedOut ? 'provider-timeout' : 'provider-unavailable',
    }, timedOut ? 504 : 502));
  } finally {
    deadline.dispose();
  }
  if (cacheWrite) {
    try {
      registerDeferredWork(defer, cacheWrite);
    } catch {
      logEvent(dependencies, 'mi_note_cards_cache_registration_failed');
    }
  }
  return result(ownershipResponse(body), 'MISS');
}
