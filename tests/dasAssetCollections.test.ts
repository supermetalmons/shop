import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assetGroupingAllowsTreeVerifiedCollectionMatch,
  assetGroupingCollectionMints,
  uniqueAssetGroupingCollectionMint,
} from '../shared/dasAssetCollections.ts';

test('DAS collection helpers normalize collection groupings', () => {
  const cases = [
    {
      name: 'null asset',
      asset: null,
      collections: [],
      unique: null,
    },
    {
      name: 'missing grouping',
      asset: {},
      collections: [],
      unique: null,
    },
    {
      name: 'metadata collection without grouping',
      asset: { content: { metadata: { collection: { key: 'collection-1' } } } },
      collections: [],
      unique: null,
    },
    {
      name: 'ignores malformed groups',
      asset: {
        grouping: [
          null,
          'collection-1',
          { group_key: 'creator', group_value: 'creator-1' },
          { group_key: 'collection', group_value: '' },
        ],
      },
      collections: [],
      unique: null,
    },
    {
      name: 'single collection',
      asset: { grouping: [{ group_key: 'collection', group_value: 'collection-1' }] },
      collections: ['collection-1'],
      unique: 'collection-1',
    },
    {
      name: 'duplicate collection',
      asset: {
        grouping: [
          { group_key: 'collection', group_value: 'collection-1' },
          { group_key: 'collection', group_value: 'collection-1' },
        ],
      },
      collections: ['collection-1'],
      unique: 'collection-1',
    },
    {
      name: 'multiple collections',
      asset: {
        grouping: [
          { group_key: 'collection', group_value: 'collection-1' },
          { group_key: 'collection', group_value: 'collection-2' },
        ],
      },
      collections: ['collection-1', 'collection-2'],
      unique: null,
    },
  ];

  for (const entry of cases) {
    assert.deepEqual(
      assetGroupingCollectionMints(entry.asset),
      entry.collections,
      `${entry.name} collections`,
    );
    assert.equal(
      uniqueAssetGroupingCollectionMint(entry.asset),
      entry.unique,
      `${entry.name} unique collection`,
    );
  }
});

test('DAS collection helpers allow tree proof only when grouping is inconclusive or includes expected collection', () => {
  const cases = [
    {
      name: 'missing grouping',
      asset: {},
      expectedCollectionMint: 'collection-1',
      allowed: true,
    },
    {
      name: 'single expected collection',
      asset: { grouping: [{ group_key: 'collection', group_value: 'collection-1' }] },
      expectedCollectionMint: 'collection-1',
      allowed: true,
    },
    {
      name: 'multiple collections including expected',
      asset: {
        grouping: [
          { group_key: 'collection', group_value: 'collection-1' },
          { group_key: 'collection', group_value: 'collection-2' },
        ],
      },
      expectedCollectionMint: 'collection-1',
      allowed: true,
    },
    {
      name: 'only another collection',
      asset: { grouping: [{ group_key: 'collection', group_value: 'collection-2' }] },
      expectedCollectionMint: 'collection-1',
      allowed: false,
    },
    {
      name: 'missing expected collection',
      asset: {},
      expectedCollectionMint: '',
      allowed: false,
    },
  ];

  for (const entry of cases) {
    assert.equal(
      assetGroupingAllowsTreeVerifiedCollectionMatch(entry.asset, entry.expectedCollectionMint),
      entry.allowed,
      entry.name,
    );
  }
});
