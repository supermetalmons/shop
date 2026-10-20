import { DEPLOYMENT_DROPS } from './deploymentRegistry.ts';
import { ETHEREUM_111K_DROP_ID } from './ethereum/protocol.ts';

export type ShipperFulfillmentAccessConfig = Readonly<{
  wallet: string;
  dropIds: readonly string[];
}>;

export type FulfillmentDropGrants = ReadonlySet<string> | readonly string[];

const ETHEREUM_FULFILLMENT_ADMIN_WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';

export const MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES: readonly string[] = Object.freeze([
  'ETaETZU82ZFnaz3j3TKAxRRzbQvt1Bn5tnF9EGMZe5zy',
  'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
  '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
]);

const MAINNET_ADMIN_SHIPPER_WALLETS = new Set(MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES);

export const FULFILLMENT_ADMIN_WALLET_ADDRESSES: readonly string[] = Object.freeze([
  ETHEREUM_FULFILLMENT_ADMIN_WALLET,
]);

export const ADMIN_IRL_REDEEM_WALLET_ADDRESSES: readonly string[] = Object.freeze([
  ...FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  ...MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES,
]);

export const FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES: readonly string[] = Object.freeze([
  'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
  ...MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES,
]);

const MAINNET_FULFILLMENT_DROP_IDS: readonly string[] = Object.freeze(
  Object.values(DEPLOYMENT_DROPS)
    .filter((drop) => drop.solanaCluster === 'mainnet-beta')
    .map((drop) => drop.dropId)
    .sort(),
);

export const SHIPPER_FULFILLMENT_ACCESS: readonly ShipperFulfillmentAccessConfig[] = Object.freeze([
  ...MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES.map((wallet) => Object.freeze({
    wallet,
    dropIds: MAINNET_FULFILLMENT_DROP_IDS,
  })),
  Object.freeze({
    wallet: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
    dropIds: MAINNET_FULFILLMENT_DROP_IDS,
  }),
]);

export const STAFF_WALLET_ADDRESSES: readonly string[] = Object.freeze(Array.from(new Set([
  ...FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  ...FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES,
  ...SHIPPER_FULFILLMENT_ACCESS.map(({ wallet }) => wallet),
])));

const STAFF_WALLET_ADDRESS_SET = new Set(STAFF_WALLET_ADDRESSES);

export function isSupportedFulfillmentDrop(dropId: string): boolean {
  return dropId === ETHEREUM_111K_DROP_ID || Object.hasOwn(DEPLOYMENT_DROPS, dropId);
}

export function isStaffWalletAddress(wallet: string | null | undefined): boolean {
  return Boolean(wallet && STAFF_WALLET_ADDRESS_SET.has(wallet));
}

export function isMainnetOnlyStaffWallet(wallet: string | null | undefined): boolean {
  return Boolean(wallet && MAINNET_ADMIN_SHIPPER_WALLETS.has(wallet));
}

export function walletHasAdminAccess(
  wallet: string | null | undefined,
  adminWallets: ReadonlySet<string>,
): boolean {
  return Boolean(wallet && adminWallets.has(wallet));
}

export function walletHasAdminIrlRedeemAccess(
  wallet: string | null | undefined,
  adminIrlRedeemWallets: ReadonlySet<string>,
): boolean {
  return Boolean(wallet && adminIrlRedeemWallets.has(wallet));
}

export function walletHasFulfillmentAddressAdminAccess(
  wallet: string | null | undefined,
  addressAdminWallets: ReadonlySet<string>,
): boolean {
  return Boolean(wallet && addressAdminWallets.has(wallet));
}

export function walletHasFulfillmentAppAccess(
  wallet: string | null | undefined,
  adminWallets: ReadonlySet<string>,
  shipperDropIdsByWallet: ReadonlyMap<string, unknown>,
): boolean {
  return walletHasAdminAccess(wallet, adminWallets) || Boolean(wallet && shipperDropIdsByWallet.has(wallet));
}

function dropGrantsInclude(grants: FulfillmentDropGrants, dropId: string): boolean {
  return 'has' in grants ? grants.has(dropId) : grants.includes(dropId);
}

export function walletHasFulfillmentDropAccess(
  wallet: string | null | undefined,
  dropId: string,
  adminWallets: ReadonlySet<string>,
  shipperDropIdsByWallet: ReadonlyMap<string, FulfillmentDropGrants>,
): boolean {
  if (!wallet) return false;
  if (isMainnetOnlyStaffWallet(wallet) && !MAINNET_FULFILLMENT_DROP_IDS.includes(dropId)) return false;
  if (dropId === ETHEREUM_111K_DROP_ID && wallet !== ETHEREUM_FULFILLMENT_ADMIN_WALLET) return false;
  if (walletHasAdminAccess(wallet, adminWallets)) return true;
  const grants = shipperDropIdsByWallet.get(wallet);
  return Boolean(grants && dropGrantsInclude(grants, dropId));
}

export function walletCanViewSensitiveFulfillmentAddress(
  wallet: string | null | undefined,
  dropId: string,
  adminWallets: ReadonlySet<string>,
  shipperDropIdsByWallet: ReadonlyMap<string, FulfillmentDropGrants>,
): boolean {
  return (
    Boolean(wallet) &&
    !walletHasAdminAccess(wallet, adminWallets) &&
    walletHasFulfillmentDropAccess(wallet, dropId, adminWallets, shipperDropIdsByWallet)
  );
}

export function allowedFulfillmentDropIdsForWallet(
  wallet: string | null | undefined,
  dropIds: string[],
  adminWallets: ReadonlySet<string>,
  shipperDropIdsByWallet: ReadonlyMap<string, string[]>,
): string[] {
  if (!wallet) return [];
  const allowedDropIds = walletHasAdminAccess(wallet, adminWallets)
    ? dropIds
    : shipperDropIdsByWallet.get(wallet) || [];
  if (isMainnetOnlyStaffWallet(wallet)) {
    return allowedDropIds.filter((dropId) => MAINNET_FULFILLMENT_DROP_IDS.includes(dropId));
  }
  if (
    allowedDropIds.includes(ETHEREUM_111K_DROP_ID) &&
    !walletHasFulfillmentDropAccess(wallet, ETHEREUM_111K_DROP_ID, adminWallets, shipperDropIdsByWallet)
  ) {
    return allowedDropIds.filter((dropId) => dropId !== ETHEREUM_111K_DROP_ID);
  }
  return allowedDropIds;
}
