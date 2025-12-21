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
  uriBase: string;

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
  uriBase: 'https://assets.mons.link/shop/drops/1/json/boxes/',

  // On-chain ids
  boxMinterProgramId: 'FYJ8PRHzMg3UTu47TppZxgVSS7Qh7PjzwZriYm4VVoP6',
  collectionMint: 'DJqHWvUB1vEbwCV4oYzzuVEZvaFZoyVaPdwfb6qQQzeW',
  receiptsMerkleTree: 'AQ1iHnnVH6FuDMsmDSBRq8PFUpAo1w5HvjVVdXk26g8w',
  deliveryLookupTable: '3X3HPJWwucZ8fjK9oSkyQjLxMRkZ97Tw4LrrvSPBrVpW',
};
