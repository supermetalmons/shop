export type ShipperFulfillmentAccessConfig = Readonly<{
  wallet: string;
  dropIds: readonly string[];
}>;

export type FulfillmentDropGrants = ReadonlySet<string> | readonly string[];

export const FULFILLMENT_ADMIN_WALLET_ADDRESSES: readonly string[] = Object.freeze([
  'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
]);

export const ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES: readonly string[] = Object.freeze([
  '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
  'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
]);

export const SHIPPER_FULFILLMENT_ACCESS: readonly ShipperFulfillmentAccessConfig[] = Object.freeze([
  Object.freeze({
    wallet: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    dropIds: Object.freeze(['little_swag_boxes', 'poncho_drifella', 'little_swag_hoodies', 'card_nft_2']),
  }),
  Object.freeze({
    wallet: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
    dropIds: Object.freeze(['poncho_drifella', 'card_nft_2']),
  }),
  Object.freeze({
    wallet: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
    dropIds: Object.freeze(['little_swag_boxes', 'poncho_drifella', 'little_swag_hoodies', 'card_nft_2']),
  }),
]);

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
  if (walletHasAdminAccess(wallet, adminWallets)) return dropIds;
  return shipperDropIdsByWallet.get(wallet) || [];
}
