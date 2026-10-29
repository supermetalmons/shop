import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { S3Client } from '@aws-sdk/client-s3';
import { metadataIdentities, sha256 } from '../scripts/ethereum-metadata/catalog.ts';
import { publishObjects, remoteInventory, restoreMetadata, selectedInventory, snapshotMetadata, snapshotObjects } from '../scripts/ethereum-metadata/remote.ts';
import {
  metadataMd5, S3MetadataStorage, uploadWithConcurrency,
  type MetadataListRange, type MetadataStorage, type RemoteObject,
} from '../scripts/ethereum-metadata/storage.ts';

const prefix = '111k-sepolia/';
const sourceHash = sha256('metadata publication test');
const publicationManifestSha256 = sha256('validated publication manifest');

class MemoryStorage implements MetadataStorage {
  destination = { endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, bucket: 'cdn-mons-shop' };
  values = new Map<string, Buffer>();
  reads: string[] = [];
  writes: string[] = [];
  failPut?: (key: string) => Promise<void>;
  listing?: RemoteObject[];
  listCalls: Array<{ prefix: string; range?: MetadataListRange }> = [];
  constructor(contents: Record<string, string> = { '1.json': 'old one', '2.json': 'old two', '3.json': 'old three' }) {
    for (const [file, value] of Object.entries(contents)) this.values.set(prefix + file, Buffer.from(value));
  }
  async *list(selectedPrefix: string, range?: MetadataListRange): AsyncGenerator<RemoteObject> {
    this.listCalls.push({ prefix: selectedPrefix, range });
    if (this.listing) {
      for (const row of this.listing) {
        if ((range?.startAfter === undefined || row.key > range.startAfter) &&
          (range?.endAt === undefined || row.key <= range.endAt)) yield row;
      }
      return;
    }
    for (const key of [...this.values.keys()].sort()) {
      if (key.startsWith(selectedPrefix) && (range?.startAfter === undefined || key > range.startAfter) &&
        (range?.endAt === undefined || key <= range.endAt)) {
        const body = this.values.get(key)!;
        yield { key, bytes: body.length, md5: metadataMd5(body) };
      }
    }
  }
  async get(key: string): Promise<Buffer> {
    this.reads.push(key);
    const body = this.values.get(key);
    if (!body) throw new Error('Missing object');
    return Buffer.from(body);
  }
  async put(key: string, body: Buffer): Promise<void> {
    this.writes.push(key);
    await this.failPut?.(key);
    this.values.set(key, Buffer.from(body));
  }
  close(): void {}
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), '111k-remote-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function mockSnapshotOutput(t: TestContext, createOutput: typeof fs.createWriteStream): void {
  const replacement = t.mock.method(fs, 'createWriteStream', createOutput);
  syncBuiltinESMExports();
  t.after(() => { replacement.mock.restore(); syncBuiltinESMExports(); });
}

function sourceObject(file: string, text: string) {
  const body = Buffer.from(text);
  return { file, body, bytes: body.length, md5: metadataMd5(body), sha256: sha256(body) };
}

async function* objectStream(objects = [sourceObject('1.json', 'new one'), sourceObject('2.json', 'new two'), sourceObject('3.json', 'new three')]) {
  yield* objects;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

const files = () => new Set(['1.json', '2.json', '3.json']);

test('restore inventory permits damaged and missing objects but retains key validation', async () => {
  const storage = new MemoryStorage({ '2.json': 'old two', '3.json': 'old three' });
  const restoreOptions = { allowMissing: true, allowInvalidMetadata: true };
  await assert.rejects(remoteInventory(storage, prefix, files()), /inventory is incomplete/);
  const partial = await remoteInventory(storage, prefix, files(), restoreOptions);
  assert.deepEqual([...partial.keys()], ['2.json', '3.json']);
  storage.values.set(prefix + '4.json', Buffer.from('unexpected'));
  await assert.rejects(remoteInventory(storage, prefix, files(), restoreOptions), /Unexpected remote metadata key/);
  storage.values.delete(prefix + '4.json');
  storage.listing = [{ key: prefix + '2.json', bytes: 7, md5: 'invalid' }];
  await assert.rejects(remoteInventory(storage, prefix, files(), { allowMissing: true }), /Unexpected remote metadata key or checksum/);
  assert.equal((await remoteInventory(storage, prefix, files(), restoreOptions)).get('2.json')?.md5, 'invalid');
  for (const listing of [
    [...storage.listing, ...storage.listing],
    [{ key: '111k/2.json', bytes: 0, md5: 'invalid' }],
    [{ key: prefix + '3.json', bytes: 0, md5: 'invalid' }, ...storage.listing],
  ]) {
    storage.listing = listing;
    await assert.rejects(remoteInventory(storage, prefix, files(), restoreOptions), /Unexpected remote metadata key/);
  }
});

test('remote inventory requires complete unique collection keys and valid checksums', async () => {
  const storage = new MemoryStorage();
  const valid = await remoteInventory(storage, prefix, files());
  assert.equal(valid.size, 3);
  assert.deepEqual(storage.listCalls, [{ prefix, range: undefined }]);
  const rows = [...valid.values()];
  for (const listing of [
    rows.slice(1),
    [...rows, rows[0]],
    [{ ...rows[0], key: '111k/1.json' }, ...rows.slice(1)],
    [{ ...rows[0], key: `${prefix}../1.json` }, ...rows.slice(1)],
    [{ ...rows[0], bytes: 0 }, ...rows.slice(1)],
    [{ ...rows[0], bytes: 128 * 1024 + 1 }, ...rows.slice(1)],
    [{ ...rows[0], md5: 'invalid' }, ...rows.slice(1)],
    [{ ...rows[0], md5: `${rows[0].md5}-2` }, ...rows.slice(1)],
  ]) {
    storage.listing = listing;
    await assert.rejects(remoteInventory(storage, prefix, files()), /incomplete|Unexpected remote/);
  }
});

test('metadata inventories isolate direct token files from nested deployment namespaces', async () => {
  const storage = new MemoryStorage();
  for (const deployment of ['1', 'next-collection', 'zz-later']) {
    storage.values.set(`${prefix}${deployment}/1.json`, Buffer.from('other deployment'));
    storage.values.set(`${prefix}${deployment}/2.json`, Buffer.from('different metadata'));
  }
  const inventory = await remoteInventory(storage, prefix, files());
  assert.deepEqual([...inventory.keys()], ['1.json', '2.json', '3.json']);
  assert.equal(inventory.get('1.json')?.md5, metadataMd5(Buffer.from('old one')));
  const child = await remoteInventory(storage, `${prefix}next-collection/`, new Set(['1.json', '2.json']));
  assert.equal(child.size, 2);
  assert.equal(child.get('1.json')?.md5, metadataMd5(Buffer.from('other deployment')));
  for (const invalid of ['invalid.json', '4.json', '../1.json', '_invalid/1.json']) {
    storage.values.set(prefix + invalid, Buffer.from('invalid direct entry'));
    await assert.rejects(remoteInventory(storage, prefix, files()), /Unexpected remote metadata key/);
    storage.values.delete(prefix + invalid);
  }
});

test('parallel root inventory ignores child namespaces inside and beyond direct-file ranges', async () => {
  const storage = new MemoryStorage({});
  const expected = new Set(Array.from({ length: 10_001 }, (_, index) => `${index + 1}.json`));
  for (const file of expected) storage.values.set(prefix + file, Buffer.from('x'));
  for (const namespace of ['1', '5000', 'next']) storage.values.set(`${prefix}${namespace}/1.json`, Buffer.from('other scope'));
  const inventory = await remoteInventory(storage, prefix, expected);
  assert.equal(inventory.size, expected.size);
  assert.deepEqual([...inventory.keys()].sort(), [...expected].sort());
});

test('S3 listing uses a delimiter to avoid enumerating child deployment objects', async () => {
  const requests: Record<string, unknown>[] = [];
  const row = { Key: `${prefix}1.json`, Size: 1, ETag: `"${metadataMd5(Buffer.from('x'))}"` };
  const pages = [
    { Contents: [], CommonPrefixes: [{ Prefix: `${prefix}0-test/` }], IsTruncated: true, NextContinuationToken: 'direct' },
    { Contents: [row], CommonPrefixes: [{ Prefix: `${prefix}test-2/` }], IsTruncated: false },
  ];
  const client = { send: async (command: { input: Record<string, unknown> }) => {
    requests.push(command.input);
    return pages.shift();
  }, destroy() {} } as unknown as S3Client;
  const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, client);
  assert.deepEqual((await collect(storage.list(prefix))).map(object => object.key), [`${prefix}1.json`]);
  assert.ok(requests.every(request => request.Delimiter === '/'));
  assert.equal(requests[1].ContinuationToken, 'direct');
  const invalidClient = { send: async () => ({ CommonPrefixes: [{ Prefix: `${prefix}../` }], IsTruncated: false }), destroy() {} } as unknown as S3Client;
  await assert.rejects(collect(new S3MetadataStorage(storage.destination, invalidClient).list(prefix)), /Invalid nested metadata namespace/);
});

test('parallel inventory ranges include every boundary once and retain an open final range', async () => {
  const storage = new MemoryStorage({});
  const expected = new Set(Array.from({ length: 20_001 }, (_, index) => `${index + 1}.json`));
  for (const file of expected) storage.values.set(prefix + file, Buffer.from('x'));
  const inventory = await remoteInventory(storage, prefix, expected);
  assert.equal(inventory.size, expected.size);
  assert.deepEqual([...inventory.keys()].sort(), [...expected].sort());
  const ordered = [...expected].sort().map(file => prefix + file);
  assert.deepEqual(storage.listCalls, [
    { prefix, range: { startAfter: undefined, endAt: ordered[9_999] } },
    { prefix, range: { startAfter: ordered[9_999], endAt: ordered[19_999] } },
    { prefix, range: { startAfter: ordered[19_999], endAt: ordered[20_000] } },
    { prefix, range: { startAfter: ordered[20_000] } },
  ]);
});

test('parallel inventory detects unexpected keys before, between and after expected ranges', async () => {
  const storage = new MemoryStorage({});
  const expected = new Set(Array.from({ length: 10_001 }, (_, index) => `${index + 1}.json`));
  for (const file of expected) storage.values.set(prefix + file, Buffer.from('x'));
  const ordered = [...expected].sort();
  const between = `${ordered[9_999]}.unexpected`;
  assert.ok(between > ordered[9_999] && between < ordered[10_000]);
  for (const file of ['.unexpected', between, 'zzzz.unexpected']) {
    storage.values.set(prefix + file, Buffer.from('x'));
    await assert.rejects(remoteInventory(storage, prefix, expected), /Unexpected remote metadata key/);
    storage.values.delete(prefix + file);
  }
  storage.values.delete(prefix + ordered[9_999]);
  await assert.rejects(remoteInventory(storage, prefix, expected), /inventory is incomplete/);
});

test('parallel inventory never runs more than sixteen list iterators at once', async () => {
  const storage = new MemoryStorage({});
  const expected = new Set(Array.from({ length: 160_001 }, (_, index) => `${index + 1}.json`));
  const keys = [...expected].sort().map(file => prefix + file);
  const md5 = metadataMd5(Buffer.from('x'));
  const firstWave = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  storage.list = async function* (selectedPrefix, range) {
    assert.equal(selectedPrefix, prefix);
    active++;
    maximum = Math.max(maximum, active);
    if (++calls === 16) firstWave.resolve();
    try {
      await release.promise;
      for (const key of keys) {
        if ((range?.startAfter === undefined || key > range.startAfter) &&
          (range?.endAt === undefined || key <= range.endAt)) yield { key, bytes: 1, md5 };
      }
    } finally { active--; }
  };
  const pending = remoteInventory(storage, prefix, expected);
  await firstWave.promise;
  assert.equal(active, 16);
  release.resolve();
  assert.equal((await pending).size, expected.size);
  assert.equal(calls, 18);
  assert.equal(maximum, 16);
  assert.equal(active, 0);
});

test('S3 ranged listing uses StartAfter once, continues pages, and includes the upper boundary', async () => {
  const requests: Record<string, unknown>[] = [];
  const row = (id: number) => ({ Key: prefix + `${id}.json`, Size: 1, ETag: `"${metadataMd5(Buffer.from('x'))}"` });
  const pages = [
    { Contents: [row(2), row(3)], IsTruncated: true, NextContinuationToken: 'page-two' },
    { Contents: [row(4), row(5)], IsTruncated: true, NextContinuationToken: 'unnecessary-page' },
  ];
  const client = { send: async (command: { input: Record<string, unknown> }) => {
    requests.push(command.input);
    assert.ok(pages.length, 'No request after the upper boundary');
    return pages.shift();
  }, destroy() {} } as unknown as S3Client;
  const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, client);
  const listed = await collect(storage.list(prefix, { startAfter: prefix + '1.json', endAt: prefix + '4.json' }));
  assert.deepEqual(listed.map(object => object.key), [prefix + '2.json', prefix + '3.json', prefix + '4.json']);
  assert.equal(requests[0].StartAfter, prefix + '1.json');
  assert.equal(requests[0].ContinuationToken, undefined);
  assert.equal(requests[1].StartAfter, undefined);
  assert.equal(requests[1].ContinuationToken, 'page-two');
});

test('S3 listing represents damaged objects while rejecting malformed sizes and ETags', async () => {
  const md5 = metadataMd5(Buffer.from('x'));
  const rows = [
    { Key: prefix + '1.json', Size: 0, ETag: `"${md5}"` },
    { Key: prefix + '2.json', Size: 128 * 1024 + 1, ETag: `"${md5}"` },
    { Key: prefix + '3.json', Size: 1, ETag: `"${md5}-2"` },
  ];
  let contents: unknown[] = rows;
  const client = { send: async () => ({ Contents: contents, IsTruncated: false }), destroy() {} } as unknown as S3Client;
  const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, client);
  assert.deepEqual(await collect(storage.list(prefix)), rows.map(row => ({ key: row.Key, bytes: row.Size, md5: row.ETag.slice(1, -1) })));
  for (const invalid of [
    ...[undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(Size => ({ ...rows[0], Size })),
    ...[undefined, md5, '""', `"${md5}`].map(ETag => ({ ...rows[0], ETag })),
  ]) {
    contents = [invalid];
    await assert.rejects(collect(storage.list(prefix)), /Invalid remote metadata object/);
  }
});

test('S3 ranged listing rejects foreign prefixes, lower-bound violations and unordered keys', async () => {
  const row = (key: string) => ({ Key: key, Size: 1, ETag: `"${metadataMd5(Buffer.from('x'))}"` });
  for (const contents of [
    [row('111k/2.json')],
    [row(prefix + '1.json')],
    [row(prefix + '3.json'), row(prefix + '2.json')],
    [row(prefix + '2.json'), row(prefix + '2.json')],
  ]) {
    const client = { send: async () => ({ Contents: contents, IsTruncated: false }), destroy() {} } as unknown as S3Client;
    const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, client);
    await assert.rejects(collect(storage.list(prefix, { startAfter: prefix + '1.json' })), /Invalid remote metadata key order/);
  }
  let called = false;
  const client = { send: async () => { called = true; }, destroy() {} } as unknown as S3Client;
  const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, client);
  for (const range of [{ startAfter: '111k/1.json' }, { endAt: '111k/1.json' }, { startAfter: prefix + '2.json', endAt: prefix + '1.json' }]) {
    await assert.rejects(collect(storage.list(prefix, range)), /Invalid R2 listing range/);
  }
  assert.equal(called, false);
});

test('S3 ranged listing stops above a missing boundary and rejects repeated continuation tokens', async () => {
  const row = (id: number) => ({ Key: prefix + `${id}.json`, Size: 1, ETag: `"${metadataMd5(Buffer.from('x'))}"` });
  const client = { send: async () => ({ Contents: [row(2), row(4)], IsTruncated: true, NextContinuationToken: 'next' }), destroy() {} } as unknown as S3Client;
  const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, client);
  assert.deepEqual((await collect(storage.list(prefix, { endAt: prefix + '3.json' }))).map(object => object.key), [prefix + '2.json']);
  const looping = { send: async () => ({ Contents: [], IsTruncated: true, NextContinuationToken: 'same' }), destroy() {} } as unknown as S3Client;
  const invalid = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, looping);
  await assert.rejects(collect(invalid.list(prefix, { startAfter: prefix + '1.json' })), /Invalid R2 listing continuation/);
});

test('selected inventory reads only requested token IDs without listing the collection', async () => {
  const storage = new MemoryStorage();
  storage.list = async function* () { throw new Error('A sample must not list the full collection'); };
  const inventory = await selectedInventory(storage, 'sepolia', new Set(['1', '3']), 2);
  assert.deepEqual(storage.reads.sort(), [prefix + '1.json', prefix + '3.json']);
  assert.deepEqual([...inventory.keys()].sort(), ['1.json', '3.json']);
  for (const [file, object] of inventory) {
    const body = storage.values.get(prefix + file)!;
    assert.deepEqual(object, { key: prefix + file, bytes: body.length, md5: metadataMd5(body) });
  }
  storage.values.set('111k/1.json', Buffer.from('mainnet original'));
  storage.reads.length = 0;
  const mainnet = await selectedInventory(storage, 'mainnet', new Set(['1']), 1);
  assert.deepEqual(storage.reads, ['111k/1.json']);
  assert.equal(mainnet.get('1.json')?.md5, metadataMd5(Buffer.from('mainnet original')));
});

test('selected inventory rejects invalid IDs before any remote access', async () => {
  const storage = new MemoryStorage();
  for (const selected of [new Set<string>(), new Set(['0']), new Set(['01']), new Set(['../1']), new Set(['117172']), new Set(['2005556'])]) {
    await assert.rejects(selectedInventory(storage, 'sepolia', selected, 2), /outside the collection/);
  }
  assert.equal(storage.reads.length, 0);
  assert.equal(storage.writes.length, 0);
});

test('selected inventory rejects empty and oversized remote bodies', async () => {
  const storage = new MemoryStorage();
  for (const body of [Buffer.alloc(0), Buffer.alloc(128 * 1024 + 1)]) {
    storage.values.set(prefix + '1.json', body);
    await assert.rejects(selectedInventory(storage, 'sepolia', new Set(['1']), 1), /Invalid remote metadata size/);
  }
  assert.equal(storage.writes.length, 0);
});

test('snapshots reuse only checksum-matching cached originals and preserve exact bytes', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const inventory = await remoteInventory(storage, prefix, files());
  const cacheRoot = join(directory, 'prior');
  await mkdir(join(cacheRoot, 'sepolia'), { recursive: true });
  await writeFile(join(cacheRoot, 'sepolia', '1.json'), 'old one');
  await writeFile(join(cacheRoot, 'sepolia', '2.json'), 'incorrect cached data');
  const snapshot = join(directory, 'snapshot');
  const manifest = await snapshotMetadata(storage, 'sepolia', snapshot, inventory, publicationManifestSha256, { priorCacheRoot: cacheRoot, concurrency: 2 });
  assert.equal(manifest.version, 2);
  assert.ok(manifest.version === 2 && manifest.publicationManifestSha256 === publicationManifestSha256);
  assert.deepEqual(storage.reads.sort(), [prefix + '2.json', prefix + '3.json']);
  const restored = await collect(snapshotObjects(snapshot, manifest, files()));
  assert.equal(restored.length, 3);
  for (const object of restored) assert.deepEqual(object.body, storage.values.get(prefix + object.file));
  storage.values.set(prefix + '1.json', Buffer.from('later publication'));
  const reused = await snapshotMetadata(storage, 'sepolia', snapshot, inventory, publicationManifestSha256);
  assert.deepEqual(reused, manifest);
  assert.equal(storage.reads.length, 2);
});

test('both network snapshots reuse a previous canonical dataset without remote reads', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const priorDirectory = join(directory, 'previous-dataset');
  await mkdir(priorDirectory);
  for (const [key, body] of [...storage.values]) {
    const file = key.slice(prefix.length);
    await writeFile(join(priorDirectory, file), body);
    storage.values.set('111k/' + file, body);
  }
  for (const network of ['sepolia', 'mainnet'] as const) {
    const selectedPrefix = network === 'sepolia' ? prefix : '111k/';
    const inventory = await remoteInventory(storage, selectedPrefix, files());
    const snapshotDirectory = join(directory, 'snapshots', network);
    const manifest = await snapshotMetadata(storage, network, snapshotDirectory, inventory, publicationManifestSha256, { priorCacheRoot: priorDirectory });
    for await (const object of snapshotObjects(snapshotDirectory, manifest, files())) {
      assert.deepEqual(object.body, storage.values.get(selectedPrefix + object.file));
    }
  }
  assert.equal(storage.reads.length, 0);
});

test('snapshot cache fallback verifies canonical checksums and skips oversized candidates before reading', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const priorDirectory = join(directory, 'previous-dataset');
  await mkdir(join(priorDirectory, 'sepolia'), { recursive: true });
  await writeFile(join(priorDirectory, '1.json'), 'bad one');
  await writeFile(join(priorDirectory, 'sepolia', '2.json'), 'bad two');
  await writeFile(join(priorDirectory, '2.json'), 'old two');
  await writeFile(join(priorDirectory, '3.json'), Buffer.alloc(128 * 1024 + 1));
  const inventory = await remoteInventory(storage, prefix, files());
  const snapshotDirectory = join(directory, 'snapshot');
  const manifest = await snapshotMetadata(storage, 'sepolia', snapshotDirectory, inventory, publicationManifestSha256, { priorCacheRoot: priorDirectory });
  assert.deepEqual(storage.reads.sort(), [prefix + '1.json', prefix + '3.json']);
  for await (const object of snapshotObjects(snapshotDirectory, manifest, files())) {
    assert.deepEqual(object.body, storage.values.get(prefix + object.file));
  }
});

test('snapshot creation stops when remote bytes change after inventory and leaves no complete backup', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const inventory = await remoteInventory(storage, prefix, files());
  storage.values.set(prefix + '1.json', Buffer.from('changed'));
  await assert.rejects(snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256, { concurrency: 1 }), /changed while taking snapshot/);
  await assert.rejects(readFile(join(directory, 'manifest.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'objects.jsonl.gz.partial')), { code: 'ENOENT' });
});

test('snapshot open errors reject after draining delayed reads', { timeout: 2000 }, async t => {
  const directory = await temporaryDirectory(t);
  await mkdir(join(directory, 'objects.jsonl.gz.partial'));
  const storage = new MemoryStorage();
  const inventory = await remoteInventory(storage, prefix, files());
  const outputFailed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const createOutput = fs.createWriteStream;
  mockSnapshotOutput(t, (...args) => {
    const output = createOutput(...args);
    output.once('error', () => outputFailed.resolve());
    return output;
  });
  let active = 0;
  storage.get = async function (key) {
    active++;
    await release.promise;
    active--;
    return MemoryStorage.prototype.get.call(this, key);
  };
  let settled = false;
  const pending = snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256, { concurrency: 2 });
  const outcome = pending.finally(() => { settled = true; });
  const rejected = assert.rejects(outcome, { code: 'EISDIR' });
  await outputFailed.promise;
  assert.equal(active, 2);
  assert.equal(settled, false);
  release.resolve();
  await rejected;
  assert.equal(active, 0);
  assert.equal(storage.reads.length, 2);
  await assert.rejects(readFile(join(directory, 'manifest.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'objects.jsonl.gz')), { code: 'ENOENT' });
});

test('snapshot write errors stop scheduling and drain outstanding reads', { timeout: 2000 }, async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage({ '1.json': randomBytes(32 * 1024).toString('base64'), '2.json': 'old two', '3.json': 'old three' });
  const inventory = await remoteInventory(storage, prefix, files());
  const diskError = Object.assign(new Error('snapshot disk full'), { code: 'ENOSPC' });
  const outputFailed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let chunks = 0;
  mockSnapshotOutput(t, () => new Writable({ write(_chunk, _encoding, callback) {
    if (++chunks === 1) callback();
    else { outputFailed.resolve(); callback(diskError); }
  } }) as fs.WriteStream);
  let active = 0;
  let started = 0;
  storage.get = async function (key) {
    active++;
    started++;
    if (key !== prefix + '1.json') await release.promise;
    active--;
    return MemoryStorage.prototype.get.call(this, key);
  };
  let settled = false;
  const pending = snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256, { concurrency: 2 });
  const outcome = pending.finally(() => { settled = true; });
  const rejected = assert.rejects(outcome, error => error === diskError);
  await outputFailed.promise;
  assert.equal(started, 2);
  assert.equal(active, 1);
  assert.equal(settled, false);
  release.resolve();
  await rejected;
  assert.equal(active, 0);
  assert.equal(started, 2);
  await assert.rejects(readFile(join(directory, 'manifest.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'objects.jsonl.gz.partial')), { code: 'ENOENT' });
});

test('snapshot reuse rejects another publication and preserves the original backup', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const inventory = await remoteInventory(storage, prefix, files());
  const manifest = await snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256);
  const manifestBefore = await readFile(join(directory, 'manifest.json'));
  const archiveBefore = await readFile(join(directory, manifest.archive));
  storage.values.set(prefix + '1.json', Buffer.from('next revision'));
  storage.reads.length = 0;
  const nextInventory = await remoteInventory(storage, prefix, files());
  await assert.rejects(snapshotMetadata(storage, 'sepolia', directory, nextInventory, sha256('another publication manifest')),
    /not bound to this publication/);
  assert.equal(storage.reads.length, 0);
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), manifestBefore);
  assert.deepEqual(await readFile(join(directory, manifest.archive)), archiveBefore);
});

test('unbound legacy snapshots cannot be reused by a publication', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const inventory = await remoteInventory(storage, prefix, files());
  const manifest = await snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256);
  assert.equal(manifest.version, 2);
  const { publicationManifestSha256: _, ...legacy } = manifest as Extract<typeof manifest, { version: 2 }>;
  const original = `${JSON.stringify({ ...legacy, version: 1 })}\n`;
  await writeFile(join(directory, 'manifest.json'), original);
  storage.reads.length = 0;
  await assert.rejects(snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256), /not bound to this publication/);
  assert.equal(storage.reads.length, 0);
  assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), original);
  const objects = await collect(snapshotObjects(directory, { ...legacy, version: 1 }, files()));
  assert.deepEqual(objects.map(object => object.body.toString()).sort(), ['old one', 'old three', 'old two']);
});

test('restoration repairs missing objects, damaged metadata and headers from both snapshot versions', { timeout: 90_000 }, async t => {
  const root = await temporaryDirectory(t);
  const directory = join(root, 'sepolia');
  await mkdir(directory);
  const body = Buffer.from('x');
  const digest = { bytes: body.length, md5: metadataMd5(body), sha256: sha256(body), body: body.toString('base64') };
  const allFiles = Array.from(metadataIdentities(), identity => identity.file);
  const archive = gzipSync(allFiles.map(file => `${JSON.stringify({ file, ...digest })}\n`).join(''));
  const keys = allFiles.map(file => prefix + file).sort();
  const indices = new Map(keys.map((key, index) => [key, index]));
  const damaged = new Map<string, RemoteObject | null>();
  const headerKey = keys[30_000];
  let headers = { contentType: 'application/octet-stream', cacheControl: 'public, max-age=31536000' };
  const writes = new Set<string>();
  const destination = { endpoint: `https://${sha256(root).slice(0, 32)}.r2.cloudflarestorage.com`, bucket: 'cdn-mons-shop' };
  const storage: MetadataStorage = {
    destination,
    async *list(selectedPrefix, range = {}) {
      assert.equal(selectedPrefix, prefix);
      const start = range.startAfter === undefined ? 0 : indices.get(range.startAfter)! + 1;
      const end = range.endAt === undefined ? keys.length : indices.get(range.endAt)! + 1;
      for (let index = start; index < end; index++) {
        const key = keys[index];
        if (damaged.get(key) !== null) yield damaged.get(key) ?? { key, bytes: digest.bytes, md5: digest.md5 };
      }
    },
    async get() { throw new Error('Restore must read its backup rather than download objects'); },
    async put(key, restoredBody) {
      assert.ok(indices.has(key));
      assert.equal(writes.has(key), false);
      assert.deepEqual(restoredBody, body);
      writes.add(key);
      damaged.delete(key);
      if (key === headerKey) headers = { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' };
    },
    close() {},
  };
  await writeFile(join(directory, 'objects.jsonl.gz'), archive);
  for (const version of [1, 2] as const) {
    damaged.set(keys[9999], null);
    for (const [index, bytes, md5] of [
      [0, 0, metadataMd5(Buffer.alloc(0))],
      [10_000, 128 * 1024 + 1, metadataMd5(Buffer.alloc(128 * 1024 + 1))],
      [20_000, 1, `${digest.md5}-2`],
    ] as const) {
      damaged.set(keys[index], { key: keys[index], bytes, md5 });
    }
    headers = { contentType: 'application/octet-stream', cacheControl: 'public, max-age=31536000' };
    writes.clear();
    const manifest = { version, network: 'sepolia', prefix, destination, objectCount: allFiles.length, totalBytes: allFiles.length,
      archive: 'objects.jsonl.gz', archiveSha256: sha256(archive), createdAt: new Date(0).toISOString(),
      ...(version === 2 ? { publicationManifestSha256 } : {}) };
    const manifestBody = `${JSON.stringify(manifest)}\n`;
    await writeFile(join(directory, 'manifest.json'), manifestBody);
    const [report] = await restoreMetadata(root, 'sepolia', { storage });
    assert.equal(report.complete, true);
    assert.equal(report.uploaded, allFiles.length);
    assert.equal(report.skipped, 0);
    assert.equal(damaged.size, 0);
    assert.equal(writes.size, allFiles.length);
    assert.deepEqual(headers, { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' });
    assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), manifestBody);
    assert.deepEqual(await readFile(join(directory, manifest.archive)), archive);
  }
});

test('only explicitly allowed restore files may be created outside the current inventory', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage({ '2.json': 'old two' });
  const inventory = await remoteInventory(storage, prefix, files(), { allowMissing: true });
  const args = { storage, network: 'sepolia' as const, inventory, sourceHash, concurrency: 1, total: 1 };
  await assert.rejects(publishObjects({ ...args, journal: join(directory, 'upload.jsonl'),
    objects: objectStream([sourceObject('1.json', 'restored one')]) }), /not in the verified destination inventory/);
  assert.equal(storage.writes.length, 0);
  const restoreFiles = new Set(['1.json']);
  const report = await publishObjects({ ...args, restoreFiles, journal: join(directory, 'restore.jsonl'),
    objects: objectStream([sourceObject('1.json', 'restored one')]) });
  assert.deepEqual(report, { uploaded: 1, skipped: 0 });
  assert.equal(storage.values.get(prefix + '1.json')?.toString(), 'restored one');
  await assert.rejects(publishObjects({ ...args, restoreFiles, journal: join(directory, 'invalid.jsonl'),
    objects: objectStream([sourceObject('2.json', 'outside snapshot')]) }), /Invalid local object/);
  assert.deepEqual(storage.writes, [prefix + '1.json']);
});

test('snapshot reuse rejects archive corruption and another destination', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const inventory = await remoteInventory(storage, prefix, files());
  await snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256);
  const originalEndpoint = storage.destination.endpoint;
  storage.destination.endpoint = `https://${'b'.repeat(32)}.r2.cloudflarestorage.com`;
  await assert.rejects(snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256), /does not match/);
  storage.destination.endpoint = originalEndpoint;
  await appendFile(join(directory, 'objects.jsonl.gz'), 'corruption');
  await assert.rejects(snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256), /archive checksum mismatch/);
});

test('an existing snapshot manifest with a missing archive never replaces the original backup', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const inventory = await remoteInventory(storage, prefix, files());
  await snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256);
  const manifestBefore = await readFile(join(directory, 'manifest.json'));
  await rm(join(directory, 'objects.jsonl.gz'));
  storage.reads.length = 0;
  storage.values.set(prefix + '1.json', Buffer.from('later publication'));
  await assert.rejects(snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256), { code: 'ENOENT' });
  assert.equal(storage.reads.length, 0);
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), manifestBefore);
  await assert.rejects(readFile(join(directory, 'objects.jsonl.gz')), { code: 'ENOENT' });
});

test('snapshot parsing rejects duplicate, missing, unsafe and corrupt object rows', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const inventory = await remoteInventory(storage, prefix, files());
  const manifest = await snapshotMetadata(storage, 'sepolia', directory, inventory, publicationManifestSha256);
  const rows = (await collect(snapshotObjects(directory, manifest, files()))).map(row => ({ ...row, body: row.body.toString('base64') }));
  for (const modified of [
    rows.slice(1),
    [rows[0], rows[0], rows[2]],
    [{ ...rows[0], file: '../1.json' }, ...rows.slice(1)],
    [{ ...rows[0], body: Buffer.from('wrong').toString('base64') }, ...rows.slice(1)],
  ]) {
    await writeFile(join(directory, manifest.archive), gzipSync(modified.map(row => JSON.stringify(row)).join('\n') + '\n'));
    await assert.rejects(collect(snapshotObjects(directory, manifest, files())), /incomplete|invalid or duplicate|checksum mismatch/);
  }
});

test('publication overwrites changed objects, skips matching bytes, and never touches another prefix', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage({ '1.json': 'new one', '2.json': 'old two', '3.json': 'old three' });
  storage.values.set('111k/1.json', Buffer.from('mainnet remains'));
  const report = await publishObjects({ storage, network: 'sepolia', objects: objectStream(),
    inventory: await remoteInventory(storage, prefix, files()), journal: join(directory, 'upload.jsonl'), sourceHash, concurrency: 2, total: 3 });
  assert.deepEqual(report, { uploaded: 2, skipped: 1 });
  assert.deepEqual(storage.writes.sort(), [prefix + '2.json', prefix + '3.json']);
  assert.equal(storage.values.get('111k/1.json')?.toString(), 'mainnet remains');
  assert.equal((await readFile(join(directory, 'upload.jsonl'), 'utf8')).trimEnd().split('\n').length, 4);
});

test('publication reads lazy bodies concurrently within the worker bound', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  async function* objects() {
    for await (const { body, ...digest } of objectStream()) {
      yield { ...digest, readBody: async () => {
        active++;
        maximum = Math.max(maximum, active);
        if (++calls === 2) started.resolve();
        await release.promise;
        active--;
        return body;
      } };
    }
  }
  const pending = publishObjects({ storage, network: 'sepolia', objects: objects(),
    inventory: await remoteInventory(storage, prefix, files()), journal: join(directory, 'upload.jsonl'),
    sourceHash, concurrency: 2, total: 3 });
  await started.promise;
  assert.equal(active, 2);
  assert.equal(calls, 2);
  assert.equal(storage.writes.length, 0);
  release.resolve();
  assert.deepEqual(await pending, { uploaded: 3, skipped: 0 });
  assert.equal(calls, 3);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
});

test('publication checks lazy body bytes before PUT and preserves read failures', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const { body: _, ...digest } = sourceObject('1.json', 'new one');
  const inventory = await remoteInventory(storage, prefix, files());
  for (const [index, readBody] of [
    async () => Buffer.from('bad one'),
    async () => { throw new Error('local file read failed'); },
  ].entries()) {
    async function* objects() { yield { ...digest, readBody }; }
    await assert.rejects(publishObjects({ storage, network: 'sepolia', objects: objects(), inventory,
      journal: join(directory, `${index}.jsonl`), sourceHash, concurrency: 1, total: 1 }),
    /Local object checksum mismatch|local file read failed/);
    assert.equal((await readFile(join(directory, `${index}.jsonl`), 'utf8')).trimEnd().split('\n').length, 1);
  }
  assert.equal(storage.writes.length, 0);
});

test('publication resumes interrupted uploads and repairs an incomplete journal tail', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const journal = join(directory, 'upload.jsonl');
  storage.failPut = async key => { if (key === prefix + '2.json') throw new Error('interrupted transport'); };
  const args = { storage, network: 'sepolia' as const, journal, sourceHash, concurrency: 1, total: 3 };
  await assert.rejects(publishObjects({ ...args, objects: objectStream(), inventory: await remoteInventory(storage, prefix, files()) }), /interrupted transport/);
  assert.deepEqual(storage.writes, [prefix + '1.json', prefix + '2.json']);
  await appendFile(journal, '{"file":"2.json"');
  storage.failPut = undefined;
  storage.writes.length = 0;
  const report = await publishObjects({ ...args, objects: objectStream(), inventory: await remoteInventory(storage, prefix, files()) });
  assert.deepEqual(report, { uploaded: 2, skipped: 1 });
  assert.deepEqual(storage.writes, [prefix + '2.json', prefix + '3.json']);
  const lines = (await readFile(journal, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(1).map(row => row.file), ['1.json', '2.json', '3.json']);
});

test('publication reconciles uncertain successful writes using fresh remote checksums', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage({ '1.json': 'old one' });
  const object = sourceObject('1.json', 'new one');
  storage.failPut = async key => { storage.values.set(key, object.body); throw new Error('lost response'); };
  const args = { storage, network: 'sepolia' as const, journal: join(directory, 'upload.jsonl'), sourceHash, concurrency: 1, total: 1 };
  const inventory = () => remoteInventory(storage, prefix, new Set(['1.json']));
  await assert.rejects(publishObjects({ ...args, objects: objectStream([object]), inventory: await inventory() }), /lost response/);
  storage.failPut = undefined;
  storage.writes.length = 0;
  assert.deepEqual(await publishObjects({ ...args, objects: objectStream([object]), inventory: await inventory() }), { uploaded: 0, skipped: 1 });
  assert.equal(storage.writes.length, 0);
});

test('publication rejects checksum failures and unsafe filenames before writing', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage();
  const inventory = await remoteInventory(storage, prefix, files());
  const valid = sourceObject('1.json', 'new one');
  for (const [index, object] of [
    { ...valid, body: Buffer.from('tampered') },
    { ...valid, md5: '0'.repeat(32) },
    { ...valid, sha256: '0'.repeat(64) },
    { ...valid, file: '../1.json' },
    sourceObject('1.json', 'x'.repeat(128 * 1024 + 1)),
  ].entries()) {
    await assert.rejects(publishObjects({ storage, network: 'sepolia', objects: objectStream([object]), inventory,
      journal: join(directory, `${index}.jsonl`), sourceHash, concurrency: 1, total: 1 }), /checksum mismatch|Invalid local object/);
  }
  assert.equal(storage.writes.length, 0);
});

test('publication rejects another source, destination or completion checksum in a journal', async t => {
  const directory = await temporaryDirectory(t);
  const storage = new MemoryStorage({ '1.json': 'new one' });
  const object = sourceObject('1.json', 'new one');
  const journal = join(directory, 'upload.jsonl');
  const args = { storage, network: 'sepolia' as const, journal, sourceHash, concurrency: 1, total: 1 };
  const inventory = await remoteInventory(storage, prefix, new Set(['1.json']));
  await publishObjects({ ...args, objects: objectStream([object]), inventory });
  await assert.rejects(publishObjects({ ...args, sourceHash: sha256('another source'), objects: objectStream([object]), inventory }), /different destination or manifest/);
  await assert.rejects(publishObjects({ ...args, network: 'mainnet', objects: objectStream([object]), inventory }), /different destination or manifest/);
  const lines = (await readFile(journal, 'utf8')).trimEnd().split('\n');
  lines[1] = JSON.stringify({ file: '1.json', sha256: sha256('wrong completion') });
  await writeFile(journal, lines.join('\n') + '\n');
  await assert.rejects(publishObjects({ ...args, objects: objectStream([object]), inventory }), /journal checksum mismatch/);
  assert.equal(storage.writes.length, 0);
});

test('bounded concurrent work stops scheduling after failure and drains started requests', async () => {
  const started = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  let finished = 0;
  let settled = false;
  const operation = uploadWithConcurrency(Array.from({ length: 10 }, (_, index) => index), 3, async index => {
    active++;
    maximum = Math.max(maximum, active);
    if (++calls === 3) started.resolve();
    if (index === 0) { await fail.promise; active--; throw new Error('terminal failure'); }
    await release.promise;
    active--;
    finished++;
  });
  const outcome = operation.then(() => { settled = true; }, error => { settled = true; throw error; });
  void outcome.catch(() => {});
  await started.promise;
  fail.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
  assert.equal(active, 2);
  assert.equal(settled, false);
  release.resolve();
  await assert.rejects(outcome, /terminal failure/);
  assert.equal(maximum, 3);
  assert.equal(finished, 2);
  assert.equal(active, 0);
});

test('S3 transport retries a transient PUT and preserves replacement metadata and checksums', async t => {
  const body = Buffer.from('{"name":"1"}\n');
  let requests = 0;
  const observed: Array<{ contentType: string | undefined; cacheControl: string | undefined; md5: string | string[] | undefined; conditional: string | undefined; body: Buffer }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observed.push({ contentType: request.headers['content-type'], cacheControl: request.headers['cache-control'],
      md5: request.headers['content-md5'], conditional: request.headers['if-none-match'], body: Buffer.concat(chunks) });
    if (++requests === 1) {
      response.writeHead(503, { 'Content-Type': 'application/xml' });
      response.end('<Error><Code>SlowDown</Code><Message>retry</Message></Error>');
    } else {
      response.writeHead(200, { ETag: `"${metadataMd5(body)}"` });
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = new S3Client({ endpoint, region: 'auto', forcePathStyle: true, maxAttempts: 5,
    credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const storage = new S3MetadataStorage({ endpoint, bucket: 'cdn-mons-shop' }, client);
  t.after(() => storage.close());
  await storage.put(prefix + '1.json', body);
  assert.equal(requests, 2);
  for (const request of observed) {
    assert.equal(request.contentType, 'application/json; charset=utf-8');
    assert.equal(request.cacheControl, 'no-store');
    assert.equal(request.md5, Buffer.from(metadataMd5(body), 'hex').toString('base64'));
    assert.equal(request.conditional, undefined);
    assert.deepEqual(request.body, body);
  }
});

test('S3 transport rejects a successful response with an incorrect checksum', async () => {
  const client = { send: async () => ({ ETag: `"${'0'.repeat(32)}"` }), destroy() {} } as unknown as S3Client;
  const storage = new S3MetadataStorage({ endpoint: 'https://example.invalid', bucket: 'cdn-mons-shop' }, client);
  await assert.rejects(storage.put(prefix + '1.json', Buffer.from('body')), /Uploaded object checksum mismatch/);
});
