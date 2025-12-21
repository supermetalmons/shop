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

  // Optional convenience fields (not required by runtime logic, but useful to keep synced)
  totalSupply: number;

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

  // On-chain ids
  boxMinterProgramId: 'HxHRyEJok9VD7WfCrZKY58wh2cFvepTyzV2B92Kmrh5k',
  collectionMint: 'AAFckuKi8keaaFTPfnyApL1D1mPtywq4HQDM3NpwaHuD',
  receiptsMerkleTree: '81phSLXTWGmXHcjRzmyYuvNSYdFWgFGoTmB3dytfGnVz',
  deliveryLookupTable: '2GX46VBg82BCLyQozkCqnKVcYyoWwb5LvcBX2n28yaz8',
};
