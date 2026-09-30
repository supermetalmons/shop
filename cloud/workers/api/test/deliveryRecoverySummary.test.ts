import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryRecoveryStateQuery } from '../src/commerceQueries.ts';
import {
  CommerceRepositoryError,
  D1CommerceRepository,
  commerceKeys,
  type CommerceDocumentData,
  type CommerceJsonValue,
} from '../src/commerceRepository.ts';
import { fetchDeliveryRecoveryState } from '../src/deliveryRecoveryStore.ts';
import {
  createCommerceD1Harness,
  seedCommerceDocuments,
  type CommerceD1CallObservation,
} from './commerceD1Harness.ts';

test('recovery summaries aggregate timing fields while preserving owner scope and malformed delivery identities', async (context) => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  context.after(() => harness.database.close());
  const largeValue = 'x'.repeat(100_000);
  seedCommerceDocuments(harness, [
    {
      key: commerceKeys.deliveryOrder('drop', '1'),
      data: { owner: 'owner', status: 'processing', receiptRecovery: { lastAttemptAt: 90_000, leaseExpiresAt: 140_000 } },
    },
    { key: commerceKeys.deliveryOrder('drop', 'malformed'), data: { owner: 'owner', status: 'processing' } },
    {
      key: commerceKeys.deliveryOrder('other-drop', '2'),
      data: {
        owner: 'owner', status: 'prepared', createdAt: 1_000, items: [largeValue], addressSnapshot: { encrypted: largeValue },
        receiptRecovery: { preparedProbeCount: 0, nextPreparedProbeAt: 80_000, pendingSubmission: { signedTx: largeValue } },
      },
    },
    { key: commerceKeys.deliveryOrder('drop', '3'), data: { owner: 'other', status: 'processing' } },
    { key: commerceKeys.deliveryOrder('drop', '4'), data: { owner: 'owner', status: 'ready_to_ship' } },
    { key: commerceKeys.stripeCheckout('drop', '5'), data: { owner: 'owner', status: 'processing' } },
  ]);
  const repository = new D1CommerceRepository(harness.db);
  assert.deepEqual(await repository.queryDeliveryRecoveryState({ owner: 'owner', nowMs: 100_000 }), {
    remainingProcessing: 2, nextCheckAt: 80_000,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'batch');
  if (calls[0].method !== 'batch') assert.fail('Expected one authoritative batch.');
  assert.equal(calls[0].statements.length, 2);
  const query = deliveryRecoveryStateQuery('owner', 100_000, 100_000);
  assert.equal(calls[0].statements[1].sql, query.sql);
  assert.match(calls[0].statements[0].sql, /commerce_delivery_recovery_control/);
  assert.doesNotMatch(query.sql, /ORDER BY/);
  const plan = harness.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings)
    .map((row) => row.detail).join('\n');
  assert.match(plan, /SEARCH document USING INDEX commerce_documents_delivery_owner_status/);
  assert.doesNotMatch(plan, /SCAN document|USE TEMP B-TREE/);
  const projected = harness.database.prepare(query.sql).all(...query.bindings);
  assert.equal(projected.length, 1);
  assert.deepEqual({ ...projected[0] }, { remaining_processing: 2, next_check_at: 80_000, invalid_count: 0 });
  assert.ok(JSON.stringify(projected).length < 150);
  await assert.rejects(repository.queryDeliveryRecoveryState({ owner: '', nowMs: 100_000 }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'invalid-argument');
  assert.equal(calls.length, 1);
});

test('recovery summaries preserve legacy timing values, retry leases, and prepared probe exhaustion', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const cases: Array<{ data: CommerceDocumentData; expected: number | null }> = [
    { data: { status: 'processing' }, expected: 100_000 },
    { data: { status: 'processing', receiptRecovery: { lastAttemptAt: 90_000 } }, expected: 120_000 },
    { data: { status: 'processing', receiptRecovery: { lastAttemptAt: 90_000, leaseExpiresAt: 150_000 } }, expected: 150_000 },
    { data: { status: 'processing', receiptRecovery: { lastAttemptAt: 1, leaseExpiresAt: 2 } }, expected: 100_000 },
    { data: { status: 'prepared', createdAt: 1_000 }, expected: 31_000 },
    { data: { status: 'prepared', createdAt: 1_000, receiptRecovery: { preparedProbeCount: '1' } }, expected: 121_000 },
    { data: { status: 'prepared', createdAt: 1_000, receiptRecovery: { preparedProbeCount: true } }, expected: 121_000 },
    { data: { status: 'prepared', createdAt: 1_000, receiptRecovery: { preparedProbeCount: [2.9] } }, expected: 601_000 },
    { data: { status: 'prepared', createdAt: 1_000, receiptRecovery: { preparedProbeCount: -1 } }, expected: 31_000 },
    { data: { status: 'prepared', receiptRecovery: { preparedProbeCount: 3, nextPreparedProbeAt: 50_000 } }, expected: null },
    { data: { status: 'prepared', receiptRecovery: { preparedProbeCount: 'Infinity', nextPreparedProbeAt: 50_000 } }, expected: 50_000 },
    { data: { status: 'prepared', createdAt: -1 }, expected: 100_000 },
    { data: { status: 'prepared', createdAt: 0 }, expected: 100_000 },
  ];
  const malformedValues: CommerceJsonValue[] = [null, '200000', true, [], [200_000], {}, { seconds: 200 }];
  for (const value of malformedValues) {
    cases.push(
      { data: { status: 'processing', receiptRecovery: { lastAttemptAt: value, leaseExpiresAt: value } }, expected: 100_000 },
      { data: { status: 'prepared', createdAt: value, receiptRecovery: { nextPreparedProbeAt: value } }, expected: 100_000 },
      { data: { status: 'prepared', createdAt: 1_000, receiptRecovery: value }, expected: 31_000 },
    );
  }
  seedCommerceDocuments(harness, cases.map(({ data }, index) => ({
    key: commerceKeys.deliveryOrder('drop', String(index)), data: { ...data, owner: `owner-${index}` },
  })));
  const repository = new D1CommerceRepository(harness.db);
  for (const [index, { data, expected }] of cases.entries()) {
    assert.deepEqual(await repository.queryDeliveryRecoveryState({ owner: `owner-${index}`, nowMs: 100_000, preparedNowMs: 100_000 }), {
      remainingProcessing: data.status === 'processing' ? 1 : 0, nextCheckAt: expected,
    }, JSON.stringify(data));
  }
});

test('recovery responses retain the live prepared fallback clock independently of processing time', async (context) => {
  context.mock.method(Date, 'now', () => 200_000);
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocuments(harness, [{ key: commerceKeys.deliveryOrder('drop', '1'), data: { owner: 'owner', status: 'prepared' } }]);
  const repository = new D1CommerceRepository(harness.db);
  assert.deepEqual(await fetchDeliveryRecoveryState({ repository, nowMs: 100_000, signal: new AbortController().signal }, 'owner', 100_000), {
    remainingProcessing: 0, nextCheckAt: 200_000,
  });
  assert.deepEqual(await repository.queryDeliveryRecoveryState({ owner: 'owner', nowMs: 100_000, preparedNowMs: 100_000 }), {
    remainingProcessing: 0, nextCheckAt: 100_000,
  });
});

test('recovery summaries fail closed on corrupt document metadata and projected JSON', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocuments(harness, [{ key: commerceKeys.deliveryOrder('drop', '1'), data: { owner: 'owner', status: 'processing' } }]);
  const corruptions = [
    { invalid_count: 1 }, { invalid_count: null }, { remaining_processing: -1 },
    { remaining_processing: '1' }, { next_check_at: '90000' }, { next_check_at: Number.NaN },
  ];
  for (const corruption of corruptions) {
    const database = new Proxy(harness.db, {
      get(target, property, receiver) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch<Record<string, unknown>>(statements);
          return [results[0], { ...results[1], results: results[1].results.map((row) => ({ ...row, ...corruption })) }];
        };
        return Reflect.get(target, property, receiver);
      },
    });
    await assert.rejects(new D1CommerceRepository(database).queryDeliveryRecoveryState({ owner: 'owner', nowMs: 100_000 }),
      (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable', JSON.stringify(corruption));
  }
});


test('recovery summary rejects missing state instead of hiding outstanding orders', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  seedCommerceDocuments(harness, [{ key: commerceKeys.deliveryOrder('drop', '7'), data: { owner: 'owner', status: 'processing' } }]);
  harness.database.exec('DROP TRIGGER commerce_delivery_recovery_delete_guard');
  harness.database.exec('DELETE FROM commerce_delivery_recovery');
  await assert.rejects(new D1CommerceRepository(harness.db).queryDeliveryRecoveryState({ owner: 'owner', nowMs: 1 }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable');
});


test('recovery summary rejects invalid stored lease identities', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const key = commerceKeys.deliveryOrder('drop', '7');
  seedCommerceDocuments(harness, [{ key, data: { owner: 'owner', status: 'processing' } }]);
  const state = harness.database.prepare('SELECT generation, revision FROM commerce_delivery_recovery WHERE parent_path = ?').get(key.path)!;
  const guardId = crypto.randomUUID();
  harness.database.prepare(`INSERT INTO commerce_commit_guards
    (guard_id, expectations_json, created_at_ms, delivery_recovery_expectations_json)
    VALUES (?, '[]', 0, ?)`).run(guardId, JSON.stringify([{ parentPath: key.path, ...state }]));
  harness.database.prepare('UPDATE commerce_delivery_recovery SET lease_id = ?, revision = revision + 1 WHERE parent_path = ?')
    .run('x'.repeat(36), key.path);
  harness.database.prepare('DELETE FROM commerce_commit_guards WHERE guard_id = ?').run(guardId);
  await assert.rejects(new D1CommerceRepository(harness.db).queryDeliveryRecoveryState({ owner: 'owner', nowMs: 1 }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable');
});
