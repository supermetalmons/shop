import {
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  allowedFulfillmentDropIdsForWallet,
  walletHasAdminIrlRedeemAccess,
  walletHasFulfillmentAppAccess,
} from '../../functions/src/shared/fulfillmentAccess';

export const ADMIN_WALLETS = new Set<string>(FULFILLMENT_ADMIN_WALLET_ADDRESSES);

const ADMIN_IRL_REDEEM_WALLETS = new Set<string>([
  ...ADMIN_WALLETS,
  ...ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
]);

const SHIPPER_DROP_IDS_BY_WALLET = new Map<string, string[]>(
  SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, [...dropIds]]),
);

export function hasFulfillmentAppAccess(wallet: string | null | undefined): boolean {
  return walletHasFulfillmentAppAccess(wallet, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET);
}

export function hasAdminIrlRedeemAccess(wallet: string | null | undefined): boolean {
  return walletHasAdminIrlRedeemAccess(wallet, ADMIN_IRL_REDEEM_WALLETS);
}

export function listAllowedFulfillmentDropIds(wallet: string | null | undefined, dropIds: string[]): string[] {
  return allowedFulfillmentDropIdsForWallet(wallet, dropIds, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET);
}
