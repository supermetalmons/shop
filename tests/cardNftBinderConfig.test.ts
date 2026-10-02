import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_DROPS, getReceiptPoolDeployment } from '../shared/deploymentRegistry.ts';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import { API_DROPS } from '../cloud/workers/api/src/dropConfig.ts';
import {
  MONS_SHOP_RECEIPTS_POOL_ID,
  requireReceiptPoolSpec,
} from '../scripts/shared/receiptPoolConfig.ts';

const METADATA_BASE = 'https://cdn.lil.org/nft/card_nft_binder/json';
const AUTHORITY = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const TREASURY = 'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq';

test('card NFT binder deployments remain Stripe-only members of the shared receipt pool', () => {
  const DEVNET_BINDER = DEPLOYMENT_DROPS.card_nft_binder_devnet;
  const MAINNET_BINDER = DEPLOYMENT_DROPS.card_nft_binder;
  for (const config of [DEVNET_BINDER, MAINNET_BINDER]) {
    assert.equal(config.dropFamily, 'card_nft_binder');
    assert.equal(config.displayName, 'Card NFT Binder');
    assert.equal(config.salesMode, 'stripe_receipt_only');
    assert.equal(config.receiptPoolId, MONS_SHOP_RECEIPTS_POOL_ID);
    assert.equal(config.metadataBase, METADATA_BASE);
    assert.equal(config.maxSupply, 15);
    assert.equal(config.itemsPerBox, 0);
    assert.equal(config.maxPerTx, 1);
    assert.equal(config.namePrefix, 'binder');
    assert.equal(config.figureNamePrefix, 'binder');
    assert.equal(config.symbol, 'receipts');
    assert.equal(config.stripeCheckoutEnabled, true);
    assert.equal(config.stripeProductTaxCode, 'txcd_99999999');
    assert.equal(config.priceSol, 1_000_000);
    assert.equal(config.discountPriceSol, 1_000_000);
    assert.equal(config.treasury, TREASURY);
    const pool = getReceiptPoolDeployment(config.solanaCluster, config.receiptPoolId!);
    assert.ok(pool);
    assert.equal(config.collectionMint, pool.collectionMint);
    assert.equal(config.receiptsMerkleTree, pool.receiptsMerkleTree);
    assert.equal(config.receiptsTreeMaxDepth, pool.receiptsTreeMaxDepth);
    assert.equal(config.receiptsTreeCanopyDepth, pool.receiptsTreeCanopyDepth);
  }

  assert.equal(DEVNET_BINDER.dropId, 'card_nft_binder_devnet');
  assert.equal(DEVNET_BINDER.solanaCluster, 'devnet');
  assert.equal(DEVNET_BINDER.boxMinterProgramId, '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6');
  assert.equal(DEVNET_BINDER.boxMinterConfigPda, 'CziiZZkPYnZuEzPap8SKj3N8KvL1zrdbGPuR9kNd92NT');
  assert.equal(DEVNET_BINDER.stripeLiveUnitAmountCents, undefined);

  assert.equal(MAINNET_BINDER.dropId, 'card_nft_binder');
  assert.equal(MAINNET_BINDER.solanaCluster, 'mainnet-beta');
  assert.equal(MAINNET_BINDER.boxMinterProgramId, '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU');
  assert.equal(MAINNET_BINDER.boxMinterConfigPda, '9fd9YF6ZYMZw9ERwdnc798xoUFo584Tmqxc5bWu8j1Bi');
  assert.equal(FRONTEND_DROPS.card_nft_binder.forceSoldOut, true);
  assert.equal(FRONTEND_DROPS.card_nft_binder_devnet.forceSoldOut, undefined);
  assert.equal(FRONTEND_DROPS.card_nft_binder.maxSupply, 15);
  assert.equal(FRONTEND_DROPS.card_nft_binder.receiptMaxId, 20);
  assert.equal(API_DROPS.card_nft_binder.maxSupply, 15);
  assert.equal(API_DROPS.card_nft_binder.receiptMaxId, 20);
  assert.equal(FRONTEND_DROPS.card_nft_binder_devnet.receiptMaxId, undefined);
  assert.equal(MAINNET_BINDER.stripeLiveUnitAmountCents, 10_000);
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
