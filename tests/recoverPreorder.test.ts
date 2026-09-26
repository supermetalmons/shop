import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { parsePreorderRecoveryArgs, recoverPreorder } from '../scripts/ops/recoverPreorder.ts';
import { getPreorderConfig } from '../shared/preorders.ts';
import { PreorderStore, type StoredPreorder } from '../cloud/workers/api/src/preorderStore.ts';
import { createCommerceD1Harness } from '../cloud/workers/api/test/commerceD1Harness.ts';

const config = getPreorderConfig('mi_note_cards_devnet')!;
const signature = bs58.encode(new Uint8Array(64).fill(7));
const signedTransaction = Buffer.from('signed preorder transaction').toString('base64');
type RecoveryDependencies = NonNullable<Parameters<typeof recoverPreorder>[1]>;
type Outcome = Awaited<ReturnType<RecoveryDependencies['probe']>>;

async function harness(context: TestContext, options: { prepared?: boolean; order?: Partial<StoredPreorder> } = {}) {
  const { database, db } = createCommerceD1Harness();
  context.after(() => database.close());
  const store = new PreorderStore(db);
  const source: StoredPreorder = {
    orderId: 'preorder-recovery-1', preorderId: config.preorderId, cluster: config.cluster,
    collection: config.collection, buyer: Keypair.generate().publicKey.toBase58(), requestId: 'request-1',
    ethereumAddress: '0x0000000000000000000000000000000000000001',
    cardIds: [1, 2], assets: [1, 2].map((id) => ({ id, address: Keypair.generate().publicKey.toBase58() })),
    status: 'prepared', signature: null, confirmedSlot: null, signedTransaction: null, preparedTransaction: 'prepared-transaction',
    blockhash: Keypair.generate().publicKey.toBase58(), blockhashContextSlot: 10,
    lastValidBlockHeight: 100, createdAtMs: 1000, expiresAtMs: 121000, revision: 1,
    ...options.order,
  };
  await store.reserve(source);
  const order = options.prepared ? source : await store.submit(source, { transactionBase64: signedTransaction, signature }, 2000);
  const sql: string[] = [];
  let probeCalls = 0;
  let outcome: Outcome = { status: 'expired' };
  const dependencies: RecoveryDependencies = {
    query: (statement) => {
      sql.push(statement);
      return database.prepare(statement).all();
    },
    probe: async (record) => {
      probeCalls += 1;
      assert.equal(record.order_id, order.orderId);
      assert.equal(record.signature, signature);
      assert.equal(record.signed_transaction, signedTransaction);
      return outcome;
    },
  };
  return {
    database, store, order, sql, dependencies,
    probeCalls: () => probeCalls,
    outcome: (value: Outcome) => { outcome = value; },
    claims: () => database.prepare('SELECT card_id FROM commerce_preorder_claims WHERE order_id = ? ORDER BY card_id')
      .all(order.orderId).map((row) => row.card_id),
    run: (write: boolean, overrides: Partial<RecoveryDependencies> = {}) => recoverPreorder(
      { orderId: order.orderId, write }, { ...dependencies, ...overrides }),
  };
}

function assertReadOnly(sql: string[]) {
  assert.ok(sql.length > 0);
  assert.ok(sql.every((statement) => /^\s*SELECT\b/i.test(statement)), sql.join('\n'));
}

test('preorder recovery CLI defaults to read-only and requires an explicit write flag', () => {
  assert.deepEqual(parsePreorderRecoveryArgs(['order_123-a']), { orderId: 'order_123-a', write: false });
  assert.deepEqual(parsePreorderRecoveryArgs(['order_123-a', '--write']), { orderId: 'order_123-a', write: true });
  for (const args of [[], [''], ['../order'], ['order; DELETE'], ['a'.repeat(129)], ['order', '--force'],
    ['order', 'extra'], ['order', '--write', '--write'], ['--write', 'order']]) {
    assert.throws(() => parsePreorderRecoveryArgs(args), /Usage:/);
  }
});

test('dry-run verifies submitted outcomes without mutating orders or claims', async (context) => {
  for (const status of ['expired', 'failed', 'finalized'] as const) {
    await context.test(status, async (context) => {
      const h = await harness(context);
      h.outcome({ status, slot: 120 });
      const result = await h.run(false);
      assert.equal(result.status, 'submitted');
      assert.equal(result.verifiedOutcome, status);
      assert.equal(result.write, false);
      assert.equal(h.probeCalls(), 1);
      assert.deepEqual(await h.store.get(h.order.orderId), h.order);
      assert.deepEqual(h.claims(), [1, 2]);
      assertReadOnly(h.sql);
    });
  }
});

test('mainnet recovery uses its configured collection and preserves verified success claims', async (context) => {
  const mainnet = getPreorderConfig('mi_note_cards')!;
  const h = await harness(context, { order: {
    preorderId: mainnet.preorderId, cluster: mainnet.cluster, collection: mainnet.collection,
  } });
  h.outcome({ status: 'finalized', slot: 120 });
  const preview = await h.run(false, { probe: async (record) => {
    assert.equal(record.cluster, 'mainnet-beta');
    assert.equal(record.collection, mainnet.collection);
    return h.dependencies.probe(record);
  } });
  assert.equal(preview.status, 'submitted');
  assert.equal(preview.verifiedOutcome, 'finalized');
  assertReadOnly(h.sql);
  const result = await h.run(true);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(h.claims(), [1, 2]);
});

test('mainnet recovery retains uncertain orders and releases only verified expiry', async (context) => {
  const mainnet = getPreorderConfig('mi_note_cards')!;
  const h = await harness(context, { order: {
    preorderId: mainnet.preorderId, cluster: mainnet.cluster, collection: mainnet.collection,
  } });
  h.outcome({ status: 'pending' });
  await assert.rejects(h.run(true), /uncertain/);
  assert.deepEqual(await h.store.get(h.order.orderId), h.order);
  assert.deepEqual(h.claims(), [1, 2]);
  assertReadOnly(h.sql);
  h.outcome({ status: 'expired' });
  assert.equal((await h.run(true)).status, 'expired');
  assert.deepEqual(h.claims(), []);
});

test('verified expiry and failure release claims only after the terminal state is persisted', async (context) => {
  for (const status of ['expired', 'failed'] as const) {
    await context.test(status, async (context) => {
      const h = await harness(context);
      h.outcome({ status });
      const result = await h.run(true, { query: async (sql) => {
        if (/^\s*DELETE\b/i.test(sql)) {
          const persisted = await h.store.get(h.order.orderId);
          assert.equal(persisted?.status, status);
          assert.equal(persisted?.signature, signature);
          assert.equal(persisted?.signedTransaction, signedTransaction);
        }
        return h.dependencies.query(sql);
      } });
      assert.equal(result.status, status);
      assert.equal(result.verifiedOutcome, status);
      assert.equal(result.write, true);
      assert.equal((await h.store.get(h.order.orderId))?.revision, h.order.revision + 1);
      assert.deepEqual(h.claims(), []);
      assert.equal(h.sql.filter((sql) => /^\s*UPDATE\b/i.test(sql)).length, 1);
      assert.equal(h.sql.filter((sql) => /^\s*DELETE\b/i.test(sql)).length, 1);
    });
  }
});

test('verified success permanently retains the claims and a rerun is read-only', async (context) => {
  const h = await harness(context);
  h.outcome({ status: 'finalized', slot: 120 });
  const result = await h.run(true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.verifiedOutcome, 'finalized');
  assert.deepEqual(h.claims(), [1, 2]);
  assert.equal(h.sql.some((sql) => /^\s*DELETE\b/i.test(sql)), false);
  h.sql.length = 0;
  const repeated = await h.run(true);
  assert.equal(repeated.status, 'succeeded');
  assert.equal(h.probeCalls(), 1);
  assert.deepEqual(h.claims(), [1, 2]);
  assertReadOnly(h.sql);
});

test('pending outcomes and archive RPC errors preserve all recovery information', async (context) => {
  for (const scenario of ['pending', 'rpc-error'] as const) {
    await context.test(scenario, async (context) => {
      const h = await harness(context);
      h.outcome({ status: 'pending' });
      const overrides = scenario === 'rpc-error' ? { probe: async () => { throw new Error('Archive unavailable'); } } : {};
      await assert.rejects(h.run(true, overrides), scenario === 'pending' ? /uncertain/ : /Archive unavailable/);
      assert.deepEqual(await h.store.get(h.order.orderId), h.order);
      assert.deepEqual(h.claims(), [1, 2]);
      assertReadOnly(h.sql);
    });
  }
});

test('confirmed-only recovery cannot finish an order or release its claims', async (context) => {
  const h = await harness(context);
  const confirmed = await h.store.confirm(h.order, 110, 2500);
  h.outcome({ status: 'confirmed', slot: 110 });
  for (const write of [false, true]) {
    await assert.rejects(h.run(write), /wait for finalization/);
    assert.deepEqual(await h.store.get(h.order.orderId), confirmed);
    assert.deepEqual(h.claims(), [1, 2]);
  }
  assertReadOnly(h.sql);
  h.outcome({ status: 'finalized', slot: 120 });
  assert.equal((await h.run(true)).status, 'succeeded');
  assert.equal((await h.store.get(h.order.orderId))?.confirmedSlot, 120);
});

test('a concurrent confirmation fences an older recovery write', async (context) => {
  const h = await harness(context);
  await assert.rejects(h.run(true, { probe: async () => {
    await h.store.confirm(h.order, 110, 2500);
    return { status: 'expired' };
  } }), /changed during recovery/);
  assert.equal((await h.store.get(h.order.orderId))?.status, 'submitted');
  assert.equal((await h.store.get(h.order.orderId))?.confirmedSlot, 110);
  assert.deepEqual(h.claims(), [1, 2]);
});

test('housekeeping during archive verification does not invalidate unchanged submission evidence', async (context) => {
  for (const confirmed of [false, true]) for (const status of ['expired', 'finalized'] as const) {
    await context.test(`${confirmed ? 'confirmed' : 'unconfirmed'} ${status}`, async (context) => {
      const h = await harness(context);
      const initial = confirmed ? await h.store.confirm(h.order, 110, 2500) : h.order;
      h.outcome({ status, slot: 120 });
      const result = await h.run(true, { probe: async (record) => {
        assert.equal(record.confirmed_slot, initial.confirmedSlot);
        for (let index = 0; index < 3; index += 1) {
          await h.store.defer((await h.store.get(h.order.orderId))!, 3000 + index);
        }
        return h.dependencies.probe(record);
      } });
      const persisted = (await h.store.get(h.order.orderId))!;
      assert.equal(result.status, status === 'finalized' ? 'succeeded' : 'expired');
      assert.equal(persisted.revision, initial.revision + 4);
      assert.equal(persisted.confirmedSlot, status === 'finalized' ? 120 : initial.confirmedSlot);
      assert.equal(h.probeCalls(), 1);
      assert.deepEqual(h.claims(), status === 'finalized' ? [1, 2] : []);
    });
  }
});

test('uncertain archive evidence preserves claims despite concurrent housekeeping', async (context) => {
  const h = await harness(context);
  const confirmed = await h.store.confirm(h.order, 110, 2500);
  await assert.rejects(h.run(true, { probe: async () => {
    await h.store.defer(confirmed, 3000);
    return { status: 'pending' };
  } }), /uncertain/);
  const persisted = (await h.store.get(h.order.orderId))!;
  assert.equal(persisted.status, 'submitted');
  assert.equal(persisted.confirmedSlot, 110);
  assert.deepEqual(h.claims(), [1, 2]);
  assertReadOnly(h.sql);
});

test('a failed terminal write never attempts claim deletion', async (context) => {
  const h = await harness(context);
  h.database.exec(`CREATE TRIGGER recovery_test_update_failure BEFORE UPDATE ON commerce_preorder_orders
    BEGIN SELECT RAISE(ABORT, 'storage failure'); END;`);
  await assert.rejects(h.run(true), /storage failure/);
  assert.deepEqual(await h.store.get(h.order.orderId), h.order);
  assert.deepEqual(h.claims(), [1, 2]);
  assert.equal(h.sql.some((sql) => /^\s*DELETE\b/i.test(sql)), false);
});

test('paused commerce rejects recovery writes without releasing reservations', async (context) => {
  const h = await harness(context);
  h.database.exec(`INSERT INTO commerce_authority_control_lease VALUES
    (1, '00000000-0000-4000-8000-000000001099', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
      CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000);
    UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
    DELETE FROM commerce_authority_control_lease;`);
  await assert.rejects(h.run(true), /commerce authority is not d1/);
  assert.deepEqual(await h.store.get(h.order.orderId), h.order);
  assert.deepEqual(h.claims(), [1, 2]);
  assert.equal(h.sql.some((sql) => /^\s*DELETE\b/i.test(sql)), false);
});

test('a rerun repairs interrupted terminal cleanup without repeating archive verification', async (context) => {
  const h = await harness(context);
  h.database.exec(`CREATE TRIGGER recovery_test_delete_failure BEFORE DELETE ON commerce_preorder_claims
    BEGIN SELECT RAISE(ABORT, 'cleanup failure'); END;`);
  await assert.rejects(h.run(true), /cleanup failure/);
  assert.equal((await h.store.get(h.order.orderId))?.status, 'expired');
  assert.deepEqual(h.claims(), [1, 2]);
  h.database.exec('DROP TRIGGER recovery_test_delete_failure');
  h.sql.length = 0;
  assert.equal((await h.run(false)).status, 'expired');
  assertReadOnly(h.sql);
  assert.deepEqual(h.claims(), [1, 2]);
  assert.equal((await h.run(true)).status, 'expired');
  assert.equal((await h.run(true)).status, 'expired');
  assert.deepEqual(h.claims(), []);
  assert.equal(h.probeCalls(), 1);
  assert.equal(h.sql.some((sql) => /^\s*UPDATE\b/i.test(sql)), false);
});

test('a concurrent successful finalization wins over an older expiry result', async (context) => {
  const h = await harness(context);
  const result = await h.run(true, { probe: async () => {
    await h.store.finish(h.order, 'succeeded', 3000);
    return { status: 'expired' };
  } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(h.claims(), [1, 2]);
  assert.equal((await h.store.get(h.order.orderId))?.signature, signature);
  assert.equal(h.sql.some((sql) => /^\s*DELETE\b/i.test(sql)), false);
});

test('a concurrent terminal failure cannot be revived by an older successful proof', async (context) => {
  const h = await harness(context);
  const confirmed = await h.store.confirm(h.order, 110, 2500);
  const result = await h.run(true, { probe: async () => {
    await h.store.finish(confirmed, 'failed', 3000);
    return { status: 'finalized', slot: 120 };
  } });
  assert.equal(result.status, 'failed');
  assert.equal((await h.store.get(h.order.orderId))?.confirmedSlot, 110);
  assert.deepEqual(h.claims(), []);
});

test('missing, mismatched and malformed orders cannot be probed or mutated', async (context) => {
  for (const [name, transform] of [
    ['missing', () => []],
    ['wrong order ID', (rows: Record<string, unknown>[]) => [{ ...rows[0], order_id: 'other-order' }]],
    ['mismatched cluster', (rows: Record<string, unknown>[]) => [{ ...rows[0], cluster: 'mainnet-beta' }]],
    ['unsupported cluster', (rows: Record<string, unknown>[]) => [{ ...rows[0], cluster: 'testnet' }]],
    ['wrong collection', (rows: Record<string, unknown>[]) => [{ ...rows[0], collection: Keypair.generate().publicKey.toBase58() }]],
    ['mismatched preorder', (rows: Record<string, unknown>[]) => [{ ...rows[0], preorder_id: 'mi_note_cards' }]],
    ['unknown preorder', (rows: Record<string, unknown>[]) => [{ ...rows[0], preorder_id: 'unknown-preorder' }]],
    ['invalid buyer', (rows: Record<string, unknown>[]) => [{ ...rows[0], buyer: 'invalid' }]],
    ['invalid signature', (rows: Record<string, unknown>[]) => [{ ...rows[0], signature: 'invalid' }]],
    ['missing signature', (rows: Record<string, unknown>[]) => [{ ...rows[0], signature: null }]],
    ['missing transaction', (rows: Record<string, unknown>[]) => [{ ...rows[0], signed_transaction: null }]],
    ['negative block height', (rows: Record<string, unknown>[]) => [{ ...rows[0], last_valid_block_height: -1 }]],
    ['negative confirmation slot', (rows: Record<string, unknown>[]) => [{ ...rows[0], confirmed_slot: -1 }]],
    ['missing confirmation slot', (rows: Record<string, unknown>[]) => [{ ...rows[0], confirmed_slot: undefined }]],
  ] as const) {
    await context.test(name, async (context) => {
      const h = await harness(context);
      await assert.rejects(h.run(true, { query: async (sql) => transform(await h.dependencies.query(sql)) }));
      assert.equal(h.probeCalls(), 0);
      assert.deepEqual(await h.store.get(h.order.orderId), h.order);
      assert.deepEqual(h.claims(), [1, 2]);
      assertReadOnly(h.sql);
    });
  }
});

test('prepared orders use normal cancellation or expiry without operator mutation', async (context) => {
  const h = await harness(context, { prepared: true });
  await assert.rejects(h.run(true), /not submitted/);
  assert.equal(h.probeCalls(), 0);
  assert.deepEqual(await h.store.get(h.order.orderId), h.order);
  assert.deepEqual(h.claims(), [1, 2]);
  assertReadOnly(h.sql);
});

test('invalid asset records are rejected before archive verification or database mutation', async (context) => {
  const address = Keypair.generate().publicKey.toBase58();
  const otherAddress = Keypair.generate().publicKey.toBase58();
  for (const [name, assets] of [
    ['invalid JSON', '{'],
    ['no assets', '[]'],
    ['out-of-range ID', JSON.stringify([{ id: 1396, address }])],
    ['invalid address', JSON.stringify([{ id: 1, address: 'invalid' }])],
    ['duplicate ID', JSON.stringify([{ id: 1, address }, { id: 1, address: otherAddress }])],
    ['duplicate address', JSON.stringify([{ id: 1, address }, { id: 2, address }])],
    ['too many assets', JSON.stringify([1, 2, 3, 4].map((id) => ({ id, address: Keypair.generate().publicKey.toBase58() })))],
  ]) {
    await context.test(name, async (context) => {
      const h = await harness(context);
      await assert.rejects(h.run(true, { query: async (sql) => (await h.dependencies.query(sql))
        .map((row) => ({ ...row, assets_json: assets })) }), /asset records are invalid/);
      assert.equal(h.probeCalls(), 0);
      assert.deepEqual(await h.store.get(h.order.orderId), h.order);
      assert.deepEqual(h.claims(), [1, 2]);
      assertReadOnly(h.sql);
    });
  }
});
