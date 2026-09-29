import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hydrateStripeCheckoutState,
  parseStripeCheckoutStateRow,
  stripeCheckoutStateFromDocument,
  stripeCheckoutStateMetadata,
  stripeCheckoutStateRow,
} from '../../../../shared/stripeCheckoutState.ts';
import { CommerceWriteConflict, D1CommerceRepository, commerceFieldValue, commerceKeys } from '../src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocument, type CommerceD1Harness } from './commerceD1Harness.ts';

const key = commerceKeys.stripeCheckout('drop', 'cs_state');

function activate(harness: CommerceD1Harness): void {
  const { database } = harness;
  database.exec(`INSERT INTO commerce_authority_control_lease VALUES (1, '00000000-0000-4000-8000-000000000026',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000);
    UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
    UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
    UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'preparing',
      source_documents_revision = (SELECT documents_revision FROM commerce_authority_control);`);
  for (const document of database.prepare("SELECT * FROM commerce_documents WHERE document_kind = 'stripe_checkout'").all()) {
    const row = stripeCheckoutStateRow(stripeCheckoutStateFromDocument(String(document.document_path),
      JSON.parse(String(document.document_json)), Number(document.version)));
    const columns = Object.keys(row);
    database.prepare(`INSERT INTO commerce_stripe_checkout_state (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((column) => row[column]));
  }
  database.exec(`UPDATE commerce_stripe_checkout_state_control SET preparation_state = 'ready', prepared_at_ms = 0;
    UPDATE commerce_stripe_checkout_state_control SET storage_mode = 'table';
    UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1, paused_at_ms = NULL,
      updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
    DELETE FROM commerce_authority_control_lease;`);
}

test('checkout state validates exact scalars and hydration never revives cleared historical fields', () => {
  const legacy = { status: 'processing', processingAttemptId: 'old', nextFulfillmentRetryAt: 300, updatedAt: 100,
    stripeSessionSummary: { id: 'cs_state' } };
  const state = stripeCheckoutStateFromDocument(key.path, { status: 'fulfilled', updatedAt: 200 }, 2);
  assert.deepEqual(parseStripeCheckoutStateRow(stripeCheckoutStateRow(state)), state);
  const hydrated = hydrateStripeCheckoutState(legacy, state);
  assert.equal(hydrated.status, 'fulfilled');
  assert.equal(Object.hasOwn(hydrated, 'processingAttemptId'), false);
  assert.equal(Object.hasOwn(hydrated, 'nextFulfillmentRetryAt'), false);
  assert.deepEqual(stripeCheckoutStateMetadata(hydrated, legacy), legacy);
  assert.equal(legacy.status, 'processing');
  for (const fields of [{ status: 'other' }, { status: 'created', updatedAt: '100' },
    { status: 'processing', processingAttemptCount: -1 }, { status: 'processing', processingLeaseExpiresAt: 0.5 }]) {
    assert.throws(() => stripeCheckoutStateFromDocument(key.path, fields, 1), /Invalid Stripe checkout state/);
  }
  assert.throws(() => parseStripeCheckoutStateRow({ document_path: key.path, document_version: 1, status: 'created' }),
    /Invalid Stripe checkout state/);
});

test('checkout state-only writes preserve frozen JSON and bump the parent without rewriting its payload', async () => {
  const writes: string[] = [];
  const harness = createCommerceD1Harness({ stripeCheckoutStateMode: 'legacy',
    observeStatement: ({ method, sql }) => { if (method === 'run') writes.push(sql); } });
  seedCommerceDocument(harness, { key, data: { status: 'processing', processingAttemptId: 'old',
    nextFulfillmentRetryAt: 400, updatedAt: 100, metadata: { kept: true } } });
  activate(harness);
  const original = harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(key.path)!.document_json;
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(Date.now(), (unit) => unit.update(key, {
    status: 'fulfilled', processingAttemptId: commerceFieldValue.delete(),
    nextFulfillmentRetryAt: commerceFieldValue.delete(), updatedAt: commerceFieldValue.serverTimestamp(),
  }));
  const current = await repository.get(key);
  assert.equal(current?.version, 2);
  assert.equal(current?.data.status, 'fulfilled');
  assert.equal(Object.hasOwn(current!.data, 'processingAttemptId'), false);
  assert.equal(Object.hasOwn(current!.data, 'nextFulfillmentRetryAt'), false);
  assert.equal(harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(key.path)!.document_json, original);
  const parentWrites = writes.filter((sql) => /(?:INSERT INTO|UPDATE) commerce_documents\b/.test(sql));
  assert.equal(parentWrites.length, 1);
  assert.doesNotMatch(parentWrites[0], /document_json/);
  assert.equal(harness.database.prepare('SELECT document_version FROM commerce_stripe_checkout_state WHERE document_path = ?').get(key.path)!.document_version, 2);
  await repository.run(Date.now(), (unit) => unit.update(key, { metadata: { changed: true }, updatedAt: commerceFieldValue.serverTimestamp() }));
  const raw = JSON.parse(String(harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?').get(key.path)!.document_json));
  assert.equal(raw.status, 'processing');
  assert.equal(raw.processingAttemptId, 'old');
  assert.deepEqual(raw.metadata, { changed: true });
  assert.equal((await repository.get(key))?.data.status, 'fulfilled');
});

test('checkout state shares optimistic conflicts and commits terminal outbox rows atomically', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, { key, data: { status: 'fulfillment_pending', updatedAt: 100 } });
  const repository = new D1CommerceRepository(harness.db);
  const first = await repository.begin(Date.now());
  const second = await repository.begin(Date.now());
  await first.get(key);
  await second.get(key);
  await first.update(key, { status: 'processing', processingAttemptId: 'winner' });
  await second.update(key, { status: 'processing', processingAttemptId: 'loser' });
  await first.commit();
  await assert.rejects(second.commit(), CommerceWriteConflict);
  assert.equal((await repository.get(key))?.data.processingAttemptId, 'winner');
  await repository.run(Date.now(), async (unit) => {
    await unit.get(key);
    await unit.update(key, { status: 'fulfilled', processingAttemptId: commerceFieldValue.delete() });
    await unit.enqueueNotificationOutbox({ parentPath: key.path, family: 'stripe_terminal', dropId: 'drop',
      generation: crypto.randomUUID(), outcome: 'fulfilled', retryUntilMs: Date.now() + 60000,
      entries: [{ kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: 'drop:1:order_received', state: 'pending' }] });
  });
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_notification_outbox_stripe_due').get()!.count, 1);
  await repository.run(Date.now(), (unit) => unit.update(key, { status: 'fulfillment_pending' }));
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_notification_outbox_stripe_due').get()!.count, 0);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').get()!.count, 0);
});

test('checkout batches reject omitted typed-state writes and stale legacy writers without partial changes', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, { key, data: { status: 'created', updatedAt: 100 } });
  const guard = crypto.randomUUID();
  await assert.rejects(harness.db.batch([
    harness.db.prepare(`INSERT INTO commerce_commit_guards (guard_id, expectations_json, created_at_ms, stripe_checkout_paths_json)
      VALUES (?, '[]', 0, ?)`).bind(guard, JSON.stringify([key.path])),
    harness.db.prepare('UPDATE commerce_documents SET version = version + 1 WHERE document_path = ?').bind(key.path),
    harness.db.prepare('DELETE FROM commerce_commit_guards WHERE guard_id = ?').bind(guard),
  ]), /stripe checkout state commit is incomplete/);
  assert.equal(harness.database.prepare('SELECT version FROM commerce_documents WHERE document_path = ?').get(key.path)!.version, 1);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').get()!.count, 0);
  await assert.rejects(harness.db.prepare("UPDATE commerce_documents SET version = version + 1, document_json = json_set(document_json, '$.status', 'fulfilled') WHERE document_path = ?").bind(key.path).run(), /stripe checkout state is unavailable/);
  await assert.rejects(harness.db.prepare("UPDATE commerce_stripe_checkout_state SET status = 'fulfilled' WHERE document_path = ?").bind(key.path).run(), /stripe checkout state is unavailable/);
  await new D1CommerceRepository(harness.db).run(Date.now(), (unit) => unit.delete(key));
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_stripe_checkout_state').get()!.count, 0);
});

test('table-only checkout runtime rejects legacy mode without affecting ordinary document reads', async () => {
  const harness = createCommerceD1Harness({ stripeCheckoutStateMode: 'legacy' });
  seedCommerceDocument(harness, { key, data: { status: 'created', updatedAt: 100 } });
  const repository = new D1CommerceRepository(harness.db);
  await assert.rejects(repository.get(key), { code: 'unavailable' });
  await assert.rejects(repository.get(commerceKeys.stripeCheckout('drop', 'cs_absent')), { code: 'unavailable' });
  await assert.rejects(repository.queryManualReviewCheckouts({ dropId: 'drop', limit: 25 }), { code: 'unavailable' });
  await assert.rejects(repository.queryStaleStripeFulfillments(100), { code: 'unavailable' });
  await assert.rejects(repository.queryDueStripeTerminalNotifications(100), { code: 'unavailable' });
  const unit = await repository.begin(Date.now());
  await assert.rejects(unit.get(commerceKeys.stripeCheckout('drop', 'cs_absent')), { code: 'unavailable' });
  await assert.rejects(unit.getMany([commerceKeys.stripeCheckout('drop', 'cs_absent')]), { code: 'unavailable' });
  await assert.rejects(repository.run(Date.now(), (unit) => unit.create(commerceKeys.stripeCheckout('drop', 'cs_new'),
    { status: 'created', updatedAt: 100 })), { code: 'unavailable' });
  const other = commerceKeys.claimCode('CODE');
  await repository.run(Date.now(), (unit) => unit.create(other, { status: 'unclaimed' }));
  assert.equal((await repository.get(other))?.data.status, 'unclaimed');
});
