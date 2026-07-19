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
  assert.equal(dasAssetDudeId(asset), 2.75);
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

test('DAS metadata name fallback keeps JavaScript truthy and number semantics', () => {
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
  assert.equal(dasAssetDudeId(emptyDudeAttribute), 0);
});

test('DAS URI parsing supplies kind and ids when attributes are absent', () => {
  const box = { content: { metadata: { json_uri: 'https://metadata.example/drop/b123.json' } } };
  const receipt = { content: { json_uri: 'https://metadata.example/drop/rf456.json' } };

  assert.equal(dasAssetKind(box, STRING_ONLY_NAME), 'box');
  assert.equal(dasAssetBoxId(box, STRING_ONLY_NAME), '123');
  assert.equal(dasAssetKind(receipt, STRING_ONLY_NAME), 'certificate');
  assert.equal(dasAssetDudeId(receipt), 456);
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
