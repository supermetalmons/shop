type ProviderMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export function trackProviderFetch(providerFetch: typeof fetch, metrics: ProviderMetrics): typeof fetch {
  return async (input, init) => {
    const startedAt = performance.now();
    metrics.upstreamCalls += 1;
    try {
      return await providerFetch(input, init);
    } finally {
      metrics.providerDurationMs += Math.max(0, performance.now() - startedAt);
    }
  };
}
