import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildRevealAssetCatalog, importRevealAssets } from '../scripts/ethereum-metadata/assetImport.ts';
import { importRevealCollectionBlocks } from '../scripts/ethereum-metadata/collectionBlocks.ts';
import { buildRevealCatalogUpdateBatch, inspectRevealCatalogUpdate, preflightRevealCatalogUpdateMedia,
  prepareRevealCatalogUpdate, prepareRevealCatalogUpdateFromBundle, promoteRevealCatalogUpdate,
  readRevealCatalogUpdateBundle, runRevealCatalogUpdate } from '../scripts/ethereum-metadata/catalogUpdate.ts';
import { parseCatalogUpdateArgs } from '../scripts/ethereum-metadata/catalogUpdateCli.ts';
import { computeRevealCatalogDescriptor, validateRevealAssetCatalog } from '../shared/ethereum/revealAssetCatalog.ts';
import { getRevealCatalog, getRevealCatalogDescriptor, getSupportedRevealCatalogVersions } from '../shared/ethereum/revealCatalogRegistry.ts';
import { revealCatalogUpdateHash, validateRevealCatalogUpdateBatch, type RevealCatalogUpdateBatch } from '../shared/ethereum/revealCatalogUpdate.ts';
import type { EthereumRevealCatalogUpdateRequest, EthereumRevealCatalogUpdateResult } from '../shared/ethereum/revealMaintenance.ts';

const ASSETS = 'scripts/ethereum-metadata/reveal-assets/111k_devnet';
const sample = () => ({ '3d/1.png': [1, 1], 'animated/1.png': [1, 1], 'paintings/1.png': [1, 1],
  'paintings/alt/1.webp': [1, 1], 'videos/1.mp4': [2, 1], 'videos/1.webp': [2, 1] });
const nextSource = () => ({ ...sample(), 'paintings/2.png': [2, 3], 'paintings/3.png': [3, 2],
  'videos/2.mp4': [2, 1], 'videos/2.webp': [2, 1] });
const catalog = (source: object, catalogVersion: string) => buildRevealAssetCatalog(JSON.stringify(source), { catalogVersion, availableEggs: 111111 });
const batch = () => buildRevealCatalogUpdateBatch(catalog(sample(), '111k-v5'), catalog(nextSource(), '111k-v6'), () => 0);
function rehash(value: RevealCatalogUpdateBatch): RevealCatalogUpdateBatch {
  value.batchSha256 = revealCatalogUpdateHash(value);
  value.batchId = `catalog-${value.batchSha256.slice(0, 32)}`;
  return value;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), '111k-catalog-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootDirectory = join(directory, 'repo');
  const sourcePath = join(directory, 'source.json');
  await writeFile(sourcePath, JSON.stringify(sample()));
  await importRevealAssets({ rootDirectory, sourcePath, catalogVersion: '111k-v5', availableEggs: 111111 });
  await writeFile(sourcePath, JSON.stringify(nextSource()));
  return { directory: join(directory, 'frozen'), rootDirectory, sourcePath, catalogVersion: '111k-v6' };
}

const mediaFetch: typeof fetch = async input => new Response('media', { status: 206, headers: {
  'content-type': String(input).endsWith('.mp4') ? 'video/mp4' : String(input).endsWith('.glb') ? 'model/gltf-binary' :
    String(input).endsWith('.webp') ? 'image/webp' : 'image/png', 'access-control-allow-origin': '*', etag: 'test',
} });

test('partial, absent and sparse alternatives preserve full variant output and reject unknown IDs', () => {
  const full = catalog(sample(), '111k-v5');
  assert.equal(full.categories.paintings.variants!.alt.assetIds, undefined);
  const partial = catalog(nextSource(), '111k-v6');
  assert.deepEqual(partial.categories.paintings.variants!.alt.assetIds, [1]);
  const sparse = catalog({ ...nextSource(), 'paintings/alt/3.webp': [4, 3] }, '111k-v6');
  assert.deepEqual(sparse.categories.paintings.variants!.alt.assetIds, [1, 3]);
  const absent = nextSource();
  delete absent['paintings/alt/1.webp'];
  assert.equal(catalog(absent, '111k-v6').categories.paintings.variants, undefined);
  assert.throws(() => catalog({ ...sample(), 'paintings/alt/2.webp': [1, 1] }, '111k-v6'), /alternate IDs/);
  const malformed = structuredClone(sparse);
  malformed.categories.paintings.variants!.alt.assetIds = [3, 1];
  assert.throws(() => validateRevealAssetCatalog(malformed), /variant asset IDs/);
});

test('frozen mapping covers highest eggs exactly once and only new artwork identities', () => {
  const value = batch();
  validateRevealCatalogUpdateBatch(value);
  assert.equal(value.mappings.length, 3);
  assert.deepEqual(value.mappings.map(row => row.eggId), [111105, 111106, 111107]);
  assert.deepEqual(new Set(value.mappings.map(row => `${row.category}:${row.assetId}`)), new Set(['painting:2', 'painting:3', 'video:2']));
  assert.notDeepEqual(value.mappings.map(row => `${row.category}:${row.assetId}`), ['painting:2', 'painting:3', 'video:2']);
  const duplicated = structuredClone(value);
  duplicated.mappings[1] = { ...duplicated.mappings[0], eggId: duplicated.mappings[1].eggId };
  assert.throws(() => validateRevealCatalogUpdateBatch(rehash(duplicated)), /bijection/);
  const oldArtwork = structuredClone(value);
  oldArtwork.mappings[0].assetId = 1;
  assert.throws(() => validateRevealCatalogUpdateBatch(rehash(oldArtwork)), /bijection/);
  const wrongEgg = structuredClone(value);
  wrongEgg.mappings[0].eggId--;
  assert.throws(() => validateRevealCatalogUpdateBatch(rehash(wrongEgg)), /bijection/);
  const tampered = structuredClone(value);
  tampered.batchSha256 = 'a'.repeat(64);
  assert.throws(() => validateRevealCatalogUpdateBatch(tampered), /batch shape/);
});

test('updates reject deletions, old media changes and nonincreasing catalog versions', () => {
  const old = catalog(sample(), '111k-v5');
  assert.throws(() => buildRevealCatalogUpdateBatch(old, catalog(sample(), '111k-v6')), /egg cutoff/);
  assert.throws(() => buildRevealCatalogUpdateBatch(old, catalog(nextSource(), '111k-v5')), /identity/);
  assert.throws(() => buildRevealCatalogUpdateBatch(old, catalog({ ...nextSource(), 'paintings/1.png': [2, 1] }, '111k-v6')), /media changed/);
  const removedAlt = nextSource();
  delete removedAlt['paintings/alt/1.webp'];
  assert.throws(() => buildRevealCatalogUpdateBatch(old, catalog(removedAlt, '111k-v6')), /alternate changed/);
});

test('a newly prepared singleton operation has a unique nonce without changing its catalog or mapping', () => {
  const predecessor = catalog(sample(), '111k-v5');
  const target = catalog({ ...sample(), 'paintings/2.png': [2, 3] }, '111k-v6');
  const first = buildRevealCatalogUpdateBatch(predecessor, target);
  const second = buildRevealCatalogUpdateBatch(predecessor, target);
  assert.deepEqual(first.mappings, second.mappings);
  assert.deepEqual(first.target.descriptor, second.target.descriptor);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.batchId, second.batchId);
  assert.throws(() => validateRevealCatalogUpdateBatch({ ...first, nonce: second.nonce }), /checksum mismatch/);
  assert.throws(() => validateRevealCatalogUpdateBatch({ ...first, nonce: 'invalid' }), /batch shape/);
});

test('inspect is read-only, prepare freezes once, promotion is explicit and retains ancestors', async t => {
  const input = await fixture(t);
  const original = await readFile(join(input.rootDirectory, ASSETS, 'manifest.json'), 'utf8');
  const summary = await inspectRevealCatalogUpdate(input);
  assert.equal(summary.additions, 3);
  assert.equal(summary.newEggCount, 111104);
  assert.equal(await readFile(join(input.rootDirectory, ASSETS, 'manifest.json'), 'utf8'), original);
  const first = await prepareRevealCatalogUpdate(input);
  assert.deepEqual(await prepareRevealCatalogUpdate(input), first);
  assert.deepEqual(await readRevealCatalogUpdateBundle(input.directory), first);
  assert.equal(await readFile(join(input.rootDirectory, ASSETS, 'manifest.json'), 'utf8'), original);
  await assert.rejects(promoteRevealCatalogUpdate(input.directory, { rootDirectory: input.rootDirectory, write: false }), /requires --write/);
  await promoteRevealCatalogUpdate(input.directory, { rootDirectory: input.rootDirectory, write: true });
  await promoteRevealCatalogUpdate(input.directory, { rootDirectory: input.rootDirectory, write: true });
  assert.deepEqual(await prepareRevealCatalogUpdate(input), first);
  const ancestors = JSON.parse(await readFile(join(input.rootDirectory, 'shared/ethereum/revealCatalogAncestors.json'), 'utf8'));
  assert.equal(ancestors.length, 1);
  assert.deepEqual(computeRevealCatalogDescriptor(ancestors[0]), first.batch.predecessor.descriptor);
  assert.equal(JSON.parse(await readFile(join(input.rootDirectory, ASSETS, 'manifest.json'), 'utf8')).catalogVersion, '111k-v6');
  assert.equal((await importRevealAssets({ rootDirectory: input.rootDirectory, check: true })).status, 'checked');
});

test('promotion excludes standalone imports between predecessor validation and canonical writes', async t => {
  const input = await fixture(t);
  await writeFile(input.sourcePath, JSON.stringify({ ...sample(), 'paintings/2.png': [2, 3] }));
  const { batch } = await prepareRevealCatalogUpdate({ ...input, catalogVersion: '111k-v7' });
  const concurrentSource = join(input.rootDirectory, 'concurrent-source.json');
  await writeFile(concurrentSource, JSON.stringify({ ...sample(), 'videos/2.mp4': [2, 1], 'videos/2.webp': [2, 1] }));
  const ancestorPath = join(input.rootDirectory, 'shared/ethereum/revealCatalogAncestors.json');
  const originalRename = fs.rename;
  let attempted = false;
  const rename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    if (args[1] === ancestorPath) {
      attempted = true;
      await assert.rejects(importRevealAssets({ rootDirectory: input.rootDirectory, sourcePath: concurrentSource,
        catalogVersion: '111k-v6', availableEggs: 111111 }), /Another metadata operation/);
    }
  });
  syncBuiltinESMExports();
  try {
    await promoteRevealCatalogUpdate(input.directory, { rootDirectory: input.rootDirectory, write: true });
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(attempted, true);
  const result = await importRevealAssets({ rootDirectory: input.rootDirectory, check: true });
  assert.deepEqual(result.descriptor, batch.target.descriptor);
  assert.deepEqual(JSON.parse(await readFile(ancestorPath, 'utf8')), [batch.predecessor.manifest]);
  await assert.rejects(importRevealAssets({ rootDirectory: input.rootDirectory, sourcePath: concurrentSource,
    catalogVersion: '111k-v6', availableEggs: 111111 }), /cannot decrease/);
});

test('source and frozen bundle tampering fail before canonical writes', async t => {
  const input = await fixture(t);
  await writeFile(input.sourcePath, JSON.stringify({ ...nextSource(), 'paintings/1.png': [2, 2] }));
  await assert.rejects(prepareRevealCatalogUpdate(input), /existing source/);
  await writeFile(input.sourcePath, JSON.stringify(nextSource()));
  await prepareRevealCatalogUpdate(input);
  await writeFile(join(input.directory, 'source.json'), JSON.stringify(sample()));
  await assert.rejects(readRevealCatalogUpdateBundle(input.directory), /checksum/);
  await assert.rejects(promoteRevealCatalogUpdate(input.directory, { rootDirectory: input.rootDirectory, write: true }), /checksum/);
  assert.equal(JSON.parse(await readFile(join(input.rootDirectory, ASSETS, 'manifest.json'), 'utf8')).catalogVersion, '111k-v5');
});

test('expansion can add legacy collection blocks but cannot change dimensions or recorded labels', async t => {
  const input = await fixture(t);
  const rich = Object.fromEntries(Object.entries(nextSource()).map(([path, dimensions]) =>
    [path, [...dimensions, `${path.split('/')[0]} Block`]]));
  await writeFile(input.sourcePath, JSON.stringify(rich));
  const prepared = await prepareRevealCatalogUpdate(input);
  assert.equal(prepared.batch.mappings.length, 3);
  await promoteRevealCatalogUpdate(input.directory, { rootDirectory: input.rootDirectory, write: true });
  const expanded = { ...rich, 'paintings/4.png': [2, 3, 'New Block'] };
  await writeFile(input.sourcePath, JSON.stringify(expanded));
  const next = { ...input, catalogVersion: '111k-v7' };
  assert.equal((await inspectRevealCatalogUpdate(next)).additions, 1);
  for (const tuple of [[1, 1], [1, 1, 'changed']]) {
    await writeFile(input.sourcePath, JSON.stringify({ ...expanded, '3d/1.png': tuple }));
    await assert.rejects(inspectRevealCatalogUpdate(next), /existing collection block labels/);
  }
  await writeFile(input.sourcePath, JSON.stringify({ ...expanded, '3d/1.png': [2, 2, '3d Block'] }));
  await assert.rejects(inspectRevealCatalogUpdate(next), /existing source paths or dimensions/);
});

test('expansion preserves supplemental labels before promoting a legacy two-value catalog', async t => {
  const input = await fixture(t);
  const withBlocks = (source: Record<string, number[]>) => Object.fromEntries(Object.entries(source).map(([path, dimensions]) =>
    [path, [...dimensions, `${path.split('/')[0]} Block`]]));
  await writeFile(input.sourcePath, JSON.stringify(withBlocks(sample())));
  await importRevealCollectionBlocks(input);
  const before = await readFile(join(input.rootDirectory, ASSETS, 'manifest.json'), 'utf8');
  const expanded = withBlocks(nextSource());
  await writeFile(input.sourcePath, JSON.stringify(expanded));
  assert.equal((await inspectRevealCatalogUpdate(input)).additions, 3);
  for (const tuple of [[1, 1], [1, 1, 'changed']]) {
    await writeFile(input.sourcePath, JSON.stringify({ ...expanded, '3d/1.png': tuple }));
    await assert.rejects(prepareRevealCatalogUpdate(input), /existing collection block labels/);
    assert.equal(await readFile(join(input.rootDirectory, ASSETS, 'manifest.json'), 'utf8'), before);
  }
  await writeFile(input.sourcePath, JSON.stringify(expanded));
  await writeFile(join(input.rootDirectory, ASSETS, 'collection-blocks.source.json'), JSON.stringify(withBlocks(nextSource())));
  await assert.rejects(inspectRevealCatalogUpdate(input), /collection block source checksum mismatch/);
});

test('a cancelled operation can be prepared again after promotion with its original mapping and a new nonce', async t => {
  const input = await fixture(t);
  const original = await prepareRevealCatalogUpdate(input);
  await promoteRevealCatalogUpdate(input.directory, { rootDirectory: input.rootDirectory, write: true });
  const retryDirectory = `${input.directory}-retry`;
  const retry = await prepareRevealCatalogUpdateFromBundle(input.directory, retryDirectory);
  assert.deepEqual(retry.batch.mappings, original.batch.mappings);
  assert.deepEqual(retry.batch.predecessor, original.batch.predecessor);
  assert.deepEqual(retry.batch.target, original.batch.target);
  assert.notEqual(retry.batch.nonce, original.batch.nonce);
  assert.notEqual(retry.batch.batchId, original.batch.batchId);
  assert.deepEqual(await prepareRevealCatalogUpdateFromBundle(input.directory, retryDirectory), retry);
  assert.deepEqual(await readRevealCatalogUpdateBundle(input.directory), original);
  await assert.rejects(prepareRevealCatalogUpdateFromBundle(input.directory, input.directory), /new bundle directory/);
});

test('media preflight bounds requests and rejects unavailable assets before remote mutation', async t => {
  const value = batch();
  const urls: string[] = [];
  const report = await preflightRevealCatalogUpdateMedia(value, async (input, init) => {
    urls.push(String(input));
    assert.equal((init!.headers as Record<string, string>).Range, 'bytes=0-32');
    assert.equal(init!.redirect, 'manual');
    return mediaFetch(input, init);
  });
  assert.equal(report.objects, 4);
  assert.equal(urls.length, 4);
  const input = await fixture(t);
  await prepareRevealCatalogUpdate(input);
  let calls = 0;
  await assert.rejects(runRevealCatalogUpdate({ ...input, deploymentId: 'test', expectedRevision: 4, action: 'apply',
    fetchSource: async () => new Response('missing', { status: 404 }), transport: async () => { calls++; throw new Error('unexpected'); } }), /preflight failed/);
  assert.equal(calls, 0);
});

test('online apply resumes every phase with frozen identity and verify remains read-only', async t => {
  const input = await fixture(t);
  const { batch: value } = await prepareRevealCatalogUpdate(input);
  const calls: EthereumRevealCatalogUpdateRequest[] = [];
  const result = (phase: EthereumRevealCatalogUpdateResult['phase']): EthereumRevealCatalogUpdateResult => ({
    deploymentId: 'test', batchId: value.batchId, phase, complete: phase === 'complete', catalogRevision: 2,
    total: 3, staged: 3, applied: 3, published: 3, frozen: 1, retryAfterMs: 10_000,
    nextVerificationEggId: null,
  });
  const phases: EthereumRevealCatalogUpdateResult['phase'][] = ['staging', 'validating', 'activating', 'publishing', 'verifying', 'observing', 'complete'];
  let phase = 0;
  const transport = async (request: EthereumRevealCatalogUpdateRequest) => {
    calls.push(request);
    return result(request.action === 'verify' ? 'complete' : phases[Math.min(phase++, phases.length - 1)]);
  };
  const delays: number[] = [];
  await runRevealCatalogUpdate({ ...input, deploymentId: 'test', expectedRevision: 4, action: 'apply', transport,
    fetchSource: mediaFetch, sleep: async ms => { delays.push(ms); } });
  assert.deepEqual(calls.map(row => row.action), ['begin', ...Array(6).fill('advance')]);
  assert.deepEqual(delays, Array(6).fill(5000));
  assert.deepEqual(calls[0].batch, value);
  const before = await Promise.all((await readdir(input.directory)).sort().map(async name => [name, await readFile(join(input.directory, name), 'utf8')]));
  await runRevealCatalogUpdate({ ...input, deploymentId: 'test', expectedRevision: 4, action: 'verify', transport,
    fetchSource: async () => { throw new Error('verify made network media requests'); } });
  const after = await Promise.all((await readdir(input.directory)).sort().map(async name => [name, await readFile(join(input.directory, name), 'utf8')]));
  assert.deepEqual(after, before);
  assert.equal(calls.at(-1)!.action, 'verify');
  await assert.rejects(runRevealCatalogUpdate({ ...input, deploymentId: 'test', expectedRevision: 5, action: 'apply', transport }), /original revision/);
});

test('CLI rejects accidental promotion, malformed scopes and incompatible flags', () => {
  assert.equal(parseCatalogUpdateArgs(['inspect', '--source', '/tmp/input.json'])!.command, 'inspect');
  assert.equal(parseCatalogUpdateArgs(['verify', '--bundle', '/tmp/bundle'])!.command, 'verify');
  assert.equal(parseCatalogUpdateArgs(['promote', '--bundle', '/tmp/bundle', '--write'])!.write, true);
  for (const command of ['apply', 'cancel']) {
    const args = [command, '--bundle', '/tmp/bundle', '--deployment-id', 'test', '--expected-revision', '4'];
    assert.throws(() => parseCatalogUpdateArgs(args));
    assert.equal(parseCatalogUpdateArgs([...args, '--write'])!.write, true);
  }
  assert.equal(parseCatalogUpdateArgs(['prepare', '--from-bundle', '/tmp/old', '--bundle', '/tmp/new'])!.fromDirectory, '/tmp/old');
  for (const args of [['promote', '--bundle', '/tmp/bundle'], ['apply', '--bundle', '/tmp/bundle'],
    ['inspect', '--source', '/tmp/input.json', '--write'], ['verify', '--bundle', '/tmp/bundle', '--expected-revision', '1'],
    ['apply', '--bundle', '/tmp/bundle', '--deployment-id', 'test', '--expected-revision', '0'],
    ['prepare', '--from-bundle', '/tmp/old', '--bundle', '/tmp/new', '--source', '/tmp/source'],
    ['prepare', '--from-bundle', '/tmp/old', '--bundle', '/tmp/new', '--catalog-version', '111k-v6']]) {
    assert.throws(() => parseCatalogUpdateArgs(args));
  }
});

test('read-only verification pages every object and rejects a stalled cursor', async t => {
  const input = await fixture(t);
  const { batch: value } = await prepareRevealCatalogUpdate(input);
  const cursors: number[] = [];
  const options = { ...input, deploymentId: 'test', expectedRevision: 4, action: 'verify' as const };
  const response = (nextVerificationEggId: number | null): EthereumRevealCatalogUpdateResult => ({
    deploymentId: 'test', batchId: value.batchId, phase: 'complete', complete: true, catalogRevision: 2,
    total: 3, staged: 3, applied: 3, published: 3, frozen: 1, retryAfterMs: 0, nextVerificationEggId,
  });
  await runRevealCatalogUpdate({ ...options, transport: async request => {
    assert.equal(request.action, 'verify');
    cursors.push(request.verificationAfterEggId!);
    return response(cursors.length === 1 ? 111106 : null);
  } });
  assert.deepEqual(cursors, [111104, 111106]);
  await assert.rejects(runRevealCatalogUpdate({ ...options,
    transport: async request => response(request.verificationAfterEggId!) }), /cursor did not advance/);
});

test('failed begin preserves original operation revision and rejects a different revision on retry', async t => {
  const input = await fixture(t);
  await prepareRevealCatalogUpdate(input);
  const options = { ...input, deploymentId: 'test', expectedRevision: 4, action: 'apply' as const, fetchSource: mediaFetch };
  await assert.rejects(runRevealCatalogUpdate({ ...options, transport: async () => { throw new Error('interrupted'); } }), /interrupted/);
  const journal = JSON.parse(await readFile(join(input.directory, 'test.journal.json'), 'utf8'));
  assert.equal(journal.expectedRevision, 4);
  assert.equal(journal.result, null);
  await assert.rejects(runRevealCatalogUpdate({ ...options, expectedRevision: 5,
    transport: async () => { throw new Error('wrong revision reached transport'); } }), /original revision/);
});

test('concurrent local mutation commands cannot overwrite the operation journal', async t => {
  const input = await fixture(t);
  const { batch: value } = await prepareRevealCatalogUpdate(input);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const options = { ...input, deploymentId: 'test', expectedRevision: 4, action: 'apply' as const, fetchSource: mediaFetch };
  const first = runRevealCatalogUpdate({ ...options, transport: async () => {
    entered();
    await blocked;
    return { deploymentId: 'test', batchId: value.batchId, phase: 'complete', complete: true, catalogRevision: 2,
      total: 3, staged: 3, applied: 3, published: 3, frozen: 1, retryAfterMs: 0 };
  } });
  await started;
  try {
    await assert.rejects(runRevealCatalogUpdate({ ...options, expectedRevision: 5,
      transport: async () => { throw new Error('second mutation reached transport'); } }), /Another metadata operation/);
  } finally { release(); }
  await first;
  assert.equal(JSON.parse(await readFile(join(input.directory, 'test.journal.json'), 'utf8')).expectedRevision, 4);
});

test('current v8 catalog and retained v5, v6 and v7 ancestors are pinned and immutable', () => {
  const supported = getSupportedRevealCatalogVersions();
  for (const [version, eggs, paintings] of [
    ['111k-v5', 76642, 30990], ['111k-v6', 67284, 40348], ['111k-v7', 60504, 47128],
    ['111k-v8', 55303, 52329],
  ] as const) {
    assert.ok(supported.includes(version));
    const descriptor = getRevealCatalogDescriptor(version)!;
    const value = getRevealCatalog(version, descriptor.manifestSha256)!;
    assert.equal(value.categories.eggs.count, eggs);
    assert.equal(value.categories.paintings.count, paintings);
    assert.ok(Object.isFrozen(value.categories.eggs));
    assert.equal(getRevealCatalog(version, 'a'.repeat(64)), undefined);
  }
  assert.equal(getRevealCatalog('111k-v999'), undefined);
});
