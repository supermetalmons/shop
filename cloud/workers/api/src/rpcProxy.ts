import type { SolanaCluster } from '../../../../shared/deploymentCore.js';
import {
  isExactShopRpcRequest,
  isExactShopRpcResponse,
  isTransientShopRpcError,
  SHOP_RPC_METHODS,
  type ShopRpcId,
  type ShopRpcMethod,
} from '../../../../shared/solanaRpcProxy.js';
import {
  PUBLIC_RATE_LIMITS,
  isAllowedPublicOrigin,
  observePublicRateLimit,
  publicCorsHeaders,
} from './publicRequestPolicy.js';
import {
  createRequestDeadline,
  createTimedAbortScope,
  isRequestCancellationError,
  raceWithSignal,
  readBoundedRequestJson,
} from './boundedRequest.js';
import { cancelResponseBody } from './boundedResponse.js';

const MAX_RPC_REQUEST_BODY_BYTES = 32 * 1024;
const MAX_RPC_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export type RpcProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RpcRequestMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type RpcProxyDependencies = {
  log: (entry: Record<string, unknown>) => void;
  providerFetch: RpcProviderFetch;
  providerTimeoutMs: number;
  providerAttemptTimeoutMs: number;
  randomUint32: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type RpcFailureKind = 'deadline' | 'timeout' | 'unavailable';

class RpcFailure extends Error {
  constructor(readonly kind: RpcFailureKind) {
    super(kind);
    this.name = 'RpcFailure';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rpcCorsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigin = origin && isAllowedPublicOrigin(origin) ? origin : null;
  return {
    ...(allowedOrigin ? publicCorsHeaders(
      allowedOrigin,
      'POST, OPTIONS',
      'Content-Type, Solana-Client',
    ) : {}),
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  };
}

function rpcErrorResponse(
  origin: string | null,
  id: ShopRpcId | null,
  code: number,
  message: string,
  status: number,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status,
    headers: { ...rpcCorsHeaders(origin), ...headers },
  });
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
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
      if (size > maxBytes) throw new RpcFailure('unavailable');
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

async function parseRpcRequest(request: Request): Promise<unknown> {
  return readBoundedRequestJson(request, {
    maxBytes: MAX_RPC_REQUEST_BODY_BYTES,
    signal: request.signal,
    createError: () => new Error('invalid-request'),
  });
}

async function readRpcResponse(
  response: Response,
  expectedId: ShopRpcId,
  signal: AbortSignal,
): Promise<{ payload: Record<string, unknown>; text: string }> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RPC_RESPONSE_BODY_BYTES) {
    await cancelResponseBody(response);
    throw new RpcFailure('unavailable');
  }
  if (!response.body) throw new RpcFailure('unavailable');
  try {
    const text = await readBoundedText(response.body, MAX_RPC_RESPONSE_BODY_BYTES, signal);
    const payload: unknown = JSON.parse(text);
    if (!isExactShopRpcResponse(payload, expectedId)) throw new RpcFailure('unavailable');
    return { payload, text };
  } catch (error) {
    if (signal.aborted && error === signal.reason) throw error;
    if (error instanceof RpcFailure) throw error;
    throw new RpcFailure('unavailable');
  }
}

function heliusRpcUrl(cluster: SolanaCluster, apiKey: string): string {
  const subdomain = cluster === 'mainnet-beta' ? 'mainnet' : 'devnet';
  return `https://${subdomain}.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

function retryDelayMs(dependencies: RpcProxyDependencies, response?: Response): number {
  const retryAfterHeader = response?.headers.get('Retry-After');
  if (retryAfterHeader !== undefined && retryAfterHeader !== null && retryAfterHeader.trim()) {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(1000, retryAfter * 1000);
  }
  return 100 + (dependencies.randomUint32() % 151);
}

function providerHttpFailure(status: number): RpcFailure {
  return new RpcFailure(status === 408 || status === 504 ? 'timeout' : 'unavailable');
}

async function fetchRpc(
  cluster: SolanaCluster,
  apiKey: string,
  requestBody: ReturnType<typeof requireRpcRequest>,
  signal: AbortSignal,
  dependencies: RpcProxyDependencies,
  metrics: RpcRequestMetrics,
): Promise<string> {
  const attempts = requestBody.method === 'sendTransaction' ? 1 : 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal.aborted) throw signal.reason;
    const attemptScope = createTimedAbortScope(signal, {
      timeoutMs: dependencies.providerAttemptTimeoutMs,
      timeoutMessage: 'Provider attempt timed out',
    });
    let response: Response | undefined;
    const startedAt = performance.now();
    try {
      metrics.upstreamCalls += 1;
      response = await raceWithSignal(dependencies.providerFetch(heliusRpcUrl(cluster, apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: attemptScope.signal,
      }), attemptScope.signal);
      let parsed: Awaited<ReturnType<typeof readRpcResponse>>;
      try {
        parsed = await readRpcResponse(response, requestBody.id, attemptScope.signal);
      } catch (error) {
        if (!response.ok) {
          const failure = providerHttpFailure(response.status);
          if (signal.aborted) throw failure;
          if (
            attempt + 1 < attempts &&
            TRANSIENT_HTTP_STATUSES.has(response.status)
          ) {
            if (!attemptScope.signal.aborted) {
              await dependencies.sleep(retryDelayMs(dependencies, response), attemptScope.signal);
            }
            continue;
          }
          throw failure;
        }
        if (signal.aborted && error === signal.reason) throw error;
        throw error;
      }
      const encodedApiKey = encodeURIComponent(apiKey);
      if (parsed.text.includes(apiKey) || (encodedApiKey !== apiKey && parsed.text.includes(encodedApiKey))) {
        throw new RpcFailure('unavailable');
      }
      const responseError = isRecord(parsed.payload.error) ? parsed.payload.error : null;
      if (
        !response.ok &&
        attempt + 1 < attempts &&
        TRANSIENT_HTTP_STATUSES.has(response.status)
      ) {
        await dependencies.sleep(retryDelayMs(dependencies, response), attemptScope.signal);
        continue;
      }
      if (!response.ok && !responseError) {
        throw providerHttpFailure(response.status);
      }
      if (
        attempt + 1 < attempts &&
        responseError &&
        isTransientShopRpcError(responseError)
      ) {
        await dependencies.sleep(retryDelayMs(dependencies), attemptScope.signal);
        continue;
      }
      return parsed.text;
    } catch (error) {
      if (signal.aborted && error === signal.reason) throw error;
      if (error instanceof RpcFailure) throw error;
      if (attemptScope.timedOut()) {
        if (attempt + 1 < attempts) continue;
        throw new RpcFailure('timeout');
      }
      if (signal.aborted) {
        if (error instanceof RpcFailure) throw error;
        throw new RpcFailure('unavailable');
      }
      if (attempt + 1 < attempts) {
        await dependencies.sleep(retryDelayMs(dependencies), attemptScope.signal);
        continue;
      }
      throw new RpcFailure('unavailable');
    } finally {
      attemptScope.dispose();
      metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
    }
  }
  throw new RpcFailure('unavailable');
}

function requireRpcRequest(value: unknown) {
  if (!isExactShopRpcRequest(value)) throw new Error('invalid-request');
  return value;
}

export function handleRpcPreflight(request: Request): Response {
  const origin = request.headers.get('Origin');
  if (!origin || !isAllowedPublicOrigin(origin)) {
    return rpcErrorResponse(origin, null, -32096, 'Origin not allowed', 403);
  }
  return new Response(null, { status: 204, headers: rpcCorsHeaders(origin) });
}

export function handleRpcMethodNotAllowed(request: Request): Response {
  const origin = request.headers.get('Origin');
  if (!origin || !isAllowedPublicOrigin(origin)) {
    return rpcErrorResponse(origin, null, -32096, 'Origin not allowed', 403);
  }
  return rpcErrorResponse(origin, null, -32600, 'Invalid request', 405, { Allow: 'POST, OPTIONS' });
}

export async function handleRpcPost(
  request: Request,
  env: Env,
  cluster: SolanaCluster,
  dependencies: RpcProxyDependencies,
  metrics: RpcRequestMetrics,
): Promise<{ response: Response; rpcMethod?: ShopRpcMethod }> {
  const origin = request.headers.get('Origin');
  if (!origin || !isAllowedPublicOrigin(origin)) {
    return { response: rpcErrorResponse(origin, null, -32096, 'Origin not allowed', 403) };
  }
  let rawBody: unknown;
  let invalid: { id: ShopRpcId | null; code: number; message: string } | undefined;
  try {
    rawBody = await parseRpcRequest(request);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    invalid = { id: null, code: -32600, message: 'Invalid request' };
  }
  if (!invalid && isRecord(rawBody) && typeof rawBody.method === 'string' && !isExactShopRpcRequest(rawBody)) {
    const id = (typeof rawBody.id === 'string' || typeof rawBody.id === 'number') ? rawBody.id : null;
    const methodAllowed = SHOP_RPC_METHODS.includes(rawBody.method as ShopRpcMethod);
    invalid = {
      id,
      code: methodAllowed ? -32600 : -32601,
      message: methodAllowed ? 'Invalid request' : 'Method not allowed',
    };
  }
  let requestBody: ReturnType<typeof requireRpcRequest> | undefined;
  if (!invalid) {
    try {
      requestBody = requireRpcRequest(rawBody);
    } catch {
      invalid = { id: null, code: -32600, message: 'Invalid request' };
    }
  }
  if (invalid) {
    return { response: rpcErrorResponse(origin, invalid.id, invalid.code, invalid.message, 400) };
  }
  if (!requestBody) {
    return { response: rpcErrorResponse(origin, null, -32600, 'Invalid request', 400) };
  }
  const rpcClass = requestBody.method === 'sendTransaction' ? 'write' : 'read';
  await observePublicRateLimit({
    binding: rpcClass === 'write'
      ? env.PUBLIC_RPC_WRITE_RATE_LIMITER
      : env.PUBLIC_RPC_READ_RATE_LIMITER,
    limit: rpcClass === 'write' ? PUBLIC_RATE_LIMITS.rpcWrite : PUBLIC_RATE_LIMITS.rpcRead,
    log: dependencies.log,
    request,
    route: `/rpc/${cluster}`,
    rpcClass,
  });
  const apiKey = typeof env.HELIUS_API_KEY === 'string' ? env.HELIUS_API_KEY.trim() : '';
  if (!apiKey) {
    return {
      response: rpcErrorResponse(origin, requestBody.id, -32099, 'Provider unavailable', 502),
      rpcMethod: requestBody.method,
    };
  }
  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.providerTimeoutMs,
    timeoutMessage: 'RPC provider request timed out',
  });
  try {
    const text = await fetchRpc(cluster, apiKey, requestBody, deadline.signal, dependencies, metrics);
    return {
      response: new Response(text, { status: 200, headers: rpcCorsHeaders(origin) }),
      rpcMethod: requestBody.method,
    };
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    const kind = error instanceof RpcFailure ? error.kind : 'unavailable';
    const timedOut = deadline.timedOut() || kind === 'deadline' || kind === 'timeout';
    return {
      response: rpcErrorResponse(
        origin,
        requestBody.id,
        timedOut ? -32098 : -32099,
        timedOut ? 'Provider timeout' : 'Provider unavailable',
        timedOut ? 504 : 502,
      ),
      rpcMethod: requestBody.method,
    };
  } finally {
    deadline.dispose();
  }
}

export function handleRpcInternalError(request: Request): Response {
  const origin = request.headers.get('Origin');
  return rpcErrorResponse(origin, null, -32603, 'Internal error', 500);
}
