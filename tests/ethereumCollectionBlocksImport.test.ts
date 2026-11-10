import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildRevealCollectionBlocks, importRevealCollectionBlocks } from '../scripts/ethereum-metadata/collectionBlocks.ts';
import { buildRevealAssetCatalog, importRevealAssets } from '../scripts/ethereum-metadata/assetImport.ts';
import { parseAssetCliArgs } from '../scripts/ethereum-metadata/assetCli.ts';
import { computeRevealCatalogDescriptor } from '../shared/ethereum/revealAssetCatalog.ts';
import { lookupRevealCollectionBlock, selectRevealCollectionBlocks, validateRevealCollectionBlocks } from '../shared/ethereum/revealCollectionBlocks.ts';

const ASSETS = 'scripts/ethereum-metadata/reveal-assets/111k_devnet';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sample = (): Record<string, [number, number, string]> => ({
  '3d/1.png': [2048, 2048, 'Knives'], '3d/2.png': [2048, 2048, 'Guns'],
  'animated/1.png': [932, 1006, 'gifworks'],
  'paintings/1.png': [1864, 2012, ' First block '], 'paintings/2.png': [1864, 2012, ' First block '],
  'paintings/3.png': [1864, 2012, 'second'], 'paintings/4.png': [1864, 2012, ' First block '],
  'paintings/alt/1.webp': [932, 1006, ' First block '],
  'videos/1.mp4': [854, 480, 'film clips'], 'videos/1.webp': [854, 480, 'film clips'],
});
const dimensions = (source = sample()) => Object.fromEntries(Object.entries(source).map(([path, value]) => [path, value.slice(0, 2)]));
const catalog = (source: object, catalogVersion = '111k-v5') => buildRevealAssetCatalog(JSON.stringify(source), { catalogVersion, availableEggs: 111111 });
const build = (source = sample()) => buildRevealCollectionBlocks({ source: JSON.stringify(source),
  frozenSource: JSON.stringify(dimensions()), catalog: catalog(dimensions()) });

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), '111k-collection-blocks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rootDirectory = join(directory, 'repo');
  const sourcePath = join(directory, '111k.json');
  await writeFile(sourcePath, JSON.stringify(dimensions()));
  await importRevealAssets({ rootDirectory, sourcePath, catalogVersion: '111k-v5', availableEggs: 111111 });
  await writeFile(sourcePath, JSON.stringify(sample()));
  return { rootDirectory, sourcePath };
}

async function snapshot(directory: string): Promise<Record<string, { sha256: string; mtime: string }>> {
  const result: Record<string, { sha256: string; mtime: string }> = {};
  async function walk(path: string, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(path, entry.name), `${prefix}${entry.name}/`);
      else {
        const file = join(path, entry.name);
        result[`${prefix}${entry.name}`] = { sha256: digest(await readFile(file)), mtime: String((await stat(file, { bigint: true })).mtimeNs) };
      }
    }
  }
  await walk(directory);
  return result;
}

test('collection block generation preserves labels and deterministically compresses adjacent ranges', () => {
  const first = build();
  assert.deepEqual(build(), first);
  assert.deepEqual(first.ranges.painting, [[2, ' First block '], [3, 'second'], [4, ' First block ']]);
  assert.deepEqual(first.ranges['3d'], [[1, 'Knives'], [2, 'Guns']]);
  assert.deepEqual(first.ranges.video, [[1, 'film clips']]);
  assert.deepEqual(first.ranges.animated, [[1, 'gifworks']]);
  assert.equal(first.source.sha256, digest(JSON.stringify(sample())));
  const lookup = selectRevealCollectionBlocks(first, first.catalogs[0]);
  for (const category of ['painting', 'video', '3d', 'animated'] as const) {
    let previousEnd = 0;
    for (const [end, label] of first.ranges[category]) {
      assert.equal(lookupRevealCollectionBlock(lookup, category, previousEnd + 1), label);
      assert.equal(lookupRevealCollectionBlock(lookup, category, end), label);
      previousEnd = end;
    }
    assert.equal(lookupRevealCollectionBlock(lookup, category, previousEnd + 1), null);
  }
});

test('the saved manifest reproduces all collection blocks and every real range boundary', async () => {
  const source = JSON.parse(await readFile(new URL(`../${ASSETS}/collection-blocks.source.json`, import.meta.url), 'utf8')) as Record<string, [number, number, string]>;
  const value: unknown = JSON.parse(await readFile(new URL(`../${ASSETS}/collection-blocks.json`, import.meta.url), 'utf8'));
  validateRevealCollectionBlocks(value);
  assert.equal(Object.values(value.ranges).reduce((sum, ranges) => sum + ranges.length, 0), 20);
  const lookup = selectRevealCollectionBlocks(value, value.catalogs.at(-1)!);
  let count = 0;
  for (const [category, family, extension] of [['painting', 'paintings', 'png'], ['video', 'videos', 'mp4'], ['3d', '3d', 'png'], ['animated', 'animated', 'png']] as const) {
    for (let id = 1; id <= lookup!.counts[category]; id++) {
      assert.equal(lookupRevealCollectionBlock(lookup, category, id), source[`${family}/${id}.${extension}`][2]);
      count++;
    }
  }
  assert.equal(count, 50607);
});

test('generation rejects incomplete, malformed and conflicting labels or changed dimensions', () => {
  const mutations: Array<(source: Record<string, unknown>) => void> = [
    source => { source['3d/1.png'] = [2048, 2048]; },
    source => { source['3d/1.png'] = [2048, 2048, ' ']; },
    source => { source['3d/1.png'] = [2048, 2048, 8]; },
    source => { source['3d/1.png'] = [4096, 4096, 'Knives']; },
    source => { delete source['3d/2.png']; },
    source => { source['paintings/alt/1.webp'] = [932, 1006, 'Wrong']; },
    source => { source['videos/1.webp'] = [854, 480, 'Wrong']; },
  ];
  for (const mutate of mutations) {
    const source = sample();
    mutate(source);
    assert.throws(() => build(source), /collection block|Collection block|source|Source|dimensions|media/);
  }
});

test('catalog bindings retain earlier versions and labels across append-only additions', () => {
  const previous = build();
  const source = sample();
  source['paintings/5.png'] = [1864, 2012, 'new block'];
  const nextCatalog = catalog(source, '111k-v6');
  const next = buildRevealCollectionBlocks({ source: JSON.stringify(source), frozenSource: JSON.stringify(source), catalog: nextCatalog, previous });
  assert.deepEqual(next.catalogs.map(value => value.catalogVersion), ['111k-v5', '111k-v6']);
  assert.deepEqual(next.catalogs[0], previous.catalogs[0]);
  assert.equal(lookupRevealCollectionBlock(selectRevealCollectionBlocks(next, previous.catalogs[0]), 'painting', 5), null);
  assert.equal(lookupRevealCollectionBlock(selectRevealCollectionBlocks(next, computeRevealCatalogDescriptor(nextCatalog)), 'painting', 5), 'new block');
  source['3d/1.png'][2] = 'changed';
  assert.throws(() => buildRevealCollectionBlocks({ source: JSON.stringify(source), frozenSource: JSON.stringify(source),
    catalog: catalog(source, '111k-v6'), previous }), /Recorded collection block changed/);
});

test('generation rejects conflicting identities and incompatible ancestor media', () => {
  const previous = build();
  const changedCatalog = catalog(sample());
  assert.throws(() => buildRevealCollectionBlocks({ source: JSON.stringify(sample()), frozenSource: JSON.stringify(sample()),
    catalog: changedCatalog, previous }), /catalog identity changed/);
  const ancestorSource = dimensions();
  ancestorSource['3d/1.png'] = [2048, 1024];
  assert.throws(() => buildRevealCollectionBlocks({ source: JSON.stringify(sample()), frozenSource: JSON.stringify(dimensions()),
    catalog: catalog(dimensions()), ancestors: [catalog(ancestorSource, '111k-v4')] }), /Incompatible collection block catalog/);
});

test('import saves an independent source, leaves frozen assets intact, and check is read-only', async t => {
  const options = await fixture(t);
  const before = await snapshot(options.rootDirectory);
  assert.equal((await importRevealCollectionBlocks(options)).status, 'updated');
  const after = await snapshot(options.rootDirectory);
  for (const [path, value] of Object.entries(before)) assert.deepEqual(after[path], value, path);
  assert.equal(await readFile(join(options.rootDirectory, ASSETS, 'collection-blocks.source.json'), 'utf8'), JSON.stringify(sample()));
  await rm(options.sourcePath);
  assert.equal((await importRevealCollectionBlocks({ rootDirectory: options.rootDirectory, check: true })).status, 'checked');
  assert.deepEqual(await snapshot(options.rootDirectory), after);
  assert.equal((await importRevealCollectionBlocks({ rootDirectory: options.rootDirectory })).status, 'unchanged');
});

test('check rejects a promoted catalog until its collection block binding is regenerated', async t => {
  const options = await fixture(t);
  await importRevealCollectionBlocks(options);
  await writeFile(options.sourcePath, JSON.stringify(dimensions()));
  await importRevealAssets({ ...options, catalogVersion: '111k-v6', availableEggs: 111111 });
  const before = await snapshot(options.rootDirectory);
  await assert.rejects(importRevealCollectionBlocks({ rootDirectory: options.rootDirectory, check: true }), /outputs are stale/);
  assert.deepEqual(await snapshot(options.rootDirectory), before);
  assert.equal((await importRevealCollectionBlocks({ rootDirectory: options.rootDirectory })).status, 'updated');
  assert.equal((await importRevealCollectionBlocks({ rootDirectory: options.rootDirectory, check: true })).status, 'checked');
});

test('collection block import recovers a partially committed pair without changing frozen assets', async t => {
  const options = await fixture(t);
  const destination = join(options.rootDirectory, ASSETS, 'collection-blocks.source.json');
  const script = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
    const rename=fs.rename; fs.rename=async (...args)=>{await rename(...args);if(String(args[1])===${JSON.stringify(destination)})process.kill(process.pid,'SIGKILL');};
    syncBuiltinESMExports();const {importRevealCollectionBlocks}=await import(${JSON.stringify(new URL('../scripts/ethereum-metadata/collectionBlocks.ts', import.meta.url).href)});
    await importRevealCollectionBlocks(${JSON.stringify(options)});`;
  const processResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(processResult.signal, 'SIGKILL', processResult.stderr);
  const interrupted = await snapshot(options.rootDirectory);
  await assert.rejects(importRevealCollectionBlocks({ ...options, check: true }), /Interrupted/);
  assert.deepEqual(await snapshot(options.rootDirectory), interrupted);
  assert.equal((await importRevealCollectionBlocks(options)).status, 'updated');
  assert.equal((await importRevealCollectionBlocks({ rootDirectory: options.rootDirectory, check: true })).status, 'checked');
});

test('collection-blocks CLI accepts its own source/check options and rejects allocation changes', () => {
  assert.deepEqual(parseAssetCliArgs(['collection-blocks', '--source', 'manifest.json', '--check']), {
    command: 'collection-blocks', sourcePath: resolve('manifest.json'), check: true,
  });
  assert.deepEqual(parseAssetCliArgs(['collection-blocks']), { command: 'collection-blocks' });
  for (const option of ['--catalog-version', '--available-eggs']) {
    assert.throws(() => parseAssetCliArgs(['collection-blocks', option, option === '--catalog-version' ? '111k-v8' : '111111']), /allocation options/);
  }
});
