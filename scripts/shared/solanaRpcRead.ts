function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryRpcRead<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 4);
  const baseDelayMs = Math.max(1, opts.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 4_000);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      console.warn(`⚠️  ${label} failed (${err instanceof Error ? err.message : String(err)}). Retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${label} failed after ${retries + 1} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
