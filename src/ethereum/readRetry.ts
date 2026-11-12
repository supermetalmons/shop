import type { QueryFunctionContext } from '@tanstack/react-query';
import { EthereumApiError } from './api';
import { EthereumNetworkError } from './request';

type ReadQuery = { state: { error: unknown; fetchFailureReason?: unknown; fetchStatus?: string } };
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const PERMANENT_CODES = new Set(['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found',
  'failed-precondition', 'aborted', 'cancelled', 'transaction-reverted', 'operation-failed', 'operation-ambiguous']);
const MAX_IMMEDIATE_RETRY_DELAY_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const queryCooldowns = new WeakMap<object, EthereumApiError>();

function transient(error: unknown): boolean {
  if (error instanceof EthereumApiError) return TRANSIENT_STATUSES.has(error.status) && !PERMANENT_CODES.has(error.code ?? '');
  return error instanceof EthereumNetworkError || error instanceof DOMException && error.name === 'TimeoutError';
}

function cooldown(error: unknown): number {
  return error instanceof EthereumApiError && error.retryAtMs !== null ? Math.max(0, error.retryAtMs - Date.now()) : 0;
}

export async function runEthereumRead<T>(
  { client, queryKey, signal: querySignal }: Pick<QueryFunctionContext, 'client' | 'queryKey' | 'signal'>,
  read: (signal: AbortSignal) => Promise<T>,
  operationSignal?: AbortSignal,
): Promise<T> {
  querySignal.throwIfAborted();
  const query = client.getQueryCache().find({ queryKey, exact: true });
  const signal = operationSignal ? AbortSignal.any([querySignal, operationSignal]) : querySignal;
  const cancelOperation = () => { if (!querySignal.aborted) void query?.cancel({ revert: true }); };
  operationSignal?.addEventListener('abort', cancelOperation, { once: true });
  try {
    if (operationSignal?.aborted) cancelOperation();
    signal.throwIfAborted();
    const previous = query && queryCooldowns.get(query);
    if (cooldown(previous) > 0) throw previous;
    if (query) queryCooldowns.delete(query);
    const value = await read(signal);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    signal.throwIfAborted();
    if (query && error instanceof EthereumApiError && transient(error) && cooldown(error) > 0) queryCooldowns.set(query, error);
    throw error;
  } finally { operationSignal?.removeEventListener('abort', cancelOperation); }
}

export function ethereumReadRetry(failureCount: number, error: unknown): boolean {
  return failureCount < 2 && transient(error) && cooldown(error) <= MAX_IMMEDIATE_RETRY_DELAY_MS;
}

export function ethereumReadRetryDelay(failureCount: number, error: unknown): number {
  return Math.max(failureCount === 0 ? 1_000 : 2_000, cooldown(error)) + Math.floor(Math.random() * 251);
}

export function ethereumReadCanRefetch(query: ReadQuery): boolean {
  const error = queryCooldowns.get(query) ?? query.state.fetchFailureReason ?? query.state.error;
  return !error || transient(error) && cooldown(error) === 0;
}

export function ethereumReadRefetchInterval(query: ReadQuery, healthyInterval: number | false): number | false {
  const error = queryCooldowns.get(query) ?? query.state.error;
  if (error && !transient(error)) return false;
  const remaining = cooldown(error);
  if (remaining > MAX_TIMER_MS) return false;
  if (healthyInterval === false && (query.state.fetchStatus === 'fetching' || query.state.fetchStatus === 'paused')) return false;
  if (healthyInterval === false) return error instanceof EthereumApiError &&
    (error.retryAfterMs ?? 0) > MAX_IMMEDIATE_RETRY_DELAY_MS && (remaining > 0 || queryCooldowns.has(query)) ? Math.max(1_000, remaining) : false;
  return Math.max(healthyInterval, remaining);
}

export const ethereumReadRetryOptions = {
  retry: ethereumReadRetry,
  retryDelay: ethereumReadRetryDelay,
  refetchOnWindowFocus: ethereumReadCanRefetch,
  refetchOnReconnect: ethereumReadCanRefetch,
  refetchOnMount: ethereumReadCanRefetch,
  retryOnMount: ethereumReadCanRefetch,
};
