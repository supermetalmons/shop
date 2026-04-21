/**
 * Cloud Functions deployment constants (COMMITTED).
 *
 * This file is intended to be updated by `scripts/deploy-all-onchain.ts` (`npm run deploy-all-onchain -- <dropId>`) after
 * an on-chain deployment, so functions can run with minimal env usage.
 *
 * Secrets:
 * - HELIUS_API_KEY (env/runtime config)
 * - COSIGNER_SECRET (Firebase Functions secret / Google Secret Manager)
 */

export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';
export type DropFamily = 'default' | 'little_swag_boxes' | 'poncho_drifella' | 'lsw_cobalt_figure_hoodie';

export type FunctionsDropConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;
  dropFamily: DropFamily;
  collectionName: string;

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: string;
  mintSelection?: MintSelectionConfig;

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
  boxMinterConfigPda?: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  deliveryLookupTable: string;
};

// Backward-compatible type alias.
export type FunctionsDeploymentConfig = FunctionsDropConfig;

export type FunctionsDropsMap = Record<string, FunctionsDropConfig>;

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
  const mintSelection = normalizeMintSelectionConfig(config.mintSelection);
  const boxMinterConfigPda = String(config.boxMinterConfigPda || '').trim();
  return {
    ...config,
    dropId: normalizedDropId,
    dropFamily: normalizedDropFamily,
    metadataBase: normalizeDropBase(config.metadataBase),
    ...(mintSelection ? { mintSelection } : {}),
    ...(boxMinterConfigPda ? { boxMinterConfigPda } : {}),
    figureNamePrefix: String(config.figureNamePrefix || '').trim() || 'figure',
    discountMintsPerWallet: normalizeDiscountMintsPerWallet(config.discountMintsPerWallet),
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
  "lsw_cobalt_figure_hoodie_26_devnet": createFunctionsDrop({
    solanaCluster: "devnet",
    dropId: "lsw_cobalt_figure_hoodie_26_devnet",
    dropFamily: "lsw_cobalt_figure_hoodie",
    collectionName: "lsw cobalt figure hoodie 26",

    // Drop metadata base (collection.json + json/* + images/*)
    metadataBase: "https://assets.mons.link/drops/hoodie",
    mintSelection: {
      kind: "size",
      options: [
        {
          key: "L",
          label: "L",
          startId: 1,
          endId: 15,
        },
        {
          key: "XL",
          label: "XL",
          startId: 16,
          endId: 30,
        },
        {
          key: "2XL",
          label: "2XL",
          startId: 31,
          endId: 34,
        },
      ],
    },


    // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
    treasury: "8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM",
    priceSol: 0.069,
    discountPriceSol: 0.042,
    discountMintsPerWallet: 1,
    discountMerkleRoot: "e35a4009c844dcb102d8f21a5b3c7f38842bf3224006b547e68be0dca9ba1871",
    maxSupply: 34,
    itemsPerBox: 0,
    maxPerTx: 15,
    namePrefix: "hoodie",
    figureNamePrefix: "hoodie",
    symbol: "hoodie",

    // On-chain ids
    boxMinterProgramId: "J9ffqCnnV1kg2gZ7Wg4ebVW5KLFH557UDdz9Y6F8fK2W",
    boxMinterConfigPda: "J7nBERYvdk5pzURedetJScpG8BzZmPte7r9tpssu4gdo",
    collectionMint: "H1LeDztc2RuBq9PeeVu2LrvT5rwp8G3e2oiyLoEGmfQq",
    receiptsMerkleTree: "Bz3uut5ckj4ZGWZyTYJZnRp2fKc4FauNnMmWfjiniKF9",
    deliveryLookupTable: "Fg8FY7UtNQLLvKq29Hsp9XQBSVwVVuWmsFMAAg9Akegk",
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
};
// END AUTO-GENERATED FUNCTIONS DROP REGISTRY

assertSharedProgramDropsUseExplicitConfigPdas(FUNCTIONS_DROPS, 'Functions deployment config');

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
