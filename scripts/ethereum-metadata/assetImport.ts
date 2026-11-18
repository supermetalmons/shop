import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  revealCatalogMedia, validateRevealAssetCatalog,
  type RevealAssetCatalog, type RevealAssetCatalogDescriptor, type RevealAssetCategory, type RevealAssetRatio,
} from '../../shared/ethereum/revealAssetCatalog.ts';
import type { EthereumArtworkCategory } from '../../shared/ethereum/reveal.ts';
import { withMetadataLock } from './lock.ts';
import { ordinaryRevealCatalogSource } from './ownerHatchingCatalog.ts';
import { createRecoverableFileSet, readOptionalFile as readOptional, type FileSetRecoveryEntry } from '../shared/recoverableFileSet.ts';

const ROOT_DIRECTORY = fileURLToPath(new URL('../../', import.meta.url));
const ARTWORK_TEMPLATE = fileURLToPath(new URL('./templates/artwork.json', import.meta.url));
const ASSET_DIRECTORY = 'scripts/ethereum-metadata/reveal-assets/111k_devnet';
const DESCRIPTOR_PATH = 'shared/ethereum/revealCatalog.json';
const ANCESTORS_PATH = 'shared/ethereum/revealCatalogAncestors.json';
const ARTWORK_COUNT = 111_111;
const DEFAULT_AVAILABLE_EGGS = 76_700;
const REFERENCE_CATEGORIES: EthereumArtworkCategory[] = ['egg', 'painting', 'video', '3d', 'animated'];
const OUTPUT_PATHS = ['source.json', 'manifest.json', ...REFERENCE_CATEGORIES.map(category => `${category}.template.json`)]
  .map(name => join(ASSET_DIRECTORY, name)).concat(DESCRIPTOR_PATH, ANCESTORS_PATH);
const IMPORT_STATE_DIRECTORY = '.cache/111k-assets';
const SOURCE_GROUPS = ['3d', 'animated', 'paintings', 'paintings/alt', 'videos/mp4', 'videos/webp'] as const;
type SourceGroup = typeof SOURCE_GROUPS[number];
type SourceDimensions = Map<number, RevealAssetRatio>;

export type BuildRevealAssetCatalogOptions = {
  catalogVersion: string;
  availableEggs?: number;
};

export type RevealAssetImportOptions = {
  rootDirectory?: string;
  sourcePath?: string;
  catalogVersion?: string;
  availableEggs?: number;
  artworkTemplatePath?: string;
  check?: boolean;
};

export type RevealAssetImportResult = {
  manifest: RevealAssetCatalog;
  descriptor: RevealAssetCatalogDescriptor;
  status: 'updated' | 'unchanged' | 'checked';
  changedFiles: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function revision(version: unknown): number {
  if (typeof version !== 'string' || !/^111k-v[1-9][0-9]{0,8}$/.test(version)) {
    throw new Error('Catalog version must be 111k-v followed by a positive integer');
  }
  const value = Number(version.slice(6));
  if (!Number.isSafeInteger(value)) throw new Error('Catalog version exceeds the safe integer range');
  return value;
}

function reducedRatio([width, height]: RevealAssetRatio): RevealAssetRatio {
  let a = width;
  let b = height;
  while (b !== 0) [a, b] = [b, a % b];
  return [width / a, height / a];
}

function sourceGroups(source: string): Record<SourceGroup, SourceDimensions> {
  const value: unknown = JSON.parse(source);
  if (!record(value)) throw new Error('Asset source must be an object mapping paths to dimensions');
  const keys = [...source.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(match => JSON.parse(match[1]) as string);
  if (new Set(keys).size !== keys.length) throw new Error('Asset source contains duplicate paths');
  const groups = Object.fromEntries(SOURCE_GROUPS.map(group => [group, new Map<number, RevealAssetRatio>()])) as
    Record<SourceGroup, SourceDimensions>;
  for (const [path, dimensions] of Object.entries(value)) {
    const match = /^(3d|animated|paintings)\/([1-9][0-9]*)\.png$|^(paintings\/alt)\/([1-9][0-9]*)\.webp$|^(videos)\/([1-9][0-9]*)\.(mp4|webp)$/.exec(path);
    if (!match) throw new Error(`Unsupported asset source path: ${path}`);
    const group = (match[1] ?? match[3] ?? `videos/${match[7]}`) as SourceGroup;
    const rawId = match[2] ?? match[4] ?? match[6];
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || String(id) !== rawId) throw new Error(`Invalid asset ID: ${path}`);
    if (!Array.isArray(dimensions) || dimensions.length !== 2 && dimensions.length !== 3 ||
      dimensions.slice(0, 2).some(dimension => !Number.isSafeInteger(dimension) || dimension <= 0)) {
      throw new Error(`Asset dimensions must be positive safe integers: ${path}`);
    }
    if (dimensions.length === 3 && (typeof dimensions[2] !== 'string' || !dimensions[2].trim())) {
      throw new Error(`Asset collection block must be a nonempty string: ${path}`);
    }
    groups[group].set(id, [dimensions[0], dimensions[1]]);
  }
  for (const group of SOURCE_GROUPS) {
    if (group === 'paintings/alt') continue;
    const ids = [...groups[group].keys()].sort((a, b) => a - b);
    if (ids.length === 0 || ids.some((id, index) => id !== index + 1)) {
      throw new Error(`Asset IDs must be contiguous from 1 with no gaps: ${group}`);
    }
  }
  if ([...groups['paintings/alt'].keys()].some(id => !groups.paintings.has(id))) {
    throw new Error('Painting alternate IDs must belong to primary painting IDs');
  }
  for (const id of groups['paintings/alt'].keys()) {
    if ((value[`paintings/alt/${id}.webp`] as unknown[])[2] !== (value[`paintings/${id}.png`] as unknown[])[2]) {
      throw new Error(`Painting primary and alternate collection blocks must match: ${id}`);
    }
  }
  if (groups['videos/mp4'].size !== groups['videos/webp'].size) {
    throw new Error('Video MP4 and WEBP IDs must be paired');
  }
  for (const [id, dimensions] of groups['videos/mp4']) {
    const poster = groups['videos/webp'].get(id)!;
    if (dimensions[0] !== poster[0] || dimensions[1] !== poster[1]) {
      throw new Error(`Video MP4 and WEBP dimensions must match: ${id}`);
    }
    if ((value[`videos/${id}.mp4`] as unknown[])[2] !== (value[`videos/${id}.webp`] as unknown[])[2]) {
      throw new Error(`Video MP4 and WEBP collection blocks must match: ${id}`);
    }
  }
  return groups;
}

function palette(dimensions: SourceDimensions, ids = [...dimensions.keys()].sort((a, b) => a - b)): {
  aspectRatioPalette: RevealAssetRatio[];
  aspectRatioIndexById: number[];
} {
  const ratios = ids.map(id => reducedRatio(dimensions.get(id)!));
  const unique = new Map(ratios.map(ratio => [ratio.join(':'), ratio]));
  const aspectRatioPalette = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const indexes = new Map(aspectRatioPalette.map((ratio, index) => [ratio.join(':'), index]));
  return { aspectRatioPalette, aspectRatioIndexById: ratios.map(ratio => indexes.get(ratio.join(':'))!) };
}

function mediaCategory(dimensions: SourceDimensions, pathTemplate: string, imagePathTemplate?: string): RevealAssetCategory {
  return { count: dimensions.size, pathTemplate, ...(imagePathTemplate ? { imagePathTemplate } : {}), ...palette(dimensions) };
}

export function buildRevealAssetCatalog(
  sourceBytes: string | Uint8Array, options: BuildRevealAssetCatalogOptions,
): RevealAssetCatalog {
  revision(options.catalogVersion);
  const availableEggs = options.availableEggs ?? DEFAULT_AVAILABLE_EGGS;
  if (!Number.isSafeInteger(availableEggs) || availableEggs < 1) {
    throw new Error('Available eggs must be a positive safe integer');
  }
  const groups = sourceGroups(Buffer.from(sourceBytes).toString('utf8'));
  const eggCount = ARTWORK_COUNT - groups['3d'].size - groups.animated.size - groups.paintings.size - groups['videos/mp4'].size;
  if (eggCount < 0 || eggCount > availableEggs) {
    throw new Error(`Egg allocation ${eggCount} must be nonnegative and cannot exceed ${availableEggs} available eggs`);
  }
  const manifest: RevealAssetCatalog = {
    version: 2,
    catalogVersion: options.catalogVersion,
    dropId: '111k_devnet',
    baseUrl: 'https://cdn.lil.org/nft/111k/',
    artworkCount: ARTWORK_COUNT,
    source: { filename: '111k.json', sha256: sha256(sourceBytes) },
    importSettings: { availableEggs, eggAspectRatio: [1, 1] },
    categories: {
      eggs: { count: eggCount, availableCount: availableEggs, pathTemplate: 'eggs/{id}.png', aspectRatio: [1, 1] },
      paintings: {
        ...mediaCategory(groups.paintings, 'paintings/{id}.png'),
        ...(groups['paintings/alt'].size ? { variants: { alt: { pathTemplate: 'paintings/alt/{id}.webp',
          ...(groups['paintings/alt'].size === groups.paintings.size ? {} : {
            assetIds: [...groups['paintings/alt'].keys()].sort((a, b) => a - b) }),
          ...palette(groups['paintings/alt']) } } } : {}),
      },
      videos: mediaCategory(groups['videos/mp4'], 'videos/{id}.mp4', 'videos/{id}.webp'),
      '3d': mediaCategory(groups['3d'], '3d/{id}.glb', '3d/{id}.png'),
      animated: mediaCategory(groups.animated, 'animated/{id}.mp4', 'animated/{id}.png'),
      receipts: { count: 85_556, pathTemplate: 'placeholder.png', aspectRatio: [466, 503] },
    },
  };
  validateRevealAssetCatalog(manifest);
  return manifest;
}

function referenceTemplates(manifest: RevealAssetCatalog, template: unknown): Record<string, string> {
  if (!record(template) || typeof template.name !== 'string' || typeof template.description !== 'string' ||
    typeof template.image !== 'string' || !Array.isArray(template.attributes) ||
    template.attributes.some(attribute => !record(attribute) || typeof attribute.trait_type !== 'string' ||
      (typeof attribute.value !== 'string' && (typeof attribute.value !== 'number' || !Number.isFinite(attribute.value))))) {
    throw new Error('Invalid baseline artwork metadata template');
  }
  const attributes = template.attributes;
  return Object.fromEntries(REFERENCE_CATEGORIES.map(category => {
    const referenceCatalog = category === 'egg' && manifest.categories.eggs.count === 0
      ? { ...manifest, categories: { ...manifest.categories,
        eggs: { ...manifest.categories.eggs, count: manifest.categories.eggs.availableCount! } } }
      : manifest;
    const media = revealCatalogMedia(referenceCatalog, category, 1);
    const placeholderUrl = (url: string) => {
      const result = url.replace(/\/1(?=\.[^/]+$)/, '/{{assetId}}');
      if (result === url) throw new Error(`Unable to create asset URL placeholder: ${category}`);
      return result;
    };
    const metadata: Record<string, unknown> = {
      ...template,
      name: category === 'egg' ? 'Egg #{{assetId}}' : '{{tokenId}}',
      description: category === 'egg' ? 'a unrevealed gan egg. what will hatch from it?' : template.description,
      image: placeholderUrl(media.image),
      aspectRatio: media.aspectRatio,
      attributes: [...attributes.filter(attribute => (attribute as Record<string, unknown>).trait_type !== 'type'),
        { trait_type: 'type', value: category }],
      category,
      revealStatus: 'revealed',
    };
    delete metadata.animation_url;
    if (media.animation_url) metadata.animation_url = placeholderUrl(media.animation_url);
    const source = `${JSON.stringify(metadata, null, 2)}\n`;
    if (/\{\{|\}\}/.test(source.replaceAll('{{tokenId}}', '1').replaceAll('{{assetId}}', '1'))) {
      throw new Error(`Unresolved reference metadata placeholder: ${category}`);
    }
    return [`${category}.template.json`, source];
  }));
}

function assetFileSet(rootDirectory: string) {
  return createRecoverableFileSet({
    stateDirectory: join(rootDirectory, IMPORT_STATE_DIRECTORY),
    staging: 'directory',
    decodeJournal(journal): FileSetRecoveryEntry[] {
      if (!Array.isArray(journal) || !journal.length || journal.length > OUTPUT_PATHS.length) {
        throw new Error('Invalid asset import recovery journal');
      }
      const paths = new Set<string>();
      return journal.map((entry: unknown) => {
        if (!record(entry) || typeof entry.file !== 'string' || !OUTPUT_PATHS.includes(entry.file) || paths.has(entry.file) ||
          entry.previous !== null && typeof entry.previous !== 'string' ||
          typeof entry.nextSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.nextSha256)) {
          throw new Error('Invalid asset import recovery entry');
        }
        paths.add(entry.file);
        const previous = entry.previous === null ? null : Buffer.from(entry.previous as string, 'base64');
        if (previous && previous.toString('base64') !== entry.previous) throw new Error('Invalid asset import recovery bytes');
        return { path: join(rootDirectory, entry.file), previous, nextSha256: entry.nextSha256 };
      });
    },
    encodeJournal: entries => entries.map(entry => ({ file: relative(rootDirectory, entry.path),
      previous: entry.previous?.toString('base64') ?? null, nextSha256: entry.nextSha256 })),
    conflictMessage: (path, phase) => phase === 'write'
      ? `Asset output changed during import: ${relative(rootDirectory, path)}`
      : `Asset output changed since interrupted import: ${relative(rootDirectory, path)}`,
  });
}

export async function importRevealAssets(options: RevealAssetImportOptions = {}): Promise<RevealAssetImportResult> {
  const rootDirectory = resolve(options.rootDirectory ?? ROOT_DIRECTORY);
  if (options.check) {
    if (await readOptional(join(rootDirectory, IMPORT_STATE_DIRECTORY, 'recovery.json'))) {
      throw new Error('Interrupted asset import: rerun import without --check to recover');
    }
    return runImport(rootDirectory, options);
  }
  return withRevealAssetImportLock(rootDirectory, importAssets => importAssets(options));
}

export async function withRevealAssetImportLock<T>(root: string,
  work: (importAssets: (options?: Omit<RevealAssetImportOptions, 'rootDirectory'>) => Promise<RevealAssetImportResult>) => Promise<T>,
): Promise<T> {
  const rootDirectory = resolve(root);
  return withMetadataLock(join(rootDirectory, '.111k-assets.lock'), async () => {
    await assetFileSet(rootDirectory).recover();
    return work((options = {}) => runImport(rootDirectory, options));
  });
}

async function runImport(rootDirectory: string, options: RevealAssetImportOptions): Promise<RevealAssetImportResult> {
  const assetDirectory = join(rootDirectory, ASSET_DIRECTORY);
  const manifestPath = join(assetDirectory, 'manifest.json');
  const descriptorPath = join(rootDirectory, DESCRIPTOR_PATH);
  const [existingManifestBytes, existingDescriptorBytes, inputBytes, templateBytes] = await Promise.all([
    readOptional(manifestPath),
    readOptional(descriptorPath),
    readFile(options.sourcePath ? resolve(options.sourcePath) : join(assetDirectory, 'source.json')),
    readFile(options.artworkTemplatePath ? resolve(options.artworkTemplatePath) : ARTWORK_TEMPLATE),
  ]);
  const existingManifest: unknown = existingManifestBytes ? JSON.parse(existingManifestBytes.toString('utf8')) : undefined;
  const existingDescriptor: unknown = existingDescriptorBytes ? JSON.parse(existingDescriptorBytes.toString('utf8')) : undefined;
  if (existingDescriptor !== undefined && (!record(existingDescriptor) ||
    Object.keys(existingDescriptor).length !== 2 || typeof existingDescriptor.catalogVersion !== 'string' ||
    !/^111k-v[1-9][0-9]{0,8}$/.test(existingDescriptor.catalogVersion) || typeof existingDescriptor.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(existingDescriptor.manifestSha256))) {
    throw new Error('Invalid saved reveal catalog descriptor');
  }
  if (existingDescriptor !== undefined && existingManifest !== undefined) {
    try { validateRevealAssetCatalog(existingManifest, existingDescriptor); }
    catch (error) {
      throw new Error('Saved reveal asset catalog is stale or inconsistent with its descriptor', { cause: error });
    }
  }
  const priorVersion = record(existingDescriptor) ? existingDescriptor.catalogVersion :
    record(existingManifest) ? existingManifest.catalogVersion : undefined;
  const catalogVersion = options.catalogVersion ?? priorVersion;
  const nextRevision = revision(catalogVersion);
  if (priorVersion !== undefined && nextRevision < revision(priorVersion)) {
    throw new Error(`Catalog version cannot decrease below ${priorVersion}`);
  }
  const savedAvailableEggs = record(existingManifest) && record(existingManifest.importSettings)
    ? existingManifest.importSettings.availableEggs : undefined;
  const sourceBytes = options.sourcePath || priorVersion !== catalogVersion
    ? Buffer.from(ordinaryRevealCatalogSource(inputBytes.toString('utf8'))) : inputBytes;
  const manifest = buildRevealAssetCatalog(sourceBytes, {
    catalogVersion: catalogVersion as string,
    availableEggs: options.availableEggs ?? (savedAvailableEggs as number | undefined),
  });
  const descriptor: RevealAssetCatalogDescriptor = {
    catalogVersion: manifest.catalogVersion,
    manifestSha256: sha256(JSON.stringify(manifest)),
  };
  validateRevealAssetCatalog(manifest, descriptor);
  const templates = referenceTemplates(manifest, JSON.parse(templateBytes.toString('utf8')));
  const files = [
    { path: join(assetDirectory, 'source.json'), bytes: sourceBytes },
    { path: manifestPath, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    ...Object.entries(templates).map(([name, source]) => ({ path: join(assetDirectory, name), bytes: Buffer.from(source) })),
    { path: descriptorPath, bytes: Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`) },
  ];
  const outputs = (await Promise.all(files.map(async file => ({ ...file,
    previous: file.path === manifestPath ? existingManifestBytes :
      file.path === descriptorPath ? existingDescriptorBytes : await readOptional(file.path),
  }))))
    .filter(file => !file.previous?.equals(file.bytes));
  if (priorVersion !== undefined && priorVersion !== catalogVersion) {
    validateRevealAssetCatalog(existingManifest, existingDescriptor);
    const path = join(rootDirectory, ANCESTORS_PATH);
    const previous = await readOptional(path);
    const ancestors: unknown = previous ? JSON.parse(previous.toString('utf8')) : [];
    if (!Array.isArray(ancestors)) throw new Error('Invalid supported catalog ancestors.');
    let retained = false;
    for (const ancestor of ancestors) {
      validateRevealAssetCatalog(ancestor);
      if (ancestor.catalogVersion === priorVersion) {
        if (JSON.stringify(ancestor) !== JSON.stringify(existingManifest)) throw new Error('Conflicting supported predecessor catalog.');
        retained = true;
      }
      if (ancestor.catalogVersion === catalogVersion) validateRevealAssetCatalog(ancestor, descriptor);
    }
    if (!retained) {
      ancestors.push(existingManifest);
      outputs.unshift({ path, previous, bytes: Buffer.from(JSON.stringify(ancestors, null, 2) + '\n') });
    }
    const { validateCollectionBlockUpgrade } = await import('./collectionBlocks.ts');
    await validateCollectionBlockUpgrade(rootDirectory, sourceBytes, manifest, ancestors);
  }
  const changedFiles = outputs.map(output => relative(rootDirectory, output.path));
  if (outputs.length > 0 && priorVersion === catalogVersion) {
    throw new Error(`Changed or stale catalog ${catalogVersion} requires a higher catalog version: ${changedFiles.join(', ')}`);
  }
  if (options.check) {
    if (outputs.length > 0) throw new Error(`Reveal asset outputs are stale: ${changedFiles.join(', ')}`);
    return { manifest, descriptor, status: 'checked', changedFiles };
  }
  if (outputs.length === 0) return { manifest, descriptor, status: 'unchanged', changedFiles };
  await assetFileSet(rootDirectory).write(outputs);
  return { manifest, descriptor, status: 'updated', changedFiles };
}
