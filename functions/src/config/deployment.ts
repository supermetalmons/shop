/**
 * Cloud Functions deployment constants (COMMITTED).
 *
 * This file is intended to be updated by `scripts/deploy-all-box-minter.ts` after
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

  // Optional convenience fields (not required by runtime logic, but useful to keep synced)
  totalSupply: number;
  deliveryVault: string;

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

  // Optional convenience fields (not required by runtime logic, but useful to keep synced)
  totalSupply: 333,
  deliveryVault: 'Aj42b5TrjeZyAVeZVxpjV8nxQ7CSExjmYV42NwuFcjqa',

  // On-chain ids
  boxMinterProgramId: 'D6HxewzSWiFc4yVupdRQT1G4mFw4K7rJKhiV3SEoUju9',
  collectionMint: 'CxMNd67qGWFmyadYJz6a11CBASbsFteXiz7t4NxNVJLC',
  receiptsMerkleTree: 'CzTvErCx1jz6csebZG9Yi7yhaJ2zTQpXmDfMQVCHqNxk',
  deliveryLookupTable: 'EfaFdGw2kYwV5yzjMuBhvNuM8Smt3TyLZum497GZRXqf',
};
