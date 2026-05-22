import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export type DropFamily = 'default' | 'little_swag_boxes' | 'poncho_drifella' | 'little_swag_hoodies';
export type MetadataPathFormat = 'legacy' | 'compact';

export type FigureMediaConfigSerialized = {
  strategy?: 'direct' | 'cyclic';
  count?: number;
  overrides?: Record<number, number>;
};

export type MintSelectionOptionSerialized = {
  key: string;
  label: string;
  startId: number;
  endId: number;
};

export type MintSelectionConfigSerialized = {
  kind: 'size';
  options: MintSelectionOptionSerialized[];
};

export type FrontendDropConfigSerialized = {
  solanaCluster: string;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;
  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  secondaryMarketHref?: string;
  figureMedia?: FigureMediaConfigSerialized;
  forceSoldOut?: boolean;
  mintSelection?: MintSelectionConfigSerialized;
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  discountMintsPerWallet: number;
  discountMerkleRoot: string;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
  collectionMint: string;
};

export type FunctionsDropConfigSerialized = FrontendDropConfigSerialized & {
  stripeLiveUnitAmountCents?: number;
  stripeProductTaxCode?: string;
  receiptsMerkleTree: string;
  deliveryLookupTable: string;
};

export type FrontendDropRegistry = {
  drops: Record<string, FrontendDropConfigSerialized>;
};

export type FunctionsDropRegistry = {
  drops: Record<string, FunctionsDropConfigSerialized>;
};

export type DropPaths = {
  base: string;
  collectionJson: string;
  boxesJsonBase: string;
  figuresJsonBase: string;
  receiptsBoxesJsonBase: string;
  receiptsFiguresJsonBase: string;
};

export const FRONTEND_DEPLOYMENT_REGISTRY_START = '// BEGIN AUTO-GENERATED FRONTEND DROP REGISTRY';
export const FRONTEND_DEPLOYMENT_REGISTRY_END = '// END AUTO-GENERATED FRONTEND DROP REGISTRY';
export const FUNCTIONS_DEPLOYMENT_REGISTRY_START = '// BEGIN AUTO-GENERATED FUNCTIONS DROP REGISTRY';
export const FUNCTIONS_DEPLOYMENT_REGISTRY_END = '// END AUTO-GENERATED FUNCTIONS DROP REGISTRY';

function tsStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function asTrimmedString(value: unknown): string {
  return String(value ?? '').trim();
}

function asFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asOptionalStripeUnitAmountCents(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 50 && n <= 99_999_999 ? n : undefined;
}

const IPFS_PROTOCOL = 'ipfs://';
export const DROP_METADATA_IPFS_GATEWAY = 'https://dweb.link/ipfs/';
const RAW_CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const HTTP_PROTOCOL = 'http://';
const HTTPS_PROTOCOL = 'https://';

const BASE32_LOOKUP: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Array.from(BASE32_ALPHABET).map((char, index) => [char, index] as const)),
);

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeMetadataPathFormat(value: unknown, fallback: MetadataPathFormat = 'legacy'): MetadataPathFormat {
  return value === 'compact' || value === 'legacy' ? value : fallback;
}

function decodeBase32Lower(value: string): Uint8Array | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    const digit = BASE32_LOOKUP[char];
    if (typeof digit !== 'number') return null;
    buffer = (buffer << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

function readUvarint(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < bytes.length; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return { value, nextOffset: index + 1 };
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

function isRawCidV1(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized.startsWith('b')) return false;
  const bytes = decodeBase32Lower(normalized.slice(1));
  if (!bytes?.length) return false;

  const version = readUvarint(bytes, 0);
  if (!version || version.value !== 1) return false;
  const codec = readUvarint(bytes, version.nextOffset);
  if (!codec) return false;
  const multihashCode = readUvarint(bytes, codec.nextOffset);
  if (!multihashCode) return false;
  const multihashLength = readUvarint(bytes, multihashCode.nextOffset);
  if (!multihashLength || multihashLength.value < 1) return false;
  return bytes.length === multihashLength.nextOffset + multihashLength.value;
}

function isRawIpfsCid(value: string): boolean {
  return RAW_CID_V0_RE.test(value) || isRawCidV1(value);
}

function hasSupportedMetadataBaseScheme(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    normalized.startsWith(HTTPS_PROTOCOL) ||
    normalized.startsWith(HTTP_PROTOCOL) ||
    normalized.startsWith(IPFS_PROTOCOL)
  );
}

export function isSupportedMetadataBaseInput(base: string): boolean {
  const trimmed = trimTrailingSlashes(String(base || '').trim());
  if (!trimmed) return false;
  return hasSupportedMetadataBaseScheme(trimmed) || isRawIpfsCid(trimmed);
}

function hasInvalidMetadataBasePath(base: string): boolean {
  const normalized = trimTrailingSlashes(String(base || '').trim());
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return (
    lower.endsWith('.json') ||
    lower.includes('/json/boxes') ||
    lower.includes('/json/figures') ||
    lower.includes('/json/receipts')
  );
}

function hasMetadataBaseQueryOrFragment(base: string): boolean {
  const normalized = String(base || '').trim();
  return normalized.includes('?') || normalized.includes('#');
}

export function normalizeAndValidateMetadataBaseInput(base: string): string {
  const trimmed = trimTrailingSlashes(String(base || '').trim());
  if (!trimmed) {
    throw new Error('metadataBase is required and must be an https://..., ipfs://..., or raw IPFS CID value.');
  }
  if (!isSupportedMetadataBaseInput(trimmed)) {
    throw new Error(
      `Invalid metadataBase: ${trimmed}. Expected https://..., http://..., ipfs://..., or a raw IPFS CID.`,
    );
  }
  if (hasMetadataBaseQueryOrFragment(trimmed)) {
    throw new Error(
      `Invalid metadataBase: ${trimmed}. Expected the drop root without query strings or fragments.`,
    );
  }
  const normalized = normalizeDropBase(trimmed);
  if (hasInvalidMetadataBasePath(normalized)) {
    throw new Error(
      `Invalid metadataBase: ${trimmed}. Expected the drop root, not collection.json or a metadata asset path.`,
    );
  }
  return normalized;
}

function normalizeIpfsProtocolUrl(value: string): string {
  const trimmed = trimTrailingSlashes(String(value || '').trim());
  if (!trimmed) return '';
  if (!trimmed.toLowerCase().startsWith(IPFS_PROTOCOL)) return trimmed;
  const withoutProtocol = trimmed.slice(IPFS_PROTOCOL.length).replace(/^ipfs\//i, '');
  return `${IPFS_PROTOCOL}${withoutProtocol.replace(/^\/+/, '')}`;
}

export function normalizeDropBase(base: string): string {
  const trimmed = trimTrailingSlashes(String(base || '').trim());
  if (!trimmed) return '';
  if (isRawIpfsCid(trimmed)) return `${IPFS_PROTOCOL}${trimmed}`;
  return normalizeIpfsProtocolUrl(trimmed);
}

export function canonicalizeDropAssetUrl(url: string): string {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  const normalizedIpfs = normalizeIpfsProtocolUrl(trimmed);
  if (normalizedIpfs.toLowerCase().startsWith(IPFS_PROTOCOL)) return normalizedIpfs;

  try {
    const parsed = new URL(trimmed);
    const hostMatch = parsed.hostname.match(/^([^./]+)\.ipfs\./i);
    if (hostMatch?.[1]) {
      return `${IPFS_PROTOCOL}${hostMatch[1]}${trimTrailingSlashes(parsed.pathname)}${parsed.search}${parsed.hash}`;
    }
    const pathMatch = parsed.pathname.match(/^\/ipfs\/([^/]+)(\/.*)?$/i);
    if (pathMatch?.[1]) {
      return `${IPFS_PROTOCOL}${pathMatch[1]}${trimTrailingSlashes(pathMatch[2] || '')}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Non-URL strings should pass through unchanged.
  }

  return trimmed;
}

export function resolveDropAssetUrl(url: string): string {
  const canonical = canonicalizeDropAssetUrl(url);
  if (!canonical.toLowerCase().startsWith(IPFS_PROTOCOL)) return canonical;
  const path = canonical.slice(IPFS_PROTOCOL.length).replace(/^\/+/, '');
  return `${DROP_METADATA_IPFS_GATEWAY}${path}`;
}

export function dropPathsFromBase(dropBase: string, metadataPathFormat: MetadataPathFormat = 'compact'): DropPaths {
  const base = normalizeDropBase(dropBase);
  if (metadataPathFormat === 'legacy') {
    return {
      base,
      collectionJson: `${base}/collection.json`,
      boxesJsonBase: `${base}/json/boxes/`,
      figuresJsonBase: `${base}/json/figures/`,
      receiptsBoxesJsonBase: `${base}/json/receipts/boxes/`,
      receiptsFiguresJsonBase: `${base}/json/receipts/figures/`,
    };
  }
  return {
    base,
    collectionJson: `${base}/collection.json`,
    boxesJsonBase: `${base}/b`,
    figuresJsonBase: `${base}/f`,
    receiptsBoxesJsonBase: `${base}/rb`,
    receiptsFiguresJsonBase: `${base}/rf`,
  };
}

export function normalizeDropId(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

const DROP_FAMILY_BY_DROP_ID: Record<string, Exclude<DropFamily, 'default'>> = {
  little_swag_boxes: 'little_swag_boxes',
  little_swag_boxes_devnet: 'little_swag_boxes',
  poncho_drifella: 'poncho_drifella',
};

export function defaultDropFamilyForDropId(dropId: string): DropFamily {
  const normalizedDropId = normalizeDropId(dropId);
  return DROP_FAMILY_BY_DROP_ID[normalizedDropId] || 'default';
}

function asDropFamily(value: unknown): DropFamily | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'little_swag_boxes' ||
    normalized === 'little_swag_hoodies' ||
    normalized === 'poncho_drifella' ||
    normalized === 'default'
  ) {
    return normalized;
  }
  return undefined;
}

export function requireDropFamily(value: string, label: string): DropFamily {
  const normalized = asDropFamily(value);
  if (normalized) return normalized;
  throw new Error(
    `Invalid ${label}: ${value} (expected default, little_swag_boxes, little_swag_hoodies, or poncho_drifella)`,
  );
}

export function normalizeDropFamily(value: unknown, dropId?: string): DropFamily {
  const normalized = asDropFamily(value);
  if (normalized) return normalized;
  return defaultDropFamilyForDropId(dropId || '');
}

export type SecondaryMarketplaceKey = 'magiceden' | 'tensor';

export type SecondaryMarketplaceLink = {
  key: SecondaryMarketplaceKey;
  label: string;
  href: string;
};

const MAGIC_EDEN_MARKETPLACE_HREF_OVERRIDES: Record<string, string> = {
  little_swag_boxes: 'https://magiceden.io/marketplace/little_swag_boxes',
  poncho_drifella: 'https://magiceden.io/marketplace/poncho_drifella',
};

const TENSOR_MARKETPLACE_HREF_OVERRIDES: Record<string, string> = {
  little_swag_boxes: 'https://www.tensor.trade/trade/little_swag_boxes',
  poncho_drifella: 'https://www.tensor.trade/trade/poncho_drifella',
};

const FORCE_SOLD_OUT_DROP_OVERRIDES: Record<string, true> = {
  poncho_drifella: true,
};

function defaultSecondaryMarketHref(dropId: string): string | undefined {
  return secondaryMarketplaceLinksForDropId(dropId).find((link) => link.key === 'tensor')?.href;
}

export function secondaryMarketplaceLinksForDropId(dropId: string): SecondaryMarketplaceLink[] {
  const normalizedDropId = normalizeDropId(dropId);
  if (!normalizedDropId) return [];
  return [
    {
      key: 'magiceden',
      label: 'Magic Eden',
      href: MAGIC_EDEN_MARKETPLACE_HREF_OVERRIDES[normalizedDropId] || `https://magiceden.io/marketplace/${normalizedDropId}`,
    },
    {
      key: 'tensor',
      label: 'Tensor',
      href: TENSOR_MARKETPLACE_HREF_OVERRIDES[normalizedDropId] || `https://www.tensor.trade/trade/${normalizedDropId}`,
    },
  ];
}

function defaultFrontendForceSoldOutForDropId(dropId: string): boolean {
  const normalizedDropId = normalizeDropId(dropId);
  return FORCE_SOLD_OUT_DROP_OVERRIDES[normalizedDropId] === true;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return undefined;
  return normalized;
}

function normalizeDiscountMintsPerWallet(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) return 1;
  return parsed;
}

const LITTLE_SWAG_BOXES_FIGURE_MEDIA: FigureMediaConfigSerialized = {
  strategy: 'cyclic',
  count: 333,
  overrides: {
    344: 1,
    353: 90,
    360: 3,
    505: 163,
    650: 285,
    660: 13,
    661: 206,
    662: 82,
    663: 175,
    664: 19,
    665: 92,
    666: 86,
    677: 1,
    686: 90,
    693: 3,
    838: 163,
    983: 285,
    993: 49,
    994: 206,
    995: 21,
    996: 175,
    997: 19,
    998: 92,
    999: 86,
  },
};

function normalizeFigureMediaConfigForRegistry(raw: unknown): FigureMediaConfigSerialized | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const strategy = obj.strategy === 'cyclic' ? 'cyclic' : obj.strategy === 'direct' ? 'direct' : undefined;
  const count = normalizePositiveInteger(obj.count);
  const overrideEntries = Object.entries((obj.overrides as Record<string, unknown>) || {}).flatMap(([figureIdRaw, mediaIdRaw]) => {
    const figureId = normalizePositiveInteger(figureIdRaw);
    const mediaId = normalizePositiveInteger(mediaIdRaw);
    if (!figureId || !mediaId) return [];
    return [[figureId, mediaId] as const];
  });
  const overrides = overrideEntries.length ? Object.fromEntries(overrideEntries) : undefined;
  if (!strategy && !count && !overrides) return undefined;
  return {
    ...(strategy ? { strategy } : {}),
    ...(count ? { count } : {}),
    ...(overrides ? { overrides } : {}),
  };
}

function normalizeMintSelectionConfigForRegistry(raw: unknown): MintSelectionConfigSerialized | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== 'size') return undefined;
  const optionsRaw = Array.isArray(obj.options) ? obj.options : [];
  const options = optionsRaw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const option = entry as Record<string, unknown>;
    const key = asTrimmedString(option.key);
    const label = asTrimmedString(option.label) || key;
    const startId = normalizePositiveInteger(option.startId);
    const endId = normalizePositiveInteger(option.endId);
    if (!key || !label || !startId || !endId || endId < startId) return [];
    return [{ key, label, startId, endId }];
  });
  if (options.length !== 3) return undefined;
  return {
    kind: 'size',
    options,
  };
}

export function defaultFrontendFigureMediaForDropFamily(dropFamily: DropFamily): FigureMediaConfigSerialized | undefined {
  if (dropFamily !== 'little_swag_boxes') return undefined;
  return normalizeFigureMediaConfigForRegistry(LITTLE_SWAG_BOXES_FIGURE_MEDIA);
}

function normalizeFrontendDropForRegistry(raw: unknown): FrontendDropConfigSerialized | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const dropId = normalizeDropId(asTrimmedString(obj.dropId));
  if (!dropId) return undefined;
  const dropFamily = normalizeDropFamily(obj.dropFamily, dropId);
  const metadataBase = asTrimmedString(obj.metadataBase) || asTrimmedString((obj.paths as any)?.base);
  const secondaryMarketHref = asTrimmedString(obj.secondaryMarketHref);
  const defaultMarketHref = defaultSecondaryMarketHref(dropId);
  const figureMedia = normalizeFigureMediaConfigForRegistry(obj.figureMedia) || defaultFrontendFigureMediaForDropFamily(dropFamily);
  const forceSoldOut = obj.forceSoldOut === true || defaultFrontendForceSoldOutForDropId(dropId);
  const mintSelection = normalizeMintSelectionConfigForRegistry(obj.mintSelection);
  const boxMinterConfigPda = asTrimmedString(obj.boxMinterConfigPda);
  const stripeCheckoutEnabled = obj.stripeCheckoutEnabled === true;
  const stripeLiveUnitAmountCents = asOptionalStripeUnitAmountCents(obj.stripeLiveUnitAmountCents);
  return {
    solanaCluster: asTrimmedString(obj.solanaCluster),
    dropId,
    dropFamily,
    collectionName: asTrimmedString(obj.collectionName) || dropId,
    metadataBase: normalizeDropBase(metadataBase),
    metadataPathFormat: normalizeMetadataPathFormat(obj.metadataPathFormat),
    ...(secondaryMarketHref && secondaryMarketHref !== defaultMarketHref ? { secondaryMarketHref } : {}),
    ...(figureMedia ? { figureMedia } : {}),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    ...(mintSelection ? { mintSelection } : {}),
    treasury: asTrimmedString(obj.treasury),
    priceSol: asFiniteNumber(obj.priceSol),
    discountPriceSol: asFiniteNumber(obj.discountPriceSol),
    ...(stripeCheckoutEnabled ? { stripeCheckoutEnabled: true } : {}),
    ...(stripeLiveUnitAmountCents != null ? { stripeLiveUnitAmountCents } : {}),
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(obj.discountMintsPerWallet),
    discountMerkleRoot: asTrimmedString(obj.discountMerkleRoot),
    maxSupply: Math.floor(asFiniteNumber(obj.maxSupply)),
    itemsPerBox: Math.floor(asFiniteNumber(obj.itemsPerBox)),
    maxPerTx: Math.floor(asFiniteNumber(obj.maxPerTx)),
    namePrefix: asTrimmedString(obj.namePrefix),
    figureNamePrefix: asTrimmedString(obj.figureNamePrefix) || 'figure',
    symbol: asTrimmedString(obj.symbol),
    boxMinterProgramId: asTrimmedString(obj.boxMinterProgramId),
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    collectionMint: asTrimmedString(obj.collectionMint),
  };
}

function normalizeFunctionsDropForRegistry(raw: unknown): FunctionsDropConfigSerialized | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const frontendShape = normalizeFrontendDropForRegistry(raw);
  if (!frontendShape) return undefined;
  const stripeLiveUnitAmountCents = asOptionalStripeUnitAmountCents(obj.stripeLiveUnitAmountCents);
  const stripeProductTaxCode = asTrimmedString(obj.stripeProductTaxCode);
  return {
    ...frontendShape,
    ...(stripeLiveUnitAmountCents != null ? { stripeLiveUnitAmountCents } : {}),
    ...(stripeProductTaxCode ? { stripeProductTaxCode } : {}),
    receiptsMerkleTree: asTrimmedString(obj.receiptsMerkleTree),
    deliveryLookupTable: asTrimmedString(obj.deliveryLookupTable),
  };
}

async function importModuleFresh(filePath: string): Promise<Record<string, unknown>> {
  const href = pathToFileURL(filePath).href;
  const mtimeMs = existsSync(filePath) ? statSync(filePath).mtimeMs : Date.now();
  return (await import(`${href}?t=${mtimeMs}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)) as Record<string, unknown>;
}

export async function readFrontendDropRegistry(filePath: string): Promise<FrontendDropRegistry> {
  const drops: Record<string, FrontendDropConfigSerialized> = {};
  if (!existsSync(filePath)) return { drops };

  let mod: Record<string, unknown> = {};
  try {
    mod = await importModuleFresh(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load existing frontend deployment config at ${filePath}: ${reason}`);
  }

  const dropsCandidate = mod.FRONTEND_DROPS;
  if (dropsCandidate && typeof dropsCandidate === 'object' && !Array.isArray(dropsCandidate)) {
    Object.values(dropsCandidate as Record<string, unknown>).forEach((value) => {
      const normalized = normalizeFrontendDropForRegistry(value);
      if (!normalized) return;
      drops[normalized.dropId] = normalized;
    });
  }

  if (!Object.keys(drops).length) {
    const legacy = mod.FRONTEND_DEPLOYMENT || mod.DEPLOYMENT || mod.default;
    const normalized = normalizeFrontendDropForRegistry(legacy);
    if (normalized) drops[normalized.dropId] = normalized;
  }

  return { drops };
}

export async function readFunctionsDropRegistry(filePath: string): Promise<FunctionsDropRegistry> {
  const drops: Record<string, FunctionsDropConfigSerialized> = {};
  if (!existsSync(filePath)) return { drops };

  let mod: Record<string, unknown> = {};
  try {
    mod = await importModuleFresh(filePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load existing functions deployment config at ${filePath}: ${reason}`);
  }

  const dropsCandidate = mod.FUNCTIONS_DROPS;
  if (dropsCandidate && typeof dropsCandidate === 'object' && !Array.isArray(dropsCandidate)) {
    Object.values(dropsCandidate as Record<string, unknown>).forEach((value) => {
      const normalized = normalizeFunctionsDropForRegistry(value);
      if (!normalized) return;
      drops[normalized.dropId] = normalized;
    });
  }

  if (!Object.keys(drops).length) {
    const legacy = mod.FUNCTIONS_DEPLOYMENT || mod.DEPLOYMENT || mod.default;
    const normalized = normalizeFunctionsDropForRegistry(legacy);
    if (normalized) drops[normalized.dropId] = normalized;
  }

  return { drops };
}

function renderFigureMediaConfigLiteral(config: FigureMediaConfigSerialized, indent = '    '): string {
  const lines = [`${indent}figureMedia: {`];
  if (config.strategy) {
    lines.push(`${indent}  strategy: ${tsStringLiteral(config.strategy)},`);
  }
  if (typeof config.count === 'number' && Number.isFinite(config.count) && config.count > 0) {
    lines.push(`${indent}  count: ${Math.floor(config.count)},`);
  }
  const overrideEntries = Object.entries(config.overrides || {})
    .map(([figureId, mediaId]) => [Math.floor(Number(figureId)), Math.floor(Number(mediaId))] as const)
    .filter(([figureId, mediaId]) => Number.isFinite(figureId) && figureId > 0 && Number.isFinite(mediaId) && mediaId > 0)
    .sort((a, b) => a[0] - b[0]);
  if (overrideEntries.length) {
    lines.push(`${indent}  overrides: {`);
    overrideEntries.forEach(([figureId, mediaId]) => {
      lines.push(`${indent}    ${figureId}: ${mediaId},`);
    });
    lines.push(`${indent}  },`);
  }
  lines.push(`${indent}},`);
  return lines.join('\n');
}

function renderMintSelectionConfigLiteral(config: MintSelectionConfigSerialized, indent = '    '): string {
  const lines = [`${indent}mintSelection: {`, `${indent}  kind: ${tsStringLiteral(config.kind)},`, `${indent}  options: [`];
  config.options.forEach((option) => {
    lines.push(`${indent}    {`);
    lines.push(`${indent}      key: ${tsStringLiteral(option.key)},`);
    lines.push(`${indent}      label: ${tsStringLiteral(option.label)},`);
    lines.push(`${indent}      startId: ${Math.floor(Number(option.startId))},`);
    lines.push(`${indent}      endId: ${Math.floor(Number(option.endId))},`);
    lines.push(`${indent}    },`);
  });
  lines.push(`${indent}  ],`);
  lines.push(`${indent}},`);
  return lines.join('\n');
}

function renderOptionalBoxMinterConfigPdaLine(boxMinterConfigPda?: string): string {
  return boxMinterConfigPda ? `    boxMinterConfigPda: ${tsStringLiteral(boxMinterConfigPda)},\n` : '';
}

function renderSharedProgramConfigPdaAssertion(registryName: string, registryLabel: string): string {
  return [
    `function assertSharedProgramDropsUseExplicitConfigPdas<`,
    `  T extends { dropId: string; solanaCluster: SolanaCluster; boxMinterProgramId: string; boxMinterConfigPda?: string },`,
    `>(drops: Record<string, T>, registryLabel: string): void {`,
    `  const counts = new Map<string, number>();`,
    `  Object.values(drops).forEach((drop) => {`,
    '    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;',
    `    counts.set(key, (counts.get(key) || 0) + 1);`,
    `  });`,
    `  Object.values(drops).forEach((drop) => {`,
    '    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;',
    `    if ((counts.get(key) || 0) < 2) return;`,
    `    if (String(drop.boxMinterConfigPda || '').trim()) return;`,
    `    throw new Error(`,
    '      `${registryLabel} drop ${drop.dropId} shares program ${drop.boxMinterProgramId} on ${drop.solanaCluster} and must set boxMinterConfigPda.`,',
    `    );`,
    `  });`,
    `}`,
    ``,
    `assertSharedProgramDropsUseExplicitConfigPdas(${registryName}, ${tsStringLiteral(registryLabel)});`,
  ].join('\n');
}

function renderFrontendDropEntry(drop: FrontendDropConfigSerialized): string {
  const stripeCheckoutEnabledLine = drop.stripeCheckoutEnabled ? `    stripeCheckoutEnabled: true,\n` : '';
  const stripeLiveUnitAmountCentsLine =
    drop.stripeLiveUnitAmountCents != null
      ? `    stripeLiveUnitAmountCents: ${Math.floor(Number(drop.stripeLiveUnitAmountCents))},\n`
      : '';
  return `  ${tsStringLiteral(drop.dropId)}: createFrontendDrop({
    solanaCluster: ${tsStringLiteral(drop.solanaCluster)},
    dropId: ${tsStringLiteral(drop.dropId)},
    dropFamily: ${tsStringLiteral(drop.dropFamily)},
    collectionName: ${tsStringLiteral(drop.collectionName)},

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: ${tsStringLiteral(drop.metadataBase)},
    metadataPathFormat: ${tsStringLiteral(drop.metadataPathFormat)},
${drop.secondaryMarketHref ? `    secondaryMarketHref: ${tsStringLiteral(drop.secondaryMarketHref)},\n` : ''}${drop.forceSoldOut ? `    forceSoldOut: true,\n` : ''}${drop.figureMedia ? `${renderFigureMediaConfigLiteral(drop.figureMedia)}\n` : ''}${drop.mintSelection ? `${renderMintSelectionConfigLiteral(drop.mintSelection)}\n` : ''}

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: ${tsStringLiteral(drop.treasury)},
    priceSol: ${Number(drop.priceSol)},
    discountPriceSol: ${Number(drop.discountPriceSol)},
${stripeCheckoutEnabledLine}${stripeLiveUnitAmountCentsLine}    discountMintsPerWallet: ${Math.floor(Number(drop.discountMintsPerWallet))},
    discountMerkleRoot: ${tsStringLiteral(drop.discountMerkleRoot)},
    maxSupply: ${Math.floor(Number(drop.maxSupply))},
    itemsPerBox: ${Math.floor(Number(drop.itemsPerBox))},
    maxPerTx: ${Math.floor(Number(drop.maxPerTx))},
    namePrefix: ${tsStringLiteral(drop.namePrefix)},
    figureNamePrefix: ${tsStringLiteral(drop.figureNamePrefix)},
    symbol: ${tsStringLiteral(drop.symbol)},

    // On-chain ids
    boxMinterProgramId: ${tsStringLiteral(drop.boxMinterProgramId)},
${renderOptionalBoxMinterConfigPdaLine(drop.boxMinterConfigPda)}    collectionMint: ${tsStringLiteral(drop.collectionMint)},
  }),`;
}

function renderFunctionsDropEntry(drop: FunctionsDropConfigSerialized): string {
  const stripeCheckoutEnabledLine = drop.stripeCheckoutEnabled ? `    stripeCheckoutEnabled: true,\n` : '';
  const stripeLiveUnitAmountCentsLine =
    drop.stripeLiveUnitAmountCents != null
      ? `    stripeLiveUnitAmountCents: ${Math.floor(Number(drop.stripeLiveUnitAmountCents))},\n`
      : '';
  const stripeProductTaxCodeLine = drop.stripeProductTaxCode
    ? `    stripeProductTaxCode: ${tsStringLiteral(drop.stripeProductTaxCode)},\n`
    : '';
  return `  ${tsStringLiteral(drop.dropId)}: createFunctionsDrop({
    solanaCluster: ${tsStringLiteral(drop.solanaCluster)},
    dropId: ${tsStringLiteral(drop.dropId)},
    dropFamily: ${tsStringLiteral(drop.dropFamily)},
    collectionName: ${tsStringLiteral(drop.collectionName)},

    // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
    metadataBase: ${tsStringLiteral(drop.metadataBase)},
    metadataPathFormat: ${tsStringLiteral(drop.metadataPathFormat)},
${drop.mintSelection ? `${renderMintSelectionConfigLiteral(drop.mintSelection)}\n` : ''}

    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: ${tsStringLiteral(drop.treasury)},
    priceSol: ${Number(drop.priceSol)},
    discountPriceSol: ${Number(drop.discountPriceSol)},
${stripeCheckoutEnabledLine}${stripeLiveUnitAmountCentsLine}${stripeProductTaxCodeLine}    discountMintsPerWallet: ${Math.floor(Number(drop.discountMintsPerWallet))},
    discountMerkleRoot: ${tsStringLiteral(drop.discountMerkleRoot)},
    maxSupply: ${Math.floor(Number(drop.maxSupply))},
    itemsPerBox: ${Math.floor(Number(drop.itemsPerBox))},
    maxPerTx: ${Math.floor(Number(drop.maxPerTx))},
    namePrefix: ${tsStringLiteral(drop.namePrefix)},
    figureNamePrefix: ${tsStringLiteral(drop.figureNamePrefix)},
    symbol: ${tsStringLiteral(drop.symbol)},

    // On-chain ids
    boxMinterProgramId: ${tsStringLiteral(drop.boxMinterProgramId)},
${renderOptionalBoxMinterConfigPdaLine(drop.boxMinterConfigPda)}    collectionMint: ${tsStringLiteral(drop.collectionMint)},
    receiptsMerkleTree: ${tsStringLiteral(drop.receiptsMerkleTree)},
    deliveryLookupTable: ${tsStringLiteral(drop.deliveryLookupTable)},
  }),`;
}

export function renderFrontendDeploymentRegistrySection(args: {
  drops: Record<string, FrontendDropConfigSerialized>;
}): string {
  const dropIds = Object.keys(args.drops).sort((a, b) => a.localeCompare(b));
  const entries = dropIds.map((dropId) => renderFrontendDropEntry(args.drops[dropId])).join('\n');
  return `${FRONTEND_DEPLOYMENT_REGISTRY_START}
export const FRONTEND_DROPS: FrontendDropsMap = {
${entries}
};
${FRONTEND_DEPLOYMENT_REGISTRY_END}`;
}

export function renderFrontendDeploymentRegistryFile(args: {
  drops: Record<string, FrontendDropConfigSerialized>;
}): string {
  const registrySection = renderFrontendDeploymentRegistrySection(args);
  return `/**
 * Frontend deployment constants (COMMITTED).
 *
 * This file is intended to be updated by \`scripts/deploy-all-onchain.ts\` (\`npm run deploy-all-onchain -- <dropId>\`) after
 * an on-chain deployment.
 * Manual edits outside the auto-generated registry section are preserved.
 *
 * Secrets:
 * - Do NOT put secrets here.
 * - \`VITE_HELIUS_API_KEY\` and \`VITE_FIREBASE_API_KEY\` may be provided via env to
 *   override the bundled frontend defaults in \`src/lib/helius.ts\` and \`src/lib/firebase.ts\`.
 */

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
export type DropFamily = 'default' | 'little_swag_boxes' | 'poncho_drifella' | 'little_swag_hoodies';
export type MetadataPathFormat = 'legacy' | 'compact';

export type FigureMediaStrategy = 'direct' | 'cyclic';

export type FigureMediaConfig = {
  strategy?: FigureMediaStrategy;
  count?: number;
  overrides?: Record<number, number>;
};

export type MintSelectionOption = {
  key: string;
  label: string;
  startId: number;
  endId: number;
};

export type MintSelectionConfig = {
  kind: 'size';
  options: MintSelectionOption[];
};

export type FrontendDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;

  // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  secondaryMarketHref?: string;
  figureMedia?: FigureMediaConfig;
  forceSoldOut?: boolean;
  mintSelection?: MintSelectionConfig;

  // Drop config (kept in sync with on-chain config; useful for UI defaults)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  discountMintsPerWallet: number;
  discountMerkleRoot: string;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;

  // On-chain ids
  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
  collectionMint: string;

  // Canonical derived drop paths (avoid duplicating URL strings).
  paths: DropPaths;
};

// Backward-compatible type alias.
export type FrontendDeploymentConfig = FrontendDropConfig;

export type FrontendDropsMap = Record<string, FrontendDropConfig>;

export type SecondaryMarketplaceKey = 'magiceden' | 'tensor';

export type SecondaryMarketplaceLink = {
  key: SecondaryMarketplaceKey;
  label: string;
  href: string;
};

export type DropPaths = {
  /** Normalized drop base (no trailing slash). */
  base: string;
  collectionJson: string;
  boxesJsonBase: string;
  figuresJsonBase: string;
  receiptsBoxesJsonBase: string;
  receiptsFiguresJsonBase: string;
};

export const DROP_METADATA_IPFS_GATEWAY = 'https://dweb.link/ipfs/';
const IPFS_PROTOCOL = 'ipfs://';
const RAW_CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const BASE32_LOOKUP: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Array.from(BASE32_ALPHABET).map((char, index) => [char, index] as const)),
);

function trimTrailingSlashes(value: string): string {
  return value.replace(/\\/+$/, '');
}

function normalizeMetadataPathFormat(value: unknown, fallback: MetadataPathFormat = 'legacy'): MetadataPathFormat {
  return value === 'compact' || value === 'legacy' ? value : fallback;
}

function decodeBase32Lower(value: string): Uint8Array | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    const digit = BASE32_LOOKUP[char];
    if (typeof digit !== 'number') return null;
    buffer = (buffer << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

function readUvarint(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < bytes.length; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return { value, nextOffset: index + 1 };
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

function isRawCidV1(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized.startsWith('b')) return false;
  const bytes = decodeBase32Lower(normalized.slice(1));
  if (!bytes?.length) return false;

  const version = readUvarint(bytes, 0);
  if (!version || version.value !== 1) return false;
  const codec = readUvarint(bytes, version.nextOffset);
  if (!codec) return false;
  const multihashCode = readUvarint(bytes, codec.nextOffset);
  if (!multihashCode) return false;
  const multihashLength = readUvarint(bytes, multihashCode.nextOffset);
  if (!multihashLength || multihashLength.value < 1) return false;
  return bytes.length === multihashLength.nextOffset + multihashLength.value;
}

function isRawIpfsCid(value: string): boolean {
  return RAW_CID_V0_RE.test(value) || isRawCidV1(value);
}

function normalizeIpfsProtocolUrl(value: string): string {
  const trimmed = trimTrailingSlashes(String(value || '').trim());
  if (!trimmed) return '';
  if (!trimmed.toLowerCase().startsWith(IPFS_PROTOCOL)) return trimmed;
  const withoutProtocol = trimmed.slice(IPFS_PROTOCOL.length).replace(/^ipfs\\//i, '');
  return \`\${IPFS_PROTOCOL}\${withoutProtocol.replace(/^\\/+/, '')}\`;
}

export function normalizeDropBase(base: string): string {
  // Accept either \`https://...\`, \`ipfs://...\`, or a raw CID like \`bafy...\`.
  const trimmed = trimTrailingSlashes(String(base || '').trim());
  if (!trimmed) return '';
  if (isRawIpfsCid(trimmed)) return \`\${IPFS_PROTOCOL}\${trimmed}\`;
  return normalizeIpfsProtocolUrl(trimmed);
}

export function canonicalizeDropAssetUrl(url: string): string {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  const normalizedIpfs = normalizeIpfsProtocolUrl(trimmed);
  if (normalizedIpfs.toLowerCase().startsWith(IPFS_PROTOCOL)) return normalizedIpfs;

  try {
    const parsed = new URL(trimmed);
    const hostMatch = parsed.hostname.match(/^([^./]+)\\.ipfs\\./i);
    if (hostMatch?.[1]) {
      return \`\${IPFS_PROTOCOL}\${hostMatch[1]}\${trimTrailingSlashes(parsed.pathname)}\${parsed.search}\${parsed.hash}\`;
    }
    const pathMatch = parsed.pathname.match(/^\\/ipfs\\/([^/]+)(\\/.*)?$/i);
    if (pathMatch?.[1]) {
      return \`\${IPFS_PROTOCOL}\${pathMatch[1]}\${trimTrailingSlashes(pathMatch[2] || '')}\${parsed.search}\${parsed.hash}\`;
    }
  } catch {
    // Non-URL strings should pass through unchanged.
  }

  return trimmed;
}

export function resolveDropAssetUrl(url: string): string {
  const canonical = canonicalizeDropAssetUrl(url);
  if (!canonical.toLowerCase().startsWith(IPFS_PROTOCOL)) return canonical;
  const path = canonical.slice(IPFS_PROTOCOL.length).replace(/^\\/+/, '');
  return \`\${DROP_METADATA_IPFS_GATEWAY}\${path}\`;
}

export function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

const DROP_FAMILY_BY_DROP_ID: Record<string, Exclude<DropFamily, 'default'>> = {
  little_swag_boxes: 'little_swag_boxes',
  little_swag_boxes_devnet: 'little_swag_boxes',
  poncho_drifella: 'poncho_drifella',
};

export function defaultDropFamilyForDropId(dropId: string): DropFamily {
  const normalizedDropId = normalizeDropId(dropId);
  return DROP_FAMILY_BY_DROP_ID[normalizedDropId] || 'default';
}

export function normalizeDropFamily(value: unknown, dropId?: string): DropFamily {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'little_swag_boxes' ||
    normalized === 'little_swag_hoodies' ||
    normalized === 'poncho_drifella' ||
    normalized === 'default'
  ) {
    return normalized as DropFamily;
  }
  return defaultDropFamilyForDropId(dropId || '');
}

function normalizeOptionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed || undefined;
}

const MAGIC_EDEN_MARKETPLACE_HREF_OVERRIDES: Record<string, string> = {
  little_swag_boxes: 'https://magiceden.io/marketplace/little_swag_boxes',
  poncho_drifella: 'https://magiceden.io/marketplace/poncho_drifella',
};

const TENSOR_MARKETPLACE_HREF_OVERRIDES: Record<string, string> = {
  little_swag_boxes: 'https://www.tensor.trade/trade/little_swag_boxes',
  poncho_drifella: 'https://www.tensor.trade/trade/poncho_drifella',
};

const FORCE_SOLD_OUT_DROP_OVERRIDES: Record<string, true> = {
  poncho_drifella: true,
};

function normalizeDiscountMintsPerWallet(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) return 1;
  return parsed;
}

function defaultSecondaryMarketHref(dropId: string): string | undefined {
  return secondaryMarketplaceLinksForDropId(dropId).find((link) => link.key === 'tensor')?.href;
}

export function secondaryMarketplaceLinksForDropId(dropId: string): SecondaryMarketplaceLink[] {
  const normalizedDropId = normalizeDropId(dropId);
  if (!normalizedDropId) return [];
  return [
    {
      key: 'magiceden',
      label: 'Magic Eden',
      href: MAGIC_EDEN_MARKETPLACE_HREF_OVERRIDES[normalizedDropId] || \`https://magiceden.io/marketplace/\${normalizedDropId}\`,
    },
    {
      key: 'tensor',
      label: 'Tensor',
      href: TENSOR_MARKETPLACE_HREF_OVERRIDES[normalizedDropId] || \`https://www.tensor.trade/trade/\${normalizedDropId}\`,
    },
  ];
}

function defaultForceSoldOutForDropId(dropId: string): boolean {
  const normalizedDropId = normalizeDropId(dropId);
  return FORCE_SOLD_OUT_DROP_OVERRIDES[normalizedDropId] === true;
}

function normalizeFigureMediaConfig(raw: FigureMediaConfig | undefined): FigureMediaConfig | undefined {
  if (!raw) return undefined;
  const strategy = raw.strategy === 'cyclic' ? 'cyclic' : raw.strategy === 'direct' ? 'direct' : undefined;
  const countRaw = Number(raw.count);
  const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.floor(countRaw) : undefined;
  const overrideEntries = Object.entries(raw.overrides || {}).flatMap(([figureIdRaw, mediaIdRaw]) => {
    const figureId = Math.floor(Number(figureIdRaw));
    const mediaId = Math.floor(Number(mediaIdRaw));
    if (!Number.isFinite(figureId) || figureId <= 0) return [];
    if (!Number.isFinite(mediaId) || mediaId <= 0) return [];
    return [[figureId, mediaId] as const];
  });
  const overrides = overrideEntries.length ? Object.fromEntries(overrideEntries) : undefined;
  if (!strategy && !count && !overrides) return undefined;
  return {
    ...(strategy ? { strategy } : {}),
    ...(count ? { count } : {}),
    ...(overrides ? { overrides } : {}),
  };
}

function normalizeMintSelectionConfig(raw: MintSelectionConfig | undefined): MintSelectionConfig | undefined {
  if (!raw || raw.kind !== 'size' || !Array.isArray(raw.options)) return undefined;
  const options = raw.options.flatMap((entry) => {
    const key = String(entry?.key || '').trim();
    const label = String(entry?.label || key).trim();
    const startId = Math.floor(Number(entry?.startId));
    const endId = Math.floor(Number(entry?.endId));
    if (!key || !label || !Number.isFinite(startId) || !Number.isFinite(endId) || startId < 1 || endId < startId) {
      return [];
    }
    return [{ key, label, startId, endId }];
  });
  if (options.length !== 3) return undefined;
  return {
    kind: 'size',
    options,
  };
}

const LITTLE_SWAG_BOXES_FIGURE_MEDIA: FigureMediaConfig = {
  strategy: 'cyclic',
  count: 333,
  overrides: {
    344: 1,
    353: 90,
    360: 3,
    505: 163,
    650: 285,
    660: 13,
    661: 206,
    662: 82,
    663: 175,
    664: 19,
    665: 92,
    666: 86,
    677: 1,
    686: 90,
    693: 3,
    838: 163,
    983: 285,
    993: 49,
    994: 206,
    995: 21,
    996: 175,
    997: 19,
    998: 92,
    999: 86,
  },
};

function defaultFigureMediaConfigForDropFamily(dropFamily: DropFamily): FigureMediaConfig | undefined {
  if (dropFamily !== 'little_swag_boxes') return undefined;
  return normalizeFigureMediaConfig(LITTLE_SWAG_BOXES_FIGURE_MEDIA);
}

export function dropPathsFromBase(dropBase: string, metadataPathFormat: MetadataPathFormat = 'compact'): DropPaths {
  const base = normalizeDropBase(dropBase);
  if (metadataPathFormat === 'legacy') {
    return {
      base,
      collectionJson: \`\${base}/collection.json\`,
      boxesJsonBase: \`\${base}/json/boxes/\`,
      figuresJsonBase: \`\${base}/json/figures/\`,
      receiptsBoxesJsonBase: \`\${base}/json/receipts/boxes/\`,
      receiptsFiguresJsonBase: \`\${base}/json/receipts/figures/\`,
    };
  }
  return {
    base,
    collectionJson: \`\${base}/collection.json\`,
    boxesJsonBase: \`\${base}/b\`,
    figuresJsonBase: \`\${base}/f\`,
    receiptsBoxesJsonBase: \`\${base}/rb\`,
    receiptsFiguresJsonBase: \`\${base}/rf\`,
  };
}

function createFrontendDrop(
  config: Omit<FrontendDropConfig, 'dropId' | 'paths' | 'metadataPathFormat'> & {
    dropId: string;
    metadataPathFormat?: MetadataPathFormat;
  },
): FrontendDropConfig {
  const { stripeCheckoutEnabled: rawStripeCheckoutEnabled, ...baseConfig } = config;
  const normalizedDropId = normalizeDropId(config.dropId);
  const normalizedDropFamily = normalizeDropFamily(config.dropFamily, normalizedDropId);
  const metadataPathFormat = normalizeMetadataPathFormat(config.metadataPathFormat);
  const figureMedia = normalizeFigureMediaConfig(config.figureMedia) || defaultFigureMediaConfigForDropFamily(normalizedDropFamily);
  const forceSoldOut = config.forceSoldOut === true || defaultForceSoldOutForDropId(normalizedDropId);
  const mintSelection = normalizeMintSelectionConfig(config.mintSelection);
  const boxMinterConfigPda = normalizeOptionalString(config.boxMinterConfigPda);
  const stripeCheckoutEnabled = rawStripeCheckoutEnabled === true;
  return {
    ...baseConfig,
    dropId: normalizedDropId,
    dropFamily: normalizedDropFamily,
    metadataBase: normalizeDropBase(config.metadataBase),
    metadataPathFormat,
    secondaryMarketHref: normalizeOptionalString(config.secondaryMarketHref) || defaultSecondaryMarketHref(normalizedDropId),
    ...(figureMedia ? { figureMedia } : {}),
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    ...(mintSelection ? { mintSelection } : {}),
    figureNamePrefix: normalizeOptionalString(config.figureNamePrefix) || 'figure',
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
    ...(stripeCheckoutEnabled ? { stripeCheckoutEnabled: true } : {}),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    paths: dropPathsFromBase(config.metadataBase, metadataPathFormat),
  };
}

${registrySection}

${renderSharedProgramConfigPdaAssertion('FRONTEND_DROPS', 'Frontend deployment config')}

export function getFrontendDrop(dropId: string): FrontendDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return FRONTEND_DROPS[normalizedDropId];
}

export function dropFamilyForDrop(dropOrId?: FrontendDropConfig | string): DropFamily {
  const drop =
    typeof dropOrId === 'string'
      ? getFrontendDrop(dropOrId)
      : dropOrId && typeof dropOrId === 'object'
        ? dropOrId
        : undefined;
  const fallbackDropId = typeof dropOrId === 'string' ? dropOrId : drop?.dropId;
  return normalizeDropFamily(drop?.dropFamily, fallbackDropId);
}

export function isDropFamily(dropOrId: FrontendDropConfig | string | undefined, dropFamily: DropFamily): boolean {
  return dropFamilyForDrop(dropOrId) === dropFamily;
}

export function requireFrontendDrop(dropId: string): FrontendDropConfig {
  const found = getFrontendDrop(dropId);
  if (!found) {
    throw new Error(\`Unknown frontend dropId: \${dropId}\`);
  }
  return found;
}

export function listFrontendDrops(): FrontendDropConfig[] {
  return Object.keys(FRONTEND_DROPS)
    .sort((a, b) => a.localeCompare(b))
    .map((dropId) => FRONTEND_DROPS[dropId]);
}
`;
}

export function renderFunctionsDeploymentRegistrySection(args: {
  drops: Record<string, FunctionsDropConfigSerialized>;
}): string {
  const dropIds = Object.keys(args.drops).sort((a, b) => a.localeCompare(b));
  const entries = dropIds.map((dropId) => renderFunctionsDropEntry(args.drops[dropId])).join('\n');
  return `${FUNCTIONS_DEPLOYMENT_REGISTRY_START}
export const FUNCTIONS_DROPS: FunctionsDropsMap = {
${entries}
};
${FUNCTIONS_DEPLOYMENT_REGISTRY_END}`;
}

export function renderFunctionsDeploymentRegistryFile(args: {
  drops: Record<string, FunctionsDropConfigSerialized>;
}): string {
  const registrySection = renderFunctionsDeploymentRegistrySection(args);
  return `/**
 * Cloud Functions deployment constants (COMMITTED).
 *
 * This file is intended to be updated by \`scripts/deploy-all-onchain.ts\` (\`npm run deploy-all-onchain -- <dropId>\`) after
 * an on-chain deployment, so functions can run with minimal env usage.
 * Manual edits outside the auto-generated registry section are preserved.
 *
 * Secrets:
 * - HELIUS_API_KEY (env/runtime config)
 * - COSIGNER_SECRET (Firebase Functions secret / Google Secret Manager)
 */

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
export type DropFamily = 'default' | 'little_swag_boxes' | 'poncho_drifella' | 'little_swag_hoodies';
export type MetadataPathFormat = 'legacy' | 'compact';

export type MintSelectionOption = {
  key: string;
  label: string;
  startId: number;
  endId: number;
};

export type MintSelectionConfig = {
  kind: 'size';
  options: MintSelectionOption[];
};

export type FunctionsDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;

  // Drop metadata base (collection.json + legacy/compact metadata JSON + images/*)
  metadataBase: string;
  metadataPathFormat: MetadataPathFormat;
  mintSelection?: MintSelectionConfig;

  // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  stripeCheckoutEnabled?: boolean;
  stripeLiveUnitAmountCents?: number;
  stripeProductTaxCode?: string;
  discountMintsPerWallet: number;
  discountMerkleRoot: string;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;

  // On-chain ids
  boxMinterProgramId: string;
  boxMinterConfigPda?: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  deliveryLookupTable: string;
};

// Backward-compatible type alias.
export type FunctionsDeploymentConfig = FunctionsDropConfig;

export type FunctionsDropsMap = Record<string, FunctionsDropConfig>;

export type DropPaths = {
  /** Normalized drop base (no trailing slash). */
  base: string;
  collectionJson: string;
  boxesJsonBase: string;
  figuresJsonBase: string;
  receiptsBoxesJsonBase: string;
  receiptsFiguresJsonBase: string;
};

export const DROP_METADATA_IPFS_GATEWAY = 'https://dweb.link/ipfs/';
const IPFS_PROTOCOL = 'ipfs://';
const RAW_CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const BASE32_LOOKUP: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Array.from(BASE32_ALPHABET).map((char, index) => [char, index] as const)),
);

function trimTrailingSlashes(value: string): string {
  return value.replace(/\\/+$/, '');
}

function normalizeMetadataPathFormat(value: unknown, fallback: MetadataPathFormat = 'legacy'): MetadataPathFormat {
  return value === 'compact' || value === 'legacy' ? value : fallback;
}

function decodeBase32Lower(value: string): Uint8Array | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    const digit = BASE32_LOOKUP[char];
    if (typeof digit !== 'number') return null;
    buffer = (buffer << 5) | digit;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

function readUvarint(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < bytes.length; index += 1) {
    const byte = bytes[index];
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return { value, nextOffset: index + 1 };
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

function isRawCidV1(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized.startsWith('b')) return false;
  const bytes = decodeBase32Lower(normalized.slice(1));
  if (!bytes?.length) return false;

  const version = readUvarint(bytes, 0);
  if (!version || version.value !== 1) return false;
  const codec = readUvarint(bytes, version.nextOffset);
  if (!codec) return false;
  const multihashCode = readUvarint(bytes, codec.nextOffset);
  if (!multihashCode) return false;
  const multihashLength = readUvarint(bytes, multihashCode.nextOffset);
  if (!multihashLength || multihashLength.value < 1) return false;
  return bytes.length === multihashLength.nextOffset + multihashLength.value;
}

function isRawIpfsCid(value: string): boolean {
  return RAW_CID_V0_RE.test(value) || isRawCidV1(value);
}

function normalizeIpfsProtocolUrl(value: string): string {
  const trimmed = trimTrailingSlashes(String(value || '').trim());
  if (!trimmed) return '';
  if (!trimmed.toLowerCase().startsWith(IPFS_PROTOCOL)) return trimmed;
  const withoutProtocol = trimmed.slice(IPFS_PROTOCOL.length).replace(/^ipfs\\//i, '');
  return \`\${IPFS_PROTOCOL}\${withoutProtocol.replace(/^\\/+/, '')}\`;
}

export function normalizeDropBase(base: string): string {
  // Accept either \`https://...\`, \`ipfs://...\`, or a raw CID like \`bafy...\`.
  const trimmed = trimTrailingSlashes(String(base || '').trim());
  if (!trimmed) return '';
  if (isRawIpfsCid(trimmed)) return \`\${IPFS_PROTOCOL}\${trimmed}\`;
  return normalizeIpfsProtocolUrl(trimmed);
}

export function canonicalizeDropAssetUrl(url: string): string {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  const normalizedIpfs = normalizeIpfsProtocolUrl(trimmed);
  if (normalizedIpfs.toLowerCase().startsWith(IPFS_PROTOCOL)) return normalizedIpfs;

  try {
    const parsed = new URL(trimmed);
    const hostMatch = parsed.hostname.match(/^([^./]+)\\.ipfs\\./i);
    if (hostMatch?.[1]) {
      return \`\${IPFS_PROTOCOL}\${hostMatch[1]}\${trimTrailingSlashes(parsed.pathname)}\${parsed.search}\${parsed.hash}\`;
    }
    const pathMatch = parsed.pathname.match(/^\\/ipfs\\/([^/]+)(\\/.*)?$/i);
    if (pathMatch?.[1]) {
      return \`\${IPFS_PROTOCOL}\${pathMatch[1]}\${trimTrailingSlashes(pathMatch[2] || '')}\${parsed.search}\${parsed.hash}\`;
    }
  } catch {
    // Non-URL strings should pass through unchanged.
  }

  return trimmed;
}

export function resolveDropAssetUrl(url: string): string {
  const canonical = canonicalizeDropAssetUrl(url);
  if (!canonical.toLowerCase().startsWith(IPFS_PROTOCOL)) return canonical;
  const path = canonical.slice(IPFS_PROTOCOL.length).replace(/^\\/+/, '');
  return \`\${DROP_METADATA_IPFS_GATEWAY}\${path}\`;
}

export function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

const DROP_FAMILY_BY_DROP_ID: Record<string, Exclude<DropFamily, 'default'>> = {
  little_swag_boxes: 'little_swag_boxes',
  little_swag_boxes_devnet: 'little_swag_boxes',
  poncho_drifella: 'poncho_drifella',
};

export function defaultDropFamilyForDropId(dropId: string): DropFamily {
  const normalizedDropId = normalizeDropId(dropId);
  return DROP_FAMILY_BY_DROP_ID[normalizedDropId] || 'default';
}

export function normalizeDropFamily(value: unknown, dropId?: string): DropFamily {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'little_swag_boxes' ||
    normalized === 'little_swag_hoodies' ||
    normalized === 'poncho_drifella' ||
    normalized === 'default'
  ) {
    return normalized as DropFamily;
  }
  return defaultDropFamilyForDropId(dropId || '');
}

function normalizeDiscountMintsPerWallet(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) return 1;
  return parsed;
}

function normalizeMintSelectionConfig(raw: MintSelectionConfig | undefined): MintSelectionConfig | undefined {
  if (!raw || raw.kind !== 'size' || !Array.isArray(raw.options)) return undefined;
  const options = raw.options.flatMap((entry) => {
    const key = String(entry?.key || '').trim();
    const label = String(entry?.label || key).trim();
    const startId = Math.floor(Number(entry?.startId));
    const endId = Math.floor(Number(entry?.endId));
    if (!key || !label || !Number.isFinite(startId) || !Number.isFinite(endId) || startId < 1 || endId < startId) {
      return [];
    }
    return [{ key, label, startId, endId }];
  });
  if (options.length !== 3) return undefined;
  return {
    kind: 'size',
    options,
  };
}

export function dropPathsFromBase(dropBase: string, metadataPathFormat: MetadataPathFormat = 'compact'): DropPaths {
  const base = normalizeDropBase(dropBase);
  if (metadataPathFormat === 'legacy') {
    return {
      base,
      collectionJson: \`\${base}/collection.json\`,
      boxesJsonBase: \`\${base}/json/boxes/\`,
      figuresJsonBase: \`\${base}/json/figures/\`,
      receiptsBoxesJsonBase: \`\${base}/json/receipts/boxes/\`,
      receiptsFiguresJsonBase: \`\${base}/json/receipts/figures/\`,
    };
  }
  return {
    base,
    collectionJson: \`\${base}/collection.json\`,
    boxesJsonBase: \`\${base}/b\`,
    figuresJsonBase: \`\${base}/f\`,
    receiptsBoxesJsonBase: \`\${base}/rb\`,
    receiptsFiguresJsonBase: \`\${base}/rf\`,
  };
}

function createFunctionsDrop(
  config: Omit<FunctionsDropConfig, 'dropId' | 'metadataPathFormat'> & {
    dropId: string;
    metadataPathFormat?: MetadataPathFormat;
  },
): FunctionsDropConfig {
  const {
    stripeCheckoutEnabled: rawStripeCheckoutEnabled,
    stripeProductTaxCode: rawStripeProductTaxCode,
    ...baseConfig
  } = config;
  const normalizedDropId = normalizeDropId(config.dropId);
  const normalizedDropFamily = normalizeDropFamily(config.dropFamily, normalizedDropId);
  const metadataPathFormat = normalizeMetadataPathFormat(config.metadataPathFormat);
  const mintSelection = normalizeMintSelectionConfig(config.mintSelection);
  const boxMinterConfigPda = String(config.boxMinterConfigPda || '').trim();
  const stripeCheckoutEnabled = rawStripeCheckoutEnabled === true;
  const stripeProductTaxCode = String(rawStripeProductTaxCode || '').trim();
  return {
    ...baseConfig,
    dropId: normalizedDropId,
    dropFamily: normalizedDropFamily,
    metadataBase: normalizeDropBase(config.metadataBase),
    metadataPathFormat,
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    ...(mintSelection ? { mintSelection } : {}),
    ...(stripeCheckoutEnabled ? { stripeCheckoutEnabled: true } : {}),
    ...(stripeProductTaxCode ? { stripeProductTaxCode } : {}),
    figureNamePrefix: String(config.figureNamePrefix || '').trim() || 'figure',
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
  };
}

${registrySection}

${renderSharedProgramConfigPdaAssertion('FUNCTIONS_DROPS', 'Functions deployment config')}

export function getFunctionsDrop(dropId: string): FunctionsDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return FUNCTIONS_DROPS[normalizedDropId];
}

export function requireFunctionsDrop(dropId: string): FunctionsDropConfig {
  const found = getFunctionsDrop(dropId);
  if (!found) {
    throw new Error(\`Unknown functions dropId: \${dropId}\`);
  }
  return found;
}

export function listFunctionsDrops(): FunctionsDropConfig[] {
  return Object.keys(FUNCTIONS_DROPS)
    .sort((a, b) => a.localeCompare(b))
    .map((dropId) => FUNCTIONS_DROPS[dropId]);
}
`;
}

export function replaceMarkedSection(args: {
  filePath: string;
  existingContent: string;
  startMarker: string;
  endMarker: string;
  nextSection: string;
}): string | undefined {
  const start = args.existingContent.indexOf(args.startMarker);
  const end = args.existingContent.indexOf(args.endMarker);
  if (start === -1 && end === -1) return undefined;
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Malformed auto-generated section markers in ${args.filePath}`);
  }

  const sectionStart = args.existingContent.lastIndexOf('\n', start);
  const prefixEnd = sectionStart === -1 ? 0 : sectionStart + 1;
  const sectionEndLine = args.existingContent.indexOf('\n', end);
  const suffixStart = sectionEndLine === -1 ? args.existingContent.length : sectionEndLine + 1;
  const nextSection = args.nextSection.endsWith('\n') ? args.nextSection : `${args.nextSection}\n`;
  return `${args.existingContent.slice(0, prefixEnd)}${nextSection}${args.existingContent.slice(suffixStart)}`;
}

export function writeTextFileIfChanged(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const next = content.endsWith('\n') ? content : `${content}\n`;
  const prev = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  if (prev === next) return;
  writeFileSync(filePath, next, 'utf8');
}

export function writeFrontendDeploymentRegistryFile(args: {
  filePath: string;
  drops: Record<string, FrontendDropConfigSerialized>;
}): void {
  const prevContent = existsSync(args.filePath) ? readFileSync(args.filePath, 'utf8') : '';
  const section = renderFrontendDeploymentRegistrySection({ drops: args.drops });
  const content =
    replaceMarkedSection({
      filePath: args.filePath,
      existingContent: prevContent,
      startMarker: FRONTEND_DEPLOYMENT_REGISTRY_START,
      endMarker: FRONTEND_DEPLOYMENT_REGISTRY_END,
      nextSection: section,
    }) || renderFrontendDeploymentRegistryFile({ drops: args.drops });
  writeTextFileIfChanged(args.filePath, content);
}

export function writeFunctionsDeploymentRegistryFile(args: {
  filePath: string;
  drops: Record<string, FunctionsDropConfigSerialized>;
}): void {
  const prevContent = existsSync(args.filePath) ? readFileSync(args.filePath, 'utf8') : '';
  const section = renderFunctionsDeploymentRegistrySection({ drops: args.drops });
  const content =
    replaceMarkedSection({
      filePath: args.filePath,
      existingContent: prevContent,
      startMarker: FUNCTIONS_DEPLOYMENT_REGISTRY_START,
      endMarker: FUNCTIONS_DEPLOYMENT_REGISTRY_END,
      nextSection: section,
    }) || renderFunctionsDeploymentRegistryFile({ drops: args.drops });
  writeTextFileIfChanged(args.filePath, content);
}
