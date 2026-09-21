import {
  HELIUS_SEARCH_ASSETS_MAX_CANDIDATES,
  HELIUS_SEARCH_ASSETS_MAX_CURSOR_PAGES,
  HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES,
  HELIUS_SEARCH_ASSETS_MAX_PROVIDER_CALLS,
  HELIUS_SEARCH_ASSETS_MAX_TOTAL_BYTES,
} from '../../../../shared/heliusDas.js';
import {
  isExactShopInventoryResponse,
  isExactShopPendingOpenBoxesResponse,
} from '../../../../shared/shopApi.js';
import {
  type RpcProviderFetch,
  type RpcProxyDependencies,
  type RpcRequestMetrics,
} from './rpcProxy.js';
import { MAX_INVENTORY_RESPONSE_BODY_BYTES } from './inventoryLimits.js';
import {
  applyPublicCors,
  publicCorsHeaders,
  publicRequestOrigin,
} from './publicRequestPolicy.js';
import {
  readBoundedRequestJson,
  sleepWithSignal,
} from './boundedRequest.js';
import { jsonResponse as sharedJsonResponse } from './httpResponse.js';

const HELIUS_OVERALL_TIMEOUT_MS = 60_000;

const HELIUS_ATTEMPT_TIMEOUT_MS = 15_000;

const EXPECTED_ASSET_RECOVERY_TIMEOUT_MS = 5_000;

const MAX_REQUEST_BODY_BYTES = 1024;

const RESEND_TIMEOUT_MS = 10_000;

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const PUBLIC_JSON_HEADERS = {
  ...CORS_HEADERS,
  'Timing-Allow-Origin': '*',
};

export const BASE_HEADERS = {
  ...PUBLIC_JSON_HEADERS,
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

export type ProviderFetch = RpcProviderFetch;

export type WorkerDependencies = RpcProxyDependencies & {
  cache: Pick<Cache, 'match' | 'put'> | null;
  expectedAssetRecoveryTimeoutMs: number;
  providerMaxResponseBodyBytes: number;
  providerMaxTotalResponseBodyBytes: number;
  inventoryMaxCandidates: number;
  inventoryMaxCursorPages: number;
  inventoryMaxProviderCalls: number;
  inventoryMaxResponseBodyBytes: number;
  resendFetch: ProviderFetch;
  resendTimeoutMs: number;
  validateInventoryResponse: typeof isExactShopInventoryResponse;
  validatePendingOpenBoxesResponse: typeof isExactShopPendingOpenBoxesResponse;
};

export type WorkerRequestMetrics = RpcRequestMetrics & {
  expectedAssetIds: number;
  expectedAssetRecoveryFailures: number;
  expectedAssetResolved: number;
};

export function publicJsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  return sharedJsonResponse(body, status, {
    headers: { ...PUBLIC_JSON_HEADERS, ...headers },
  });
}

export function publicOriginDeniedResponse(): Response {
  return sharedJsonResponse({ ok: false, error: 'invalid-request' }, 403, {
    headers: {
      'Vary': 'Origin',
    },
  });
}

export function handlePublicPreflight(request: Request, allowMethods = 'POST, OPTIONS'): Response {
  const origin = publicRequestOrigin(request);
  if (!origin) return publicOriginDeniedResponse();
  return new Response(null, {
    status: 204,
    headers: {
      ...publicCorsHeaders(origin, allowMethods),
      'Cache-Control': 'no-store',
    },
  });
}

export function handlePublicMethodNotAllowed(request: Request, allowMethods = 'POST, OPTIONS'): Response {
  const origin = publicRequestOrigin(request);
  if (!origin) return publicOriginDeniedResponse();
  return applyPublicCors(
    publicJsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: allowMethods }),
    origin,
    allowMethods,
  );
}

export async function parseJsonRequestBody<T>(
  request: Request,
  validate: (value: unknown) => value is T,
): Promise<T> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: MAX_REQUEST_BODY_BYTES,
    signal: request.signal,
    createError: () => new Error('invalid-request'),
  });
  if (!validate(value)) throw new Error('invalid-request');
  return value;
}

export const sleepWithAbort = sleepWithSignal;

export const defaultDependencies: WorkerDependencies = {
  cache: typeof caches === 'undefined'
    ? null
    : (caches as CacheStorage & { readonly default: Cache }).default,
  expectedAssetRecoveryTimeoutMs: EXPECTED_ASSET_RECOVERY_TIMEOUT_MS,
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
