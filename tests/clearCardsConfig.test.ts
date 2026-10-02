import assert from 'node:assert/strict';
import test from 'node:test';
import { DEPLOYMENT_DROPS } from '../shared/deploymentRegistry.ts';
import { FRONTEND_DROPS } from '../src/config/deployment.ts';
import { API_DROPS } from '../cloud/workers/api/src/dropConfig.ts';

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

test('mainnet Clear Cards retains its deployed identity and routed payments', () => {
  const drop = DEPLOYMENT_DROPS.clear_cards;
  assert.equal(drop.solanaCluster, 'mainnet-beta');
  assert.equal(drop.dropId, 'clear_cards');
  assert.equal(drop.dropFamily, 'clear_cards');
  assert.equal(drop.boxMinterProgramId, '7FGMn1z6TMi6ndyVooP9n1y3zuWhcrxfcJgcSQs6VNNU');
  assert.equal(drop.boxMinterConfigPda, '7yqyrPyYvy7uwkWDy7NaSSP14vrmqVqTGWLe26qGhGCK');
  assert.equal(drop.collectionMint, '3fYe95cviaHzka38Q82q64JLhhddKQm37Jt4dQSxPKxz');
  assert.equal(drop.receiptsMerkleTree, '65VeAMmCNL4eNVH93aegjVHtQQyaBtVsn41UvuvdCLKo');
  assert.equal(drop.metadataBase, 'https://cdn.lil.org/nft/clear_cards/json');
  assert.equal(drop.metadataPathFormat, 'compact');
  assert.equal(drop.priceSol, 0.5);
  assert.equal(drop.discountPriceSol, 0.01);
  assert.equal(drop.maxSupply, 192);
  assert.equal(drop.itemsPerBox, 1);
  assert.equal(drop.maxPerTx, 15);
  assert.equal(drop.stripeCheckoutEnabled ?? false, false);
  assert.equal(drop.forceSoldOut, true);
  assert.equal(FRONTEND_DROPS.clear_cards.forceSoldOut, true);
  assert.equal(drop.treasury, undefined);
  assert.deepEqual(drop.paymentRouting, PAYMENT_ROUTING);
  for (const projection of [FRONTEND_DROPS.clear_cards, API_DROPS.clear_cards]) {
    assert.deepEqual(projection.paymentRouting, PAYMENT_ROUTING);
    assert.equal(projection.treasury, PAYMENT_ROUTING.deliveryPaymentReceiver);
  }
});

test('Clear Cards devnet deployments retain both treasury and split routing configs', () => {
  const treasuryDrop = DEPLOYMENT_DROPS.clear_cards_devnet_v2;
  const splitDrop = DEPLOYMENT_DROPS.clear_cards_devnet_v3;
  for (const drop of [treasuryDrop, splitDrop]) {
    assert.equal(drop.solanaCluster, 'devnet');
    assert.equal(drop.boxMinterProgramId, '8oFSao3VA9DrZouLe3ZFqkbUsjuF6aFDr1eJPh4pyh6');
    assert.equal(drop.metadataBase, DEPLOYMENT_DROPS.clear_cards.metadataBase);
    assert.equal(drop.receiptsTreeMaxDepth, 14);
    assert.equal(drop.receiptsTreeCanopyDepth, 0);
    assert.equal(drop.itemsPerBox, 1);
  }
  assert.equal(treasuryDrop.boxMinterConfigPda, '2TupdgyHKyDFiRj4oKYAoXoFzK2nxPCZYu3xfL5ZgT7Q');
  assert.equal(treasuryDrop.treasury, PAYMENT_ROUTING.mintProceeds[0].address);
  assert.equal(treasuryDrop.paymentRouting, undefined);
  assert.equal(splitDrop.boxMinterConfigPda, 'dWd4jHmVQLKhiKEzqnsdYRee5v5Ud4WGf3RfZb6KJ4j');
  assert.equal(splitDrop.treasury, undefined);
  assert.deepEqual(splitDrop.paymentRouting, PAYMENT_ROUTING);
});
