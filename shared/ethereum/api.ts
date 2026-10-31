import type { DeliveryOrderSummary, ProfileAddress, SaveProfileAddressRequest } from '../contracts.ts';
import type { Ethereum111kConfig } from './config.ts';
import type { EthereumDeliveryQuote, EthereumInventoryItem } from './protocol.ts';

export const ETHEREUM_SESSION_HEADER = 'X-Mons-Ethereum-Session';
export const ETHEREUM_API_PATHS = {
  config: '/ethereum/111k/config', stats: '/ethereum/111k/stats', inventory: '/ethereum/111k/inventory',
  metadata: '/ethereum/111k/metadata', transactionsConfirm: '/ethereum/111k/transactions/confirm',
  authChallenge: '/ethereum/auth/challenge', authVerify: '/ethereum/auth/verify', authLogout: '/ethereum/auth/logout',
  profile: '/ethereum/profile', addresses: '/ethereum/addresses', shipments: '/ethereum/shipments',
  deliveryPrepare: '/ethereum/111k/delivery/prepare', deliveryConfirm: '/ethereum/111k/delivery/confirm',
  claimPrepare: '/ethereum/111k/claims/prepare', claimConfirm: '/ethereum/111k/claims/confirm',
} as const;

export type EthereumAuthChallenge = { challengeId: string; message: string; expiresAtMs: number };
export type EthereumSession = { token: string; address: string; chainId: number; dropId: '111k_devnet'; expiresAtMs: number };
export type EthereumStats = {
  chainId: number; contractAddress: string; owner: string | null;
  allocatedCrates: number; warehousesMinted: number; monumentsMinted: number; artworksMinted: number;
  cratePriceWei: string; warehousePriceWei: string; monumentPriceWei: string; saleActive: boolean;
  remainingCrates: number; remainingWarehouses: number; remainingMonuments: number;
  discountMerkleRoot: string; discountCratePriceWei: string; discountAllowance: number; discountUsed: number;
};
export type EthereumInventoryResponse = { items: EthereumInventoryItem[]; nextCursor: string | null; observedBlock: number };
export type EthereumPreparedTransaction = { to: string; data: string; value: string; chainId: number };
export type EthereumProfileResponse = { wallet: string; email?: string; addresses: ProfileAddress[] };
export type EthereumSaveAddressRequest = SaveProfileAddressRequest;
export type EthereumSaveAddressResponse = { address: ProfileAddress };
export type EthereumShipmentsResponse = { orders: DeliveryOrderSummary[] };
export type EthereumDeliveryPrepareRequest = { tokenIds: string[]; addressId: string; requestId: string };
export type EthereumDeliveryPrepareResponse = {
  orderId: number; expiresAtMs: number; quote: EthereumDeliveryQuote; signature: string; transaction: EthereumPreparedTransaction;
};
export type EthereumDeliveryConfirmRequest = { orderId: number; transactionHash: string };
export type EthereumConfirmationResponse = { status: 'pending' | 'confirmed'; confirmations: number };
export type EthereumDeliveryConfirmResponse = EthereumConfirmationResponse & { orderId: number };
export type EthereumClaimPrepareRequest = { receiptId: string; code: string };
export type EthereumClaimPrepareResponse = {
  claimId: string; receiptId: string; deadline: number; expiresAtMs: number;
  signature: string; transaction: EthereumPreparedTransaction;
};
export type EthereumClaimConfirmRequest = { claimId: string; transactionHash: string };
export type EthereumTransactionConfirmResponse = EthereumConfirmationResponse & {
  items: EthereumInventoryItem[]; burnedTokenIds: string[];
};
export type { Ethereum111kConfig, EthereumDeliveryQuote, EthereumInventoryItem };
