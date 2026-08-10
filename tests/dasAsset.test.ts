import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dasAssetBoxId,
  dasAssetDudeId,
  dasAssetKind,
  dasAssetLooksBurntOrClosed,
  dasAssetMatchesCollection,
  dasAssetMetadataName,
  dasAssetMetadataUri,
} from '../functions/src/shared/dasAsset.ts';
import {
  SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES,
  SHOP_INVENTORY_NAME_MAX_UTF8_BYTES,
  SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES,
  shopApiUtf8ByteLength,
} from '../functions/src/shared/shopApi.ts';
import {
  listShopCollectionQueryRuntimes,
  transformShopInventoryItem,
} from '../functions/src/shared/shopDomain.ts';

const STRING_ONLY_NAME = { metadataNameMode: 'string-only' } as const;
const COERCED_NAME = { metadataNameMode: 'coerce' } as const;
const CHECK_SCRIPT_BURN_POLICY = {
  missingAssetResult: false,
  nonBooleanFlagIsBurnt: true,
} as const;
const ASSIGN_SCRIPT_BURN_POLICY = {
  missingAssetResult: true,
  nonBooleanFlagIsBurnt: true,
} as const;
const INDEX_BURN_POLICY = {
  missingAssetResult: true,
  nonBooleanFlagIsBurnt: false,
} as const;

test('DAS metadata parsing preserves URI and attribute fallback order', () => {
  const asset = {
    content: {
      json_uri: '',
      jsonUri: 'https://metadata.example/drop/rf17.json',
      metadata: {
        uri: 'https://metadata.example/drop/b9.json',
        attributes: [
          { trait_type: 'type', value: 'certificate' },
          { trait_type: 'box_id', value: ' 08 ' },
          { trait_type: 'dude_id', value: '2.75' },
        ],
      },
    },
  };

  assert.equal(dasAssetMetadataUri(asset), 'https://metadata.example/drop/rf17.json');
  assert.equal(dasAssetKind(asset, STRING_ONLY_NAME), 'certificate');
  assert.equal(dasAssetBoxId(asset, STRING_ONLY_NAME), ' 08 ');
  assert.equal(dasAssetDudeId(asset), 17);
});

test('DAS name policies preserve script-specific string coercion', () => {
  const name = { toString: () => 'Box #42' };
  const asset = { content: { metadata: { name, title: 'Figure 9' } } };

  assert.equal(dasAssetKind(asset, STRING_ONLY_NAME), null);
  assert.equal(dasAssetBoxId(asset, STRING_ONLY_NAME), undefined);
  assert.equal(dasAssetMetadataName(asset), undefined);
  assert.equal(dasAssetKind(asset, COERCED_NAME), 'box');
  assert.equal(dasAssetBoxId(asset, COERCED_NAME), '42');
});

test('DAS metadata name fallback preserves truthy names and rejects empty dude IDs', () => {
  const titleFallback = { content: { metadata: { name: 0, title: 'Figure 9' } } };
  const emptyDudeAttribute = {
    content: {
      metadata: {
        attributes: [{ trait_type: 'dude_id', value: '' }],
      },
    },
  };

  assert.equal(dasAssetMetadataName(titleFallback), 'Figure 9');
  assert.equal(dasAssetKind(titleFallback, STRING_ONLY_NAME), 'dude');
  assert.equal(dasAssetDudeId(emptyDudeAttribute), undefined);
});

test('DAS dude IDs must be positive and zero falls through or remains absent', () => {
  for (const value of [0, '0']) {
    assert.equal(dasAssetDudeId({
      content: {
        json_uri: 'https://metadata.example/drop/rf17.json',
        metadata: {
          attributes: [{ trait_type: 'dude_id', value }],
        },
      },
    }), 17);
  }

  assert.equal(dasAssetDudeId({
    content: { json_uri: 'https://metadata.example/drop/rf0.json' },
  }), undefined);

  const drop = listShopCollectionQueryRuntimes(false).find((entry) => entry.dropId === 'drifella_shirt');
  assert.ok(drop);
  const item = transformShopInventoryItem({
    id: 'zero-dude-asset',
    burnt: false,
    grouping: [{ group_key: 'collection', group_value: drop.collectionMint }],
    content: {
      json_uri: `${drop.metadataBase}/legacy.json`,
      metadata: {
        name: 'Dude #0',
        attributes: [{ trait_type: 'type', value: 'dude' }],
      },
    },
  }, drop.solanaCluster);
  assert.ok(item);
  assert.equal(item.dudeId, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'dudeId'), false);
});

test('DAS URI parsing supplies kind and ids when attributes are absent', () => {
  const box = { content: { metadata: { json_uri: 'https://metadata.example/drop/b123.json' } } };
  const receipt = { content: { json_uri: 'https://metadata.example/drop/rf456.json' } };

  assert.equal(dasAssetKind(box, STRING_ONLY_NAME), 'box');
  assert.equal(dasAssetBoxId(box, STRING_ONLY_NAME), '123');
  assert.equal(dasAssetKind(receipt, STRING_ONLY_NAME), 'certificate');
  assert.equal(dasAssetDudeId(receipt), 456);
});

test('shop inventory normalizes malformed dude IDs and falls back to the metadata name', () => {
  const drop = listShopCollectionQueryRuntimes(false).find((entry) => entry.dropId === 'drifella_shirt');
  assert.ok(drop);
  const item = transformShopInventoryItem({
    id: 'dude-asset',
    burnt: false,
    grouping: [{ group_key: 'collection', group_value: drop.collectionMint }],
    content: {
      json_uri: `${drop.metadataBase}/legacy.json`,
      metadata: {
        name: 'Dude #42',
        attributes: [
          { trait_type: 'type', value: 'dude' },
          { trait_type: 'dude_id', value: '1.5' },
        ],
      },
    },
  }, drop.solanaCluster);
  assert.equal(item?.dudeId, 42);
});

test('shop inventory compacts metadata at exact UTF-8 boundaries', () => {
  const drop = listShopCollectionQueryRuntimes(false).find((entry) => entry.dropId === 'drifella_shirt');
  assert.ok(drop);
  const name = 'é'.repeat(SHOP_INVENTORY_NAME_MAX_UTF8_BYTES / 2);
  const rawImage = 'i'.repeat(SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES);
  const boxId = 'b'.repeat(SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES);
  const item = transformShopInventoryItem({
    id: 'bounded-shop-asset',
    burnt: false,
    grouping: [{ group_key: 'collection', group_value: drop.collectionMint }],
    content: {
      json_uri: `${drop.metadataBase}/legacy.json`,
      links: { image: rawImage },
      metadata: {
        name,
        attributes: [
          { trait_type: 'type', value: 'box' },
          { trait_type: 'box_id', value: boxId },
          { trait_type: 'unused', value: 'not retained' },
        ],
      },
    },
  }, drop.solanaCluster);

  assert.deepEqual(item, {
    id: 'bounded-shop-asset',
    dropId: drop.dropId,
    name,
    kind: 'box',
    rawImage,
    boxId,
  });
  assert.equal(shopApiUtf8ByteLength(item.name), SHOP_INVENTORY_NAME_MAX_UTF8_BYTES);
});

test('shop inventory truncates names without splitting UTF-8 and omits oversized URLs and identifiers', () => {
  const drop = listShopCollectionQueryRuntimes(false).find((entry) => entry.dropId === 'drifella_shirt');
  assert.ok(drop);
  const item = transformShopInventoryItem({
    id: 'oversized-shop-asset',
    burnt: false,
    grouping: [{ group_key: 'collection', group_value: drop.collectionMint }],
    content: {
      json_uri: `${drop.metadataBase}/legacy.json`,
      links: { image: 'i'.repeat(SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES + 1) },
      metadata: {
        name: `${'n'.repeat(SHOP_INVENTORY_NAME_MAX_UTF8_BYTES - 1)}💥`,
        attributes: [
          { trait_type: 'type', value: 'box' },
          { trait_type: 'box_id', value: 'b'.repeat(SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES + 1) },
        ],
      },
    },
  }, drop.solanaCluster);

  assert.ok(item);
  assert.equal(item.name, 'n'.repeat(SHOP_INVENTORY_NAME_MAX_UTF8_BYTES - 1));
  assert.equal(shopApiUtf8ByteLength(item.name), SHOP_INVENTORY_NAME_MAX_UTF8_BYTES - 1);
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'rawImage'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'boxId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'attributes'), false);
});

test('DAS metadata parsing treats malformed attribute containers as absent', () => {
  for (const attributes of [null, {}, 'invalid']) {
    const box = {
      content: {
        metadata: {
          attributes,
          uri: 'https://metadata.example/drop/b123.json',
        },
      },
    };
    const receipt = {
      content: {
        metadata: {
          attributes,
          uri: 'https://metadata.example/drop/rf456.json',
        },
      },
    };

    assert.doesNotThrow(() => dasAssetKind(box, STRING_ONLY_NAME));
    assert.equal(dasAssetKind(box, STRING_ONLY_NAME), 'box');
    assert.equal(dasAssetBoxId(box, STRING_ONLY_NAME), '123');
    assert.equal(dasAssetKind(receipt, STRING_ONLY_NAME), 'certificate');
    assert.equal(dasAssetDudeId(receipt), 456);
  }
});

test('DAS burn parsing makes missing-asset policy explicit and preserves markers', () => {
  assert.equal(dasAssetLooksBurntOrClosed(null, CHECK_SCRIPT_BURN_POLICY), false);
  assert.equal(dasAssetLooksBurntOrClosed(null, ASSIGN_SCRIPT_BURN_POLICY), true);
  assert.equal(
    dasAssetLooksBurntOrClosed({ burnt: false, burned: true }, CHECK_SCRIPT_BURN_POLICY),
    false,
  );
  assert.equal(
    dasAssetLooksBurntOrClosed(
      { compression: { is_burnt: { slot: 12 } } },
      CHECK_SCRIPT_BURN_POLICY,
    ),
    true,
  );
  assert.equal(
    dasAssetLooksBurntOrClosed({ compression: { is_burnt: { slot: 12 } } }, INDEX_BURN_POLICY),
    false,
  );
  assert.equal(
    dasAssetLooksBurntOrClosed(
      { ownership: { ownership_state: 'BURNED' } },
      CHECK_SCRIPT_BURN_POLICY,
    ),
    true,
  );
});

test('DAS burn parsing can preserve the frontend narrower aliases and state handling', () => {
  const frontendPolicy = {
    missingAssetResult: false,
    nonBooleanFlagIsBurnt: true,
    includeAlternateFlagNames: false,
    includeOwnershipState: false,
  } as const;

  assert.equal(
    dasAssetLooksBurntOrClosed({ compression: { is_burnt: true } }, frontendPolicy),
    false,
  );
  assert.equal(
    dasAssetLooksBurntOrClosed(
      { ownership: { ownership_state: 'BURNED' } },
      frontendPolicy,
    ),
    false,
  );
  assert.equal(
    dasAssetLooksBurntOrClosed({ compression: { burnt: { slot: 12 } } }, frontendPolicy),
    true,
  );
});

test('DAS collection matching accepts grouping or metadata fallback without coercion', () => {
  assert.equal(
    dasAssetMatchesCollection(
      {
        grouping: [{ group_key: 'collection', group_value: 'collection-1' }],
        content: { metadata: { collection: { key: 'other' } } },
      },
      'collection-1',
    ),
    true,
  );
  assert.equal(
    dasAssetMatchesCollection(
      {
        grouping: [{ group_key: 'collection', group_value: 'other' }],
        content: { metadata: { collection: { key: 'collection-1' } } },
      },
      'collection-1',
    ),
    true,
  );
  assert.equal(
    dasAssetMatchesCollection(
      {
        grouping: [{ group_key: 'collection', group_value: 1 }],
        content: { metadata: { collection: { key: 1 } } },
      },
      '1',
    ),
    false,
  );
});
