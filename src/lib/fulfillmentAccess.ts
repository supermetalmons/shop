import {
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  allowedFulfillmentDropIdsForWallet,
  walletHasAdminIrlRedeemAccess,
  walletHasFulfillmentAddressAdminAccess,
  walletHasFulfillmentAppAccess,
} from '../../functions/src/shared/fulfillmentAccess';
import {
  DEPLOYMENT_DROPS,
  deploymentTreasuryAlias,
} from '../../functions/src/shared/deploymentRegistry';

export const ADMIN_WALLETS = new Set<string>(FULFILLMENT_ADMIN_WALLET_ADDRESSES);

const ADMIN_IRL_REDEEM_WALLETS = new Set<string>([
  ...ADMIN_WALLETS,
  ...ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
]);

const FULFILLMENT_ADDRESS_ADMIN_WALLETS = new Set<string>(FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES);

const SHIPPER_DROP_IDS_BY_WALLET = new Map<string, string[]>(
  SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, [...dropIds]]),
);

export const DEVNET_INVENTORY_WALLETS = new Set<string>([
  ...FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  ...FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES,
  ...ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  ...SHIPPER_FULFILLMENT_ACCESS.map(({ wallet }) => wallet),
  ...Object.values(DEPLOYMENT_DROPS).map(deploymentTreasuryAlias),
  '8cC8yaEuoTRfmxEopJ9ttUq8JoKR6QkNnm7UqUXPymDw',
]);

export function hasFulfillmentAppAccess(wallet: string | null | undefined): boolean {
  return walletHasFulfillmentAppAccess(wallet, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET);
}

export function hasAdminIrlRedeemAccess(wallet: string | null | undefined): boolean {
  return walletHasAdminIrlRedeemAccess(wallet, ADMIN_IRL_REDEEM_WALLETS);
}

export function hasFulfillmentAddressAdminAccess(wallet: string | null | undefined): boolean {
  return walletHasFulfillmentAddressAdminAccess(wallet, FULFILLMENT_ADDRESS_ADMIN_WALLETS);
}

export function hasDevnetInventoryAccess(wallet: string | null | undefined): boolean {
  return Boolean(wallet && DEVNET_INVENTORY_WALLETS.has(wallet));
}

export function listAllowedFulfillmentDropIds(wallet: string | null | undefined, dropIds: string[]): string[] {
  return allowedFulfillmentDropIdsForWallet(wallet, dropIds, ADMIN_WALLETS, SHIPPER_DROP_IDS_BY_WALLET);
}
