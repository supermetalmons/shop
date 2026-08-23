export const BOX_MINTER_CONFIG_SEED = 'config';
export const BOX_MINTER_PENDING_OPEN_SEED = 'open';

export const BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX = 0;
export const BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX = 1;
export const BOX_MINTER_MAX_ITEMS_PER_BOX = 5;

export const BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET = 1;
export const BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET = 3;

export const BOX_MINTER_MINT_VARIANT_KIND_NONE = 0;
export const BOX_MINTER_MINT_VARIANT_KIND_SIZE = 1;
export const BOX_MINTER_MINT_VARIANT_OPTION_COUNT = 3;

export type BoxMinterMintVariantKind =
  | typeof BOX_MINTER_MINT_VARIANT_KIND_NONE
  | typeof BOX_MINTER_MINT_VARIANT_KIND_SIZE;

export type BoxMinterMintVariantTuple = [number, number, number];

export function isConfiguredBoxMinterItemsPerBox(
  value: unknown,
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX &&
    (value as number) <= BOX_MINTER_MAX_ITEMS_PER_BOX
  );
}

export function isOpenableBoxMinterItemsPerBox(
  value: unknown,
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX &&
    (value as number) <= BOX_MINTER_MAX_ITEMS_PER_BOX
  );
}

export function isBoxMinterDiscountMintsPerWallet(
  value: unknown,
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET &&
    (value as number) <= BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET
  );
}

export function isBoxMinterMintVariantKind(
  value: unknown,
): value is BoxMinterMintVariantKind {
  return (
    value === BOX_MINTER_MINT_VARIANT_KIND_NONE ||
    value === BOX_MINTER_MINT_VARIANT_KIND_SIZE
  );
}
