import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { API_DROPS } from '../src/dropConfig.ts';
import { adminIrlRedeemPrepareTestHooks } from '../src/adminIrlRedeemPrepare.ts';
import { irlClaimTestHooks } from '../src/irlClaim.ts';
import { receiptTransferTestHooks } from '../src/receiptTransfer.ts';

const OWNER = new PublicKey(new Uint8Array(32).fill(1));
const TREE = new PublicKey(new Uint8Array(32).fill(2));
const OTHER_TREE = new PublicKey(new Uint8Array(32).fill(3));
const HASH = bs58.encode(new Uint8Array(32).fill(4));
const SHORT_HASH = bs58.encode(new Uint8Array(31).fill(4));
const DROP_ID = 'receipt_proof_adapters';
const runtimeFields = {
  dropId: DROP_ID,
  receiptsMerkleTree: TREE,
  receiptsTreeMaxDepth: undefined,
  receiptsTreeCanopyDepth: 0,
};
const adapters = [
  {
    name: 'admin',
    errorName: 'AdminIrlRedeemPrepareError',
    parse: (asset: Record<string, unknown>, proof: Record<string, unknown>) =>
      adminIrlRedeemPrepareTestHooks.parseProof(asset, proof, {
        ...adminIrlRedeemPrepareTestHooks.buildRuntime(API_DROPS.card_nft_2),
        ...runtimeFields,
      }, OWNER.toBase58()),
    missingIdentity: 'Unable to fetch receipt proof for transfer',
    wrongTree: 'Receipt does not belong to the configured receipts tree',
    treeDetails: undefined,
    invalidNonce: 'Unable to parse receipt leaf id',
    outOfRange: 'Unable to parse receipt leaf id',
    invalidFlags: 'Receipt proof flags are invalid',
    pathDetails: undefined,
  },
  {
    name: 'transfer',
    errorName: 'ReceiptTransferError',
    parse: (asset: Record<string, unknown>, proof: Record<string, unknown>) =>
      receiptTransferTestHooks.parseProof(asset, proof, {
        ...receiptTransferTestHooks.buildRuntime(API_DROPS.card_nft_2),
        ...runtimeFields,
      }, OWNER.toBase58()),
    missingIdentity: 'Unable to fetch receipt proof for transfer',
    wrongTree: 'Receipt does not belong to the configured receipts tree',
    treeDetails: { receiptTree: OTHER_TREE.toBase58(), receiptsTree: TREE.toBase58(), dropId: DROP_ID },
    invalidNonce: 'Unable to parse receipt leaf id',
    outOfRange: 'Receipt leaf index out of range',
    invalidFlags: 'Receipt proof flags are invalid',
    pathDetails: { dropId: DROP_ID },
  },
  {
    name: 'claim',
    errorName: 'IrlClaimError',
    parse: (asset: Record<string, unknown>, proof: Record<string, unknown>) =>
      irlClaimTestHooks.parseProof(asset, proof, {
        ...irlClaimTestHooks.buildRuntime(API_DROPS.card_nft_2),
        ...runtimeFields,
      }, OWNER.toBase58()),
    missingIdentity: 'Unable to fetch certificate proof for burn',
    wrongTree: 'Certificate does not belong to the configured receipts tree',
    treeDetails: { certificateTree: OTHER_TREE.toBase58(), receiptsTree: TREE.toBase58(), dropId: DROP_ID },
    invalidNonce: 'Unable to parse certificate leaf id',
    outOfRange: 'Certificate leaf index out of range',
    invalidFlags: 'Invalid burn flags',
    pathDetails: undefined,
  },
] as const;

function asset(compression: Record<string, unknown> = {}, ownership: Record<string, unknown> = {}) {
  return {
    compression: { leaf_id: 4, data_hash: HASH, creator_hash: HASH, ...compression },
    ownership: { owner: OWNER.toBase58(), ...ownership },
  };
}

function proof(overrides: Record<string, unknown> = {}) {
  return { tree_id: TREE.toBase58(), root: HASH, proof: [], ...overrides };
}

function expectFailure(
  adapter: typeof adapters[number],
  input: { asset?: Record<string, unknown>; proof?: Record<string, unknown> },
  message: string,
  details?: unknown,
) {
  assert.throws(() => adapter.parse(input.asset ?? asset(), input.proof ?? proof()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.constructor.name, adapter.errorName);
    assert.equal(error.name, adapter.errorName);
    assert.equal(error.message, message);
    assert.ok('code' in error && 'details' in error);
    assert.equal(error.code, 'failed-precondition');
    assert.deepEqual(error.details, details);
    return true;
  });
}

for (const adapter of adapters) {
  test(`${adapter.name} receipt proof adapter retains decoded values and aliases`, () => {
    const decoded = adapter.parse(asset({
      leaf_id: undefined,
      leafId: '4',
      data_hash: undefined,
      dataHash: HASH,
      creator_hash: undefined,
      creatorHash: HASH,
      assetDataHash: HASH,
      flags: '255',
    }, { delegate: OTHER_TREE.toBase58() }), proof({ tree_id: undefined, treeId: TREE.toBase58() }));
    assert.deepEqual(decoded, {
      merkleTree: TREE,
      root: Buffer.from(new Uint8Array(32).fill(4)),
      dataHash: Buffer.from(new Uint8Array(32).fill(4)),
      creatorHash: Buffer.from(new Uint8Array(32).fill(4)),
      assetDataHash: Buffer.from(new Uint8Array(32).fill(4)),
      flags: 255,
      nonce: 4,
      index: 4,
      proofAccounts: [],
      leafOwner: OWNER,
      leafDelegate: OTHER_TREE,
    });
    const defaults = adapter.parse(asset(), proof());
    assert.equal(defaults.flags, null);
    assert.equal(defaults.assetDataHash, null);
    assert.ok(defaults.leafDelegate.equals(OWNER));
  });

  test(`${adapter.name} receipt proof adapter preserves domain error contracts`, () => {
    expectFailure(adapter, { proof: proof({ root: '' }) }, adapter.missingIdentity);
    expectFailure(adapter, { proof: proof({ tree_id: 'invalid' }) }, adapter.missingIdentity);
    expectFailure(adapter, { proof: proof({ tree_id: OTHER_TREE.toBase58() }) }, adapter.wrongTree, adapter.treeDetails);
    for (const leaf_id of [-1, 1.5]) {
      expectFailure(adapter, { asset: asset({ leaf_id }) }, adapter.invalidNonce);
    }
    expectFailure(adapter, { asset: asset({ leaf_id: 0x1_0000_0000 }) }, adapter.outOfRange);
    expectFailure(adapter, { proof: proof({ proof: null }) },
      adapter.name === 'claim' ? 'Receipt proof path is invalid' : 'Asset proof path is missing', adapter.pathDetails);
    expectFailure(adapter, { proof: proof({ proof: ['invalid'] }) },
      'Asset proof path contains an invalid public key at index 0', adapter.pathDetails);
    expectFailure(adapter, { asset: asset({}, { owner: OTHER_TREE.toBase58() }) },
      'Receipt proof owner does not match the expected wallet');
    expectFailure(adapter, { asset: asset({}, { delegate: 'invalid' }) }, 'Receipt proof owner is invalid');
    expectFailure(adapter, { asset: asset({ flags: 256 }) }, adapter.invalidFlags);
    expectFailure(adapter, { proof: proof({ root: '0' }) }, 'Invalid assetProof.root');
    expectFailure(adapter, { proof: proof({ root: SHORT_HASH }) }, 'Invalid assetProof.root length');
    for (const field of ['data_hash', 'creator_hash', 'asset_data_hash']) {
      expectFailure(adapter, { asset: asset({ [field]: SHORT_HASH }) }, `Invalid asset.compression.${field} length`);
    }
  });

  test(`${adapter.name} receipt proof adapter preserves validation precedence and path limits`, () => {
    expectFailure(adapter, {
      asset: asset({}, { owner: OTHER_TREE.toBase58() }),
      proof: proof({ proof: ['invalid'] }),
    }, 'Asset proof path contains an invalid public key at index 0', adapter.pathDetails);
    expectFailure(adapter, { asset: asset({ flags: 256 }), proof: proof({ root: '0' }) }, adapter.invalidFlags);
    const longProof = proof({ proof: Array.from({ length: 65 }, () => TREE.toBase58()) });
    if (adapter.name === 'claim') {
      expectFailure(adapter, { proof: longProof }, 'Receipt proof path is invalid');
      expectFailure(adapter, {
        asset: asset({ leaf_id: -1 }),
        proof: longProof,
      }, adapter.invalidNonce);
    } else {
      assert.equal(adapter.parse(asset(), longProof).proofAccounts.length, 65);
    }
  });
}
