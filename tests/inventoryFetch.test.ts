import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listShopCollectionQueryRuntimes,
  listShopPendingOpenProgramScopes,
  listUniqueInventoryCollectionScopes,
  resolveInventoryAssetDropId,
  resolvePendingOpenDropId,
  type InventoryDropResolutionCandidate,
  type PendingOpenRecordCandidate,
} from '../functions/src/shared/shopDomain.ts';

const LITTLE_SWAG_BOXES_COLLECTION = '7c3tY7nEZ6yDuUCrsL6dX7AFcCqKbwMwS6HRvdZXeQXr';
const PONCHO_DRIFELLA_COLLECTION = 'JCTP3kK3xGtWs5mDHxJBuRro38HftaiCDdKsfkXuK2gH';
const SHARED_RECEIPTS_COLLECTION = 'SharedReceiptCollection11111111111111111111111';
const SHARED_RECEIPTS_TREE = 'SharedReceiptTree111111111111111111111111111111';

test('pending-open resolution requires the selected drop to match the placeholder count', () => {
  const sharedScope = listShopPendingOpenProgramScopes(false).find((scope) =>
    scope.drops.some((drop) => drop.dropId === 'card_nft_2'));
  assert.ok(sharedScope);
  const runtimes = listShopCollectionQueryRuntimes(false);
  const cardDrop = runtimes.find((drop) => drop.dropId === 'card_nft_2');
  const clearCardsDrop = runtimes.find((drop) => drop.dropId === 'clear_cards');
  const littleSwagDrop = runtimes.find((drop) => drop.dropId === 'little_swag_boxes');
  const shirtDrop = runtimes.find((drop) => drop.dropId === 'drifella_shirt');
  assert.ok(cardDrop?.boxMinterConfigPda);
  assert.ok(clearCardsDrop?.boxMinterConfigPda);
  assert.ok(littleSwagDrop);
  assert.ok(shirtDrop);

  const entry = (
    candidateDrops: PendingOpenRecordCandidate['candidateDrops'],
    dudeCount: number,
    configPda?: string,
  ): PendingOpenRecordCandidate => ({
    solanaCluster: 'mainnet-beta',
    pendingPda: 'pending',
    boxAssetId: 'box',
    dudeAssetIds: Array.from({ length: dudeCount }, (_, index) => `dude-${index}`),
    candidateDrops,
    ...(configPda ? { configPda } : {}),
  });
  const cardAsset = {
    grouping: [{ group_key: 'collection', group_value: cardDrop.collectionMint }],
    content: { json_uri: `${cardDrop.metadataBase}/c1.json` },
  };
  const shirtAsset = {
    grouping: [{ group_key: 'collection', group_value: shirtDrop.collectionMint }],
    content: { json_uri: `${shirtDrop.metadataBase}/b1.json` },
  };

  assert.equal(resolvePendingOpenDropId(entry(sharedScope.drops, 3, cardDrop.boxMinterConfigPda)), 'card_nft_2');
  assert.equal(resolvePendingOpenDropId(entry(sharedScope.drops, 1, cardDrop.boxMinterConfigPda)), null);
  assert.equal(resolvePendingOpenDropId(entry(sharedScope.drops, 0, shirtDrop.boxMinterConfigPda)), null);
  assert.equal(resolvePendingOpenDropId(entry([shirtDrop], 0)), null);
  assert.equal(resolvePendingOpenDropId(entry([cardDrop, shirtDrop], 0), shirtAsset), null);
  assert.equal(resolvePendingOpenDropId(entry([cardDrop], 6)), null);
  assert.equal(resolvePendingOpenDropId(entry([cardDrop], 3)), 'card_nft_2');
  assert.equal(resolvePendingOpenDropId(entry([cardDrop], 1)), null);
  assert.equal(resolvePendingOpenDropId(entry(sharedScope.drops, 3)), 'card_nft_2');
  assert.equal(resolvePendingOpenDropId(entry(sharedScope.drops, 1)), 'clear_cards');
  assert.equal(resolvePendingOpenDropId(entry([cardDrop, littleSwagDrop], 3), cardAsset), 'card_nft_2');
  assert.equal(resolvePendingOpenDropId(entry(sharedScope.drops, 2), shirtAsset), null);
});

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
test('inventory resolution accepts a configured legacy metadata base alias only', () => {
  const canonicalBase = 'https://cdn.lil.org/nft/little_swag_boxes';
  const legacyBase = 'https://assets.mons.link/drops/lsb';
  const candidates: InventoryDropResolutionCandidate[] = [
    {
      dropId: 'little_swag_boxes',
      solanaCluster: 'mainnet-beta',
      collectionMint: LITTLE_SWAG_BOXES_COLLECTION,
      receiptsMerkleTree: null,
      metadataBase: canonicalBase,
      metadataBaseAliases: [legacyBase],
      maxSupply: 333,
    },
    {
      dropId: 'unrelated_drop',
      solanaCluster: 'mainnet-beta',
      collectionMint: LITTLE_SWAG_BOXES_COLLECTION,
      receiptsMerkleTree: null,
      metadataBase: 'https://cdn.lil.org/nft/unrelated_drop',
      maxSupply: 333,
    },
  ];
  const asset = {
    id: 'legacy-lsb-box',
    grouping: [{ group_key: 'collection', group_value: LITTLE_SWAG_BOXES_COLLECTION }],
    content: { json_uri: `${legacyBase}/json/boxes/7.json` },
  };

  assert.equal(
    resolveInventoryAssetDropId(asset, candidates, 'mainnet-beta'),
    'little_swag_boxes',
  );
  assert.equal(
    resolveInventoryAssetDropId(
      {
        ...asset,
        content: { json_uri: 'https://assets.example.com/drops/lsb/json/boxes/7.json' },
      },
      candidates,
      'mainnet-beta',
    ),
    null,
  );
});

test('Poncho inventory resolves canonical and legacy roots while unrelated roots stay strict', () => {
  const canonicalBase = 'https://cdn.lil.org/nft/poncho_drifella';
  const legacyBase = 'https://assets.mons.link/drops/poncho';
  const candidates: InventoryDropResolutionCandidate[] = [
    {
      dropId: 'poncho_drifella',
      solanaCluster: 'mainnet-beta',
      collectionMint: PONCHO_DRIFELLA_COLLECTION,
      receiptsMerkleTree: '5wCjVex6yXCms518RccxmAaVMGoPvTEQcb4UR3MYtQow',
      metadataBase: canonicalBase,
      metadataBaseAliases: [legacyBase],
      maxSupply: 207,
    },
    {
      dropId: 'unrelated_drop',
      solanaCluster: 'mainnet-beta',
      collectionMint: PONCHO_DRIFELLA_COLLECTION,
      receiptsMerkleTree: null,
      metadataBase: 'https://cdn.lil.org/nft/unrelated_drop',
      maxSupply: 207,
    },
  ];
  const asset = (uri: string) => ({
    id: uri,
    grouping: [{ group_key: 'collection', group_value: PONCHO_DRIFELLA_COLLECTION }],
    content: { json_uri: uri },
  });

  assert.equal(
    resolveInventoryAssetDropId(
      asset(`${legacyBase}/json/boxes/7.json`),
      candidates,
      'mainnet-beta',
    ),
    'poncho_drifella',
  );
  assert.equal(
    resolveInventoryAssetDropId(
      asset(`${canonicalBase}/json/figures/207.json`),
      candidates,
      'mainnet-beta',
    ),
    'poncho_drifella',
  );
  assert.equal(
    resolveInventoryAssetDropId(
      asset('https://cdn.lil.org/nft/poncho_drifella_evil/json/boxes/7.json'),
      candidates,
      'mainnet-beta',
    ),
    null,
  );
});
