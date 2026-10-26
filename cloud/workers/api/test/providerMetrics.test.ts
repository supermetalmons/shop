import assert from 'node:assert/strict';
import test from 'node:test';
import { trackProviderFetch } from '../src/providerMetrics.ts';

test('provider metrics preserve inputs, responses, and synchronous and asynchronous failures', async (context) => {
  let elapsed = 0;
  context.mock.method(performance, 'now', () => elapsed);
  const metrics = { upstreamCalls: 0, providerDurationMs: 0 };
  const response = new Response('ok');
  const failure = new Error('Provider failed');
  const inputs: Parameters<typeof fetch>[] = [];
  const trackedFetch = trackProviderFetch((...args) => {
    inputs.push(args);
    elapsed += 5;
    if (inputs.length === 2) throw failure;
    if (inputs.length === 3) return Promise.reject(failure);
    return Promise.resolve(response);
  }, metrics);
  const input = new URL('https://provider.example');
  const init = { method: 'POST', body: 'payload', signal: new AbortController().signal };

  assert.equal(await trackedFetch(input, init), response);
  assert.equal(response.bodyUsed, false);
  assert.equal(inputs[0][0], input);
  assert.equal(inputs[0][1], init);
  await assert.rejects(trackedFetch(input), (error) => error === failure);
  await assert.rejects(trackedFetch(input), (error) => error === failure);
  assert.deepEqual(metrics, { upstreamCalls: 3, providerDurationMs: 15 });
});

test('concurrent provider calls are counted once and retain separate durations', async (context) => {
  let elapsed = 0;
  context.mock.method(performance, 'now', () => elapsed);
  const metrics = { upstreamCalls: 4, providerDurationMs: 7 };
  const complete: ((response: Response) => void)[] = [];
  const trackedFetch = trackProviderFetch(() => new Promise((resolve) => complete.push(resolve)), metrics);
  const firstResponse = new Response('first');
  const secondResponse = new Response('second');
  const first = trackedFetch('https://provider.example/first');
  elapsed = 2;
  const second = trackedFetch('https://provider.example/second');
  assert.deepEqual(metrics, { upstreamCalls: 6, providerDurationMs: 7 });
  elapsed = 5;
  complete[1](secondResponse);
  assert.equal(await second, secondResponse);
  elapsed = 11;
  complete[0](firstResponse);
  assert.equal(await first, firstResponse);
  assert.deepEqual(metrics, { upstreamCalls: 6, providerDurationMs: 21 });
});
