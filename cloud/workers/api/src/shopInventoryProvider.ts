import type { SolanaCluster } from '../../../../shared/deploymentCore.js';
import { raceWithSignal } from './boundedRequest.js';
import {
  cancelResponseBody,
  readBoundedResponseJson,
} from './boundedResponse.js';
import { heliusRpcUrl } from './solanaProvider.js';
import type { WorkerDependencies, WorkerRequestMetrics } from './publicRouteSupport.js';

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

type ProviderFailureKind = 'asset-not-found' | 'deadline' | 'timeout' | 'unavailable' | 'page-too-large' | 'limit';

type InventoryProviderDependencies = Pick<WorkerDependencies,
  | 'expectedAssetRecoveryTimeoutMs'
  | 'inventoryMaxCandidates'
  | 'inventoryMaxCursorPages'
  | 'inventoryMaxProviderCalls'
  | 'inventoryMaxResponseBodyBytes'
  | 'providerAttemptTimeoutMs'
  | 'providerFetch'
  | 'providerMaxResponseBodyBytes'
  | 'providerMaxTotalResponseBodyBytes'
  | 'randomUint32'
  | 'sleep'
>;

export class ProviderFailure extends Error {
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

export class ProviderReadGate {
  private tail = Promise.resolve();

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const queued = previous.then(() => {
      if (signal.aborted) throw signal.reason;
      return operation();
    });
    this.tail = queued.then(() => undefined, () => undefined);
    return raceWithSignal(queued, signal);
  }
}

export function createAttemptScope(overallSignal: AbortSignal, timeoutMs: number): AttemptScope {
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

export type ProviderContext = {
  apiKey: string;
  signal: AbortSignal;
  dependencies: InventoryProviderDependencies;
  metrics: WorkerRequestMetrics;
  providerResponseBodyBytes: number;
  inventoryCandidates: number;
  inventoryCursorPages: number;
  inventoryProviderCalls: number;
  providerReadGate: ProviderReadGate;
};

async function readBoundedJsonResponse(
  response: Response,
  context: ProviderContext,
  pageOverflowIsRetryable = false,
  signal: AbortSignal = context.signal,
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
  try {
    return await readBoundedResponseJson(response, {
      maxBytes,
      signal,
      contentType: 'ignore',
      createError: (failure) => new ProviderFailure(
        failure === 'too-large' && pageOverflowIsRetryable
          ? 'page-too-large'
          : 'unavailable',
      ),
      onBytes: (bytes) => {
        context.providerResponseBodyBytes += bytes;
        if (context.providerResponseBodyBytes > context.dependencies.providerMaxTotalResponseBodyBytes) {
          throw new ProviderFailure('limit');
        }
      },
    });
  } catch (error) {
    if (signal.aborted && error === signal.reason) throw error;
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure('unavailable');
  }
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

function retryDelayMs(dependencies: Pick<WorkerDependencies, 'randomUint32'>, response?: Response): number {
  const retryAfterHeader = response?.headers.get('Retry-After');
  if (retryAfterHeader !== undefined && retryAfterHeader !== null && retryAfterHeader.trim()) {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(1000, retryAfter * 1000);
  }
  return 100 + (dependencies.randomUint32() % 151);
}

export async function heliusRpc<T>(
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
    if (signal.aborted) throw signal.reason;
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
      response = await raceWithSignal(context.dependencies.providerFetch(
        heliusRpcUrl(cluster, context.apiKey),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
          signal: attemptScope.signal,
        },
      ), attemptScope.signal);
      if (!response.ok) {
        const retryable = TRANSIENT_HTTP_STATUSES.has(response.status);
        const failure = new ProviderFailure(
          response.status === 408 || response.status === 504 ? 'timeout' : 'unavailable',
        );
        await cancelResponseBody(response);
        if (!retryable || attempt + 1 >= maxAttempts) throw failure;
        if (signal.aborted) throw signal.reason;
        await context.dependencies.sleep(retryDelayMs(context.dependencies, response), attemptScope.signal);
        continue;
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
      if (signal.aborted && error === signal.reason) throw error;
      if (error instanceof ProviderFailure) throw error;
      if (attemptScope.timedOut()) {
        if (attempt + 1 < maxAttempts) continue;
        throw new ProviderFailure('timeout');
      }
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
