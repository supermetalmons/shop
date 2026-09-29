import assert from 'node:assert/strict';
import test from 'node:test';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { deliveryRecoveryPageQuery } from '../src/commerceQueries.ts';
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
