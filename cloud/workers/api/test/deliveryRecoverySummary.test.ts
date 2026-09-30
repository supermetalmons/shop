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

test('recovery summaries select only timing fields while preserving owner scope and malformed delivery identities', async (context) => {
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
  const query = deliveryRecoveryStateQuery('owner');
  assert.equal(calls[0].statements[1].sql, query.sql);
  assert.match(query.sql, /authority\.authority_state = 'd1'/);
  assert.doesNotMatch(query.sql, /ORDER BY/);
  const plan = harness.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings)
    .map((row) => row.detail).join('\n');
  assert.match(plan, /SEARCH document USING INDEX commerce_documents_delivery_owner_status/);
  assert.doesNotMatch(plan, /SCAN document|USE TEMP B-TREE/);
  const projected = harness.database.prepare(query.sql).all(...query.bindings);
  assert.equal(projected.length, 3);
  for (const row of projected) {
    assert.ok(String(row.document_json).length < 300);
    const data = JSON.parse(String(row.document_json));
    assert.deepEqual(Object.keys(data).sort(), ['createdAt', 'receiptRecovery', 'status']);
    assert.deepEqual(Object.keys(data.receiptRecovery).sort(), [
      'lastAttemptAt', 'leaseExpiresAt', 'nextPreparedProbeAt', 'preparedProbeCount',
    ]);
  }
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
    { document_path: 'archives/drop/deliveryOrders/1' },
    { document_kind: 'claim_code' },
    { document_id: '2' },
    { drop_id: 'other' },
    { version: 0 },
    { create_time: null },
    { update_time: null },
    { processed_at_seconds: 1, processed_at_nanos: null },
    { document_json: '[]' },
    { document_json: '{' },
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
