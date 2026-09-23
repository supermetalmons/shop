export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number, signal: AbortSignal) => Promise<R>,
  options: { signal: AbortSignal },
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  const cancellation = new AbortController();
  const signal = AbortSignal.any([options.signal, cancellation.signal]);
  signal.throwIfAborted();
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && nextIndex < values.length) {
      try {
        signal.throwIfAborted();
        const index = nextIndex++;
        results[index] = await mapper(values[index], index, signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          cancellation.abort(error);
        }
      }
    }
  }));
  if (failed) throw failure;
  signal.throwIfAborted();
  return results;
}
