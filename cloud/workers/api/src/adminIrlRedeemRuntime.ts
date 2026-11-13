import type { PublicKey } from '@solana/web3.js';
import type { SolanaCluster } from '../../../../shared/deploymentCore.js';
import { AdminIrlRedeemPrepareError } from './adminIrlRedeemErrors.js';
import type { ApiDropConfig } from './dropConfig.js';
import { buildReceiptDropRuntime } from './solanaDropRuntime.js';

export type AdminIrlRedeemRuntime = {
  config: ApiDropConfig;
  dropId: string;
  cluster: SolanaCluster;
  boxMinterProgramId: PublicKey;
  boxMinterConfigPda: PublicKey;
  collectionMint: PublicKey;
  receiptsMerkleTree: PublicKey;
  deliveryLookupTable?: PublicKey;
  receiptsTreeMaxDepth?: number;
  receiptsTreeCanopyDepth: number;
  itemsPerBox: number;
  maxSupply: number;
  maxDudeId: number;
  receiptMaxId: number;
};

export function buildRuntime(config: ApiDropConfig): AdminIrlRedeemRuntime {
  return buildReceiptDropRuntime(config, {
    error: AdminIrlRedeemPrepareError,
    invalidConfigurationMessage: 'Admin IRL redeem drop configuration is invalid.',
  });
}
