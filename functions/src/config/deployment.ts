/**
 * Cloud Functions deployment constants (COMMITTED).
 *
 * This file is intended to be updated by `scripts/deploy-all-onchain.ts` (`npm run deploy-all-onchain`) after
 * an on-chain deployment, so functions can run with minimal env usage.
 *
 * Secrets:
 * - HELIUS_API_KEY (env/runtime config)
 * - COSIGNER_SECRET (Firebase Functions secret / Google Secret Manager)
 */

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
export type DropFamily = 'default' | 'little_swag_boxes' | 'poncho_drifella';

export type FunctionsDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
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
  // Allow callers to pass either `https://.../drops/lsb` or `https://.../drops/lsb/`.
  return String(base || '').replace(/\/+$/, '');
}

export function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

const DROP_FAMILY_BY_DROP_ID: Record<string, Exclude<DropFamily, 'default'>> = {
  little_swag_boxes: 'little_swag_boxes',
  little_swag_boxes_devnet: 'little_swag_boxes',
  poncho_drifella: 'poncho_drifella',
  poncho_drifella_draft: 'poncho_drifella',
};

export function defaultDropFamilyForDropId(dropId: string): DropFamily {
  const normalizedDropId = normalizeDropId(dropId);
  return DROP_FAMILY_BY_DROP_ID[normalizedDropId] || 'default';
}

export function normalizeDropFamily(value: unknown, dropId?: string): DropFamily {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'little_swag_boxes' || normalized === 'poncho_drifella' || normalized === 'default') {
    return normalized as DropFamily;
  }
  return defaultDropFamilyForDropId(dropId || '');
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
    collectionJson: `${base}/collection.json`,
    boxesJsonBase: `${base}/json/boxes/`,
    figuresJsonBase: `${base}/json/figures/`,
    receiptsBoxesJsonBase: `${base}/json/receipts/boxes/`,
    receiptsFiguresJsonBase: `${base}/json/receipts/figures/`,
  };
}

function createFunctionsDrop(config: Omit<FunctionsDropConfig, 'dropId'> & { dropId: string }): FunctionsDropConfig {
  const normalizedDropId = normalizeDropId(config.dropId);
  const normalizedDropFamily = normalizeDropFamily(config.dropFamily, normalizedDropId);
  return {
    ...config,
    dropId: normalizedDropId,
    dropFamily: normalizedDropFamily,
    metadataBase: normalizeDropBase(config.metadataBase),
    figureNamePrefix: String(config.figureNamePrefix || '').trim() || 'figure',
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
  };
}

// BEGIN AUTO-GENERATED FUNCTIONS DROP REGISTRY
export const FUNCTIONS_DROPS: FunctionsDropsMap = {
  "little_swag_boxes": createFunctionsDrop({
    solanaCluster: "mainnet-beta",
    dropId: "little_swag_boxes",
    dropFamily: "little_swag_boxes",
    collectionName: "Little Swag Boxes",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/lsb",

    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
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
    receiptsMerkleTree: "Bep28XBM8LEjdCHgTzhuo5hFazpKrKgxDaEcnRg2VThV",
    deliveryLookupTable: "F51Mj4JFGdVKJfdbYc4aT4de8Dbst7BmWr2P2Bwxa8Wz",
  }),
  "little_swag_boxes_devnet": createFunctionsDrop({
    solanaCluster: "devnet",
    dropId: "little_swag_boxes_devnet",
    dropFamily: "little_swag_boxes",
    collectionName: "Little Swag Boxes",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/lsb",

    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
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
    receiptsMerkleTree: "2C64cbdnyASftaTdVFYYudn94g274QZ1wv283ocRQaTT",
    deliveryLookupTable: "8JhdJPGjsgAaBdBH3sQChwtmuwUBeWxnpcCRPT4Hph9A",
  }),
  "lsw_cobalt_figure_hoodie_26_draft": createFunctionsDrop({
    solanaCluster: "devnet",
    dropId: "lsw_cobalt_figure_hoodie_26_draft",
    dropFamily: "default",
    collectionName: "lsw cobalt figure hoodie 26",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/hoodie",

    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 1,
    discountMerkleRoot: "6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c",
    maxSupply: 34,
    itemsPerBox: 1,
    maxPerTx: 15,
    namePrefix: "hoodie",
    figureNamePrefix: "hoodie",
    symbol: "hoodie",

    // On-chain ids
    boxMinterProgramId: "HnRphG2N4wX6mG6Pbz1LacUkUX8J4FB1gjK5AqP5Ed4K",
    collectionMint: "7gTdmjNtRUcmqdhMtnck4SYLc9xXDU8Y1mY4vmkey5Eq",
    receiptsMerkleTree: "J1cFF4bX4XuzK1n3KQ9YMe4nffv6wHup7ikip3Y5QsnU",
    deliveryLookupTable: "2nGXrq2zT9U5Ftxpno89z3sTnNv64DbWCm7NjkdLm8bU",
  }),
  "poncho_drifella": createFunctionsDrop({
    solanaCluster: "mainnet-beta",
    dropId: "poncho_drifella",
    dropFamily: "poncho_drifella",
    collectionName: "Poncho Drifella",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/poncho",

    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
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
    receiptsMerkleTree: "5wCjVex6yXCms518RccxmAaVMGoPvTEQcb4UR3MYtQow",
    deliveryLookupTable: "4j1YHm1iwmYDZegY5CxJUYqBcxtpPy7UBkSUfRfz6W8c",
  }),
  "poncho_drifella_draft": createFunctionsDrop({
    solanaCluster: "devnet",
    dropId: "poncho_drifella_draft",
    dropFamily: "poncho_drifella",
    collectionName: "Poncho Drifella",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/poncho",

    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
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
    receiptsMerkleTree: "7H3FAZRmbsfwt9U1w2TduQ6cicdkjqgj4TDfkfhr7vkd",
    deliveryLookupTable: "HRUJM7HmE1WRXwYz1JyxbN9CbANXHWSMgz7RcusUEbyC",
  }),
};
// END AUTO-GENERATED FUNCTIONS DROP REGISTRY

export function getFunctionsDrop(dropId: string): FunctionsDropConfig | undefined {
  const normalizedDropId = normalizeDropId(dropId);
  return FUNCTIONS_DROPS[normalizedDropId];
}

export function requireFunctionsDrop(dropId: string): FunctionsDropConfig {
  const found = getFunctionsDrop(dropId);
  if (!found) {
    throw new Error(`Unknown functions dropId: ${dropId}`);
  }
  return found;
}

export function listFunctionsDrops(): FunctionsDropConfig[] {
  return Object.keys(FUNCTIONS_DROPS)
    .sort((a, b) => a.localeCompare(b))
    .map((dropId) => FUNCTIONS_DROPS[dropId]);
}
