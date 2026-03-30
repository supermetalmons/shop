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

export type FrontendDeploymentConfig = {
  solanaCluster: SolanaCluster;
  dropId: string;

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: string;

  // Drop config (kept in sync with on-chain config; useful for UI defaults)
  treasury: string;
  priceSol: number;
  discountPriceSol: number;
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

const FRONTEND_METADATA_BASE = 'https://assets.mons.link/drops/lsb';

export const FRONTEND_DEPLOYMENT: FrontendDeploymentConfig = {
  solanaCluster: 'mainnet-beta',
  dropId: 'little_swag_boxes',

  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: FRONTEND_METADATA_BASE,

  // Drop config (kept in sync with on-chain config; useful for UI defaults)
  treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
  priceSol: 1,
  discountPriceSol: 0.55,
  discountMerkleRoot: '6f1626377cd32663ba24a8b3788eddcddca6feac46a827eee8053e5b0fd5c14c',
  maxSupply: 333,
  itemsPerBox: 3,
  maxPerTx: 15,
  namePrefix: 'box',
  symbol: 'box',

  // On-chain ids
  boxMinterProgramId: '22NeePs5wgkzP4j5sPzfzJqXsFAu9SUMiGBznPQVaAep',
  collectionMint: '7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr',

  // Canonical derived drop paths (avoid duplicating URL strings).
  paths: dropPathsFromBase(FRONTEND_METADATA_BASE),
};
