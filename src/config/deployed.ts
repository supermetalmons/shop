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
  rpcUrl: string;
  boxMinterProgramId: string;
  collectionMint: string;
  metadataBase: string;
};

export const FRONTEND_DEPLOYED: FrontendDeployedConfig = {
  solanaCluster: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  boxMinterProgramId: 'ArSfSR1qT9BhZTBzFgt6HdG2WNxkhKvVtBZoV9TvLHVV',
  collectionMint: 'CxZubJmi2aubC76EF7yP88xsooosjcmrqomZv6FSS7Uj',
  metadataBase: 'https://assets.mons.link/shop/drops/1',
};
