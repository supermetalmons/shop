/**
 * Frontend values produced by on-chain deployment (COMMITTED).
 *
 * This file is intended to be overwritten by `scripts/deploy-all-onchain.ts` (`npm run deploy-all-onchain`).
 * Put anything that is NOT produced by deployment (Firebase non-secret config,
 * encryption public key, etc) in `src/config/deployment.ts`.
 */
export type SolanaCluster = 'devnet' | 'testnet' | 'mainnet-beta';

export type FrontendDeployedConfig = {
  solanaCluster: SolanaCluster;
  // Drop metadata base (collection.json + json/* + images/*)
  metadataBase: string;

  // Drop config (kept in sync with on-chain config; useful for UI defaults)
  treasury: string;
  priceSol: number;
  maxSupply: number;
  maxPerTx: number;
  namePrefix: string;
  symbol: string;

  boxMinterProgramId: string;
  collectionMint: string;
};

export const FRONTEND_DEPLOYED: FrontendDeployedConfig = {
  solanaCluster: 'devnet',
  metadataBase: 'https://assets.mons.link/drops/lsb',
  treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
  priceSol: 0.01,
  maxSupply: 333,
  maxPerTx: 15,
  namePrefix: 'box',
  symbol: 'box',
  boxMinterProgramId: '9cEJavUm5MRXxdT33FVwJvtge4DwdNkThzm2NEsgFnxb',
  collectionMint: 'BRYrDCL8TEqVywzFxLpzMQvHaytPVS7nnxtVeF7ahT3y',
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
export const FRONTEND_PATHS = dropPathsFromBase(FRONTEND_DEPLOYED.metadataBase);
