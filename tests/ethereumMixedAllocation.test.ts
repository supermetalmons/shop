import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cp, copyFile, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256 } from '../scripts/ethereum-metadata/catalog.ts';
import { buildMixedAllocation, prepareMixedRelease, readPreparedMixedRelease, type MixedReleasePolicy } from '../scripts/ethereum-metadata/mixedAllocation.ts';
import { getInstalledMixedAllocation } from '../shared/ethereum/installedMixedAllocation.ts';
import { getRevealCatalog } from '../shared/ethereum/revealCatalogRegistry.ts';
import { drawMixedAllocation, mixedAllocationCounts, mixedAllocationHash, validateMixedAllocationDefinition, validateMixedAllocationRelease } from '../shared/ethereum/revealMixedAllocation.ts';
import { buildRevealAssetCatalog } from '../scripts/ethereum-metadata/assetImport.ts';
import { buildRevealCollectionBlocks } from '../scripts/ethereum-metadata/collectionBlocks.ts';
import { computeRevealCatalogDescriptor, revealCatalogMedia, revealCatalogAssetId, revealCatalogAssetOrdinal } from '../shared/ethereum/revealAssetCatalog.ts';
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
  const v9Ancestors = collectionBlocks.catalogs
    .filter(({ catalogVersion }) => Number(catalogVersion.slice(6)) < Number(predecessor.catalogVersion.slice(6)))
    .map(({ catalogVersion, manifestSha256 }) => getRevealCatalog(catalogVersion, manifestSha256));
  await writeFile(join(root, 'shared/ethereum/revealCatalogAncestors.json'), JSON.stringify(v9Ancestors, null, 2) + '\n');
  await writeFile(join(root, 'shared/ethereum/mixedAllocationReleases.json'), '[]\n');
  const args = ['--import', 'tsx', 'scripts/ethereum-metadata/promoteMixedRelease.ts', '--source', join(release, 'original-input.json'), '--write'];
  const options = { cwd: root, encoding: 'utf8' as const, timeout: 60_000 };
  const conflictingOwner = JSON.parse(originalOwner);
  conflictingOwner.batches[0].id = 'different-owner-batch';
  await writeFile(ownerPath, JSON.stringify(conflictingOwner));
  const installedFiles = [descriptor, ownerPath, join(root, 'shared/ethereum/mixedAllocationReleases.json'), join(root, 'shared/ethereum/revealCatalogAncestors.json'),
    ...(await readdir(join(root, assets))).map(name => join(root, assets, name))];
  const snapshot = () => Promise.all(installedFiles.map(async path => sha256(await readFile(path))));
  const before = await snapshot();
  const rejected = spawnSync(process.execPath, args, options);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Owner supplement predecessor changed/);
  assert.deepEqual(await snapshot(), before);
  await writeFile(ownerPath, originalOwner);

  const ancestorsPath = join(root, 'shared/ethereum/revealCatalogAncestors.json');
  const blocksPath = join(root, assets, 'collection-blocks.json');
  const retainedCatalogs = await readFile(ancestorsPath, 'utf8');
  const retainedBlocks = await readFile(blocksPath, 'utf8');
  const catalogs = JSON.parse(retainedCatalogs);
  const blocks = JSON.parse(retainedBlocks);
  const omitted = blocks.catalogs[0].catalogVersion;
  await writeFile(ancestorsPath, JSON.stringify(catalogs.filter((row: { catalogVersion: string }) => row.catalogVersion !== omitted)));
  await writeFile(blocksPath, JSON.stringify({ ...blocks, catalogs: blocks.catalogs.slice(1) }));
  const shortened = await snapshot();
  const historyRejected = spawnSync(process.execPath, args, options);
  assert.equal(historyRejected.status, 1);
  assert.match(historyRejected.stderr, /collection block history/);
  assert.deepEqual(await snapshot(), shortened);
  await writeFile(ancestorsPath, retainedCatalogs);
  await writeFile(blocksPath, retainedBlocks);

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

  await cp(resolve('cloud/workers/api/src'), join(root, 'cloud/workers/api/src'), { recursive: true });
  const media = join(root, 'media.mjs');
  const cli = ['--import', 'tsx', 'scripts/ethereum-metadata/mixedCli.ts'];
  const policy = {
    batchId: 'synthetic-ordinary', deploymentId: 'synthetic', chainId: 11155111, contractAddress: '0x' + '1'.repeat(40),
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/synthetic/', deploymentBlock: 1, originCatalogVersion: '111k-v9', predecessor: result.catalog,
    targetVersion: result.catalog.catalogVersion, quotas: [], ordinaryCount: 1,
  };
  const complete = JSON.parse(await readFile(join(root, release, 'original-input.json'), 'utf8'));
  const painting = targetCatalog.categories.paintings.count + 1;
  const nextSource = { ...complete, [`paintings/${painting}.png`]: [80, 80, 'new artwork'] };
  const prepare = async (scope: MixedReleasePolicy, fullSource: object) => {
    const source = join(root, scope.batchId + '.json');
    const policyFile = join(root, scope.batchId + '-policy.json');
    const bundle = join(root, '.operations', scope.batchId);
    await writeFile(source, JSON.stringify(fullSource));
    await writeFile(policyFile, JSON.stringify(scope));
    const args = [...cli, 'prepare', '--source', source, '--policy', policyFile, '--bundle', bundle];
    const prepared = spawnSync(process.execPath, args, options);
    assert.equal(prepared.status, 0, prepared.stderr);
    const approved = JSON.parse(prepared.stdout);
    return { args, approved, bundle, policyFile, promote: ['--import', media, ...cli, 'promote', '--definition-sha256', approved.definitionSha256, '--bundle', bundle, '--write'] };
  };
  const ordinary = await prepare(policy, complete);
  const head = await prepare({ ...policy, batchId: 'new-head', targetVersion: '111k-v11', ordinaryCount: 0 },
    { ...nextSource, [`paintings/alt/${painting}.webp`]: [80, 80, 'new artwork'] });
  const later = await prepare({ ...policy, batchId: 'later-older-predecessor', targetVersion: '111k-v12', ordinaryCount: 0 },
    { ...nextSource, [`paintings/${painting + 1}.png`]: [80, 80, 'another artwork'] });
  await writeFile(media, 'globalThis.fetch = async () => new Response(null, {status: 404});');
  const priorInstall = await snapshot();
  const invalidMedia = spawnSync(process.execPath, head.promote, options);
  assert.equal(invalidMedia.status, 1);
  assert.match(invalidMedia.stderr, /media failed/);
  assert.deepEqual(await snapshot(), priorInstall);
  const largeTemplate = join(root, 'large-template.json');
  await writeFile(largeTemplate, JSON.stringify({ name: '{{tokenId}}', description: 'a'.repeat(400 * 1024), attributes: [] }));
  const largeTraits = `globalThis.fetch = async (url, init) => new Headers(init?.headers).has('Range')
    ? new Response('sample', {status:206,headers: {'content-type':String(url).endsWith('.webp')?'image/webp':'image/png','access-control-allow-origin':'*'}})
    : Response.json({'collection block':'new artwork',attributes:[{trait_type:'detail',value:'b'.repeat(120 * 1024)}]});`;
  await writeFile(media, largeTraits);
  const oversized = spawnSync(process.execPath, [...head.promote, '--template-file', largeTemplate], options);
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /exceeds 512 KiB/);
  assert.deepEqual(await snapshot(), priorInstall);

  await writeFile(media, `globalThis.fetch = async (url, init) => new Headers(init?.headers).has('Range')
    ? new Response('sample', {status:206,headers: {'content-type':String(url).endsWith('.webp')?'image/webp':'image/png','access-control-allow-origin':'*'}})
    : Response.json({'collection block':'new artwork',attributes:[]});`);
  for (const batch of [ordinary, head]) {
    const promoted = spawnSync(process.execPath, batch.promote, options);
    assert.equal(promoted.status, 0, promoted.stderr);
    const { mediaPreflight } = JSON.parse(promoted.stdout);
    assert.equal(mediaPreflight.definitionSha256, batch.approved.definitionSha256);
    assert.equal(mediaPreflight.mediaObjects, batch === ordinary ? 0 : 2);
    assert.equal(mediaPreflight.traitSources, batch === ordinary ? 0 : 1);
    assert.deepEqual(JSON.parse(await readFile(descriptor, 'utf8')), batch.approved.catalog);
  }
  assert.deepEqual(JSON.parse(await readFile(join(root, 'shared/ethereum/mixedAllocationReleases.json'), 'utf8')).map((row: MixedReleasePolicy) => row.batchId),
    [policy.batchId, 'new-head']);
  const installed = await snapshot();
  await writeFile(media, largeTraits);
  const repeatedCheck = spawnSync(process.execPath, [...head.promote, '--template-file', largeTemplate], options);
  assert.equal(repeatedCheck.status, 1);
  assert.match(repeatedCheck.stderr, /exceeds 512 KiB/);
  assert.deepEqual(await snapshot(), installed);
  const stale = spawnSync(process.execPath, later.promote, options);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /changed existing artwork source/);
  assert.deepEqual(await snapshot(), installed);

  const frozen = async () => Promise.all((await readdir(ordinary.bundle)).map(async name => sha256(await readFile(join(ordinary.bundle, name)))));
  const { catalogVersion, manifestSha256 } = policy.predecessor;
  const definitionPath = join(ordinary.bundle, 'definition.json');
  const reorderedDefinition = { ...JSON.parse(await readFile(definitionPath, 'utf8')), predecessor: { manifestSha256, catalogVersion } };
  await writeFile(definitionPath, JSON.stringify(reorderedDefinition));
  const frozenBytes = await frozen();
  const again = spawnSync(process.execPath, ordinary.args, options);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), { ...ordinary.approved, definitionSha256: mixedAllocationHash(reorderedDefinition) });
  assert.deepEqual(await frozen(), frozenBytes);
  await writeFile(ordinary.policyFile, JSON.stringify({ ...policy, ordinaryCount: 2 }));
  const changed = spawnSync(process.execPath, ordinary.args, options);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /differs from requested source or policy/);
  assert.deepEqual(await frozen(), frozenBytes);

});

test('mixed preflight validates canonical metadata size and media on the holder origins', async () => {
  const { preflightMixedMedia } = await import('../scripts/ethereum-metadata/mixedMedia.ts');
  const { applyRevealAttributePayload, MAX_REVEAL_METADATA_BYTES } = await import('../cloud/workers/api/src/ethereumRevealAttributes.ts');
  const { buildNewRevealedArtwork } = await import('../cloud/workers/api/src/ethereumRevealCatalog.ts');
  const { selectRevealCollectionBlocks, lookupRevealCollectionBlock } = await import('../shared/ethereum/revealCollectionBlocks.ts');
  const lookup = selectRevealCollectionBlocks(collectionBlocks, release.definition.target);
  const groups = (['painting', 'video', '3d', 'animated'] as const).map(category => ({
    category, collectionBlock: lookupRevealCollectionBlock(lookup, category, 1)!, firstId: 1, lastId: 1, ownerCount: 0,
  }));
  const definition = { ...release.definition, version: 2 as const, groups, batchId: 'media-fixture', deploymentId: 'fixture',
    chainId: 11155111, contractAddress: '0x' + '1'.repeat(40), deploymentBlock: 1, metadataBaseUri: 'https://fixture.test/', originCatalogVersion: release.definition.predecessor.catalogVersion, ordinaryCount: 0 };
  const types: Record<string, string> = { png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', glb: 'model/gltf-binary' };
  const prior = structuredClone(targetCatalog);
  const priorAlt = prior.categories.paintings.variants!.alt;
  priorAlt.assetIds = priorAlt.assetIds!.slice(1);
  function fetchFixture(failure?: 'traits' | 'media' | 'holder' | 'near-limit' | 'alternate'): typeof fetch {
    return async (input, options) => {
      const url = new URL(String(input));
      if (new Headers(options?.headers).has('Range')) {
        assert.equal(options?.method, 'GET');
        assert.equal(new Headers(options?.headers).get('range'), 'bytes=0-32');
        if (failure === 'alternate' && url.pathname.includes('/alt/')) return new Response(null, { status: 404 });
        const origin = new Headers(options.headers).get('Origin')!;
        return new Response('sample', { status: 206, headers: {
          'content-type': failure === 'media' ? 'text/html' : types[url.pathname.split('.').at(-1)!],
          'access-control-allow-origin': origin === 'https://mons.shop' ? '*' :
            failure === 'holder' && origin === 'https://www.vvv.so' ? 'https://mons.shop' : origin,
        } });
      }
      const category = url.pathname.split('/json/')[0].split('/').at(-1)!.replace(/s$/, '');
      const label = groups.find(group => group.category === category)!.collectionBlock;
      return Response.json({ 'collection block': failure === 'traits' ? 'wrong' : label,
        attributes: failure === 'near-limit' ? [{ trait_type: 'text', value: 'x'.repeat(MAX_REVEAL_METADATA_BYTES - 2048) }] : [] });
    };
  }
  const run = (fetcher: typeof fetch, templateJson?: string) =>
    preflightMixedMedia(definition, targetCatalog, fetcher, templateJson, collectionBlocks, prior);
  const evidence = await run(fetchFixture());
  assert.equal(evidence.mediaObjects, 8);
  assert.equal(evidence.traitSources, 4);
  assert.equal(evidence.definitionSha256, mixedAllocationHash(definition));
  assert.ok(Number.isFinite(Date.parse(evidence.checkedAt)));
  await assert.rejects(run(async () => new Response(null, { status: 403 })), /media failed/);
  await assert.rejects(run(fetchFixture('media')), /media failed/);
  await assert.rejects(run(fetchFixture('holder')), /CORS/);
  await assert.rejects(run(fetchFixture('alternate')), /paintings\/alt\//);
  await assert.rejects(run(fetchFixture('traits')), /collection-block-mismatch/);
  assert.equal((await run(fetchFixture('near-limit'))).traitSources, 4);
  await assert.rejects(run(fetchFixture('near-limit'), JSON.stringify({ name: '{{tokenId}}', description: 'x'.repeat(2048) })),
    /Enriched metadata exceeds/);

  const painting = groups[0];
  const render = (templateJson: string) => buildNewRevealedArtwork({
    templateJson, tokenId: '111111', crateTokenId: '116666', category: painting.category, assetId: painting.firstId, catalog: targetCatalog,
    observation: { blockNumber: 0, blockHash: '0x' + '0'.repeat(64), transactionHash: '0x' + '0'.repeat(64) },
  }, lookup!);
  const template = (description: string) => JSON.stringify({ name: '{{tokenId}}', description });
  const padding = MAX_REVEAL_METADATA_BYTES + 1 - Buffer.byteLength(render(template('')).metadataJson);
  const paddedTemplate = template('é'.repeat(Math.floor(padding / 2)) + 'x'.repeat(padding % 2));
  const base = render(paddedTemplate);
  assert.equal(Buffer.byteLength(base.metadataJson), MAX_REVEAL_METADATA_BYTES + 1);
  assert.ok(Buffer.byteLength(base.placeholderJson) <= MAX_REVEAL_METADATA_BYTES);
  const traits = JSON.stringify([{ trait_type: 'collection block', value: painting.collectionBlock }]);
  assert.ok(Buffer.byteLength(applyRevealAttributePayload(base.metadataJson, traits).metadataJson) <= MAX_REVEAL_METADATA_BYTES);
  await assert.rejects(preflightMixedMedia({ ...definition, groups: [painting] }, targetCatalog, fetchFixture(),
    paddedTemplate, collectionBlocks, prior), /Base or placeholder metadata exceeds/);
  await assert.rejects(run(fetchFixture(), JSON.stringify({ name: '{{tokenId}}', image: 'é'.repeat(MAX_REVEAL_METADATA_BYTES / 2) })),
    /Base or placeholder metadata exceeds/);
});

test('v9 preparation and frozen verification require standalone owner artworks and relics', async t => {
  const predecessorSource = await readFile(resolve('releases/111k-catalog-v9/source.json'), 'utf8');
  const withRelics = await readFile(resolve('releases/111k-catalog-v9/original-input.json'), 'utf8');
  const drowee = ownerSupplement.batches.find(batch => batch.id === 'drowee-2026-11-13')!;
  const additions = Object.fromEntries(drowee.artworks.map(art => [
    `animated/${art.assetId}.png`, [art.width, art.height, art.collectionBlock],
  ]));
  const input = { predecessor, predecessorSource, installedCatalogs: [predecessor], collectionBlocks, ownerSupplement,
    policy: { batchId: 'complete-v9-input', deploymentId: 'synthetic', chainId: 11155111, contractAddress: '0x' + '1'.repeat(40),
      metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/synthetic/', deploymentBlock: 1, originCatalogVersion: predecessor.catalogVersion,
      predecessor: definition.predecessor, targetVersion: predecessor.catalogVersion, quotas: [], ordinaryCount: 1 } };
  const withoutRelics = JSON.stringify({ ...JSON.parse(predecessorSource), ...additions });
  assert.throws(() => prepareMixedRelease({ ...input, originalSource: withoutRelics }), /relics/);
  assert.throws(() => prepareMixedRelease({ ...input, originalSource: withRelics }), /historical owner artwork/);
  const originalSource = JSON.stringify({ ...JSON.parse(withRelics), ...additions });
  const prepared = prepareMixedRelease({ ...input, originalSource });
  const directory = await mkdtemp(join(tmpdir(), 'v9-frozen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = { 'manifest.json': JSON.stringify(prepared.targetCatalog), 'predecessor.json': JSON.stringify(predecessor),
    'source.json': prepared.normalizedSource, 'owner-supplement.json': JSON.stringify(ownerSupplement),
    'collection-blocks.json': JSON.stringify(collectionBlocks) };
  await Promise.all(Object.entries(files).map(([name, bytes]) => writeFile(join(directory, name), bytes)));
  for (const [bytes, error] of [[originalSource, null], [withRelics, /historical owner artwork/], [withoutRelics, /relics/]] as const) {
    await writeFile(join(directory, 'definition.json'), JSON.stringify({ ...prepared.definition, sourceSha256: sha256(bytes) }));
    await writeFile(join(directory, 'original-input.json'), bytes);
    if (error) await assert.rejects(readPreparedMixedRelease(directory), error);
    else assert.deepEqual((await readPreparedMixedRelease(directory)).definition, prepared.definition);
  }
});

test('reviewed mixed releases allocate all media types, support pooled quotas, and skip historical owner animations', () => {
  const relics = Object.fromEntries(Object.entries(JSON.parse(source)).filter(([path]) => path.startsWith('relics/')));
  const normalized = (entries: object) => JSON.stringify(entries, null, 2) + '\n';
  const prepare = (args: Parameters<typeof prepareMixedRelease>[0]) => prepareMixedRelease({
    ...args, originalSource: JSON.stringify({ ...JSON.parse(args.originalSource), ...relics }),
  });
  const entry = (label: string) => [100, 100, label];
  const previous: Record<string, (number | string)[]> = {
    'paintings/1.png': entry('original'), 'videos/1.mp4': entry('original'), 'videos/1.webp': entry('original'), '3d/1.png': entry('original'),
  };
  for (let id = 1; id <= 421; id++) previous[`animated/${id}.png`] = entry('original');
  const predecessorSource = JSON.stringify(previous);
  const predecessor = buildRevealAssetCatalog(predecessorSource, { availableEggs: 111_111, catalogVersion: '111k-v11' });
  const descriptor = computeRevealCatalogDescriptor(predecessor);
  const collectionBlocks = buildRevealCollectionBlocks({ source: predecessorSource, frozenSource: predecessorSource, catalog: predecessor });
  const originalSource = JSON.stringify({    ...previous, 'paintings/2.png': entry('new painting'), '3d/2.png': entry('new model'),
    'videos/2.mp4': entry('new video'), 'videos/2.webp': entry('new video'), 'animated/721.png': entry('new GIF'), 'animated/721.gif': entry('new GIF')  });
  const policy = {    batchId: 'synthetic-mixed', deploymentId: 'synthetic', chainId: 11155111, contractAddress: '0x' + '1'.repeat(40),
    metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/synthetic/', deploymentBlock: 1, originCatalogVersion: predecessor.catalogVersion, predecessor: descriptor, targetVersion: '111k-v12',
    quotas: [{ collections: ['new painting', 'new model', 'new video', 'new GIF'], ownerCount: 3 }], ordinaryCount: 1 };
  const input = { policy, originalSource, predecessorSource, predecessor, collectionBlocks, ownerSupplement, installedCatalogs: [predecessor] };
  const mixed = prepare(input);
  const reordered = { manifestSha256: descriptor.manifestSha256, catalogVersion: descriptor.catalogVersion };
  const repeated = prepare({ ...input, policy: { ...policy, predecessor: reordered } });
  assert.equal(mixedAllocationHash(repeated.definition), mixedAllocationHash(mixed.definition));
  const privateRangePolicy = { ...policy, freshEggStart: 1 };
  assert.throws(() => prepare({ ...input, policy: privateRangePolicy }), /Invalid mixed release policy/);
  assert.equal('freshEggStart' in mixed.definition, false);
  assert.deepEqual(mixedAllocationCounts(mixed.definition), { preassignedCount: 3, ordinaryCount: 1, readyCount: 4, futureCount: 1, totalCount: 4 });
  for (const choose of [() => 0, (n: number) => n - 1]) {
    const draw = drawMixedAllocation(mixed.definition, choose);
    assert.equal(draw.owner.length, 3);
    assert.equal(draw.future.length, 1);
    assert.equal(new Set([...draw.owner, ...draw.future].map(row => row.category)).size, 4);
  }
  const later = buildRevealAssetCatalog(normalized({ ...JSON.parse(originalSource), 'paintings/3.png': entry('later') }), {
    availableEggs: 111_111, catalogVersion: '111k-v13'  });
  const currentBlocks = buildRevealCollectionBlocks({    source: normalized({ ...JSON.parse(originalSource), 'paintings/3.png': entry('later') }),
    frozenSource: normalized({ ...JSON.parse(originalSource), 'paintings/3.png': entry('later') }), catalog: later,
    ancestors: [predecessor, mixed.targetCatalog], previous: mixed.collectionBlocks  });
  const retained = prepare({ ...input, installedCatalogs: [predecessor, mixed.targetCatalog, later], collectionBlocks: currentBlocks });
  assert.deepEqual(retained.definition, mixed.definition);
  const headEntries = { ...JSON.parse(originalSource), 'paintings/alt/2.webp': entry('new painting') };
  const headSource = normalized(headEntries);
  const head = buildRevealAssetCatalog(headSource, { availableEggs: 111_111, catalogVersion: '111k-v12' });
  const headBlocks = buildRevealCollectionBlocks({ source: headSource, frozenSource: headSource, catalog: head, ancestors: [predecessor], previous: collectionBlocks });
  const update = { ...input, policy: { ...policy, targetVersion: '111k-v13' }, installedCatalogs: [predecessor, head], installedSource: headSource,
    collectionBlocks: headBlocks };
  const next = { ...headEntries, 'paintings/3.png': entry('later') };
  for (const path of ['paintings/2.png', 'paintings/alt/2.webp']) {
    const resized = { ...next, [path]: [200, 200, 'new painting'] };
    assert.throws(() => prepare({ ...update, originalSource: JSON.stringify(resized) }), /changed existing artwork source/);
  }
  const removed = { ...next };
  delete removed['paintings/alt/2.webp'];
  assert.throws(() => prepare({ ...update, originalSource: JSON.stringify(removed) }), /changed existing artwork source/);
  assert.equal(prepare({ ...update, originalSource: JSON.stringify(next) }).targetCatalog.catalogVersion, '111k-v13');
  const onlyNewAlternate = { ...headEntries, 'paintings/alt/1.webp': entry('original') };
  assert.equal(prepare({ ...update, originalSource: JSON.stringify(onlyNewAlternate) }).targetCatalog.catalogVersion, '111k-v13');
  validateMixedAllocationRelease(mixed.definition, predecessor, mixed.targetCatalog, currentBlocks, ownerSupplement);
  assert.deepEqual(mixed.targetCatalog.categories.animated.count, 422);
  assert.equal(revealCatalogAssetId(mixed.targetCatalog.categories.animated, 422), 721);
  assert.equal(revealCatalogAssetOrdinal(mixed.targetCatalog.categories.animated, 721), 422);
  assert.equal(revealCatalogAssetOrdinal(mixed.targetCatalog.categories.animated, 422), 0);
  assert.match(revealCatalogMedia(mixed.targetCatalog, 'animated', 721).animation_url!, /\.gif$/);
  assert.throws(() => revealCatalogMedia(mixed.targetCatalog, 'animated', 422), /invalid asset ID/);
  assert.throws(() => prepare({ ...input, policy: { ...policy, quotas: [{ ...policy.quotas[0], ownerCount: 5 }] } }), /totals/);
  const future = prepare({ ...input, policy: { ...policy, quotas: [], ordinaryCount: 0 } });
  assert.equal(mixedAllocationCounts(future.definition).readyCount, 0);
  assert.equal(mixedAllocationCounts(future.definition).futureCount, 4);
  const allOwner = prepare({ ...input, policy: { ...policy, quotas: [{ ...policy.quotas[0], ownerCount: 4 }] } });
  assert.equal(mixedAllocationCounts(allOwner.definition).futureCount, 0);
  const ordinary = prepare({ ...input, originalSource: predecessorSource, policy: { ...policy, targetVersion: descriptor.catalogVersion, quotas: [] } });
  assert.deepEqual(ordinary.definition.target, descriptor);
  assert.deepEqual(mixedAllocationCounts(ordinary.definition), { preassignedCount: 0, ordinaryCount: 1, readyCount: 1, futureCount: 0, totalCount: 0 });
});
