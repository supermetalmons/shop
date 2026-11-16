import { isSignalCancellationError, sleepWithSignal } from '../boundedRequest.js';
import type { CommerceDocumentKey } from '../commerceRepository.js';
import type { StripeCheckoutCommerceContext } from './commerce.js';
import { StaleStripeCheckoutProcessingAttemptError, StripeCheckoutFulfillmentError } from './errors.js';
import {
  recordStripeCheckoutRetryableFulfillmentError,
  STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS,
} from './store.js';

const STRIPE_CHECKOUT_FULFILLMENT_RETRY_DELAY_MS = 1_000;
const RETRYABLE_STRIPE_FULFILLMENT_CODES = new Set([
  'aborted',
  'deadline-exceeded',
  'internal',
  'resource-exhausted',
  'unavailable',
]);
const RETRYABLE_GRPC_STATUS_CODES = new Set([4, 8, 10, 13, 14]);

function errorStatusCode(err: unknown): number | null {
  const anyErr = err as any;
  const candidates = [anyErr?.statusCode, anyErr?.status, anyErr?.response?.status, anyErr?.raw?.statusCode];
  for (const candidate of candidates) {
    const statusCode = Number(candidate);
    if (Number.isFinite(statusCode) && statusCode > 0) return Math.floor(statusCode);
  }
  return null;
}

function errorCodeValues(err: unknown): Array<string | number> {
  const anyErr = err as any;
  return [
    anyErr?.code,
    anyErr?.details?.code,
    anyErr?.cause?.code,
    typeof anyErr?.status === 'string' ? anyErr.status : undefined,
    typeof anyErr?.details?.status === 'string' ? anyErr.details.status : undefined,
    typeof anyErr?.cause?.status === 'string' ? anyErr.cause.status : undefined,
  ].filter((value) => value != null);
}

function looksLikeTransientProviderMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('deadline exceeded') ||
    m.includes('fetch failed') ||
    m.includes('socket hang up') ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('service unavailable') ||
    m.includes('gateway timeout') ||
    (m.includes('rpc') && m.includes('error'))
  );
}

export function isRetryableStripeCheckoutFulfillmentError(err: unknown): boolean {
  const errorType = String((err as any)?.type || (err as any)?.rawType || '');
  if (errorType === 'StripeConnectionError') return true;

  const statusCode = errorStatusCode(err);
  if (statusCode === 408 || statusCode === 409 || statusCode === 429) return true;
  if (statusCode != null && statusCode >= 500) return true;

  for (const code of errorCodeValues(err)) {
    if (typeof code === 'number' && RETRYABLE_GRPC_STATUS_CODES.has(code)) return true;
    const normalized = String(code).trim().toLowerCase().replace(/_/g, '-');
    if (RETRYABLE_STRIPE_FULFILLMENT_CODES.has(normalized)) return true;
    const numericCode = Number(normalized);
    if (Number.isFinite(numericCode) && RETRYABLE_GRPC_STATUS_CODES.has(numericCode)) return true;
  }

  const message = err instanceof Error ? err.message : String(err || '');
  return looksLikeTransientProviderMessage(message);
}

export function normalizeFulfillmentCancellation(error: unknown, signal?: AbortSignal): unknown {
  if (!signal || !isSignalCancellationError(signal, error)) return error;
  if (error instanceof StripeCheckoutFulfillmentError) return error;
  const timedOut = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
  const cancellation = new StripeCheckoutFulfillmentError(
    timedOut ? 'deadline-exceeded' : 'aborted',
    timedOut ? 'Stripe checkout fulfillment timed out' : 'Stripe checkout fulfillment was cancelled',
  );
  Object.defineProperty(cancellation, 'cause', { value: signal.reason });
  return cancellation;
}

export async function runStripeCheckoutFulfillmentWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  params: {
    commerce: StripeCheckoutCommerceContext;
    checkoutKey: CommerceDocumentKey<'stripe_checkout'>;
    summarizeError: (err: unknown) => unknown;
    maxAttempts?: number;
    retryDelayMs?: number;
    processingAttemptId?: string;
    signal?: AbortSignal;
  },
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(Number(params.maxAttempts ?? STRIPE_CHECKOUT_FULFILLMENT_MAX_ATTEMPTS)));
  const retryDelayMs = Math.max(0, Math.floor(Number(params.retryDelayMs ?? STRIPE_CHECKOUT_FULFILLMENT_RETRY_DELAY_MS)));
  const signal = params.signal || new AbortController().signal;
  let attempt = 1;

  while (true) {
    signal.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (err) {
      if (signal.aborted || attempt >= maxAttempts || !isRetryableStripeCheckoutFulfillmentError(err)) throw err;

      const retryRecordStatus = await recordStripeCheckoutRetryableFulfillmentError({
        commerce: params.commerce,
        checkoutKey: params.checkoutKey,
        summarizeError: params.summarizeError,
        err,
        attempt,
        retryDelayMs,
        processingAttemptId: params.processingAttemptId,
      });
      if (retryRecordStatus === 'stale') throw new StaleStripeCheckoutProcessingAttemptError();
      try {
        await sleepWithSignal(retryDelayMs, signal);
      } catch (error) {
        if (isSignalCancellationError(signal, error)) throw err;
        throw error;
      }
      attempt += 1;
    }
  }
}
