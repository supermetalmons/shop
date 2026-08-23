import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NEW_DROP as DEVNET_BINDER } from '../scripts/newDrops/card_nft_binder_devnet.ts';
import { NEW_DROP as MAINNET_BINDER } from '../scripts/newDrops/card_nft_binder.ts';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import { API_DROPS } from '../cloud/workers/api/src/dropConfig.ts';
import {
  MONS_SHOP_RECEIPTS_POOL_ID,
  requireReceiptPoolSpec,
} from '../scripts/shared/receiptPoolConfig.ts';

const METADATA_BASE = 'https://cdn.lil.org/nft/card_nft_binder/json';
const AUTHORITY = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const TREASURY = 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq';

test('card NFT binder configs are Stripe-only members of the shared receipt pool', () => {
  for (const config of [DEVNET_BINDER, MAINNET_BINDER]) {
    assert.equal(config.onchain.dropFamily, 'card_nft_binder');
    assert.equal(config.onchain.displayName, 'Card NFT Binder');
    assert.equal(config.onchain.salesMode, 'stripe_receipt_only');
    assert.equal(config.onchain.receiptPoolId, MONS_SHOP_RECEIPTS_POOL_ID);
    assert.equal(config.onchain.metadataBase, METADATA_BASE);
    assert.equal(config.onchain.maxSupply, 15);
    assert.equal(config.onchain.itemsPerBox, 0);
    assert.equal(config.onchain.maxPerTx, 1);
    assert.equal(config.onchain.namePrefix, 'binder');
    assert.equal(config.onchain.figureNamePrefix, 'binder');
    assert.equal(config.onchain.symbol, undefined);
    assert.equal(config.onchain.stripeCheckoutEnabled, true);
    assert.equal(config.onchain.stripeProductTaxCode, 'txcd_99999999');
    assert.equal(config.onchain.priceSol, 1_000_000);
    assert.equal(config.onchain.discountPriceSol, 1_000_000);
    assert.equal(config.onchain.treasury, TREASURY);
    assert.equal(config.onchain.collectionMetadata, undefined);
    assert.equal(config.onchain.coreCollectionRoyaltiesBps, undefined);
    assert.equal(config.onchain.receiptsTree, undefined);
  }

  assert.equal(DEVNET_BINDER.onchain.dropId, 'card_nft_binder_devnet');
  assert.equal(DEVNET_BINDER.deploy.solanaCluster, 'devnet');
  assert.equal(
    DEVNET_BINDER.deploy.reuseProgramIdFromDropId,
    'little_swag_hoodies_devnet',
  );
  assert.equal(DEVNET_BINDER.onchain.stripeLiveUnitAmountCents, undefined);

  assert.equal(MAINNET_BINDER.onchain.dropId, 'card_nft_binder');
  assert.equal(MAINNET_BINDER.deploy.solanaCluster, 'mainnet-beta');
  assert.equal(FRONTEND_DROPS.card_nft_binder.forceSoldOut, true);
  assert.equal(FRONTEND_DROPS.card_nft_binder_devnet.forceSoldOut, undefined);
  assert.equal(FRONTEND_DROPS.card_nft_binder.maxSupply, 15);
  assert.equal(FRONTEND_DROPS.card_nft_binder.receiptMaxId, 20);
  assert.equal(API_DROPS.card_nft_binder.maxSupply, 15);
  assert.equal(API_DROPS.card_nft_binder.receiptMaxId, 20);
  assert.equal(FRONTEND_DROPS.card_nft_binder_devnet.receiptMaxId, undefined);
  assert.equal(
    MAINNET_BINDER.deploy.reuseProgramIdFromDropId,
    'little_swag_hoodies',
  );
  assert.equal(MAINNET_BINDER.onchain.stripeLiveUnitAmountCents, 10_000);
});

test('mons shop receipts pool owns the reusable collection and tree policy', () => {
  const pool = requireReceiptPoolSpec(MONS_SHOP_RECEIPTS_POOL_ID);
  assert.deepEqual(pool, {
    receiptPoolId: 'mons_shop_receipts',
    displayName: 'mons shop receipts',
    authority: AUTHORITY,
    collectionMetadataUri:
      'https://cdn.lil.org/nft/mons_shop_receipts/collection.json',
    collectionName: 'mons shop receipts',
    collectionSymbol: 'receipts',
    collectionDescription: 'redeemed on mons dot shop',
    collectionExternalUrl: 'https://mons.shop',
    collectionImage:
      'https://cdn.lil.org/nft/mons_shop_receipts/cover.png',
    royaltiesBasisPoints: 500,
    royaltiesRecipient: TREASURY,
    receiptsTree: {
      maxDepth: 14,
      maxBufferSize: 64,
      canopyDepth: 8,
    },
  });
  assert.equal(2 ** pool.receiptsTree.maxDepth - 15, 16_369);
});

test('binder discount sentinel is derived from the System Program address', () => {
  const csvPath = fileURLToPath(
    new URL('../scripts/discounts/card_nft_binder.csv', import.meta.url),
  );
  assert.equal(
    readFileSync(csvPath, 'utf8').trim(),
    '11111111111111111111111111111111',
  );
});
