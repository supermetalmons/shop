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
  boxMinterProgramId: 'D6HxewzSWiFc4yVupdRQT1G4mFw4K7rJKhiV3SEoUju9',
  collectionMint: 'CxMNd67qGWFmyadYJz6a11CBASbsFteXiz7t4NxNVJLC',
  metadataBase: 'https://assets.mons.link/shop/drops/1',
};
