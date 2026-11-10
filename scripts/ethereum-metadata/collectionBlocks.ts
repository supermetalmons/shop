import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRevealAssetCatalog, withRevealAssetImportLock } from './assetImport.ts';
import { computeRevealCatalogDescriptor, revealCatalogMedia, validateRevealAssetCatalog,
  REVEAL_ASSET_FAMILIES, type RevealAssetCatalog } from '../../shared/ethereum/revealAssetCatalog.ts';
import { lookupRevealCollectionBlock, selectRevealCollectionBlocks, validateRevealCollectionBlocks,
  type RevealCollectionBlocks } from '../../shared/ethereum/revealCollectionBlocks.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ASSETS = 'scripts/ethereum-metadata/reveal-assets/111k_devnet';
const FILES = ['collection-blocks.source.json', 'collection-blocks.json'] as const;
const STATE = '.cache/111k-collection-blocks';
const CATEGORIES = ['painting', 'video', '3d', 'animated'] as const;
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Source = Record<string, [number, number, string?]>;

export type RevealCollectionBlocksImportOptions = { rootDirectory?: string; sourcePath?: string; check?: boolean };

function sourceEntries(bytes: string | Uint8Array): Source {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Source;
}

function compatible(catalog: RevealAssetCatalog, current: RevealAssetCatalog): boolean {
  return CATEGORIES.every(category => {
    const count = catalog.categories[REVEAL_ASSET_FAMILIES[category]].count;
    if (count > current.categories[REVEAL_ASSET_FAMILIES[category]].count) return false;
    for (let id = 1; id <= count; id++) {
      if (JSON.stringify(revealCatalogMedia(catalog, category, id)) !==
        JSON.stringify(revealCatalogMedia(current, category, id))) return false;
    }
    return true;
  });
}

export function buildRevealCollectionBlocks(input: {
  source: string | Uint8Array; frozenSource: string | Uint8Array; catalog: RevealAssetCatalog;
  ancestors?: readonly RevealAssetCatalog[]; previous?: RevealCollectionBlocks;
}): RevealCollectionBlocks {
  validateRevealAssetCatalog(input.catalog);
  const { catalogVersion, importSettings } = input.catalog;
  const generated = buildRevealAssetCatalog(input.source, { catalogVersion, availableEggs: importSettings.availableEggs });
  const frozen = buildRevealAssetCatalog(input.frozenSource, { catalogVersion, availableEggs: importSettings.availableEggs });
  if (JSON.stringify(frozen) !== JSON.stringify(input.catalog)) throw new Error('Frozen asset source does not reproduce its catalog.');
  if (JSON.stringify(generated.categories) !== JSON.stringify(input.catalog.categories)) {
    throw new Error('Collection block source must cover the current catalog media exactly.');
  }
  const source = sourceEntries(input.source);
  const original = sourceEntries(input.frozenSource);
  if (Object.keys(source).length !== Object.keys(original).length || Object.entries(original).some(([path, value]) =>
    !source[path] || value[0] !== source[path][0] || value[1] !== source[path][1] ||
    value[2] !== undefined && value[2] !== source[path][2])) {
    throw new Error('Collection block source cannot change existing paths, dimensions, or recorded labels.');
  }
  for (const [path, value] of Object.entries(source)) {
    if (value.length !== 3 || typeof value[2] !== 'string' || !value[2].trim()) {
      throw new Error(`Collection block must be a nonempty string: ${path}`);
    }
    const primary = path.startsWith('paintings/alt/') ? path.replace('paintings/alt/', 'paintings/').replace(/\.webp$/, '.png')
      : path.startsWith('videos/') && path.endsWith('.webp') ? path.replace(/\.webp$/, '.mp4') : path;
    if (source[primary]?.[2] !== value[2]) throw new Error(`Collection block companions must match: ${path}`);
  }
  const ranges: Record<typeof CATEGORIES[number], Array<[number, string]>> = { painting: [], video: [], '3d': [], animated: [] };
  for (const category of CATEGORIES) {
    const family = REVEAL_ASSET_FAMILIES[category];
    const definition = input.catalog.categories[family];
    const entries = ranges[category];
    for (let id = 1; id <= definition.count; id++) {
      const path = (definition.imagePathTemplate ?? definition.pathTemplate).replace('{id}', String(id));
      const label = source[path]?.[2];
      if (!label) throw new Error(`Missing collection block: ${path}`);
      const previous = entries.at(-1);
      if (previous?.[1] === label) previous[0] = id;
      else entries.push([id, label]);
    }
  }
  const catalogs = new Map<string, RevealCollectionBlocks['catalogs'][number]>();
  if (input.previous) {
    validateRevealCollectionBlocks(input.previous);
    for (const binding of input.previous.catalogs) catalogs.set(binding.catalogVersion, binding);
  }
  for (const catalog of [...(input.ancestors ?? []), input.catalog]) {
    validateRevealAssetCatalog(catalog);
    if (!compatible(catalog, input.catalog)) throw new Error(`Incompatible collection block catalog: ${catalog.catalogVersion}`);
    const descriptor = computeRevealCatalogDescriptor(catalog);
    const existing = catalogs.get(descriptor.catalogVersion);
    if (existing && existing.manifestSha256 !== descriptor.manifestSha256) {
      throw new Error(`Collection block catalog identity changed: ${descriptor.catalogVersion}`);
    }
    catalogs.set(descriptor.catalogVersion, { ...descriptor,
      counts: Object.fromEntries(CATEGORIES.map(category => [category, catalog.categories[REVEAL_ASSET_FAMILIES[category]].count])) as
        RevealCollectionBlocks['catalogs'][number]['counts'] });
  }
  const result: RevealCollectionBlocks = { version: 1, source: { filename: '111k.json', sha256: sha256(input.source) },
    catalogs: [...catalogs.values()].sort((first, second) => Number(first.catalogVersion.slice(6)) - Number(second.catalogVersion.slice(6))), ranges };
  validateRevealCollectionBlocks(result);
  if (input.previous) {
    for (const binding of input.previous.catalogs) {
      const before = selectRevealCollectionBlocks(input.previous, binding);
      const after = selectRevealCollectionBlocks(result, binding);
      for (const category of CATEGORIES) {
        for (let id = 1; id <= binding.counts[category]; id++) {
          if (lookupRevealCollectionBlock(before, category, id) !== lookupRevealCollectionBlock(after, category, id)) {
            throw new Error(`Recorded collection block changed: ${category}/${id}`);
          }
        }
      }
    }
  }
  return result;
}

async function optional(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

type Recovery = { previous: string | null; nextSha256: string };

async function recover(root: string): Promise<void> {
  const journalPath = join(root, STATE, 'recovery.json');
  const bytes = await optional(journalPath);
  if (!bytes) return;
  const entries: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(entries) || entries.length !== FILES.length) throw new Error('Invalid collection block recovery journal.');
  const journal = entries.map((entry: unknown): Recovery => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !('previous' in entry) || entry.previous !== null && typeof entry.previous !== 'string' ||
      !('nextSha256' in entry) || typeof entry.nextSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.nextSha256) ||
      typeof entry.previous === 'string' && Buffer.from(entry.previous, 'base64').toString('base64') !== entry.previous) {
      throw new Error('Invalid collection block recovery entry.');
    }
    return { previous: entry.previous as string | null, nextSha256: entry.nextSha256 };
  });
  for (const [index, entry] of journal.entries()) {
    const path = join(root, ASSETS, FILES[index]);
    const current = await optional(path);
    const previous = entry.previous === null ? null : Buffer.from(entry.previous, 'base64');
    if (current === null ? previous === null : previous !== null && current.equals(previous)) continue;
    if (current === null || sha256(current) !== entry.nextSha256) throw new Error(`Collection block output changed after interruption: ${FILES[index]}`);
  }
  for (const [index, entry] of journal.entries()) {
    const path = join(root, ASSETS, FILES[index]);
    if (entry.previous === null) await rm(path, { force: true });
    else {
      const temporary = join(root, STATE, 'restore.tmp');
      await writeFile(temporary, Buffer.from(entry.previous, 'base64'));
      await rename(temporary, path);
    }
  }
  await rm(journalPath);
}

async function writeOutputs(root: string, next: readonly Buffer[], previous: readonly (Buffer | null)[]): Promise<void> {
  const state = join(root, STATE);
  await mkdir(state, { recursive: true });
  try {
    for (const [index, bytes] of next.entries()) {
      await writeFile(join(state, `${index}.tmp`), bytes);
      const current = await optional(join(root, ASSETS, FILES[index]));
      if (current === null ? previous[index] !== null : previous[index] === null || !current.equals(previous[index]!)) {
        throw new Error(`Collection block output changed during import: ${FILES[index]}`);
      }
    }
    await writeFile(join(state, 'recovery.tmp'), JSON.stringify(previous.map((bytes, index) => ({
      previous: bytes?.toString('base64') ?? null, nextSha256: sha256(next[index]),
    }))));
    await rename(join(state, 'recovery.tmp'), join(state, 'recovery.json'));
    for (const [index, file] of FILES.entries()) await rename(join(state, `${index}.tmp`), join(root, ASSETS, file));
    await rm(join(state, 'recovery.json'));
  } catch (error) {
    await recover(root);
    throw error;
  } finally {
    await Promise.all(['0.tmp', '1.tmp', 'recovery.tmp'].map(file => rm(join(state, file), { force: true })));
  }
}

async function runImport(root: string, options: RevealCollectionBlocksImportOptions) {
  const directory = join(root, ASSETS);
  const [frozenSource, catalogBytes, descriptorBytes, ancestorBytes, savedSource, savedArtifact] = await Promise.all([
    readFile(join(directory, 'source.json')), readFile(join(directory, 'manifest.json')),
    readFile(join(root, 'shared/ethereum/revealCatalog.json')), optional(join(root, 'shared/ethereum/revealCatalogAncestors.json')),
    optional(join(directory, FILES[0])), optional(join(directory, FILES[1])),
  ]);
  const catalog: unknown = JSON.parse(catalogBytes.toString('utf8'));
  validateRevealAssetCatalog(catalog, JSON.parse(descriptorBytes.toString('utf8')));
  const ancestors: unknown = ancestorBytes ? JSON.parse(ancestorBytes.toString('utf8')) : [];
  if (!Array.isArray(ancestors)) throw new Error('Invalid collection block ancestor catalogs.');
  for (const ancestor of ancestors) validateRevealAssetCatalog(ancestor);
  if (Boolean(savedSource) !== Boolean(savedArtifact)) throw new Error('Collection block source and artifact must both exist or both be absent.');
  let previous: RevealCollectionBlocks | undefined;
  if (savedArtifact) {
    const value: unknown = JSON.parse(savedArtifact.toString('utf8'));
    validateRevealCollectionBlocks(value);
    if (value.source.sha256 !== sha256(savedSource!)) throw new Error('Saved collection block source checksum mismatch.');
    previous = value;
  }
  const source = options.sourcePath ? await readFile(resolve(options.sourcePath)) : savedSource;
  if (!source) throw new Error('Collection block source is missing; supply --source with the complete three-value manifest.');
  const artifact = buildRevealCollectionBlocks({ source, frozenSource, catalog, ancestors, previous });
  const next = [source, Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`)];
  const old = [savedSource, savedArtifact];
  const changedFiles = FILES.flatMap((file, index) => old[index]?.equals(next[index]) ? [] : [relative(root, join(directory, file))]);
  if (options.check && changedFiles.length) throw new Error(`Collection block outputs are stale: ${changedFiles.join(', ')}`);
  if (!options.check && changedFiles.length) await writeOutputs(root, next, old);
  return { status: options.check ? 'checked' as const : changedFiles.length ? 'updated' as const : 'unchanged' as const,
    sourceSha256: artifact.source.sha256, catalogs: artifact.catalogs.map(({ catalogVersion }) => catalogVersion),
    rangeCount: Object.values(artifact.ranges).reduce((count, ranges) => count + ranges.length, 0), changedFiles };
}

export async function importRevealCollectionBlocks(options: RevealCollectionBlocksImportOptions = {}) {
  const root = resolve(options.rootDirectory ?? ROOT);
  if (options.check) {
    if (await optional(join(root, STATE, 'recovery.json')) || await optional(join(root, '.cache/111k-assets/recovery.json'))) {
      throw new Error('Interrupted asset or collection block import: rerun its command without --check to recover.');
    }
    return runImport(root, options);
  }
  return withRevealAssetImportLock(root, async () => { await recover(root); return runImport(root, options); });
}
