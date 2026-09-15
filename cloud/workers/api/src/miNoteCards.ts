import {
  MI_NOTE_2_CONTRACT_ADDRESS,
  MI_NOTE_3_CONTRACT_ADDRESS,
  MI_NOTE_CONTRACT_ADDRESS,
  MI_NOTE_MODERN_CONTRACT_ADDRESSES,
  MI_NOTE_CONTRACT_ADDRESSES,
  MI_NOTE_CARDS_API_PATH,
  MAX_MI_NOTE_TOKEN_IDS,
  isExactMiNoteCardsEvent,
  isExactMiNoteCardsResponse,
  miNoteAddressFromSearch,
  type MiNoteCardsCollectionEvent,
  type MiNoteCardsOutcome,
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
  fetchOriginalMiNotes,
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
import type { WorkerDependencies, WorkerRequestMetrics } from './workerPublicRoutes.js';

const MAX_CACHE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 60_000;
const CACHE_EXPIRY_HEADER = 'X-Mi-Note-Cards-Expires-At';
const STREAM_TYPE = 'application/x-ndjson';

type MiNoteCardsDependencies = Pick<WorkerDependencies, 'cache' | 'providerFetch' | 'log'> & {
  timeoutMs?: number;
  backupDelayMs?: number;
  now?: () => number;
};
type MiNoteCardsEnv = Pick<Env, 'ALCHEMY_MI_NOTE_API_KEY' | 'OPENSEA_API_KEY' | 'PUBLIC_SHOP_RATE_LIMITER'>;

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

async function readCachedOwnership(
  cacheRequest: Request,
  contract: MiNoteContractAddress,
  dependencies: MiNoteCardsDependencies,
  signal: AbortSignal,
  now: () => number,
): Promise<MiNoteCardsCollectionEvent | null> {
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
    if (isExactMiNoteCardsEvent(body) && body.type === 'collection' && body.contractAddress === contract) return body;
    logEvent(dependencies, 'mi_note_cards_cache_invalid');
  } catch {
    if (signal.aborted) throw signal.reason;
    logEvent(dependencies, 'mi_note_cards_cache_read_failed');
  }
  return null;
}

async function raceProviders(
  contract: MiNoteContractAddress,
  primary: Promise<string[]>,
  backup: (signal: AbortSignal) => Promise<string[]>,
  signal: AbortSignal,
  backupDelayMs: number,
): Promise<MiNoteCardsCollectionEvent> {
  const winner = Promise.withResolvers<MiNoteCardsCollectionEvent>();
  const backupController = new AbortController();
  let finished = false;
  let primaryFailed = false;
  let backupFailed = false;
  let backupStarted = false;
  let backupTask: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const success = (tokenIds: string[], provider: 'alchemy' | 'opensea') => {
    if (finished || signal.aborted) return;
    finished = true;
    winner.resolve({ type: 'collection', contractAddress: contract, tokenIds, provider, visibilityLimited: provider === 'opensea' });
  };
  const startBackup = () => {
    if (backupStarted || finished || signal.aborted) return;
    backupStarted = true;
    clearTimeout(timer);
    backupTask = backup(AbortSignal.any([signal, backupController.signal])).then(
      (ids) => success(ids, 'opensea'),
      () => {
        backupFailed = true;
        if (primaryFailed && !finished) winner.reject(miNoteProviderFailure());
      },
    );
  };
  const primaryTask = primary.then(
    (ids) => success(ids, 'alchemy'),
    () => {
      primaryFailed = true;
      if (backupFailed && !finished) winner.reject(miNoteProviderFailure());
      else startBackup();
    },
  );
  timer = setTimeout(startBackup, backupDelayMs);
  try {
    return await raceWithSignal(winner.promise, signal);
  } finally {
    finished = true;
    clearTimeout(timer);
    backupController.abort();
    if (backupTask) await backupTask;
    void primaryTask;
  }
}

async function collectOwnership(args: {
  request: Request;
  address: string;
  env: MiNoteCardsEnv;
  dependencies: MiNoteCardsDependencies;
  metrics: WorkerRequestMetrics;
  deadline: RequestDeadline;
  defer: DeferredWork;
  onOutcome: (outcome: MiNoteCardsOutcome) => void;
}): Promise<{ body: MiNoteCardsResponse; cacheStatus: string; successes: number }> {
  const { request, address, env, dependencies, metrics, deadline, defer, onOutcome } = args;
  const now = dependencies.now ?? Date.now;
  const alchemyKey = typeof env.ALCHEMY_MI_NOTE_API_KEY === 'string' ? env.ALCHEMY_MI_NOTE_API_KEY.trim() : '';
  const openSeaKey = typeof env.OPENSEA_API_KEY === 'string' ? env.OPENSEA_API_KEY.trim() : '';
  const modernController = new AbortController();
  const originalController = new AbortController();
  const settled = new Set<MiNoteContractAddress>();
  const primaryTasks: Promise<unknown>[] = [];
  let modern: Promise<Map<MiNoteContractAddress, string[]>> | undefined;
  let successes = 0;
  let cacheHits = 0;
  let totalIds = 0;
  const tokenIdsByContract: MiNoteTokenIdsByContract = {
    [MI_NOTE_2_CONTRACT_ADDRESS]: [],
    [MI_NOTE_3_CONTRACT_ADDRESS]: [],
    [MI_NOTE_CONTRACT_ADDRESS]: [],
  };
  const resultsByContract = {} as MiNoteCardsResponse['resultsByContract'];
  const primary = (contract: MiNoteContractAddress): Promise<string[]> => {
    if (contract === MI_NOTE_CONTRACT_ADDRESS) {
      const task = fetchOriginalMiNotes(address, alchemyKey, {
        providerFetch: dependencies.providerFetch, metrics,
        signal: AbortSignal.any([deadline.signal, originalController.signal]),
      });
      primaryTasks.push(task);
      return task;
    }
    if (!modern) {
      modern = fetchAlchemyMiNotes(address, alchemyKey, {
        providerFetch: dependencies.providerFetch, metrics,
        signal: AbortSignal.any([deadline.signal, modernController.signal]),
      });
      primaryTasks.push(modern);
    }
    return modern.then((groups) => groups.get(contract)!);
  };
  try {
    await Promise.all(MI_NOTE_CONTRACT_ADDRESSES.map(async (contract) => {
      const cacheUrl = new URL(MI_NOTE_CARDS_API_PATH, request.url);
      cacheUrl.searchParams.set('address', address);
      cacheUrl.searchParams.set('contract', contract);
      cacheUrl.searchParams.set('version', '3');
      const cacheRequest = new Request(cacheUrl);
      let outcome: MiNoteCardsOutcome;
      let cached = false;
      try {
        const hit = await readCachedOwnership(cacheRequest, contract, dependencies, deadline.signal, now);
        if (hit) {
          outcome = hit;
          cached = true;
          cacheHits += 1;
        } else {
          outcome = await raceProviders(contract, primary(contract), (signal) => fetchOpenSeaMiNotes(address, contract, openSeaKey, {
            providerFetch: dependencies.providerFetch, metrics, signal,
          }), deadline.signal, dependencies.backupDelayMs ?? 1_000);
        }
        if (deadline.signal.aborted) throw deadline.signal.reason;
        if (totalIds + outcome.tokenIds.length > MAX_MI_NOTE_TOKEN_IDS) throw miNoteProviderFailure();
        totalIds += outcome.tokenIds.length;
        successes += 1;
        tokenIdsByContract[contract] = outcome.tokenIds;
        resultsByContract[contract] = { status: 'success', provider: outcome.provider, visibilityLimited: outcome.visibilityLimited };
        if (!cached && dependencies.cache) {
          const cache = dependencies.cache;
          const cacheResponse = jsonResponse(outcome, 200, { headers: {
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
        outcome = { type: 'error', contractAddress: contract, error };
        resultsByContract[contract] = { status: 'error', error };
        logEvent(dependencies, 'mi_note_cards_collection_failed', { contract, error });
      } finally {
        settled.add(contract);
        if (contract === MI_NOTE_CONTRACT_ADDRESS) originalController.abort();
        if (MI_NOTE_MODERN_CONTRACT_ADDRESSES.every((item) => settled.has(item))) modernController.abort();
      }
      onOutcome(outcome);
    }));
    const body: MiNoteCardsResponse = { ok: true, tokenIdsByContract, resultsByContract };
    if (successes && !isExactMiNoteCardsResponse(body)) throw miNoteProviderFailure();
    return { body, successes, cacheStatus: cacheHits === 3 ? 'HIT' : cacheHits ? 'PARTIAL' : 'MISS' };
  } finally {
    modernController.abort();
    originalController.abort();
    await Promise.allSettled(primaryTasks);
  }
}

function wantsStream(request: Request): boolean {
  return (request.headers.get('Accept') ?? '').split(',').some((item) => {
    const [type, ...parameters] = item.trim().toLowerCase().split(';');
    const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith('q='));
    return type.trim() === STREAM_TYPE && (quality === undefined || Number(quality.slice(2)) > 0);
  });
}

export async function handleMiNoteCards(
  request: Request,
  env: MiNoteCardsEnv,
  dependencies: MiNoteCardsDependencies,
  metrics: WorkerRequestMetrics,
  defer: DeferredWork,
): Promise<{ response: Response; cacheStatus?: string }> {
  const origin = publicRequestOrigin(request);
  const result = (response: Response, cacheStatus?: string) => {
    const corsResponse = origin ? applyPublicCors(response, origin, 'GET, OPTIONS') : response;
    corsResponse.headers.set('Vary', 'Origin, Accept');
    return { response: corsResponse, ...(cacheStatus ? { cacheStatus } : {}) };
  };
  if (!origin) return result(jsonResponse({ ok: false, error: 'origin-not-allowed' }, 403));
  const { address } = miNoteAddressFromSearch(new URL(request.url).search);
  if (!address) return result(jsonResponse({ ok: false, error: 'invalid-request' }, 400));
  const cancellation = new AbortController();
  const deadline = createRequestDeadline(new Request(request, { signal: AbortSignal.any([request.signal, cancellation.signal]) }), {
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
    if (wantsStream(request)) {
      let closed = false;
      let keepalive: ReturnType<typeof setTimeout> | undefined;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const sendKeepalive = () => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode('\n'));
              keepalive = setTimeout(sendKeepalive, 1_000);
            } catch {
              closed = true;
              cancellation.abort(new DOMException('Stream disconnected', 'AbortError'));
            }
          };
          keepalive = setTimeout(sendKeepalive, 1_000);
          const producer = collectOwnership({ request, address, env, dependencies, metrics, deadline, defer,
            onOutcome: (outcome) => {
              if (!closed) controller.enqueue(encoder.encode(JSON.stringify(outcome) + '\n'));
            },
          }).then((collected) => {
            if (!closed) {
              controller.enqueue(encoder.encode('{"type":"done"}\n'));
              controller.close();
              closed = true;
            }
            logEvent(dependencies, 'mi_note_cards_stream_complete', {
              providerDurationMs: metrics.providerDurationMs, upstreamCalls: metrics.upstreamCalls,
              providerCacheStatus: collected.cacheStatus, resultsByContract: collected.body.resultsByContract,
            });
          }, () => {
            if (!closed) {
              controller.error(miNoteProviderFailure());
              closed = true;
            }
            logEvent(dependencies, 'mi_note_cards_stream_cancelled', {
              providerDurationMs: metrics.providerDurationMs, upstreamCalls: metrics.upstreamCalls,
            });
          }).finally(() => {
            clearTimeout(keepalive);
            deadline.dispose();
          });
          deferWork(defer, producer, dependencies);
        },
        cancel(reason) {
          closed = true;
          clearTimeout(keepalive);
          cancellation.abort(reason ?? new DOMException('Stream cancelled', 'AbortError'));
        },
      });
      return result(new Response(stream, { headers: {
        'Content-Type': `${STREAM_TYPE}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } }), 'STREAM');
    }
    const collected = await collectOwnership({ request, address, env, dependencies, metrics, deadline, defer, onOutcome: () => {} });
    deadline.dispose();
    return result(collected.successes ? jsonResponse(collected.body, 200) : failureResponse(), collected.cacheStatus);
  } catch (error) {
    deadline.dispose();
    if (deadline.clientAborted()) throw error;
    return result(failureResponse());
  }
}
