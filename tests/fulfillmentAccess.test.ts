import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  walletCanViewSensitiveFulfillmentAddress,
  walletHasFulfillmentDropAccess,
} from '../functions/src/shared/fulfillmentAccess.ts';
import {
  ADMIN_WALLETS,
  hasAdminIrlRedeemAccess,
  hasFulfillmentAppAccess,
  listAllowedFulfillmentDropIds,
} from '../src/lib/fulfillmentAccess.ts';

const ADMIN_WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const ALL_DROP_IDS = [
  'little_swag_boxes',
  'poncho_drifella',
  'drifella_shirt',
  'little_swag_hoodies',
  'card_nft_2',
];
const LIMITED_SHIPPER_WALLET = 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq';
const FULFILLMENT_ONLY_WALLET = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';

test('fulfillment access inventory is frozen and preserves configured wallet and drop ordering', () => {
  assert.equal(Object.isFrozen(FULFILLMENT_ADMIN_WALLET_ADDRESSES), true);
  assert.equal(Object.isFrozen(ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES), true);
  assert.equal(Object.isFrozen(SHIPPER_FULFILLMENT_ACCESS), true);
  SHIPPER_FULFILLMENT_ACCESS.forEach((entry) => {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.dropIds), true);
  });

  assert.deepEqual(FULFILLMENT_ADMIN_WALLET_ADDRESSES, [ADMIN_WALLET]);
  assert.deepEqual(ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES, [
    '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    LIMITED_SHIPPER_WALLET,
  ]);
  assert.deepEqual(
    SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, [...dropIds]]),
    [
      ['8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM', ALL_DROP_IDS],
      [LIMITED_SHIPPER_WALLET, ['poncho_drifella', 'drifella_shirt', 'card_nft_2']],
      [FULFILLMENT_ONLY_WALLET, ALL_DROP_IDS],
    ],
  );
});

test('frontend fulfillment access keeps admin, shipper, and Admin IRL membership behavior', () => {
  assert.equal(ADMIN_WALLETS.has(ADMIN_WALLET), true);
  assert.equal(hasFulfillmentAppAccess(ADMIN_WALLET), true);
  assert.equal(hasFulfillmentAppAccess(LIMITED_SHIPPER_WALLET), true);
  assert.equal(hasFulfillmentAppAccess(FULFILLMENT_ONLY_WALLET), true);
  assert.equal(hasFulfillmentAppAccess('11111111111111111111111111111111'), false);
  assert.equal(hasFulfillmentAppAccess(null), false);

  assert.equal(hasAdminIrlRedeemAccess(ADMIN_WALLET), true);
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES.forEach((wallet) => {
    assert.equal(hasAdminIrlRedeemAccess(wallet), true);
  });
  assert.equal(hasAdminIrlRedeemAccess(FULFILLMENT_ONLY_WALLET), false);
});

test('frontend allowed-drop lists retain caller and configured array references', () => {
  const adminDropIds = [...ALL_DROP_IDS];
  assert.equal(listAllowedFulfillmentDropIds(ADMIN_WALLET, adminDropIds), adminDropIds);

  const firstShipperResult = listAllowedFulfillmentDropIds(LIMITED_SHIPPER_WALLET, [...ALL_DROP_IDS]);
  const secondShipperResult = listAllowedFulfillmentDropIds(LIMITED_SHIPPER_WALLET, []);
  assert.equal(firstShipperResult, secondShipperResult);
  assert.deepEqual(firstShipperResult, ['poncho_drifella', 'drifella_shirt', 'card_nft_2']);

  assert.deepEqual(listAllowedFulfillmentDropIds(FULFILLMENT_ONLY_WALLET, []), ALL_DROP_IDS);
  assert.deepEqual(listAllowedFulfillmentDropIds('11111111111111111111111111111111', ALL_DROP_IDS), []);
  assert.deepEqual(listAllowedFulfillmentDropIds(undefined, ALL_DROP_IDS), []);
});

test('sensitive fulfillment addresses remain visible only to an authorized non-admin shipper', () => {
  const admins = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
  const shipperGrants = new Map(
    SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, new Set(dropIds)]),
  );

  assert.equal(walletHasFulfillmentDropAccess(ADMIN_WALLET, 'card_nft_2', admins, shipperGrants), true);
  assert.equal(walletCanViewSensitiveFulfillmentAddress(ADMIN_WALLET, 'card_nft_2', admins, shipperGrants), false);
  assert.equal(
    walletCanViewSensitiveFulfillmentAddress(LIMITED_SHIPPER_WALLET, 'card_nft_2', admins, shipperGrants),
    true,
  );
  assert.equal(
    walletCanViewSensitiveFulfillmentAddress(
      LIMITED_SHIPPER_WALLET,
      'little_swag_boxes',
      admins,
      shipperGrants,
    ),
    false,
  );
  assert.equal(
    walletCanViewSensitiveFulfillmentAddress('11111111111111111111111111111111', 'card_nft_2', admins, shipperGrants),
    false,
  );
});
