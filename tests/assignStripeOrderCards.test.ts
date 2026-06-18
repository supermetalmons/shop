import test from 'node:test';
import assert from 'node:assert/strict';
import { assignStripeOrderCardsTestHooks } from '../functions/scripts/assignStripeOrderCards.ts';
import {
  CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET,
  CARD_NFT_2_COMMON_CARD_IDS,
  CARD_NFT_2_COMMON_CARD_ID_SET,
  CARD_NFT_2_MAX_CARD_ID,
} from '../functions/src/cardNft2RevealIds.ts';

const runtime = {
  dropId: 'card_nft_2',
  config: { dropFamily: 'card_nft_2' },
  itemsPerBox: 3,
  maxDudeId: 100,
};

const scriptRuntime = {
  ...runtime,
  cluster: 'mainnet-beta' as const,
  heliusRpcBase: 'https://mainnet.helius-rpc.com',
  collectionMintStr: 'collection-1',
  canonicalMetadataBase: 'https://metadata.example/drop',
  collectionMintSharedOnCluster: false,
};

function firstNNonBucketIds(count: number): number[] {
  const ids: number[] = [];
  for (let id = 1; id <= CARD_NFT_2_MAX_CARD_ID && ids.length < count; id += 1) {
    if (!CARD_NFT_2_COMMON_CARD_ID_SET.has(id) && !CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(id)) {
      ids.push(id);
    }
  }
  if (ids.length !== count) throw new Error(`Expected at least ${count} non-bucket card_nft_2 ids`);
  return ids;
}

function fakeDb(initial: Record<string, any>) {
  const store = new Map(Object.entries(initial));
  const snap = (path: string) => ({
    exists: store.has(path),
    data: () => store.get(path),
    ref: { path },
  });
  return {
    doc: (path: string) => ({
      path,
      get: async () => snap(path),
    }),
  };
}

test('Stripe card assignment treats empty existing IRL claims as repairable pending state', () => {
  const claims = assignStripeOrderCardsTestHooks.existingIrlClaimsByBoxId(
    {
      irlClaims: [
        {
          boxId: 7,
          code: '1234567890',
          dudeIds: [],
        },
      ],
    },
    runtime,
    'drops/card_nft_2/deliveryOrders/1',
  );

  assert.equal(claims.get(7)?.complete, null);
});

test('Stripe card assignment preserves complete existing IRL claims', () => {
  const claims = assignStripeOrderCardsTestHooks.existingIrlClaimsByBoxId(
    {
      irlClaims: [
        {
          boxId: 8,
          code: '1234567890',
          boxAssetId: 'receipt-asset',
          dudeIds: [1, 2, 3],
        },
      ],
    },
    runtime,
    'drops/card_nft_2/deliveryOrders/1',
  );

  assert.deepEqual(claims.get(8)?.complete, {
    boxId: 8,
    code: '1234567890',
    boxAssetId: 'receipt-asset',
    dudeIds: [1, 2, 3],
  });
});

test('Stripe card assignment fails on partially populated invalid IRL claim ids', () => {
  assert.throws(
    () =>
      assignStripeOrderCardsTestHooks.existingIrlClaimsByBoxId(
        {
          irlClaims: [
            {
              boxId: 9,
              code: '1234567890',
              boxAssetId: 'receipt-asset',
              dudeIds: [1, 2],
            },
          ],
        },
        runtime,
        'drops/card_nft_2/deliveryOrders/1',
      ),
    /invalid existing IRL claim dudeIds/,
  );
});

test('Stripe card assignment fails on non-finite IRL claim ids instead of filtering them', () => {
  assert.throws(
    () =>
      assignStripeOrderCardsTestHooks.existingIrlClaimsByBoxId(
        {
          irlClaims: [
            {
              boxId: 10,
              code: '1234567890',
              boxAssetId: 'receipt-asset',
              dudeIds: [1, 2, 3, 'bad'],
            },
          ],
        },
        runtime,
        'drops/card_nft_2/deliveryOrders/1',
      ),
    /invalid existing IRL claim dudeIds/,
  );
});

test('Stripe card assignment validates receipt asset by exact manifest asset', () => {
  assert.doesNotThrow(() =>
    assignStripeOrderCardsTestHooks.validateReceiptAssetForManifest({
      asset: {
        id: 'receipt-asset',
        ownership: { owner: 'owner-wallet' },
        grouping: [{ group_key: 'collection', group_value: 'collection-1' }],
        content: {
          json_uri: 'https://metadata.example/drop/json/receipts/boxes/8.json',
          metadata: {
            attributes: [{ trait_type: 'type', value: 'certificate' }],
          },
        },
      },
      assetId: 'receipt-asset',
      owner: 'owner-wallet',
      runtime: scriptRuntime,
      boxId: 8,
      context: 'test context',
    }),
  );

  assert.throws(
    () =>
      assignStripeOrderCardsTestHooks.validateReceiptAssetForManifest({
        asset: {
          id: 'receipt-asset',
          ownership: { owner: 'different-owner' },
          grouping: [{ group_key: 'collection', group_value: 'collection-1' }],
          content: {
            json_uri: 'https://metadata.example/drop/json/receipts/boxes/8.json',
            metadata: {
              attributes: [{ trait_type: 'type', value: 'certificate' }],
            },
          },
        },
        assetId: 'receipt-asset',
        owner: 'owner-wallet',
        runtime: scriptRuntime,
        boxId: 8,
        context: 'test context',
      }),
    /not owned by owner-wallet/,
  );
});

test('Stripe card assignment fails when receipt snapshot changed after dry-run', () => {
  assert.throws(
    () =>
      assignStripeOrderCardsTestHooks.validateManifestReceiptSnapshot({
        manifestBox: {
          boxId: 8,
          receiptClaimCode: 'ABCDEF-0123456789',
          receiptOwner: 'old-owner',
          receiptOwnerSource: 'receipt_owner',
          receiptClaimStatus: 'unclaimed',
          receiptAssetId: 'receipt-asset',
          assignmentStatus: 'planned',
          dudeIds: [1, 2, 3],
        },
        receiptOwner: {
          owner: 'new-owner',
          source: 'claimed_recipient',
          claimStatus: 'claimed',
        },
        context: 'test context',
      }),
    /receipt owner changed/,
  );
});

test('Stripe card assignment validates dry-run manifest envelope and totals', () => {
  const manifest = {
    version: 1,
    dropId: 'card_nft_2',
    createdAt: '2026-01-01T00:00:00.000Z',
    generatedByDryRun: true,
    orders: [
      {
        docPath: 'drops/card_nft_2/deliveryOrders/1',
        deliveryId: 1,
        boxes: [
          {
            boxId: 8,
            receiptClaimCode: 'ABCDEF-0123456789',
            receiptOwner: '11111111111111111111111111111111',
            receiptOwnerSource: 'receipt_owner',
            receiptClaimStatus: 'unclaimed',
            receiptAssetId: 'receipt-asset',
            assignmentStatus: 'planned',
            dudeIds: [1, 2, 3],
          },
        ],
      },
    ],
    totals: {
      orders: 1,
      boxes: 1,
      plannedAssignments: 1,
      existingAssignments: 0,
    },
  };

  assert.doesNotThrow(() => assignStripeOrderCardsTestHooks.validateManifestTotals(manifest as any, 'test manifest'));
  assert.throws(
    () =>
      assignStripeOrderCardsTestHooks.validateManifestShape(
        {
          ...manifest,
          generatedByDryRun: false,
        } as any,
        scriptRuntime,
      ),
    /not generated by this dry-run script/,
  );
  assert.throws(
    () =>
      assignStripeOrderCardsTestHooks.validateManifestTotals(
        {
          ...manifest,
          totals: { ...manifest.totals, boxes: 2 },
        } as any,
        'test manifest',
      ),
    /totals\.boxes mismatch/,
  );
});

test('Stripe card assignment preflight rejects hand-edited assignments before writes can start', async () => {
  const commonId = CARD_NFT_2_COMMON_CARD_IDS[0]!;
  const [neitherA, neitherB, neitherC] = firstNNonBucketIds(3);
  const preflightRuntime = {
    ...scriptRuntime,
    maxDudeId: CARD_NFT_2_MAX_CARD_ID,
  };

  await assert.rejects(
    () =>
      assignStripeOrderCardsTestHooks.preflightManifestAssignments(
        fakeDb({
          'drops/card_nft_2/meta/dudePool': {
            available: [commonId, neitherA, neitherB, neitherC],
          },
        }) as any,
        preflightRuntime,
        {
          version: 1,
          dropId: 'card_nft_2',
          createdAt: '2026-01-01T00:00:00.000Z',
          generatedByDryRun: true,
          orders: [
            {
              docPath: 'drops/card_nft_2/deliveryOrders/1',
              deliveryId: 1,
              boxes: [
                {
                  boxId: 8,
                  receiptClaimCode: 'ABCDEF-0123456789',
                  receiptOwner: '11111111111111111111111111111111',
                  receiptOwnerSource: 'receipt_owner',
                  receiptClaimStatus: 'unclaimed',
                  receiptAssetId: 'receipt-asset',
                  assignmentStatus: 'planned',
                  dudeIds: [neitherA, neitherB, neitherC],
                },
              ],
            },
          ],
          totals: {
            orders: 1,
            boxes: 1,
            plannedAssignments: 1,
            existingAssignments: 0,
          },
        } as any,
      ),
    /missing an available common dude/,
  );
});
