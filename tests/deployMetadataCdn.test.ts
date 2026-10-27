import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { inspectMetadataCdnPayload, metadataCdnTarget, parseMetadataCdnDeployArgs, runDeployMetadataCdn } from '../scripts/ops/deployMetadataCdn.ts';

const config = {
  name: 'mons-shop-cdn', account_id: 'e25f90fc073ea309b54b8b5144bf28e0', main: 'src/index.ts',
  workers_dev: false, preview_urls: false, compatibility_date: '2026-08-08',
  compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
  routes: [{ pattern: 'cdn.mons.shop', custom_domain: true }],
  r2_buckets: [{ binding: 'METADATA_BUCKET', bucket_name: 'cdn-mons-shop' }],
  observability: { enabled: true, head_sampling_rate: 1 },
};
const target = metadataCdnTarget(config);
const domain = { id: '545e67c68a27b0d2deb987f6c8d080446de6e229', zone_id: target.zoneId, zone_name: target.zoneName,
  hostname: target.hostname, service: target.worker, environment: '', enabled: true, previews_enabled: false };

async function multipart(changes: Record<string, unknown> = {}): Promise<Uint8Array> {
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify({ main_module: 'index.js',
    bindings: [{ name: 'METADATA_BUCKET', type: 'r2_bucket', bucket_name: target.bucket }],
    compatibility_date: target.compatibilityDate, compatibility_flags: target.compatibilityFlags,
    observability: target.observability, ...changes })], { type: 'application/json' }));
  form.set('index.js', new Blob(['export default { fetch() { return new Response("flowers 🌷"); } };'], {
    type: 'application/javascript+module',
  }), 'index.js');
  return new Uint8Array(await new Request('https://example.test', { method: 'PUT', body: form }).arrayBuffer());
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'metadata-cdn-deploy-test-'));
  await mkdir(join(root, 'cloud/workers/cdn'), { recursive: true });
  await writeFile(join(root, 'cloud/workers/cdn/wrangler.jsonc'), JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await multipart();
  const output = join(root, '.cache/report.json');
  const run = (write: boolean, providerFetch: typeof fetch) => runDeployMetadataCdn([
    ...(write ? ['--write'] : []), '--output', output,
  ], { root, prepare: async () => bytes, fetch: providerFetch, apiToken: 'private-test-token',
    now: () => new Date('2026-10-27T00:00:00.000Z') });
  const report = async () => JSON.parse(await readFile(output, 'utf8'));
  return { bytes, output, run, report };
}

function success(result: unknown): Response { return Response.json({ success: true, result }); }
function zone(accountId = target.accountId): Response {
  return success({ id: target.zoneId, name: target.zoneName, status: 'active', account: { id: accountId } });
}

test('CDN deployment defaults to preparation and requires explicit well-formed mutation flags', () => {
  assert.deepEqual(parseMetadataCdnDeployArgs([]), { write: false, output: '.cache/111k-offchain/cdn-deployment.json' });
  assert.deepEqual(parseMetadataCdnDeployArgs(['--output', '.cache/report.json', '--write']), { write: true, output: '.cache/report.json' });
  for (const args of [['--write', '--write'], ['--output'], ['--output', '--write'], ['--force'], ['--output', 'worker.js']]) {
    assert.throws(() => parseMetadataCdnDeployArgs(args));
  }
});

test('the dedicated deployment refuses unrelated workers, buckets and domain routes', () => {
  for (const changes of [{ name: 'other' }, { account_id: 'invalid' }, { workers_dev: true }, { preview_urls: true },
    { main: '../other.ts' }, { routes: [{ pattern: 'other.mons.shop', custom_domain: true }] },
    { routes: [...config.routes, ...config.routes] },
    { r2_buckets: [{ binding: 'METADATA_BUCKET', bucket_name: 'other' }] }]) {
    assert.throws(() => metadataCdnTarget({ ...config, ...changes }));
  }
});

test('multipart inspection retains the exact upload bytes and rejects JS, truncation and mismatched bindings', async () => {
  const bytes = await multipart();
  const payload = await inspectMetadataCdnPayload(bytes, target);
  assert.equal(payload.bytes, bytes);
  assert.deepEqual(payload.modules, ['index.js']);
  assert.match(payload.contentType, /^multipart\/form-data; boundary=/);
  assert.match(payload.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(inspectMetadataCdnPayload(new TextEncoder().encode('export default {};'), target), /multipart/);
  await assert.rejects(inspectMetadataCdnPayload(bytes.slice(0, -5), target), /incomplete/);
  await assert.rejects(inspectMetadataCdnPayload(await multipart({ bindings: [] }), target), /differs/);
  await assert.rejects(inspectMetadataCdnPayload(await multipart({ compatibility_date: '2020-01-01' }), target), /differs/);
  await assert.rejects(inspectMetadataCdnPayload(await multipart({ main_module: 'missing.js' }), target), /differs/);
});

test('preparation writes only a public report and makes no Cloudflare request', async t => {
  const f = await fixture(t);
  const result = await f.run(false, async () => { throw new Error('Unexpected network request'); });
  assert.equal(result.phase, 'prepared');
  assert.equal(result.payloadBytes, f.bytes.byteLength);
  assert.deepEqual(await f.report(), result);
  const text = await readFile(f.output, 'utf8');
  assert.ok(!text.includes('private-test-token'));
  assert.ok(!text.includes('export default'));
});

test('deployment verifies zone ownership and rejects an already owned hostname before any mutation', async t => {
  for (const scenario of ['wrong-account', 'conflicting-worker', 'ambiguous-domains']) {
    const f = await fixture(t);
    let writes = 0;
    await assert.rejects(f.run(true, async (input, init) => {
      if (init?.method !== 'GET') writes++;
      if (String(input).includes('/zones/')) return zone(scenario === 'wrong-account' ? 'a'.repeat(32) : target.accountId);
      return success(scenario === 'ambiguous-domains' ? [domain, domain] : [{ ...domain, service: 'another-worker' }]);
    }), /configured account|different Worker|ambiguous/);
    assert.equal(writes, 0);
    assert.equal((await f.report()).phase, 'prepared');
  }
});

test('deployment uploads raw Wrangler multipart and attaches only the configured hostname', async t => {
  const f = await fixture(t);
  let attached = false;
  const writes: string[] = [];
  const result = await f.run(true, async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-test-token');
    assert.equal(init?.redirect, 'error');
    if (url.pathname.includes('/zones/')) return zone();
    if (url.pathname.endsWith('/subdomain')) return success({ enabled: false, previews_enabled: false });
    if (init?.method === 'GET') {
      assert.equal(url.searchParams.get('hostname'), target.hostname);
      return success(attached ? [domain] : []);
    }
    writes.push(url.pathname);
    if (url.pathname.endsWith(`/scripts/${target.worker}`)) {
      assert.equal((await f.report()).phase, 'uploading');
      assert.ok(init?.body instanceof Uint8Array);
      assert.deepEqual(init.body, f.bytes);
      const header = new Headers(init.headers).get('Content-Type')!;
      const uploaded = await new Response(init.body, { headers: { 'Content-Type': header } }).formData();
      assert.equal((uploaded.get('index.js') as Blob).type, 'application/javascript+module');
      return success({ id: target.worker, deployment_id: '7a135c272c754d70a76cc6c2254af3b5' });
    }
    assert.equal((await f.report()).phase, 'attaching-domain');
    assert.deepEqual(JSON.parse(String(init?.body)), { hostname: target.hostname, service: target.worker,
      zone_id: target.zoneId, enabled: true, previews_enabled: false });
    attached = true;
    return success(domain);
  });
  assert.equal(result.phase, 'complete');
  assert.equal(result.domainAction, 'attached');
  assert.equal(result.domainId, domain.id);
  assert.deepEqual(writes, [`/client/v4/accounts/${target.accountId}/workers/scripts/${target.worker}`, `/client/v4/accounts/${target.accountId}/workers/domains`]);
});

test('an existing matching domain is verified and reused without a domain update', async t => {
  const f = await fixture(t);
  let puts = 0;
  const result = await f.run(true, async (input, init) => {
    if (String(input).includes('/zones/')) return zone();
    if (String(input).endsWith('/subdomain')) return success({ enabled: false, previews_enabled: false });
    if (init?.method === 'GET') return success([domain]);
    puts++;
    assert.ok(String(input).endsWith(`/scripts/${target.worker}`));
    return success({ id: target.worker, deployment_id: '7a135c272c754d70a76cc6c2254af3b5' });
  });
  assert.equal(result.phase, 'complete');
  assert.equal(result.domainAction, 'reused');
  assert.equal(puts, 1);
});

test('upload uncertainty is journaled without retrying or exposing provider errors', async t => {
  const f = await fixture(t);
  let puts = 0;
  await assert.rejects(f.run(true, async (input, init) => {
    if (String(input).includes('/zones/')) return zone();
    if (String(input).endsWith('/subdomain')) return success({ enabled: false, previews_enabled: false });
    if (init?.method === 'GET') return success([]);
    puts++;
    return Response.json({ success: false, errors: [{ message: 'private-test-token' }] });
  }), /not confirmed/);
  assert.equal(puts, 1);
  const report = await f.report();
  assert.equal(report.phase, 'uploading');
  assert.ok(!JSON.stringify(report).includes('private-test-token'));
});

test('a hostname takeover after upload stops attachment and preserves the uploaded deployment identity', async t => {
  const f = await fixture(t);
  let reads = 0;
  let puts = 0;
  await assert.rejects(f.run(true, async (input, init) => {
    if (String(input).includes('/zones/')) return zone();
    if (String(input).endsWith('/subdomain')) return success({ enabled: false, previews_enabled: false });
    if (init?.method === 'GET') return success(++reads === 1 ? [] : [{ ...domain, service: 'another-worker' }]);
    puts++;
    return success({ id: target.worker, deployment_id: '7a135c272c754d70a76cc6c2254af3b5' });
  }), /different Worker/);
  assert.equal(puts, 1);
  assert.equal((await f.report()).phase, 'uploaded');
  assert.equal((await f.report()).deploymentId, '7a135c272c754d70a76cc6c2254af3b5');
});

for (const initial of [{ enabled: true, previews_enabled: false }, { enabled: false, previews_enabled: true }]) {
  test(`deployment disables workers.dev=${initial.enabled} and preview URLs=${initial.previews_enabled}`, async t => {
    const f = await fixture(t);
    let state = { ...initial };
    let updates = 0;
    const result = await f.run(true, async (input, init) => {
      if (String(input).includes('/zones/')) return zone();
      if (String(input).endsWith('/subdomain')) {
        if (init?.method === 'POST') {
          assert.equal((await f.report()).phase, 'configuring-subdomain');
          assert.deepEqual(JSON.parse(String(init.body)), { enabled: false, previews_enabled: false });
          state = { enabled: false, previews_enabled: false };
          updates++;
        }
        return success(state);
      }
      if (init?.method === 'GET') return success([domain]);
      return success({ id: target.worker, deployment_id: '7a135c272c754d70a76cc6c2254af3b5' });
    });
    assert.equal(updates, 1);
    assert.equal(result.workersDev, false);
    assert.equal(result.previewUrls, false);
    assert.equal(result.phase, 'complete');
  });
}
