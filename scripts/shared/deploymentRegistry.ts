import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export type FigureMediaConfigSerialized = {
  strategy?: 'direct' | 'cyclic';
  count?: number;
  overrides?: Record<number, number>;
};

export type FrontendDropConfigSerialized = {
  solanaCluster: string;
  dropId: string;
  collectionName: string;
  metadataBase: string;
  secondaryMarketHref?: string;
  figureMedia?: FigureMediaConfigSerialized;
  forceSoldOut?: boolean;
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  discountMintsPerWallet: number;
  discountMerkleRoot: string;
  maxSupply: number;
  itemsPerBox: number;
  maxPerTx: number;
  namePrefix: string;
  figureNamePrefix: string;
  symbol: string;
  boxMinterProgramId: string;
  collectionMint: string;
};

export type FunctionsDropConfigSerialized = FrontendDropConfigSerialized & {
  receiptsMerkleTree: string;
  deliveryLookupTable: string;
};

export type FrontendDropRegistry = {
  defaultDropId: string | undefined;
  drops: Record<string, FrontendDropConfigSerialized>;
};

export type FunctionsDropRegistry = {
  defaultDropId: string | undefined;
  drops: Record<string, FunctionsDropConfigSerialized>;
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

export function normalizeDropBase(base: string): string {
  return String(base || '').replace(/\/+$/, '');
}

export function normalizeDropId(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

const SECONDARY_MARKET_HREF_OVERRIDES: Record<string, string> = {
  poncho_drifella: 'https://www.tensor.trade/trade/poncho_drifella',
};

const FORCE_SOLD_OUT_DROP_OVERRIDES: Record<string, true> = {
  poncho_drifella: true,
};

function defaultSecondaryMarketHref(dropId: string): string | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  const overrideHref = SECONDARY_MARKET_HREF_OVERRIDES[normalizedDropId];
  if (overrideHref) return overrideHref;
  return normalizedDropId ? `https://www.tensor.trade/trade/${normalizedDropId}` : undefined;
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

// Keep family variants such as little_swag_boxes_devnet aligned with the canonical media ids.
const LITTLE_SWAG_BOXES_DROP_ID_PREFIX = 'little_swag_boxes';
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

function isLittleSwagBoxesFamilyDropId(dropId: string): boolean {
  const normalizedDropId = normalizeDropId(dropId);
  return normalizedDropId === LITTLE_SWAG_BOXES_DROP_ID_PREFIX || normalizedDropId.startsWith(`${LITTLE_SWAG_BOXES_DROP_ID_PREFIX}_`);
}

export function defaultFrontendFigureMediaForDropId(dropId: string): FigureMediaConfigSerialized | undefined {
  if (!isLittleSwagBoxesFamilyDropId(dropId)) return undefined;
  return normalizeFigureMediaConfigForRegistry(LITTLE_SWAG_BOXES_FIGURE_MEDIA);
}

function normalizeFrontendDropForRegistry(raw: unknown): FrontendDropConfigSerialized | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const dropId = normalizeDropId(asTrimmedString(obj.dropId));
  if (!dropId) return undefined;
  const metadataBase = asTrimmedString(obj.metadataBase) || asTrimmedString((obj.paths as any)?.base);
  const secondaryMarketHref = asTrimmedString(obj.secondaryMarketHref);
  const defaultMarketHref = defaultSecondaryMarketHref(dropId);
  const figureMedia = normalizeFigureMediaConfigForRegistry(obj.figureMedia) || defaultFrontendFigureMediaForDropId(dropId);
  const forceSoldOut = obj.forceSoldOut === true || defaultFrontendForceSoldOutForDropId(dropId);
  return {
    solanaCluster: asTrimmedString(obj.solanaCluster),
    dropId,
    collectionName: asTrimmedString(obj.collectionName) || dropId,
    metadataBase: normalizeDropBase(metadataBase),
    ...(secondaryMarketHref && secondaryMarketHref !== defaultMarketHref ? { secondaryMarketHref } : {}),
    ...(figureMedia ? { figureMedia } : {}),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    treasury: asTrimmedString(obj.treasury),
    priceSol: asFiniteNumber(obj.priceSol),
    discountPriceSol: asFiniteNumber(obj.discountPriceSol),
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(obj.discountMintsPerWallet),
    discountMerkleRoot: asTrimmedString(obj.discountMerkleRoot),
    maxSupply: Math.floor(asFiniteNumber(obj.maxSupply)),
    itemsPerBox: Math.floor(asFiniteNumber(obj.itemsPerBox)),
    maxPerTx: Math.floor(asFiniteNumber(obj.maxPerTx)),
    namePrefix: asTrimmedString(obj.namePrefix),
    figureNamePrefix: asTrimmedString(obj.figureNamePrefix) || 'figure',
    symbol: asTrimmedString(obj.symbol),
    boxMinterProgramId: asTrimmedString(obj.boxMinterProgramId),
    collectionMint: asTrimmedString(obj.collectionMint),
  };
}

function normalizeFunctionsDropForRegistry(raw: unknown): FunctionsDropConfigSerialized | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const frontendShape = normalizeFrontendDropForRegistry(raw);
  if (!frontendShape) return undefined;
  return {
    ...frontendShape,
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
  if (!existsSync(filePath)) return { defaultDropId: undefined, drops };

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

  const defaultDropIdRaw = asTrimmedString(mod.FRONTEND_DEFAULT_DROP_ID);
  const defaultDropId = normalizeDropId(defaultDropIdRaw || Object.keys(drops)[0] || '');
  return { defaultDropId: defaultDropId || undefined, drops };
}

export async function readFunctionsDropRegistry(filePath: string): Promise<FunctionsDropRegistry> {
  const drops: Record<string, FunctionsDropConfigSerialized> = {};
  if (!existsSync(filePath)) return { defaultDropId: undefined, drops };

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

  const defaultDropIdRaw = asTrimmedString(mod.FUNCTIONS_DEFAULT_DROP_ID);
  const defaultDropId = normalizeDropId(defaultDropIdRaw || Object.keys(drops)[0] || '');
  return { defaultDropId: defaultDropId || undefined, drops };
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

function renderFrontendDropEntry(drop: FrontendDropConfigSerialized): string {
  return `  ${tsStringLiteral(drop.dropId)}: createFrontendDrop({
    solanaCluster: ${tsStringLiteral(drop.solanaCluster)},
    dropId: ${tsStringLiteral(drop.dropId)},
    collectionName: ${tsStringLiteral(drop.collectionName)},

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: ${tsStringLiteral(drop.metadataBase)},
${drop.secondaryMarketHref ? `    secondaryMarketHref: ${tsStringLiteral(drop.secondaryMarketHref)},\n` : ''}${drop.forceSoldOut ? `    forceSoldOut: true,\n` : ''}${drop.figureMedia ? `${renderFigureMediaConfigLiteral(drop.figureMedia)}\n` : ''}

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: ${tsStringLiteral(drop.treasury)},
    priceSol: ${Number(drop.priceSol)},
    discountPriceSol: ${Number(drop.discountPriceSol)},
    discountMintsPerWallet: ${Math.floor(Number(drop.discountMintsPerWallet))},
    discountMerkleRoot: ${tsStringLiteral(drop.discountMerkleRoot)},
    maxSupply: ${Math.floor(Number(drop.maxSupply))},
    itemsPerBox: ${Math.floor(Number(drop.itemsPerBox))},
    maxPerTx: ${Math.floor(Number(drop.maxPerTx))},
    namePrefix: ${tsStringLiteral(drop.namePrefix)},
    figureNamePrefix: ${tsStringLiteral(drop.figureNamePrefix)},
    symbol: ${tsStringLiteral(drop.symbol)},

    // On-chain ids
    boxMinterProgramId: ${tsStringLiteral(drop.boxMinterProgramId)},
    collectionMint: ${tsStringLiteral(drop.collectionMint)},
  }),`;
}

function renderFunctionsDropEntry(drop: FunctionsDropConfigSerialized): string {
  return `  ${tsStringLiteral(drop.dropId)}: createFunctionsDrop({
    solanaCluster: ${tsStringLiteral(drop.solanaCluster)},
    dropId: ${tsStringLiteral(drop.dropId)},
    collectionName: ${tsStringLiteral(drop.collectionName)},

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: ${tsStringLiteral(drop.metadataBase)},

    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: ${tsStringLiteral(drop.treasury)},
    priceSol: ${Number(drop.priceSol)},
    discountPriceSol: ${Number(drop.discountPriceSol)},
    discountMintsPerWallet: ${Math.floor(Number(drop.discountMintsPerWallet))},
    discountMerkleRoot: ${tsStringLiteral(drop.discountMerkleRoot)},
    maxSupply: ${Math.floor(Number(drop.maxSupply))},
    itemsPerBox: ${Math.floor(Number(drop.itemsPerBox))},
    maxPerTx: ${Math.floor(Number(drop.maxPerTx))},
    namePrefix: ${tsStringLiteral(drop.namePrefix)},
    figureNamePrefix: ${tsStringLiteral(drop.figureNamePrefix)},
    symbol: ${tsStringLiteral(drop.symbol)},

    // On-chain ids
    boxMinterProgramId: ${tsStringLiteral(drop.boxMinterProgramId)},
    collectionMint: ${tsStringLiteral(drop.collectionMint)},
    receiptsMerkleTree: ${tsStringLiteral(drop.receiptsMerkleTree)},
    deliveryLookupTable: ${tsStringLiteral(drop.deliveryLookupTable)},
  }),`;
}

export function renderFrontendDeploymentRegistrySection(args: {
  defaultDropId: string;
  drops: Record<string, FrontendDropConfigSerialized>;
}): string {
  const dropIds = Object.keys(args.drops).sort((a, b) => a.localeCompare(b));
  const entries = dropIds.map((dropId) => renderFrontendDropEntry(args.drops[dropId])).join('\n');
  return `${FRONTEND_DEPLOYMENT_REGISTRY_START}
export const FRONTEND_DEFAULT_DROP_ID = ${tsStringLiteral(args.defaultDropId)};

export const FRONTEND_DROPS: FrontendDropsMap = {
${entries}
};
${FRONTEND_DEPLOYMENT_REGISTRY_END}`;
}

export function renderFrontendDeploymentRegistryFile(args: {
  defaultDropId: string;
  drops: Record<string, FrontendDropConfigSerialized>;
}): string {
  const registrySection = renderFrontendDeploymentRegistrySection(args);
  return `/**
 * Frontend deployment constants (COMMITTED).
 *
 * This file is intended to be updated by \`scripts/deploy-all-onchain.ts\` (\`npm run deploy-all-onchain\`) after
 * an on-chain deployment.
 * Manual edits outside the auto-generated registry section are preserved.
 *
 * Secrets:
 * - Do NOT put secrets here.
 * - \`VITE_HELIUS_API_KEY\` and \`VITE_FIREBASE_API_KEY\` may be provided via env to
 *   override the bundled frontend defaults in \`src/lib/helius.ts\` and \`src/lib/firebase.ts\`.
 */

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

export type FigureMediaStrategy = 'direct' | 'cyclic';

export type FigureMediaConfig = {
  strategy?: FigureMediaStrategy;
  count?: number;
  overrides?: Record<number, number>;
};

export type FrontendDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  collectionName: string;

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: string;
  secondaryMarketHref?: string;
  figureMedia?: FigureMediaConfig;
  forceSoldOut?: boolean;

  // Drop config (kept in sync with on-chain config; useful for UI defaults)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
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
  collectionMint: string;

  // Canonical derived drop paths (avoid duplicating URL strings).
  paths: DropPaths;
};

// Backward-compatible type alias.
export type FrontendDeploymentConfig = FrontendDropConfig;

export type FrontendDropsMap = Record<string, FrontendDropConfig>;

export type DropPaths = {
  /** Normalized drop base (no trailing slash). */
  base: string;
  collectionJson: string;
  boxesJsonBase: string;
  figuresJsonBase: string;
  receiptsBoxesJsonBase: string;
  receiptsFiguresJsonBase: string;
};

export function normalizeDropBase(base: string): string {
  // Allow callers to pass either \`https://.../drops/lsb\` or \`https://.../drops/lsb/\`.
  return String(base || '').replace(/\\/+$/, '');
}

export function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

function normalizeOptionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed || undefined;
}

const SECONDARY_MARKET_HREF_OVERRIDES: Record<string, string> = {
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
  const normalizedDropId = normalizeDropId(dropId);
  const overrideHref = SECONDARY_MARKET_HREF_OVERRIDES[normalizedDropId];
  if (overrideHref) return overrideHref;
  return normalizedDropId ? \`https://www.tensor.trade/trade/\${normalizedDropId}\` : undefined;
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

// Keep family variants such as little_swag_boxes_devnet aligned with the canonical media ids.
const LITTLE_SWAG_BOXES_DROP_ID_PREFIX = 'little_swag_boxes';
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

function defaultFigureMediaConfigForDropId(dropId: string): FigureMediaConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  if (normalizedDropId !== LITTLE_SWAG_BOXES_DROP_ID_PREFIX && !normalizedDropId.startsWith(LITTLE_SWAG_BOXES_DROP_ID_PREFIX + '_')) {
    return undefined;
  }
  return normalizeFigureMediaConfig(LITTLE_SWAG_BOXES_FIGURE_MEDIA);
}

export function dropPathsFromBase(dropBase: string): DropPaths {
  const base = normalizeDropBase(dropBase);
  return {
    base,
    collectionJson: \`\${base}/collection.json\`,
    boxesJsonBase: \`\${base}/json/boxes/\`,
    figuresJsonBase: \`\${base}/json/figures/\`,
    receiptsBoxesJsonBase: \`\${base}/json/receipts/boxes/\`,
    receiptsFiguresJsonBase: \`\${base}/json/receipts/figures/\`,
  };
}

function createFrontendDrop(config: Omit<FrontendDropConfig, 'dropId' | 'paths'> & { dropId: string }): FrontendDropConfig {
  const normalizedDropId = normalizeDropId(config.dropId);
  const figureMedia = normalizeFigureMediaConfig(config.figureMedia) || defaultFigureMediaConfigForDropId(normalizedDropId);
  const forceSoldOut = config.forceSoldOut === true || defaultForceSoldOutForDropId(normalizedDropId);
  return {
    ...config,
    dropId: normalizedDropId,
    metadataBase: normalizeDropBase(config.metadataBase),
    secondaryMarketHref: normalizeOptionalString(config.secondaryMarketHref) || defaultSecondaryMarketHref(normalizedDropId),
    ...(figureMedia ? { figureMedia } : {}),
    figureNamePrefix: normalizeOptionalString(config.figureNamePrefix) || 'figure',
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    paths: dropPathsFromBase(config.metadataBase),
  };
}

${registrySection}

export function getFrontendDrop(dropId: string): FrontendDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return FRONTEND_DROPS[normalizedDropId];
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

// Backward-compatible alias: always points to the default drop.
export const FRONTEND_DEPLOYMENT: FrontendDeploymentConfig = requireFrontendDrop(FRONTEND_DEFAULT_DROP_ID);
`;
}

export function renderFunctionsDeploymentRegistrySection(args: {
  defaultDropId: string;
  drops: Record<string, FunctionsDropConfigSerialized>;
}): string {
  const dropIds = Object.keys(args.drops).sort((a, b) => a.localeCompare(b));
  const entries = dropIds.map((dropId) => renderFunctionsDropEntry(args.drops[dropId])).join('\n');
  return `${FUNCTIONS_DEPLOYMENT_REGISTRY_START}
export const FUNCTIONS_DEFAULT_DROP_ID = ${tsStringLiteral(args.defaultDropId)};

export const FUNCTIONS_DROPS: FunctionsDropsMap = {
${entries}
};
${FUNCTIONS_DEPLOYMENT_REGISTRY_END}`;
}

export function renderFunctionsDeploymentRegistryFile(args: {
  defaultDropId: string;
  drops: Record<string, FunctionsDropConfigSerialized>;
}): string {
  const registrySection = renderFunctionsDeploymentRegistrySection(args);
  return `/**
 * Cloud Functions deployment constants (COMMITTED).
 *
 * This file is intended to be updated by \`scripts/deploy-all-onchain.ts\` (\`npm run deploy-all-onchain\`) after
 * an on-chain deployment, so functions can run with minimal env usage.
 * Manual edits outside the auto-generated registry section are preserved.
 *
 * Secrets:
 * - HELIUS_API_KEY (env/runtime config)
 * - COSIGNER_SECRET (Firebase Functions secret / Google Secret Manager)
 */

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

export type FunctionsDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  collectionName: string;

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: string;

  // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
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

export function normalizeDropBase(base: string): string {
  // Allow callers to pass either \`https://.../drops/lsb\` or \`https://.../drops/lsb/\`.
  return String(base || '').replace(/\\/+$/, '');
}

export function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

function normalizeDiscountMintsPerWallet(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) return 1;
  return parsed;
}

export function dropPathsFromBase(dropBase: string): DropPaths {
  const base = normalizeDropBase(dropBase);
  return {
    base,
    collectionJson: \`\${base}/collection.json\`,
    boxesJsonBase: \`\${base}/json/boxes/\`,
    figuresJsonBase: \`\${base}/json/figures/\`,
    receiptsBoxesJsonBase: \`\${base}/json/receipts/boxes/\`,
    receiptsFiguresJsonBase: \`\${base}/json/receipts/figures/\`,
  };
}

function createFunctionsDrop(config: Omit<FunctionsDropConfig, 'dropId'> & { dropId: string }): FunctionsDropConfig {
  const normalizedDropId = normalizeDropId(config.dropId);
  return {
    ...config,
    dropId: normalizedDropId,
    metadataBase: normalizeDropBase(config.metadataBase),
    figureNamePrefix: String(config.figureNamePrefix || '').trim() || 'figure',
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
  };
}

${registrySection}

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

// Backward-compatible aliases: always point to the default drop.
export const FUNCTIONS_DEPLOYMENT: FunctionsDeploymentConfig = requireFunctionsDrop(FUNCTIONS_DEFAULT_DROP_ID);

/**
 * Canonical derived paths for the default drop.
 *
 * Keep all path building in one place to avoid duplicating URL strings.
 */
export const FUNCTIONS_PATHS = dropPathsFromBase(FUNCTIONS_DEPLOYMENT.metadataBase);
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
  defaultDropId: string;
  drops: Record<string, FrontendDropConfigSerialized>;
}): void {
  const prevContent = existsSync(args.filePath) ? readFileSync(args.filePath, 'utf8') : '';
  const section = renderFrontendDeploymentRegistrySection({ defaultDropId: args.defaultDropId, drops: args.drops });
  const content =
    replaceMarkedSection({
      filePath: args.filePath,
      existingContent: prevContent,
      startMarker: FRONTEND_DEPLOYMENT_REGISTRY_START,
      endMarker: FRONTEND_DEPLOYMENT_REGISTRY_END,
      nextSection: section,
    }) || renderFrontendDeploymentRegistryFile({ defaultDropId: args.defaultDropId, drops: args.drops });
  writeTextFileIfChanged(args.filePath, content);
}

export function writeFunctionsDeploymentRegistryFile(args: {
  filePath: string;
  defaultDropId: string;
  drops: Record<string, FunctionsDropConfigSerialized>;
}): void {
  const prevContent = existsSync(args.filePath) ? readFileSync(args.filePath, 'utf8') : '';
  const section = renderFunctionsDeploymentRegistrySection({ defaultDropId: args.defaultDropId, drops: args.drops });
  const content =
    replaceMarkedSection({
      filePath: args.filePath,
      existingContent: prevContent,
      startMarker: FUNCTIONS_DEPLOYMENT_REGISTRY_START,
      endMarker: FUNCTIONS_DEPLOYMENT_REGISTRY_END,
      nextSection: section,
    }) || renderFunctionsDeploymentRegistryFile({ defaultDropId: args.defaultDropId, drops: args.drops });
  writeTextFileIfChanged(args.filePath, content);
}
