import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { buildRevealAssetCatalog, importRevealAssets } from '../scripts/ethereum-metadata/assetImport.ts';
import { parseAssetCliArgs } from '../scripts/ethereum-metadata/assetCli.ts';
import { revealCatalogMedia, validateRevealAssetCatalog } from '../shared/ethereum/revealAssetCatalog.ts';

const assetDirectory = 'scripts/ethereum-metadata/reveal-assets/111k_devnet';
const descriptorPath = 'shared/ethereum/revealCatalog.json';
const sourcePath = new URL(`../${assetDirectory}/source.json`, import.meta.url);
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sample = (): Record<string, unknown> => ({
  '3d/1.png': [2048, 2048],
  'animated/1.png': [932, 1006],
  'paintings/1.png': [1864, 2012],
  'paintings/alt/1.webp': [1297, 1400],
  'videos/1.mp4': [854, 480],
  'videos/1.webp': [854, 480],
});
const build = (source = JSON.stringify(sample())) => buildRevealAssetCatalog(source, {
  catalogVersion: '111k-v5', availableEggs: 111111,
});

async function snapshot(directory: string): Promise<Record<string, { sha256: string; mtime: string }>> {
  const files: Record<string, { sha256: string; mtime: string }> = {};
  async function visit(path: string, prefix: string) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
      const relative = `${prefix}${entry.name}`;
      const filename = join(path, entry.name);
      if (entry.isDirectory()) await visit(filename, `${relative}/`);
      else files[relative] = { sha256: digest(await readFile(filename)), mtime: String((await stat(filename, { bigint: true })).mtimeNs) };
    }
  }
  await visit(directory, '');
  return files;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), '111k-asset-import-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const inputPath = join(directory, 'dimensions.json');
  const bytes = `${JSON.stringify(sample(), null, 2)}\n`;
  await writeFile(inputPath, bytes);
  const rootDirectory = join(directory, 'output');
  return { directory, rootDirectory, inputPath, bytes,
    options: { rootDirectory, sourcePath: inputPath, catalogVersion: '111k-v5', availableEggs: 111111 } };
}

function interruptImport(options: Parameters<typeof importRevealAssets>[0], destination: string) {
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.rename;
    fs.rename = async (...args) => {
      await rename(...args);
      if (String(args[1]) === ${JSON.stringify(destination)}) process.kill(process.pid, 'SIGKILL');
    };
    syncBuiltinESMExports();
    const { importRevealAssets } = await import(${JSON.stringify(new URL('../scripts/ethereum-metadata/assetImport.ts', import.meta.url).href)});
    await importRevealAssets(${JSON.stringify(options)});
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.signal, 'SIGKILL', `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
}

test('saved source imports the final five categories, exact ratios and balanced egg supply', async () => {
  const source = await readFile(sourcePath);
  const catalog = buildRevealAssetCatalog(source, { catalogVersion: '111k-v5' });
  validateRevealAssetCatalog(catalog);
  assert.equal(catalog.version, 2);
  assert.equal(catalog.catalogVersion, '111k-v5');
  assert.equal(Object.keys(JSON.parse(source.toString('utf8'))).length, 65517);
  assert.deepEqual(catalog.source, { filename: '111k.json', sha256: digest(source) });
  assert.deepEqual(catalog.importSettings, { availableEggs: 76700, eggAspectRatio: [1, 1] });
  assert.deepEqual(Object.fromEntries(Object.entries(catalog.categories).map(([category, value]) => [category, value.count])), {
    eggs: 76642, paintings: 30990, videos: 58, '3d': 3000, animated: 421, receipts: 85556,
  });
  assert.equal(catalog.categories.eggs.availableCount! - catalog.categories.eggs.count, 58);
  assert.equal(catalog.artworkCount, 111111);
  assert.deepEqual(revealCatalogMedia(catalog, 'painting', 1), {
    image: 'https://cdn.lil.org/nft/111k/paintings/1.png', aspectRatio: { width: 466, height: 503 },
  });
  assert.deepEqual(revealCatalogMedia(catalog, '3d', 3000), {
    image: 'https://cdn.lil.org/nft/111k/3d/3000.png', animation_url: 'https://cdn.lil.org/nft/111k/3d/3000.glb',
    aspectRatio: { width: 1, height: 1 },
  });
  assert.deepEqual(revealCatalogMedia(catalog, 'animated', 421), {
    image: 'https://cdn.lil.org/nft/111k/animated/421.png', animation_url: 'https://cdn.lil.org/nft/111k/animated/421.mp4',
    aspectRatio: { width: 466, height: 503 },
  });
  for (const id of [1, 40, 46, 58]) assert.deepEqual(revealCatalogMedia(catalog, 'video', id).aspectRatio, { width: 16, height: 9 });
  for (const id of [41, 42, 43, 44]) assert.deepEqual(revealCatalogMedia(catalog, 'video', id).aspectRatio, { width: 427, height: 240 });
  assert.deepEqual(revealCatalogMedia(catalog, 'video', 45).aspectRatio, { width: 54, height: 31 });
  assert.deepEqual(catalog.categories.receipts, { count: 85556, pathTemplate: 'placeholder.png', aspectRatio: [466, 503] });
  assert.deepEqual(buildRevealAssetCatalog(source, { catalogVersion: '111k-v5' }), catalog);
});

test('source ordering cannot change asset IDs or ratio palette ordering, and variants do not add artworks', () => {
  const entries = sample();
  entries['paintings/2.png'] = [932, 1111];
  entries['paintings/alt/2.webp'] = [932, 1111];
  const forward = build(JSON.stringify(entries));
  const reversed = build(JSON.stringify(Object.fromEntries(Object.entries(entries).reverse())));
  assert.deepEqual(forward.categories, reversed.categories);
  assert.notEqual(forward.source.sha256, reversed.source.sha256);
  assert.equal(forward.categories.paintings.count, 2);
  assert.equal(forward.categories.videos.count, 1);
  assert.equal(forward.categories.eggs.count, 111106);
  assert.deepEqual(forward.categories.paintings.aspectRatioPalette, [[466, 503], [932, 1111]]);
  assert.deepEqual(forward.categories.paintings.aspectRatioIndexById, [0, 1]);
  assert.deepEqual(forward.categories.paintings.variants?.alt.aspectRatioPalette, [[932, 1111], [1297, 1400]]);
  assert.deepEqual(forward.categories.paintings.variants?.alt.aspectRatioIndexById, [1, 0]);
});

test('legacy receipt catalog imports advance the revision without changing artwork allocation', async t => {
  const f = await fixture(t);
  const initial = await importRevealAssets(f.options);
  const legacy = structuredClone(initial.manifest);
  legacy.catalogVersion = '111k-v4';
  legacy.categories.receipts = { count: 85556, pathTemplate: 'receipts/{id}.webp',
    baseUrl: 'https://legacy.example/111k/', aspectRatio: [1, 1] };
  validateRevealAssetCatalog(legacy);
  await writeFile(join(f.rootDirectory, assetDirectory, 'manifest.json'), JSON.stringify(legacy));
  await writeFile(join(f.rootDirectory, descriptorPath), JSON.stringify({ catalogVersion: legacy.catalogVersion,
    manifestSha256: digest(JSON.stringify(legacy)) }));
  const imported = await importRevealAssets(f.options);
  assert.equal(imported.status, 'updated');
  assert.equal(imported.manifest.catalogVersion, '111k-v5');
  assert.deepEqual(imported.manifest, initial.manifest);
  legacy.catalogVersion = '111k-v5';
  assert.throws(() => validateRevealAssetCatalog(legacy), /invalid receipts media/);
});

test('egg balancing rejects insufficient availability and invalid catalog revisions', () => {
  const source = JSON.stringify(sample());
  for (const availableEggs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 111106]) {
    assert.throws(() => buildRevealAssetCatalog(source, { catalogVersion: '111k-v5', availableEggs }), /eggs|Egg allocation/);
  }
  assert.equal(buildRevealAssetCatalog(source, { catalogVersion: '111k-v5', availableEggs: 111107 }).categories.eggs.count, 111107);
  for (const catalogVersion of ['', 'v4', '111k-v0', '111k-v04', '111k-v5.5']) {
    assert.throws(() => buildRevealAssetCatalog(source, { catalogVersion, availableEggs: 111111 }), /Catalog version/);
  }
});

test('a complete non-egg inventory allocates zero eggs and excess artwork cannot overwrite it', async t => {
  const f = await fixture(t);
  const source = sample();
  for (let id = 2; id <= 111108; id++) source[`3d/${id}.png`] = [2048, 2048];
  await writeFile(f.inputPath, JSON.stringify(source));
  const imported = await importRevealAssets(f.options);
  assert.equal(imported.manifest.categories.eggs.count, 0);
  assert.equal(imported.manifest.categories['3d'].count, 111108);
  assert.throws(() => revealCatalogMedia(imported.manifest, 'egg', 1), /Invalid reveal asset/);
  const reference = JSON.parse(await readFile(join(f.rootDirectory, assetDirectory, 'egg.template.json'), 'utf8'));
  assert.equal(reference.name, 'Egg #{{assetId}}');
  assert.equal(reference.image, 'https://cdn.lil.org/nft/111k/eggs/{{assetId}}.png');
  const before = await snapshot(f.rootDirectory);
  source['3d/111109.png'] = [2048, 2048];
  await writeFile(f.inputPath, JSON.stringify(source));
  await assert.rejects(importRevealAssets({ ...f.options, catalogVersion: '111k-v6' }), /Egg allocation/);
  assert.deepEqual(await snapshot(f.rootDirectory), before);
});

test('source parsing rejects malformed dimensions, noncanonical paths, gaps and unmatched media', () => {
  for (const dimensions of [null, '932x1006', [], [1], [1, 2, 3], [0, 1], [-1, 1], [1.5, 2], ['1', 2], [Number.MAX_SAFE_INTEGER + 1, 2]]) {
    assert.throws(() => build(JSON.stringify({ ...sample(), '3d/1.png': dimensions })), /dimensions/);
  }
  for (const path of ['3d/01.png', '3d/0.png', '3d/9007199254740992.png', '3d/1.glb', '3d/1.PNG',
    'paintings/../1.png', '/paintings/1.png', 'https://cdn.lil.org/nft/111k/paintings/1.png', 'eggs/1.png']) {
    assert.throws(() => build(JSON.stringify({ ...sample(), [path]: [1, 1] })), /path|asset ID/i);
  }
  for (const source of ['[]', 'null', '{}', '{broken', '{"3d/1.png":[1,1],"3d/1.png":[2,2]}']) assert.throws(() => build(source));
  const gap = { ...sample(), '3d/3.png': [1, 1] };
  assert.throws(() => build(JSON.stringify(gap)), /contiguous/);
  assert.throws(() => build(JSON.stringify({ ...sample(), 'paintings/alt/2.webp': [1, 1] })), /alternate IDs/);
  assert.throws(() => build(JSON.stringify({ ...sample(), 'videos/2.mp4': [1, 1] })), /paired/);
  assert.throws(() => build(JSON.stringify({ ...sample(), 'videos/1.webp': [1280, 720] })), /dimensions must match/);
});

test('import writes a complete reproducible bundle and check mode never rewrites it', async t => {
  const f = await fixture(t);
  const result = await importRevealAssets(f.options);
  assert.equal(result.status, 'updated');
  assert.equal(result.changedFiles.length, 8);
  const files = await snapshot(f.rootDirectory);
  assert.deepEqual(Object.keys(files).sort(), [
    '3d.template.json', 'animated.template.json', 'egg.template.json', 'manifest.json', 'painting.template.json', 'source.json', 'video.template.json',
  ].map(name => `${assetDirectory}/${name}`).concat(descriptorPath).sort());
  assert.equal(await readFile(join(f.rootDirectory, assetDirectory, 'source.json'), 'utf8'), f.bytes);
  assert.deepEqual(JSON.parse(await readFile(join(f.rootDirectory, descriptorPath), 'utf8')), result.descriptor);
  assert.equal(result.descriptor.manifestSha256, digest(JSON.stringify(result.manifest)));
  assert.equal((await importRevealAssets(f.options)).status, 'unchanged');
  const checked = await importRevealAssets({ rootDirectory: f.rootDirectory, check: true });
  assert.equal(checked.status, 'checked');
  assert.deepEqual(checked.changedFiles, []);
  assert.deepEqual(await snapshot(f.rootDirectory), files);
  const reference = JSON.parse(await readFile(join(f.rootDirectory, assetDirectory, 'video.template.json'), 'utf8'));
  assert.equal(reference.image, 'https://cdn.lil.org/nft/111k/videos/{{assetId}}.webp');
  assert.equal(reference.animation_url, 'https://cdn.lil.org/nft/111k/videos/{{assetId}}.mp4');
  assert.deepEqual(reference.aspectRatio, { width: 427, height: 240 });
});

test('check mode on a fresh destination and malformed source leave all outputs untouched', async t => {
  const f = await fixture(t);
  await assert.rejects(importRevealAssets({ ...f.options, check: true }), /stale/);
  assert.deepEqual(await snapshot(f.rootDirectory), {});
  await importRevealAssets(f.options);
  const before = await snapshot(f.rootDirectory);
  for (const source of [JSON.stringify({ ...sample(), '3d/1.png': [0, 1] }),
    JSON.stringify({ ...sample(), '3d/3.png': [1, 1] }),
    JSON.stringify({ ...sample(), 'videos/2.webp': [1, 1] }), '[]']) {
    await writeFile(f.inputPath, source);
    await assert.rejects(importRevealAssets({ ...f.options, catalogVersion: '111k-v6' }));
    assert.deepEqual(await snapshot(f.rootDirectory), before);
  }
});

test('source changes require a new catalog revision and older versions cannot overwrite it', async t => {
  const f = await fixture(t);
  await importRevealAssets(f.options);
  const before = await snapshot(f.rootDirectory);
  const changed = { ...sample(), '3d/1.png': [2048, 1024] };
  await writeFile(f.inputPath, JSON.stringify(changed));
  await assert.rejects(importRevealAssets(f.options), /higher catalog version/);
  assert.deepEqual(await snapshot(f.rootDirectory), before);
  const next = await importRevealAssets({ ...f.options, catalogVersion: '111k-v6' });
  assert.equal(next.manifest.catalogVersion, '111k-v6');
  assert.deepEqual(revealCatalogMedia(next.manifest, '3d', 1).aspectRatio, { width: 2, height: 1 });
  const after = await snapshot(f.rootDirectory);
  await assert.rejects(importRevealAssets(f.options), /cannot decrease/);
  assert.deepEqual(await snapshot(f.rootDirectory), after);
  assert.equal((await importRevealAssets({ rootDirectory: f.rootDirectory, check: true })).status, 'checked');
});

test('interrupted imports and interrupted recovery roll back before retrying, while check mode never writes', async t => {
  const f = await fixture(t);
  await importRevealAssets(f.options);
  await writeFile(f.inputPath, JSON.stringify({ ...sample(), '3d/1.png': [2048, 1024] }));
  const options = { ...f.options, catalogVersion: '111k-v6' };
  const manifestPath = join(f.rootDirectory, assetDirectory, 'manifest.json');
  interruptImport(options, manifestPath);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).catalogVersion, '111k-v6');
  assert.equal(JSON.parse(await readFile(join(f.rootDirectory, descriptorPath), 'utf8')).catalogVersion, '111k-v5');
  const interrupted = await snapshot(f.rootDirectory);
  await assert.rejects(importRevealAssets({ ...options, check: true }), /Interrupted asset import/);
  assert.deepEqual(await snapshot(f.rootDirectory), interrupted);
  interruptImport(options, manifestPath);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).catalogVersion, '111k-v5');
  const retried = await importRevealAssets(options);
  assert.equal(retried.manifest.catalogVersion, '111k-v6');
  assert.deepEqual(revealCatalogMedia(retried.manifest, '3d', 1).aspectRatio, { width: 2, height: 1 });
  assert.equal((await importRevealAssets({ rootDirectory: f.rootDirectory, check: true })).status, 'checked');
  await assert.rejects(readFile(join(f.rootDirectory, '.cache/111k-assets/recovery.json')), { code: 'ENOENT' });
});

test('recovery preserves intervening edits and allows a higher revision after they are restored', async t => {
  const f = await fixture(t);
  await importRevealAssets(f.options);
  await writeFile(f.inputPath, JSON.stringify({ ...sample(), '3d/1.png': [2048, 1024] }));
  const manifestPath = join(f.rootDirectory, assetDirectory, 'manifest.json');
  interruptImport({ ...f.options, catalogVersion: '111k-v6' }, manifestPath);
  const interruptedManifest = await readFile(manifestPath);
  await writeFile(manifestPath, 'manual edit');
  const before = Object.fromEntries(Object.entries(await snapshot(f.rootDirectory))
    .filter(([path]) => !path.startsWith('.111k-assets.lock/')));
  await assert.rejects(importRevealAssets({ ...f.options, catalogVersion: '111k-v6' }), /changed since interrupted import/);
  assert.deepEqual(await snapshot(f.rootDirectory), before);
  await writeFile(manifestPath, interruptedManifest);
  const retried = await importRevealAssets({ ...f.options, catalogVersion: '111k-v6' });
  assert.equal(retried.manifest.catalogVersion, '111k-v6');
  assert.equal((await importRevealAssets({ rootDirectory: f.rootDirectory, check: true })).status, 'checked');
});

test('check detects changes to saved source, catalog, descriptor or reference metadata without writing', async t => {
  const f = await fixture(t);
  await importRevealAssets(f.options);
  const mutations: Array<[string, (bytes: string) => string]> = [
    [`${assetDirectory}/source.json`, bytes => `${bytes}\n`],
    [`${assetDirectory}/manifest.json`, bytes => JSON.stringify({ ...JSON.parse(bytes), baseUrl: 'https://wrong.example/' })],
    [descriptorPath, bytes => JSON.stringify({ ...JSON.parse(bytes), manifestSha256: '0'.repeat(64) })],
    [`${assetDirectory}/painting.template.json`, bytes => bytes.replace('paintings/', 'wrong/')],
  ];
  for (const [relative, change] of mutations) {
    const path = join(f.rootDirectory, relative);
    const original = await readFile(path, 'utf8');
    await writeFile(path, change(original));
    const before = await snapshot(f.rootDirectory);
    await assert.rejects(importRevealAssets({ rootDirectory: f.rootDirectory, check: true }), /stale|higher catalog version|descriptor/i);
    assert.deepEqual(await snapshot(f.rootDirectory), before);
    await writeFile(path, original);
  }
});

test('malformed saved descriptors fail before any output is changed', async t => {
  const f = await fixture(t);
  await importRevealAssets(f.options);
  const path = join(f.rootDirectory, descriptorPath);
  for (const descriptor of [null, [], {}, { catalogVersion: '111k-v5' },
    { catalogVersion: 'invalid', manifestSha256: '0'.repeat(64) },
    { catalogVersion: '111k-v5', manifestSha256: 'not-a-hash' },
    { catalogVersion: '111k-v5', manifestSha256: '0'.repeat(64), extra: true }]) {
    await writeFile(path, JSON.stringify(descriptor));
    const before = await snapshot(f.rootDirectory);
    await assert.rejects(importRevealAssets({ ...f.options, check: true }), /descriptor|Catalog version/i);
    assert.deepEqual(await snapshot(f.rootDirectory), before);
  }
});

test('a higher requested revision cannot bypass an inconsistent saved catalog and descriptor', async t => {
  const f = await fixture(t);
  await importRevealAssets(f.options);
  const mutations: Array<[string, (value: Record<string, unknown>) => Record<string, unknown>]> = [
    [`${assetDirectory}/manifest.json`, value => ({ ...value, catalogVersion: '111k-v8' })],
    [`${assetDirectory}/manifest.json`, value => ({ ...value, baseUrl: 'https://changed.example/' })],
    [descriptorPath, value => ({ ...value, catalogVersion: '111k-v8' })],
    [descriptorPath, value => ({ ...value, manifestSha256: '0'.repeat(64) })],
  ];
  for (const [relative, change] of mutations) {
    const path = join(f.rootDirectory, relative);
    const original = await readFile(path, 'utf8');
    await writeFile(path, JSON.stringify(change(JSON.parse(original))));
    const before = await snapshot(f.rootDirectory);
    await assert.rejects(importRevealAssets({ ...f.options, catalogVersion: '111k-v9' }), /stale|inconsistent|checksum/i);
    assert.deepEqual(await snapshot(f.rootDirectory), before);
    await writeFile(path, original);
  }
});

test('baseline artwork template changes require a revision and retain only the selected type', async t => {
  const f = await fixture(t);
  await importRevealAssets(f.options);
  const templatePath = join(f.directory, 'artwork.json');
  await writeFile(templatePath, JSON.stringify({ name: '{{tokenId}}', description: 'Shared description', image: 'https://example.com/placeholder.png',
    attributes: [{ trait_type: 'type', value: 'painting' }, { trait_type: 'series', value: '111K' }] }));
  const before = await snapshot(f.rootDirectory);
  await assert.rejects(importRevealAssets({ ...f.options, artworkTemplatePath: templatePath }), /higher catalog version/);
  assert.deepEqual(await snapshot(f.rootDirectory), before);
  await importRevealAssets({ ...f.options, artworkTemplatePath: templatePath, catalogVersion: '111k-v6' });
  for (const category of ['egg', 'painting', 'video', '3d', 'animated']) {
    const reference = JSON.parse(await readFile(join(f.rootDirectory, assetDirectory, `${category}.template.json`), 'utf8'));
    assert.equal(reference.name, category === 'egg' ? 'Egg #{{assetId}}' : '{{tokenId}}');
    assert.equal(reference.description, 'Shared description');
    assert.deepEqual(reference.attributes, [{ trait_type: 'series', value: '111K' }, { trait_type: 'type', value: category }]);
  }
});

test('shared validation binds the descriptor to catalog bytes and rejects malformed ratios and counts', () => {
  const catalog = build();
  const descriptor = { catalogVersion: catalog.catalogVersion, manifestSha256: digest(JSON.stringify(catalog)) };
  validateRevealAssetCatalog(catalog, descriptor);
  for (const invalid of [null, [], {}, { ...descriptor, catalogVersion: '111k-v3' },
    { ...descriptor, manifestSha256: '0'.repeat(64) }, { ...descriptor, extra: true }]) {
    assert.throws(() => validateRevealAssetCatalog(catalog, invalid), /Invalid reveal asset catalog/);
  }
  const changed = structuredClone(catalog);
  changed.categories.eggs.count--;
  assert.throws(() => validateRevealAssetCatalog(changed), /counts must total/);
  changed.categories.eggs.count++;
  changed.baseUrl = 'http://cdn.lil.org/nft/111k/';
  assert.throws(() => validateRevealAssetCatalog(changed), /Invalid reveal asset catalog/);
  changed.baseUrl = catalog.baseUrl;
  changed.categories.paintings.aspectRatioIndexById = [99];
  assert.throws(() => validateRevealAssetCatalog(changed), /Invalid reveal asset catalog/);
});

test('asset CLI accepts explicit imports and rejects ambiguous or malformed options', () => {
  assert.deepEqual(parseAssetCliArgs(['import', '--source', 'input.json', '--catalog-version', '111k-v5', '--available-eggs', '76700', '--check']), {
    sourcePath: resolve('input.json'), catalogVersion: '111k-v5', availableEggs: 76700, check: true,
  });
  assert.deepEqual(parseAssetCliArgs(['import', '--check']), { check: true });
  assert.equal(parseAssetCliArgs(['--help']), null);
  for (const args of [[], ['generate'], ['import', 'extra'], ['import', '--source', ' '], ['import', '--catalog-version', '111k-v0'],
    ['import', '--available-eggs', '0'], ['import', '--available-eggs', '1.5'], ['import', '--available-eggs', '9007199254740992'], ['import', '--unknown']]) {
    assert.throws(() => parseAssetCliArgs(args));
  }
});
