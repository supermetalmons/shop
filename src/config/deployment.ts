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
  // Allow callers to pass either `https://.../drops/lsb` or `https://.../drops/lsb/`.
  return String(base || '').replace(/\/+$/, '');
}

export function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

function normalizeOptionalString(value: unknown): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed || undefined;
}

function normalizeDiscountMintsPerWallet(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) return 1;
  return parsed;
}

function defaultSecondaryMarketHref(dropId: string): string | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return normalizedDropId ? `https://www.tensor.trade/trade/${normalizedDropId}` : undefined;
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
  return {
    ...config,
    dropId: normalizedDropId,
    metadataBase: normalizeDropBase(config.metadataBase),
    secondaryMarketHref: normalizeOptionalString(config.secondaryMarketHref) || defaultSecondaryMarketHref(normalizedDropId),
    figureMedia: normalizeFigureMediaConfig(config.figureMedia),
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
    ...(config.forceSoldOut === true ? { forceSoldOut: true } : {}),
    paths: dropPathsFromBase(config.metadataBase),
  };
}

export const FRONTEND_DEFAULT_DROP_ID = 'little_swag_boxes';

export const FRONTEND_DROPS: FrontendDropsMap = {
  little_swag_boxes: createFrontendDrop({
    solanaCluster: 'mainnet-beta',
    dropId: 'little_swag_boxes',
    collectionName: 'Little Swag Boxes',

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: 'https://assets.mons.link/drops/lsb',
    secondaryMarketHref: 'https://www.tensor.trade/trade/little_swag_boxes',
    forceSoldOut: true,
    figureMedia: {
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
    },

    // Drop config (kept in sync with on-chain config; useful for UI defaults)
    treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    priceSol: 1,
    discountPriceSol: 0.55,
    discountMintsPerWallet: 1,
    discountMerkleRoot: '6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c',
    maxSupply: 333,
    itemsPerBox: 3,
    maxPerTx: 15,
    namePrefix: 'box',
    symbol: 'box',

    // On-chain ids
    boxMinterProgramId: '22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep',
    collectionMint: '7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr',
  }),
};

export function getFrontendDrop(dropId: string): FrontendDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return FRONTEND_DROPS[normalizedDropId];
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

// Backward-compatible alias: always points to the default drop.
export const FRONTEND_DEPLOYMENT: FrontendDeploymentConfig = requireFrontendDrop(FRONTEND_DEFAULT_DROP_ID);
