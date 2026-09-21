import { PublicKey } from '@solana/web3.js';
import {
  BOX_MINTER_CONFIG_SEED,
  isConfiguredBoxMinterItemsPerBox,
} from '../../../../shared/boxMinterProtocol.js';
import { normalizeDropId, type SolanaCluster } from '../../../../shared/deploymentCore.js';
import { AdminIrlRedeemPrepareError } from './adminIrlRedeemErrors.js';
import { type ApiDropConfig } from './dropConfig.js';

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

function configuredPublicKey(label: string, value: string | undefined, required = true): PublicKey | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) {
    if (!required) return undefined;
    throw new AdminIrlRedeemPrepareError('failed-precondition', `${label} is not configured.`);
  }
  try {
    const key = new PublicKey(normalized);
    if (required && key.equals(PublicKey.default)) {
      throw new AdminIrlRedeemPrepareError('failed-precondition', `${label} is not configured.`);
    }
    return key;
  } catch (error) {
    if (error instanceof AdminIrlRedeemPrepareError) throw error;
    throw new AdminIrlRedeemPrepareError('failed-precondition', `${label} is invalid.`);
  }
}

export function buildRuntime(config: ApiDropConfig): AdminIrlRedeemRuntime {
  const dropId = normalizeDropId(config.dropId);
  const maxSupply = Number(config.maxSupply);
  const itemsPerBox = Number(config.itemsPerBox);
  const receiptMaxId = Number(config.receiptMaxId ?? maxSupply);
  const maxDudeId = maxSupply * itemsPerBox;
  const receiptsTreeMaxDepth = Number(config.receiptsTreeMaxDepth);
  const receiptsTreeCanopyDepth = Number(config.receiptsTreeCanopyDepth ?? 0);
  if (
    !Number.isInteger(maxSupply) || maxSupply < 1 ||
    !isConfiguredBoxMinterItemsPerBox(itemsPerBox) ||
    !Number.isInteger(receiptMaxId) || receiptMaxId < maxSupply || receiptMaxId > 0xffff_ffff ||
    !Number.isSafeInteger(maxDudeId) || maxDudeId > 0xffff ||
    !Number.isInteger(receiptsTreeCanopyDepth) || receiptsTreeCanopyDepth < 0 ||
    (Number.isInteger(receiptsTreeMaxDepth) && receiptsTreeCanopyDepth >= receiptsTreeMaxDepth)
  ) {
    throw new AdminIrlRedeemPrepareError('failed-precondition', 'Admin IRL redeem drop configuration is invalid.', { dropId });
  }
  const boxMinterProgramId = configuredPublicKey('BOX_MINTER_PROGRAM_ID', config.boxMinterProgramId)!;
  const boxMinterConfigPda = configuredPublicKey('BOX_MINTER_CONFIG_PDA', config.boxMinterConfigPda, false) ||
    PublicKey.findProgramAddressSync([Buffer.from(BOX_MINTER_CONFIG_SEED)], boxMinterProgramId)[0];
  return {
    config,
    dropId,
    cluster: config.solanaCluster,
    boxMinterProgramId,
    boxMinterConfigPda,
    collectionMint: configuredPublicKey('COLLECTION_MINT', config.collectionMint)!,
    receiptsMerkleTree: configuredPublicKey('RECEIPTS_MERKLE_TREE', config.receiptsMerkleTree)!,
    deliveryLookupTable: configuredPublicKey('DELIVERY_LOOKUP_TABLE', config.deliveryLookupTable, false),
    ...(Number.isInteger(receiptsTreeMaxDepth) && receiptsTreeMaxDepth > 0 ? { receiptsTreeMaxDepth } : {}),
    receiptsTreeCanopyDepth,
    itemsPerBox,
    maxSupply,
    maxDudeId,
    receiptMaxId,
  };
}
