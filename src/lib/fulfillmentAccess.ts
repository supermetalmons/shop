export const ADMIN_WALLETS = new Set<string>([
  'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
]);

const ADMIN_IRL_REDEEM_WALLETS = new Set<string>([
  ...ADMIN_WALLETS,
  '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
  'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
]);

const SHIPPER_DROP_IDS_BY_WALLET = new Map<string, string[]>([
  ['8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM', ['little_swag_boxes', 'poncho_drifella', 'little_swag_hoodies', 'card_nft_2']],
  ['AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq', ['poncho_drifella', 'card_nft_2']],
  [
    'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
    ['little_swag_boxes', 'poncho_drifella', 'little_swag_hoodies', 'card_nft_2'],
  ],
]);

export function hasFulfillmentAppAccess(wallet: string | null | undefined): boolean {
  if (!wallet) return false;
  return ADMIN_WALLETS.has(wallet) || SHIPPER_DROP_IDS_BY_WALLET.has(wallet);
}

export function hasAdminIrlRedeemAccess(wallet: string | null | undefined): boolean {
  return Boolean(wallet && ADMIN_IRL_REDEEM_WALLETS.has(wallet));
}

export function listAllowedFulfillmentDropIds(wallet: string | null | undefined, dropIds: string[]): string[] {
  if (!wallet) return [];
  if (ADMIN_WALLETS.has(wallet)) return dropIds;
  return SHIPPER_DROP_IDS_BY_WALLET.get(wallet) || [];
}
