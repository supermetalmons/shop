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
  metadataBase: 'https://assets.mons.link/shop/drops/1',

  // Drop config (kept in sync with on-chain config; useful for server-side defaults/validation)
  treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
  priceSol: 0.01,
  maxSupply: 333,
  maxPerTx: 15,
  namePrefix: 'box',
  symbol: 'box',

  // On-chain ids
  boxMinterProgramId: '9rbaqjwtceDzU92JP9PQQfQVDms9y5Fawn1oMcuAHEVt',
  collectionMint: '4e5jWM6pNMpucCeJP8t3kLUbkrhE4wqzk6FWoBwFC2va',
  receiptsMerkleTree: '3v86yhVTdhiAkMxMJkGeMkeEizQ3W75RYAQbM1V3SvwR',
  deliveryLookupTable: '3oqEqaRUZ6QevAACduAgiGegoT6HDe7KQSja2FkbiPAu',
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
  // Allow callers to pass either `https://.../drops/1` or `https://.../drops/1/`.
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
