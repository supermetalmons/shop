import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_DROPS,
  deploymentTreasuryAlias,
} from '../shared/deploymentRegistry.ts';
import {
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES,
  FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES,
  FULFILLMENT_ADMIN_WALLET_ADDRESSES,
  SHIPPER_FULFILLMENT_ACCESS,
  STAFF_WALLET_ADDRESSES,
  allowedFulfillmentDropIdsForWallet,
  isStaffWalletAddress,
  walletCanViewSensitiveFulfillmentAddress,
  walletHasFulfillmentDropAccess,
} from '../shared/fulfillmentAccess.ts';
import {
  ADMIN_WALLETS,
  DEVNET_INVENTORY_WALLETS,
  hasAdminIrlRedeemAccess,
  hasDevnetInventoryAccess,
  hasFulfillmentAddressAdminAccess,
  hasFulfillmentAppAccess,
  listAllowedFulfillmentDropIds,
} from '../src/lib/fulfillmentAccess.ts';

const ADMIN_WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const ADDRESS_VIEWING_ADMIN_WALLET = 'ETaETZU82ZFnaz3j3TKAxRRzbQvt1Bn5tnF9EGMZe5zy';
const MAINNET_SHIPPER_WALLET = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
const ALL_DROP_IDS = Object.keys(DEPLOYMENT_DROPS);
const MAINNET_DROP_IDS = Object.values(DEPLOYMENT_DROPS)
  .filter((drop) => drop.solanaCluster === 'mainnet-beta')
  .map((drop) => drop.dropId)
  .sort();
const ADMIN_ONLY_DROP_ID = 'card_nft_binder_devnet';
const CARD_FULFILLMENT_DROP_IDS = ['card_nft_2', 'clear_cards'];
const CARD_NFT_BINDER_FULFILLMENT_DROP_IDS = Object.values(DEPLOYMENT_DROPS)
  .filter(drop => drop.dropFamily === 'card_nft_binder').map(drop => drop.dropId).sort();
const SHIPPER_BINDER_DROP_IDS = CARD_NFT_BINDER_FULFILLMENT_DROP_IDS.filter(
  (dropId) => dropId !== ADMIN_ONLY_DROP_ID,
);
const LIMITED_SHIPPER_WALLET = 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq';
const FULFILLMENT_ONLY_WALLET = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const ADDITIONAL_DEVNET_INVENTORY_WALLET = '8cC8yaEuoTRfmxEopJ9ttUq8JoKR6QkNnm7UqUXPymDw';

test('fulfillment access inventory is frozen and preserves configured wallet and drop ordering', () => {
  assert.equal(Object.isFrozen(FULFILLMENT_ADMIN_WALLET_ADDRESSES), true);
  assert.equal(Object.isFrozen(FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES), true);
  assert.equal(Object.isFrozen(ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES), true);
  assert.equal(Object.isFrozen(SHIPPER_FULFILLMENT_ACCESS), true);
  assert.equal(Object.isFrozen(STAFF_WALLET_ADDRESSES), true);
  SHIPPER_FULFILLMENT_ACCESS.forEach((entry) => {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.dropIds), true);
  });

  assert.deepEqual(FULFILLMENT_ADMIN_WALLET_ADDRESSES, [ADMIN_WALLET, ADDRESS_VIEWING_ADMIN_WALLET]);
  assert.deepEqual(FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES, [FULFILLMENT_ONLY_WALLET]);
  assert.deepEqual(ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES, [
    '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    LIMITED_SHIPPER_WALLET,
  ]);
  assert.deepEqual(
    SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, [...dropIds]]),
    [
      [MAINNET_SHIPPER_WALLET, MAINNET_DROP_IDS],
      [
        LIMITED_SHIPPER_WALLET,
        [
          'poncho_drifella',
          'drifella_shirt',
          ...CARD_FULFILLMENT_DROP_IDS,
          ...SHIPPER_BINDER_DROP_IDS,
        ],
      ],
      [FULFILLMENT_ONLY_WALLET, MAINNET_DROP_IDS],
    ],
  );
  assert.deepEqual(STAFF_WALLET_ADDRESSES, [
    ADMIN_WALLET,
    ADDRESS_VIEWING_ADMIN_WALLET,
    FULFILLMENT_ONLY_WALLET,
    '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    LIMITED_SHIPPER_WALLET,
  ]);
  STAFF_WALLET_ADDRESSES.forEach((wallet) => assert.equal(isStaffWalletAddress(wallet), true));
  assert.equal(isStaffWalletAddress('11111111111111111111111111111111'), false);
});

test('frontend fulfillment access keeps admin, shipper, and Admin IRL membership behavior', () => {
  assert.equal(ADMIN_WALLETS.has(ADMIN_WALLET), true);
  assert.equal(ADMIN_WALLETS.has(ADDRESS_VIEWING_ADMIN_WALLET), true);
  assert.equal(hasFulfillmentAppAccess(ADMIN_WALLET), true);
  assert.equal(hasFulfillmentAppAccess(ADDRESS_VIEWING_ADMIN_WALLET), true);
  assert.equal(hasFulfillmentAppAccess(LIMITED_SHIPPER_WALLET), true);
  assert.equal(hasFulfillmentAppAccess(FULFILLMENT_ONLY_WALLET), true);
  assert.equal(hasFulfillmentAppAccess('11111111111111111111111111111111'), false);
  assert.equal(hasFulfillmentAppAccess(null), false);

  assert.equal(hasAdminIrlRedeemAccess(ADMIN_WALLET), true);
  assert.equal(hasAdminIrlRedeemAccess(ADDRESS_VIEWING_ADMIN_WALLET), true);
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES.forEach((wallet) => {
    assert.equal(hasAdminIrlRedeemAccess(wallet), true);
  });
  assert.equal(hasAdminIrlRedeemAccess(FULFILLMENT_ONLY_WALLET), false);
  assert.equal(hasFulfillmentAddressAdminAccess(FULFILLMENT_ONLY_WALLET), true);
  assert.equal(hasFulfillmentAddressAdminAccess(ADMIN_WALLET), false);
  assert.equal(hasFulfillmentAddressAdminAccess(ADDRESS_VIEWING_ADMIN_WALLET), false);
  assert.equal(hasFulfillmentAddressAdminAccess(LIMITED_SHIPPER_WALLET), false);
});

test('devnet inventory access includes operational, treasury, and explicitly added wallets', () => {
  FULFILLMENT_ADMIN_WALLET_ADDRESSES.forEach((wallet) => {
    assert.equal(hasDevnetInventoryAccess(wallet), wallet !== ADDRESS_VIEWING_ADMIN_WALLET);
  });
  FULFILLMENT_ADDRESS_ADMIN_WALLET_ADDRESSES.forEach((wallet) => {
    assert.equal(hasDevnetInventoryAccess(wallet), true);
  });
  ADMIN_IRL_REDEEM_ADDITIONAL_WALLET_ADDRESSES.forEach((wallet) => {
    assert.equal(hasDevnetInventoryAccess(wallet), true);
  });
  SHIPPER_FULFILLMENT_ACCESS.forEach(({ wallet }) => {
    assert.equal(hasDevnetInventoryAccess(wallet), true);
  });
  Object.values(DEPLOYMENT_DROPS).forEach((drop) => {
    assert.equal(
      hasDevnetInventoryAccess(deploymentTreasuryAlias(drop)),
      true,
    );
  });

  assert.equal(DEVNET_INVENTORY_WALLETS.has(ADDITIONAL_DEVNET_INVENTORY_WALLET), true);
  assert.equal(hasDevnetInventoryAccess(ADDITIONAL_DEVNET_INVENTORY_WALLET), true);
  assert.equal(hasDevnetInventoryAccess('11111111111111111111111111111111'), false);
  assert.equal(hasDevnetInventoryAccess(null), false);
  assert.equal(DEVNET_INVENTORY_WALLETS.has(ADDRESS_VIEWING_ADMIN_WALLET), false);
});

test('frontend allowed-drop lists retain caller and configured array references', () => {
  const adminDropIds = [...ALL_DROP_IDS];
  assert.equal(listAllowedFulfillmentDropIds(ADMIN_WALLET, adminDropIds), adminDropIds);

  const firstShipperResult = listAllowedFulfillmentDropIds(LIMITED_SHIPPER_WALLET, [...ALL_DROP_IDS]);
  const secondShipperResult = listAllowedFulfillmentDropIds(LIMITED_SHIPPER_WALLET, []);
  assert.equal(firstShipperResult, secondShipperResult);
  assert.deepEqual(firstShipperResult, [
    'poncho_drifella',
    'drifella_shirt',
    ...CARD_FULFILLMENT_DROP_IDS,
    ...SHIPPER_BINDER_DROP_IDS,
  ]);

  assert.deepEqual(listAllowedFulfillmentDropIds(FULFILLMENT_ONLY_WALLET, []), MAINNET_DROP_IDS);
  assert.deepEqual(listAllowedFulfillmentDropIds('11111111111111111111111111111111', ALL_DROP_IDS), []);
  assert.deepEqual(listAllowedFulfillmentDropIds(undefined, ALL_DROP_IDS), []);
});

test('designated fulfillment wallets see every mainnet drop with matching API access', () => {
  const admins = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
  const shipperGrants = new Map(
    SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, new Set(dropIds)]),
  );
  for (const wallet of [MAINNET_SHIPPER_WALLET, FULFILLMENT_ONLY_WALLET, ADMIN_WALLET, ADDRESS_VIEWING_ADMIN_WALLET]) {
    const visibleDropIds = listAllowedFulfillmentDropIds(wallet, ALL_DROP_IDS);
    assert.ok(visibleDropIds.includes('mi_note_cards'), wallet);
    for (const dropId of MAINNET_DROP_IDS) {
      assert.ok(visibleDropIds.includes(dropId), `${wallet}: ${dropId}`);
      assert.equal(walletHasFulfillmentDropAccess(wallet, dropId, admins, shipperGrants), true);
      assert.equal(walletCanViewSensitiveFulfillmentAddress(wallet, dropId, admins, shipperGrants),
        wallet !== ADMIN_WALLET);
    }
    if (wallet === ADMIN_WALLET) continue;
    for (const dropId of [...ALL_DROP_IDS.filter((id) => !MAINNET_DROP_IDS.includes(id)), 'unknown_drop']) {
      assert.equal(visibleDropIds.includes(dropId), false);
      assert.equal(walletHasFulfillmentDropAccess(wallet, dropId, admins, shipperGrants), false);
    }
  }
  assert.equal(listAllowedFulfillmentDropIds(LIMITED_SHIPPER_WALLET, ALL_DROP_IDS).includes('mi_note_cards'), false);
  assert.equal(walletHasFulfillmentDropAccess(LIMITED_SHIPPER_WALLET, 'mi_note_cards', admins, shipperGrants), false);
});

test('sensitive fulfillment addresses require an authorized shipper or designated viewing admin', () => {
  const admins = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
  const shipperGrants = new Map(
    SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, new Set(dropIds)]),
  );

  assert.equal(walletHasFulfillmentDropAccess(ADMIN_WALLET, ADMIN_ONLY_DROP_ID, admins, shipperGrants), true);
  SHIPPER_FULFILLMENT_ACCESS.forEach(({ wallet }) => {
    assert.equal(walletHasFulfillmentDropAccess(wallet, ADMIN_ONLY_DROP_ID, admins, shipperGrants), false);
  });
  assert.equal(walletHasFulfillmentDropAccess(ADMIN_WALLET, 'card_nft_2', admins, shipperGrants), true);
  assert.equal(walletCanViewSensitiveFulfillmentAddress(ADMIN_WALLET, 'card_nft_2', admins, shipperGrants), false);
  assert.equal(walletCanViewSensitiveFulfillmentAddress(ADDRESS_VIEWING_ADMIN_WALLET, 'card_nft_2', admins, shipperGrants), true);
  assert.equal(
    walletCanViewSensitiveFulfillmentAddress(LIMITED_SHIPPER_WALLET, 'card_nft_2', admins, shipperGrants),
    true,
  );
  assert.equal(
    walletCanViewSensitiveFulfillmentAddress(LIMITED_SHIPPER_WALLET, 'clear_cards', admins, shipperGrants),
    true,
  );
  SHIPPER_BINDER_DROP_IDS.forEach((dropId) => {
    assert.equal(
      walletCanViewSensitiveFulfillmentAddress(
        LIMITED_SHIPPER_WALLET,
        dropId,
        admins,
        shipperGrants,
      ),
      true,
    );
  });
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

test('Ethereum test fulfillment is limited to the designated admin in the frontend and backend', () => {
  const admins = new Set(FULFILLMENT_ADMIN_WALLET_ADDRESSES);
  const grants = new Map(SHIPPER_FULFILLMENT_ACCESS.map(({ wallet, dropIds }) => [wallet, new Set(dropIds)]));
  const dropIds = [...ALL_DROP_IDS, '111k_devnet'];
  assert.equal(walletHasFulfillmentDropAccess(ADMIN_WALLET, '111k_devnet', admins, grants), true);
  assert.equal(listAllowedFulfillmentDropIds(ADMIN_WALLET, dropIds), dropIds);
  for (const wallet of [
    ADDRESS_VIEWING_ADMIN_WALLET,
    ...SHIPPER_FULFILLMENT_ACCESS.map(({ wallet }) => wallet),
    '0x1111111111111111111111111111111111111111',
    null,
    undefined,
  ]) {
    assert.equal(walletHasFulfillmentDropAccess(wallet, '111k_devnet', admins, grants), false);
    assert.equal(listAllowedFulfillmentDropIds(wallet, dropIds).includes('111k_devnet'), false);
    assert.equal(walletCanViewSensitiveFulfillmentAddress(wallet, '111k_devnet', admins, grants), false);
  }
});

test('generic admin and explicit shipper grants cannot bypass the Ethereum wallet restriction', () => {
  const dropIds = ['card_nft_2', '111k_devnet'];
  const admins = new Set([ADMIN_WALLET, ADDITIONAL_DEVNET_INVENTORY_WALLET]);
  const shipperGrants = new Map([[FULFILLMENT_ONLY_WALLET, [...dropIds]]]);
  const shipperSetGrants = new Map([[FULFILLMENT_ONLY_WALLET, new Set(dropIds)]]);

  for (const wallet of [ADDITIONAL_DEVNET_INVENTORY_WALLET, FULFILLMENT_ONLY_WALLET]) {
    for (const grants of [shipperGrants, shipperSetGrants]) {
      assert.equal(walletHasFulfillmentDropAccess(wallet, '111k_devnet', admins, grants), false);
      assert.equal(walletHasFulfillmentDropAccess(wallet, 'card_nft_2', admins, grants), true);
    }
    assert.deepEqual(allowedFulfillmentDropIdsForWallet(wallet, dropIds, admins, shipperGrants), ['card_nft_2']);
  }
  assert.deepEqual(dropIds, ['card_nft_2', '111k_devnet']);
  assert.deepEqual(shipperGrants.get(FULFILLMENT_ONLY_WALLET), dropIds);
  assert.equal(walletHasFulfillmentDropAccess(ADMIN_WALLET, '111k_devnet', new Set(), new Map()), false);
});
