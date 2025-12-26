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

export type FunctionsDeploymentConfig = {
  solanaCluster: SolanaCluster;

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: string;

  // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
  discountMerkleRoot: string;
  maxSupply: number;
  maxPerTx: number;
  namePrefix: string;
  symbol: string;

  // On-chain ids
  boxMinterProgramId: string;
  collectionMint: string;
  receiptsMerkleTree: string;
  deliveryLookupTable: string;
};

export const FUNCTIONS_DEPLOYMENT: FunctionsDeploymentConfig = {
  solanaCluster: 'devnet',

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: 'https://assets.mons.link/drops/lsb',

  // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
  treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
  priceSol: 0.01,
  discountPriceSol: 0.005,
  discountMerkleRoot: '6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c',
  maxSupply: 333,
  maxPerTx: 15,
  namePrefix: 'box',
  symbol: 'box',

  // On-chain ids
  boxMinterProgramId: 'Gqc3nnkYegyk4SDFdFY5hRDc4kA7cmW4SJ3PmTC65ege',
  collectionMint: '7qyqJFvHgUftmtGkTCvAuBK55i6FZhp5dYaSd3E5BBhk',
  receiptsMerkleTree: '6QGMeeWGjWdfDnApm4pKg29sU87RY8qBCW2v3hvcvpDT',
  deliveryLookupTable: '5qMw1HhkohDej8mP74K2SUMPqwcDQ7qdLPDMzyHkWAJA',
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

/**
 * Canonical derived paths for the current drop.
 *
 * Keep all path building in one place to avoid duplicating URL strings.
 */
export const FUNCTIONS_PATHS = dropPathsFromBase(FUNCTIONS_DEPLOYMENT.metadataBase);
