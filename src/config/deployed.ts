/**
 * Frontend values produced by on-chain deployment (COMMITTED).
 *
 * This file is intended to be overwritten by `scripts/deploy-all-box-minter.ts`.
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
  boxMinterProgramId: '8ppYPX2FkPoFcXwWfDJKyPy16STm4q912QwdSgAs9Tr9',
  collectionMint: 'EBsDK56cGoer796S5tQYz9x83d1w96Rn8L8HCSyKa5cP',
  metadataBase: 'https://assets.mons.link/shop/drops/1',
};

