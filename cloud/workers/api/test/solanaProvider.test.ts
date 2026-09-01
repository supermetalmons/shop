import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSolanaProvider,
  parseSolanaRpcAccount,
  SolanaProviderError,
  type SolanaProviderOptions,
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
