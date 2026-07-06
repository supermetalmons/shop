import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assetGroupingAllowsTreeVerifiedCollectionMatch as frontendAssetGroupingAllowsTreeVerifiedCollectionMatch,
  assetGroupingCollectionMints as frontendAssetGroupingCollectionMints,
  uniqueAssetGroupingCollectionMint as frontendUniqueAssetGroupingCollectionMint,
} from '../src/lib/dasAssetCollections.ts';
import {
  assetGroupingAllowsTreeVerifiedCollectionMatch as functionsAssetGroupingAllowsTreeVerifiedCollectionMatch,
  assetGroupingCollectionMints as functionsAssetGroupingCollectionMints,
  uniqueAssetGroupingCollectionMint as functionsUniqueAssetGroupingCollectionMint,
} from '../functions/src/dasAssetCollections.ts';

const helperPairs = [
  {
    label: 'frontend',
    assetGroupingAllowsTreeVerifiedCollectionMatch: frontendAssetGroupingAllowsTreeVerifiedCollectionMatch,
    assetGroupingCollectionMints: frontendAssetGroupingCollectionMints,
    uniqueAssetGroupingCollectionMint: frontendUniqueAssetGroupingCollectionMint,
  },
  {
    label: 'functions',
    assetGroupingAllowsTreeVerifiedCollectionMatch: functionsAssetGroupingAllowsTreeVerifiedCollectionMatch,
    assetGroupingCollectionMints: functionsAssetGroupingCollectionMints,
    uniqueAssetGroupingCollectionMint: functionsUniqueAssetGroupingCollectionMint,
  },
];

test('DAS collection helpers stay aligned across frontend and functions copies', () => {
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

  for (const helper of helperPairs) {
    for (const entry of cases) {
      assert.deepEqual(
        helper.assetGroupingCollectionMints(entry.asset),
        entry.collections,
        `${helper.label}: ${entry.name} collections`,
      );
      assert.equal(
        helper.uniqueAssetGroupingCollectionMint(entry.asset),
        entry.unique,
        `${helper.label}: ${entry.name} unique collection`,
      );
    }
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

  for (const helper of helperPairs) {
    for (const entry of cases) {
      assert.equal(
        helper.assetGroupingAllowsTreeVerifiedCollectionMatch(entry.asset, entry.expectedCollectionMint),
        entry.allowed,
        `${helper.label}: ${entry.name}`,
      );
    }
  }
});
