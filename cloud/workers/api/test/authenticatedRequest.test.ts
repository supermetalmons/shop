import assert from 'node:assert/strict';
import test from 'node:test';
import { withAuthenticatedRequest } from '../src/authenticatedRequest.ts';

type RequestOptions = Parameters<typeof withAuthenticatedRequest>[1];

function options(overrides: Partial<RequestOptions['dependencies']> = {}): RequestOptions {
  return {
    opsDb: undefined,
    timeoutMessage: 'Authenticated request timed out',
    dependencies: {
      nowMs: () => 1_700_000_000_000,
      providerFetch: async () => assert.fail('Unexpected provider fetch'),
      timeoutMs: 100,
      verifyIdentity: async () => ({ kind: 'anonymous', authSubject: 'subject' }),
      ...overrides,
    },
  };
}

test('authenticated requests verify identity and read the clock only when requested', async () => {
  const request = new Request('https://api.mons.shop/test');
  let clockReads = 0;
  let verificationCalls = 0;
  let requestSignal: AbortSignal | undefined;
  const identity = { kind: 'anonymous' as const, authSubject: 'subject' };
  const result = await withAuthenticatedRequest(request, options({
    nowMs: () => {
      clockReads += 1;
      return 123;
    },
    verifyIdentity: async (input, db, signal, nowMs) => {
      verificationCalls += 1;
      assert.equal(input, request);
      assert.equal(db, undefined);
      assert.equal(signal, requestSignal);
      assert.equal(nowMs, 123);
      return identity;
    },
  }), async ({ deadline, authenticate }) => {
    requestSignal = deadline.signal;
    assert.equal(clockReads, 0);
    assert.equal(verificationCalls, 0);
    return authenticate();
  });
  assert.equal(result, identity);
  assert.equal(clockReads, 1);
  assert.equal(verificationCalls, 1);

  await withAuthenticatedRequest(request, options({
    nowMs: () => assert.fail('Unused authentication read the clock'),
    verifyIdentity: async () => assert.fail('Unused authentication ran'),
  }), async () => undefined);
});

test('authenticated request metrics include successful and throwing provider calls', async (context) => {
  let elapsed = 0;
  context.mock.method(performance, 'now', () => elapsed);
  const response = new Response('ok');
  const failure = new Error('Provider failed');
  let calls = 0;
  const metrics = await withAuthenticatedRequest(new Request('https://api.mons.shop/test'), options({
    providerFetch: () => {
      calls += 1;
      elapsed += calls === 1 ? 5 : 9;
      if (calls === 2) throw failure;
      return Promise.resolve(response);
    },
  }), async ({ trackedFetch, metrics }) => {
    assert.equal(await trackedFetch('https://provider.example/first'), response);
    await assert.rejects(trackedFetch('https://provider.example/second'), (error) => error === failure);
    return metrics;
  });
  assert.deepEqual(metrics, { upstreamCalls: 2, providerDurationMs: 14 });
});

test('authenticated requests dispose deadlines after success and failure', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const request = new Request('https://api.mons.shop/test');
  const signals: AbortSignal[] = [];
  const failure = new Error('Handler failed');
  const result = await withAuthenticatedRequest(request, options(), async ({ deadline }) => {
    signals.push(deadline.signal);
    return 'done';
  });
  assert.equal(result, 'done');
  await assert.rejects(withAuthenticatedRequest(request, options(), async ({ deadline }) => {
    signals.push(deadline.signal);
    throw failure;
  }), (error) => error === failure);
  context.mock.timers.tick(100);
  assert.equal(signals.length, 2);
  assert.equal(signals.every((signal) => !signal.aborted), true);
});

test('authenticated request deadlines signal the callback without racing its result', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  const operation = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  let settled = false;
  const pending = withAuthenticatedRequest(new Request('https://api.mons.shop/test'), options(), async ({ deadline }) => {
    signal = deadline.signal;
    await operation;
    return 'finished';
  });
  void pending.then(() => { settled = true; });
  context.mock.timers.tick(100);
  await Promise.resolve();
  assert.ok(signal?.aborted);
  assert.equal((signal.reason as Error).message, 'Authenticated request timed out');
  assert.equal(settled, false);
  release();
  assert.equal(await pending, 'finished');
});
