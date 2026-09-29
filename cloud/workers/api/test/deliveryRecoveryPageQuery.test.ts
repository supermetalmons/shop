import assert from 'node:assert/strict';
import test from 'node:test';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { deliveryRecoveryPageQuery } from '../src/commerceQueries.ts';
import { runDeliveryRecoveryPageQuery } from '../src/deliveryRecoveryStore.ts';
import { decodeDeliveryRecoveryCursor } from '../../../../shared/deliveryRecoveryPagination.ts';
import { createCommerceD1Harness, seedCommerceDocuments, seedNotificationOutbox } from './commerceD1Harness.ts';

test('recovery pages filter by wallet, drop and phase before applying stable path boundaries', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  seedCommerceDocuments(harness, Array.from({ length: 18 }, (_, index) => ({
    key: commerceKeys.deliveryOrder(index < 3 ? 'other' : 'drop', String(index).padStart(2, '0')),
    data: { owner: index === 4 ? 'other-wallet' : 'wallet', status: index === 5 ? 'prepared' : 'processing' },
  })));
  const args = { owner: 'wallet', dropId: 'drop', phase: 'processing', limit: 9 } as const;
  const first = await repository.queryDeliveryRecoveryPage(args);
  assert.deepEqual(first.map((row) => row.key.documentId), ['03', '06', '07', '08', '09', '10', '11', '12', '13']);
  const tail = await repository.queryDeliveryRecoveryPage({ ...args, startAfterPath: first.at(-1)!.key.path });
  assert.deepEqual(tail.map((row) => row.key.documentId), ['14', '15', '16', '17']);
  const prepared = await repository.queryDeliveryRecoveryPage({ ...args, phase: 'prepared' });
  assert.deepEqual(prepared.map((row) => row.key.documentId), ['05']);
  const query = deliveryRecoveryPageQuery(args);
  const plan = harness.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings);
  assert.ok(plan.some((row) => String(row.detail).includes('commerce_documents_delivery_owner_status')));
  assert.ok(plan.every((row) => !String(row.detail).includes('TEMP B-TREE')));
  await assert.rejects(repository.queryDeliveryRecoveryPage({ ...args, limit: 10 }), /Invalid recovery page/);
});

test('ready recovery pages include only pending notifications for the requested drop and owner', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const keys = ['other', 'drop', 'drop'].map((drop, index) => commerceKeys.deliveryOrder(drop, String(index + 1)));
  seedCommerceDocuments(harness, keys.map((key) => ({ key, data: { owner: 'wallet', status: 'ready_to_ship' } })));
  for (const [index, key] of keys.entries()) {
    const state = index === 2 ? 'queued' : 'pending';
    seedNotificationOutbox(harness, {
      parentPath: key.path, family: 'ready', dropId: key.dropId!, generation: crypto.randomUUID(),
      outcome: null, state, revision: 1, attemptCount: 0,
      entries: [{ kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: `ready:${index}`, state }],
      nextAttemptAtMs: state === 'pending' ? 0 : null, claimId: null, claimExpiresAtMs: null,
      retryUntilMs: 10_000, createdAtMs: 0, updatedAtMs: 0, lastErrorCode: null,
    });
  }
  const args = { owner: 'wallet', dropId: 'drop', phase: 'ready', limit: 9 } as const;
  const page = await repository.queryDeliveryRecoveryPage(args);
  assert.deepEqual(page.map((row) => row.key.path), [keys[1].path]);
  assert.deepEqual(await repository.queryDeliveryRecoveryPage({ ...args, owner: 'other' }), []);
  assert.deepEqual(await repository.queryDeliveryRecoveryPage({ ...args, startAfterPath: keys[1].path }), []);
});

for (const phase of ['processing', 'prepared', 'ready'] as const) {
  for (const position of ['first', 'lookahead'] as const) {
    test(`${phase} recovery excludes an unencodable ${position} row before applying the page limit`, async (context) => {
      const harness = createCommerceD1Harness();
      context.after(() => harness.database.close());
      const repository = new D1CommerceRepository(harness.db);
      const owner = '11111111111111111111111111111111';
      const status = phase === 'ready' ? 'ready_to_ship' : phase;
      const ids = ['10', '11', '12', '13', '14', '15', '16', '17', '19', '20'];
      const prefix = 'drops/drop/deliveryOrders/';
      const malformedId = position === 'first' ? `!${'x'.repeat(500)}` : `18${'"'.repeat(512 - prefix.length - 2)}`;
      const malformedKey = commerceKeys.deliveryOrder('drop', malformedId);
      const keys = [malformedKey, ...ids.map((id) => commerceKeys.deliveryOrder('drop', id))];
      seedCommerceDocuments(harness, keys.map((key) => ({ key, data: { owner, status } })));
      if (phase === 'ready') {
        for (const [index, key] of keys.entries()) seedNotificationOutbox(harness, {
          parentPath: key.path, family: 'ready', dropId: 'drop', generation: crypto.randomUUID(),
          outcome: null, state: 'pending', revision: 1, attemptCount: 0,
          entries: [{ kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: `ready:${index}`, state: 'pending' }],
          nextAttemptAtMs: 0, claimId: null, claimExpiresAtMs: null,
          retryUntilMs: 10_000, createdAtMs: 0, updatedAtMs: 0, lastErrorCode: null,
        });
      }
      const commerce = { repository, nowMs: Date.now(), signal: new AbortController().signal };
      const first = await runDeliveryRecoveryPageQuery(commerce, owner, 'drop', false, null);
      assert.deepEqual(first.map(({ document }) => document.key.documentId), ids.slice(0, 9));
      const cursor = decodeDeliveryRecoveryCursor(first[7].cursor)!;
      const tail = await runDeliveryRecoveryPageQuery(commerce, owner, 'drop', false, cursor);
      assert.deepEqual(tail.map(({ document }) => document.key.documentId), ['19', '20']);
      assert.ok([...first, ...tail].every(({ cursor }) => decodeDeliveryRecoveryCursor(cursor)));
      const legacy = phase === 'ready'
        ? await repository.queryPendingReadyNotifications({ owner, limit: 20 })
        : await repository.queryDeliveryRecoveryOrders(owner);
      assert.ok(legacy.some((document) => document.key.path === malformedKey.path));
    });
  }
}
