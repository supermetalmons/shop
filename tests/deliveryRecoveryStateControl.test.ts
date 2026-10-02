import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { parseDeliveryRecoveryStateControlArgs, runDeliveryRecoveryStateControl } from '../scripts/ops/deliveryRecoveryStateControl.ts';
import { parseCommerceD1DocumentRow, queryRemoteCommerceDocuments } from '../scripts/shared/commerceD1Maintenance.ts';
import { parseDeliveryRecoveryRow, updateDeliveryRecoveryRecord } from '../shared/deliveryRecoveryState.ts';
import {
  D1CommerceRepository,
  commerceKeys,
  type CommerceDocumentData,
  type CommerceJsonValue,
} from '../cloud/workers/api/src/commerceRepository.ts';
import {
  createCommerceD1Harness,
  seedCommerceDocument,
  seedCommerceDocuments,
  type CommerceDocumentSeed,
} from '../cloud/workers/api/test/commerceD1Harness.ts';
import { createCurrentCommerceDatabase } from './helpers/commerceDatabase.ts';

const ORDERS_SQL = "SELECT * FROM commerce_documents WHERE document_kind = 'delivery_order' ORDER BY document_path";
const LEASE_ID = '00000000-0000-4000-8000-000000001099';

function harness(context: { after: (cleanup: () => void) => void }) {
  const result = createCommerceD1Harness();
  context.after(() => result.database.close());
  return result;
}

function orderSeed(id: string, data: CommerceDocumentData = {}, dropId = 'drop', version = 1): CommerceDocumentSeed {
  return {
    key: commerceKeys.deliveryOrder(dropId, id),
    data: { status: 'processing', updatedAt: 1000, ...data },
    version,
    createTime: '2026-09-01T00:00:00.000Z',
    updateTime: `2026-09-01T00:00:0${version}.000Z`,
  };
}

function query(database: DatabaseSync) {
  return (sql: string) => database.prepare(sql).all().map((row) => ({ ...row }));
}

function responseBytes(rows: Record<string, unknown>[]): number {
  return Buffer.byteLength(JSON.stringify([{ success: true, results: rows, meta: {} }], null, 2));
}

test('recovery state control accepts only read-only status and rejects retired commands before querying', async () => {
  assert.deepEqual(parseDeliveryRecoveryStateControlArgs(['status']), { command: 'status' });
  for (const argv of [
    [], ['prepare'], ['activate'], ['status', '--write'], ['status', '--expected-revision', '1'],
    ['prepare', '--write', '--expected-revision', '1'],
    ['activate', '--write', '--expected-revision', '1', '--worker-deployed'],
  ]) {
    assert.throws(() => parseDeliveryRecoveryStateControlArgs(argv), /Status is read-only.*bootstrap:commerce/);
    await assert.rejects(runDeliveryRecoveryStateControl(argv, {
      query: () => assert.fail('Invalid commands must not query or mutate Commerce.'),
    }), /Status is read-only/);
  }
});

test('uninitialized recovery status reports the bootstrap path without preparing storage', async (context) => {
  const database = createCurrentCommerceDatabase(context);
  const normal = query(database);
  const before = normal('SELECT * FROM commerce_delivery_recovery_control');
  const result = await runDeliveryRecoveryStateControl(['status'], { query: (sql) => {
    assert.match(sql, /^SELECT\b/);
    return normal(sql);
  } });
  assert.equal(result.mode, 'legacy');
  assert.equal(result.preparation, 'idle');
  assert.equal(result.deliveryCount, 0);
  assert.match(result.validationError!, /Storage is not initialized.*commerce_operations\.md/);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(normal('SELECT * FROM commerce_delivery_recovery_control'), before);
  assert.throws(() => queryRemoteCommerceDocuments(`${ORDERS_SQL} LIMIT 0`, normal), /requires active checkout and delivery recovery table storage/);
});

test('status and hydration preserve absent, null, scalar, future and signed recovery payloads without writes', async (context) => {
  const fixture = harness(context);
  const values: Array<CommerceJsonValue | undefined> = [
    undefined, null, false, 3, 'future-value', ['future'],
    {
      preparedProbeCount: '2.9', nextPreparedProbeAt: 1500, lastAttemptAt: 1000, leaseExpiresAt: 5000,
      pendingTransactions: [{ serializedTransaction: 'signed-test-transaction', signature: 'test-signature' }],
      future: { keep: true, text: '\\"🌍' },
    },
  ];
  seedCommerceDocuments(fixture, values.map((value, index) => orderSeed(String(100 + index),
    value === undefined ? {} : { receiptRecovery: value })));
  const repository = new D1CommerceRepository(fixture.db);
  const journalKey = commerceKeys.deliveryOrder('drop', '106');
  await repository.run(2000, async (unit) => {
    const snapshot = await unit.getRecoverySnapshot(journalKey);
    assert.ok(snapshot);
    unit.stageRecovery(updateDeliveryRecoveryRecord(snapshot.state, { leaseId: LEASE_ID }, 2000));
  });
  const normal = query(fixture.database);
  const parents = normal('SELECT * FROM commerce_documents ORDER BY document_path');
  const savedRows = normal('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path');
  const authority = normal('SELECT * FROM commerce_authority_control');
  const changes = normal('SELECT total_changes() AS count')[0].count;
  const readOnly = (sql: string) => {
    assert.match(sql, /^SELECT\b/);
    return normal(sql);
  };
  const result = await runDeliveryRecoveryStateControl(['status'], { query: readOnly });
  const hydrated = queryRemoteCommerceDocuments(ORDERS_SQL, readOnly);
  assert.equal(result.mode, 'table');
  assert.equal(result.preparation, 'ready');
  assert.equal(result.validationError, null);
  assert.equal(result.deliveryCount, values.length);
  assert.equal(result.legacyMetadataCount, 0);
  assert.deepEqual(hydrated.map((document) => document.data.receiptRecovery), values);
  assert.equal(Object.hasOwn(hydrated[0].data, 'receiptRecovery'), false);
  assert.equal(Object.hasOwn(hydrated[1].data, 'receiptRecovery'), true);
  const records = savedRows.map(parseDeliveryRecoveryRow);
  records.forEach((record, index) => {
    assert.equal(record.receiptRecoveryJson, values[index] === undefined ? null : JSON.stringify(values[index]));
    assert.equal(record.revision, index === values.length - 1 ? 2 : 1);
  });
  assert.equal(records.at(-1)!.leaseId, LEASE_ID);
  assert.equal(records.at(-1)!.leaseExpiresAtMs, 5000);
  assert.equal(records.at(-1)!.preparedDelayMs, 600000);
  assert.equal(records.at(-1)!.preparedExplicitAtMs, 1500);
  assert.equal(records.at(-1)!.processingRetryAtMs, 31000);
  assert.deepEqual(normal('SELECT * FROM commerce_documents ORDER BY document_path'), parents);
  assert.deepEqual(normal('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path'), savedRows);
  assert.deepEqual(normal('SELECT * FROM commerce_authority_control'), authority);
  assert.equal(normal('SELECT total_changes() AS count')[0].count, changes);
  assert.ok(parents.every((row) => !Object.hasOwn(parseCommerceD1DocumentRow(row).data, 'receiptRecovery')));
});

test('recovery status reports current retry schedules and active versus expired leases', async (context) => {
  const fixture = harness(context);
  const now = Date.now();
  seedCommerceDocuments(fixture, [
    orderSeed('1', { receiptRecovery: { lastAttemptAt: 1000, leaseExpiresAt: now + 60000 } }),
    orderSeed('2', { receiptRecovery: { lastAttemptAt: 2000, leaseExpiresAt: 1000 } }),
    orderSeed('3', { status: 'prepared' }),
  ]);
  const result = await runDeliveryRecoveryStateControl(['status'], { query: query(fixture.database) });
  assert.equal(result.validationError, null);
  assert.deepEqual(result.groups, [
    { status: 'prepared', count: 1, oldest_retry_at_ms: null, expired_leases: 0, active_leases: 0 },
    { status: 'processing', count: 2, oldest_retry_at_ms: 31000, expired_leases: 1, active_leases: 1 },
  ]);
});

for (const condition of ['missing', 'corrupt-projections', 'malformed-parent'] as const) {
  test(`recovery status diagnoses ${condition} state without repairing it`, async (context) => {
    const fixture = harness(context);
    seedCommerceDocument(fixture, orderSeed('1', { receiptRecovery: { preparedProbeCount: 0 } }));
    if (condition === 'missing') {
      fixture.database.exec('DROP TRIGGER commerce_delivery_recovery_delete_guard; DELETE FROM commerce_delivery_recovery');
    } else if (condition === 'corrupt-projections') {
      fixture.database.exec('DROP TRIGGER commerce_delivery_recovery_update_guard; UPDATE commerce_delivery_recovery SET prepared_delay_ms = 120000');
    } else {
      const seed = orderSeed('1', {}, 'drop', 2);
      seed.updateTime = 'broken';
      seedCommerceDocument(fixture, seed);
    }
    const normal = query(fixture.database);
    const changes = normal('SELECT total_changes() AS count')[0].count;
    const result = await runDeliveryRecoveryStateControl(['status'], { query: normal });
    const error = condition === 'missing' ? /state is missing/ : condition === 'corrupt-projections' ? /projections/ : /identity is inconsistent/;
    assert.match(result.validationError!, error);
    assert.throws(() => queryRemoteCommerceDocuments(ORDERS_SQL, normal), error);
    assert.equal(normal('SELECT total_changes() AS count')[0].count, changes);
  });
}

test('maintenance hydration follows current recovery state without restoring parent metadata', async (context) => {
  const fixture = harness(context);
  seedCommerceDocument(fixture, orderSeed('1', { receiptRecovery: { preparedProbeCount: 0, future: 'initial' } }));
  const normal = query(fixture.database);
  const parents = normal('SELECT * FROM commerce_documents');
  const original = parseDeliveryRecoveryRow(normal('SELECT * FROM commerce_delivery_recovery')[0]);
  const repository = new D1CommerceRepository(fixture.db);
  await repository.run(3000, async (unit) => {
    const snapshot = await unit.getRecoverySnapshot(commerceKeys.deliveryOrder('drop', '1'));
    assert.ok(snapshot);
    unit.stageRecovery(updateDeliveryRecoveryRecord(snapshot.state, {
      receiptRecoveryJson: JSON.stringify({ preparedProbeCount: 3, future: 'current' }), leaseId: LEASE_ID,
    }, 3000));
  });
  assert.deepEqual(queryRemoteCommerceDocuments(ORDERS_SQL, normal)[0].data.receiptRecovery, { preparedProbeCount: 3, future: 'current' });
  assert.equal((await runDeliveryRecoveryStateControl(['status'], { query: normal })).validationError, null);
  assert.deepEqual(normal('SELECT * FROM commerce_documents'), parents);
  const current = parseDeliveryRecoveryRow(normal('SELECT * FROM commerce_delivery_recovery')[0]);
  assert.equal(current.generation, original.generation);
  assert.equal(current.revision, original.revision + 1);
  assert.equal(current.leaseId, LEASE_ID);
});

for (const boundary of ['preflight', 'snapshot'] as const) {
  test(`maintenance hydration keeps a coherent parent and recovery record across a concurrent ${boundary} update`, (context) => {
    const fixture = harness(context);
    seedCommerceDocument(fixture, orderSeed('1', { snapshotLabel: 'original', receiptRecovery: { preparedProbeCount: 0 } }));
    const normal = query(fixture.database);
    let calls = 0;
    const hydrated = queryRemoteCommerceDocuments(`${ORDERS_SQL} LIMIT 1;`, (sql) => {
      const rows = normal(sql);
      calls += 1;
      if (calls === (boundary === 'preflight' ? 1 : 2)) {
        seedCommerceDocument(fixture, orderSeed('1', { snapshotLabel: 'updated', receiptRecovery: { preparedProbeCount: 1 } }, 'drop', 2));
      }
      return rows;
    });
    assert.equal(calls, 2);
    assert.equal(hydrated.length, 1);
    const updated = boundary === 'preflight';
    assert.equal(hydrated[0].version, updated ? 2 : 1);
    assert.equal(hydrated[0].data.snapshotLabel, updated ? 'updated' : 'original');
    assert.deepEqual(hydrated[0].data.receiptRecovery, { preparedProbeCount: updated ? 1 : 0 });
    assert.equal(normal('SELECT version FROM commerce_documents')[0].version, 2);
    assert.equal(parseDeliveryRecoveryRow(normal('SELECT * FROM commerce_delivery_recovery')[0]).revision, 2);
  });
}

test('maintenance snapshots preserve filtering, ordering and limits while hydrating each selected order', (context) => {
  const fixture = harness(context);
  seedCommerceDocuments(fixture, [
    orderSeed('1', { receiptRecovery: { marker: 1 } }),
    orderSeed('2', { receiptRecovery: { marker: 2 } }),
    orderSeed('3', { receiptRecovery: { marker: 3 } }),
    orderSeed('9', { receiptRecovery: { marker: 9 } }, 'other'),
  ]);
  const rows = queryRemoteCommerceDocuments(`SELECT * FROM commerce_documents
    WHERE document_kind = 'delivery_order' AND drop_id = 'drop' AND document_id > '1'
    ORDER BY document_path DESC LIMIT 1;`, query(fixture.database));
  assert.deepEqual(rows.map((row) => [row.path, row.data.receiptRecovery]), [
    ['drops/drop/deliveryOrders/3', { marker: 3 }],
  ]);
});

test('maintenance reads reject inactive or missing state tables even for empty delivery results', (context) => {
  for (const options of [{ deliveryRecoveryMode: 'legacy' }, { stripeCheckoutStateMode: 'legacy' }] as const) {
    const fixture = createCommerceD1Harness(options);
    context.after(() => fixture.database.close());
    assert.throws(() => queryRemoteCommerceDocuments(`${ORDERS_SQL} LIMIT 0`, query(fixture.database)), /requires active checkout and delivery recovery table storage/);
  }
  for (const table of ['commerce_delivery_recovery_control', 'commerce_delivery_recovery', 'commerce_stripe_checkout_state']) {
    const fixture = harness(context);
    fixture.database.exec(`DROP TABLE ${table}`);
    assert.throws(() => queryRemoteCommerceDocuments(`${ORDERS_SQL} LIMIT 0`, query(fixture.database)), /no such table/);
  }
});

test('recovery status reads 548 orders in bounded pages without per-order queries or writes', async (context) => {
  const fixture = harness(context);
  const orderCount = 548;
  seedCommerceDocuments(fixture, Array.from({ length: orderCount }, (_, index) => orderSeed(String(1000 + index))));
  const normal = query(fixture.database);
  const saved = normal('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path');
  const pageSizes: number[] = [];
  const paths: string[] = [];
  let calls = 0;
  const result = await runDeliveryRecoveryStateControl(['status'], { query: (sql) => {
    calls += 1;
    assert.match(sql, /^SELECT\b/);
    assert.ok(Buffer.byteLength(sql) < 100000);
    const rows = normal(sql);
    if (rows.length && Object.hasOwn(rows[0], 'document_json')) {
      assert.ok(rows.length <= 5, 'Status must not return an unbounded page of recovery journals.');
      pageSizes.push(rows.length);
      paths.push(...rows.map((row) => String(row.document_path)));
    }
    return rows;
  } });
  assert.equal(result.deliveryCount, orderCount);
  assert.equal(result.validationError, null);
  assert.deepEqual(pageSizes, [...Array(109).fill(5), 3]);
  assert.equal(new Set(paths).size, orderCount);
  assert.deepEqual(paths, saved.map((row) => String(row.parent_path)));
  assert.ok(calls <= Math.ceil(orderCount / 5) + 4, `Status made ${calls} queries for ${orderCount} orders.`);
  assert.deepEqual(normal('SELECT * FROM commerce_delivery_recovery ORDER BY parent_path'), saved);
});

test('large recovery status pages remain below the runner output limit without duplicate parent journals', async (context) => {
  const fixture = harness(context);
  const receiptRecovery = { custom: '\\'.repeat(900_000), preparedProbeCount: 1 };
  seedCommerceDocuments(fixture, Array.from({ length: 11 }, (_, index) =>
    orderSeed(String(1000 + index), { retained: '\\'.repeat(75_000), receiptRecovery })));
  const normal = query(fixture.database);
  let inspected = 0;
  const result = await runDeliveryRecoveryStateControl(['status'], { query: (sql) => {
    const rows = normal(sql);
    assert.ok(responseBytes(rows) < 64 * 1024 * 1024, 'Each status response must fit the runner output limit.');
    if (rows.length && Object.hasOwn(rows[0], 'document_json')) {
      assert.ok(rows.length <= 5);
      for (const row of rows) {
        assert.equal(Object.hasOwn(JSON.parse(String(row.document_json)), 'receiptRecovery'), false);
        assert.deepEqual(JSON.parse(String(row.receipt_recovery_json)), receiptRecovery);
        inspected += 1;
      }
    }
    return rows;
  } });
  assert.equal(result.deliveryCount, 11);
  assert.equal(result.validationError, null);
  assert.equal(inspected, 11);
});

test('maintenance hydration returns large journals once without duplicating them in metadata or state JSON', (context) => {
  const fixture = harness(context);
  const receiptRecovery = { preparedProbeCount: 1, future: '"\\'.repeat(275_000) };
  seedCommerceDocuments(fixture, Array.from({ length: 16 }, (_, index) => orderSeed(String(1000 + index), { receiptRecovery })));
  const normal = query(fixture.database);
  const payloadJson = JSON.stringify(receiptRecovery);
  assert.ok(Buffer.byteLength(payloadJson) > 1_100_000);
  let snapshots = 0;
  const hydrated = queryRemoteCommerceDocuments(ORDERS_SQL, (sql) => {
    const rows = normal(sql);
    assert.ok(responseBytes(rows) < 64 * 1024 * 1024, 'Hydrated query output must fit the runner output limit.');
    if (rows.length && Object.hasOwn(rows[0], 'recovery_payload_json')) {
      snapshots += 1;
      assert.equal(rows.length, 16);
      for (const row of rows) {
        assert.equal(Object.hasOwn(JSON.parse(String(row.document_json)), 'receiptRecovery'), false);
        assert.equal(row.recovery_payload_json, payloadJson);
        assert.equal(Object.hasOwn(JSON.parse(String(row.recovery_state_json)), 'receipt_recovery_json'), false);
        assert.ok(Buffer.byteLength(String(row.recovery_state_json)) < 1024);
      }
    }
    return rows;
  });
  assert.equal(snapshots, 1);
  assert.equal(hydrated.length, 16);
  hydrated.forEach((document) => assert.deepEqual(document.data.receiptRecovery, receiptRecovery));
});
