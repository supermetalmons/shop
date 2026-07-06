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

type ReceiptAssetOptions = {
  owner?: string;
  grouping?: { group_key: string; group_value: string }[] | null;
  jsonUri?: string;
  metadata?: Record<string, unknown>;
};

function receiptCertificateAsset(options: ReceiptAssetOptions = {}) {
  const {
    owner = 'owner-wallet',
    grouping = [{ group_key: 'collection', group_value: 'collection-1' }],
    jsonUri = 'https://metadata.example/drop/json/receipts/boxes/8.json',
    metadata = {},
  } = options;
  const asset: any = {
    id: 'receipt-asset',
    ownership: { owner },
    content: {
      json_uri: jsonUri,
      metadata: {
        attributes: [{ trait_type: 'type', value: 'certificate' }],
        ...metadata,
      },
    },
  };
  if (grouping) asset.grouping = grouping;
  return asset;
}

function validateReceiptAssetForManifest(asset: any, overrides: Record<string, unknown> = {}) {
  return assignStripeOrderCardsTestHooks.validateReceiptAssetForManifest({
    asset,
    assetId: 'receipt-asset',
    owner: 'owner-wallet',
    runtime: scriptRuntime,
    boxId: 8,
    context: 'test context',
    ...overrides,
  });
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
    validateReceiptAssetForManifest(
      receiptCertificateAsset({
        jsonUri: 'https://cdn.example/migrated-drop/json/receipts/boxes/8.json',
      }),
    ),
  );

  assert.throws(
    () => validateReceiptAssetForManifest(receiptCertificateAsset({ owner: 'different-owner' })),
    /not owned by owner-wallet/,
  );

  assert.throws(
    () =>
      validateReceiptAssetForManifest(
        receiptCertificateAsset({
          grouping: [{ group_key: 'collection', group_value: 'different-collection' }],
        }),
      ),
    /does not match card_nft_2/,
  );

  assert.throws(
    () =>
      validateReceiptAssetForManifest(
        receiptCertificateAsset({
          grouping: null,
          metadata: { collection: { key: 'collection-1' } },
        }),
      ),
    /does not match card_nft_2/,
  );

  assert.throws(
    () =>
      validateReceiptAssetForManifest(
        receiptCertificateAsset({
          grouping: [
            { group_key: 'collection', group_value: 'collection-1' },
            { group_key: 'collection', group_value: 'different-collection' },
          ],
        }),
      ),
    /does not match card_nft_2/,
  );

  assert.throws(
    () =>
      validateReceiptAssetForManifest(receiptCertificateAsset(), {
        runtime: { ...scriptRuntime, collectionMintSharedOnCluster: true },
      }),
    /does not match card_nft_2/,
  );
});

test('Stripe card assignment skips receipt search when collection mint is shared', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('unexpected fetch');
  }) as typeof fetch;

  try {
    const candidates = await assignStripeOrderCardsTestHooks.findReceiptAssetCandidatesOwnedBy({
      owner: 'owner-wallet',
      runtime: { ...scriptRuntime, collectionMintSharedOnCluster: true },
      boxId: 8,
    });

    assert.deepEqual(candidates, []);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Stripe card assignment sends DAS collection grouping options under options', () => {
  const params = assignStripeOrderCardsTestHooks.heliusSearchAssetsParams('owner-wallet', 1, ['collection', 'collection-1']);

  assert.deepEqual(params.options, { showUnverifiedCollections: true });
  assert.equal(Object.hasOwn(params, 'displayOptions'), false);
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

test('Stripe card assignment validates manifest paths against the requested drop id', () => {
  const devnetRuntime = {
    ...scriptRuntime,
    dropId: 'card_nft_2_devnet_final',
    cluster: 'devnet' as const,
  };
  const manifest = {
    version: 1,
    dropId: 'card_nft_2_devnet_final',
    createdAt: '2026-01-01T00:00:00.000Z',
    generatedByDryRun: true,
    orders: [
      {
        docPath: 'drops/card_nft_2_devnet_final/deliveryOrders/1',
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

  assert.doesNotThrow(() => assignStripeOrderCardsTestHooks.validateManifestShape(manifest as any, devnetRuntime));
  assert.throws(() => assignStripeOrderCardsTestHooks.validateManifestShape(manifest as any, scriptRuntime), /Manifest dropId must be card_nft_2/);
});

test('Stripe card assignment keeps scanning full Helius pages when total is capped', () => {
  assert.equal(
    assignStripeOrderCardsTestHooks.heliusSearchAssetsHasNextPage(
      { limit: 1000, page: 1, total: 1000 },
      1,
      Array.from({ length: 1000 }, () => ({})),
    ),
    true,
  );
  assert.equal(
    assignStripeOrderCardsTestHooks.heliusSearchAssetsHasNextPage(
      { limit: 1000, page: 3, total: 768 },
      3,
      Array.from({ length: 768 }, () => ({})),
    ),
    false,
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
