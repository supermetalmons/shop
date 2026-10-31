import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs, { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  fileSha256, inBatches, loadMetadataTemplates, md5, metadataBody, metadataCounts, metadataIdentities,
  metadataObjects, readMetadataManifest, renderMetadata, sha256, type MetadataManifest, type MetadataObject,
} from '../scripts/ethereum-metadata/catalog.ts';
import { ETHEREUM_ITEM_KINDS, type EthereumItemKind } from '../shared/ethereum/protocol.ts';
import { validateMetadata } from '../scripts/ethereum-metadata/validate.ts';
import { generateMetadata } from '../scripts/ethereum-metadata/generate.ts';
import { withMetadataLock } from '../scripts/ethereum-metadata/lock.ts';

const examples: Array<{ kind: EthereumItemKind; name: string; image: string; type: string }> = [
  { kind: 'artwork', name: '1', image: 'artwork_placeholder.png', type: 'painting' },
  { kind: 'warehouse', name: 'Warehouse #1', image: 'warehouse.webp', type: 'warehouse' },
  { kind: 'monument', name: 'Monument #1', image: 'monuments/1.webp', type: 'monument' },
  { kind: 'crate', name: 'Crate #1', image: 'crate.jpg', type: 'crate' },
  { kind: 'crate_receipt', name: 'Crate Receipt #1', image: 'crate_receipt.webp', type: 'crate receipt' },
  { kind: 'artwork_receipt', name: 'Receipt #1', image: 'artwork_placeholder_receipt.webp', type: 'receipt' },
  { kind: 'monument_receipt', name: 'Monument Receipt #1', image: 'receipt_background.webp', type: 'monument receipt' },
];

test('the editable templates produce the approved metadata format', async () => {
  const { templates } = await loadMetadataTemplates();
  for (const example of examples) {
    assert.deepEqual(renderMetadata(example.kind, 1, templates), {
      name: example.name, description: '', image: `https://wip.lil.org/111k/${example.image}`,
      attributes: [{ trait_type: 'type', value: example.type }],
    });
  }
  assert.equal(renderMetadata('artwork', 111111, templates).name, '111111');
  assert.equal(renderMetadata('artwork_receipt', 111112, templates).name, 'Receipt #111112');
  assert.equal(renderMetadata('artwork_receipt', 222222, templates).name, 'Receipt #222222');
  assert.equal(renderMetadata('crate_receipt', 5555, templates).name, 'Crate Receipt #5555');
  assert.equal(renderMetadata('warehouse', 505, templates).name, 'Warehouse #505');
  const first = metadataIdentities().next().value!;
  assert.equal(metadataBody(first, templates), `${JSON.stringify(renderMetadata('artwork', 1, templates), null, 2)}\n`);
});

test('all eighteen monuments use their individual images and reject numbers outside their supply', async () => {
  const { templates } = await loadMetadataTemplates();
  for (let displayId = 1; displayId <= 18; displayId++) {
    assert.deepEqual(renderMetadata('monument', displayId, templates), {
      name: `Monument #${displayId}`, description: '', image: `https://wip.lil.org/111k/monuments/${displayId}.webp`,
      attributes: [{ trait_type: 'type', value: 'monument' }],
    });
  }
  for (const displayId of [0, 19]) assert.throws(() => renderMetadata('monument', displayId, templates), /Invalid item number/);
});

test('all eighteen monument receipts use the shared receipt background and matching display numbers', async () => {
  const { templates } = await loadMetadataTemplates();
  for (let displayId = 1; displayId <= 18; displayId++) {
    assert.deepEqual(renderMetadata('monument_receipt', displayId, templates), {
      name: `Monument Receipt #${displayId}`, description: '', image: 'https://wip.lil.org/111k/receipt_background.webp',
      attributes: [{ trait_type: 'type', value: 'monument receipt' }],
    });
  }
  for (const displayId of [0, 19]) assert.throws(() => renderMetadata('monument_receipt', displayId, templates), /Invalid item number/);
});

test('collection coverage preserves every token filename and both artwork receipt ranges', () => {
  const counts = Object.fromEntries(ETHEREUM_ITEM_KINDS.map(kind => [kind, 0]));
  const seen = new Set<string>();
  const boundaries: Record<string, [string, string]> = {};
  for (const identity of metadataIdentities()) {
    assert.equal(identity.file, `${identity.tokenId}.json`);
    assert.equal(seen.has(identity.tokenId), false);
    seen.add(identity.tokenId);
    counts[identity.kind]++;
    boundaries[identity.kind] ??= [identity.tokenId, identity.tokenId];
    boundaries[identity.kind][1] = identity.tokenId;
  }
  assert.equal(seen.size, 344984);
  assert.deepEqual(counts, { artwork: 111111, crate: 5555, warehouse: 505, artwork_receipt: 222222, crate_receipt: 5555, monument: 18, monument_receipt: 18 });
  assert.deepEqual(metadataCounts(), counts);
  assert.deepEqual(boundaries, {
    artwork: ['1', '111111'], crate: ['111112', '116666'], warehouse: ['116667', '117171'],
    artwork_receipt: ['1000001', '1222222'], crate_receipt: ['2000001', '2005555'],
    monument: ['117172', '117189'], monument_receipt: ['3000001', '3000018'],
  });
  for (const id of ['0', '117190', '1000000', '1222223', '2000000', '2005556', '3000000', '3000019']) assert.equal(seen.has(id), false);
});

test('templates can evolve without embedding descriptions, images, or attributes in generator code', async () => {
  const { templates } = await loadMetadataTemplates();
  templates.artwork.description = 'Painting {{displayId}}, token {{tokenId}}.';
  templates.artwork.image = 'https://example.com/paintings/{{tokenId}}.png';
  templates.artwork.attributes.push({ trait_type: 'edition', value: 3 });
  assert.deepEqual(renderMetadata('artwork', 42, templates), {
    name: '42', description: 'Painting 42, token 42.', image: 'https://example.com/paintings/42.png',
    attributes: [{ trait_type: 'type', value: 'painting' }, { trait_type: 'edition', value: 3 }],
  });
  templates.artwork.name = '{{unknown}}';
  assert.throws(() => renderMetadata('artwork', 42, templates), /Unresolved/);
  templates.artwork.name = '{{tokenId}}';
  for (const image of ['http://example.com/image.png', 'https://example.com/a b.png', 'https://example.com\\image.png',
    'https://example.com/a\nb.png', 'https://user:password@example.com/image.png', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    templates.artwork.image = image;
    assert.throws(() => renderMetadata('artwork', 42, templates), /HTTPS/);
  }
  assert.throws(() => renderMetadata('artwork', 111112, templates), /Invalid item number/);
});

test('generated metadata respects the runtime 128 KiB response limit', async () => {
  const { templates } = await loadMetadataTemplates();
  const first = metadataIdentities().next().value!;
  const baseBytes = Buffer.byteLength(metadataBody(first, templates));
  templates.artwork.description = 'x'.repeat(128 * 1024 - baseBytes);
  assert.equal(Buffer.byteLength(metadataBody(first, templates)), 128 * 1024);
  templates.artwork.description += 'x';
  assert.throws(() => metadataBody(first, templates), /exceeds 128 KiB/);
});

test('rendered image URLs remain valid after token and display ID substitutions', async () => {
  const { templates } = await loadMetadataTemplates();
  templates.crate.image = 'https://images.example:{{tokenId}}/image.png';
  assert.throws(() => renderMetadata('crate', 1, templates), /HTTPS/);
  templates.artwork.image = 'https://images.example:{{displayId}}/image.png';
  assert.equal(renderMetadata('artwork', 65535, templates).image, 'https://images.example:65535/image.png');
  assert.throws(() => renderMetadata('artwork', 65536, templates), /HTTPS/);
  templates.artwork_receipt.image = 'https://images.example/{{tokenId}}.png?display={{displayId}}';
  assert.equal(renderMetadata('artwork_receipt', 222222, templates).image,
    'https://images.example/1222222.png?display=222222');
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), '111k-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { templates, sources, hashes } = await loadMetadataTemplates();
  await mkdir(join(directory, 'templates'));
  await Promise.all(Object.entries(sources).map(([kind, source]) => writeFile(join(directory, 'templates', `${kind}.json`), source)));
  const identity = metadataIdentities().next().value!;
  const body = metadataBody(identity, templates);
  const object: MetadataObject = { ...identity, bytes: Buffer.byteLength(body), sha256: sha256(body), md5: md5(body) };
  await writeFile(join(directory, 'objects.jsonl'), `${JSON.stringify(object)}\n`);
  const manifest: MetadataManifest = {
    version: 1, objectCount: 344984, totalBytes: object.bytes, counts: metadataCounts(),
    objectsFile: 'objects.jsonl', objectsSha256: await fileSha256(join(directory, 'objects.jsonl')),
    templateSha256: hashes, sourceSha256: { fixture: sha256('fixture') },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, object, manifest };
}

test('artifact manifests bind the stored template snapshot and object ledger', async t => {
  const { directory, manifest } = await fixture(t);
  assert.deepEqual(await readMetadataManifest(directory), manifest);
  const snapshot = join(directory, 'templates', 'artwork.json');
  const template = await readFile(snapshot, 'utf8');
  await writeFile(snapshot, template.replace('artwork_placeholder.png', 'replacement.png'));
  await assert.rejects(readMetadataManifest(directory), /template checksum mismatch/);
  await writeFile(snapshot, template);
  await writeFile(join(directory, 'objects.jsonl'), '{}\n');
  await assert.rejects(readMetadataManifest(directory), /object manifest checksum mismatch/);
});

test('six-kind metadata publications cannot qualify as the monument receipt collection', async t => {
  const { directory, manifest } = await fixture(t);
  const { monument_receipt: _count, ...counts } = manifest.counts;
  const { monument_receipt: _hash, ...templateSha256 } = manifest.templateSha256;
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    ...manifest, counts, templateSha256, objectCount: 344966,
  }));
  await assert.rejects(readMetadataManifest(directory), /complete collection/);
});

test('generation preserves completed revision artifacts and their validation evidence', async t => {
  const { directory } = await fixture(t);
  const original = await readFile(join(directory, 'manifest.json'), 'utf8');
  const evidence = '{"previousSuccess":true}\n';
  await writeFile(join(directory, 'validation.json'), evidence);
  await assert.rejects(generateMetadata(directory), /already contains a completed metadata manifest/);
  assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), original);
  assert.equal(await readFile(join(directory, 'validation.json'), 'utf8'), evidence);
  await assert.rejects(readFile(join(directory, '.generate.lock')), { code: 'ENOENT' });
});

test('generation recovers an interrupted owner while preserving completed revisions', async t => {
  const { directory } = await fixture(t);
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  const lock = join(directory, '.generate.lock');
  const id = randomUUID();
  await mkdir(lock);
  await writeFile(join(lock, `${id}.json`), JSON.stringify({ id, pid: child.pid, host: hostname() }));
  const original = await readFile(join(directory, 'manifest.json'), 'utf8');
  await assert.rejects(generateMetadata(directory), /already contains a completed metadata manifest/);
  assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), original);
  await assert.rejects(readFile(lock), { code: 'ENOENT' });
});

test('generation writes complete ledger batches when filesystem writes are short', async t => {
  const directory = await mkdtemp(join(tmpdir(), '111k-short-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binding = (process as unknown as {
    binding(name: string): Record<string, (...args: any[]) => unknown>;
  }).binding('fs');
  const originalOpen = fs.open;
  const originalWrite = fs.writeFile;
  const writeBuffer = binding.writeBuffer.bind(binding);
  const writeString = binding.writeString.bind(binding);
  const failure = new Error('Stop after the first ledger batch');
  let ledgerFd = -1;
  let shortWrites = 0;
  t.mock.method(fs, 'open', async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    if (path === join(directory, 'objects.jsonl.tmp')) ledgerFd = handle.fd;
    return handle;
  });
  t.mock.method(fs, 'writeFile', (path, data, options) => path === join(directory, '65.json')
    ? Promise.reject(failure) : originalWrite(path, data, options));
  t.mock.method(binding, 'writeBuffer', (...args) => {
    if (args[0] === ledgerFd && args[3] > 97) { args[3] = 97; shortWrites++; }
    return writeBuffer(...args);
  });
  t.mock.method(binding, 'writeString', (...args) => {
    if (args[0] === ledgerFd && args[1].length > 97) { args[1] = args[1].slice(0, 97); shortWrites++; }
    return writeString(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(generateMetadata(directory), error => error === failure);
    assert.ok(shortWrites > 0);
    const ledger = await readFile(join(directory, 'objects.jsonl.tmp'), 'utf8');
    assert.equal(ledger.endsWith('\n'), true);
    const rows = ledger.trimEnd().split('\n').map(line => JSON.parse(line) as MetadataObject);
    assert.deepEqual(rows.map(row => row.tokenId), Array.from({ length: 64 }, (_, index) => String(index + 1)));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('generation drains pending object writes before releasing its lock after a rendering failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), '111k-generation-drain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = join(directory, '.generate.lock');
  const { templates } = await loadMetadataTemplates();
  const first = metadataIdentities().next().value!;
  templates.artwork.description = 'x'.repeat(128 * 1024 - Buffer.byteLength(metadataBody(first, templates)));
  const source = JSON.stringify(templates.artwork);
  const originalRead = fs.readFile;
  const originalWrite = fs.writeFile;
  const originalOpen = fs.open;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writes: Array<Promise<void>> = [];
  let closed = false;
  let settled = false;
  t.mock.method(fs, 'readFile', (async (path, options) => String(path).endsWith('/scripts/ethereum-metadata/templates/artwork.json')
    ? source : originalRead(path, options)) as typeof fs.readFile);
  t.mock.method(fs, 'writeFile', (path, data, options) => {
    if (String(path).startsWith(`${directory}/`) && /\/\d+\.json$/.test(String(path))) {
      if (writes.length === 9) return Promise.reject(new Error('Unexpected object beyond the regression fixture'));
      const write = release.promise.then(() => originalWrite(path, data, options));
      writes.push(write);
      if (writes.length === 9) started.resolve();
      return write;
    }
    return originalWrite(path, data, options);
  });
  t.mock.method(fs, 'open', async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', () => { closed = true; return close(); });
    return handle;
  });
  syncBuiltinESMExports();
  const generation = generateMetadata(directory).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try {
    await started.promise;
    assert.equal(closed, false);
    assert.equal(settled, false);
    await assert.rejects(withMetadataLock(lock, async () => assert.fail('pending writes lost their lock')), /Another metadata operation owns/);
    release.resolve();
    assert.match((await generation).message, /Metadata exceeds 128 KiB: 10\.json/);
    assert.equal(writes.length, 9);
    assert.equal(closed, true);
    assert.equal(await withMetadataLock(lock, async () => 'retry'), 'retry');
  } finally {
    release.resolve();
    await generation;
    await Promise.allSettled(writes);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('generation drains sibling template writes and preserves the first failure before releasing its lock', async t => {
  const directory = await mkdtemp(join(tmpdir(), '111k-template-drain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = join(directory, '.generate.lock');
  const originalWrite = fs.writeFile;
  const originalRemove = fs.rm;
  const failure = new Error('template write failed');
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writes: Array<Promise<void>> = [];
  let releasing = false;
  let settled = false;
  t.mock.method(fs, 'writeFile', (path, data, options) => {
    if (path === join(directory, 'templates', 'artwork.json')) return Promise.reject(failure);
    if (path === join(directory, 'templates', 'crate.json')) {
      const write = release.promise.then(() => originalWrite(path, data, options));
      writes.push(write);
      started.resolve();
      return write;
    }
    return originalWrite(path, data, options);
  });
  t.mock.method(fs, 'rm', (path, options) => {
    if (String(path).startsWith(`${lock}/`)) releasing = true;
    return originalRemove(path, options);
  });
  syncBuiltinESMExports();
  const generation = generateMetadata(directory).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try {
    await started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releasing, false);
    assert.equal(settled, false);
    await assert.rejects(withMetadataLock(lock, async () => assert.fail('pending template write lost its lock')), /Another metadata operation owns/);
    release.resolve();
    assert.equal(await generation, failure);
    assert.equal(await readFile(join(directory, 'templates', 'crate.json'), 'utf8'), (await loadMetadataTemplates()).sources.crate);
    assert.equal(await withMetadataLock(lock, async () => 'retry'), 'retry');
  } finally {
    release.resolve();
    await generation;
    await Promise.allSettled(writes);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('object ledgers reject missing coverage, duplicates, out-of-order identities, and unsafe filenames', async t => {
  const { directory, object } = await fixture(t);
  const read = async () => { for await (const _object of metadataObjects(directory)) { void _object; } };
  await assert.rejects(read(), /incomplete/);
  for (const rows of [
    [object, object],
    [{ ...object, tokenId: '2', file: '2.json' }],
    [{ ...object, file: '../1.json' }],
    [{ ...object, file: '/tmp/1.json' }],
    [{ ...object, md5: 'invalid' }],
    [{ ...object, bytes: 0 }],
    [{ ...object, bytes: 128 * 1024 + 1 }],
  ]) {
    await writeFile(join(directory, 'objects.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(read(), /invalid, duplicated, or out-of-order/);
  }
});

test('validation rejects edited payloads even when their inventory checksums have been updated', async t => {
  const { directory, manifest } = await fixture(t);
  const { templates } = await loadMetadataTemplates();
  templates.artwork.name = 'Unexpected';
  const objects: MetadataObject[] = [];
  for (const identity of metadataIdentities()) {
    const body = metadataBody(identity, templates);
    objects.push({ ...identity, bytes: Buffer.byteLength(body), sha256: sha256(body), md5: md5(body) });
    await writeFile(join(directory, identity.file), body);
    if (objects.length === 64) break;
  }
  await writeFile(join(directory, 'objects.jsonl'), objects.map(object => JSON.stringify(object)).join('\n') + '\n');
  manifest.objectsSha256 = await fileSha256(join(directory, 'objects.jsonl'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'validation.json'), '{"previousSuccess":true}\n');
  await assert.rejects(validateMetadata(directory), /Metadata content mismatch/);
  await assert.rejects(readFile(join(directory, 'validation.json')), { code: 'ENOENT' });
});

test('bounded validation batches finish already-started reads before reporting a failure', async () => {
  let active = 0;
  let maximum = 0;
  const finished: number[] = [];
  const failure = new Error('invalid object');
  await assert.rejects(inBatches([1, 2, 3, 4], 3, async value => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      if (value === 2) throw failure;
      await new Promise(resolve => setImmediate(resolve));
      finished.push(value);
    } finally { active--; }
  }), error => error === failure);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.deepEqual(finished, [1, 3]);
});
