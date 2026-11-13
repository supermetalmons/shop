import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { API_DROPS, type ApiDropConfig } from '../src/dropConfig.ts';
import { buildRuntime as adminRuntime } from '../src/adminIrlRedeemRuntime.ts';
import { deliveryPrepareTestHooks } from '../src/deliveryPrepare.ts';
import { runtimeForDrop } from '../src/deliveryReceiptOnchain.ts';
import { receiptTransferTestHooks } from '../src/receiptTransfer.ts';

function key(value: number): string {
  return new PublicKey(new Uint8Array(32).fill(value)).toBase58();
}

const DROP: ApiDropConfig = {
  ...API_DROPS.card_nft_2,
  dropId: 'runtime_test',
  boxMinterProgramId: key(1),
  boxMinterConfigPda: key(2),
  collectionMint: key(3),
  receiptsMerkleTree: key(4),
  deliveryLookupTable: '',
  maxSupply: 100,
  itemsPerBox: 3,
  receiptMaxId: 200,
  receiptsTreeMaxDepth: 14,
  receiptsTreeCanopyDepth: 4,
  operationsConfig: undefined,
};

function issuanceRuntime(config: ApiDropConfig) {
  const previous = API_DROPS[config.dropId];
  API_DROPS[config.dropId] = config;
  try {
    return runtimeForDrop(config.dropId);
  } finally {
    if (previous) API_DROPS[config.dropId] = previous;
    else delete API_DROPS[config.dropId];
  }
}

const ADAPTERS = [
  { name: 'prepare', build: deliveryPrepareTestHooks.buildRuntime, error: 'DeliveryPrepareError', message: 'Delivery drop configuration is invalid.' },
  { name: 'issuance', build: issuanceRuntime, error: 'DeliveryReceiptError', message: 'Delivery drop configuration is invalid.' },
  { name: 'transfer', build: receiptTransferTestHooks.buildRuntime, error: 'ReceiptTransferError', message: 'Receipt transfer drop configuration is invalid.' },
  { name: 'admin', build: adminRuntime, error: 'AdminIrlRedeemPrepareError', message: 'Admin IRL redeem drop configuration is invalid.' },
] as const;

test('Solana runtime adapters retain their deployed-drop support and result fields', () => {
  const commonKeys = ['config', 'dropId', 'cluster', 'boxMinterProgramId', 'boxMinterConfigPda', 'collectionMint', 'maxDudeId'];
  const deliveryKeys = ['itemsPerBox', 'maxSupply'];
  const receiptKeys = ['receiptsMerkleTree', 'deliveryLookupTable', 'receiptsTreeMaxDepth', 'receiptsTreeCanopyDepth', 'receiptMaxId'];
  const keys = {
    prepare: [...commonKeys, ...deliveryKeys, 'deliveryLookupTable'],
    issuance: [...commonKeys, ...deliveryKeys, 'receiptsMerkleTree'],
    transfer: [...commonKeys, ...receiptKeys],
    admin: [...commonKeys, ...deliveryKeys, ...receiptKeys],
  };
  for (const adapter of ADAPTERS) {
    assert.deepEqual(Object.keys(adapter.build(DROP)).sort(), keys[adapter.name].sort(), adapter.name);
    for (const config of Object.values(API_DROPS)) {
      const runtime = adapter.build(config);
      assert.equal(runtime.config, config);
      assert.equal(runtime.dropId, config.dropId);
      assert.equal(runtime.cluster, config.solanaCluster);
    }
  }
});

test('Solana runtime adapters use the operations config and its figure range', () => {
  const config = { ...DROP, operationsConfig: { configId: 'runtime_operations', boxMinterConfigPda: key(5), maxSupply: 200 } };
  for (const adapter of ADAPTERS) {
    const runtime = adapter.build(config);
    assert.equal(runtime.boxMinterConfigPda.toBase58(), key(5));
    assert.equal(runtime.maxDudeId, 600);
    assert.throws(() => adapter.build({ ...config, operationsConfig: { ...config.operationsConfig, maxSupply: 99 } }),
      { message: 'Invalid operations figure ID range.' });
  }
});

test('Solana runtime adapters preserve missing and explicit zero config PDA policies', () => {
  const singleton = PublicKey.findProgramAddressSync([Buffer.from('config')], new PublicKey(DROP.boxMinterProgramId))[0];
  for (const adapter of ADAPTERS) {
    for (const boxMinterConfigPda of ['', '   ']) {
      assert.ok(adapter.build({ ...DROP, boxMinterConfigPda }).boxMinterConfigPda.equals(singleton), adapter.name);
    }
    const zero = adapter.build({ ...DROP, boxMinterConfigPda: PublicKey.default.toBase58() });
    assert.ok(zero.boxMinterConfigPda.equals(adapter.name === 'issuance' ? singleton : PublicKey.default), adapter.name);
  }
});

test('Solana runtime adapters preserve configuration errors and validation order', () => {
  for (const adapter of ADAPTERS) {
    for (const patch of [{ itemsPerBox: 6 }, { maxSupply: 0 }, { maxSupply: 0x1_0000_0000 }, { maxSupply: 30_000 }]) {
      assert.throws(() => adapter.build({ ...DROP, ...patch, boxMinterProgramId: 'invalid' }), {
        name: adapter.error, code: 'failed-precondition', message: adapter.message, details: { dropId: DROP.dropId },
      });
    }
    for (const [field, label] of [['boxMinterProgramId', 'BOX_MINTER_PROGRAM_ID'], ['collectionMint', 'COLLECTION_MINT']] as const) {
      for (const value of ['', PublicKey.default.toBase58()]) {
        assert.throws(() => adapter.build({ ...DROP, [field]: value }), {
          name: adapter.error, code: 'failed-precondition', message: `${label} is not configured.`, details: undefined,
        });
      }
      assert.throws(() => adapter.build({ ...DROP, [field]: 'invalid' }), {
        name: adapter.error, code: 'failed-precondition', message: `${label} is invalid.`, details: undefined,
      });
      assert.equal(adapter.build({ ...DROP, [field]: ` ${DROP[field]} ` })[field].toBase58(), DROP[field]);
    }
  }
});

test('receipt runtime validation stays separate from delivery validation', () => {
  for (const patch of [{ receiptMaxId: 99 }, { receiptsTreeCanopyDepth: 14 }, { receiptsTreeCanopyDepth: -1 }]) {
    for (const adapter of ADAPTERS) {
      if (adapter.name === 'prepare' || adapter.name === 'issuance') {
        assert.doesNotThrow(() => adapter.build({ ...DROP, ...patch }));
      } else {
        assert.throws(() => adapter.build({ ...DROP, ...patch }), {
          name: adapter.error, code: 'failed-precondition', message: adapter.message, details: { dropId: DROP.dropId },
        });
      }
    }
  }
  for (const build of [adminRuntime, receiptTransferTestHooks.buildRuntime]) {
    const runtime = build({ ...DROP, receiptMaxId: undefined, receiptsTreeMaxDepth: undefined, receiptsTreeCanopyDepth: undefined });
    assert.equal(runtime.receiptMaxId, DROP.maxSupply);
    assert.equal(runtime.receiptsTreeCanopyDepth, 0);
    assert.equal(Object.hasOwn(runtime, 'receiptsTreeMaxDepth'), false);
    assert.equal(runtime.deliveryLookupTable, undefined);
    assert.ok(build({ ...DROP, deliveryLookupTable: PublicKey.default.toBase58() }).deliveryLookupTable?.equals(PublicKey.default));
  }
});

test('runtime adapters require only the keys their operation uses', () => {
  for (const adapter of ADAPTERS) {
    if (adapter.name === 'prepare') {
      assert.doesNotThrow(() => adapter.build({ ...DROP, receiptsMerkleTree: '' }));
    } else {
      assert.throws(() => adapter.build({ ...DROP, receiptsMerkleTree: '' }), {
        name: adapter.error, code: 'failed-precondition', message: 'RECEIPTS_MERKLE_TREE is not configured.',
      });
    }
    if (adapter.name === 'issuance') {
      assert.doesNotThrow(() => adapter.build({ ...DROP, deliveryLookupTable: 'invalid' }));
    } else {
      assert.throws(() => adapter.build({ ...DROP, deliveryLookupTable: 'invalid' }), {
        name: adapter.error, code: 'failed-precondition', message: 'DELIVERY_LOOKUP_TABLE is invalid.',
      });
    }
  }
  assert.throws(() => runtimeForDrop('unsupported_runtime_test'), {
    name: 'DeliveryReceiptError', code: 'invalid-argument', message: 'Unsupported dropId: unsupported_runtime_test',
  });
});
