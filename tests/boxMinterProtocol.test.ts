import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOX_MINTER_CONFIG_SEED,
  BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX,
  BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET,
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX,
  BOX_MINTER_MINT_VARIANT_KIND_NONE,
  BOX_MINTER_MINT_VARIANT_KIND_SIZE,
  BOX_MINTER_MINT_VARIANT_OPTION_COUNT,
  BOX_MINTER_PENDING_OPEN_SEED,
  isBoxMinterDiscountMintsPerWallet,
  isBoxMinterMintVariantKind,
  isConfiguredBoxMinterItemsPerBox,
  isOpenableBoxMinterItemsPerBox,
  type BoxMinterMintVariantTuple,
} from '../functions/src/shared/boxMinterProtocol.ts';

test('box-minter item predicates preserve configured and openable boundaries', () => {
  assert.equal(BOX_MINTER_CONFIG_SEED, 'config');
  assert.equal(BOX_MINTER_PENDING_OPEN_SEED, 'open');
  assert.equal(BOX_MINTER_MIN_CONFIGURED_ITEMS_PER_BOX, 0);
  assert.equal(BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX, 1);
  assert.equal(BOX_MINTER_MAX_ITEMS_PER_BOX, 5);

  for (const value of [-1, 0.5, 6, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    assert.equal(isConfiguredBoxMinterItemsPerBox(value), false);
  }
  for (const value of [0, 1, 2, 3, 4, 5]) {
    assert.equal(isConfiguredBoxMinterItemsPerBox(value), true);
  }

  for (const value of [-1, 0, 0.5, 6, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    assert.equal(isOpenableBoxMinterItemsPerBox(value), false);
  }
  for (const value of [1, 2, 3, 4, 5]) {
    assert.equal(isOpenableBoxMinterItemsPerBox(value), true);
  }
});

test('box-minter discount and variant predicates preserve protocol boundaries', () => {
  assert.equal(BOX_MINTER_MIN_DISCOUNT_MINTS_PER_WALLET, 1);
  assert.equal(BOX_MINTER_MAX_DISCOUNT_MINTS_PER_WALLET, 3);
  assert.equal(BOX_MINTER_MINT_VARIANT_KIND_NONE, 0);
  assert.equal(BOX_MINTER_MINT_VARIANT_KIND_SIZE, 1);
  assert.equal(BOX_MINTER_MINT_VARIANT_OPTION_COUNT, 3);

  for (const value of [0, 1.5, 4, Number.NaN, Number.POSITIVE_INFINITY, '1']) {
    assert.equal(isBoxMinterDiscountMintsPerWallet(value), false);
  }
  for (const value of [1, 2, 3]) {
    assert.equal(isBoxMinterDiscountMintsPerWallet(value), true);
  }

  assert.equal(isBoxMinterMintVariantKind(BOX_MINTER_MINT_VARIANT_KIND_NONE), true);
  assert.equal(isBoxMinterMintVariantKind(BOX_MINTER_MINT_VARIANT_KIND_SIZE), true);
  assert.equal(isBoxMinterMintVariantKind(-1), false);
  assert.equal(isBoxMinterMintVariantKind(2), false);
  assert.equal(isBoxMinterMintVariantKind('1'), false);
});

test('box-minter variant tuples remain mutable three-item tuples', () => {
  const tuple: BoxMinterMintVariantTuple = [1, 2, 3];
  tuple[1] = 7;
  assert.deepEqual(tuple, [1, 7, 3]);
});
