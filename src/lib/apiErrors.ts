import {
  STRIPE_OWNER_MERGE_LIMIT_ERROR_REASON,
  WALLET_SESSION_SUPERSEDED_ERROR_REASON,
  normalizeApiErrorCode,
} from '../../shared/apiErrorCode';

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type RetryWithBackoffOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
};

export function isRetryableApiError(err: unknown): boolean {
  const anyErr = err as any;
  const code = typeof anyErr?.code === 'string' ? anyErr.code : '';
  const normalized = normalizeApiErrorCode(code);
  const reason = typeof anyErr?.details?.reason === 'string' ? anyErr.details.reason : '';

  if (
    reason === STRIPE_OWNER_MERGE_LIMIT_ERROR_REASON ||
    reason === WALLET_SESSION_SUPERSEDED_ERROR_REASON
  ) {
    return false;
  }

  if (
    normalized === 'unavailable' ||
    normalized === 'deadline-exceeded' ||
    normalized === 'resource-exhausted' ||
    normalized === 'internal' ||
    normalized === 'unknown' ||
    normalized === 'cancelled' ||
    normalized === 'aborted'
  ) {
    return true;
  }

  const message = typeof anyErr?.message === 'string' ? anyErr.message : '';
  if (err instanceof TypeError && /fetch/i.test(message)) return true;
  if (/network|timeout|temporarily unavailable|connection/i.test(message.toLowerCase())) return true;
  return false;
}

export function isRetryableReceiptIssuanceError(err: unknown): boolean {
  if (isRetryableApiError(err)) return true;
  const anyErr = err as { code?: unknown; message?: unknown };
  return normalizeApiErrorCode(typeof anyErr?.code === 'string' ? anyErr.code : '') === 'failed-precondition' &&
    anyErr?.message === 'Delivery transaction not found or failed.';
}

export async function retryWithBackoff<T>(operation: () => Promise<T>, options: RetryWithBackoffOptions): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitterRatio = 0,
    shouldRetry,
  } = options;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) throw err;
      if (shouldRetry && !shouldRetry(err, attempt)) throw err;

      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitterMs = jitterRatio > 0 ? Math.round(delayMs * jitterRatio * Math.random()) : 0;
      await sleep(delayMs + jitterMs);
    }
  }

  throw (lastErr ?? new Error('Retry failed'));
}
