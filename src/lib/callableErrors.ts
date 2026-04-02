export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type RetryWithBackoffOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
};

export function isRetryableCallableError(err: unknown): boolean {
  const anyErr = err as any;
  const code = typeof anyErr?.code === 'string' ? anyErr.code : '';
  const normalized = code.startsWith('functions/') ? code.slice('functions/'.length) : code;

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
