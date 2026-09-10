import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createStripeChargebackCheckpointStore,
  parseStripeChargebackBackfillArgs,
  runStripeChargebackBackfill,
  runStripeChargebackWebhookConfiguration,
} from '../scripts/ops/backfillStripeChargebacks.ts';
import { stripeChargebackMaintenanceFailureCode, withStripeChargebackMaintenance } from '../scripts/shared/stripeChargebackMaintenance.ts';
import { STRIPE_DISPUTE_EVENT_TYPES, type StripeChargebackBackfillResult } from '../shared/stripeChargebacks.ts';

type Dependencies = Parameters<typeof runStripeChargebackBackfill>[2];
type Checkpoint = Parameters<Dependencies['store']['save']>[0];
const TOKEN = 'test-session-secret';
const ENDPOINT = 'https://api.mons.shop/admin/stripe-chargebacks/backfill';

function batch(overrides: Partial<StripeChargebackBackfillResult> = {}): Response {
  return Response.json({
    ok: true,
    mode: 'live', write: false, nextCursor: null,
    scanned: 1, matchedOrders: 1, inserted: 0, existing: 0, unrelated: 0,
    failures: [],
    ...overrides,
  });
}

function fixture(responses: Array<Response | Error>) {
  const checkpoints = new Map<string, Checkpoint>();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logs: string[] = [];
  const delays: number[] = [];
  const key = (mode: string, write: boolean) => `${mode}:${write}`;
  const dependencies: Dependencies = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'Expected a prepared response');
      return response;
    },
    sleep: async (delayMs) => { delays.push(delayMs); },
    nowMs: () => Date.UTC(2026, 8, 10),
    log: (message) => { logs.push(message); },
    store: {
      load: (mode, write) => structuredClone(checkpoints.get(key(mode, write))),
      save: (checkpoint) => { checkpoints.set(key(checkpoint.mode, checkpoint.write), structuredClone(checkpoint)); },
    },
  };
  return { dependencies, checkpoints, calls, logs, delays, responses };
}

function body(call: { init: RequestInit }) {
  return JSON.parse(String(call.init.body));
}

test('chargeback runner defaults to both modes and dry run, with explicit write and restart', () => {
  assert.deepEqual(parseStripeChargebackBackfillArgs([]), { modes: ['live', 'test'], write: false, restart: false, cloudflare: false, configureWebhooks: false });
  assert.deepEqual(parseStripeChargebackBackfillArgs(['--mode', 'test', '--write', '--restart']), {
    modes: ['test'], write: true, restart: true, cloudflare: false, configureWebhooks: false,
  });
  assert.deepEqual(parseStripeChargebackBackfillArgs(['--mode', 'both']).modes, ['live', 'test']);
  for (const argv of [
    ['--write', '--write'], ['--mode'], ['--mode', 'unknown'],
    ['--url', 'https://untrusted.example'], ['--token', TOKEN],
    ['--configure-webhooks'], ['--cloudflare', '--configure-webhooks', '--restart'],
  ]) {
    assert.throws(() => parseStripeChargebackBackfillArgs(argv), (error: Error) => !error.message.includes(TOKEN));
  }
});

test('chargeback runner scans every cursor and both modes using a pinned authenticated endpoint', async () => {
  const f = fixture([
    batch({ scanned: 10, matchedOrders: 8, unrelated: 2, nextCursor: 'du_page1' }),
    batch({ scanned: 1, matchedOrders: 0, unrelated: 1 }),
    batch({ mode: 'test', scanned: 0, matchedOrders: 0 }),
  ]);
  const results = await runStripeChargebackBackfill(parseStripeChargebackBackfillArgs([]), TOKEN, f.dependencies);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].totals, { scanned: 11, matchedOrders: 8, inserted: 0, existing: 0, unrelated: 3 });
  assert.deepEqual(f.calls.map(body), [
    { mode: 'live', write: false },
    { mode: 'live', write: false, cursor: 'du_page1' },
    { mode: 'test', write: false },
  ]);
  for (const call of f.calls) {
    assert.equal(call.url, ENDPOINT);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.has('Origin'), false);
  }
  assert.ok([...f.checkpoints.values()].every((checkpoint) => checkpoint.complete));
  assert.equal(JSON.stringify([...f.checkpoints]).includes(TOKEN), false);
  assert.equal(f.logs.join('\n').includes(TOKEN), false);
});

test('chargeback runner retries identical batches for rate limits, server errors and network failures', async () => {
  const f = fixture([
    new Response(TOKEN, { status: 429, headers: { 'Retry-After': '300' } }),
    new Response(TOKEN, { status: 503, headers: { 'Retry-After': 'Thu, 10 Sep 2026 00:00:07 GMT' } }),
    new Error(TOKEN),
    batch(),
  ]);
  await runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live']), TOKEN, f.dependencies);
  assert.deepEqual(f.delays, [30_000, 7_000, 4_000]);
  assert.ok(f.calls.every((call) => call.init.body === f.calls[0].init.body));
  assert.equal(f.logs.join('\n').includes(TOKEN), false);
});

test('chargeback runner stops after five transient attempts without losing the current cursor', async () => {
  const f = fixture([
    batch({ nextCursor: 'du_resume' }),
    ...Array.from({ length: 5 }, () => new Response(TOKEN, { status: 503 })),
  ]);
  const args = parseStripeChargebackBackfillArgs(['--mode', 'live']);
  await assert.rejects(runStripeChargebackBackfill(args, TOKEN, f.dependencies), /after five attempts/);
  assert.equal(f.calls.length, 6);
  assert.equal(f.checkpoints.get('live:false').cursor, 'du_resume');
  assert.equal(f.checkpoints.get('live:false').complete, false);
  assert.equal(f.logs.some((message) => message.includes('full history complete')), false);
  f.responses.push(batch({ scanned: 2, matchedOrders: 2 }));
  const result = await runStripeChargebackBackfill(args, TOKEN, f.dependencies);
  assert.equal(body(f.calls[6]).cursor, 'du_resume');
  assert.equal(result[0].totals.scanned, 3);
});

test('chargeback runner requires an existing token and never retries authorization failures', async () => {
  for (const token of [undefined, '', '  secret', 'secret\n']) {
    const f = fixture([]);
    await assert.rejects(runStripeChargebackBackfill(parseStripeChargebackBackfillArgs([]), token, f.dependencies), /MONS_STAFF_SESSION_TOKEN/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.checkpoints.size, 0);
  }
  for (const status of [401, 403]) {
    const f = fixture([new Response(TOKEN, { status })]);
    await assert.rejects(runStripeChargebackBackfill(parseStripeChargebackBackfillArgs([]), TOKEN, f.dependencies), /authorization failed/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.delays.length, 0);
    assert.equal(f.logs.join('\n').includes(TOKEN), false);
  }
});

test('chargeback runner rejects redirects, permanent HTTP errors and malformed success responses', async () => {
  const invalid = [
    new Response(TOKEN, { status: 302, headers: { Location: 'https://untrusted.example' } }),
    new Response(TOKEN, { status: 400 }),
    new Response(TOKEN, { status: 200 }),
    Response.json({ ok: false, message: TOKEN }),
    batch({ mode: 'test' }),
    batch({ write: true }),
    batch({ scanned: 11 }),
    batch({ matchedOrders: -1 }),
    batch({ nextCursor: TOKEN }),
    batch({ nextCursor: 'du_empty', scanned: 0 }),
    batch({ failures: [{ disputeId: 'du_valid', code: `secret ${TOKEN}` }] }),
  ];
  for (const response of invalid) {
    const f = fixture([response]);
    await assert.rejects(
      runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live']), TOKEN, f.dependencies),
      (error: Error) => !error.message.includes(TOKEN),
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.checkpoints.get('live:false').complete, false);
  }
});

test('chargeback runner preserves failing page details and retries it without skipping disputes', async () => {
  const f = fixture([
    batch({ write: true, inserted: 1, nextCursor: 'du_good' }),
    batch({ write: true, scanned: 2, inserted: 1, nextCursor: 'du_good', failures: [{ disputeId: 'du_bad', code: 'chargeback-identity-conflict' }] }),
  ]);
  const args = parseStripeChargebackBackfillArgs(['--mode', 'live', '--write']);
  await assert.rejects(runStripeChargebackBackfill(args, TOKEN, f.dependencies), /backfill incomplete/);
  const checkpoint = f.checkpoints.get('live:true');
  assert.equal(checkpoint.cursor, 'du_good');
  assert.equal(checkpoint.totals.scanned, 1);
  assert.equal(checkpoint.failedBatch.failures[0].disputeId, 'du_bad');
  assert.ok(f.logs.some((message) => message.includes('du_bad')));
  f.responses.push(batch({ write: true, scanned: 2, matchedOrders: 2, inserted: 1, existing: 1 }));
  const [result] = await runStripeChargebackBackfill(args, TOKEN, f.dependencies);
  assert.equal(body(f.calls[2]).cursor, 'du_good');
  assert.equal(result.complete, true);
  assert.equal(result.failedBatch, undefined);
  assert.equal(result.totals.scanned, 3);
});

test('chargeback runner retries transient dispute failures within successful HTTP responses without counting partial attempts', async () => {
  const f = fixture([
    batch({ write: true, scanned: 2, inserted: 1, failures: [{ disputeId: 'du_retry', code: 'stripe-unavailable' }] }),
    batch({ write: true, scanned: 2, inserted: 0, existing: 1, failures: [{ disputeId: 'du_retry', code: 'chargeback-storage-unavailable' }] }),
    batch({ write: true, scanned: 2, matchedOrders: 2, inserted: 1, existing: 1 }),
  ]);
  const [result] = await runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live', '--write']), TOKEN, f.dependencies);
  assert.equal(result.complete, true);
  assert.equal(result.totals.scanned, 2);
  assert.equal(result.totals.inserted, 1);
  assert.equal(result.totals.existing, 1);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((call) => call.init.body === f.calls[0].init.body));
  assert.deepEqual(f.delays, [1_000, 2_000]);
});

test('chargeback runner preserves the failing page and details after five transient dispute failures', async () => {
  const f = fixture([
    batch({ nextCursor: 'du_saved' }),
    ...Array.from({ length: 5 }, (_, index) => batch({
      nextCursor: 'du_saved',
      failures: [{ disputeId: 'du_retry', code: index % 2 ? 'chargeback-order-pending' : 'chargeback-unavailable' }],
    })),
  ]);
  await assert.rejects(
    runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live']), TOKEN, f.dependencies),
    /backfill incomplete/,
  );
  assert.equal(f.calls.length, 6);
  assert.equal(f.delays.length, 4);
  const checkpoint = f.checkpoints.get('live:false');
  assert.equal(checkpoint.complete, false);
  assert.equal(checkpoint.cursor, 'du_saved');
  assert.equal(checkpoint.totals.scanned, 1);
  assert.equal(checkpoint.failedBatch.failures[0].disputeId, 'du_retry');
  assert.ok(f.calls.slice(1).every((call) => body(call).cursor === 'du_saved'));
  assert.equal(f.logs.some((message) => message.includes('full history complete')), false);
});

test('chargeback runner stops immediately when a page has permanent or credential failures mixed with transient failures', async () => {
  for (const code of ['chargeback-identity-conflict', 'invalid-dispute', 'stripe-not-configured', 'stripe-credentials-rejected']) {
    const f = fixture([batch({
      scanned: 2,
      failures: [
        { disputeId: 'du_retry', code: 'stripe-unavailable' },
        { disputeId: 'du_permanent', code },
      ],
    })]);
    await assert.rejects(
      runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live']), TOKEN, f.dependencies),
      /backfill incomplete/,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.delays.length, 0);
    assert.equal(f.checkpoints.get('live:false').failedBatch.failures[1].code, code);
  }
});

test('chargeback runner reports malformed provider disputes with the sanitized unknown identity', async () => {
  const f = fixture([batch({ failures: [{ disputeId: 'unknown', code: 'invalid-dispute' }] })]);
  await assert.rejects(runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live']), TOKEN, f.dependencies), /backfill incomplete/);
  assert.equal(f.checkpoints.get('live:false').failedBatch.failures[0].code, 'invalid-dispute');
  assert.ok(f.logs.some((message) => message.includes('dispute=unknown failure=invalid-dispute')));
});

test('chargeback runner rejects repeated pagination cursors', async () => {
  const f = fixture([batch({ nextCursor: 'dp_loop' }), batch({ nextCursor: 'dp_loop' })]);
  await assert.rejects(runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live']), TOKEN, f.dependencies), /repeated a cursor/);
  assert.equal(f.checkpoints.get('live:false').cursor, 'dp_loop');
  assert.equal(f.checkpoints.get('live:false').totals.scanned, 1);
});

test('chargeback runner separates dry and write progress, and reruns completed histories from the start', async () => {
  const f = fixture([
    batch({ nextCursor: 'du_dry' }), new Response('', { status: 400 }),
    batch({ write: true, inserted: 1 }),
    batch(),
    batch(),
  ]);
  await assert.rejects(runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live']), TOKEN, f.dependencies));
  await runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live', '--write']), TOKEN, f.dependencies);
  assert.equal(body(f.calls[2]).cursor, undefined);
  assert.equal(f.checkpoints.get('live:false').cursor, 'du_dry');
  await runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live', '--restart']), TOKEN, f.dependencies);
  assert.equal(body(f.calls[3]).cursor, undefined);
  await runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live']), TOKEN, f.dependencies);
  assert.equal(body(f.calls[4]).cursor, undefined);
});

test('chargeback checkpoints are protected, atomic, resumable and contain no session token', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'stripe-chargebacks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture([batch({ nextCursor: 'du_disk' }), new Response(TOKEN, { status: 400 })]);
  f.dependencies.store = createStripeChargebackCheckpointStore(directory);
  const args = parseStripeChargebackBackfillArgs(['--mode', 'live']);
  await assert.rejects(runStripeChargebackBackfill(args, TOKEN, f.dependencies));
  const path = join(directory, 'live-dry-run.json');
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8').includes(TOKEN), false);
  f.dependencies.store = createStripeChargebackCheckpointStore(directory);
  f.responses.push(batch());
  await runStripeChargebackBackfill(args, TOKEN, f.dependencies);
  assert.equal(body(f.calls[2]).cursor, 'du_disk');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).complete, true);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), mode: 'test' }));
  await assert.rejects(runStripeChargebackBackfill(args, TOKEN, f.dependencies), /Invalid backfill checkpoint/);
});

test('chargeback checkpoint storage rejects directory and checkpoint symlinks', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'stripe-chargebacks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'target');
  writeFileSync(target, TOKEN);
  symlinkSync(directory, join(directory, 'alias'));
  assert.throws(() => createStripeChargebackCheckpointStore(join(directory, 'alias')), /Unsafe/);
  const store = createStripeChargebackCheckpointStore(directory);
  symlinkSync(target, join(directory, 'live-dry-run.json'));
  assert.throws(() => store.load('live', false), /safely/);
  assert.equal(readFileSync(target, 'utf8'), TOKEN);
});

function webhookConfiguration(mode: 'live' | 'test', write: boolean, complete: boolean) {
  return {
    mode, write, complete,
    endpoints: [{
      id: 'we_fixture', url: 'https://api.mons.shop/webhooks/stripe',
      enabledEvents: ['checkout.session.completed', ...(complete ? STRIPE_DISPUTE_EVENT_TYPES : [])],
      missingEvents: complete ? [] : [...STRIPE_DISPUTE_EVENT_TYPES],
      updated: write && complete,
    }],
  };
}

test('Cloudflare backfill uses private RPC without a staff token and shares retry and checkpoint behavior', async () => {
  const f = fixture([]);
  const requests: unknown[] = [];
  const responses = [
    batch({ nextCursor: 'du_cloudflare' }),
    batch({ nextCursor: 'du_cloudflare', failures: [{ disputeId: 'du_retry', code: 'stripe-unavailable' }] }),
    batch(),
  ];
  f.dependencies.maintenance = {
    backfill: async (request) => { requests.push(request); return responses.shift(); },
    configureWebhooks: async () => { throw new Error('Unexpected webhook call'); },
  };
  const args = parseStripeChargebackBackfillArgs(['--cloudflare', '--mode', 'live']);
  assert.equal(args.cloudflare, true);
  const [result] = await runStripeChargebackBackfill(args, undefined, f.dependencies);
  assert.equal(result.complete, true);
  assert.equal(result.totals.scanned, 2);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(requests, [
    { mode: 'live', write: false },
    { mode: 'live', write: false, cursor: 'du_cloudflare' },
    { mode: 'live', write: false, cursor: 'du_cloudflare' },
  ]);
  assert.deepEqual(f.delays, [1_000]);
  await assert.rejects(runStripeChargebackBackfill(parseStripeChargebackBackfillArgs([]), TOKEN, f.dependencies), /requires --cloudflare/);
  await assert.rejects(runStripeChargebackBackfill(args, undefined, { ...f.dependencies, maintenance: undefined }), /not connected/);
});

test('Cloudflare maintenance fixes the named service configuration and disposes the proxy after success', async () => {
  const options: unknown[] = [];
  const requests: unknown[] = [];
  let disposed = 0;
  await withStripeChargebackMaintenance(async (transport) => {
    const response = await transport.backfill({ mode: 'live', write: false });
    assert.equal((await response.json() as { ok: boolean }).ok, true);
    const config = await transport.configureWebhooks({ mode: 'test', write: false });
    assert.equal(config.status, 200);
  }, async (value) => {
    options.push(value);
    return {
      env: { CHARGEBACKS: {
        backfill: async (request) => { requests.push(request); return (await batch().json()); },
        configureWebhooks: async (request) => { requests.push(request); return webhookConfiguration('test', false, false); },
      } },
      dispose: async () => { disposed += 1; },
    };
  });
  const option = options[0] as { configPath: string; envFiles: string[]; persist: boolean; remoteBindings: boolean };
  assert.deepEqual({ ...option, configPath: '<pinned>' }, { configPath: '<pinned>', envFiles: [], persist: false, remoteBindings: true });
  const config = JSON.parse(readFileSync(option.configPath, 'utf8'));
  const production = JSON.parse(readFileSync(new URL('../cloud/workers/api/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.account_id, production.account_id);
  assert.equal(config.name, 'mons-shop-chargeback-operator');
  assert.equal(config.compatibility_date, production.compatibility_date);
  assert.deepEqual(config.services, [{ binding: 'CHARGEBACKS', service: 'mons-shop-api', entrypoint: 'StripeChargebackMaintenance', remote: true }]);
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'account_id', 'compatibility_date', 'name', 'services']);
  assert.deepEqual(requests, [{ mode: 'live', write: false }, { mode: 'test', write: false }]);
  assert.equal(disposed, 1);
});

test('Cloudflare maintenance disposes on runner failure and hides connection and provider error details', async () => {
  let disposed = 0;
  const failures: unknown[] = [
    { ok: false, error: { code: 'stripe-not-configured', status: 503, message: TOKEN } },
    { ok: false, error: { code: 'stripe-credentials-rejected', status: 503, message: TOKEN } },
    { ok: false, error: { code: 'stripe-unavailable', status: 503, message: TOKEN } },
    { ok: false, error: { code: 'deadline-exceeded', status: 504 } },
    new Error(TOKEN),
  ];
  const stop = new Error('Operator stopped');
  await assert.rejects(withStripeChargebackMaintenance(async (transport) => {
    for (const status of [400, 400, 503, 503, 503]) {
      const response = await transport.backfill({ mode: 'live', write: false });
      assert.equal(response.status, status);
      assert.equal((await response.text()).includes(TOKEN), false);
    }
    throw stop;
  }, async () => ({
    env: { CHARGEBACKS: {
      backfill: async () => {
        const result = failures.shift();
        if (result instanceof Error) throw result;
        return result;
      },
      configureWebhooks: async () => undefined,
    } },
    dispose: async () => { disposed += 1; },
  })), (error) => error === stop);
  assert.equal(disposed, 1);
  await assert.rejects(withStripeChargebackMaintenance(async () => undefined, async () => { throw new Error(TOKEN); }),
    (error: Error) => error.message.includes('Wrangler authentication') && !error.message.includes(TOKEN));
});

test('webhook configuration inspects both modes without modifying backfill checkpoints or requiring staff auth', async () => {
  const f = fixture([]);
  const requests: unknown[] = [];
  f.dependencies.maintenance = {
    backfill: async () => { throw new Error('Unexpected backfill'); },
    configureWebhooks: async (request) => {
      requests.push(request);
      return Response.json({ ok: true, ...webhookConfiguration(request.mode, request.write, false) });
    },
  };
  const args = parseStripeChargebackBackfillArgs(['--cloudflare', '--configure-webhooks']);
  const results = await runStripeChargebackWebhookConfiguration(args, f.dependencies);
  assert.equal(results.length, 2);
  assert.equal(results.every((result) => !result.complete), true);
  assert.deepEqual(requests, [{ mode: 'live', write: false }, { mode: 'test', write: false }]);
  assert.equal(f.checkpoints.size, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.some((line) => line.includes('missingEvents=5')), true);
});

test('webhook configuration retries transient failures and requires verified complete write results', async () => {
  const f = fixture([]);
  let attempts = 0;
  f.dependencies.maintenance = {
    backfill: async () => { throw new Error('Unexpected backfill'); },
    configureWebhooks: async (request) => {
      attempts += 1;
      return attempts === 1
        ? new Response('', { status: 503 })
        : Response.json({ ok: true, ...webhookConfiguration(request.mode, request.write, true) });
    },
  };
  const args = parseStripeChargebackBackfillArgs(['--cloudflare', '--configure-webhooks', '--mode', 'live', '--write']);
  const [result] = await runStripeChargebackWebhookConfiguration(args, f.dependencies);
  assert.equal(result.complete, true);
  assert.equal(attempts, 2);
  assert.deepEqual(f.delays, [1_000]);
  f.dependencies.maintenance.configureWebhooks = async (request) => Response.json({ ok: true, ...webhookConfiguration(request.mode, request.write, false) });
  await assert.rejects(runStripeChargebackWebhookConfiguration(args, f.dependencies), /incomplete/);
  f.dependencies.maintenance.configureWebhooks = async () => new Response('', { status: 400 });
  await assert.rejects(runStripeChargebackWebhookConfiguration(args, f.dependencies), /HTTP 400/);
});

test('Cloudflare maintenance normalizes only safe known codes and rejects malformed error envelopes', async () => {
  const replies = [
    { ok: false, error: { code: 'stripe-webhook-not-active', status: 409 } },
    { ok: false, error: { code: TOKEN, status: 503 } },
    { ok: false, error: { code: 'stripe-unavailable', status: 'invalid' } },
  ];
  await withStripeChargebackMaintenance(async (transport) => {
    const missingEndpoint = await transport.configureWebhooks({ mode: 'live', write: false });
    assert.equal(stripeChargebackMaintenanceFailureCode(missingEndpoint), 'stripe-webhook-not-active');
    const unknown = await transport.configureWebhooks({ mode: 'live', write: false });
    assert.equal(stripeChargebackMaintenanceFailureCode(unknown), undefined);
    assert.equal((await unknown.text()).includes(TOKEN), false);
    const malformed = await transport.configureWebhooks({ mode: 'live', write: false });
    assert.equal(malformed.status, 400);
    assert.equal(stripeChargebackMaintenanceFailureCode(malformed), undefined);
  }, async () => ({
    env: { CHARGEBACKS: { backfill: async () => undefined, configureWebhooks: async () => replies.shift() } },
    dispose: async () => undefined,
  }));
});

test('webhook configuration rejects inconsistent completion and unexpected endpoint identities', async () => {
  const f = fixture([]);
  const args = parseStripeChargebackBackfillArgs(['--cloudflare', '--configure-webhooks', '--mode', 'live', '--write']);
  const base = webhookConfiguration('live', true, true);
  const invalid = [
    { ...base, complete: false },
    { ...base, endpoints: [] },
    { ...base, endpoints: [{ ...base.endpoints[0], url: 'https://untrusted.example' }] },
    { ...base, endpoints: [{ ...base.endpoints[0], missingEvents: ['charge.dispute.created'] }] },
  ];
  for (const value of invalid) {
    f.dependencies.maintenance = {
      backfill: async () => { throw new Error('Unexpected backfill'); },
      configureWebhooks: async () => Response.json({ ok: true, ...value }),
    };
    await assert.rejects(runStripeChargebackWebhookConfiguration(args, f.dependencies));
  }
});

test('Cloudflare maintenance times out a stalled RPC and releases its proxy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let disposed = 0;
  await withStripeChargebackMaintenance(async (transport) => {
    const pending = transport.backfill({ mode: 'live', write: false });
    t.mock.timers.tick(60_000);
    assert.equal((await pending).status, 503);
  }, async () => ({
    env: { CHARGEBACKS: {
      backfill: () => new Promise(() => undefined),
      configureWebhooks: async () => undefined,
    } },
    dispose: async () => { disposed += 1; },
  }));
  assert.equal(disposed, 1);
});

test('Stripe provider diagnostics expose only validated HTTP codes and classify retries consistently across RPC and dispute results', async () => {
  const cases = [
    ['stripe-http-400', false, true],
    ['stripe-http-408', true, true],
    ['stripe-http-429', true, true],
    ['stripe-http-500', true, true],
    ['stripe-http-503', true, true],
    ['stripe-http-599', true, true],
    ['stripe-api-version-unsupported', false, true],
    ['stripe-redirect-rejected', false, true],
    ['stripe-request-timeout', true, true],
    ['stripe-network-error', true, true],
    ['stripe-http-300', false, false],
    ['stripe-http-600', false, false],
    [`stripe-http-503-${TOKEN}`, false, false],
  ] as const;
  for (const [code, retryable, visible] of cases) {
    await withStripeChargebackMaintenance(async (transport) => {
      const response = await transport.backfill({ mode: 'live', write: false });
      assert.equal(response.status, retryable ? 503 : 400, code);
      assert.equal(stripeChargebackMaintenanceFailureCode(response), visible ? code : undefined, code);
      assert.equal((await response.text()).includes(TOKEN), false);
    }, async () => ({
      env: { CHARGEBACKS: {
        backfill: async () => ({ ok: false, error: { code, status: 503 } }),
        configureWebhooks: async () => undefined,
      } },
      dispose: async () => undefined,
    }));
    if (!visible) continue;
    const f = fixture([
      batch({ failures: [{ disputeId: 'du_provider', code }] }),
      ...(retryable ? [batch()] : []),
    ]);
    const run = runStripeChargebackBackfill(parseStripeChargebackBackfillArgs(['--mode', 'live']), TOKEN, f.dependencies);
    if (retryable) {
      assert.equal((await run)[0].complete, true, code);
      assert.equal(f.calls.length, 2, code);
    } else {
      await assert.rejects(run, /backfill incomplete/);
      assert.equal(f.calls.length, 1, code);
    }
  }
});
