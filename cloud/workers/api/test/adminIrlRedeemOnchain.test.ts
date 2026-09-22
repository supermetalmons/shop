import assert from 'node:assert/strict';
import test from 'node:test';
import { rpcCall } from '../src/adminIrlRedeemOnchain.ts';
import { buildRuntime } from '../src/adminIrlRedeemRuntime.ts';
import { API_DROPS } from '../src/dropConfig.ts';

test('Admin IRL provider retries one transient response and bounds provider JSON', async () => {
  const runtime = buildRuntime(API_DROPS.card_nft_2);
  let calls = 0;
  const result = await rpcCall({
    apiKey: 'helius-test-key',
    attemptTimeoutMs: 1000,
    providerFetch: async (_input, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { id: string };
      return calls === 1
        ? new Response(null, { status: 503 })
        : Response.json({ jsonrpc: '2.0', id: body.id, result: { value: 7 } });
    },
    signal: new AbortController().signal,
  }, runtime, 'testMethod', []);
  assert.deepEqual(result, { value: 7 });
  assert.equal(calls, 2);

  await assert.rejects(
    rpcCall({
      apiKey: 'helius-test-key',
      attemptTimeoutMs: 1000,
      providerFetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { id: string };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'x'.repeat(3_000_000) }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
      signal: new AbortController().signal,
    }, runtime, 'testMethod', []),
    (error) => (error as { code?: unknown }).code === 'unavailable',
  );
});

test('Admin IRL provider preserves abort-first and provider-first outcomes', async () => {
  const runtime = buildRuntime(API_DROPS.card_nft_2);
  const cancellation = new AbortController();
  const reason = new Error('client disconnected');
  await assert.rejects(
    rpcCall({
      apiKey: 'helius-test-key',
      attemptTimeoutMs: 1000,
      providerFetch: async () => {
        cancellation.abort(reason);
        throw new Error('provider failed after cancellation');
      },
      signal: cancellation.signal,
    }, runtime, 'testMethod', []),
    (error: unknown) => error === reason,
  );

  const race = new AbortController();
  const providerError = new Error('provider failed first');
  let rejectProvider!: (error: unknown) => void;
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
  const providerFirst = assert.rejects(
    rpcCall({
      apiKey: 'helius-test-key',
      attemptTimeoutMs: 1000,
      providerFetch: () => new Promise((_resolve, reject) => {
        rejectProvider = reject;
        markProviderStarted();
      }),
      signal: race.signal,
    }, runtime, 'testMethod', []),
    (error: unknown) => error !== race.signal.reason &&
      (error as { code?: unknown }).code === 'unavailable',
  );
  await providerStarted;
  rejectProvider(providerError);
  queueMicrotask(() => race.abort(new Error('late client disconnect')));
  await providerFirst;
});
