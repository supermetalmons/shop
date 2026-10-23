import type { SolanaCluster } from '../../../../shared/deploymentCore.js';
import { HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES } from '../../../../shared/heliusDas.js';
import { isTransientShopRpcError } from '../../../../shared/solanaRpcProxy.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { createSolanaProvider, type SolanaRetryPolicy } from './solanaProvider.js';

const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export const SOLANA_READ_RETRY: SolanaRetryPolicy = {
  attempts: 2,
  delayMs: () => 100,
  shouldRetry: (failure) =>
    failure.kind === 'network' ||
    failure.kind === 'timeout' ||
    failure.kind === 'body' ||
    (failure.kind === 'http' && TRANSIENT_HTTP_STATUSES.has(failure.status || 0)),
};

export const SOLANA_TRANSIENT_RPC_READ_RETRY: SolanaRetryPolicy = {
  ...SOLANA_READ_RETRY,
  shouldRetry: (failure, attemptNumber) =>
    SOLANA_READ_RETRY.shouldRetry(failure, attemptNumber) ||
    (failure.kind === 'rpc' && isTransientShopRpcError({
      code: failure.rpcCode,
      message: failure.message,
      ...(failure.rpcData === undefined ? {} : { data: failure.rpcData }),
    })),
};

export const SOLANA_REST_READ_RETRY: SolanaRetryPolicy = {
  ...SOLANA_READ_RETRY,
  shouldRetry: (failure, attemptNumber) =>
    failure.kind === 'invalid-response' || SOLANA_READ_RETRY.shouldRetry(failure, attemptNumber),
};

export const SOLANA_SINGLE_ATTEMPT: SolanaRetryPolicy = {
  attempts: 1,
  delayMs: () => 100,
  shouldRetry: () => false,
};

export type SolanaReadProviderContext = {
  apiKey: string;
  providerFetch: ProfileProviderFetch;
  signal: AbortSignal;
  attemptTimeoutMs?: number;
};

export function createSolanaReadProvider(
  context: SolanaReadProviderContext,
  cluster: SolanaCluster,
  requestIdPrefix: string,
  retry: SolanaRetryPolicy,
) {
  return createSolanaProvider({
    apiKey: context.apiKey,
    attemptTimeoutMs: context.attemptTimeoutMs ?? 8_000,
    cluster,
    fetch: context.providerFetch,
    maxResponseBytes: HELIUS_SEARCH_ASSETS_MAX_PAGE_BYTES,
    requestId: (method) => `${requestIdPrefix}-${method}`,
    retry,
    signal: context.signal,
  });
}
