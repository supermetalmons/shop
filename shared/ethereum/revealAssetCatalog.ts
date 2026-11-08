import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { EthereumArtworkCategory } from './reveal.ts';

export type RevealAssetRatio = readonly [number, number];
export type RevealAssetRatios =
  | { aspectRatio: RevealAssetRatio; aspectRatioPalette?: never; aspectRatioIndexById?: never }
  | { aspectRatio?: never; aspectRatioPalette: readonly RevealAssetRatio[]; aspectRatioIndexById: readonly number[] };
export type RevealAssetVariant = RevealAssetRatios & { pathTemplate: string };
export type RevealAssetCategory = RevealAssetRatios & {
  count: number;
  pathTemplate: string;
  imagePathTemplate?: string;
  baseUrl?: string;
  availableCount?: number;
  variants?: { alt: RevealAssetVariant };
};
export type RevealAssetCatalog = {
  version: 2;
  catalogVersion: string;
  dropId: string;
  baseUrl: string;
  artworkCount: number;
  source: { filename: '111k.json'; sha256: string };
  importSettings: { availableEggs: number; eggAspectRatio: RevealAssetRatio };
  categories: Record<'eggs' | 'paintings' | 'videos' | '3d' | 'animated' | 'receipts', RevealAssetCategory>;
};
export type RevealAssetCatalogDescriptor = { catalogVersion: string; manifestSha256: string };

const CATEGORY_KEYS = { egg: 'eggs', painting: 'paintings', video: 'videos', '3d': '3d', animated: 'animated' } as const;
const MEDIA_PATHS = {
  eggs: ['eggs/{id}.png'],
  paintings: ['paintings/{id}.png'],
  videos: ['videos/{id}.mp4', 'videos/{id}.webp'],
  '3d': ['3d/{id}.glb', '3d/{id}.png'],
  animated: ['animated/{id}.mp4', 'animated/{id}.png'],
  receipts: ['placeholder.png'],
} as const;
const CATALOG_VERSION = /^111k-v[1-9]\d{0,8}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function invalid(reason: string): never { throw new Error(`Invalid reveal asset catalog: ${reason}.`); }

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function ratio(value: unknown): value is RevealAssetRatio {
  if (!Array.isArray(value) || value.length !== 2 || !count(value[0]) || value[0] < 1 || !count(value[1]) || value[1] < 1) return false;
  let [first, second] = value as [number, number];
  while (second !== 0) [first, second] = [second, first % second];
  return first === 1;
}

function validateRatios(value: Record<string, unknown>, length: number): void {
  if (value.aspectRatio !== undefined) {
    if (!ratio(value.aspectRatio) || value.aspectRatioPalette !== undefined || value.aspectRatioIndexById !== undefined) {
      invalid('ambiguous or invalid aspect ratios');
    }
    return;
  }
  const palette = value.aspectRatioPalette;
  const indexes = value.aspectRatioIndexById;
  if (!Array.isArray(palette) || !palette.length || !Array.isArray(indexes) || indexes.length !== length) {
    invalid('invalid aspect ratio palette or indexes');
  }
  for (let index = 0; index < palette.length; index++) {
    if (!ratio(palette[index])) invalid('invalid aspect ratio palette');
    if (index === 0) continue;
    const previous = palette[index - 1];
    const current = palette[index];
    if (previous[0] > current[0] || previous[0] === current[0] && previous[1] >= current[1]) {
      invalid('aspect ratio palette must be sorted and distinct');
    }
  }
  for (const index of indexes) {
    if (!count(index) || index >= palette.length) invalid('invalid aspect ratio index');
  }
}

function baseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('https://') || !value.endsWith('/') ||
    /[\u0000-\u0020\u007f\\%]/.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && url.href === value && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function validateRevealAssetCatalog(value: unknown, descriptor?: unknown): asserts value is RevealAssetCatalog {
  if (!record(value) || !keys(value, ['version', 'catalogVersion', 'dropId', 'baseUrl', 'artworkCount', 'source', 'importSettings', 'categories']) ||
    value.version !== 2 || typeof value.catalogVersion !== 'string' || !CATALOG_VERSION.test(value.catalogVersion) ||
    value.dropId !== '111k_devnet' || value.artworkCount !== 111_111 || !baseUrl(value.baseUrl)) invalid('invalid identity');
  if (!record(value.source) || !keys(value.source, ['filename', 'sha256']) || value.source.filename !== '111k.json' ||
    typeof value.source.sha256 !== 'string' || !SHA256.test(value.source.sha256)) invalid('invalid source');
  if (!record(value.importSettings) || !keys(value.importSettings, ['availableEggs', 'eggAspectRatio']) ||
    !count(value.importSettings.availableEggs) || !ratio(value.importSettings.eggAspectRatio)) invalid('invalid import settings');
  if (!record(value.categories) || Object.keys(value.categories).length !== Object.keys(MEDIA_PATHS).length) {
    invalid('invalid categories');
  }
  let total = 0;
  for (const [name, paths] of Object.entries(MEDIA_PATHS)) {
    const category = value.categories[name];
    if (!record(category) || !keys(category, ['count', 'pathTemplate', 'imagePathTemplate', 'baseUrl', 'availableCount', 'variants',
      'aspectRatio', 'aspectRatioPalette', 'aspectRatioIndexById']) || !count(category.count) ||
      category.pathTemplate !== paths[0] && !(name === 'receipts' && Number(value.catalogVersion.slice(6)) <= 4 &&
        category.pathTemplate === 'receipts/{id}.webp') || category.imagePathTemplate !== paths[1] ||
      category.baseUrl !== undefined && !baseUrl(category.baseUrl)) invalid(`invalid ${name} media`);
    validateRatios(category, category.count);
    if (name !== 'receipts') total += category.count;
    if (name === 'eggs') {
      if (category.availableCount !== value.importSettings.availableEggs || category.count > value.importSettings.availableEggs ||
        !ratio(category.aspectRatio) || category.aspectRatio[0] !== value.importSettings.eggAspectRatio[0] ||
        category.aspectRatio[1] !== value.importSettings.eggAspectRatio[1]) invalid('invalid egg allocation');
    } else if (category.availableCount !== undefined) invalid('unexpected available count');
    if (category.variants !== undefined) {
      if (name !== 'paintings' || !record(category.variants) || !keys(category.variants, ['alt']) ||
        !record(category.variants.alt) || !keys(category.variants.alt, ['pathTemplate', 'aspectRatio', 'aspectRatioPalette', 'aspectRatioIndexById']) ||
        category.variants.alt.pathTemplate !== 'paintings/alt/{id}.webp') invalid('invalid artwork variant');
      validateRatios(category.variants.alt, category.count);
    }
  }
  if (total !== value.artworkCount) invalid('artwork counts must total 111111');
  if (descriptor !== undefined && (!record(descriptor) || !keys(descriptor, ['catalogVersion', 'manifestSha256']) ||
    descriptor.catalogVersion !== value.catalogVersion || typeof descriptor.manifestSha256 !== 'string' ||
    !SHA256.test(descriptor.manifestSha256) ||
    bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value)))) !== descriptor.manifestSha256)) {
    invalid('catalog descriptor checksum mismatch');
  }
}

export function revealCatalogMedia(catalog: RevealAssetCatalog, category: EthereumArtworkCategory, assetId: number): {
  image: string; animation_url?: string; aspectRatio: { width: number; height: number };
} {
  if (!Object.hasOwn(CATEGORY_KEYS, category)) invalid('unknown artwork category');
  const definition = catalog.categories[CATEGORY_KEYS[category]];
  if (!Number.isSafeInteger(assetId) || assetId < 1 || assetId > definition.count) invalid('invalid asset ID');
  const pair = definition.aspectRatio ?? definition.aspectRatioPalette[definition.aspectRatioIndexById[assetId - 1]];
  const url = (path: string) => `${definition.baseUrl ?? catalog.baseUrl}${path.replace('{id}', String(assetId))}`;
  return {
    image: url(definition.imagePathTemplate ?? definition.pathTemplate),
    ...(definition.imagePathTemplate ? { animation_url: url(definition.pathTemplate) } : {}),
    aspectRatio: { width: pair[0], height: pair[1] },
  };
}
