import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import { EthereumApiError } from './ethereumError.js';
import { validEthereumRpcResponse } from './ethereumRpcValue.js';
import { ProviderBudgetClient, ProviderBudgetUnavailable, type ProviderBudgetNamespace, type ProviderLane, type ProviderName } from './ethereumProviderBudget.js';

export type EthereumProviderEnvironment = {
  ALCHEMY_MI_NOTE_API_KEY?: string;
  ETHEREUM_111K_RPC_URL?: string;
  ETHEREUM_PROVIDER_CONTROL_ENABLED?: string;
  ETHEREUM_PROVIDER_BUDGET?: ProviderBudgetNamespace;
  QUICKNODE_ETHEREUM_MAINNET_RPC_URL?: string;
  QUICKNODE_ETHEREUM_MAINNET_ENABLED?: string;
};

export type EthereumProviderBudget = Pick<ProviderBudgetClient, 'take' | 'reportThrottle'> & Partial<Pick<ProviderBudgetClient, 'acquirePublic'>>;

type RpcInput = { jsonrpc: '2.0'; id: number; method: string; params: unknown[] };
export type EthereumProviderAttempt = {
  provider: ProviderName | 'local';
  url: string;
  signal: AbortSignal;
  request(payload: RpcInput | RpcInput[], requestSignal?: AbortSignal): Promise<unknown>;
  rpc(method: string, params: unknown[]): Promise<unknown>;
  cancel(): void;
  drain(): Promise<void>;
  metrics(): EthereumProviderAttemptMetrics;
};

export type EthereumProviderAttemptMetrics = {
  provider: ProviderName | 'local';
  methods: Record<string, number>;
  calls: number;
  budgetUnits: number;
  budgetWaitMs: number;
};

export type EthereumProviderMetrics = {
  event: 'ethereum_provider_operation';
  lane: ProviderLane;
  outcome: 'success' | 'error' | 'cancelled';
  durationMs: number;
  secondaryReason?: 'hedge' | 'budget' | 'throttle' | 'transport';
  winner?: ProviderName | 'local';
  attempts: Array<EthereumProviderAttemptMetrics & { outcome: 'success' | 'error' | 'cancelled' }>;
};

export class RpcProviderError extends Error {
  constructor(readonly provider: ProviderName | 'local', readonly kind: 'range' | 'throttle' | 'transport' | 'response',
    readonly retryAfterMs = 1_000, cause?: unknown) {
    super(`Ethereum provider ${kind === 'throttle' ? 'is throttled' : 'is unavailable'}.`, { cause });
  }
  get retryable(): boolean { return this.kind === 'throttle' || this.kind === 'transport'; }
}

export function ethereumProviderApiError(error: unknown): EthereumApiError {
  if (error instanceof EthereumApiError) return error;
  if (error instanceof ProviderBudgetUnavailable) return new EthereumApiError('unavailable',
    'Ethereum provider capacity is temporarily busy.', { kind: 'provider-budget', retryAfterMs: error.retryAfterMs });
  if (error instanceof RpcProviderError) return new EthereumApiError('unavailable', error.message,
    { kind: error.kind === 'throttle' ? 'provider-throttle' : 'provider-unavailable', retryAfterMs: error.retryAfterMs });
  return new EthereumApiError('unavailable', 'Ethereum provider is temporarily unavailable.');
}

const COSTS: Readonly<Record<string, number>> = {
  eth_chainId: 5, eth_blockNumber: 10, eth_call: 26, eth_getTransactionReceipt: 20,
  eth_getTransactionByHash: 20, eth_getBlockByNumber: 20, eth_getBlockByHash: 20,
  eth_getCode: 20, eth_getTransactionCount: 20, eth_getLogs: 60, eth_getBalance: 20,
  eth_getStorageAt: 20, eth_estimateGas: 20, eth_feeHistory: 10, eth_gasPrice: 20,
};

export function ethereumProviderCost(method: string, provider: ProviderName): number {
  const cost = COSTS[method];
  if (cost === undefined) throw new EthereumApiError('unavailable', 'Ethereum provider method is not configured.');
  return provider === 'quicknode' ? 1 : cost;
}

function providerRetryAfter(response: Response, now = Date.now()): number {
  const value = response.headers.get('Retry-After')?.trim();
  if (!value) return 2_000;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Math.ceil(Number(value) * 1_000) : Date.parse(value) - now;
  return Number.isSafeInteger(delay) && delay >= 0 ? Math.max(1, delay) : 2_000;
}

export function ethereumProviderBudget(env: EthereumProviderEnvironment, chainId?: number, maxQuantum?: number): ProviderBudgetClient {
  if (chainId === 31337 || env.ETHEREUM_PROVIDER_CONTROL_ENABLED !== 'true') return new ProviderBudgetClient(undefined, maxQuantum);
  if (!env.ETHEREUM_PROVIDER_BUDGET) throw new ProviderBudgetUnavailable(1_000);
  return new ProviderBudgetClient(env.ETHEREUM_PROVIDER_BUDGET, maxQuantum);
}

async function reportProviderThrottle(budget: EthereumProviderBudget, provider: ProviderName, retryAfterMs: number, signal: AbortSignal): Promise<void> {
  const reporting = budget.reportThrottle(provider, retryAfterMs);
  await raceWithSignal(reporting, AbortSignal.any([signal, AbortSignal.timeout(100)])).catch(() => {});
}

export async function fetchAlchemyNft(env: EthereumProviderEnvironment, url: URL, init: RequestInit,
  options: { signal: AbortSignal; fetch?: typeof fetch; budgetClient?: ProviderBudgetClient }): Promise<Response> {
  const budget = options.budgetClient ?? ethereumProviderBudget(env, 1, 100);
  await takePublicBudget(budget, 'alchemy', 100, options.signal, Date.now() + 1_000);
  options.signal.throwIfAborted();
  const response = await providerResponse((options.fetch ?? fetch), url, { ...init, redirect: 'manual', signal: options.signal }, options.signal);
  if (response.status === 429) {
    const retryAfterMs = providerRetryAfter(response);
    await cancelResponseBody(response);
    await reportProviderThrottle(budget, 'alchemy', retryAfterMs, options.signal);
    throw ethereumProviderApiError(new RpcProviderError('alchemy', 'throttle', retryAfterMs));
  }
  return response;
}

async function takePublicBudget(budget: EthereumProviderBudget, provider: ProviderName, cost: number,
  signal: AbortSignal, deadlineMs: number, onCapacityWait?: () => void): Promise<void> {
  signal.throwIfAborted();
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new ProviderBudgetUnavailable(1_000);
  const timeout = createTimedAbortScope(signal, { timeoutMs: remaining, timeoutMessage: 'Public provider admission timed out.' });
  try {
    for (;;) {
      timeout.signal.throwIfAborted();
      try { await raceWithSignal(budget.take(provider, 'public', cost, timeout.signal), timeout.signal); return; }
      catch (error) {
        timeout.signal.throwIfAborted();
        if (!(error instanceof ProviderBudgetUnavailable)) throw error;
        onCapacityWait?.();
        if (!budget.acquirePublic) throw error;
        await raceWithSignal(budget.acquirePublic(provider, cost, deadlineMs, timeout.signal), timeout.signal);
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.timedOut()) throw new ProviderBudgetUnavailable(1_000);
    throw error;
  } finally { timeout.dispose(); }
}

function providerUrl(env: EthereumProviderEnvironment, chainId: number, provider: ProviderName | 'local'): string {
  if (provider === 'local') {
    let url: URL;
    try { url = new URL(env.ETHEREUM_111K_RPC_URL || 'http://127.0.0.1:8545'); }
    catch { throw new EthereumApiError('unavailable', 'Local Ethereum RPC configuration is invalid.'); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash) throw new EthereumApiError('unavailable', 'Local Ethereum RPC configuration is invalid.');
    return url.href;
  }
  if (provider === 'quicknode') {
    let url: URL;
    try { url = new URL(env.QUICKNODE_ETHEREUM_MAINNET_RPC_URL || ''); } catch {
      throw new EthereumApiError('unavailable', 'QuickNode RPC configuration is invalid.');
    }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.quiknode.pro') || url.username || url.password || url.hash || chainId !== 1) {
      throw new EthereumApiError('unavailable', 'QuickNode RPC configuration is invalid.');
    }
    return url.href;
  }
  const host = chainId === 1 ? 'eth-mainnet' : chainId === 11155111 ? 'eth-sepolia' : null;
  if (!host || !env.ALCHEMY_MI_NOTE_API_KEY?.trim()) throw new EthereumApiError('unavailable', 'Ethereum RPC is not configured.');
  return `https://${host}.g.alchemy.com/v2/${encodeURIComponent(env.ALCHEMY_MI_NOTE_API_KEY.trim())}`;
}

export async function waitForProvider(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(2_147_483_647, Math.max(1, ms)));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function providerResponse(providerFetch: typeof fetch, url: string | URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const pending = (async () => {
    signal.throwIfAborted();
    const response = await providerFetch(url, init);
    if (signal.aborted) {
      await cancelResponseBody(response);
      throw signal.reason;
    }
    return response;
  })();
  return raceWithSignal(pending, signal);
}

function classifyRpcError(provider: ProviderName | 'local', payload: RpcInput | RpcInput[], body: unknown, retryAfterMs: number): void {
  for (const value of Array.isArray(body) ? body : [body]) {
    if (!value || typeof value !== 'object' || !('error' in value) || !value.error || typeof value.error !== 'object') continue;
    const error = value.error as { code?: unknown; message?: unknown };
    const message = typeof error.message === 'string' ? error.message : '';
    if (error.code === 3 || error.code !== 429 && /\brevert(?:ed)?\b/i.test(message)) continue;
    if (error.code === 429 || /rate.?limit|quota|credits|compute units|throughput|too many requests|requests per second/i.test(message)) {
      throw new RpcProviderError(provider, 'throttle', retryAfterMs);
    }
    if ((Array.isArray(payload) ? payload : [payload]).some(call => call.method === 'eth_getLogs') &&
      /blocks? range|too many (?:logs|results)|response size|query.*(?:limit|timeout)|limit exceeded/i.test(message)) {
      throw new RpcProviderError(provider, 'range');
    }
    const serverError = error.code === -32603 || typeof error.code === 'number' && Number.isInteger(error.code) &&
      error.code >= -32099 && error.code <= -32000;
    if (serverError && ['internal error', 'internal server error', 'unable to complete request at this time.',
      'request timed out. client should retry.'].includes(message.trim().toLowerCase())) {
      throw new RpcProviderError(provider, 'transport', retryAfterMs);
    }
  }
}

export function createEthereumProviderAttempt(env: EthereumProviderEnvironment, chainId: number,
  provider: ProviderName | 'local', parentSignal: AbortSignal, options: {
    lane?: ProviderLane; budgetClient?: EthereumProviderBudget; fetch?: typeof fetch;
    publicAdmissionDeadlineMs?: number; publicAdmissionComplete?: boolean; onInitialCapacityWait?: () => void;
  } = {}): EthereumProviderAttempt {
  const url = providerUrl(env, chainId, provider);
  const lane = options.lane ?? 'public';
  const budget = options.budgetClient ?? ethereumProviderBudget(env, chainId, lane === 'public' ? 100 : undefined);
  const admissionDeadlineMs = options.publicAdmissionDeadlineMs ?? Date.now() + 1_000;
  const cancellation = new AbortController();
  const signal = AbortSignal.any([parentSignal, cancellation.signal]);
  const requests = new Set<Promise<unknown>>();
  const metrics: EthereumProviderAttemptMetrics = { provider, methods: {}, calls: 0, budgetUnits: 0, budgetWaitMs: 0 };
  let admissionComplete = options.publicAdmissionComplete ?? false;
  const execute = async (payload: RpcInput | RpcInput[], callerSignal?: AbortSignal): Promise<unknown> => {
    const operationSignal = callerSignal ? AbortSignal.any([signal, callerSignal]) : signal;
    operationSignal.throwIfAborted();
    const calls = Array.isArray(payload) ? payload : [payload];
    if (!calls.length || calls.length > 4 || calls.some(call => call.jsonrpc !== '2.0' || !Number.isSafeInteger(call.id) || !Array.isArray(call.params)) ||
      new Set(calls.map(call => call.id)).size !== calls.length) throw new EthereumApiError('unavailable', 'Ethereum provider batch is invalid.');
    const cost = calls.reduce((total, call) => total + ethereumProviderCost(call.method, provider === 'quicknode' ? provider : 'alchemy'), 0);
    if (provider === 'quicknode' && Array.isArray(payload)) {
      const batchCancellation = new AbortController();
      const batchSignal = AbortSignal.any([operationSignal, batchCancellation.signal]);
      const work = payload.map(call => request(call, batchSignal));
      try { return await Promise.all(work); }
      catch (error) {
        batchCancellation.abort(error);
        await Promise.allSettled(work);
        throw error;
      }
    }
    if (provider !== 'local') {
      for (;;) {
        const budgetStarted = performance.now();
        try {
          if (lane === 'public') await takePublicBudget(budget, provider, cost, operationSignal,
            admissionComplete ? Date.now() + 1_000 : admissionDeadlineMs, admissionComplete ? undefined : options.onInitialCapacityWait);
          else await budget.take(provider, lane, cost, operationSignal);
          break;
        } catch (error) {
          if (!(error instanceof ProviderBudgetUnavailable) || !admissionComplete) throw error;
          await error.wait(operationSignal);
        } finally { metrics.budgetWaitMs += performance.now() - budgetStarted; }
      }
    }
    operationSignal.throwIfAborted();
    admissionComplete = true;
    metrics.calls += calls.length;
    metrics.budgetUnits += provider === 'local' ? 0 : cost;
    for (const call of calls) metrics.methods[call.method] = (metrics.methods[call.method] ?? 0) + 1;
    const requestSignal = AbortSignal.any([operationSignal, AbortSignal.timeout(10_000)]);
    try {
      const response = await providerResponse((options.fetch ?? fetch), url, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: requestSignal,
      }, requestSignal);
      const retryAfterMs = providerRetryAfter(response);
      if (provider === 'quicknode' && response.status === 413 && calls.some(call => call.method === 'eth_getLogs')) {
        await cancelResponseBody(response);
        throw new RpcProviderError(provider, 'range');
      }
      if (response.status === 429 || response.status >= 500) {
        await cancelResponseBody(response);
        throw new RpcProviderError(provider, response.status === 429 ? 'throttle' : 'transport', retryAfterMs);
      }
      const body = await readBoundedResponseJson(response, { maxBytes: 3 * 1024 * 1024, contentType: 'require-json', signal: requestSignal,
        createError: (failure, cause) => new RpcProviderError(provider, failure === 'stream-failed' ? 'transport'
          : failure === 'too-large' && calls.some(call => call.method === 'eth_getLogs') ? 'range' : 'response', 1_000, cause) });
      if (!response.ok) throw new RpcProviderError(provider, 'response');
      if (!validEthereumRpcResponse(payload, body)) throw new RpcProviderError(provider, 'response');
      classifyRpcError(provider, payload, body, retryAfterMs);
      return body;
    } catch (error) {
      operationSignal.throwIfAborted();
      if (error instanceof RpcProviderError) {
        if (error.kind === 'throttle' && provider !== 'local') await reportProviderThrottle(budget, provider, error.retryAfterMs, operationSignal);
        throw error;
      }
      if (requestSignal.aborted && calls.some(call => call.method === 'eth_getLogs')) throw new RpcProviderError(provider, 'range');
      throw new RpcProviderError(provider, 'transport', 1_000, error);
    }
  };
  const request = (payload: RpcInput | RpcInput[], requestSignal?: AbortSignal): Promise<unknown> => {
    const pending = execute(payload, requestSignal);
    requests.add(pending);
    return pending.finally(() => requests.delete(pending));
  };
  return { provider, url, signal, request,
    cancel: () => cancellation.abort(new Error('Ethereum provider attempt stopped.')),
    async drain() { while (requests.size) await Promise.allSettled([...requests]); },
    metrics: () => ({ ...metrics, methods: { ...metrics.methods }, budgetWaitMs: Math.round(metrics.budgetWaitMs) }),
    async rpc(method, params) {
    const body = await request({ jsonrpc: '2.0', id: 1, method, params });
    if (!body || typeof body !== 'object' || !('result' in body) || 'error' in body ||
      !('id' in body) || body.id !== 1 || !('jsonrpc' in body) || body.jsonrpc !== '2.0') throw new RpcProviderError(provider, 'response');
    return body.result;
  } };
}

export async function withEthereumProvider<T>(env: EthereumProviderEnvironment, chainId: number, signal: AbortSignal,
  operation: (attempt: EthereumProviderAttempt) => Promise<T>, options: {
    lane?: ProviderLane; hedgeMs?: number; budgetClient?: EthereumProviderBudget; fetch?: typeof fetch;
    onMetrics?: (metrics: EthereumProviderMetrics) => void;
  } = {}): Promise<T> {
  signal.throwIfAborted();
  if (options.hedgeMs !== undefined && (!Number.isFinite(options.hedgeMs) || options.hedgeMs < 0)) throw new TypeError('Invalid provider hedge delay.');
  const started = performance.now();
  const primary = chainId === 31337 ? 'local' : 'alchemy';
  const secondaryEnabled = chainId === 1 && env.QUICKNODE_ETHEREUM_MAINNET_ENABLED === 'true' && !!env.QUICKNODE_ETHEREUM_MAINNET_RPC_URL;
  const budgetClient = options.budgetClient ?? ethereumProviderBudget(env, chainId, (options.lane ?? 'public') === 'public' ? 100 : undefined);
  const publicAdmissionDeadlineMs = Date.now() + 1_000;
  const attempts: Array<{ provider: ProviderName | 'local'; controller: AbortController; attempt?: EthereumProviderAttempt;
    outcome: 'success' | 'error' | 'cancelled' }> = [];
  const running: Promise<void>[] = [];
  const failures: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let secondaryStarted = false;
  let pending = 0;
  let winner: EthereumProviderMetrics['winner'];
  let secondaryReason: EthereumProviderMetrics['secondaryReason'];
  let resolveResult!: (value: T) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const stop = () => {
    for (const item of attempts) {
      item.controller.abort(new Error('Ethereum provider operation finished.'));
      item.attempt?.cancel();
    }
  };
  const finish = (value: T, provider: EthereumProviderMetrics['winner']) => {
    if (settled) return;
    settled = true;
    winner = provider;
    resolveResult(value);
    stop();
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectResult(error);
    stop();
  };
  const start = (provider: ProviderName | 'local', reason?: EthereumProviderMetrics['secondaryReason']) => {
    if (settled) return;
    if (provider === 'quicknode') {
      if (!secondaryEnabled || secondaryStarted) return;
      secondaryStarted = true;
      secondaryReason = reason;
    }
    const controller = new AbortController();
    const item: typeof attempts[number] = { provider, controller, outcome: 'cancelled' };
    attempts.push(item);
    pending++;
    const attemptSignal = AbortSignal.any([signal, controller.signal]);
    const work = Promise.resolve().then(() => {
      attemptSignal.throwIfAborted();
      const attempt = item.attempt = createEthereumProviderAttempt(env, chainId, provider, attemptSignal, {
        ...options, budgetClient, publicAdmissionDeadlineMs,
        publicAdmissionComplete: (options.lane ?? 'public') === 'public' && provider === 'quicknode' &&
          attempts.some(value => value.attempt && value.attempt.metrics().calls > 0),
        onInitialCapacityWait: () => { if (provider === 'alchemy') start('quicknode', 'budget'); },
      });
      if (provider === 'alchemy' && secondaryEnabled) {
        const hedge = options.hedgeMs !== undefined && options.lane === 'reveal';
        timer = setTimeout(() => {
          if (hedge || attempt.metrics().calls === 0) start('quicknode', hedge ? 'hedge' : 'budget');
        }, hedge ? options.hedgeMs : (options.lane ?? 'public') === 'public' ? 500 : 1_000);
      }
      return raceWithSignal(Promise.resolve().then(() => operation(attempt)), attemptSignal);
    }).then(value => {
      if (settled) return;
      item.outcome = 'success';
      finish(value, provider);
    }, error => {
      item.attempt?.cancel();
      if (settled) return;
      item.outcome = 'error';
      failures.push(error);
      const retryable = error instanceof ProviderBudgetUnavailable || error instanceof RpcProviderError && error.retryable;
      if (retryable && provider === 'alchemy') start('quicknode', error instanceof ProviderBudgetUnavailable ? 'budget'
        : error instanceof RpcProviderError && error.kind === 'throttle' ? 'throttle' : 'transport');
    }).finally(async () => {
      pending--;
      item.attempt?.cancel();
      if (!settled && pending === 0) {
        const retries = failures.filter((error): error is ProviderBudgetUnavailable | RpcProviderError =>
          error instanceof ProviderBudgetUnavailable || error instanceof RpcProviderError && error.retryable);
        fail(retries.length === failures.length ? retries.reduce((earliest, error) =>
          error.retryAfterMs < earliest.retryAfterMs ? error : earliest) : failures[0]);
      }
      await item.attempt?.drain();
    });
    running.push(work);
  };
  const aborted = () => fail(signal.reason);
  signal.addEventListener('abort', aborted, { once: true });
  try {
    if (signal.aborted) aborted();
    else start(primary);
    return await result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', aborted);
    stop();
    await Promise.allSettled(running);
    const metrics: EthereumProviderMetrics = { event: 'ethereum_provider_operation', lane: options.lane ?? 'public',
      outcome: winner ? 'success' : signal.aborted ? 'cancelled' : 'error', durationMs: Math.round(performance.now() - started),
      ...(secondaryReason ? { secondaryReason } : {}), ...(winner ? { winner } : {}),
      attempts: attempts.map(item => ({ ...(item.attempt?.metrics() ?? { provider: item.provider, methods: {}, calls: 0, budgetUnits: 0, budgetWaitMs: 0 }), outcome: item.outcome })) };
    try {
      if (options.onMetrics) options.onMetrics(metrics);
      else if (env.ETHEREUM_PROVIDER_CONTROL_ENABLED === 'true') console.log(metrics);
    } catch {}
  }
}
