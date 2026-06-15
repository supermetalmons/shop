import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  countNormalIrlPackStatus,
  type PackStatusDropRuntime,
} from '../functions/src/packStatus.ts';
import { requireSupportedPackStatusDrop } from '../functions/scripts/rebuildPackStatus.ts';

const CARD_NFT_2_RUNTIME: PackStatusDropRuntime = {
  dropId: 'card_nft_2',
  cluster: 'mainnet-beta',
  maxSupply: 12_000,
};

test('pack status breakdown computes card-focused rows from pack and card counters', () => {
  const breakdown = buildPackStatusBreakdown({
    dropId: 'card_nft_2',
    totalInitialSupply: 100,
    unsealedOnline: 20,
    redeemedIrlNormal: 10,
    redeemedIrlStripe: 5,
    redeemedUnsealedCards: 7,
  } as any);

  assert.equal(breakdown.totalInitialSupply, 100);
  assert.equal(breakdown.cardsPerPack, 3);
  assert.equal(breakdown.totalCards, 300);
  assert.equal(breakdown.total, 300);
  assert.equal(breakdown.unsealedCards, 60);
  assert.equal(breakdown.redeemedIrl, 15);
  assert.equal(breakdown.redeemedCards, 52);
  assert.deepEqual(
    breakdown.items.map((item) => [item.key, item.label, item.amount, item.percentage]),
    [
      ['unsealed', 'Unpacked', 60, 20],
      ['redeemed', 'Redeemed', 52, 17.33],
      ['total', 'Total', 300, 100],
    ],
  );
});

test('pack status breakdown treats missing raw counter fields safely without sealed rows', () => {
  const missing = buildPackStatusBreakdown({
    dropId: 'card_nft_2',
    totalInitialSupply: 10,
  } as any);
  assert.equal(missing.unsealedOnline, 0);
  assert.equal(missing.redeemedIrl, 0);
  assert.equal(missing.redeemedUnsealedCards, 0);
  assert.equal(missing.unsealedCards, 0);
  assert.equal(missing.redeemedCards, 0);
  assert.equal(missing.totalCards, 30);
  assert.equal(missing.items.some((item) => item.key === 'sealed'), false);

  const excessive = buildPackStatusBreakdown({
    dropId: 'card_nft_2',
    totalInitialSupply: 5,
    unsealedOnline: 4,
    redeemedIrlNormal: 4,
    redeemedIrlStripe: 4,
  } as any);
  assert.equal(excessive.totalCards, 15);
  assert.equal(excessive.unsealedCards, 12);
  assert.equal(excessive.redeemedCards, 24);
});

test('historical pack status counting separates online reveals, normal IRL, and Stripe IRL', () => {
  const counters = buildPackStatusCountersFromRebuildInputs({
    dropRuntime: CARD_NFT_2_RUNTIME,
    assignmentCount: 10,
    irlClaimAssignmentCount: 2,
    inFlightNormalAssignments: 1,
    deliveryOrders: [
      {
        status: 'ready_to_ship',
        items: [
          { kind: 'box', assetId: 'box-a' },
          { kind: 'box', assetId: 'box-b' },
          { kind: 'dude', assetId: 'dude-a' },
        ],
      },
      {
        status: 'ready_to_ship',
        source: 'stripe_offchain',
        metadataIds: [101, 102, 103],
      },
      {
        status: 'processing',
        items: [{ kind: 'box', assetId: 'in-flight' }],
      },
    ],
  });

  assert.deepEqual(counters, {
    dropId: 'card_nft_2',
    totalInitialSupply: 12_000,
    totalCards: 36_000,
    cardsPerPack: 3,
    unsealedOnline: 7,
    redeemedIrlNormal: 2,
    redeemedIrlStripe: 3,
    redeemedUnsealedCards: 1,
  });
});

test('normal IRL pack status increments counters and records card-equivalent event quantity', async () => {
  const updates: Array<{ ref: any; data: any }> = [];
  const creates: Array<{ ref: any; data: any }> = [];
  const db = {
    doc: (path: string) => ({ path }),
    runTransaction: async (fn: any) =>
      fn({
        get: async () => ({ exists: false }),
        update: (ref: any, data: any) => updates.push({ ref, data }),
        create: (ref: any, data: any) => creates.push({ ref, data }),
      }),
  } as any;

  const result = await countNormalIrlPackStatus({
    db,
    dropRuntime: CARD_NFT_2_RUNTIME,
    deliveryId: 123,
    packQuantity: 2,
    unsealedCardQuantity: 4,
  });

  assert.deepEqual(result, { counted: true, quantity: 10 });
  assert.equal(updates.length, 1);
  assert.equal(String(updates[0].ref.path).endsWith('/meta/packStatus'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'redeemedIrlNormal'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'redeemedUnsealedCards'), true);
  assert.equal(creates.length, 1);
  assert.equal(String(creates[0].ref.path).includes('/packStatusEvents/redeemedIrlNormal_123'), true);
  assert.equal(creates[0].data.quantity, 10);
  assert.deepEqual(creates[0].data.increments, {
    redeemedIrlNormal: 2,
    redeemedUnsealedCards: 4,
  });
});

test('normal IRL pack status skips duplicate events without incrementing counters', async () => {
  const updates: Array<{ ref: any; data: any }> = [];
  const creates: Array<{ ref: any; data: any }> = [];
  const db = {
    doc: (path: string) => ({ path }),
    runTransaction: async (fn: any) =>
      fn({
        get: async () => ({ exists: true }),
        update: (ref: any, data: any) => updates.push({ ref, data }),
        create: (ref: any, data: any) => creates.push({ ref, data }),
      }),
  } as any;

  const result = await countNormalIrlPackStatus({
    db,
    dropRuntime: CARD_NFT_2_RUNTIME,
    deliveryId: 123,
    packQuantity: 2,
    unsealedCardQuantity: 4,
  });

  assert.deepEqual(result, { counted: false, quantity: 0 });
  assert.equal(updates.length, 0);
  assert.equal(creates.length, 0);
});

test('pack status rebuild script rejects unsupported drops', () => {
  assert.throws(() => requireSupportedPackStatusDrop('card_nft_2_devnet_final'), /only supports card_nft_2/i);
  assert.equal(requireSupportedPackStatusDrop('card_nft_2').dropId, 'card_nft_2');
});
