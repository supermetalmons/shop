import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSolanaProvider,
  parseSolanaRpcAccount,
  SolanaProviderError,
  type SolanaProviderAttemptEvent,
  type SolanaProviderOptions,
  type SolanaRpcCallOptions,
  type SolanaRetryPolicy,
} from '../src/solanaProvider.ts';

const RETRY_HTTP: SolanaRetryPolicy = {
  attempts: 2,
  delayMs: () => 0,
  shouldRetry: (failure) => failure.kind === 'http' || failure.kind === 'network' ||
    failure.kind === 'timeout' || failure.kind === 'body',
};

function providerOptions(fetch: typeof globalThis.fetch): SolanaProviderOptions {
  return {
    apiKey: 'test-key',
    attemptTimeoutMs: 20,
    cluster: 'devnet',
    fetch,
    maxResponseBytes: 1024,
    requestId: (method) => `test-${method}`,
    retry: RETRY_HTTP,
    signal: new AbortController().signal,
  };
}

test('raw Solana transport cancels non-OK bodies without reading them', async () => {
  let cancelled = false;
  const provider = createSolanaProvider(providerOptions(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    }), { status: 503 })));
  await assert.rejects(provider.rpc('getAsset', {}, {
    retry: { attempts: 1, delayMs: () => 0, shouldRetry: () => false },
  }), (error: unknown) => error instanceof SolanaProviderError && error.kind === 'http' && error.status === 503);
  assert.equal(cancelled, true);
});

test('Solana RPC redirects default to manual and support a per-call follow override', async () => {
  const redirects: Array<RequestRedirect | undefined> = [];
  const providerFetch: typeof fetch = async (_input, init) => {
    redirects.push(init?.redirect);
    const request = JSON.parse(String(init?.body)) as { id: string };
    return Response.json({ jsonrpc: '2.0', id: request.id, result: 'ok' });
  };
  const manual = createSolanaProvider(providerOptions(providerFetch));
  assert.equal(await manual.rpc('getAsset', {}), 'ok');
  assert.equal(await manual.rpc('getAsset', {}, { redirect: 'follow' }), 'ok');
  assert.deepEqual(redirects, ['manual', undefined]);
});

test('truthy malformed RPC errors are rejected only when requested', async () => {
  const provider = createSolanaProvider(providerOptions(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { id: string };
    return Response.json({
      jsonrpc: '2.0',
      id: request.id,
      error: ['malformed'],
      result: 'ok',
    });
  }));

  assert.equal(await provider.rpc('getAsset', {}), 'ok');
  await assert.rejects(
    provider.rpc('getAsset', {}, { errorMode: 'truthy' }),
    (error: unknown) => error instanceof SolanaProviderError && error.kind === 'rpc',
  );
});

test('Solana provider retries configured HTTP failures and preserves RPC failures', async () => {
  let attempts = 0;
  const provider = createSolanaProvider(providerOptions(async (_input, init) => {
    attempts += 1;
    if (attempts === 1) return new Response(null, { status: 503 });
    const request = JSON.parse(String(init?.body)) as { id: string };
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { ok: true } });
  }));
  assert.deepEqual(await provider.rpc('getAsset', {}), { ok: true });
  assert.equal(attempts, 2);

  attempts = 0;
  const failed = createSolanaProvider(providerOptions(async (_input, init) => {
    attempts += 1;
    const request = JSON.parse(String(init?.body)) as { id: string };
    return Response.json({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32000, message: 'terminal', data: { logs: ['failed'] } },
    });
  }));
  await assert.rejects(failed.rpc('sendTransaction', []), (error: unknown) =>
    error instanceof SolanaProviderError &&
    error.kind === 'rpc' &&
    error.rpcCode === -32000 &&
    JSON.stringify(error.rpcData) === JSON.stringify({ logs: ['failed'] }));
  assert.equal(attempts, 1);
});

test('Solana provider preserves parent aborts and validates account payloads', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  const provider = createSolanaProvider({
    ...providerOptions(async () => new Promise<Response>(() => undefined)),
    signal: controller.signal,
  });
  const pending = provider.rpc('getAsset', {});
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);

  const account = parseSolanaRpcAccount({
    owner: '11111111111111111111111111111111',
    data: [Buffer.from([1, 2, 3]).toString('base64'), 'base64'],
  }, { maxEncodedBytes: 32 });
  assert.deepEqual(Array.from(account.data), [1, 2, 3]);
  await assert.rejects(async () => parseSolanaRpcAccount({}, { maxEncodedBytes: 32 }),
    (error: unknown) => error instanceof SolanaProviderError && error.reason === 'account-shape');
});

test('Solana attempt hooks are observational and support per-call overrides', async () => {
  const phases: string[] = [];
  const provider = createSolanaProvider({
    ...providerOptions(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({ jsonrpc: '2.0', id: request.id, result: 'ok' });
    }),
    onAttempt: () => { throw new Error('telemetry failed'); },
  });
  assert.equal(await provider.rpc('getAsset', {}, {
    onAttempt: (event) => phases.push(event.phase),
  }), 'ok');
  assert.deepEqual(phases, ['start', 'success']);

  const throwing = createSolanaProvider({
    ...providerOptions(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({ jsonrpc: '2.0', id: request.id, result: 'ok' });
    }),
    onAttempt: () => { throw new Error('telemetry failed'); },
  });
  assert.equal(await throwing.rpc('getAsset', {}), 'ok');
});

test('asset indexing retries exhausted RPC failures and REST failures retain their method', async () => {
  let attempts = 0;
  const retryOnce: SolanaRetryPolicy = {
    attempts: 1,
    delayMs: () => 0,
    shouldRetry: () => false,
  };
  const provider = createSolanaProvider({
    ...providerOptions(async (_input, init) => {
      attempts += 1;
      const request = JSON.parse(String(init?.body)) as { id: string };
      return attempts === 1
        ? Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'lagging' } })
        : Response.json({ jsonrpc: '2.0', id: request.id, result: { id: 'asset' } });
    }),
    retry: retryOnce,
  });
  assert.deepEqual(await provider.getAsset('asset', {
    indexingRetry: { attempts: 2, baseDelayMs: 0, capDelayToRemaining: true, maxElapsedMs: 1000 },
  }), { id: 'asset' });
  assert.equal(attempts, 2);

  let proofCalls = 0;
  const fallback = createSolanaProvider({
    ...providerOptions(async (_input, init) => {
      proofCalls += 1;
      if (proofCalls === 2) throw new Error('REST failed');
      const request = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'unsupported' },
      });
    }),
    retry: retryOnce,
  });
  await assert.rejects(fallback.getAssetProof('asset', { restRetry: retryOnce }),
    (error: unknown) => error instanceof SolanaProviderError &&
      error.kind === 'network' &&
      error.method === 'getAssetProofRest');
});

test('Solana provider retries body transport failures separately from invalid envelopes', async () => {
  let calls = 0;
  const provider = createSolanaProvider(providerOptions(async (_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as { id: string };
    if (calls === 1) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('connection reset'));
        },
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result: 'ok' });
  }));
  assert.equal(await provider.rpc('getAsset', {}), 'ok');
  assert.equal(calls, 2);

  calls = 0;
  const invalidJson = createSolanaProvider(providerOptions(async (_input, init) => {
    calls += 1;
    if (calls === 1) return new Response('{', { headers: { 'Content-Type': 'application/json' } });
    const request = JSON.parse(String(init?.body)) as { id: string };
    return Response.json({ jsonrpc: '2.0', id: request.id, result: 'ok' });
  }));
  assert.equal(await invalidJson.rpc('getAsset', {}), 'ok');
  assert.equal(calls, 2);

  calls = 0;
  const invalidEnvelope = createSolanaProvider(providerOptions(async (_input, init) => {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as { id: string };
    return Response.json({ jsonrpc: '2.0', id: request.id });
  }));
  await assert.rejects(invalidEnvelope.rpc('getAsset', {}),
    (error: unknown) => error instanceof SolanaProviderError && error.kind === 'invalid-response');
  assert.equal(calls, 1);
});

test('basic Solana envelopes normalize numeric-string fallback codes', async () => {
  const retryOnce: SolanaRetryPolicy = {
    attempts: 1,
    delayMs: () => 0,
    shouldRetry: () => false,
  };
  let assetCalls = 0;
  const assetProvider = createSolanaProvider({
    ...providerOptions(async (_input, init) => {
      assetCalls += 1;
      if (init?.body === undefined) return Response.json([{ id: 'asset' }]);
      const request = JSON.parse(String(init.body)) as { id: string };
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: '-32601', message: 'unsupported' },
      });
    }),
    retry: retryOnce,
  });
  assert.deepEqual(await assetProvider.getAsset('asset', { restRetry: retryOnce }), { id: 'asset' });
  assert.equal(assetCalls, 2);

  let proofCalls = 0;
  const proofProvider = createSolanaProvider({
    ...providerOptions(async (_input, init) => {
      proofCalls += 1;
      if (init?.body === undefined) return Response.json({ root: 'proof' });
      const request = JSON.parse(String(init.body)) as { id: string };
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: '-32602', message: 'unsupported' },
      });
    }),
    retry: retryOnce,
  });
  assert.deepEqual(await proofProvider.getAssetProof('asset', { restRetry: retryOnce }), { root: 'proof' });
  assert.equal(proofCalls, 2);
});

test('Solana provider preserves cancellation reasons that resemble provider failures', async () => {
  const controller = new AbortController();
  let markRead!: () => void;
  const reading = new Promise<void>((resolve) => { markRead = resolve; });
  const reason = new SolanaProviderError('invalid-response', 'cancelled');
  const provider = createSolanaProvider({
    ...providerOptions(async () => Response.json(new ReadableStream())),
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        markRead();
      },
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json' } }),
    signal: controller.signal,
  });
  const pending = provider.rpc('getAsset', {});
  await reading;
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});

type RetryTransport = 'rpc' | 'rest';

function retryTransport(
  transport: RetryTransport,
  providerFetch: typeof fetch,
  overrides: Partial<SolanaProviderOptions> = {},
) {
  const method = transport === 'rpc' ? 'getAssetProof' : 'getAssetProofRest';
  const retry = overrides.retry || RETRY_HTTP;
  const provider = createSolanaProvider({
    ...providerOptions(async (input, init) => {
      if (transport === 'rest' && init?.body !== undefined) {
        const request = JSON.parse(String(init.body)) as { id: string };
        return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } });
      }
      return providerFetch(input, init);
    }),
    ...overrides,
    retry: transport === 'rpc' ? retry : { attempts: 1, delayMs: () => 0, shouldRetry: () => false },
    onAttempt: event => { if (event.method === method) overrides.onAttempt?.(event); },
  });
  return {
    method,
    run: (options: SolanaRpcCallOptions = {}) => transport === 'rpc'
      ? provider.rpc('getAssetProof', { id: 'asset' }, options)
      : provider.getAssetProof('asset', { restRetry: retry }),
  };
}

function retryResponse(transport: RetryTransport, init?: RequestInit): Response {
  const result = { root: 'proof' };
  if (transport === 'rest') return Response.json(result);
  const request = JSON.parse(String(init?.body)) as { id: string };
  return Response.json({ jsonrpc: '2.0', id: request.id, result });
}

for (const transport of ['rpc', 'rest'] as const) {
  test(`${transport} retries preserve event ordering, failure identity, and callback arguments`, async () => {
    const events: SolanaProviderAttemptEvent[] = [];
    const retryCalls: Array<{ callback: string; failure: SolanaProviderError; attemptNumber: number }> = [];
    const requestIds: string[] = [];
    let calls = 0;
    const provider = retryTransport(transport, async (_input, init) => {
      if (init?.body) requestIds.push((JSON.parse(String(init.body)) as { id: string }).id);
      return ++calls === 1 ? new Response(null, { status: 503 }) : retryResponse(transport, init);
    }, {
      onAttempt: event => events.push(event),
      requestId: (method, attemptNumber) => `${method}-${attemptNumber}`,
      retry: {
        attempts: 2,
        shouldRetry: (failure, attemptNumber) => {
          retryCalls.push({ callback: 'shouldRetry', failure, attemptNumber });
          return true;
        },
        delayMs: (failure, attemptNumber) => {
          retryCalls.push({ callback: 'delayMs', failure, attemptNumber });
          return 0;
        },
      },
    });
    assert.deepEqual(await provider.run(), { root: 'proof' });
    assert.deepEqual(events.map(({ phase, attemptNumber, method }) => [phase, attemptNumber, method]), [
      ['start', 1, provider.method], ['failure', 1, provider.method],
      ['start', 2, provider.method], ['success', 2, provider.method],
    ]);
    const failure = events[1].failure!;
    assert.equal(failure.kind, 'http');
    assert.equal(failure.status, 503);
    assert.equal(failure.method, provider.method);
    assert.deepEqual(retryCalls.map(({ callback, attemptNumber }) => [callback, attemptNumber]), [
      ['shouldRetry', 1], ['delayMs', 1],
    ]);
    assert.ok(retryCalls.every(call => call.failure === failure));
    if (transport === 'rpc') assert.deepEqual(requestIds, ['getAssetProof-1', 'getAssetProof-2']);
  });

  test(`${transport} attempt timeouts retry and successful scopes are disposed`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const events: SolanaProviderAttemptEvent[] = [];
    const provider = retryTransport(transport, async (_input, init) => {
      signals.push(init!.signal!);
      if (signals.length > 1) return retryResponse(transport, init);
      started.resolve();
      return new Promise<Response>(() => undefined);
    }, {
      onAttempt: event => events.push(event),
      retry: { ...RETRY_HTTP, delayMs: () => 10 },
    });
    const result = provider.run();
    await started.promise;
    context.mock.timers.tick(20);
    await new Promise(setImmediate);
    assert.equal(events[1].failure?.kind, 'timeout');
    assert.equal(events[1].failure?.method, provider.method);
    assert.equal(events[1].failure?.cause, signals[0].reason);
    context.mock.timers.tick(10);
    assert.deepEqual(await result, { root: 'proof' });
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    context.mock.timers.tick(100);
    assert.equal(signals[1].aborted, false);
    assert.deepEqual(events.map(event => event.phase), ['start', 'failure', 'start', 'success']);
  });

  test(`${transport} null attempt timeout remains cancellable by its parent`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const started = Promise.withResolvers<void>();
    const parent = new AbortController();
    const reason = new SolanaProviderError('invalid-response', 'cancelled by parent');
    const events: SolanaProviderAttemptEvent[] = [];
    let signal: AbortSignal | undefined;
    const provider = retryTransport(transport, async (_input, init) => {
      signal = init?.signal ?? undefined;
      started.resolve();
      return new Promise<Response>(() => undefined);
    }, {
      attemptTimeoutMs: null,
      signal: parent.signal,
      onAttempt: event => events.push(event),
      retry: { attempts: 2, delayMs: () => assert.fail('unexpected delay'), shouldRetry: () => assert.fail('unexpected retry') },
    });
    const rejected = assert.rejects(provider.run(), error => error === reason);
    await started.promise;
    context.mock.timers.tick(1000);
    assert.equal(signal, parent.signal);
    assert.equal(signal?.aborted, false);
    parent.abort(reason);
    await rejected;
    assert.deepEqual(events.map(event => event.phase), ['start']);
  });

  test(`${transport} parent cancellation during backoff prevents another attempt`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const parent = new AbortController();
    const reason = new Error('cancelled during backoff');
    const events: SolanaProviderAttemptEvent[] = [];
    let calls = 0;
    let signal: AbortSignal | undefined;
    const provider = retryTransport(transport, async (_input, init) => {
      calls++;
      signal = init?.signal ?? undefined;
      return new Response(null, { status: 503 });
    }, {
      signal: parent.signal,
      onAttempt: event => events.push(event),
      retry: { ...RETRY_HTTP, delayMs: () => 100 },
    });
    const rejected = assert.rejects(provider.run(), error => error === reason);
    await new Promise(setImmediate);
    context.mock.timers.tick(20);
    assert.equal(signal?.aborted, false);
    parent.abort(reason);
    await rejected;
    context.mock.timers.tick(100);
    assert.equal(calls, 1);
    assert.equal(signal?.aborted, false);
    assert.deepEqual(events.map(event => event.phase), ['start', 'failure']);
  });
}

test('RPC timeout overrides distinguish inheritance, replacement, and disabling', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const attemptTimeoutMs of [undefined, 5, null]) {
    const pending = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined;
    let init: RequestInit | undefined;
    const provider = retryTransport('rpc', async (_input, options) => {
      init = options;
      signal = options?.signal ?? undefined;
      return pending.promise;
    }, { retry: { attempts: 1, delayMs: () => 0, shouldRetry: () => false } });
    const result = provider.run({ attemptTimeoutMs });
    if (attemptTimeoutMs === null) {
      context.mock.timers.tick(100);
      assert.equal(signal?.aborted, false);
      pending.resolve(retryResponse('rpc', init));
      assert.deepEqual(await result, { root: 'proof' });
    } else {
      const rejected = assert.rejects(result, error => error instanceof SolanaProviderError && error.kind === 'timeout');
      const timeout = attemptTimeoutMs ?? 20;
      context.mock.timers.tick(timeout - 1);
      assert.equal(signal?.aborted, false);
      context.mock.timers.tick(1);
      await rejected;
      assert.equal(signal?.aborted, true);
    }
  }
});
