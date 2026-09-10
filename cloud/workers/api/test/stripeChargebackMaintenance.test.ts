import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1Harness } from './commerceD1Harness.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';
import { createDeferredWorkCollector } from './deferredWork.ts';

const { StripeChargebackMaintenance } = await loadCloudflareWorkersModule(() => import('../src/stripeChargebackMaintenance.ts'));

function maintenance(db: D1Database, overrides: Partial<Env> = {}) {
  const deferred = createDeferredWorkCollector();
  const instance = new StripeChargebackMaintenance({ waitUntil: deferred.defer } as ExecutionContext, {
    COMMERCE_DB: db,
    ...overrides,
  } as Env);
  return { instance, drain: deferred.drain };
}

test('private chargeback maintenance exposes only narrow operations and strictly validates input', async () => {
  const harness = createCommerceD1Harness();
  const { instance } = maintenance(harness.db);
  assert.deepEqual(Object.getOwnPropertyNames(StripeChargebackMaintenance.prototype).sort(), [
    'backfill', 'configureWebhooks', 'constructor',
  ]);
  for (const input of [null, {}, { mode: 'all' }, { mode: 'live', cursor: 'invalid' }, { mode: 'live', write: 'true' },
    { mode: 'live', path: '/refunds' }, { mode: 'live', env: {} }]) {
    assert.deepEqual(await instance.backfill(input), { ok: false, error: { code: 'invalid-argument', status: 400 } });
  }
  for (const input of [null, {}, { mode: 'test', url: 'https://unrelated.example' }, { mode: 'test', cursor: 'du_other' }]) {
    assert.deepEqual(await instance.configureWebhooks(input), { ok: false, error: { code: 'invalid-argument', status: 400 } });
  }
  harness.database.close();
});

test('private chargeback maintenance returns safe coded credential failures', async () => {
  const harness = createCommerceD1Harness();
  const { instance, drain } = maintenance(harness.db);
  assert.deepEqual(await instance.backfill({ mode: 'live' }), {
    ok: false, error: { code: 'stripe-not-configured', status: 503 },
  });
  assert.deepEqual(await instance.configureWebhooks({ mode: 'test' }), {
    ok: false, error: { code: 'stripe-not-configured', status: 503 },
  });
  await drain();
  harness.database.close();
});

test('private chargeback maintenance retains server-side secrets and defaults to dry run', async (context) => {
  const harness = createCommerceD1Harness();
  const before = JSON.stringify(harness.database.prepare('SELECT * FROM commerce_authority_control').all());
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.stripe.com');
    assert.equal(url.pathname, '/v1/disputes');
    assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk_live_maintenance_fixture');
    return Response.json({ object: 'list', data: [], has_more: false });
  });
  const { instance, drain } = maintenance(harness.db, { STRIPE_SECRET_KEY_LIVE: 'sk_live_maintenance_fixture' });
  const result = await instance.backfill({ mode: 'live' });
  assert.deepEqual(result, {
    mode: 'live', write: false, nextCursor: null, scanned: 0,
    matchedOrders: 0, inserted: 0, existing: 0, unrelated: 0, failures: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /sk_live_|Authorization/);
  assert.equal(JSON.stringify(harness.database.prepare('SELECT * FROM commerce_authority_control').all()), before);
  await drain();
  harness.database.close();
});

test('private chargeback maintenance honors the commerce maintenance pause', async (context) => {
  const harness = createCommerceD1Harness();
  const prepare = harness.db.prepare.bind(harness.db);
  context.mock.method(harness.db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    context.mock.method(statement, 'first', async () => ({ authority_state: 'paused', revision: 2, documents_revision: 0 }));
    return statement;
  });
  const { instance } = maintenance(harness.db);
  for (const result of [await instance.backfill({ mode: 'live', write: true }),
    await instance.configureWebhooks({ mode: 'live', write: true })]) {
    assert.deepEqual(result, { ok: false, error: { code: 'commerce-maintenance', status: 503 } });
  }
  harness.database.close();
});
