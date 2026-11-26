import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { metadataMd5, type MetadataStorage } from '../scripts/ethereum-metadata/storage.ts';
import { runTarotOperations } from '../scripts/tarot/cli.ts';
import { buildDmxCollectionMetadata, buildDmxMetadata, DMX_METADATA_BASE_URI, dmxMetadataBody,
  dmxMetadataManifestSha256, dmxMetadataSha256, generateDmxMetadata, loadDmxMetadataBody,
  loadDmxMetadataManifest, validateDmxMetadataManifest, verifyDmxPublishedMetadata,
  type DmxMetadataManifest } from '../scripts/tarot/metadata.ts';
import { publishDmxMetadata, updateDmxMetadata, verifyDmxMetadata } from '../scripts/tarot/metadataPublication.ts';

let root: string;
let directory: string;
let manifest: DmxMetadataManifest;
const bodies = new Map<string, Buffer>();

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dmx-metadata-')));
  directory = join(root, '.cache/dmx-metadata/revision-1');
  manifest = await generateDmxMetadata(directory, { root });
  for (const object of manifest.objects) bodies.set(`dmx/${object.file}`, await readFile(join(directory, object.file)));
});

after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

class Storage implements MetadataStorage {
  destination = { endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, bucket: 'cdn-mons-shop' };
  objects = new Map<string, Buffer>();
  writes: string[] = [];
  conditions: Array<string | null> = [];
  failAt: number | null = null;
  loseResponse = false;
  beforePut?: (key: string) => void;
  beforeGet?: (key: string) => void;

  async *list(prefix: string) {
    assert.equal(prefix, 'dmx/');
    for (const [key, body] of [...this.objects.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (key.startsWith(prefix)) yield { key, bytes: body.length, md5: metadataMd5(body) };
    }
  }

  async get(key: string) {
    this.beforeGet?.(key);
    const body = this.objects.get(key);
    if (!body) throw Object.assign(new Error('Not found'), { name: 'NoSuchKey' });
    return Buffer.from(body);
  }

  async put(key: string, body: Buffer, expectedEtag?: string | null) {
    assert.notEqual(expectedEtag, undefined);
    assert.ok(bodies.has(key));
    if (this.failAt === this.writes.length) throw new Error('interrupted transport');
    this.beforePut?.(key);
    const existing = this.objects.get(key);
    if (expectedEtag === null ? existing !== undefined : !existing || expectedEtag !== `"${metadataMd5(existing)}"`) {
      throw Object.assign(new Error('Conditional write conflict'), { name: 'PreconditionFailed' });
    }
    this.objects.set(key, Buffer.from(body));
    this.writes.push(key);
    this.conditions.push(expectedEtag!);
    if (this.loseResponse) throw new Error('lost response');
  }

  close() {}
}

const headers = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', 'CF-Cache-Status': 'DYNAMIC',
};

function publicFetcher(storage: Storage, seen = new Set<string>()): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://cdn.mons.shop');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('origin'), 'https://mons.shop');
    seen.add(url.pathname.slice(1));
    const body = storage.objects.get(url.pathname.slice(1));
    return new Response(body ? new Uint8Array(body) : null, { status: body ? 200 : 404, headers });
  };
}

let revision = 1;
async function updatedRevision(files: string[]) {
  const target = join(root, `.cache/dmx-metadata/revision-${++revision}`);
  await mkdir(target, { recursive: true });
  const targetBodies = new Map(bodies);
  for (const file of files) {
    const metadata = JSON.parse(targetBodies.get(`dmx/${file}`)!.toString());
    metadata.description = `Updated revision ${revision}: ${file}`;
    targetBodies.set(`dmx/${file}`, dmxMetadataBody(metadata));
  }
  await Promise.all([...targetBodies].map(([key, body]) => writeFile(join(target, key.slice(4)), body)));
  const next = structuredClone(manifest);
  next.objects = manifest.objects.map(object => {
    const body = targetBodies.get(`dmx/${object.file}`)!;
    return { file: object.file, bytes: body.length, sha256: dmxMetadataSha256(body) };
  });
  next.totalBytes = next.objects.reduce((total, object) => total + object.bytes, 0);
  next.objectsSha256 = dmxMetadataSha256(dmxMetadataBody(next.objects));
  await writeFile(join(target, 'manifest.json'), dmxMetadataBody(next));
  const storage = new Storage();
  storage.objects = new Map(bodies);
  return { directory: target, manifest: next, bodies: targetBodies, storage };
}

test('initial DMX templates preserve renderer metadata and reject future or invalid identities', () => {
  for (const cardId of [1, 777]) {
    const card = buildDmxMetadata(cardId);
    const receipt = buildDmxMetadata(cardId + 999_999);
    assert.deepEqual(card, { name: `Tarot Card #${cardId}`, description: 'A mutating Tarot card. Initial base artwork.',
      image: `https://cdn.lil.org/nft/dmx/cards/${cardId}.png`, attributes: [
        { trait_type: 'Kind', value: 'Mutating Card' }, { trait_type: 'Card ID', value: cardId },
      ] });
    assert.deepEqual(receipt, { name: `Tarot Card Receipt #${cardId}`,
      description: 'Proves the authenticity of the physical Tarot card you scanned.',
      image: `https://cdn.lil.org/nft/dmx/receipts/${cardId}.png`, attributes: [
        { trait_type: 'Kind', value: 'NFC Card Receipt' }, { trait_type: 'Card ID', value: cardId },
      ] });
  }
  assert.deepEqual(buildDmxCollectionMetadata(), { name: 'divination machina x', symbol: 'DMX',
    description: '777 Tarot cards and their paired NFC receipts.', image: 'https://cdn.lil.org/nft/dmx/cards/1.png',
    external_link: 'https://mons.shop' });
  for (const tokenId of [0, -1, 1.5, NaN, 778, 999_999, 1_000_777, 2_000_775]) {
    assert.throws(() => buildDmxMetadata(tokenId), /initial card or NFC receipt/);
  }
});

test('generation is deterministic, complete, resumable and pinned to safe decimal filenames', async () => {
  assert.equal(manifest.objectCount, 1555);
  assert.equal(manifest.tokenCount, 1554);
  assert.deepEqual(manifest.objects.filter(object => ['1.json', '777.json', '1000000.json', '1000776.json', 'collection.json'].includes(object.file))
    .map(object => object.file), ['1.json', '777.json', '1000000.json', '1000776.json', 'collection.json']);
  assert.deepEqual(await generateDmxMetadata(directory, { root }), manifest);
  assert.deepEqual(await loadDmxMetadataManifest(directory), manifest);
  assert.equal(dmxMetadataManifestSha256(manifest), dmxMetadataSha256(await readFile(join(directory, 'manifest.json'))));
  await assert.rejects(loadDmxMetadataBody(directory, '../collection.json'), /outside/);
  for (const mutate of [
    (value: DmxMetadataManifest) => { value.baseURI = 'https://example.com/' as typeof DMX_METADATA_BASE_URI; },
    (value: DmxMetadataManifest) => { value.objects[0].file = '../1.json'; },
    (value: DmxMetadataManifest) => { value.objects[1] = value.objects[0]; },
    (value: DmxMetadataManifest) => { value.objects[0].bytes++; },
    (value: DmxMetadataManifest) => { value.objects.pop(); },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.throws(() => validateDmxMetadataManifest(changed), /DMX metadata/);
  }
});

test('generation rejects conflicting local files and paths outside the scratch namespace', async () => {
  const conflicting = join(root, '.cache/dmx-metadata/conflicting');
  await mkdir(conflicting, { recursive: true });
  await writeFile(join(conflicting, '1.json'), '{}');
  await assert.rejects(generateDmxMetadata(conflicting, { root }), /different metadata/);
  await assert.rejects(generateDmxMetadata(join(root, 'public'), { root }), /beneath/);
  const linked = join(root, '.cache/dmx-metadata/linked');
  await symlink(directory, linked);
  await assert.rejects(generateDmxMetadata(linked, { root }), /symbolic links/);
});

test('publisher resumes interrupted writes and journals, skips exact bytes, and never rewrites existing JSON', async () => {
  const storage = new Storage();
  storage.failAt = 4;
  await assert.rejects(publishDmxMetadata(directory, { root, storage, concurrency: 1 }), /interrupted transport/);
  assert.equal(storage.writes.length, 4);
  const journal = join(root, '.operations/dmx-metadata', dmxMetadataManifestSha256(manifest), 'publication.jsonl');
  await appendFile(journal, '{"file":');
  storage.failAt = null;
  const result = await publishDmxMetadata(directory, { root, storage, concurrency: 8 });
  assert.equal(result.uploaded, 1551);
  assert.equal(result.skipped, 4);
  assert.equal(storage.objects.size, 1555);
  assert.equal(storage.writes.length, 1555);
  assert.deepEqual([...storage.objects.keys()].sort(), [...bodies.keys()].sort());
  const repeat = await publishDmxMetadata(directory, { root, storage });
  assert.equal(repeat.uploaded, 0);
  assert.equal(repeat.skipped, 1555);
  const completed = (await readFile(journal, 'utf8')).trim().split('\n');
  assert.equal(completed.length, 1556);
});

test('publisher reconciles exact bytes after a lost write response', async () => {
  const storage = new Storage();
  storage.objects = new Map(bodies);
  storage.objects.delete('dmx/777.json');
  storage.loseResponse = true;
  const result = await publishDmxMetadata(directory, { root, storage });
  assert.equal(result.skipped, 1555);
  assert.equal(storage.writes.length, 1);
});

test('publication conflicts, unexpected objects and bucket changes fail before writing', async () => {
  const conflict = new Storage();
  conflict.objects.set('dmx/777.json', Buffer.from('{}'));
  await assert.rejects(publishDmxMetadata(directory, { root, storage: conflict }), /differs/);
  assert.equal(conflict.writes.length, 0);
  const unexpected = new Storage();
  unexpected.objects.set('dmx/778.json', Buffer.from('{}'));
  await assert.rejects(publishDmxMetadata(directory, { root, storage: unexpected }), /Unexpected/);
  assert.equal(unexpected.writes.length, 0);
  const bucket = new Storage();
  bucket.destination.bucket = 'other-bucket';
  await assert.rejects(publishDmxMetadata(directory, { root, storage: bucket }), /cdn-mons-shop/);
  assert.equal(bucket.writes.length, 0);
});

test('full verification reads all storage and CDN bytes and saves manifest-bound evidence', async () => {
  const storage = new Storage();
  storage.objects = new Map(bodies);
  const seen = new Set<string>();
  const result = await verifyDmxMetadata(directory, { root, storage, fetcher: publicFetcher(storage, seen) });
  assert.equal(result.complete, true);
  assert.equal(result.objectCount, 1555);
  assert.equal(result.storageVerified, true);
  assert.equal(result.publicVerified, true);
  assert.equal(result.manifestSha256, dmxMetadataManifestSha256(manifest));
  assert.equal(seen.size, 1555);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'verification.json'), 'utf8')), result);
  storage.objects.delete('dmx/1000776.json');
  await assert.rejects(verifyDmxMetadata(directory, { root, storage, fetcher: publicFetcher(storage) }), /incomplete/);
});

test('concurrent verifications atomically save valid evidence without sharing temporary files', async () => {
  const storage = new Storage();
  storage.objects = new Map(bodies);
  const fetchPublic = publicFetcher(storage);
  let waiting = 0;
  let release!: () => void;
  const bothReady = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === '/dmx/collection.json') {
      if (++waiting === 2) release();
      await bothReady;
    }
    return fetchPublic(input, init);
  };
  const results = await Promise.all([
    verifyDmxMetadata(directory, { root, storage, fetcher }),
    verifyDmxMetadata(directory, { root, storage, fetcher }),
  ]);
  for (const result of results) {
    assert.equal(result.complete, true);
    assert.equal(result.storageVerified, true);
    assert.equal(result.publicVerified, true);
    assert.equal(result.manifestSha256, dmxMetadataManifestSha256(manifest));
  }
  const saved = await readFile(join(directory, 'verification.json'));
  assert.ok(results.some(result => saved.equals(dmxMetadataBody(result))));
  assert.deepEqual((await readdir(directory)).filter(file => file.endsWith('.tmp')), []);
});

test('updates replace only changed cards, receipts and collection JSON with matching ETags', async () => {
  const files = ['1.json', '1000000.json', 'collection.json'];
  const f = await updatedRevision(files);
  const seen = new Set<string>();
  const options = { root, storage: f.storage, fetcher: publicFetcher(f.storage, seen), concurrency: 1 };
  const result = await updateDmxMetadata(f.directory, manifest, options);
  assert.equal(result.complete, true);
  assert.equal(result.storageVerified, true);
  assert.equal(result.publicVerified, true);
  assert.equal(result.manifestSha256, dmxMetadataManifestSha256(f.manifest));
  assert.equal(result.previousManifestSha256, dmxMetadataManifestSha256(manifest));
  assert.equal(result.updated, files.length);
  assert.equal(result.skipped, 1555 - files.length);
  assert.deepEqual(f.storage.writes, files.map(file => `dmx/${file}`));
  assert.deepEqual(f.storage.conditions, f.storage.writes.map(key => `"${metadataMd5(bodies.get(key)!)}"`));
  assert.equal(seen.size, 1555);
  for (const [key, body] of f.bodies) assert.ok(f.storage.objects.get(key)!.equals(body));
  const proof = JSON.parse(await readFile(join(f.directory, 'verification.json'), 'utf8'));
  assert.equal(proof.manifestSha256, dmxMetadataManifestSha256(f.manifest));
  assert.equal(proof.publicVerified, true);
  const repeated = await updateDmxMetadata(f.directory, manifest, options);
  assert.equal(repeated.updated, 0);
  assert.equal(repeated.skipped, 1555);
  assert.equal(f.storage.writes.length, files.length);
});

test('an unchanged update verifies existing metadata without writing objects', async () => {
  const storage = new Storage();
  storage.objects = new Map(bodies);
  const result = await updateDmxMetadata(directory, manifest, { root, storage, fetcher: publicFetcher(storage) });
  assert.equal(result.complete, true);
  assert.equal(result.publicVerified, true);
  assert.equal(result.updated, 0);
  assert.equal(storage.writes.length, 0);
});

test('updates reject stale, missing and unexpected remote objects before any replacement', async () => {
  const f = await updatedRevision(['1.json']);
  const cases = [
    (storage: Storage) => storage.objects.set('dmx/777.json', Buffer.from('{}')),
    (storage: Storage) => storage.objects.delete('dmx/1000776.json'),
    (storage: Storage) => storage.objects.set('dmx/778.json', Buffer.from('{}')),
    (storage: Storage) => { storage.destination.bucket = 'other-bucket'; },
  ];
  for (const change of cases) {
    const storage = new Storage();
    storage.objects = new Map(bodies);
    change(storage);
    await assert.rejects(updateDmxMetadata(f.directory, manifest, { root, storage, fetcher: publicFetcher(storage) }));
    assert.equal(storage.writes.length, 0);
  }
});

test('conditional updates preserve concurrent changes after preflight', async () => {
  const f = await updatedRevision(['1.json']);
  const concurrent = dmxMetadataBody({ name: 'Someone else changed this token' });
  f.storage.beforePut = key => { f.storage.objects.set(key, concurrent); };
  await assert.rejects(updateDmxMetadata(f.directory, manifest,
    { root, storage: f.storage, fetcher: publicFetcher(f.storage), concurrency: 1 }));
  assert.equal(f.storage.writes.length, 0);
  assert.ok(f.storage.objects.get('dmx/1.json')!.equals(concurrent));
});

test('updates reject a listing ETag that does not match the checked baseline body', async () => {
  const f = await updatedRevision(['1.json']);
  f.storage.objects.set('dmx/1.json', Buffer.from('{}'));
  f.storage.beforeGet = key => {
    if (key === 'dmx/1.json') f.storage.objects.set(key, bodies.get(key)!);
  };
  await assert.rejects(updateDmxMetadata(f.directory, manifest,
    { root, storage: f.storage, fetcher: publicFetcher(f.storage) }));
  assert.equal(f.storage.writes.length, 0);
});

test('updates resume a partial replacement and reconcile lost write responses', async () => {
  const f = await updatedRevision(['1.json', '2.json', '1000000.json']);
  const options = { root, storage: f.storage, fetcher: publicFetcher(f.storage), concurrency: 1 };
  f.storage.failAt = 1;
  await assert.rejects(updateDmxMetadata(f.directory, manifest, options), /interrupted transport/);
  assert.deepEqual(f.storage.writes, ['dmx/1.json']);
  f.storage.failAt = null;
  f.storage.loseResponse = true;
  const resumed = await updateDmxMetadata(f.directory, manifest, options);
  assert.equal(resumed.complete, true);
  assert.deepEqual(f.storage.writes, ['dmx/1.json', 'dmx/2.json', 'dmx/1000000.json']);
  assert.equal(f.storage.conditions.every(value => typeof value === 'string'), true);
  await updateDmxMetadata(f.directory, manifest, options);
  assert.equal(f.storage.writes.length, 3);
});

test('update recovery rejects a journal whose expected baseline changed', async () => {
  const f = await updatedRevision(['1.json', '2.json']);
  const options = { root, storage: f.storage, fetcher: publicFetcher(f.storage), concurrency: 1 };
  f.storage.failAt = 1;
  await assert.rejects(updateDmxMetadata(f.directory, manifest, options), /interrupted transport/);
  const journal = join(root, '.operations/dmx-metadata', dmxMetadataManifestSha256(f.manifest),
    `update-${dmxMetadataManifestSha256(manifest)}.jsonl`);
  const lines = (await readFile(journal, 'utf8')).trimEnd().split('\n');
  const header = JSON.parse(lines[0]);
  assert.equal(header.mode, 'update');
  assert.equal(header.previousManifestSha256, dmxMetadataManifestSha256(manifest));
  lines[0] = JSON.stringify({ ...header, previousManifestSha256: 'f'.repeat(64) });
  await writeFile(journal, `${lines.join('\n')}\n`);
  f.storage.failAt = null;
  await assert.rejects(updateDmxMetadata(f.directory, manifest, options), /journal/i);
  assert.equal(f.storage.writes.length, 1);
});

test('updates are not complete until the CDN serves the replacement bytes', async () => {
  const f = await updatedRevision(['1.json']);
  await assert.rejects(updateDmxMetadata(f.directory, manifest,
    { root, storage: f.storage, fetcher: async () => new Response('missing', { status: 404 }) }));
  assert.equal(f.storage.writes.length, 1);
  await assert.rejects(readFile(join(f.directory, 'verification.json')), { code: 'ENOENT' });
  const resumed = await updateDmxMetadata(f.directory, manifest,
    { root, storage: f.storage, fetcher: publicFetcher(f.storage) });
  assert.equal(resumed.publicVerified, true);
  assert.equal(f.storage.writes.length, 1);
});

test('CDN verification rejects stale, redirected, malformed and wrong-byte responses', async () => {
  const valid = bodies.get('dmx/1.json')!;
  const cases: Array<ResponseInit & { body?: Buffer; redirected?: boolean }> = [
    { status: 404 }, { status: 302 }, { headers: { ...headers, 'Content-Type': 'text/html' } },
    { headers: { ...headers, 'Cache-Control': 'public, max-age=3600' } },
    { headers: { ...headers, 'Access-Control-Allow-Origin': 'https://mons.shop' } },
    { headers: { ...headers, 'CF-Cache-Status': 'HIT' } },
    { body: Buffer.from('x'.repeat(valid.length)) }, { body: Buffer.from('{}') },
    { body: Buffer.concat([valid, Buffer.from(' ')]) }, { redirected: true },
  ];
  for (const value of cases) {
    await assert.rejects(verifyDmxPublishedMetadata(manifest, { concurrency: 1, fetcher: async () => {
      const response = new Response(new Uint8Array(value.body ?? valid), { status: value.status ?? 200, headers: value.headers ?? headers });
      if (value.redirected) Object.defineProperty(response, 'redirected', { value: true });
      return response;
    } }), /DMX public metadata/);
  }
});

test('metadata CLI accepts only explicit revision directory and rejects credential options', async () => {
  for (const concurrency of [0, 33, 1.5, NaN]) {
    await assert.rejects(publishDmxMetadata('missing', { concurrency }), /Invalid DMX metadata concurrency/);
    await assert.rejects(verifyDmxMetadata('missing', { concurrency }), /Invalid DMX metadata concurrency/);
    await assert.rejects(updateDmxMetadata('missing', manifest, { concurrency }), /Invalid DMX metadata concurrency/);
    await assert.rejects(verifyDmxPublishedMetadata(manifest, { concurrency }), /Invalid DMX metadata concurrency/);
  }
  for (const command of ['metadata-generate', 'metadata-publish', 'metadata-verify']) {
    await assert.rejects(runTarotOperations([command]), /require only --directory/);
    await assert.rejects(runTarotOperations([command, '--directory', directory, '--contract', '0x1234']), /require only --directory/);
    await assert.rejects(runTarotOperations([command, '--directory', directory, '--previous-manifest', 'baseline.json']));
  }
  for (const args of [[], ['--directory', directory], ['--previous-manifest', 'baseline.json'],
    ['--directory', directory, '--previous-manifest', 'baseline.json', '--contract', '0x1234']]) {
    await assert.rejects(runTarotOperations(['metadata-update', ...args]), /previous-manifest|require/i);
  }
  await assert.rejects(runTarotOperations(['metadata-generate', '--directory', directory]), /beneath/);
  assert.ok(dmxMetadataBody(buildDmxMetadata(1)).equals(bodies.get('dmx/1.json')!));
});
