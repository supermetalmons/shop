import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import {
  assetMatchesReceiptDropIdentity,
  assetMatchesReceiptMetadataIdentity,
  assetProofMatchesTree,
  assetProofTreePublicKey,
  decodeReceiptProof,
  normalizedAssetProofAccounts,
  ReceiptProofDecodeError,
  receiptMetadataReference,
} from '../cloud/workers/api/src/receiptProof.ts';

const TREE = new PublicKey('11111111111111111111111111111112');
const OTHER_TREE = new PublicKey('11111111111111111111111111111113');
const COLLECTION = new PublicKey('11111111111111111111111111111114');
const METADATA_BASE = 'https://cdn.lil.org/nft/card_nft_binder/json';
const OWNER = new PublicKey(Uint8Array.from({ length: 32 }, () => 4));
const DELEGATE = new PublicKey(Uint8Array.from({ length: 32 }, () => 5));
const HASHES = [6, 7, 8, 9].map((value) => Buffer.alloc(32, value));

function receiptProofInput() {
  return {
    asset: {
      compression: {
        leaf_id: 7,
        data_hash: new PublicKey(HASHES[1]).toBase58(),
        creator_hash: new PublicKey(HASHES[2]).toBase58(),
        asset_data_hash: new PublicKey(HASHES[3]).toBase58(),
        flags: 3,
      } as Record<string, unknown>,
      ownership: { owner: OWNER.toBase58(), delegate: DELEGATE.toBase58() } as Record<string, unknown>,
    },
    proof: {
      tree_id: TREE.toBase58(),
      root: new PublicKey(HASHES[0]).toBase58(),
      proof: [TREE.toBase58(), OTHER_TREE.toBase58()],
    } as Record<string, unknown>,
    expectedTree: TREE,
    expectedOwner: OWNER.toBase58(),
  };
}

function assertDecodeFailure(
  input: Parameters<typeof decodeReceiptProof>[0],
  reason: ReceiptProofDecodeError['reason'],
  message?: string,
) {
  assert.throws(() => decodeReceiptProof(input), (error) => {
    assert.ok(error instanceof ReceiptProofDecodeError);
    assert.equal(error.reason, reason);
    if (message) assert.equal(error.message, message);
    return true;
  });
}

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

test('non-pooled receipt metadata identity accepts configured base aliases only', () => {
  const legacyBase = 'https://assets.mons.link/drops/lsb';
  const drop = {
    collectionMintStr: COLLECTION.toBase58(),
    metadataBase: 'https://cdn.lil.org/nft/little_swag_boxes',
    metadataBaseAliases: [legacyBase],
    receiptMaxId: 333,
  };

  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset(`${legacyBase}/json/receipts/boxes/7.json`),
      drop,
      { kind: 'box', id: 7 },
    ),
    true,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset('https://assets.example.com/drops/lsb/json/receipts/boxes/7.json'),
      drop,
      { kind: 'box', id: 7 },
    ),
    false,
  );
});

test('Poncho receipt identity accepts canonical and legacy roots only', () => {
  const legacyBase = 'https://assets.mons.link/drops/poncho';
  const canonicalBase = 'https://cdn.lil.org/nft/poncho_drifella';
  const drop = {
    collectionMintStr: COLLECTION.toBase58(),
    metadataBase: canonicalBase,
    metadataBaseAliases: [legacyBase],
    receiptMaxId: 207,
  };

  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset(`${legacyBase}/json/receipts/figures/207.json`),
      drop,
      { kind: 'figure', id: 207 },
    ),
    true,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset(`${canonicalBase}/json/receipts/boxes/7.json`),
      drop,
      { kind: 'box', id: 7 },
    ),
    true,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset('https://assets.mons.link/drops/poncho-copy/json/receipts/boxes/7.json'),
      drop,
      { kind: 'box', id: 7 },
    ),
    false,
  );
});

test('Card NFT 2 compact receipt identity accepts canonical and legacy roots only', () => {
  const legacyBase = 'https://assets.mons.link/drops/cardnft2/json';
  const canonicalBase = 'https://cdn.lil.org/nft/card_nft_2/json';
  const drop = {
    collectionMintStr: COLLECTION.toBase58(),
    metadataBase: canonicalBase,
    metadataBaseAliases: [legacyBase],
    receiptMaxId: 11_133,
  };

  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset(`${legacyBase}/rf11133.json`),
      drop,
      { kind: 'figure', id: 11_133 },
    ),
    true,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset(`${canonicalBase}/rb3711.json`),
      drop,
      { kind: 'box', id: 3_711 },
    ),
    true,
  );
  assert.equal(
    assetMatchesReceiptMetadataIdentity(
      receiptAsset('https://cdn.lil.org/nft/card_nft_2/rb3711.json'),
      drop,
      { kind: 'box', id: 3_711 },
    ),
    false,
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

test('receipt proof decoder returns transaction-ready public keys and 32-byte buffers', () => {
  const decoded = decodeReceiptProof(receiptProofInput());
  assert.deepEqual(decoded, {
    merkleTree: TREE,
    root: HASHES[0],
    dataHash: HASHES[1],
    creatorHash: HASHES[2],
    assetDataHash: HASHES[3],
    flags: 3,
    nonce: 7,
    index: 7,
    proofAccounts: [TREE, OTHER_TREE],
    leafOwner: OWNER,
    leafDelegate: DELEGATE,
  });
  for (const hash of [decoded.root, decoded.dataHash, decoded.creatorHash, decoded.assetDataHash]) {
    assert.ok(Buffer.isBuffer(hash));
  }
});

test('receipt proof decoder accepts camelCase aliases and nullish snake_case fields', () => {
  for (const snakeCaseValue of [undefined, null]) {
    const input = receiptProofInput();
    input.asset.compression = {
      leaf_id: snakeCaseValue,
      leafId: '7',
      data_hash: snakeCaseValue,
      dataHash: new PublicKey(HASHES[1]).toBase58(),
      creator_hash: snakeCaseValue,
      creatorHash: new PublicKey(HASHES[2]).toBase58(),
      asset_data_hash: snakeCaseValue,
      assetDataHash: new PublicKey(HASHES[3]).toBase58(),
      flags: '3',
    };
    input.proof.tree_id = snakeCaseValue;
    input.proof.treeId = TREE.toBase58();
    assert.deepEqual(decodeReceiptProof(input), decodeReceiptProof(receiptProofInput()));
  }
});

test('receipt proof decoder preserves primary aliases when alternate values are present', () => {
  const input = receiptProofInput();
  input.asset.compression.leafId = 99;
  input.asset.compression.dataHash = 'invalid';
  input.asset.compression.creatorHash = 'invalid';
  input.asset.compression.assetDataHash = 'invalid';
  input.proof.treeId = OTHER_TREE.toBase58();
  assert.deepEqual(decodeReceiptProof(input), decodeReceiptProof(receiptProofInput()));

  for (const [field, alias] of [['data_hash', 'dataHash'], ['creator_hash', 'creatorHash'], ['asset_data_hash', 'assetDataHash']]) {
    const emptyPrimary = receiptProofInput();
    emptyPrimary.asset.compression[alias] = emptyPrimary.asset.compression[field];
    emptyPrimary.asset.compression[field] = '';
    assertDecodeFailure(emptyPrimary, 'invalid-hash-length', `Invalid asset.compression.${field} length`);
  }
  input.proof.tree_id = '';
  assertDecodeFailure(input, 'missing-proof');
});

test('receipt proof decoder trims full paths and accepts already trimmed paths', () => {
  const fullProof = Array.from({ length: 14 }, (_, index) => new PublicKey(Buffer.alloc(32, index + 1)).toBase58());
  for (const proof of [fullProof, fullProof.slice(0, 6)]) {
    const input = receiptProofInput();
    input.proof.proof = proof;
    const decoded = decodeReceiptProof({ ...input, dimensions: { maxDepth: 14, canopyDepth: 8 } });
    assert.deepEqual(decoded.proofAccounts.map((key) => key.toBase58()), fullProof.slice(0, 6));
  }
});

test('receipt proof decoder retains numeric coercion and unsigned 32-bit leaf boundaries', () => {
  for (const value of [0, 0xffff_ffff, '42', ' 12 ', '', false, true]) {
    const input = receiptProofInput();
    input.asset.compression.leaf_id = value;
    const decoded = decodeReceiptProof(input);
    assert.equal(decoded.nonce, Number(value));
    assert.equal(decoded.index, Number(value));
  }
  for (const value of [-1, 1.5, NaN, Infinity, 'bad', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const input = receiptProofInput();
    input.asset.compression.leaf_id = value;
    assertDecodeFailure(input, 'invalid-nonce');
  }
  for (const value of [0x1_0000_0000, Number.MAX_SAFE_INTEGER]) {
    const input = receiptProofInput();
    input.asset.compression.leaf_id = value;
    assertDecodeFailure(input, 'index-out-of-range');
  }
});

test('receipt proof decoder falls back to owner only for non-string delegates', () => {
  for (const delegate of [undefined, null, 0, false, {}, OWNER]) {
    const input = receiptProofInput();
    input.asset.ownership.delegate = delegate;
    assert.ok(decodeReceiptProof(input).leafDelegate.equals(OWNER));
  }
  for (const delegate of ['', 'not-a-public-key']) {
    const input = receiptProofInput();
    input.asset.ownership.delegate = delegate;
    assertDecodeFailure(input, 'invalid-owner');
  }
  const mismatched = receiptProofInput();
  mismatched.asset.ownership.owner = DELEGATE.toBase58();
  assertDecodeFailure(mismatched, 'owner-mismatch');
  const invalid = receiptProofInput();
  invalid.asset.ownership.owner = 'invalid';
  invalid.expectedOwner = 'invalid';
  assertDecodeFailure(invalid, 'invalid-owner');
});

test('receipt proof decoder preserves optional flag and hash handling', () => {
  for (const flags of [undefined, null, 0, 255, '255', '', false, true]) {
    const input = receiptProofInput();
    input.asset.compression.flags = flags;
    assert.equal(decodeReceiptProof(input).flags, flags == null ? null : Number(flags));
  }
  for (const flags of [-1, 256, 0.5, 'invalid', NaN, Infinity]) {
    const input = receiptProofInput();
    input.asset.compression.flags = flags;
    assertDecodeFailure(input, 'invalid-flags');
  }
  for (const assetDataHash of [undefined, null, '', false, 0]) {
    const input = receiptProofInput();
    input.asset.compression.asset_data_hash = assetDataHash;
    assert.equal(decodeReceiptProof(input).assetDataHash, null);
  }
});

test('receipt proof decoder rejects absent roots and unparseable or mismatched trees', () => {
  for (const root of [undefined, null, '', 123]) {
    const input = receiptProofInput();
    input.proof.root = root;
    assertDecodeFailure(input, 'missing-proof');
  }
  for (const tree of [undefined, null, '', 'invalid']) {
    const input = receiptProofInput();
    input.proof.tree_id = tree;
    assertDecodeFailure(input, 'missing-proof');
  }
  const mismatched = receiptProofInput();
  mismatched.proof.tree_id = OTHER_TREE.toBase58();
  assertDecodeFailure(mismatched, 'tree-mismatch');
});

test('receipt proof decoder distinguishes malformed base58 and incorrect hash lengths', () => {
  for (const field of ['root', 'data_hash', 'creator_hash', 'asset_data_hash']) {
    for (const [value, reason, suffix] of [
      ['not base58!', 'invalid-hash', ''],
      ['1', 'invalid-hash-length', ' length'],
      ['1'.repeat(33), 'invalid-hash-length', ' length'],
    ] as const) {
      const input = receiptProofInput();
      if (field === 'root') input.proof.root = value;
      else input.asset.compression[field] = value;
      const label = field === 'root' ? 'assetProof.root' : `asset.compression.${field}`;
      assertDecodeFailure(input, reason, `Invalid ${label}${suffix}`);
    }
  }
});

test('receipt proof decoder preserves normalization failures and applies an optional path limit before trimming', () => {
  const input = receiptProofInput();
  input.proof.proof = null;
  assertDecodeFailure(input, 'proof-normalization', 'Asset proof path is missing');
  assertDecodeFailure({ ...input, maxProofAccounts: 64 }, 'invalid-proof-path');
  input.proof.proof = [TREE.toBase58(), 'invalid'];
  assertDecodeFailure(input, 'proof-normalization', 'Asset proof path contains an invalid public key at index 1');
  input.proof.proof = [TREE.toBase58()];
  assertDecodeFailure({ ...input, dimensions: { maxDepth: 14, canopyDepth: 8 } }, 'proof-normalization');
  for (const dimensions of [{ maxDepth: 0 }, { maxDepth: 14, canopyDepth: 14 }, { maxDepth: 14, canopyDepth: -1 }]) {
    assertDecodeFailure({ ...input, dimensions }, 'proof-normalization');
  }
  input.proof.proof = Array(64).fill(TREE.toBase58());
  assert.equal(decodeReceiptProof({ ...input, maxProofAccounts: 64 }).proofAccounts.length, 64);
  input.proof.proof = Array(65).fill(TREE.toBase58());
  assert.equal(decodeReceiptProof(input).proofAccounts.length, 65);
  assertDecodeFailure({ ...input, maxProofAccounts: 64, dimensions: { maxDepth: 65, canopyDepth: 1 } }, 'invalid-proof-path');
});

test('receipt proof decoder validates proof identity, nonce, path, ownership, flags and hashes in order', () => {
  const input = receiptProofInput();
  input.proof.tree_id = OTHER_TREE.toBase58();
  input.proof.root = '';
  input.asset.compression.leaf_id = -1;
  input.proof.proof = ['invalid'];
  input.asset.ownership.owner = 'invalid';
  input.asset.compression.flags = -1;
  input.asset.compression.data_hash = 'invalid';
  assertDecodeFailure(input, 'missing-proof');
  input.proof.root = new PublicKey(HASHES[0]).toBase58();
  assertDecodeFailure(input, 'tree-mismatch');
  input.proof.tree_id = TREE.toBase58();
  assertDecodeFailure(input, 'invalid-nonce');
  input.asset.compression.leaf_id = 0;
  assertDecodeFailure(input, 'proof-normalization');
  input.proof.proof = [];
  assertDecodeFailure(input, 'owner-mismatch');
  input.expectedOwner = 'invalid';
  assertDecodeFailure(input, 'invalid-owner');
  input.expectedOwner = OWNER.toBase58();
  input.asset.ownership.owner = OWNER.toBase58();
  assertDecodeFailure(input, 'invalid-flags');
  input.asset.compression.flags = 0;
  assertDecodeFailure(input, 'invalid-hash');
});
