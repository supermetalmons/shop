/**
 * Frontend deployment constants (COMMITTED).
 *
 * This file is intended to be updated by `scripts/deploy-all-onchain.ts` (`npm run deploy-all-onchain`) after
 * an on-chain deployment.
 *
 * Secrets:
 * - Do NOT put secrets here.
 * - `VITE_HELIUS_API_KEY` and `VITE_FIREBASE_API_KEY` may be provided via env to
 *   override the bundled frontend defaults in `src/lib/helius.ts` and `src/lib/firebase.ts`.
 */

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
export type DropFamily = 'default' | 'little_swag_boxes' | 'poncho_drifella' | 'lsw_cobalt_figure_hoodie';

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

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: string;
  secondaryMarketHref?: string;
  figureMedia?: FigureMediaConfig;
  forceSoldOut?: boolean;
  mintSelection?: MintSelectionConfig;

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
  boxMinterConfigPda?: string;
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
  // Allow callers to pass either `https://.../drops/lsb` or `https://.../drops/lsb/`.
  return String(base || '').replace(/\/+$/, '');
}

export function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

const DROP_FAMILY_BY_DROP_ID: Record<string, Exclude<DropFamily, 'default'>> = {
  little_swag_boxes: 'little_swag_boxes',
  little_swag_boxes_devnet: 'little_swag_boxes',
  lsw_cobalt_figure_hoodie_26_draft: 'lsw_cobalt_figure_hoodie',
  poncho_drifella: 'poncho_drifella',
  poncho_drifella_draft: 'poncho_drifella',
};

export function defaultDropFamilyForDropId(dropId: string): DropFamily {
  const normalizedDropId = normalizeDropId(dropId);
  return DROP_FAMILY_BY_DROP_ID[normalizedDropId] || 'default';
}

export function normalizeDropFamily(value: unknown, dropId?: string): DropFamily {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'little_swag_boxes' ||
    normalized === 'lsw_cobalt_figure_hoodie' ||
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
  return normalizedDropId ? `https://www.tensor.trade/trade/${normalizedDropId}` : undefined;
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

export function dropPathsFromBase(dropBase: string): DropPaths {
  const base = normalizeDropBase(dropBase);
  return {
    base,
    collectionJson: `${base}/collection.json`,
    boxesJsonBase: `${base}/json/boxes/`,
    figuresJsonBase: `${base}/json/figures/`,
    receiptsBoxesJsonBase: `${base}/json/receipts/boxes/`,
    receiptsFiguresJsonBase: `${base}/json/receipts/figures/`,
  };
}

function createFrontendDrop(config: Omit<FrontendDropConfig, 'dropId' | 'paths'> & { dropId: string }): FrontendDropConfig {
  const normalizedDropId = normalizeDropId(config.dropId);
  const normalizedDropFamily = normalizeDropFamily(config.dropFamily, normalizedDropId);
  const figureMedia = normalizeFigureMediaConfig(config.figureMedia) || defaultFigureMediaConfigForDropFamily(normalizedDropFamily);
  const forceSoldOut = config.forceSoldOut === true || defaultForceSoldOutForDropId(normalizedDropId);
  const mintSelection = normalizeMintSelectionConfig(config.mintSelection);
  const boxMinterConfigPda = normalizeOptionalString(config.boxMinterConfigPda);
  return {
    ...config,
    dropId: normalizedDropId,
    dropFamily: normalizedDropFamily,
    metadataBase: normalizeDropBase(config.metadataBase),
    secondaryMarketHref: normalizeOptionalString(config.secondaryMarketHref) || defaultSecondaryMarketHref(normalizedDropId),
    ...(figureMedia ? { figureMedia } : {}),
    ...(mintSelection ? { mintSelection } : {}),
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    figureNamePrefix: normalizeOptionalString(config.figureNamePrefix) || 'figure',
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
    ...(forceSoldOut ? { forceSoldOut: true } : {}),
    paths: dropPathsFromBase(config.metadataBase),
  };
}

function assertSharedProgramDropsUseExplicitConfigPdas<
  T extends { dropId: string; solanaCluster: SolanaCluster; boxMinterProgramId: string; boxMinterConfigPda?: string },
>(drops: Record<string, T>, registryLabel: string): void {
  const counts = new Map<string, number>();
  Object.values(drops).forEach((drop) => {
    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  Object.values(drops).forEach((drop) => {
    const key = `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
    if ((counts.get(key) || 0) < 2) return;
    if (String(drop.boxMinterConfigPda || '').trim()) return;
    throw new Error(
      `${registryLabel} drop ${drop.dropId} shares program ${drop.boxMinterProgramId} on ${drop.solanaCluster} and must set boxMinterConfigPda.`,
    );
  });
}

// BEGIN AUTO-GENERATED FRONTEND DROP REGISTRY
export const FRONTEND_DROPS: FrontendDropsMap = {
  "little_swag_boxes": createFrontendDrop({
    solanaCluster: "mainnet-beta",
    dropId: "little_swag_boxes",
    dropFamily: "little_swag_boxes",
    collectionName: "Little Swag Boxes",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/lsb",
    forceSoldOut: true,
    figureMedia: {
      strategy: "cyclic",
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
    },


    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 1,
    discountPriceSol: 0.55,
    discountMintsPerWallet: 1,
    discountMerkleRoot: "6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c",
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: "box",
    figureNamePrefix: "figure",
    symbol: "box",

    // On-chain ids
    boxMinterProgramId: "22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep",
    collectionMint: "7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr",
  }),
  "little_swag_boxes_devnet": createFrontendDrop({
    solanaCluster: "devnet",
    dropId: "little_swag_boxes_devnet",
    dropFamily: "little_swag_boxes",
    collectionName: "Little Swag Boxes",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/lsb",
    figureMedia: {
      strategy: "cyclic",
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
    },


    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 0.1,
    discountPriceSol: 0.055,
    discountMintsPerWallet: 1,
    discountMerkleRoot: "6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c",
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: "box",
    figureNamePrefix: "figure",
    symbol: "lsb",

    // On-chain ids
    boxMinterProgramId: "CTrBmaCdgNRE9iHtrfQJnxH2puKxfi2V3gBMTxMLrrUA",
    collectionMint: "4sdm8HbtoiV3JejDkMXxGZtiCumMHyovWyjA3SLWErG6",
  }),
  "poncho_drifella": createFrontendDrop({
    solanaCluster: "mainnet-beta",
    dropId: "poncho_drifella",
    dropFamily: "poncho_drifella",
    collectionName: "Poncho Drifella",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/poncho",
    forceSoldOut: true,


    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: "AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq",
    priceSol: 0.69,
    discountPriceSol: 0.42,
    discountMintsPerWallet: 3,
    discountMerkleRoot: "57a899219adfcf52baa508f4093ab40338326957ea322d51efc60b678292727d",
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: "pack",
    figureNamePrefix: "card",
    symbol: "poncho",

    // On-chain ids
    boxMinterProgramId: "C96UF1dNPzAiRoWPDyU1BRVez5Rfqf2WeFy6gipkBS5A",
    collectionMint: "JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH",
  }),
  "poncho_drifella_draft": createFrontendDrop({
    solanaCluster: "devnet",
    dropId: "poncho_drifella_draft",
    dropFamily: "poncho_drifella",
    collectionName: "Poncho Drifella",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/poncho",


    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: "AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq",
    priceSol: 0.05,
    discountPriceSol: 0.023,
    discountMintsPerWallet: 3,
    discountMerkleRoot: "57a899219adfcf52baa508f4093ab40338326957ea322d51efc60b678292727d",
    maxSupply: 207,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: "pack",
    figureNamePrefix: "card",
    symbol: "poncho",

    // On-chain ids
    boxMinterProgramId: "J8xFh938U6kZ6HeFR4uTWMePKakWftvnBZ55QWofe69A",
    collectionMint: "9xnYJQydRNynk2dGaNcuMbqH7pGMmAM9wv5uuYBdXxxw",
  }),
};
// END AUTO-GENERATED FRONTEND DROP REGISTRY

assertSharedProgramDropsUseExplicitConfigPdas(FRONTEND_DROPS, 'Frontend deployment config');

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
    throw new Error(`Unknown frontend dropId: ${dropId}`);
  }
  return found;
}

export function listFrontendDrops(): FrontendDropConfig[] {
  return Object.keys(FRONTEND_DROPS)
    .sort((a, b) => a.localeCompare(b))
    .map((dropId) => FRONTEND_DROPS[dropId]);
}
