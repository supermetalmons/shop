import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { ProviderBudgetGrant, ProviderLane } from '../src/ethereumProviderBudget.ts';

async function runtimeFixture() {
  const source = `
    export { EthereumProviderBudgetObject } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumProviderBudgetObject.ts'))};
    export default { async fetch(request, env) {
      const body = await request.json();
      const target = env.BUDGET.getByName(body.provider);
      if (body.action === 'throttle') {
        await target.reportThrottle({ provider: body.provider, retryAfterMs: body.retryAfterMs });
        return Response.json({ ok: true });
      }
      if (body.action === 'acquire') return Response.json(await target.acquirePublic(body));
      if (body.action === 'cancel') {
        await target.cancelPublic(body);
        return Response.json({ ok: true });
      }
      return Response.json(await target.grant(body));
    } };
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  const runtime = new Miniflare({ unsafeInspectDurableObjects: true, workers: [{ config: {
    name: 'provider-budget-runtime', compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'budget.mjs', modulesRoot: resolve('.'), modules: {
      'budget.mjs': { type: 'esm', contents: bundle.outputFiles[0].text },
    } },
    env: { BUDGET: { type: 'durable-object', worker: 'provider-budget-runtime', exportName: 'EthereumProviderBudgetObject' } },
    exports: { EthereumProviderBudgetObject: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  const run = async (input: Record<string, unknown>) => {
    const response = await runtime.dispatchFetch('https://budget.test/', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'alchemy', ...input }) });
    assert.equal(response.status, 200);
    return response.json() as Promise<ProviderBudgetGrant>;
  };
  return { runtime, run };
}

test('native provider budget serializes grants and preserves quota and cooldown across eviction', { timeout: 30_000 }, async () => {
  const { runtime, run } = await runtimeFixture();
  try {
    await run({ lane: 'public', minimum: 1, wanted: 1 });
    const storage = await runtime.unsafeGetDurableObjectStorage('provider-budget-runtime', 'EthereumProviderBudgetObject', { name: 'alchemy' });
    const now = Date.now() + 60_000;
    await storage.exec('UPDATE provider_budget_control SET updated_at_ms=?', now);
    await storage.exec("UPDATE provider_budget_pools SET demanded_at_ms=?,credits=CASE pool WHEN 'shared' THEN 250000 WHEN 'reveal' THEN 150000 ELSE 100000 END", now);
    const burst = async (lane: ProviderLane, count: number) => Promise.all(Array.from({ length: count }, (_, index) =>
      run({ lane, minimum: 10, wanted: 10, requestId: `${lane}-${index}` })));
    const publicResults = await burst('public', 50);
    assert.equal(publicResults.reduce((total, value) => total + value.granted, 0), 250);
    await runtime.unsafeEvictDurableObject('provider-budget-runtime', 'EthereumProviderBudgetObject', { name: 'alchemy' });
    assert.equal((await run({ lane: 'public', minimum: 1, wanted: 1 })).granted, 0);
    assert.equal((await burst('reveal', 30)).reduce((total, value) => total + value.granted, 0), 150);
    assert.equal((await burst('background', 20)).reduce((total, value) => total + value.granted, 0), 100);
    await run({ action: 'throttle', retryAfterMs: 5000 });
    await runtime.unsafeEvictDurableObject('provider-budget-runtime', 'EthereumProviderBudgetObject', { name: 'alchemy' });
    const blocked = await run({ lane: 'reveal', minimum: 1, wanted: 1 });
    assert.equal(blocked.granted, 0);
    assert.equal(blocked.retryAfterMs, 5000);
    assert.deepEqual(await run({ lane: 'public', minimum: 10, wanted: 10, requestId: 'public-0' }), publicResults[0]);
  } finally { await runtime.dispose(); }
});

test('native public acquisition can be cancelled while waiting and replays terminal results after eviction', { timeout: 30_000 }, async () => {
  const { runtime, run } = await runtimeFixture();
  const evict = () => runtime.unsafeEvictDurableObject('provider-budget-runtime', 'EthereumProviderBudgetObject', { name: 'alchemy' });
  try {
    const issuedRequest = { action: 'acquire', minimum: 26, deadlineMs: Date.now() + 1000, requestId: 'issued' };
    const issued = await run(issuedRequest);
    assert.equal(issued.granted, 26);
    assert.equal(issued.expiresAtMs - issued.issuedAtMs, 1000);
    await evict();
    assert.deepEqual(await run(issuedRequest), issued);
    await run({ ...issuedRequest, action: 'cancel' });
    assert.deepEqual(await run(issuedRequest), issued);

    await run({ action: 'throttle', retryAfterMs: 5000 });
    const queuedRequest = { action: 'acquire', minimum: 26, deadlineMs: Date.now() + 1000, requestId: 'queued' };
    const pending = run(queuedRequest);
    const duplicate = run(queuedRequest);
    await run({ ...queuedRequest, action: 'cancel' });
    const [cancelled, replayed] = await Promise.all([pending, duplicate]);
    assert.equal(cancelled.granted, 0);
    assert.ok(cancelled.retryAfterMs >= 1000);
    assert.deepEqual(replayed, cancelled);

    const earlyRequest = { action: 'acquire', minimum: 1, deadlineMs: Date.now() + 1000, requestId: 'cancel-before-enqueue' };
    await run({ ...earlyRequest, action: 'cancel' });
    const early = await run(earlyRequest);
    assert.equal(early.granted, 0);
    await evict();
    assert.deepEqual(await run(queuedRequest), cancelled);
    assert.deepEqual(await run(earlyRequest), early);

    const expired = await run({ action: 'acquire', minimum: 1, deadlineMs: Date.now() + 50, requestId: 'deadline' });
    assert.equal(expired.granted, 0);
    assert.ok(expired.retryAfterMs >= 1000);
  } finally { await runtime.dispose(); }
});
