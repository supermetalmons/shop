import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_NFT_2_PACK_BASE_URL } from '../src/config/dropMediaDefaults.ts';
import {
  fetchInventory,
  listUniqueInventoryCollectionScopes,
  resolveInventoryAssetDropId,
  type InventoryDropResolutionCandidate,
} from '../src/lib/api.ts';

const CARD_NFT_2_COLLECTION = 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu';
const LITTLE_SWAG_BOXES_COLLECTION = '7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr';
const SHARED_RECEIPTS_COLLECTION = 'SharedReceiptCollection11111111111111111111111';
const SHARED_RECEIPTS_TREE = 'SharedReceiptTree111111111111111111111111111111';
const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';

type SearchAssetsParams = {
  method: string;
  params: any;
};

function rpcResult(id: string, result: any) {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string, message: string) {
  return Response.json({ jsonrpc: '2.0', id, error: { message } });
}

async function withMockedFetch(
  handler: (body: any) => Response | Promise<Response>,
  run: (calls: SearchAssetsParams[]) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const calls: SearchAssetsParams[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    calls.push({ method: body.method, params: body.params });
    return handler(body);
  }) as typeof fetch;

  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function assertSearchAssetsUsesCollectionGroupingOptions(calls: SearchAssetsParams[]) {
  const searchCalls = calls.filter((call) => call.method === 'searchAssets');
  assert.ok(searchCalls.length > 0);
  for (const call of searchCalls) {
    assert.deepEqual(call.params?.options, { showUnverifiedCollections: true });
    assert.equal(Object.hasOwn(call.params || {}, 'displayOptions'), false);
  }
}

function cardNft2PackAsset(id: string, packId: number) {
  return {
    id,
    burnt: false,
    grouping: [{ group_key: 'collection', group_value: CARD_NFT_2_COLLECTION }],
    content: {
      json_uri: `https://assets.mons.link/drops/cardnft2/json/b${packId}.json`,
      metadata: {
        name: `pack ${packId}`,
        attributes: [{ trait_type: 'type', value: '3 card pack' }],
      },
      links: {
        image: `https://assets.mons.link/drops/cardnft2/images/b${packId}.webp`,
      },
    },
  };
}

function cardNft2PackAssetWithCollections(id: string, packId: number, collections: string[]) {
  return {
    ...cardNft2PackAsset(id, packId),
    grouping: collections.map((collection) => ({ group_key: 'collection', group_value: collection })),
  };
}

function cardNft2PackAssetWithMetadataCollectionOnly(id: string, packId: number) {
  const base = cardNft2PackAsset(id, packId);
  const { grouping: _grouping, ...asset } = base;
  return {
    ...asset,
    content: {
      ...base.content,
      metadata: {
        ...base.content.metadata,
        collection: { key: CARD_NFT_2_COLLECTION },
      },
    },
  };
}

function unknownCardNft2Asset(index: number) {
  return {
    id: `unknown-${index}`,
    burnt: false,
    grouping: [{ group_key: 'collection', group_value: CARD_NFT_2_COLLECTION }],
    content: {
      metadata: {
        name: `unknown ${index}`,
        attributes: [],
      },
    },
  };
}

function unknownWalletAsset(index: number) {
  return {
    id: `wallet-asset-${index}`,
    burnt: false,
    content: {
      metadata: {
        name: `wallet asset ${index}`,
        attributes: [],
      },
    },
  };
}

test('shared receipt collections resolve drops by metadata base and share one query scope', () => {
  const candidates: InventoryDropResolutionCandidate[] = [
    {
      dropId: 'card_nft_binder',
      solanaCluster: 'mainnet-beta',
      collectionMint: SHARED_RECEIPTS_COLLECTION,
      receiptsMerkleTree: SHARED_RECEIPTS_TREE,
      metadataBase: 'https://cdn.lil.org/nft/card_nft_binder/json',
      receiptPoolId: 'mons_shop_receipts',
      maxSupply: 15,
      receiptMaxId: 20,
    },
    {
      dropId: 'future_receipts_drop',
      solanaCluster: 'mainnet-beta',
      collectionMint: SHARED_RECEIPTS_COLLECTION,
      receiptsMerkleTree: SHARED_RECEIPTS_TREE,
      metadataBase: 'https://cdn.lil.org/nft/future_receipts_drop/json',
      receiptPoolId: 'mons_shop_receipts',
      maxSupply: 8,
    },
    {
      dropId: 'card_nft_binder_devnet',
      solanaCluster: 'devnet',
      collectionMint: SHARED_RECEIPTS_COLLECTION,
      receiptsMerkleTree: SHARED_RECEIPTS_TREE,
      metadataBase: 'https://cdn.lil.org/nft/card_nft_binder/json',
      receiptPoolId: 'mons_shop_receipts',
      maxSupply: 15,
    },
  ];
  const binderAsset = {
    id: 'binder-receipt',
    grouping: [{ group_key: 'collection', group_value: SHARED_RECEIPTS_COLLECTION }],
    compression: { tree: SHARED_RECEIPTS_TREE },
    content: {
      json_uri: 'https://cdn.lil.org/nft/card_nft_binder/json/rb3.json',
    },
  };
  const futureAsset = {
    id: 'future-receipt',
    grouping: [{ group_key: 'collection', group_value: SHARED_RECEIPTS_COLLECTION }],
    compression: { tree: SHARED_RECEIPTS_TREE },
    content: {
      json_uri: 'https://cdn.lil.org/nft/future_receipts_drop/json/rb2.json',
    },
  };
  const unknownAsset = {
    id: 'unknown-receipt',
    grouping: [{ group_key: 'collection', group_value: SHARED_RECEIPTS_COLLECTION }],
    compression: { tree: SHARED_RECEIPTS_TREE },
    content: {
      json_uri: 'https://cdn.lil.org/nft/unknown_receipts_drop/json/rb1.json',
    },
  };
  const wrongKindAsset = {
    ...binderAsset,
    id: 'binder-box',
    content: {
      json_uri: 'https://cdn.lil.org/nft/card_nft_binder/json/b3.json',
    },
  };
  const outOfRangeAsset = {
    ...binderAsset,
    id: 'binder-receipt-out-of-range',
    content: {
      json_uri: 'https://cdn.lil.org/nft/card_nft_binder/json/rb21.json',
    },
  };
  const recoveredAsset = {
    ...binderAsset,
    id: 'binder-receipt-recovered',
    content: {
      json_uri: 'https://cdn.lil.org/nft/card_nft_binder/json/rb20.json',
    },
  };
  const nonCanonicalIdAsset = {
    ...binderAsset,
    id: 'binder-receipt-leading-zero',
    content: {
      json_uri: 'https://cdn.lil.org/nft/card_nft_binder/json/rb03.json',
    },
  };
  const wrongTreeAsset = {
    ...binderAsset,
    id: 'binder-receipt-wrong-tree',
    compression: { tree: 'WrongReceiptTree1111111111111111111111111111111' },
  };
  const missingTreeAsset = {
    ...binderAsset,
    id: 'binder-receipt-missing-tree',
    compression: undefined,
  };
  const uppercaseUriAsset = {
    ...binderAsset,
    id: 'binder-receipt-uppercase-uri',
    content: {
      json_uri: 'https://cdn.lil.org/nft/card_nft_binder/json/RB3.JSON',
    },
  };
  const legacyUriAsset = {
    ...binderAsset,
    id: 'binder-receipt-legacy-uri',
    content: {
      json_uri: 'https://cdn.lil.org/nft/card_nft_binder/json/json/receipts/boxes/3.json',
    },
  };
  const queryUriAsset = {
    ...binderAsset,
    id: 'binder-receipt-query-uri',
    content: {
      json_uri: 'https://cdn.lil.org/nft/card_nft_binder/json/rb3.json?v=1',
    },
  };
  const fragmentUriAsset = {
    ...binderAsset,
    id: 'binder-receipt-fragment-uri',
    content: {
      json_uri: 'https://cdn.lil.org/nft/card_nft_binder/json/rb3.json#receipt',
    },
  };

  assert.equal(
    resolveInventoryAssetDropId(binderAsset, candidates, 'mainnet-beta'),
    'card_nft_binder',
  );
  assert.equal(
    resolveInventoryAssetDropId(recoveredAsset, candidates, 'mainnet-beta'),
    'card_nft_binder',
  );
  assert.equal(
    resolveInventoryAssetDropId(futureAsset, candidates, 'mainnet-beta'),
    'future_receipts_drop',
  );
  assert.equal(resolveInventoryAssetDropId(unknownAsset, candidates, 'mainnet-beta'), null);
  assert.equal(resolveInventoryAssetDropId(wrongKindAsset, candidates, 'mainnet-beta'), null);
  assert.equal(resolveInventoryAssetDropId(outOfRangeAsset, candidates, 'mainnet-beta'), null);
  assert.equal(resolveInventoryAssetDropId(nonCanonicalIdAsset, candidates, 'mainnet-beta'), null);
  assert.equal(resolveInventoryAssetDropId(wrongTreeAsset, candidates, 'mainnet-beta'), null);
  assert.equal(resolveInventoryAssetDropId(missingTreeAsset, candidates, 'mainnet-beta'), null);
  assert.equal(resolveInventoryAssetDropId(uppercaseUriAsset, candidates, 'mainnet-beta'), null);
  assert.equal(resolveInventoryAssetDropId(legacyUriAsset, candidates, 'mainnet-beta'), null);
  assert.equal(resolveInventoryAssetDropId(queryUriAsset, candidates, 'mainnet-beta'), null);
  assert.equal(resolveInventoryAssetDropId(fragmentUriAsset, candidates, 'mainnet-beta'), null);
  assert.equal(
    resolveInventoryAssetDropId(
      { ...unknownAsset, content: {} },
      candidates,
      'mainnet-beta',
    ),
    null,
  );
  assert.equal(
    resolveInventoryAssetDropId(binderAsset, [candidates[0]], 'mainnet-beta'),
    'card_nft_binder',
  );
  assert.equal(
    resolveInventoryAssetDropId(unknownAsset, [candidates[0]], 'mainnet-beta'),
    null,
  );

  const scopes = listUniqueInventoryCollectionScopes(candidates);
  assert.deepEqual(
    scopes.map((drop) => drop.dropId),
    ['card_nft_binder', 'card_nft_binder_devnet'],
  );
});

test('fetchInventory requests unburned Helius assets and includes paginated boxes', async () => {
  await withMockedFetch(async (body) => {
    if (body.method !== 'searchAssets') {
      return rpcResult(body.id, null);
    }

    const params = body.params || {};
    const collection = Array.isArray(params.grouping) ? params.grouping[1] : undefined;
    const page = Number(params.page || 1);
    const isCardNft2 = collection === CARD_NFT_2_COLLECTION;

    if (!isCardNft2) {
      return rpcResult(body.id, { items: [] });
    }

    if (page === 1) {
      return rpcResult(body.id, {
        items: [
          cardNft2PackAsset('page-1-pack', 184),
          ...Array.from({ length: 999 }, (_, index) => unknownCardNft2Asset(index)),
        ],
      });
    }

    return rpcResult(body.id, {
      items: [cardNft2PackAsset('page-2-pack', 823)],
    });
  }, async (calls) => {
    const inventory = await fetchInventory(OWNER);

    assert.deepEqual(
      inventory.map((item) => item.id),
      ['page-1-pack', 'page-2-pack'],
    );
    assert.deepEqual(
      inventory.map((item) => item.boxId),
      ['184', '823'],
    );
    assert.deepEqual(
      inventory.map((item) => item.image),
      [`${CARD_NFT_2_PACK_BASE_URL}/4/initial.webp`, `${CARD_NFT_2_PACK_BASE_URL}/3/initial.webp`],
    );

    const cardNft2Calls = calls.filter(
      (call) => Array.isArray(call.params?.grouping) && call.params.grouping[1] === CARD_NFT_2_COLLECTION,
    );
    assert.deepEqual(
      cardNft2Calls.map((call) => call.params.page),
      [1, 2],
    );
    assert.equal(calls.every((call) => call.method !== 'searchAssets' || call.params?.burnt === false), true);
    assertSearchAssetsUsesCollectionGroupingOptions(calls);
  });
});

test('fetchInventory does not use metadata URLs to disambiguate multiple collection candidates', async () => {
  const ambiguousAsset = cardNft2PackAssetWithCollections('ambiguous-pack', 184, [
    CARD_NFT_2_COLLECTION,
    LITTLE_SWAG_BOXES_COLLECTION,
  ]);

  await withMockedFetch(async (body) => {
    if (body.method !== 'searchAssets') {
      return rpcResult(body.id, null);
    }

    const params = body.params || {};
    const collection = Array.isArray(params.grouping) ? params.grouping[1] : undefined;
    if (collection === CARD_NFT_2_COLLECTION || collection === LITTLE_SWAG_BOXES_COLLECTION) {
      return rpcResult(body.id, { items: [ambiguousAsset] });
    }

    return rpcResult(body.id, { items: [] });
  }, async () => {
    const inventory = await fetchInventory(OWNER);
    assert.deepEqual(inventory, []);
  });
});

test('fetchInventory ignores metadata collection keys without Helius grouping', async () => {
  const metadataOnlyAsset = cardNft2PackAssetWithMetadataCollectionOnly('metadata-only-pack', 184);

  await withMockedFetch(async (body) => {
    if (body.method !== 'searchAssets') {
      return rpcResult(body.id, null);
    }

    const params = body.params || {};
    const collection = Array.isArray(params.grouping) ? params.grouping[1] : undefined;
    if (collection === CARD_NFT_2_COLLECTION) {
      return rpcResult(body.id, { items: [metadataOnlyAsset] });
    }

    return rpcResult(body.id, { items: [] });
  }, async () => {
    const inventory = await fetchInventory(OWNER);
    assert.deepEqual(inventory, []);
  });
});

test('fetchInventory keeps the ungrouped fallback to one owner page', async () => {
  await withMockedFetch(async (body) => {
    if (body.method !== 'searchAssets') {
      return rpcResult(body.id, null);
    }

    const params = body.params || {};
    if (Array.isArray(params.grouping)) {
      return rpcResult(body.id, { items: [] });
    }

    return rpcResult(body.id, {
      page: params.page,
      limit: 1000,
      total: 2500,
      items: Array.from({ length: 1000 }, (_, index) => unknownWalletAsset(index)),
    });
  }, async (calls) => {
    const inventory = await fetchInventory(OWNER);

    assert.deepEqual(inventory, []);

    const ungroupedCalls = calls.filter((call) => call.method === 'searchAssets' && !Array.isArray(call.params?.grouping));
    assert.deepEqual(
      ungroupedCalls.map((call) => call.params.page),
      [1],
    );
  });
});

test('fetchInventory keeps grouped partial results when a later page fails', async () => {
  const originalWarn = console.warn;
  console.warn = () => undefined;

  try {
    await withMockedFetch(async (body) => {
      if (body.method !== 'searchAssets') {
        return rpcResult(body.id, null);
      }

      const params = body.params || {};
      const collection = Array.isArray(params.grouping) ? params.grouping[1] : undefined;
      const page = Number(params.page || 1);

      if (collection !== CARD_NFT_2_COLLECTION) {
        return rpcResult(body.id, { items: [] });
      }

      if (page === 1) {
        return rpcResult(body.id, {
          items: [
            cardNft2PackAsset('page-1-pack', 184),
            ...Array.from({ length: 999 }, (_, index) => unknownCardNft2Asset(index)),
          ],
        });
      }

      return rpcError(body.id, 'temporary Helius failure');
    }, async (calls) => {
      const inventory = await fetchInventory(OWNER);

      assert.deepEqual(
        inventory.map((item) => item.id),
        ['page-1-pack'],
      );

      const cardNft2Calls = calls.filter(
        (call) => Array.isArray(call.params?.grouping) && call.params.grouping[1] === CARD_NFT_2_COLLECTION,
      );
      assert.deepEqual(
        cardNft2Calls.map((call) => call.params.page),
        [1, 2],
      );
    });
  } finally {
    console.warn = originalWarn;
  }
});
