import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { withStripeChargebackMaintenance } from '../../../../scripts/shared/stripeChargebackMaintenance.ts';
import type { StripeChargebackMaintenance } from '../src/stripeChargebackMaintenance.ts';

type CallerEnv = { CHARGEBACKS: Service<StripeChargebackMaintenance> };

test('private chargeback maintenance runs through named workerd RPC without exposing runtime capabilities', async () => {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const apiConfig = {
    ...productionConfig,
    main: resolve('cloud/workers/api/src/index.ts'),
    routes: undefined,
    d1_databases: productionConfig.d1_databases.map((database: Record<string, unknown>) => ({
      ...database,
      remote: false,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
    vars: {
      STRIPE_SECRET_KEY: '',
      STRIPE_RESTRICTED_KEY: '',
      STRIPE_SECRET_KEY_LIVE: '',
      STRIPE_RESTRICTED_KEY_LIVE: '',
    },
  };
  delete apiConfig.$schema;
  delete apiConfig.secrets;
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'mons-chargeback-rpc-'));
  const fixturePath = join(fixtureDirectory, 'caller.mjs');
  await writeFile(fixturePath, `
import { stripeRead } from ${JSON.stringify(resolve('cloud/workers/api/src/stripeChargebacks.ts'))};

export default {
  async fetch(request, env) {
    const property = new URL(request.url).pathname.slice(1);
    if (property === 'provider-policy') {
      let errorRedirectRejected = false;
      try {
        new Request('https://api.stripe.com/v1/disputes', { redirect: 'error' });
      } catch {
        errorRedirectRejected = true;
      }
      let observed;
      const result = await stripeRead('disputes', { limit: '10' }, 'test', {
        COMMERCE_DB: {}, STRIPE_SECRET_KEY: 'sk_test_runtime',
      }, {
        signal: request.signal,
        providerFetch: async (input, init) => {
          const providerRequest = new Request(input, init);
          observed = {
            redirect: providerRequest.redirect,
            authorization: providerRequest.headers.get('Authorization'),
            version: providerRequest.headers.get('Stripe-Version'),
            url: providerRequest.url,
          };
          return Response.json({ object: 'list', data: [], has_more: false });
        },
      });
      return Response.json({ result, observed, errorRedirectRejected });
    }
    if (property === 'backfill') return Response.json(await env.CHARGEBACKS.backfill(await request.json()));
    if (property === 'configureWebhooks') return Response.json(await env.CHARGEBACKS.configureWebhooks(await request.json()));
    if (property !== 'env' && property !== 'ctx') return new Response(null, { status: 404 });
    try {
      await env.CHARGEBACKS[property];
      return Response.json({ exposed: true });
    } catch {
      return Response.json({ exposed: false });
    }
  },
};
`, 'utf8');
  const server = createTestHarness({
    root: resolve('.'),
    workers: [
      { config: apiConfig },
      { config: {
        name: 'stripe-chargeback-runtime-caller',
        main: fixturePath,
        compatibility_date: productionConfig.compatibility_date,
        compatibility_flags: productionConfig.compatibility_flags,
        services: [{ binding: 'CHARGEBACKS', service: 'mons-shop-api', entrypoint: 'StripeChargebackMaintenance', remote: false }],
      } },
    ],
  });
  try {
    await server.listen();
    const api = server.getWorker<Env>('mons-shop-api');
    const caller = server.getWorker<CallerEnv>('stripe-chargeback-runtime-caller');
    const providerPolicy = await caller.fetch('https://caller/provider-policy');
    assert.equal(providerPolicy.status, 200);
    assert.deepEqual(await providerPolicy.json(), {
      errorRedirectRejected: true,
      result: { object: 'list', data: [], has_more: false },
      observed: {
        redirect: 'manual',
        authorization: 'Bearer sk_test_runtime',
        version: '2026-07-29.dahlia',
        url: 'https://api.stripe.com/v1/disputes?limit=10',
      },
    });
    const { CHARGEBACKS } = await caller.getEnv();
    assert.equal(typeof CHARGEBACKS.backfill, 'function');
    assert.equal(typeof CHARGEBACKS.configureWebhooks, 'function');
    const call = async (method: 'backfill' | 'configureWebhooks', value: unknown) => {
      const response = await caller.fetch(`https://caller/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const invalid = { ok: false, error: { code: 'invalid-argument', status: 400 } };
    const rawResult = await CHARGEBACKS.backfill({ bad: true });
    assert.deepEqual(Object.keys(rawResult), ['ok', 'error']);
    assert.deepEqual(JSON.parse(JSON.stringify(rawResult)), invalid);
    assert.deepEqual(await Response.json({ ...rawResult, ok: true }).json(), { ...invalid, ok: true });
    let disposed = false;
    const operatorResponse = await withStripeChargebackMaintenance(
      (transport) => transport.backfill({ mode: 'live', cursor: 'invalid' }),
      async () => ({ env: { CHARGEBACKS }, dispose: async () => { disposed = true; } }),
    );
    assert.equal(operatorResponse.status, 400);
    assert.equal(operatorResponse.headers.get('X-Mons-Maintenance-Error'), 'invalid-argument');
    assert.deepEqual(await operatorResponse.json(), { ok: false });
    assert.equal(disposed, true);
    assert.deepEqual(await call('backfill', { bad: true }), invalid);
    assert.deepEqual(await call('configureWebhooks', { bad: true }), invalid);
    for (const property of ['env', 'ctx']) {
      const response = await caller.fetch(`https://caller/${property}`);
      assert.deepEqual(await response.json(), { exposed: false });
    }
    const publicBackfill = await api.fetch('https://api.mons.shop/admin/stripe-chargebacks/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'live' }),
    });
    assert.equal(publicBackfill.status, 401);
    const publicError = await publicBackfill.json() as { error: { code: string } };
    assert.equal(publicError.error.code, 'unauthenticated');

    await api.applyD1Migrations('COMMERCE_DB');
    assert.deepEqual(await call('backfill', { mode: 'live' }), {
      ok: false, error: { code: 'commerce-maintenance', status: 503 },
    });
    const env = await api.getEnv();
    await env.COMMERCE_DB.batch([
      env.COMMERCE_DB.prepare(`INSERT INTO commerce_authority_control_lease (
        singleton, lease_token, acquired_at_ms, expires_at_ms
      ) VALUES (
        1, '00000000-0000-4000-8000-000000000506',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
      )`),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
          updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1 AND authority_state = 'paused' AND paused_at_ms IS NULL`),
      env.COMMERCE_DB.prepare(`UPDATE commerce_authority_control
        SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
          updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE singleton = 1 AND authority_state = 'paused'`),
      env.COMMERCE_DB.prepare(`DELETE FROM commerce_authority_control_lease
        WHERE singleton = 1 AND lease_token = '00000000-0000-4000-8000-000000000506'`),
    ]);
    assert.deepEqual(await call('backfill', { mode: 'live' }), {
      ok: false, error: { code: 'stripe-not-configured', status: 503 },
    });
  } finally {
    await server.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
