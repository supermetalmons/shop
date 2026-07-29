import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import {
  assetMatchesReceiptDropIdentity,
  assetMatchesReceiptMetadataIdentity,
  assetProofMatchesTree,
  assetProofTreePublicKey,
  normalizedAssetProofAccounts,
  receiptMetadataReference,
} from '../functions/src/receiptProof.ts';

const TREE = new PublicKey('11111111111111111111111111111112');
const OTHER_TREE = new PublicKey('11111111111111111111111111111113');
const COLLECTION = new PublicKey('11111111111111111111111111111114');
const METADATA_BASE = 'https://cdn.lil.org/nft/card_nft_binder/json';

function receiptAsset(uri = `${METADATA_BASE}/rb7.json`) {
  return {
    grouping: [{ group_key: 'collection', group_value: COLLECTION.toBase58() }],
    content: { json_uri: uri },
  };
}

test('asset proof tree parser accepts Helius tree_id and treeId aliases', () => {
  assert.equal(assetProofTreePublicKey({ tree_id: TREE.toBase58() })?.toBase58(), TREE.toBase58());
  assert.equal(assetProofTreePublicKey({ treeId: TREE.toBase58() })?.toBase58(), TREE.toBase58());
});

test('asset proof tree parser rejects invalid or missing tree ids', () => {
  assert.equal(assetProofTreePublicKey({}), null);
  assert.equal(assetProofTreePublicKey({ tree_id: '' }), null);
  assert.equal(assetProofTreePublicKey({ tree_id: 'not-a-public-key' }), null);
  assert.equal(assetProofTreePublicKey(null), null);
});

test('asset proof tree matcher compares against the expected tree', () => {
  assert.equal(assetProofMatchesTree({ tree_id: TREE.toBase58() }, TREE), true);
  assert.equal(assetProofMatchesTree({ treeId: OTHER_TREE.toBase58() }, TREE), false);
  assert.equal(assetProofMatchesTree({ tree_id: 'not-a-public-key' }, TREE), false);
});

test('receipt metadata identity requires the canonical base and exact rb id', () => {
  const drop = {
    collectionMintStr: COLLECTION.toBase58(),
    metadataBase: `${METADATA_BASE}/`,
    receiptPoolId: 'mons_shop_receipts',
    receiptMaxId: 20,
  };
  assert.deepEqual(receiptMetadataReference(receiptAsset()), { kind: 'box', id: 7 });
  assert.equal(assetMatchesReceiptMetadataIdentity(receiptAsset(), drop, { kind: 'box', id: 7 }), true);
  assert.equal(assetMatchesReceiptMetadataIdentity(receiptAsset(), drop, { kind: 'box', id: 8 }), false);
  assert.equal(
    assetMatchesReceiptMetadataIdentity(receiptAsset('https://cdn.lil.org/nft/other/json/rb7.json'), drop),
    false,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(receiptAsset(`${METADATA_BASE}/rb07.json`), drop),
    false,
  );
  for (const uri of [
    `${METADATA_BASE}/RB7.JSON`,
    `${METADATA_BASE}/rb7.json?version=1`,
    `${METADATA_BASE}/rb7.json#receipt`,
    `${METADATA_BASE}/json/receipts/boxes/7.json`,
    `${METADATA_BASE}/rb21.json`,
    `${METADATA_BASE}/rb9007199254740992.json`,
  ]) {
    assert.equal(
      assetMatchesReceiptMetadataIdentity(receiptAsset(uri), drop),
      false,
      uri,
    );
  }
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset(`${METADATA_BASE}/rb16.json`),
      drop,
      { kind: 'box', id: 16 },
    ),
    true,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset(`${METADATA_BASE}/rb20.json`),
      drop,
      { kind: 'box', id: 20 },
    ),
    true,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      { ...receiptAsset(), content: {} },
      drop,
    ),
    false,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      { ...receiptAsset(), grouping: [{ group_key: 'collection', group_value: OTHER_TREE.toBase58() }] },
      drop,
    ),
    false,
  );
  assert.equal(assetMatchesReceiptMetadataIdentity({ ...receiptAsset(), grouping: [] }, drop), false);
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      {
        ...receiptAsset(),
        grouping: [
          { group_key: 'collection', group_value: COLLECTION.toBase58() },
          { group_key: 'collection', group_value: OTHER_TREE.toBase58() },
        ],
      },
      drop,
    ),
    false,
  );
});

test('non-pooled receipt metadata identity retains legacy URI compatibility', () => {
  const drop = {
    collectionMintStr: COLLECTION.toBase58(),
    metadataBase: METADATA_BASE,
    receiptMaxId: 15,
  };
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset(`${METADATA_BASE}/json/receipts/boxes/7.json?legacy=1`),
      drop,
      { kind: 'box', id: 7 },
    ),
    true,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset(`${METADATA_BASE}/RB7.JSON`),
      drop,
      { kind: 'box', id: 7 },
    ),
    true,
  );
});

test('receipt drop identity additionally requires the configured tree', () => {
  const drop = {
    collectionMintStr: COLLECTION.toBase58(),
    metadataBase: METADATA_BASE,
    receiptsMerkleTree: TREE,
    receiptPoolId: 'mons_shop_receipts',
    receiptMaxId: 20,
  };
  assert.equal(
    assetMatchesReceiptDropIdentity(receiptAsset(), { tree_id: TREE.toBase58() }, drop, { kind: 'box', id: 7 }),
    true,
  );
  assert.equal(
    assetMatchesReceiptDropIdentity(receiptAsset(), { tree_id: OTHER_TREE.toBase58() }, drop, { kind: 'box', id: 7 }),
    false,
  );
});

test('proof normalization accepts trimmed depth 6 and trims full depth 14', () => {
  const fullProof = Array.from(
    { length: 14 },
    (_, index) => new PublicKey(Uint8Array.from({ length: 32 }, () => index + 1)).toBase58(),
  );
  const trimmedProof = fullProof.slice(0, 6);

  assert.deepEqual(
    normalizedAssetProofAccounts({ proof: trimmedProof }, { maxDepth: 14, canopyDepth: 8 }).map((key) => key.toBase58()),
    trimmedProof,
  );
  assert.deepEqual(
    normalizedAssetProofAccounts({ proof: fullProof }, { maxDepth: 14, canopyDepth: 8 }).map((key) => key.toBase58()),
    trimmedProof,
  );
  assert.throws(
    () => normalizedAssetProofAccounts({ proof: fullProof.slice(0, 7) }, { maxDepth: 14, canopyDepth: 8 }),
    /expected 6 trimmed or 14 full/,
  );
  assert.throws(
    () => normalizedAssetProofAccounts({ proof: [] }, { maxDepth: 14, canopyDepth: 14 }),
    /canopy depth is invalid/,
  );
});
