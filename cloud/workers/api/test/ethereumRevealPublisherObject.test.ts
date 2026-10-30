import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { RevealPublicationJob } from '../src/ethereumRevealStore.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';

const { EthereumRevealPublisherObject } = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealPublisherObject.ts'));
const scope = { deploymentId: 'test-sepolia', chainId: 11155111, contractAddress: `0x${'11'.repeat(20)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/test-sepolia/' };
const job = (id = '1'): RevealPublicationJob => ({ token_id: id, metadata_json: `{"image":"https://example.test/${id}.webp"}`,
  placeholder_json: '{"image":"https://example.test/placeholder.webp"}', attempts: 0 });
const key = (id = '1') => `111k-sepolia/test-sepolia/${id}.json`;

function fixture() {
  const objects = new Map<string, { body: string; etag: string }>();
  const writes: Array<{ key: string; body: string; options: R2PutOptions }> = [];
  let reads = 0;
  let aborts = 0;
  const bucket = {
    async get(objectKey: string) {
      reads++;
      const current = objects.get(objectKey);
      return current ? { size: new TextEncoder().encode(current.body).byteLength, etag: current.etag,
        text: async () => current.body } as R2ObjectBody : null;
    },
    async put(objectKey: string, body: string, options: R2PutOptions) {
      writes.push({ key: objectKey, body, options });
      const current = objects.get(objectKey);
      const condition = options.onlyIf as R2Conditional;
      if (condition.etagMatches ? current?.etag !== condition.etagMatches : current !== undefined) return null;
      objects.set(objectKey, { body, etag: `etag-${writes.length}` });
      return { etag: `etag-${writes.length}` } as R2Object;
    },
  };
  const reopen = () => new EthereumRevealPublisherObject({ waitUntil() {}, abort() { aborts++; } } as never,
    { ETHEREUM_REVEAL_METADATA: bucket } as Env);
  return { publisher: reopen(), reopen, bucket, objects, writes, reads: () => reads, aborts: () => aborts };
}

for (const previous of ['absent', 'placeholder', 'published'] as const) test(`publisher handles ${previous} metadata idempotently`, async () => {
  const f = fixture();
  const item = job();
  if (previous !== 'absent') f.objects.set(key(), { body: previous === 'published' ? item.metadata_json : item.placeholder_json, etag: 'original' });
  assert.deepEqual(await f.publisher.publishBatch(scope, [item]), [{ tokenId: '1', status: 'published' }]);
  assert.equal(f.objects.get(key())?.body, item.metadata_json);
  assert.equal(f.writes.length, previous === 'published' ? 0 : 1);
  if (f.writes.length) assert.deepEqual(f.writes[0].options, {
    onlyIf: previous === 'absent' ? { etagDoesNotMatch: '*' } : { etagMatches: 'original' },
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    customMetadata: { revealDeployment: scope.deploymentId, revealToken: '1' },
  });
});

for (const body of ['{"image":"https://other.test/art.webp"}', 'x'.repeat(128 * 1024 + 1)]) {
  test(`publisher quarantines ${body.length > 128 * 1024 ? 'oversized' : 'differing'} existing metadata`, async () => {
    const f = fixture();
    f.objects.set(key(), { body, etag: 'foreign' });
    assert.deepEqual(await f.publisher.publishBatch(scope, [job()]), [{ tokenId: '1', status: 'conflict' }]);
    assert.equal(f.writes.length, 0);
    assert.equal(f.objects.get(key())?.body, body);
  });
}

test('publisher retries a lost conditional write and recognizes a concurrent identical publication', async () => {
  const f = fixture();
  const original = f.bucket.put;
  f.bucket.put = async (...args) => {
    f.objects.set(key(), { body: job().metadata_json, etag: 'concurrent' });
    return original(...args);
  };
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()]), [{ tokenId: '1', status: 'retry' }]);
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()]), [{ tokenId: '1', status: 'published' }]);
  assert.equal(f.writes.length, 1);
});

for (const operation of ['get', 'put'] as const) test(`publisher retries a failed R2 ${operation}`, async () => {
  const f = fixture();
  f.bucket[operation] = async () => { throw new Error('R2 unavailable'); };
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()]), [{ tokenId: '1', status: 'retry' }]);
});

test('publisher coalesces identical work and rejects conflicting frozen bytes', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = f.bucket.get;
  f.bucket.get = async objectKey => { await held; return original(objectKey); };
  const first = f.publisher.publishBatch(scope, [job()]);
  const second = f.publisher.publishBatch(scope, [job()]);
  assert.deepEqual(await f.publisher.publishBatch(scope, [{ ...job(), metadata_json: '{}' }]), [{ tokenId: '1', status: 'conflict' }]);
  release();
  assert.deepEqual(await first, [{ tokenId: '1', status: 'published' }]);
  assert.deepEqual(await second, await first);
  assert.equal(f.reads(), 1);
  assert.equal(f.writes.length, 1);
});

test('publisher bounds concurrent batches at eight active tokens', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = f.bucket.get;
  f.bucket.get = async objectKey => { await held; return original(objectKey); };
  const first = f.publisher.publishBatch(scope, Array.from({ length: 8 }, (_, index) => job(String(index + 1))));
  assert.deepEqual(await f.publisher.publishBatch(scope, [job('9')]), [{ tokenId: '9', status: 'retry' }]);
  release();
  assert.ok((await first).every(result => result.status === 'published'));
  assert.equal(f.writes.length, 8);
});

test('publisher rejects oversized payloads and batches before starting R2 work', () => {
  const f = fixture();
  assert.throws(() => f.publisher.publishBatch(scope, Array.from({ length: 9 }, () => job())), /Invalid reveal publication batch/);
  for (const field of ['metadata_json', 'placeholder_json']) {
    assert.throws(() => f.publisher.publishBatch(scope, [{ ...job(), [field]: 'é'.repeat(128 * 1024) }]), /Invalid reveal publication metadata/);
  }
  assert.equal(f.reads(), 0);
  assert.equal(f.writes.length, 0);
});

test('publisher returns retry for a stalled read and never writes after its deadline', async () => {
  const f = fixture();
  let release!: (value: R2ObjectBody | null) => void;
  f.bucket.get = () => new Promise(resolve => { release = resolve; });
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()], Date.now() + 20), [{ tokenId: '1', status: 'retry' }]);
  release(null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.writes.length, 0);
  assert.equal(f.aborts(), 1);
});

test('publisher bounds a stalled object body without starting a later write', async () => {
  const f = fixture();
  let release!: (value: string) => void;
  f.bucket.get = async () => ({ size: job().placeholder_json.length, etag: 'original',
    text: () => new Promise<string>(resolve => { release = resolve; }) } as R2ObjectBody);
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()], Date.now() + 20), [{ tokenId: '1', status: 'retry' }]);
  release(job().placeholder_json);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.writes.length, 0);
  assert.equal(f.aborts(), 1);
});

test('publisher bounds a stalled PUT and lets a later read reconcile its immutable bytes', async () => {
  const f = fixture();
  const original = f.bucket.put;
  let finish!: () => Promise<void>;
  f.bucket.put = (...args) => new Promise(resolve => { finish = async () => { resolve(await original(...args)); }; });
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()], Date.now() + 20), [{ tokenId: '1', status: 'retry' }]);
  await finish();
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()]), [{ tokenId: '1', status: 'retry' }]);
  assert.deepEqual(await f.reopen().publishBatch(scope, [job()]), [{ tokenId: '1', status: 'published' }]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.aborts(), 1);
});

test('eight abandoned PUTs reset their executor before another batch can add storage work', async () => {
  const f = fixture();
  let started = 0;
  f.bucket.put = () => { started++; return new Promise(() => {}); };
  const items = Array.from({ length: 8 }, (_, index) => job(String(index + 1)));
  assert.ok((await f.publisher.publishBatch(scope, items, Date.now() + 20)).every(outcome => outcome.status === 'retry'));
  assert.equal(started, 8);
  assert.equal(f.aborts(), 1);
  const next = items.map((_, index) => job(String(index + 9)));
  assert.ok((await f.publisher.publishBatch(scope, next)).every(outcome => outcome.status === 'retry'));
  assert.equal(started, 8);
  assert.equal(f.reads(), 8);
});

test('a fresh executor retries the same frozen bytes after an interrupted write', async () => {
  const f = fixture();
  const original = f.bucket.put;
  f.bucket.put = () => new Promise(() => {});
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()], Date.now() + 20), [{ tokenId: '1', status: 'retry' }]);
  f.bucket.put = original;
  assert.deepEqual(await f.reopen().publishBatch(scope, [job()]), [{ tokenId: '1', status: 'published' }]);
  assert.equal(f.objects.get(key())?.body, job().metadata_json);
  assert.equal(f.writes.length, 1);
  assert.equal(f.aborts(), 1);
});

test('publisher starts no storage work after a caller lease expires', async () => {
  const f = fixture();
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()], Date.now() - 1), [{ tokenId: '1', status: 'retry' }]);
  assert.equal(f.reads(), 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.aborts(), 0);
});

test('native publisher timeout resets its instance and retries frozen work through a fresh instance', { timeout: 10_000 }, async () => {
  const [{ build }, { Miniflare }] = await Promise.all([import('esbuild'), import('miniflare')]);
  const items = Array.from({ length: 8 }, (_, index) => job(String(index + 1)));
  const source = `
    import { EthereumRevealPublisherObject } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealPublisherObject.ts'))};
    export class NativePublisher extends EthereumRevealPublisherObject {
      constructor(ctx, env) {
        const state = { stalled: true, writes: 0 };
        super(ctx, { ETHEREUM_REVEAL_METADATA: {
          get: key => env.BUCKET.get(key),
          put: (...args) => { state.writes++; return state.stalled ? new Promise(() => {}) : env.BUCKET.put(...args); },
        } });
        this.state = state;
        this.instance = crypto.randomUUID();
      }
      identity() { return this.instance; }
      async run(stalled) {
        this.state.stalled = stalled;
        const outcomes = await this.publishBatch(${JSON.stringify(scope)}, ${JSON.stringify(items)}, Date.now() + (stalled ? 100 : 5000));
        return { instance: this.instance, outcomes, writes: this.state.writes };
      }
    }
    export default { async fetch(request, env) {
      const path = new URL(request.url).pathname;
      const object = env.PUBLISHER.getByName('publisher');
      try { return Response.json(path === '/identity' ? await object.identity() : await object.run(path === '/stall')); }
      catch { return new Response('Publisher reset', { status: 503 }); }
    } };
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: resolve('.'), loader: 'ts' }, bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'publisher-reset-test', compatibilityDate: '2026-08-08',
    manifest: { mainModule: 'publisher.mjs', modulesRoot: resolve('.'), modules: {
      'publisher.mjs': { type: 'esm', contents: bundle.outputFiles[0].text },
    } },
    env: { BUCKET: { type: 'r2', name: 'publisher-reset-bucket' },
      PUBLISHER: { type: 'durable-object', worker: 'publisher-reset-test', exportName: 'NativePublisher' } },
    exports: { NativePublisher: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const before = await (await runtime.dispatchFetch('https://publisher.test/identity')).json();
    const stalled = await runtime.dispatchFetch('https://publisher.test/stall');
    assert.equal(stalled.status, 503);
    const recovered = await runtime.dispatchFetch('https://publisher.test/retry');
    assert.equal(recovered.status, 200);
    const value = await recovered.json() as { instance: string; outcomes: Array<{ tokenId: string; status: string }>; writes: number };
    assert.notEqual(value.instance, before);
    assert.deepEqual(value.outcomes, items.map(item => ({ tokenId: item.token_id, status: 'published' })));
    assert.equal(value.writes, 8);
    const cached = await (await runtime.dispatchFetch('https://publisher.test/retry')).json();
    assert.deepEqual(cached, value);
  } finally { await runtime.dispose(); }
});
