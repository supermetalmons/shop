import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { assetProofMatchesTree, assetProofTreePublicKey } from '../functions/src/receiptProof.ts';

const TREE = new PublicKey('11111111111111111111111111111112');
const OTHER_TREE = new PublicKey('11111111111111111111111111111113');

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
