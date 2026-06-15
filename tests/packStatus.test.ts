import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPackStatusBreakdown,
  buildPackStatusCountersFromRebuildInputs,
  type PackStatusDropRuntime,
} from '../functions/src/packStatus.ts';
import { requireSupportedPackStatusDrop } from '../functions/scripts/rebuildPackStatus.ts';

const CARD_NFT_2_RUNTIME: PackStatusDropRuntime = {
  dropId: 'card_nft_2',
  cluster: 'mainnet-beta',
  maxSupply: 12_000,
};

test('pack status breakdown computes redeemed, sealed, and percentages from counters', () => {
  const breakdown = buildPackStatusBreakdown({
    dropId: 'card_nft_2',
    totalInitialSupply: 100,
    unsealedOnline: 20,
    redeemedIrlNormal: 10,
    redeemedIrlStripe: 5,
  });

  assert.equal(breakdown.redeemedIrl, 15);
  assert.equal(breakdown.sealed, 65);
  assert.deepEqual(
    breakdown.items.map((item) => [item.key, item.amount, item.percentage]),
    [
      ['unsealed_online', 20, 20],
      ['redeemed_irl', 15, 15],
      ['sealed', 65, 65],
      ['total', 100, 100],
    ],
  );
});

test('pack status breakdown treats missing or excessive raw counter fields safely', () => {
  const missing = buildPackStatusBreakdown({
    dropId: 'card_nft_2',
    totalInitialSupply: 10,
  } as any);
  assert.equal(missing.unsealedOnline, 0);
  assert.equal(missing.redeemedIrl, 0);
  assert.equal(missing.sealed, 10);

  const excessive = buildPackStatusBreakdown({
    dropId: 'card_nft_2',
    totalInitialSupply: 5,
    unsealedOnline: 4,
    redeemedIrlNormal: 4,
    redeemedIrlStripe: 4,
  });
  assert.equal(excessive.sealed, 0);
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
    unsealedOnline: 7,
    redeemedIrlNormal: 2,
    redeemedIrlStripe: 3,
  });
});

test('pack status rebuild script rejects unsupported drops', () => {
  assert.throws(() => requireSupportedPackStatusDrop('card_nft_2_devnet_final'), /only supports card_nft_2/i);
  assert.equal(requireSupportedPackStatusDrop('card_nft_2').dropId, 'card_nft_2');
});
