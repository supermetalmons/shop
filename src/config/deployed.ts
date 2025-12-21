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
  uriBase: string;

  boxMinterProgramId: string;
  collectionMint: string;
};

export const FRONTEND_DEPLOYED: FrontendDeployedConfig = {
  solanaCluster: 'devnet',
  metadataBase: 'https://assets.mons.link/shop/drops/1',
  treasury: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
  priceSol: 0.01,
  maxSupply: 333,
  maxPerTx: 15,
  namePrefix: 'box',
  symbol: 'box',
  uriBase: 'https://assets.mons.link/shop/drops/1/json/boxes/',
  boxMinterProgramId: 'FYJ8PRHzMg3UTu47TppZxgVSS7Qh7PjzwZriYm4VVoP6',
  collectionMint: 'DJqHWvUB1vEbwCV4oYzzuVEZvaFZoyVaPdwfb6qQQzeW',
};
