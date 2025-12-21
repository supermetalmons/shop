/**
 * Cloud Functions deployment constants (COMMITTED).
 *
 * This file is intended to be updated by `scripts/deploy-all-box-minter.ts` after
 * an on-chain deployment, so functions can run with minimal env usage.
 *
 * Secrets (keep in env/runtime config):
 * - HELIUS_API_KEY
 * - COSIGNER_SECRET
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
  boxMinterProgramId: '8ppYPX2FkPoFcXwWfDJKyPy16STm4q912QwdSgAs9Tr9',
  collectionMint: 'EBsDK56cGoer796S5tQYz9x83d1w96Rn8L8HCSyKa5cP',
  receiptsMerkleTree: 'H2szEocmEFNVL5V9MQyhNUyLT8RsP1mb42tApY8Vv7kf',
  deliveryLookupTable: 'Cze4KN9EgWBugu19uc5mmgaCS9w7qZ3DqAk7aSgPn5JE',
};
