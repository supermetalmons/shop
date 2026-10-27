import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { ethereumPlaceholderMetadata } from '../shared/ethereum/placeholderMetadata.ts';
import { inBatches, metadataCounts, metadataIdentities, metadataObjects, metadataPrefix, sha256, type MetadataObject } from '../scripts/ethereum-metadata/catalog.ts';
import { metadataUploadConcurrency, uploadMetadataObject, uploadWithConcurrency } from '../scripts/ethereum-metadata/upload.ts';
import localMetadataWorker from '../scripts/ethereum-metadata/local-worker.ts';

const imageSvg = (image: string) => Buffer.from(image.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');

test('CDN artwork and receipt SVGs preserve the original committed renderer fixtures exactly', async () => {
  const reference = JSON.parse(await readFile(new URL('../scripts/ethereum-metadata/reference-artwork.json', import.meta.url), 'utf8'));
  assert.equal(reference.sourceFile, 'onchain/ethereum/fixtures/metadata.json');
  assert.match(reference.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(reference.entries.length, 3);
  for (const entry of reference.entries) {
    assert.equal(ethereumPlaceholderMetadata(entry.kind, entry.displayId, 'sepolia').image, entry.image);
    assert.equal(ethereumPlaceholderMetadata(entry.kind, entry.displayId, 'mainnet').image, entry.image);
  }
});

test('metadata identifies its actual network and offchain location without changing the schema', () => {
  for (const network of ['sepolia', 'mainnet'] as const) {
    const metadata = ethereumPlaceholderMetadata(4, 222222, network);
    assert.deepEqual(Object.keys(metadata), ['name', 'description', 'image', 'attributes']);
    assert.equal(metadata.name, '111K Artwork Receipt #222222');
    assert.deepEqual(metadata.attributes, [
      { trait_type: 'Type', value: 'Artwork Receipt' },
      { trait_type: 'Item number', value: 222222 },
      { trait_type: 'Network', value: network === 'sepolia' ? 'Sepolia' : 'Ethereum Mainnet' },
    ]);
    assert.match(metadata.description, /served from the collection CDN/);
    assert.doesNotMatch(metadata.description, /onchain/);
    if (network === 'mainnet') assert.doesNotMatch(metadata.description, /test/i);
    assert.match(metadata.image, /^data:image\/svg\+xml;base64,/);
  }
  for (const [kind, id] of [[0, 1], [6, 1], [1, 0], [1, 111112], [4, 222223], [2, 5556], [3, 506], [4, 1.5], [NaN, 1]]) {
    assert.throws(() => ethereumPlaceholderMetadata(kind, id), /Invalid 111K metadata identity/);
  }
});

test('metadata coverage includes all exact token filenames without overlap or gaps', () => {
  const identities = [...metadataIdentities()];
  assert.equal(identities.length, 344948);
  assert.equal(new Set(identities.map(item => item.file)).size, 344948);
  assert.deepEqual(metadataCounts(), { artwork: 111111, crate: 5555, warehouse: 505, artwork_receipt: 222222, crate_receipt: 5555 });
  assert.deepEqual(identities.filter(item => [1, 111111, 111112, 116666, 116667, 117171, 1000001, 1222222, 2000001, 2005555].includes(Number(item.tokenId))).map(item => [item.tokenId, item.kind, item.displayId]), [
    ['1', 1, 1], ['111111', 1, 111111], ['111112', 2, 1], ['116666', 2, 5555], ['116667', 3, 1], ['117171', 3, 505],
    ['1000001', 4, 1], ['1222222', 4, 222222], ['2000001', 5, 1], ['2005555', 5, 5555],
  ]);
  assert.equal(metadataPrefix('sepolia'), '111k-sepolia/');
  assert.equal(metadataPrefix('mainnet'), '111k/');
});

test('all 222222 artwork placeholders have distinct visible center geometry and no artwork number text', () => {
  const centers = new Set<string>();
  for (let id = 1; id <= 222222; id++) {
    const svg = imageSvg(ethereumPlaceholderMetadata(4, id).image);
    const artwork = svg.match(/overflow="hidden">(.*?)<\/svg>/)?.[1];
    assert.ok(artwork);
    assert.doesNotMatch(artwork, /<text\b/);
    const circle = artwork.match(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)" fill="#efb84c"\/>/);
    assert.ok(circle);
    const key = circle.slice(1).join(':');
    assert.ok(!centers.has(key), `Duplicate visible geometry for artwork ${id}`);
    centers.add(key);
  }
  assert.equal(centers.size, 222222);
});

test('digital artwork and its receipt share the same flower across palette and petal variants', () => {
  for (const id of [1, 2, 3, 4, 42, 111080, 111081, 111111]) {
    const artworkSvg = imageSvg(ethereumPlaceholderMetadata(1, id).image);
    const receiptSvg = imageSvg(ethereumPlaceholderMetadata(4, id).image);
    const artwork = artworkSvg.slice(artworkSvg.indexOf('>') + 1, -6);
    assert.equal(receiptSvg.match(/overflow="hidden">(.*?)<\/svg>/)?.[1], artwork);
    assert.notEqual(ethereumPlaceholderMetadata(4, id).image, ethereumPlaceholderMetadata(4, id + 111111).image);
  }
});

test('object manifests reject missing coverage, duplicates, and unsafe filenames', async t => {
  const directory = await mkdtemp(join(tmpdir(), '111k-metadata-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = metadataIdentities().next().value!;
  const row = { ...first, sha256: 'a'.repeat(64), bytes: 10 };
  for (const rows of [[row], [row, row], [{ ...row, file: '../1.json' }]]) {
    await writeFile(join(directory, 'objects.jsonl'), rows.map(value => JSON.stringify(value) + '\n').join(''));
    await assert.rejects(async () => { for await (const object of metadataObjects(directory)) assert.ok(object); }, /coverage|incomplete/);
  }
});

const body = Buffer.from(JSON.stringify(ethereumPlaceholderMetadata(1, 42)) + '\n');
const object: MetadataObject = { tokenId: '42', kind: 1, displayId: 42, file: '42.json', bytes: body.length, sha256: sha256(body) };
const destination = { endpoint: 'https://example.r2.cloudflarestorage.com', bucket: 'mons-shop-cdn', prefix: '111k-sepolia/' };
const etag = `"${createHash('md5').update(body).digest('hex')}"`;

test('uploader sends bounded-scope conditional writes with transport and manifest checksums', async () => {
  let calls = 0;
  const client = { send: async (command: PutObjectCommand) => {
    calls++;
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.Bucket, 'mons-shop-cdn');
    assert.equal(command.input.Key, '111k-sepolia/42.json');
    assert.equal(command.input.IfNoneMatch, '*');
    assert.equal(command.input.ContentMD5, createHash('md5').update(body).digest('base64'));
    assert.equal(command.input.Metadata?.sha256, object.sha256);
    assert.equal(command.input.ContentType, 'application/json; charset=utf-8');
    return { ETag: etag };
  } } as unknown as Pick<S3Client, 'send'>;
  await uploadMetadataObject(client, destination, object, body);
  assert.equal(calls, 1);
  await assert.rejects(uploadMetadataObject(client, destination, object, Buffer.from('modified')), /Local checksum mismatch/);
  assert.equal(calls, 1);
});

test('uploader reconciles identical interrupted writes and rejects different existing content', async () => {
  let matches = true;
  const client = { send: async (command: PutObjectCommand | HeadObjectCommand) => {
    if (command instanceof PutObjectCommand) throw { $metadata: { httpStatusCode: 412 } };
    assert.ok(command instanceof HeadObjectCommand);
    return { ContentLength: body.length, ETag: etag, Metadata: { sha256: matches ? object.sha256 : 'f'.repeat(64) } };
  } } as unknown as Pick<S3Client, 'send'>;
  await uploadMetadataObject(client, destination, object, body);
  matches = false;
  await assert.rejects(uploadMetadataObject(client, destination, object, body), /different metadata/);
});

for (const stalled of ['PUT', 'HEAD']) {
  test(`uploader aborts a stalled ${stalled} and stops the upload pool`, { timeout: 1000 }, async t => {
    const controller = new AbortController();
    const timeout = new DOMException('Upload timed out', 'TimeoutError');
    const deadline = t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      assert.equal(milliseconds, 30_000);
      return controller.signal;
    });
    let started!: () => void;
    const pendingRequest = new Promise<void>(resolve => { started = resolve; });
    const methods: string[] = [];
    const client = { send: async (command: PutObjectCommand | HeadObjectCommand, options?: { abortSignal?: AbortSignal }) => {
      methods.push(command instanceof PutObjectCommand ? 'PUT' : 'HEAD');
      if (stalled === 'HEAD' && command instanceof PutObjectCommand) {
        assert.equal(options?.abortSignal, controller.signal);
        throw { $metadata: { httpStatusCode: 412 } };
      }
      started();
      assert.equal(options?.abortSignal, controller.signal);
      return new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
    } } as unknown as Pick<S3Client, 'send'>;
    const upload = uploadWithConcurrency([object, object], 1, item => uploadMetadataObject(client, destination, item, body));
    const rejected = assert.rejects(upload, error => error === timeout);
    await pendingRequest;
    controller.abort(timeout);
    await rejected;
    assert.deepEqual(methods, stalled === 'PUT' ? ['PUT'] : ['PUT', 'HEAD']);
    assert.equal(deadline.mock.callCount(), 1);
  });
}

test('local metadata service matches production placeholders and rejects invalid paths and methods', async () => {
  for (const [prefix, network] of [['111k-sepolia', 'sepolia'], ['111k', 'mainnet']] as const) {
    const response = localMetadataWorker.fetch(new Request(`http://localhost/${prefix}/1222222.json`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), ethereumPlaceholderMetadata(4, 222222, network));
  }
  for (const path of ['/111k/0.json', '/111k/01.json', '/111k/117172.json', '/111k/1222223.json', '/other/1.json', '/111k/1.svg']) {
    assert.equal(localMetadataWorker.fetch(new Request(`http://localhost${path}`)).status, 404);
  }
  assert.equal(localMetadataWorker.fetch(new Request('http://localhost/111k/1.json', { method: 'POST' })).status, 405);
  const head = localMetadataWorker.fetch(new Request('http://localhost/111k/1.json', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('batch operations bound concurrency and await all started work before reporting failure', async () => {
  let active = 0;
  let peak = 0;
  let completed = 0;
  await assert.rejects(inBatches([1, 2, 3, 4, 5], 3, async id => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, id === 1 ? 1 : 5));
    active--;
    completed++;
    if (id === 1) throw new Error('test failure');
  }), /test failure/);
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(completed, 3);
});

test('upload workers refill free slots while a slower upload is still running', { timeout: 1000 }, async t => {
  let releaseFirst!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  t.after(releaseFirst);
  let thirdStarted!: () => void;
  const third = new Promise<void>(resolve => { thirdStarted = resolve; });
  const started: number[] = [];
  const completed: number[] = [];
  let active = 0;
  let peak = 0;
  const result = uploadWithConcurrency([1, 2, 3, 4], 2, async id => {
    started.push(id);
    active++;
    peak = Math.max(peak, active);
    if (id === 1) await first;
    if (id === 3) thirdStarted();
    active--;
    completed.push(id);
  });
  await third;
  assert.ok(started.includes(3));
  assert.ok(!completed.includes(1));
  releaseFirst();
  await result;
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual([...completed].sort(), [1, 2, 3, 4]);
});

test('upload workers stop scheduling after failure and drain active uploads before rejecting', { timeout: 1000 }, async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  let failed!: () => void;
  const failureObserved = new Promise<void>(resolve => { failed = resolve; });
  const firstError = new Error('first upload failed');
  const started: number[] = [];
  const completed: number[] = [];
  let settled = false;
  const result = uploadWithConcurrency([1, 2, 3, 4, 5], 3, async id => {
    started.push(id);
    if (id === 1) {
      failed();
      throw firstError;
    }
    await held;
    completed.push(id);
    if (id === 3) throw new Error('later upload failed');
  }).finally(() => { settled = true; });
  const rejected = assert.rejects(result, error => error === firstError);
  await failureObserved;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(started, [1, 2, 3]);
  release();
  await rejected;
  assert.deepEqual(completed.sort(), [2, 3]);
  assert.deepEqual(started, [1, 2, 3]);
});

test('upload workers drain iterator failures and close the source', { timeout: 1000 }, async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  const sourceError = new Error('manifest read failed');
  let closed = false;
  let completed = false;
  async function* source() {
    try { yield 1; throw sourceError; } finally { closed = true; }
  }
  const result = uploadWithConcurrency(source(), 2, async () => { await held; completed = true; });
  const rejected = assert.rejects(result, error => error === sourceError);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true);
  assert.equal(completed, false);
  release();
  await rejected;
  assert.equal(completed, true);
  for (const concurrency of [0, 513, 1.5, NaN]) {
    await assert.rejects(uploadWithConcurrency([], concurrency, async () => {}), /Concurrency/);
  }
});

test('upload workers accept 512 slots while keeping the next object queued until a slot is free', { timeout: 1000 }, async t => {
  assert.equal(metadataUploadConcurrency(16), 16);
  assert.equal(metadataUploadConcurrency(512), 512);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  let started!: () => void;
  const saturated = new Promise<void>(resolve => { started = resolve; });
  let active = 0;
  let peak = 0;
  let completed = 0;
  let dispatched = 0;
  const result = uploadWithConcurrency(Array.from({ length: 513 }, (_, index) => index), 512, async () => {
    active++;
    peak = Math.max(peak, active);
    if (++dispatched === 512) started();
    await held;
    active--;
    completed++;
  });
  await saturated;
  assert.equal(dispatched, 512);
  assert.equal(completed, 0);
  release();
  await result;
  assert.equal(peak, 512);
  assert.equal(dispatched, 513);
  assert.equal(completed, 513);
  assert.equal(active, 0);
});
