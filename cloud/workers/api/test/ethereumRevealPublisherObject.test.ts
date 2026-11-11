import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { attributePublisherName } from '../src/ethereumRevealAttributes.ts';
import type { RevealPublicationJob } from '../src/ethereumRevealStore.ts';
import type { MetadataWrite } from '../src/ethereumRevealPublisherObject.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';
import { prepareRelicImagePatch, RELIC_IMAGE_TOKEN_IDS, type RelicImagesRequest } from '../../../../shared/ethereum/relicImages.ts';

const { EthereumRevealPublisherObject } = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealPublisherObject.ts'));
const scope = { deploymentId: 'test-sepolia', chainId: 11155111, contractAddress: `0x${'11'.repeat(20)}`,
  metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/test-sepolia/' };
const job = (id = '1'): RevealPublicationJob => ({ token_id: id, metadata_json: `{"image":"https://example.test/${id}.webp"}`,
  placeholder_json: '{"image":"https://example.test/placeholder.webp"}', attempts: 0 });
const key = (id = '1') => `111k-sepolia/test-sepolia/${id}.json`;
const metadataWrite = (item: RevealPublicationJob): MetadataWrite => ({ tokenId: item.token_id,
  metadataRevision: item.metadata_revision ?? 0, metadataJson: item.metadata_json,
  expectedJsons: item.expected_jsons_json ? JSON.parse(item.expected_jsons_json) : [item.placeholder_json],
  allowMissing: item.allow_missing ?? true });
const replacementJob = (id = '1'): RevealPublicationJob => ({ ...job(id), metadata_revision: 3,
  metadata_json: `{"image":"https://example.test/new-${id}.png","attributes":[]}`,
  expected_jsons_json: JSON.stringify([job(id).placeholder_json, job(id).metadata_json]), allow_missing: true, migration: true });
const jsonHeaders = { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' };
const registration = {
  deployment_id: scope.deploymentId, drop_id: '111k_devnet', chain_id: scope.chainId, contract_address: scope.contractAddress,
  metadata_base_uri: scope.metadataBaseUri, deployment_block: 100, catalog_version: '111k-v5',
  template_json: '{"name":"artwork","description":"","image":"placeholder","attributes":[]}', template_sha256: 'a'.repeat(64),
  state: 'active', revision: 3, created_at_ms: 1, updated_at_ms: 3, activated_at_ms: 3, provisioned_at_ms: 2, last_error: null,
};
const currentContract = `0x${'22'.repeat(20)}`;
const control = { paused: 0, revision: 4, paused_at_ms: null, chain_id: 11155111, contract_address: currentContract,
  reset_guard_id: null, last_reset_id: null, updated_at_ms: 1 };

function fixture() {
  const registry = { row: { ...registration } as Record<string, unknown> | null };
  const objects = new Map<string, { body: string; etag: string; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }>();
  const writes: Array<{ key: string; body: string; options: R2PutOptions }> = [];
  const desired = new Map<string, MetadataWrite>();
  const publishers = new Map<string, InstanceType<typeof EthereumRevealPublisherObject>>();
  let reads = 0;
  let aborts = 0;
  const bucket = {
    async get(objectKey: string) {
      reads++;
      const current = objects.get(objectKey);
      return current ? { size: new TextEncoder().encode(current.body).byteLength, etag: current.etag, httpMetadata: current.httpMetadata, customMetadata: current.customMetadata,
        arrayBuffer: async () => new TextEncoder().encode(current.body).buffer } as R2ObjectBody : null;
    },
    async put(objectKey: string, body: string, options: R2PutOptions) {
      writes.push({ key: objectKey, body, options });
      const current = objects.get(objectKey);
      const condition = options.onlyIf as R2Conditional;
      if (condition.etagMatches ? current?.etag !== condition.etagMatches : current !== undefined) return null;
      assert.ok(!(options.httpMetadata instanceof Headers));
      objects.set(objectKey, { body, etag: `etag-${writes.length}`, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata });
      return { etag: `etag-${writes.length}` } as R2Object;
    },
  };
  const objectName = `${scope.chainId}:${scope.contractAddress}`;
  const database = { prepare(sql: string) {
    const statement = { bind(..._values: unknown[]) { return statement; }, async first() {
      return sql.includes('ethereum_111k_control') ? control : registry.row;
    } };
    return statement;
  } };
  const reopen = (name = objectName): InstanceType<typeof EthereumRevealPublisherObject> => {
    const publisher = new EthereumRevealPublisherObject({ waitUntil() {}, abort() { aborts++; },
    id: { equals: (id: DurableObjectId) => id.toString() === name } } as never,
    { ETHEREUM_REVEAL_METADATA: bucket, OPS_DB: database, COMMERCE_DB: database,
      ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: currentContract,
      ETHEREUM_REVEAL: { getByName: () => ({ validatePublication: async (_scope: unknown, job: MetadataWrite) => {
        const current = desired.get(job.tokenId);
        return !current || current.metadataRevision === job.metadataRevision && current.metadataJson === job.metadataJson &&
          current.allowMissing === job.allowMissing && JSON.stringify(current.expectedJsons) === JSON.stringify(job.expectedJsons);
      } }) },
      ETHEREUM_REVEAL_PUBLISHER: { idFromName: (name: string) => ({ toString: () => name }),
        getByName: (name: string) => publishers.get(name) ?? reopen(name) } } as unknown as Env);
    publishers.set(name, publisher);
    return publisher;
  };
  const retire = () => Object.assign(registry.row!, { state: 'paused', retired_at_ms: Date.now(), replacement_deployment_id: 'replacement', revision: 4 });
  return { publisher: reopen(), reopen, retire, registry, bucket, objects, writes, desired, reads: () => reads, aborts: () => aborts };
}

for (const previous of ['absent', 'placeholder', 'published'] as const) test(`publisher handles ${previous} metadata idempotently`, async () => {
  const f = fixture();
  const item = job();
  if (previous !== 'absent') f.objects.set(key(), { body: previous === 'published' ? item.metadata_json : item.placeholder_json,
    etag: 'original', httpMetadata: jsonHeaders });
  assert.deepEqual(await f.publisher.publishBatch(scope, [item]), [{ tokenId: '1', status: 'published' }]);
  assert.equal(f.objects.get(key())?.body, item.metadata_json);
  assert.equal(f.writes.length, previous === 'published' ? 0 : 1);
  if (f.writes.length) assert.deepEqual(f.writes[0].options, {
    onlyIf: previous === 'absent' ? { etagDoesNotMatch: '*' } : { etagMatches: 'original' },
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    customMetadata: { revealDeployment: scope.deploymentId, revealToken: '1', revealMetadataRevision: '0' },
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
    f.objects.set(key(), { body: job().metadata_json, etag: 'concurrent', httpMetadata: jsonHeaders });
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

test('a replacement invalidates delayed reads and stale retries without blocking another token', async () => {
  const f = fixture();
  f.objects.set(key(), { body: job().placeholder_json, etag: 'placeholder', httpMetadata: jsonHeaders });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const get = f.bucket.get;
  f.bucket.get = async objectKey => { const value = await get(objectKey); if (objectKey === key()) { entered.resolve(); await release.promise; } return value; };
  const old = f.publisher.publishBatch(scope, [job()]);
  await entered.promise;
  f.desired.set('1', metadataWrite(replacementJob()));
  assert.equal((await f.publisher.publishBatch(scope, [job('2')]))[0].status, 'published');
  release.resolve();
  assert.equal((await old)[0].status, 'superseded');
  assert.equal(f.objects.get(key())?.body, job().placeholder_json);
  assert.equal((await f.publisher.publishBatch(scope, [replacementJob()]))[0].status, 'published');
  const reads = f.reads();
  assert.equal((await f.publisher.publishBatch(scope, [job()]))[0].status, 'superseded');
  assert.equal(f.reads(), reads);
  assert.equal(f.objects.get(key())?.body, replacementJob().metadata_json);
});

for (const winner of ['old', 'replacement']) test(`conditional writes preserve the replacement when the ${winner} PUT wins after a restart`, async () => {
  const f = fixture();
  f.objects.set(key(), { body: job().placeholder_json, etag: 'placeholder', httpMetadata: jsonHeaders });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const put = f.bucket.put;
  f.bucket.put = async (...args) => {
    if (args[1] === job().metadata_json) { entered.resolve(); await release.promise; }
    return put(...args);
  };
  const old = f.publisher.publishBatch(scope, [job()]);
  await entered.promise;
  f.desired.set('1', metadataWrite(replacementJob()));
  const current = f.reopen();
  if (winner === 'replacement') {
    assert.equal((await current.publishBatch(scope, [replacementJob()]))[0].status, 'published');
    release.resolve();
    assert.equal((await old)[0].status, 'retry');
  } else {
    const read = Promise.withResolvers<void>(), continueRead = Promise.withResolvers<void>();
    const get = f.bucket.get;
    f.bucket.get = async objectKey => { const value = await get(objectKey); read.resolve(); await continueRead.promise; return value; };
    const replacement = current.publishBatch(scope, [replacementJob()]);
    await read.promise;
    release.resolve();
    assert.equal((await old)[0].status, 'published');
    continueRead.resolve();
    assert.equal((await replacement)[0].status, 'retry');
    assert.equal((await current.publishBatch(scope, [replacementJob()]))[0].status, 'published');
  }
  assert.equal(f.objects.get(key())?.body, replacementJob().metadata_json);
  assert.equal((await current.publishBatch(scope, [job()]))[0].status, 'superseded');
});

test('two replacement writes leave all eight ordinary publication slots available', async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  const get = f.bucket.get;
  f.bucket.get = async objectKey => { await release.promise; return get(objectKey); };
  const replacements = f.publisher.publishBatch(scope, [replacementJob('20'), replacementJob('21')]);
  const ordinary = f.publisher.publishBatch(scope, Array.from({ length: 8 }, (_, index) => job(String(index + 1))));
  assert.equal((await f.publisher.publishBatch(scope, [replacementJob('22')]))[0].status, 'retry');
  assert.equal((await f.publisher.publishBatch(scope, [job('9')]))[0].status, 'retry');
  release.resolve();
  assert.ok((await replacements).every(result => result.status === 'published'));
  assert.ok((await ordinary).every(result => result.status === 'published'));
  assert.equal(f.writes.length, 10);
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
  let release!: (value: ArrayBuffer) => void;
  f.bucket.get = async () => ({ size: job().placeholder_json.length, etag: 'original',
    arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve; }) } as R2ObjectBody);
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()], Date.now() + 20), [{ tokenId: '1', status: 'retry' }]);
  release(new TextEncoder().encode(job().placeholder_json).buffer);
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

for (const invalid of ['missing', 'retired', 'unsupported', 'deployment', 'prefix'] as const) {
  test(`publisher refuses ${invalid} registry scope before R2 access`, async () => {
    const f = fixture();
    if (invalid === 'missing') f.registry.row = null;
    else if (invalid === 'retired') f.retire();
    else f.registry.row![invalid === 'unsupported' ? 'catalog_version' : invalid === 'deployment' ? 'deployment_id' : 'metadata_base_uri'] =
      invalid === 'unsupported' ? '111k-v4' : invalid === 'deployment' ? 'other' : 'https://cdn.mons.shop/111k-sepolia/other/';
    await assert.rejects(f.publisher.publishBatch(scope, [job()]), invalid === 'unsupported' ? /catalog is not supported/ : /not current and registered/);
    assert.equal(f.reads(), 0);
    assert.equal(f.writes.length, 0);
  });
}

test('publisher preserves admitted publication for a paused current catalog', async () => {
  const f = fixture();
  f.registry.row!.state = 'paused';
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()]), [{ tokenId: '1', status: 'published' }]);
  await assert.rejects(f.publisher.drainRetired({ deploymentId: scope.deploymentId, expectedRevision: 3 }), /retired Sepolia/);
  assert.deepEqual(await f.publisher.publishBatch(scope, [job('2')]), [{ tokenId: '2', status: 'published' }]);
});

test('a wrong retired scope cannot poison a healthy publisher instance', async () => {
  const f = fixture();
  const foreign = { ...scope, deploymentId: 'foreign-old', contractAddress: `0x${'55'.repeat(20)}`,
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/foreign-old/' };
  f.registry.row = { ...registration, deployment_id: foreign.deploymentId, contract_address: foreign.contractAddress,
    metadata_base_uri: foreign.metadataBaseUri, state: 'paused', retired_at_ms: 100, replacement_deployment_id: 'foreign-new' };
  await assert.rejects(f.publisher.publishBatch(foreign, [job()]), /object does not match/);
  f.registry.row = { ...registration };
  assert.deepEqual(await f.publisher.publishBatch(scope, [job()]), [{ tokenId: '1', status: 'published' }]);
  assert.equal(f.writes.length, 1);
});

test('retired publisher fences new batches and drains the actual pending PUT before confirming', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const put = f.bucket.put;
  f.bucket.put = async (...args) => { entered.resolve(); await release.promise; return put(...args); };
  const publication = f.publisher.publishBatch(scope, [job()]);
  await entered.promise;
  f.retire();
  let completed = false;
  const drain = f.publisher.drainRetired({ deploymentId: scope.deploymentId, expectedRevision: 4 }).then(result => { completed = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(completed, false);
    assert.deepEqual(await f.publisher.publishBatch(scope, [job('2')]), [{ tokenId: '2', status: 'retry' }]);
    release.resolve();
    assert.deepEqual(await drain, { drained: true });
    assert.deepEqual(await publication, [{ tokenId: '1', status: 'published' }]);
    assert.equal(f.writes.length, 1);
    await assert.rejects(f.reopen().publishBatch(scope, [job('2')]), /not current and registered/);
    assert.equal(f.writes.length, 1);
  } finally { release.resolve(); await Promise.allSettled([publication, drain]); }
});

test('retirement during a stalled GET prevents its continuation from starting a PUT', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const get = f.bucket.get;
  f.bucket.get = async key => { entered.resolve(); await release.promise; return get(key); };
  const publication = f.publisher.publishBatch(scope, [job()]);
  await entered.promise;
  f.retire();
  const drain = f.publisher.drainRetired({ deploymentId: scope.deploymentId, expectedRevision: 4 });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    release.resolve();
    assert.deepEqual(await publication, [{ tokenId: '1', status: 'retry' }]);
    assert.deepEqual(await drain, { drained: true });
    assert.equal(f.writes.length, 0);
  } finally { release.resolve(); await Promise.allSettled([publication, drain]); }
});

test('a same-catalog marker is checked again after a stalled GET even before the local drain RPC arrives', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const get = f.bucket.get;
  f.bucket.get = async key => { entered.resolve(); await release.promise; return get(key); };
  const publication = f.publisher.publishBatch(scope, [job()]);
  try {
    await entered.promise;
    Object.assign(f.registry.row!, { state: 'paused', retired_at_ms: Date.now(), replacement_deployment_id: 'replacement', revision: 4 });
    release.resolve();
    assert.deepEqual(await publication, [{ tokenId: '1', status: 'retry' }]);
    assert.equal(f.writes.length, 0);
    await assert.rejects(f.reopen().publishBatch(scope, [job()]), /not current and registered/);
    assert.deepEqual(await f.publisher.drainRetired({ deploymentId: scope.deploymentId, expectedRevision: 4 }), { drained: true });
    assert.equal(f.writes.length, 0);
  } finally { release.resolve(); await publication; }
});

test('a timed-out PUT remains in the retirement drain and a resetting executor never confirms success', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const put = f.bucket.put;
  f.bucket.put = async (...args) => { entered.resolve(); await release.promise; return put(...args); };
  const publication = f.publisher.publishBatch(scope, [job()], Date.now() + 20);
  await entered.promise;
  assert.deepEqual(await publication, [{ tokenId: '1', status: 'retry' }]);
  f.retire();
  let settled = false;
  const drain = f.publisher.drainRetired({ deploymentId: scope.deploymentId, expectedRevision: 4 });
  const rejection = assert.rejects(drain, /restart/).then(() => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(settled, false);
    assert.equal(f.writes.length, 0);
    release.resolve();
    await rejection;
    assert.equal(f.writes.length, 1);
    assert.deepEqual(await f.reopen().drainRetired({ deploymentId: scope.deploymentId, expectedRevision: 4 }), { drained: true });
  } finally { release.resolve(); await rejection; }
});

test('native publisher timeout resets its instance and retries frozen work through a fresh instance', { timeout: 10_000 }, async () => {
  const [{ build }, { Miniflare }] = await Promise.all([import('esbuild'), import('miniflare')]);
  const items = Array.from({ length: 8 }, (_, index) => job(String(index + 1)));
  const source = `
    import { EthereumRevealPublisherObject } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumRevealPublisherObject.ts'))};
    export class NativePublisher extends EthereumRevealPublisherObject {
      constructor(ctx, env) {
        const state = { stalled: true, writes: 0 };
        super(ctx, { ETHEREUM_REVEAL_PUBLISHER: env.PUBLISHER,
          ETHEREUM_REVEAL: { getByName: () => ({ validatePublication: async () => true }) },
          OPS_DB: { prepare: () => ({ bind: () => ({ first: async () => (${JSON.stringify(registration)}) }) }) }, ETHEREUM_REVEAL_METADATA: {
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
      const object = env.PUBLISHER.getByName(${JSON.stringify(`${scope.chainId}:${scope.contractAddress}`)});
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

test('attribute publication replaces only exact base bytes and reconciles a lost acknowledgment', async () => {
  const f = fixture();
  const name = attributePublisherName(scope);
  const publisher = f.reopen(name);
  const item = { tokenId: '1', baseJson: job().metadata_json, metadataJson: '{"attributes":[{"trait_type":"collection block","value":"B"}]}', metadataRevision: 1 };
  const publish = () => publisher.publishAttributes(scope, item, Date.now() + 5_000);
  assert.equal((await publish()).status, 'conflict');
  for (const body of [job().placeholder_json, 'other', '\ufeff' + item.baseJson]) {
    f.objects.set(key(), { body, etag: 'existing' });
    assert.equal((await publish()).status, 'conflict');
  }
  assert.equal(f.writes.length, 0);
  f.objects.set(key(), { body: item.baseJson, etag: 'base' });
  const put = f.bucket.put;
  f.bucket.put = async (...args) => { await put(...args); throw new Error('Lost acknowledgment'); };
  assert.equal((await publish()).status, 'retry');
  assert.equal(f.objects.get(key())?.body, item.metadataJson);
  assert.deepEqual(f.writes[0].options.onlyIf, { etagMatches: 'base' });
  assert.deepEqual(f.writes[0].options.httpMetadata, { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' });
  assert.equal((await f.reopen(name).publishAttributes(scope, item, Date.now() + 5_000)).status, 'published');
  assert.equal(f.writes.length, 1);
  assert.equal((await f.publisher.publishAttributes(scope, item, Date.now() + 5_000)).status, 'published');
  await assert.rejects(publisher.publishBatch(scope, [job()]), /does not match/);
});

for (const stage of ['media', 'attributes'] as const) test(`${stage} publication repairs headers on matching bytes with a conditional write`, async () => {
  const f = fixture();
  const publisher = f.reopen(attributePublisherName(scope));
  const item = job();
  const publish = async () => stage === 'media' ? (await f.publisher.publishBatch(scope, [item]))[0]
    : publisher.publishAttributes(scope, { tokenId: item.token_id, baseJson: item.placeholder_json, metadataJson: item.metadata_json, metadataRevision: 1 }, Date.now() + 5_000);
  for (const httpMetadata of [undefined, { ...jsonHeaders, contentType: 'application/octet-stream' },
    { ...jsonHeaders, cacheControl: 'max-age=3600' }, { ...jsonHeaders, contentEncoding: 'gzip' }]) {
    f.objects.set(key(), { body: item.metadata_json, etag: 'restored', httpMetadata });
    const writesBefore = f.writes.length;
    assert.equal((await publish()).status, 'published');
    assert.equal(f.objects.get(key())?.body, item.metadata_json);
    assert.deepEqual(f.objects.get(key())?.httpMetadata, jsonHeaders);
    assert.deepEqual(f.writes.at(-1)?.options.onlyIf, { etagMatches: 'restored' });
    assert.equal((await publish()).status, 'published');
    assert.equal(f.writes.length, writesBefore + 1);
  }
  f.objects.set(key(), { body: item.metadata_json, etag: 'restored' });
  const put = f.bucket.put;
  f.bucket.put = async (...args) => {
    f.objects.set(key(), { body: 'changed concurrently', etag: 'changed' });
    return put(...args);
  };
  assert.equal((await publish()).status, 'retry');
  assert.equal((await publish()).status, 'conflict');
  assert.equal(f.objects.get(key())?.body, 'changed concurrently');
});

test('attribute publisher drains header repairs and refuses new writes after retirement', async () => {
  const f = fixture();
  const publisher = f.reopen(attributePublisherName(scope));
  const item = { tokenId: '1', baseJson: job().metadata_json, metadataJson: '{"enriched":true}', metadataRevision: 1 };
  f.objects.set(key(), { body: item.metadataJson, etag: 'restored', httpMetadata: { contentType: 'application/octet-stream' } });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const put = f.bucket.put;
  f.bucket.put = async (...args) => { entered.resolve(); await release.promise; return put(...args); };
  const write = publisher.publishAttributes(scope, item, Date.now() + 5_000);
  await entered.promise;
  Object.assign(f.registry.row!, { state: 'paused', retired_at_ms: Date.now(), replacement_deployment_id: 'replacement', revision: 4 });
  let drained = false;
  const drain = Promise.all([publisher, f.publisher].map(writer => writer.drainRetired({ deploymentId: scope.deploymentId, expectedRevision: 4 })))
    .then(() => { drained = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(drained, false);
    assert.equal((await publisher.publishAttributes(scope, item, Date.now() + 5_000)).status, 'retry');
    release.resolve();
    await Promise.all([write, drain]);
    assert.equal(drained, true);
    assert.equal((await f.reopen(attributePublisherName(scope)).publishAttributes(scope, item, Date.now() + 5_000)).status, 'retry');
  } finally { release.resolve(); await Promise.allSettled([write, drain]); }
});

test('attribute preparation bounds source reads and retirement waits for aborted I/O to settle', async t => {
  const f = fixture();
  const publisher = f.reopen(attributePublisherName(scope));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.ok(init?.signal);
    signals.push(init.signal);
    if (signals.length === 4) entered.resolve();
    await release.promise;
    return Response.json({ 'collection block': 'First', attributes: [] });
  });
  const source = { category: 'painting' as const, assetId: 1, baseJson: '{"attributes":[]}' };
  const prepare = () => publisher.prepareAttributes(scope, source, Date.now() + 5_000);
  await assert.rejects(f.publisher.prepareAttributes(scope, source, Date.now() + 5_000), /does not match/);
  const work = Promise.all([prepare(), prepare(), prepare(), prepare()]);
  try {
    await entered.promise;
    assert.deepEqual(await prepare(), { status: 'source-unavailable' });
    assert.equal(signals.length, 4);
    Object.assign(f.registry.row!, { state: 'paused', retired_at_ms: Date.now(), replacement_deployment_id: 'replacement', revision: 4 });
    let drained = false;
    const drain = publisher.drainRetired({ deploymentId: scope.deploymentId, expectedRevision: 4 }).then(() => { drained = true; });
    assert.ok((await work).every(result => result.status === 'source-unavailable'));
    assert.ok(signals.every(s => s.aborted));
    assert.equal(drained, false);
    release.resolve();
    await drain;
    assert.deepEqual(await prepare(), { status: 'source-unavailable' });
    assert.equal(f.writes.length, 0);
  } finally { release.resolve(); await work; }
});

const relicJson = (tokenId = '117172') => `{ "name": "Relic", "description": "", "image": "https://cdn.lil.org/nft/111k/relics/${Number(tokenId) - 117171}.webp", "attributes": [{"trait_type":"number","value":12345678901234567890}] }\n`;
const relicScope = { ...scope, expectedRevision: 3 };
const relicRequest = (): RelicImagesRequest => ({ scope: relicScope, action: 'apply',
  patch: prepareRelicImagePatch('117172', relicJson(), 'original') });

test('relic maintenance inspects exactly 18 objects and applies only the prepared image bytes and checksum', async () => {
  const f = fixture();
  for (const tokenId of RELIC_IMAGE_TOKEN_IDS) f.objects.set(key(tokenId), { body: relicJson(tokenId), etag: 'original',
    httpMetadata: jsonHeaders, customMetadata: { sha256: 'old', preserved: 'yes' } });
  const result = await f.publisher.relicImages({ scope: relicScope, action: 'inspect' });
  assert.equal(result.action, 'inspect');
  if (result.action !== 'inspect') return;
  assert.equal(result.objects.length, 18);
  assert.deepEqual(result.objects.map(patch => patch.tokenId), RELIC_IMAGE_TOKEN_IDS);
  assert.equal(f.reads(), 18);
  assert.equal(f.writes.length, 0);
  const patch = result.objects[0];
  assert.deepEqual(await f.publisher.relicImages({ scope: relicScope, action: 'apply', patch }),
    { action: 'apply', tokenId: '117172', status: 'updated' });
  assert.deepEqual(f.writes[0].options, { onlyIf: { etagMatches: 'original' }, httpMetadata: jsonHeaders,
    customMetadata: { sha256: patch.afterSha256, preserved: 'yes' } });
  assert.equal(f.objects.get(key('117172'))?.body, patch.afterJson);
  assert.deepEqual(await f.publisher.relicImages({ scope: relicScope, action: 'apply', patch }),
    { action: 'apply', tokenId: '117172', status: 'unchanged' });
  assert.equal(f.writes.length, 1);
  const second = await f.publisher.relicImages({ scope: relicScope, action: 'inspect' });
  assert.equal(second.action === 'inspect' && second.objects[0].beforeJson, patch.afterJson);
});

for (const invalid of ['revision', 'retired', 'catalog-update', 'deployment', 'prefix', 'missing', 'drop', 'provisioning']) {
  test(`relic maintenance rejects ${invalid} before accessing R2`, async () => {
    const f = fixture();
    if (invalid === 'missing') f.registry.row = null;
    if (invalid === 'revision') f.registry.row!.revision = 4;
    if (invalid === 'retired') f.retire();
    if (invalid === 'catalog-update') Object.assign(f.registry.row!, { catalog_update_id: 'pending', catalog_update_started_at_ms: 1 });
    if (invalid === 'deployment') f.registry.row!.deployment_id = 'different';
    if (invalid === 'prefix') f.registry.row!.metadata_base_uri = 'https://cdn.mons.shop/111k-sepolia/different/';
    if (invalid === 'drop') f.registry.row!.drop_id = 'other';
    if (invalid === 'provisioning') f.registry.row!.state = 'provisioning';
    await assert.rejects(f.publisher.relicImages(relicRequest()), /identity, revision, or maintenance state/);
    assert.equal(f.reads(), 0);
    assert.equal(f.writes.length, 0);
  });
}

test('relic maintenance rechecks registry changes after reading the object', async () => {
  const f = fixture();
  f.objects.set(key('117172'), { body: relicJson(), etag: 'original', httpMetadata: jsonHeaders });
  const get = f.bucket.get;
  f.bucket.get = async key => { const result = await get(key); f.registry.row!.revision = 4; return result; };
  await assert.rejects(f.publisher.relicImages(relicRequest()), /identity, revision, or maintenance state/);
  assert.equal(f.writes.length, 0);
});

test('relic maintenance rejects stale ETags, foreign bytes and concurrent writes', async () => {
  const f = fixture();
  for (const value of [{ body: relicJson(), etag: 'new-etag' }, { body: relicJson().replace('Relic', 'Foreign'), etag: 'original' }]) {
    f.objects.set(key('117172'), { ...value, httpMetadata: jsonHeaders });
    await assert.rejects(f.publisher.relicImages(relicRequest()), /changed since preparation/);
    assert.equal(f.writes.length, 0);
  }
  f.objects.set(key('117172'), { body: relicJson(), etag: 'original', httpMetadata: jsonHeaders });
  const put = f.bucket.put;
  f.bucket.put = async (...args) => { f.objects.set(key('117172'), { body: 'foreign', etag: 'concurrent' }); return put(...args); };
  await assert.rejects(f.publisher.relicImages(relicRequest()), /conditional write conflicted/);
  assert.equal(f.objects.get(key('117172'))?.body, 'foreign');
});

test('relic maintenance reconciles an acknowledged-lost write on retry', async () => {
  const f = fixture();
  f.objects.set(key('117172'), { body: relicJson(), etag: 'original', httpMetadata: jsonHeaders });
  const put = f.bucket.put;
  f.bucket.put = async (...args) => { await put(...args); throw new Error('Lost acknowledgment'); };
  await assert.rejects(f.publisher.relicImages(relicRequest()), /Lost acknowledgment/);
  assert.deepEqual(await f.publisher.relicImages(relicRequest()), { action: 'apply', tokenId: '117172', status: 'unchanged' });
  assert.equal(f.writes.length, 1);
});

test('relic maintenance leaves ordinary artwork guards intact and rejects attribute publisher routing', async () => {
  const f = fixture();
  assert.throws(() => f.publisher.publishBatch(scope, [job('117172')]), /Invalid reveal publication metadata/);
  assert.throws(() => f.reopen(attributePublisherName(scope)).relicImages(relicRequest()), /object does not match/);
  assert.equal(f.reads(), 0);
});

test('relic maintenance bounds stalled reads and blocks overlapping operations', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<R2ObjectBody | null>();
  f.bucket.get = () => { entered.resolve(); return release.promise; };
  const operation = f.publisher.relicImages(relicRequest(), Date.now() + 20);
  await entered.promise;
  assert.throws(() => f.publisher.relicImages(relicRequest()), /already running maintenance/);
  await assert.rejects(operation, /timed out/);
  release.resolve(null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.aborts(), 1);
  assert.equal(f.writes.length, 0);
});

test('retirement drains an in-flight relic write before confirming storage is quiet', async () => {
  const f = fixture();
  f.objects.set(key('117172'), { body: relicJson(), etag: 'original', httpMetadata: jsonHeaders });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const put = f.bucket.put;
  f.bucket.put = async (...args) => { entered.resolve(); await release.promise; return put(...args); };
  const operation = f.publisher.relicImages(relicRequest());
  const rejected = assert.rejects(operation, /unavailable/);
  await entered.promise;
  f.retire();
  let drained = false;
  const drain = f.publisher.drainRetired({ deploymentId: scope.deploymentId, expectedRevision: 4 }).then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(drained, false);
  release.resolve();
  await rejected;
  await drain;
  assert.equal(drained, true);
  assert.equal(f.writes.length, 1);
});

test('relic maintenance rejects noncanonical headers before inspection, update, or unchanged success', async () => {
  const f = fixture();
  const patch = prepareRelicImagePatch('117172', relicJson(), 'original');
  for (const httpMetadata of [undefined, { ...jsonHeaders, contentType: 'application/octet-stream' },
    { ...jsonHeaders, cacheControl: 'public,max-age=3600' }, { ...jsonHeaders, contentEncoding: 'gzip' }]) {
    for (const body of [patch.beforeJson, patch.afterJson]) {
      f.objects.set(key('117172'), { body, etag: 'original', httpMetadata });
      await assert.rejects(f.publisher.relicImages({ scope: relicScope, action: 'inspect' }), /HTTP headers are not canonical/);
      await assert.rejects(f.publisher.relicImages({ scope: relicScope, action: 'apply', patch }), /HTTP headers are not canonical/);
    }
  }
  assert.equal(f.writes.length, 0);
});

test('relic maintenance rejects a body whose byte length differs from its declared size', async () => {
  const f = fixture();
  f.bucket.get = async () => ({ size: 1, etag: 'original', httpMetadata: jsonHeaders,
    arrayBuffer: async () => new TextEncoder().encode(relicJson()).buffer } as R2ObjectBody);
  await assert.rejects(f.publisher.relicImages(relicRequest()), /size is invalid/);
  assert.equal(f.writes.length, 0);
});
