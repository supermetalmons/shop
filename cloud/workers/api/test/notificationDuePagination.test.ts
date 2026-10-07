import assert from 'node:assert/strict';
import test from 'node:test';
import { commerceKeys, D1CommerceRepository } from '../src/commerceRepository.ts';
import { dueReadyNotificationsQuery, notificationOutboxDueQuery } from '../src/commerceQueries.ts';
import { parseNotificationOutboxCandidate, parseReadyNotificationCandidate, type NotificationDueCursor } from '../src/commerceDiscoveryCandidates.ts';
import { createCommerceD1Harness, seedCommerceDocument, seedNotificationOutbox } from './commerceD1Harness.ts';

function fixture(context: test.TestContext) {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const parents = new Set<number>();
  function seed(id: number, dueAtMs: number, family: 'ready' | 'shipped' = 'ready') {
    const key = commerceKeys.deliveryOrder('drop', String(id));
    if (!parents.has(id)) {
      seedCommerceDocument(harness, { key, data: { status: 'ready_to_ship', deliveryId: id, dropId: 'drop' } });
      parents.add(id);
    }
    const record = {
      parentPath: key.path, family, dropId: 'drop', generation: crypto.randomUUID(), outcome: null,
      state: 'pending' as const, revision: 1,
      entries: [{ kind: family === 'ready' ? 'buyer_order_received' as const : 'buyer_order_shipped' as const,
        jobId: crypto.randomUUID(), idempotencyKey: `drop:${id}:${family}`, state: 'pending' as const }],
      attemptCount: 0, retryUntilMs: 10_000, claimId: null, claimExpiresAtMs: null,
      nextAttemptAtMs: dueAtMs, createdAtMs: 0, updatedAtMs: 0, lastErrorCode: null,
    };
    seedNotificationOutbox(harness, record);
    return record;
  }
  return { harness, repository, seed };
}

test('ready notification keysets advance through due-time ties using the existing index', async (context) => {
  const { harness, repository, seed } = fixture(context);
  for (const [id, due] of [[1, 5], [2, 10], [3, 10], [4, 11]]) seed(id, due);
  const first = await repository.queryDueReadyNotifications({ dueAtMs: 10, limit: 2 });
  assert.deepEqual(first.map(({ key, nextAttemptAtMs }) => [key.documentId, nextAttemptAtMs]), [['1', 5], ['2', 10]]);
  const startAfter: NotificationDueCursor = { parentPath: first[1].key.path, nextAttemptAtMs: 10, family: 'ready' };
  const next = await repository.queryDueReadyNotifications({ dueAtMs: 10, limit: 2, startAfter });
  assert.deepEqual(next.map(({ key }) => key.documentId), ['3']);
  const query = dueReadyNotificationsQuery({ dueAtMs: 10, limit: 2, startAfter });
  const plan = JSON.stringify(harness.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings));
  assert.match(plan, /SEARCH outbox USING (?:COVERING )?INDEX commerce_notification_outbox_family_due/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
});

test('outbox keysets retain family ties and support a family-scoped head probe', async (context) => {
  const { harness, repository, seed } = fixture(context);
  seed(1, 10, 'ready');
  seed(1, 10, 'shipped');
  seed(2, 10, 'shipped');
  const first = await repository.notificationOutbox.queryDue({ dueAtMs: 10, limit: 1 });
  assert.equal(first[0].family, 'ready');
  const next = await repository.notificationOutbox.queryDue({ dueAtMs: 10, limit: 2, startAfter: first[0] });
  assert.deepEqual(next.map(({ parentPath, family }) => [parentPath, family]), [
    ['drops/drop/deliveryOrders/1', 'shipped'], ['drops/drop/deliveryOrders/2', 'shipped'],
  ]);
  const scoped = await repository.notificationOutbox.queryDue({ family: 'shipped', dueAtMs: 10, limit: 1, startAfter: next[0] });
  assert.deepEqual(scoped, [next[1]]);
  assert.deepEqual(await repository.notificationOutbox.queryDue({ family: 'shipped', dueAtMs: 10, limit: 1 }), [next[0]]);
  for (const family of [undefined, 'shipped'] as const) {
    const query = notificationOutboxDueQuery({ family, dueAtMs: 10, limit: 2, startAfter: next[0] });
    const plan = JSON.stringify(harness.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings));
    assert.match(plan, family ? /SEARCH outbox USING (?:COVERING )?INDEX commerce_notification_outbox_family_due/ : /SEARCH outbox USING (?:COVERING )?INDEX commerce_notification_outbox_due/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  }
});

test('notification cursors reject malformed values and mismatched families before querying', async (context) => {
  const { harness, repository } = fixture(context);
  context.mock.method(harness.db, 'batch', async () => assert.fail('invalid cursor must not query'));
  const cursor = { parentPath: 'drops/drop/deliveryOrders/1', family: 'ready' as const, nextAttemptAtMs: 10 };
  const malformed: unknown[] = [null, {}, ...[-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, '10'].map((nextAttemptAtMs) => ({ ...cursor, nextAttemptAtMs })),
    { ...cursor, parentPath: 'invalid' }, { ...cursor, family: 'invalid' },
    { ...cursor, parentPath: 'drops/drop/stripeCheckouts/cs_test' }];
  for (const value of malformed) {
    const startAfter = value as NotificationDueCursor;
    await assert.rejects(repository.queryDueReadyNotifications({ dueAtMs: 10, limit: 8, startAfter }), { code: 'invalid-argument' });
    await assert.rejects(repository.notificationOutbox.queryDue({ dueAtMs: 10, limit: 8, startAfter }), { code: 'invalid-argument' });
  }
  await assert.rejects(repository.queryDueReadyNotifications({ dueAtMs: 10, limit: 8, startAfter: { ...cursor, family: 'shipped' } }), { code: 'invalid-argument' });
  await assert.rejects(repository.notificationOutbox.queryDue({ family: 'shipped', dueAtMs: 10, limit: 8, startAfter: cursor }), { code: 'invalid-argument' });
});

test('discovery fails closed on malformed due timestamps', () => {
  for (const next_attempt_at_ms of [undefined, null, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseReadyNotificationCandidate({
      document_path: 'drops/drop/deliveryOrders/1', document_kind: 'delivery_order', document_id: '1', drop_id: 'drop',
      delivery_id_json: '1', drop_id_json: '"drop"', next_attempt_at_ms,
    }), { code: 'unavailable' });
    assert.throws(() => parseNotificationOutboxCandidate({
      parent_path: 'drops/drop/deliveryOrders/1', family: 'shipped', next_attempt_at_ms,
    }), { code: 'unavailable' });
  }
});
