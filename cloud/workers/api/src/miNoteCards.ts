import {
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESSES,
  MI_NOTE_CARDS_API_PATH,
  MAX_MI_NOTE_TOKEN_IDS,
  isCanonicalMiNoteTokenIds,
  isExactMiNoteCardsResponse,
  miNoteAddressFromSearch,
  type MiNoteCardsProvider,
  type MiNoteCardsResponse,
  type MiNoteContractAddress,
  type MiNoteTokenIdsByContract,
} from '../../../../shared/miNoteCards.js';
import { createRequestDeadline, raceWithSignal, type RequestDeadline } from './boundedRequest.js';
import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import { registerDeferredWork, type DeferredWork } from './deferredWork.js';
import { jsonResponse } from './httpResponse.js';
import {
  fetchAlchemyMiNotes,
  fetchOpenSeaMiNotes,
  miNoteProviderFailure,
  miNoteResponseWithSignal,
} from './miNoteOwnership.js';
import {
  PUBLIC_RATE_LIMITS,
  applyPublicCors,
  observePublicRateLimit,
  publicRequestOrigin,
} from './publicRequestPolicy.js';
import type { WorkerDependencies, WorkerRequestMetrics } from './publicRouteSupport.js';

const MAX_CACHE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 60_000;
const CACHE_EXPIRY_HEADER = 'X-Mi-Note-Cards-Expires-At';

type MiNoteCardsDependencies = Pick<WorkerDependencies, 'cache' | 'providerFetch' | 'log'> & {
  timeoutMs?: number;
  now?: () => number;
};
type MiNoteCardsEnv = Pick<Env, 'ALCHEMY_MI_NOTE_API_KEY' | 'OPENSEA_API_KEY' | 'PUBLIC_SHOP_RATE_LIMITER'>;
type CollectionOwnership = {
  contractAddress: MiNoteContractAddress;
  tokenIds: string[];
  provider: MiNoteCardsProvider;
  visibilityLimited: boolean;
};

function logEvent(dependencies: MiNoteCardsDependencies, event: string, fields: Record<string, unknown> = {}): void {
  try {
    dependencies.log({ event, route: MI_NOTE_CARDS_API_PATH, ...fields });
  } catch {}
}

function deferWork(defer: DeferredWork, promise: Promise<unknown>, dependencies: MiNoteCardsDependencies): void {
  try {
    registerDeferredWork(defer, promise);
  } catch {
    logEvent(dependencies, 'mi_note_cards_cache_registration_failed');
  }
}

function collectionProvider(contract: MiNoteContractAddress): MiNoteCardsProvider {
  return contract === MI_NOTE_CONTRACT_ADDRESS ? 'opensea' : 'alchemy';
}

function isCachedOwnership(value: unknown, contract: MiNoteContractAddress): value is CollectionOwnership {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 4 && body.contractAddress === contract &&
    body.provider === collectionProvider(contract) && body.visibilityLimited === (contract === MI_NOTE_CONTRACT_ADDRESS) &&
    isCanonicalMiNoteTokenIds(body.tokenIds);
}

async function readCachedOwnership(
  cacheRequest: Request,
  contract: MiNoteContractAddress,
  dependencies: MiNoteCardsDependencies,
  signal: AbortSignal,
  now: () => number,
): Promise<CollectionOwnership | null> {
  if (!dependencies.cache) return null;
  try {
    const cached = await miNoteResponseWithSignal(dependencies.cache.match(cacheRequest), signal);
    if (!cached) return null;
    const expiresAt = Number(cached.headers.get(CACHE_EXPIRY_HEADER));
    const currentTime = now();
    if (cached.status !== 200 || !Number.isSafeInteger(expiresAt) || expiresAt <= currentTime || expiresAt > currentTime + CACHE_TTL_MS) {
      await cancelResponseBody(cached);
      return null;
    }
    const body = await readBoundedResponseJson(cached, {
      maxBytes: MAX_CACHE_BYTES, contentType: 'require-json', signal, createError: miNoteProviderFailure,
    });
    if (expiresAt <= now()) return null;
    if (isCachedOwnership(body, contract)) return body;
    logEvent(dependencies, 'mi_note_cards_cache_invalid');
  } catch {
    if (signal.aborted) throw signal.reason;
    logEvent(dependencies, 'mi_note_cards_cache_read_failed');
  }
  return null;
}

async function collectOwnership(args: {
  request: Request;
  address: string;
  env: MiNoteCardsEnv;
  dependencies: MiNoteCardsDependencies;
  metrics: WorkerRequestMetrics;
  deadline: RequestDeadline;
  defer: DeferredWork;
}): Promise<{ body: MiNoteCardsResponse; cacheStatus: string; successes: number }> {
  const { request, address, env, dependencies, metrics, deadline, defer } = args;
  const now = dependencies.now ?? Date.now;
  const alchemyKey = typeof env.ALCHEMY_MI_NOTE_API_KEY === 'string' ? env.ALCHEMY_MI_NOTE_API_KEY.trim() : '';
  const openSeaKey = typeof env.OPENSEA_API_KEY === 'string' ? env.OPENSEA_API_KEY.trim() : '';
  let modern: Promise<Map<MiNoteContractAddress, string[]>> | undefined;
  let successes = 0;
  let cacheHits = 0;
  let totalIds = 0;
  const tokenIdsByContract: MiNoteTokenIdsByContract = {
    [MI_NOTE_3_CONTRACT_ADDRESS]: [],
    [MI_NOTE_2_CONTRACT_ADDRESS]: [],
    [MI_NOTE_CONTRACT_ADDRESS]: [],
  };
  const resultsByContract = {} as MiNoteCardsResponse['resultsByContract'];
  const fetchCollection = (contract: MiNoteContractAddress): Promise<string[]> => {
    const context = { providerFetch: dependencies.providerFetch, metrics, signal: deadline.signal };
    if (contract === MI_NOTE_CONTRACT_ADDRESS) return fetchOpenSeaMiNotes(address, openSeaKey, context);
    modern ??= fetchAlchemyMiNotes(address, alchemyKey, context);
    return modern.then((groups) => groups.get(contract)!);
  };
  await Promise.all(MI_NOTE_CONTRACT_ADDRESSES.map(async (contract) => {
    const cacheUrl = new URL(MI_NOTE_CARDS_API_PATH, request.url);
    cacheUrl.searchParams.set('address', address);
    cacheUrl.searchParams.set('contract', contract);
    cacheUrl.searchParams.set('version', '4');
    const cacheRequest = new Request(cacheUrl);
    try {
      const cached = await readCachedOwnership(cacheRequest, contract, dependencies, deadline.signal, now);
      const ownership: CollectionOwnership = cached ?? {
        contractAddress: contract,
        tokenIds: await fetchCollection(contract),
        provider: collectionProvider(contract),
        visibilityLimited: contract === MI_NOTE_CONTRACT_ADDRESS,
      };
      if (deadline.signal.aborted) throw deadline.signal.reason;
      if (totalIds + ownership.tokenIds.length > MAX_MI_NOTE_TOKEN_IDS) throw miNoteProviderFailure();
      totalIds += ownership.tokenIds.length;
      successes += 1;
      if (cached) cacheHits += 1;
      tokenIdsByContract[contract] = ownership.tokenIds;
      resultsByContract[contract] = { status: 'success', provider: ownership.provider, visibilityLimited: ownership.visibilityLimited };
      if (!cached && dependencies.cache) {
        const cache = dependencies.cache;
        const cacheResponse = jsonResponse(ownership, 200, { headers: {
          'Cache-Control': `public, max-age=${CACHE_TTL_MS / 1000}`,
          [CACHE_EXPIRY_HEADER]: String(now() + CACHE_TTL_MS),
        } });
        const write = Promise.resolve().then(() => cache.put(cacheRequest, cacheResponse)).catch(() => {
          logEvent(dependencies, 'mi_note_cards_cache_write_failed');
        });
        deferWork(defer, write, dependencies);
      }
    } catch {
      if (deadline.clientAborted()) throw deadline.signal.reason;
      const error = deadline.timedOut() ? 'provider-timeout' : 'provider-unavailable';
      resultsByContract[contract] = { status: 'error', error };
      logEvent(dependencies, 'mi_note_cards_collection_failed', { contract, error });
    }
  }));
  const body: MiNoteCardsResponse = { ok: true, tokenIdsByContract, resultsByContract };
  if (successes && !isExactMiNoteCardsResponse(body)) throw miNoteProviderFailure();
  return { body, successes, cacheStatus: cacheHits === 3 ? 'HIT' : cacheHits ? 'PARTIAL' : 'MISS' };
}

export async function handleMiNoteCards(
  request: Request,
  env: MiNoteCardsEnv,
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
  const { address } = miNoteAddressFromSearch(new URL(request.url).search);
  if (!address) return result(jsonResponse({ ok: false, error: 'invalid-request' }, 400));
  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.timeoutMs ?? 30_000, timeoutMessage: 'Mi note ownership request timed out',
  });
  const failureResponse = () => jsonResponse({
    ok: false, error: deadline.timedOut() ? 'provider-timeout' : 'provider-unavailable',
  }, deadline.timedOut() ? 504 : 502);
  try {
    await raceWithSignal(observePublicRateLimit({
      binding: env.PUBLIC_SHOP_RATE_LIMITER, keyScope: MI_NOTE_CARDS_API_PATH, limit: PUBLIC_RATE_LIMITS.shop,
      log: dependencies.log, request, route: MI_NOTE_CARDS_API_PATH,
    }), deadline.signal);
    const collected = await collectOwnership({ request, address, env, dependencies, metrics, deadline, defer });
    return result(collected.successes ? jsonResponse(collected.body, 200) : failureResponse(), collected.cacheStatus);
  } catch (error) {
    if (deadline.clientAborted()) throw error;
    return result(failureResponse());
  } finally {
    deadline.dispose();
  }
}
