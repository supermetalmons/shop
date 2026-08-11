import assert from 'node:assert/strict';
import test from 'node:test';
import { NEW_DROP as MAINNET_CLEAR_CARDS } from '../scripts/newDrops/clear_cards.ts';
import { NEW_DROP as DEVNET_CLEAR_CARDS } from '../scripts/newDrops/clear_cards_devnet_v2.ts';
import { NEW_DROP as SPLIT_DEVNET_CLEAR_CARDS } from '../scripts/newDrops/clear_cards_devnet_v3.ts';

const PAYMENT_ROUTING = {
  mintProceeds: [
    {
      address: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE',
      percentage: 70,
    },
    {
      address: 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz',
      percentage: 30,
    },
  ],
  deliveryPaymentReceiver: 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
};

const COLLECTION_CREATORS = [
  {
    address: 'AWmNR6t5g5zipT2NMkSPRBXxB9Th8LsZcJX71yNyzsgE',
    share: 100,
  },
];

test('mainnet Clear Cards locks the rehearsed drop values and routed payments', () => {
  assert.equal(MAINNET_CLEAR_CARDS.shared.isMainnet, true);
  assert.equal(MAINNET_CLEAR_CARDS.deploy.solanaCluster, 'mainnet-beta');
  assert.equal(MAINNET_CLEAR_CARDS.deploy.reuseProgramId, true);
  assert.equal(
    MAINNET_CLEAR_CARDS.deploy.reuseProgramIdFromDropId,
    'little_swag_hoodies',
  );
  assert.equal(MAINNET_CLEAR_CARDS.onchain.dropId, 'clear_cards');
  assert.equal(MAINNET_CLEAR_CARDS.onchain.dropFamily, 'clear_cards');
  assert.equal(
    MAINNET_CLEAR_CARDS.onchain.metadataBase,
    DEVNET_CLEAR_CARDS.onchain.metadataBase,
  );
  const { creators, ...mainnetCollectionMetadata } =
    MAINNET_CLEAR_CARDS.onchain.collectionMetadata!;
  assert.deepEqual(
    mainnetCollectionMetadata,
    DEVNET_CLEAR_CARDS.onchain.collectionMetadata,
  );
  assert.deepEqual(creators, COLLECTION_CREATORS);
  assert.deepEqual(
    MAINNET_CLEAR_CARDS.onchain.receiptsTree,
    DEVNET_CLEAR_CARDS.onchain.receiptsTree,
  );
  assert.equal(MAINNET_CLEAR_CARDS.onchain.priceSol, 0.069);
  assert.equal(MAINNET_CLEAR_CARDS.onchain.discountPriceSol, 0.01);
  assert.equal(MAINNET_CLEAR_CARDS.onchain.maxSupply, 192);
  assert.equal(MAINNET_CLEAR_CARDS.onchain.itemsPerBox, 1);
  assert.equal(MAINNET_CLEAR_CARDS.onchain.maxPerTx, 15);
  assert.equal(MAINNET_CLEAR_CARDS.onchain.stripeCheckoutEnabled, false);
  assert.equal(MAINNET_CLEAR_CARDS.onchain.treasury, undefined);
  assert.deepEqual(MAINNET_CLEAR_CARDS.onchain.paymentRouting, PAYMENT_ROUTING);
});

test('Clear Cards split-payment devnet rehearsal uses the shared hoodie program', () => {
  assert.equal(SPLIT_DEVNET_CLEAR_CARDS.shared.isMainnet, false);
  assert.equal(SPLIT_DEVNET_CLEAR_CARDS.deploy.solanaCluster, 'devnet');
  assert.equal(
    SPLIT_DEVNET_CLEAR_CARDS.deploy.reuseProgramIdFromDropId,
    'little_swag_hoodies_devnet',
  );
  assert.equal(
    SPLIT_DEVNET_CLEAR_CARDS.onchain.dropId,
    'clear_cards_devnet_v3',
  );
  assert.deepEqual(
    SPLIT_DEVNET_CLEAR_CARDS.onchain.paymentRouting,
    PAYMENT_ROUTING,
  );
  assert.deepEqual(
    SPLIT_DEVNET_CLEAR_CARDS.onchain.collectionMetadata?.creators,
    COLLECTION_CREATORS,
  );
  assert.equal(
    SPLIT_DEVNET_CLEAR_CARDS.onchain.stripeCheckoutEnabled,
    false,
  );
});
