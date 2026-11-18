import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cp, copyFile, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256 } from '../scripts/ethereum-metadata/catalog.ts';
import { buildMixedAllocation } from '../scripts/ethereum-metadata/mixedAllocation.ts';
import { getInstalledMixedAllocation } from '../shared/ethereum/installedMixedAllocation.ts';
import { getRevealCatalog } from '../shared/ethereum/revealCatalogRegistry.ts';
import { drawMixedAllocation, mixedAllocationHash, validateMixedAllocationDefinition, validateMixedAllocationRelease } from '../shared/ethereum/revealMixedAllocation.ts';
import { mixedAllocationFixtureSource } from './helpers/ethereumMixedAllocationSource.ts';

const source = await mixedAllocationFixtureSource();
const release = await buildMixedAllocation(source, sha256(source));
const { definition, targetCatalog, summary, ownerSupplement, collectionBlocks } = release;
const predecessor = getRevealCatalog(definition.predecessor.catalogVersion, definition.predecessor.manifestSha256)!;

test('mixed review binds the full source, preserves DROWEE and relics, and counts painting alternates as variants', () => {
  assert.deepEqual([summary.manifestPaths, summary.unchangedPaths, summary.knownOwnerArtworks, summary.knownRelics, summary.newAlternates],
    [148_276, 103_507, 175, 18, 37_990]);
  assert.equal(summary.newArtworks, 6586);
  assert.deepEqual(summary.groups.map(row => [row.ownerCount, row.futureCount]), [[124, 0], [100, 1400], [100, 2189], [100, 2573]]);
  assert.equal(targetCatalog.categories.paintings.count, 75_442);
  assert.equal(targetCatalog.categories.animated.count, 421);
  assert.equal(targetCatalog.categories.paintings.variants?.alt.assetIds?.at(-1), 68_980);
  assert.equal(ownerSupplement.batches[0].artworks[0].animationExtension, 'gif');
  assert.deepEqual(ownerSupplement.batches[1].artworks[0], { assetId: 597, width: 641, height: 480, collectionBlock: 'GAN videos', animationExtension: 'mp4' });
  assert.equal(ownerSupplement.batches[1].artworks.at(-1)?.assetId, 720);
  assert.equal(getRevealCatalog(definition.target.catalogVersion, definition.target.manifestSha256), undefined);
  const installed = getInstalledMixedAllocation();
  assert.equal(installed.definition.target.catalogVersion, '111k-v10');
  assert.equal(installed.targetCatalog.categories.paintings.count, 75_442);
});

test('mixed source validation rejects changed predecessors, duplicate paths, and incomplete alternate coverage', async () => {
  await assert.rejects(buildMixedAllocation(source, '0'.repeat(64)), /source SHA-256/);
  const duplicate = source.replace('{', '{"animated/597.png":[1,1,"GAN videos"],');
  await assert.rejects(buildMixedAllocation(duplicate, sha256(duplicate)), /duplicate paths/);
  const entries = JSON.parse(source);
  for (const path of ['3d/1.png', 'animated/422.png', 'relics/1.png', 'animated/597.png', 'paintings/alt/30991.webp']) {
    const value = entries[path];
    delete entries[path];
    const changed = JSON.stringify(entries);
    await assert.rejects(buildMixedAllocation(changed, sha256(changed)), /changed or removed|Missing or mislabeled|alternate coverage/);
    entries[path] = value;
  }
});

test('mixed validation rejects changed artifact bindings, overlap, and edits to a per-collection quota', () => {
  assert.throws(() => validateMixedAllocationRelease({ ...definition, ownerSupplementSha256: '0'.repeat(64) }, predecessor, targetCatalog,
    collectionBlocks, ownerSupplement), /supplements/);
  const legacySupplement = structuredClone(ownerSupplement);
  delete legacySupplement.batches.at(-1)!.allocation;
  delete legacySupplement.batches.at(-1)!.target;
  assert.throws(() => validateMixedAllocationRelease({ ...definition, ownerSupplementSha256: mixedAllocationHash(legacySupplement) },
    predecessor, targetCatalog, collectionBlocks, legacySupplement), /supplements/);
  const wrongTarget = structuredClone(ownerSupplement);
  wrongTarget.batches.at(-1)!.target!.manifestSha256 = '0'.repeat(64);
  assert.throws(() => validateMixedAllocationRelease({ ...definition, ownerSupplementSha256: mixedAllocationHash(wrongTarget) },
    predecessor, targetCatalog, collectionBlocks, wrongTarget), /supplements/);
  const changedQuota = structuredClone(definition);
  changedQuota.groups[1].ownerCount--;
  changedQuota.groups[2].ownerCount++;
  assert.throws(() => validateMixedAllocationRelease(changedQuota, predecessor, targetCatalog, collectionBlocks, ownerSupplement), /reviewed split/);
  const overlap = structuredClone(definition);
  overlap.groups[2].firstId = overlap.groups[1].lastId;
  assert.throws(() => validateMixedAllocationDefinition(overlap), /group/);
});

test('the private draw samples without replacement within each collection and accounts for every artwork once', () => {
  const draw = drawMixedAllocation(definition, maximum => maximum - 1);
  assert.equal(draw.owner.length, 424);
  assert.equal(draw.future.length, 6162);
  assert.equal(new Set([...draw.owner, ...draw.future].map(art => `${art.category}/${art.assetId}`)).size, 6586);
  for (const group of definition.groups) {
    assert.equal(draw.owner.filter(art => art.category === group.category && art.assetId >= group.firstId && art.assetId <= group.lastId).length, group.ownerCount);
  }
  assert.notDeepEqual(draw.owner, drawMixedAllocation(definition, () => 0).owner);
  assert.throws(() => drawMixedAllocation(definition, maximum => maximum), /Invalid mixed allocation draw/);
  assert.ok(draw.future.every(art => art.category === 'painting'));
});

test('mixed promotion preserves the installed catalog on an owner conflict and resumes after interruption', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mixed-promotion-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = 'scripts/ethereum-metadata/reveal-assets/111k_devnet';
  const release = 'releases/111k-catalog-v10';
  const v9source = 'releases/111k-catalog-v9/source.json';
  for (const path of ['package.json', 'scripts/ethereum-metadata', 'scripts/shared', 'shared/ethereum',
    release, v9source, 'releases/111k-relic-images-2026-11-11/preflight.json']) {
    await cp(resolve(path), join(root, path), { recursive: true });
  }
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const manifest = join(root, assets, 'manifest.json');
  const descriptor = join(root, 'shared/ethereum/revealCatalog.json');
  await writeFile(manifest, JSON.stringify(predecessor, null, 2) + '\n');
  await writeFile(descriptor, JSON.stringify(definition.predecessor, null, 2) + '\n');
  await copyFile(join(root, v9source), join(root, assets, 'source.json'));
  await copyFile(join(root, v9source), join(root, assets, 'collection-blocks.source.json'));
  await copyFile(join(root, release, 'predecessor-collection-blocks.json'), join(root, assets, 'collection-blocks.json'));
  const ownerPath = join(root, 'shared/ethereum/ownerHatchingCatalog.json');
  const originalOwner = await readFile(join(root, release, 'predecessor-owner-supplement.json'), 'utf8');
  const args = ['--import', 'tsx', 'scripts/ethereum-metadata/promoteMixedRelease.ts', '--source', join(release, 'original-input.json'), '--write'];
  const options = { cwd: root, encoding: 'utf8' as const, timeout: 60_000 };
  const conflictingOwner = JSON.parse(originalOwner);
  conflictingOwner.batches[0].id = 'different-owner-batch';
  await writeFile(ownerPath, JSON.stringify(conflictingOwner));
  const installedFiles = [descriptor, ownerPath, join(root, 'shared/ethereum/revealCatalogAncestors.json'),
    ...(await readdir(join(root, assets))).map(name => join(root, assets, name))];
  const snapshot = () => Promise.all(installedFiles.map(async path => sha256(await readFile(path))));
  const before = await snapshot();
  const rejected = spawnSync(process.execPath, args, options);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Owner supplement predecessor changed/);
  assert.deepEqual(await snapshot(), before);
  await writeFile(ownerPath, originalOwner);

  const interrupt = join(root, 'interrupt.mjs');
  await writeFile(interrupt, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.rename;
    fs.rename = async (...args) => {
      await rename(...args);
      if (args[1] === ${JSON.stringify(manifest)}) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();`);
  const stopped = spawnSync(process.execPath, ['--import', interrupt, ...args], options);
  assert.equal(stopped.signal, 'SIGKILL', stopped.stderr);
  assert.equal(JSON.parse(await readFile(manifest, 'utf8')).catalogVersion, '111k-v10');
  assert.equal(JSON.parse(await readFile(descriptor, 'utf8')).catalogVersion, '111k-v9');
  const resumed = spawnSync(process.execPath, args, options);
  assert.equal(resumed.status, 0, resumed.stderr);
  const result = JSON.parse(resumed.stdout);
  assert.deepEqual(result.catalog, getInstalledMixedAllocation().definition.target);
  assert.deepEqual(JSON.parse(await readFile(descriptor, 'utf8')), result.catalog);
  assert.equal(await readFile(manifest, 'utf8'), await readFile(join(root, release, 'manifest.json'), 'utf8'));
  await assert.rejects(readFile(join(root, '.cache/111k-assets/recovery.json')), { code: 'ENOENT' });

  const installedOwner = JSON.stringify(JSON.parse(await readFile(ownerPath, 'utf8')));
  await writeFile(ownerPath, installedOwner);
  const replay = spawnSync(process.execPath, args, options);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(await readFile(ownerPath, 'utf8'), installedOwner);
});
