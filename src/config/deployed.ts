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
  boxMinterProgramId: 'HxHRyEJok9VD7WfCrZKY58wh2cFvepTyzV2B92Kmrh5k',
  collectionMint: 'AAFckuKi8keaaFTPfnyApL1D1mPtywq4HQDM3NpwaHuD',
  metadataBase: 'https://assets.mons.link/shop/drops/1',
};
