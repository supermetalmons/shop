import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PACK_STATUS_SUPPORTED_DROP_IDS,
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  countNormalIrlPackStatus,
  normalizePackStatusBreakdown,
  shouldTrackPackStatusForDrop,
  type PackStatusDropRuntime,
} from '../functions/src/packStatus.ts';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../functions/src/stripeCheckout/contract.ts';
import { requireSupportedPackStatusDrop } from '../functions/scripts/rebuildPackStatus.ts';

const CARD_NFT_2_RUNTIME: PackStatusDropRuntime = {
  dropId: 'card_nft_2',
  cluster: 'mainnet-beta',
  itemsPerBox: 3,
  maxSupply: 12_000,
};

const PONCHO_DRIFELLA_RUNTIME: PackStatusDropRuntime = {
  dropId: 'poncho_drifella',
  cluster: 'mainnet-beta',
  itemsPerBox: 1,
  maxSupply: 207,
};

const LITTLE_SWAG_BOXES_RUNTIME: PackStatusDropRuntime = {
  dropId: 'little_swag_boxes',
  cluster: 'mainnet-beta',
  itemsPerBox: 3,
  maxSupply: 333,
};

test('pack status breakdown computes card-focused rows from pack and card counters', () => {
  const breakdown = buildPackStatusBreakdown({
    dropId: 'card_nft_2',
    totalInitialSupply: 100,
    totalCards: 300,
    cardsPerPack: 3,
    unsealedOnline: 20,
    redeemedIrlNormal: 10,
    redeemedIrlStripe: 5,
    redeemedUnsealedCards: 7,
  });

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

test('pack status breakdown computes poncho card rows from one card per pack', () => {
  const breakdown = buildPackStatusBreakdown({
    dropId: 'poncho_drifella',
    totalInitialSupply: 207,
    totalCards: 207,
    cardsPerPack: 1,
    unsealedOnline: 12,
    redeemedIrlNormal: 3,
    redeemedIrlStripe: 2,
    redeemedUnsealedCards: 1,
  });

  assert.equal(breakdown.cardsPerPack, 1);
  assert.equal(breakdown.totalCards, 207);
  assert.equal(breakdown.unsealedCards, 12);
  assert.equal(breakdown.redeemedCards, 6);
  assert.deepEqual(
    breakdown.items.map((item) => [item.key, item.label, item.amount]),
    [
      ['unsealed', 'Unpacked', 12],
      ['redeemed', 'Redeemed', 6],
      ['total', 'Total', 207],
    ],
  );
});

test('pack status breakdown computes little swag figure rows with unboxed copy', () => {
  const breakdown = buildPackStatusBreakdown({
    dropId: 'little_swag_boxes',
    totalInitialSupply: 333,
    totalCards: 999,
    cardsPerPack: 3,
    unsealedOnline: 20,
    redeemedIrlNormal: 7,
    redeemedIrlStripe: 2,
    redeemedUnsealedCards: 4,
  });

  assert.equal(breakdown.cardsPerPack, 3);
  assert.equal(breakdown.totalCards, 999);
  assert.equal(breakdown.unsealedCards, 60);
  assert.equal(breakdown.redeemedCards, 31);
  assert.deepEqual(
    breakdown.items.map((item) => [item.key, item.label, item.amount]),
    [
      ['unsealed', 'Unboxed', 60],
      ['redeemed', 'Redeemed', 31],
      ['total', 'Total', 999],
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
  assert.equal(missing.items.some((item) => String(item.key) === 'sealed'), false);

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

test('pack status raw normalization preserves schema, drop, and fallback validation', () => {
  const normalized = normalizePackStatusBreakdown(
    {
      version: 1,
      dropId: 'little_swag_boxes',
      totalInitialSupply: 10,
      unsealedOnline: 2,
      redeemedIrlNormal: 1,
      redeemedIrlStripe: 1,
      redeemedUnsealedCards: 2,
    },
    'little_swag_boxes',
    3,
  );

  assert.equal(normalized?.totalCards, 30);
  assert.equal(normalized?.items[0]?.label, 'Unboxed');
  assert.equal(normalized?.items[0]?.amount, 6);
  assert.equal(normalized?.items[1]?.amount, 8);
  assert.equal(
    normalizePackStatusBreakdown(
      { version: 2, dropId: 'little_swag_boxes', totalInitialSupply: 10 },
      'little_swag_boxes',
      3,
    ),
    null,
  );
  assert.equal(
    normalizePackStatusBreakdown(
      { version: 1, dropId: 'card_nft_2', totalInitialSupply: 10 },
      'little_swag_boxes',
      3,
    ),
    null,
  );
  assert.equal(
    normalizePackStatusBreakdown(
      { version: 1, dropId: 'little_swag_boxes', totalInitialSupply: 0 },
      'little_swag_boxes',
      3,
    ),
    null,
  );
});

test('pack status tracking gates on supported mainnet drops with configured supply', () => {
  assert.equal(shouldTrackPackStatusForDrop(CARD_NFT_2_RUNTIME), true);
  assert.equal(
    shouldTrackPackStatusForDrop({
      ...CARD_NFT_2_RUNTIME,
      cluster: 'devnet',
    }),
    false,
  );
  assert.equal(
    shouldTrackPackStatusForDrop({
      ...CARD_NFT_2_RUNTIME,
      dropId: 'card_nft_2_devnet_final',
    }),
    false,
  );
  assert.equal(
    shouldTrackPackStatusForDrop({
      ...CARD_NFT_2_RUNTIME,
      maxSupply: 0,
    }),
    false,
  );
});

test('historical pack status counting separates online reveals, normal/Admin IRL, and Stripe IRL', () => {
  const counters = buildPackStatusCountersFromRebuildInputs({
    dropRuntime: CARD_NFT_2_RUNTIME,
    assignmentCount: 10,
    irlClaimAssignmentCount: 2,
    adminIrlAssignmentCount: 1,
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
        source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
        items: [{ kind: 'box', assetId: 'admin-irl-receipt-box' }],
      },
      {
        status: 'ready_to_ship',
        source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
        items: [{ kind: 'dude', assetId: 'admin-irl-card-receipt' }],
        adminIrlRedeem: { targetKind: 'card_receipt' },
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
    unsealedOnline: 6,
    redeemedIrlNormal: 3,
    redeemedIrlStripe: 3,
    redeemedUnsealedCards: 1,
  });
});

test('historical poncho pack status counting uses one card per pack', () => {
  const counters = buildPackStatusCountersFromRebuildInputs({
    dropRuntime: PONCHO_DRIFELLA_RUNTIME,
    assignmentCount: 12,
    irlClaimAssignmentCount: 1,
    inFlightNormalAssignments: 2,
    deliveryOrders: [
      {
        status: 'ready_to_ship',
        items: [
          { kind: 'box', assetId: 'poncho-box-a' },
          { kind: 'box', assetId: 'poncho-box-b' },
          { kind: 'dude', assetId: 'poncho-card-a' },
        ],
      },
      {
        status: 'ready_to_ship',
        source: 'stripe_offchain',
        metadataIds: [10, 11],
      },
    ],
  });

  assert.deepEqual(counters, {
    dropId: 'poncho_drifella',
    totalInitialSupply: 207,
    totalCards: 207,
    cardsPerPack: 1,
    unsealedOnline: 9,
    redeemedIrlNormal: 2,
    redeemedIrlStripe: 2,
    redeemedUnsealedCards: 1,
  });
});

test('historical little swag pack status counting uses three figures per box', () => {
  const counters = buildPackStatusCountersFromRebuildInputs({
    dropRuntime: LITTLE_SWAG_BOXES_RUNTIME,
    assignmentCount: 6,
    irlClaimAssignmentCount: 1,
    inFlightNormalAssignments: 1,
    deliveryOrders: [
      {
        status: 'ready_to_ship',
        items: [
          { kind: 'box', assetId: 'lsb-box-a' },
          { kind: 'dude', assetId: 'lsb-figure-a' },
          { kind: 'dude', assetId: 'lsb-figure-b' },
        ],
      },
      {
        status: 'ready_to_ship',
        source: 'stripe_offchain',
        metadataId: 10,
      },
    ],
  });

  assert.deepEqual(counters, {
    dropId: 'little_swag_boxes',
    totalInitialSupply: 333,
    totalCards: 999,
    cardsPerPack: 3,
    unsealedOnline: 4,
    redeemedIrlNormal: 1,
    redeemedIrlStripe: 1,
    redeemedUnsealedCards: 2,
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

test('normal card-only IRL status counts one redeemed unsealed card idempotently', async () => {
  const updates: Array<{ ref: any; data: any }> = [];
  const creates: Array<{ ref: any; data: any }> = [];
  let eventExists = false;
  const db = {
    doc: (path: string) => ({ path }),
    runTransaction: async (fn: any) =>
      fn({
        get: async () => ({ exists: eventExists }),
        update: (ref: any, data: any) => updates.push({ ref, data }),
        create: (ref: any, data: any) => {
          eventExists = true;
          creates.push({ ref, data });
        },
      }),
  } as any;

  const first = await countNormalIrlPackStatus({
    db,
    dropRuntime: CARD_NFT_2_RUNTIME,
    deliveryId: 137,
    packQuantity: 0,
    unsealedCardQuantity: 1,
  });
  const duplicate = await countNormalIrlPackStatus({
    db,
    dropRuntime: CARD_NFT_2_RUNTIME,
    deliveryId: 137,
    packQuantity: 0,
    unsealedCardQuantity: 1,
  });

  assert.deepEqual(first, { counted: true, quantity: 1 });
  assert.deepEqual(duplicate, { counted: false, quantity: 0 });
  assert.equal(updates.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'redeemedIrlNormal'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'redeemedUnsealedCards'), true);
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].data.increments, { redeemedUnsealedCards: 1 });
});

test('normal IRL poncho pack status records one-card pack event quantity', async () => {
  const creates: Array<{ ref: any; data: any }> = [];
  const db = {
    doc: (path: string) => ({ path }),
    runTransaction: async (fn: any) =>
      fn({
        get: async () => ({ exists: false }),
        update: () => undefined,
        create: (ref: any, data: any) => creates.push({ ref, data }),
      }),
  } as any;

  const result = await countNormalIrlPackStatus({
    db,
    dropRuntime: PONCHO_DRIFELLA_RUNTIME,
    deliveryId: 456,
    packQuantity: 2,
    unsealedCardQuantity: 4,
  });

  assert.deepEqual(result, { counted: true, quantity: 6 });
  assert.equal(creates[0].data.quantity, 6);
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

test('pack status rebuild script accepts supported mainnet drops and rejects unsupported drops', () => {
  assert.equal(requireSupportedPackStatusDrop('card_nft_2').dropId, 'card_nft_2');
  assert.equal(requireSupportedPackStatusDrop('poncho_drifella').itemsPerBox, 1);
  assert.equal(requireSupportedPackStatusDrop('little_swag_boxes').itemsPerBox, 3);
  assert.throws(
    () => requireSupportedPackStatusDrop('card_nft_2_devnet_final'),
    /only supports card_nft_2, poncho_drifella, little_swag_boxes/i,
  );
  assert.throws(
    () => requireSupportedPackStatusDrop('little_swag_hoodies'),
    /only supports card_nft_2, poncho_drifella, little_swag_boxes/i,
  );
});

test('Firestore rules allow client pack status reads for every supported drop', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const start = rules.indexOf('match /meta/packStatus');
  const end = rules.indexOf('match /meta/dudePool', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const packStatusRule = rules.slice(start, end);

  assert.match(packStatusRule, /request\.auth\s*!=\s*null/);
  for (const dropId of PACK_STATUS_SUPPORTED_DROP_IDS) {
    assert.equal(packStatusRule.includes(`"${dropId}"`), true);
  }
  assert.match(packStatusRule, /allow\s+list,\s+create,\s+update,\s+delete:\s+if\s+false/);
});
