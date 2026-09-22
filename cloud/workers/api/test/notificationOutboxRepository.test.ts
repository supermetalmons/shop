import assert from 'node:assert/strict';
import test from 'node:test';
import { D1CommerceRepository, CommerceRepositoryError, CommerceWriteConflict, commerceKeys, commerceFieldValue } from '../src/commerceRepository.ts';
import { notificationOutboxDueQuery } from '../src/commerceQueries.ts';
import { createCommerceD1Harness, seedCommerceDocument, seedNotificationOutbox, type CommerceD1CallObservation } from './commerceD1Harness.ts';
import { parseNotificationOutboxRecord, shippedNotificationState, type NotificationOutboxCreate } from '../../../../shared/notificationOutbox.ts';
import { createNotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';

const key = commerceKeys.deliveryOrder('card_nft_2', '1');
const input = (): NotificationOutboxCreate => ({
  parentPath: key.path, family: 'shipped', dropId: 'card_nft_2', generation: crypto.randomUUID(),
  entries: [{ kind: 'buyer_order_shipped', jobId: crypto.randomUUID(), idempotencyKey: 'card_nft_2:1:order_shipped', state: 'pending' }],
  retryUntilMs: 10_000,
});

function fixture(context: test.TestContext, options: Parameters<typeof createCommerceD1Harness>[0] = {}) {
  const harness = createCommerceD1Harness(options);
  context.after(() => harness.database.close());
  seedCommerceDocument(harness, { key, data: { owner: 'wallet', status: 'ready_to_ship', fulfillmentStatus: 'Shipped' } });
  return { harness, repository: new D1CommerceRepository(harness.db) };
}

function seedShippedOutboxes(harness: ReturnType<typeof createCommerceD1Harness>, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const parentKey = commerceKeys.deliveryOrder('card_nft_2', String(index + 1));
    seedCommerceDocument(harness, { key: parentKey, version: 2, data: { status: 'ready_to_ship' } });
    const draft = input();
    const record = parseNotificationOutboxRecord({
      ...draft, parentPath: parentKey.path, outcome: null, state: 'pending', revision: 1,
      entries: [{ ...draft.entries[0], idempotencyKey: `card_nft_2:${index + 1}:order_shipped` }],
      attemptCount: 0, nextAttemptAtMs: 100, claimId: null, claimExpiresAtMs: null,
      createdAtMs: 100, updatedAtMs: 100, lastErrorCode: null,
    });
    seedNotificationOutbox(harness, record);
    return record;
  });
}

function isUnavailable(error: unknown): boolean {
  return error instanceof CommerceRepositoryError && error.code === 'unavailable';
}

function pause(harness: ReturnType<typeof createCommerceD1Harness>) {
  harness.database.exec(`INSERT INTO commerce_authority_control_lease VALUES (
    1, '123e4567-e89b-42d3-a456-426614174000',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
  );
  UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1;
  UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1;`);
}

test('outbox creation commits with its parent and preserves raw parent reads', async (context) => {
  const { harness, repository } = fixture(context);
  const draft = input();
  const created = await repository.run(100, async (unit) => {
    await unit.update(key, { fulfillmentTrackingCode: 'https://tracking.test/1' });
    return unit.enqueueNotificationOutbox(draft);
  });
  assert.equal(created.revision, 1);
  assert.deepEqual(await repository.notificationOutbox.get(key.path, 'shipped'), created);
  const parent = await repository.get(key);
  assert.equal(parent?.data.fulfillmentTrackingCode, 'https://tracking.test/1');
  assert.equal(parent?.data.buyerOrderShippedEmailState, undefined);
  await repository.run(200, async (unit) => {
    assert.equal((await unit.enqueueNotificationOutbox(input())).generation, draft.generation);
  });
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_notification_outbox').get()?.count, 1);
});

test('outbox conflict rolls back the complete business transaction', async (context) => {
  const { repository } = fixture(context);
  const original = await repository.run(100, (unit) => unit.enqueueNotificationOutbox(input()));
  const unit = await repository.begin(200);
  await unit.getNotificationOutbox(key.path, 'shipped');
  await unit.update(key, { status: 'changed' });
  await unit.replaceNotificationOutbox(input());
  assert.ok(await repository.notificationOutbox.compareAndSet({ expected: original, changes: { nextAttemptAtMs: 500 }, nowMs: 300 }));
  await assert.rejects(unit.commit(), CommerceWriteConflict);
  assert.equal((await repository.get(key))?.data.status, 'ready_to_ship');
  assert.equal((await repository.notificationOutbox.get(key.path, 'shipped'))?.generation, original.generation);
});

test('two competing claims have one winner without revising parent or maintenance document epochs', async (context) => {
  const { harness, repository } = fixture(context);
  const original = await repository.run(100, (unit) => unit.enqueueNotificationOutbox(input()));
  const snapshot = () => ({
    document: harness.database.prepare('SELECT version, update_time FROM commerce_documents WHERE document_path = ?').get(key.path),
    path: harness.database.prepare('SELECT revision FROM commerce_document_path_revisions WHERE document_path = ?').get(key.path),
    owner: harness.database.prepare('SELECT revision FROM commerce_delivery_owner_revisions WHERE owner = ?').get('wallet'),
    global: harness.database.prepare('SELECT documents_revision FROM commerce_authority_control').get(),
  });
  const before = snapshot();
  const claim = () => repository.notificationOutbox.compareAndSet({
    expected: original, nowMs: 200,
    changes: { claimId: crypto.randomUUID(), claimExpiresAtMs: 1000, nextAttemptAtMs: 1000, attemptCount: 1 },
  });
  const attempts = await Promise.all([claim(), claim()]);
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.deepEqual(snapshot(), before);
  const claimed = attempts.find(Boolean)!;
  assert.equal(await repository.notificationOutbox.compareAndSet({
    expected: claimed, nowMs: 300, parentVersion: 999, changes: { lastErrorCode: 'test' },
  }), null);
});

test('replacement and cancellation invalidate old publishers and keep a tombstone', async (context) => {
  const { repository } = fixture(context);
  const original = await repository.run(100, (unit) => unit.enqueueNotificationOutbox(input()));
  const replaced = await repository.run(200, (unit) => unit.replaceNotificationOutbox(input()));
  assert.equal(replaced.revision, 2);
  assert.equal(await repository.notificationOutbox.compareAndSet({ expected: original, changes: { nextAttemptAtMs: 999 }, nowMs: 300 }), null);
  const cancelled = await repository.run(300, (unit) => unit.cancelNotificationOutbox(key.path, 'shipped'));
  assert.equal(cancelled?.state, 'cancelled');
  assert.equal(shippedNotificationState(cancelled), undefined);
  assert.equal((await repository.run(400, (unit) => unit.enqueueNotificationOutbox(input()))).state, 'cancelled');
  assert.deepEqual(await repository.notificationOutbox.queryDue({ dueAtMs: 10_000, limit: 10 }), []);
});

test('saved publication snapshots cannot change while terminal transitions can remove payloads', async (context) => {
  const { repository } = fixture(context);
  const original = await repository.run(100, (unit) => unit.enqueueNotificationOutbox(input()));
  const entry = original.entries[0];
  const payload = createNotificationEmailJobV1({
    jobId: entry.jobId, kind: entry.kind, idempotencyKey: entry.idempotencyKey,
    recipients: ['buyer@example.com'], subject: 'Shipped', text: 'Your order shipped.', html: '<p>Your order shipped.</p>',
    context: { dropId: original.dropId, deliveryId: 1 },
  });
  const persisted = await repository.notificationOutbox.compareAndSet({
    expected: original, nowMs: 200, changes: { entries: [{ ...entry, payload }] },
  });
  assert.ok(persisted);
  await assert.rejects(repository.notificationOutbox.compareAndSet({
    expected: persisted, nowMs: 300, changes: { entries: [{ ...entry, payload: { ...payload, text: 'Changed' } }] },
  }), /immutable/);
  const queued = await repository.notificationOutbox.compareAndSet({
    expected: persisted, nowMs: 400,
    changes: { state: 'queued', entries: [{ ...entry, state: 'queued', queuedAtMs: 400 }], nextAttemptAtMs: null },
  });
  assert.equal(queued?.state, 'queued');
  assert.equal(queued?.entries[0].payload, undefined);
});

test('multiple staged changes to one outbox commit one revision', async (context) => {
  const { repository } = fixture(context);
  await repository.run(100, (unit) => unit.enqueueNotificationOutbox(input()));
  const replacement = input();
  await repository.run(200, async (unit) => {
    await unit.replaceNotificationOutbox(input());
    await unit.replaceNotificationOutbox(replacement);
    await unit.cancelNotificationOutbox(replacement.parentPath, replacement.family);
  });
  const stored = await repository.notificationOutbox.get(replacement.parentPath, replacement.family);
  assert.equal(stored?.generation, replacement.generation);
  assert.equal(stored?.revision, 2);
  assert.equal(stored?.state, 'cancelled');
});

test('legacy mode stays writable by old code but fails closed for table publishers', async (context) => {
  const { repository } = fixture(context, { notificationOutboxMode: 'legacy' });
  await repository.run(100, (unit) => unit.update(key, { buyerOrderShippedEmailState: 'pending' }));
  await assert.rejects(repository.notificationOutbox.get(key.path, 'shipped'), /unavailable/);
  await assert.rejects(repository.notificationOutbox.getMany([key.path], 'shipped'), isUnavailable);
  await assert.rejects(repository.run(100, (unit) => unit.enqueueNotificationOutbox(input())), /unavailable/);
});

test('activated legacy fences preserve frozen fields but reject changed or new legacy markers', async (context) => {
  const { harness, repository } = fixture(context);
  seedCommerceDocument(harness, { key, version: 2, data: { buyerOrderShippedEmailState: 'pending', status: 'ready_to_ship' } });
  await repository.run(100, (unit) => unit.update(key, { fulfillmentTrackingCode: 'tracking' }));
  await assert.rejects(repository.run(200, (unit) => unit.update(key, { buyerOrderShippedEmailState: 'queued' })), /legacy notification writes/);
  await assert.rejects(repository.run(200, (unit) => unit.create(commerceKeys.deliveryOrder('card_nft_2', '2'), {
    buyerOrderShippedEmailState: 'pending',
  })), /legacy notification writes/);
});

test('paused authority blocks publishers; a leased maintenance parent delete cascades outbox rows', async (context) => {
  const { harness, repository } = fixture(context);
  const original = await repository.run(100, (unit) => unit.enqueueNotificationOutbox(input()));
  assert.throws(() => harness.database.prepare('DELETE FROM commerce_notification_outbox WHERE parent_path = ?').run(key.path), /maintenance/);
  pause(harness);
  await assert.rejects(repository.notificationOutbox.get(key.path, 'shipped'), /unavailable/);
  await assert.rejects(repository.notificationOutbox.getMany([key.path], 'shipped'), isUnavailable);
  await assert.rejects(repository.notificationOutbox.compareAndSet({ expected: original, nowMs: 300, changes: { nextAttemptAtMs: 500 } }), /unavailable/);
  harness.database.prepare('DELETE FROM commerce_documents WHERE document_path = ?').run(key.path);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_notification_outbox').get()?.count, 0);
});

test('preparation blocks resume until activation and activation is irreversible', (context) => {
  const { harness } = fixture(context, { notificationOutboxMode: 'legacy' });
  pause(harness);
  harness.database.exec("UPDATE commerce_notification_outbox_control SET preparation_state = 'preparing'");
  const resume = `UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
    paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000`;
  assert.throws(() => harness.database.exec(resume), /cutover is incomplete/);
  assert.throws(() => harness.database.exec("UPDATE commerce_notification_outbox_control SET storage_mode = 'table'"), /preparation is incomplete/);
  harness.database.exec(`UPDATE commerce_notification_outbox_control SET preparation_state = 'ready',
    source_documents_revision = (SELECT documents_revision FROM commerce_authority_control), prepared_at_ms = 1`);
  assert.throws(() => harness.database.exec(resume), /cutover is incomplete/);
  harness.database.exec("UPDATE commerce_notification_outbox_control SET storage_mode = 'table'");
  assert.throws(() => harness.database.exec("UPDATE commerce_notification_outbox_control SET storage_mode = 'legacy'"), /irreversible/);
  harness.database.exec(resume);
});

test('due queries read only active rows and use the due index', async (context) => {
  const { harness, repository } = fixture(context);
  const original = await repository.run(100, (unit) => unit.enqueueNotificationOutbox(input()));
  assert.deepEqual(await repository.notificationOutbox.getMany([key.path, key.path], 'shipped'), [original]);
  assert.deepEqual(await repository.notificationOutbox.queryDue({ family: 'shipped', dueAtMs: original.nextAttemptAtMs!, limit: 1 }), [original]);
  const query = notificationOutboxDueQuery({ family: 'shipped', dueAtMs: 100, limit: 1 });
  const plan = harness.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings);
  assert.match(JSON.stringify(plan), /commerce_notification_outbox_family_due/);
  assert.throws(() => seedNotificationOutbox(harness, parseNotificationOutboxRecord({ ...original, entries: [] })), /Invalid/);
});

for (const count of [50, 51, 101, 1000]) {
  test(`getMany reads ${count} outboxes in one authority-checked batch`, async (context) => {
    const calls: CommerceD1CallObservation[] = [];
    const { harness, repository } = fixture(context, { observeCall: (call) => calls.push(call) });
    const expected = seedShippedOutboxes(harness, count);
    const actual = await repository.notificationOutbox.getMany(expected.map((record) => record.parentPath), 'shipped');
    const byPath = (left: typeof expected[number], right: typeof expected[number]) => left.parentPath.localeCompare(right.parentPath);
    assert.deepEqual(actual.sort(byPath), expected.sort(byPath));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'batch');
    if (calls[0].method !== 'batch') assert.fail('Expected one D1 batch call.');
    assert.equal(calls[0].statements.length, Math.ceil(count / 50) + 1);
    assert.match(calls[0].statements[0].sql, /FROM commerce_authority_control/);
    for (const [index, statement] of calls[0].statements.slice(1).entries()) {
      assert.equal((statement.sql.match(/\?/g) || []).length, Math.min(50, count - index * 50) + 1);
    }
  });
}

test('getMany deduplicates across chunks and excludes missing and other-family outboxes', async (context) => {
  const calls: CommerceD1CallObservation[] = [];
  const { harness, repository } = fixture(context, { observeCall: (call) => calls.push(call) });
  const expected = seedShippedOutboxes(harness, 51);
  const missingKey = commerceKeys.deliveryOrder('card_nft_2', '52');
  const readyKey = commerceKeys.deliveryOrder('card_nft_2', '53');
  for (const parentKey of [missingKey, readyKey]) {
    seedCommerceDocument(harness, { key: parentKey, data: { status: 'ready_to_ship' } });
  }
  seedNotificationOutbox(harness, {
    ...expected[0], parentPath: readyKey.path, family: 'ready', entries: [{
      kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: 'card_nft_2:53:order_received', state: 'pending',
    }],
  });
  const paths = expected.map((record) => record.parentPath);
  const actual = await repository.notificationOutbox.getMany([...paths, missingKey.path, readyKey.path, ...paths], 'shipped');
  assert.deepEqual(actual.map((record) => record.parentPath).sort(), paths.sort());
  assert.ok(actual.every((record) => record.family === 'shipped'));
  assert.equal(calls.length, 1);
  if (calls[0].method !== 'batch') assert.fail('Expected one D1 batch call.');
  assert.equal(calls[0].statements.length, 3);
});

test('getMany skips D1 for empty input', async (context) => {
  const calls: CommerceD1CallObservation[] = [];
  const { repository } = fixture(context, { observeCall: (call) => calls.push(call) });
  assert.deepEqual(await repository.notificationOutbox.getMany([], 'shipped'), []);
  assert.deepEqual(calls, []);
});

test('getMany rejects incomplete or malformed batches without returning partial outboxes', async (context) => {
  const { harness } = fixture(context);
  const paths = seedShippedOutboxes(harness, 51).map((record) => record.parentPath);
  const cases: Array<[string, (results: D1Result<Record<string, unknown>>[]) => unknown]> = [
    ['failed later result', (results) => [...results.slice(0, -1), { ...results.at(-1), success: false }]],
    ['malformed later rows', (results) => [...results.slice(0, -1), { ...results.at(-1), results: null }]],
    ['null later result', (results) => [...results.slice(0, -1), null]],
    ['missing result', (results) => results.slice(0, -1)],
    ['extra result', (results) => [...results, results.at(-1)]],
    ['non-array batch', () => null],
  ];
  for (const [name, corrupt] of cases) {
    await context.test(name, async () => {
      const db = new Proxy(harness.db, {
        get(target, property, receiver) {
          if (property === 'batch') return async (statements: D1PreparedStatement[]) =>
            corrupt(await target.batch<Record<string, unknown>>(statements));
          return Reflect.get(target, property, receiver);
        },
      });
      await assert.rejects(new D1CommerceRepository(db).notificationOutbox.getMany(paths, 'shipped'), isUnavailable);
    });
  }
});

test('pending-owner lookup tracks source eligibility and outbox state without revising outboxes', async (context) => {
  const { harness, repository } = fixture(context);
  const draft: NotificationOutboxCreate = { ...input(), family: 'ready', entries: [{
    kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: 'card_nft_2:1:order_received', state: 'pending',
  }] };
  const original = await repository.run(100, (unit) => unit.enqueueNotificationOutbox(draft));
  const owners = () => harness.database.prepare('SELECT owner FROM commerce_notification_outbox_pending_owners ORDER BY owner').all().map((row) => row.owner);
  assert.deepEqual(owners(), ['wallet']);
  await repository.run(200, (unit) => unit.update(key, { owner: 'second-owner' }));
  assert.deepEqual(owners(), ['second-owner']);
  assert.deepEqual(await repository.notificationOutbox.get(key.path, 'ready'), original);
  assert.deepEqual(await repository.queryPendingReadyNotifications({ owner: 'wallet', limit: 8 }), []);
  assert.equal((await repository.queryPendingReadyNotifications({ owner: 'second-owner', limit: 8 })).length, 1);
  await repository.run(300, (unit) => unit.update(key, { status: 'processing' }));
  assert.deepEqual(owners(), []);
  await repository.run(400, (unit) => unit.update(key, { status: 'ready_to_ship' }));
  assert.deepEqual(owners(), ['second-owner']);
  await repository.run(500, (unit) => unit.update(key, { owner: null }));
  assert.deepEqual(owners(), []);
  await repository.run(600, (unit) => unit.update(key, { owner: 'wallet' }));
  const changes = Number(harness.database.prepare('SELECT total_changes() AS count').get()!.count);
  const claimed = await repository.notificationOutbox.compareAndSet({ expected: original, nowMs: 700,
    changes: { claimId: crypto.randomUUID(), claimExpiresAtMs: 1_000, nextAttemptAtMs: 1_000, attemptCount: 1 } });
  assert.ok(claimed);
  assert.equal(Number(harness.database.prepare('SELECT total_changes() AS count').get()!.count) - changes, 1);
  await repository.notificationOutbox.compareAndSet({ expected: claimed, nowMs: 800,
    changes: { state: 'queued', entries: claimed.entries.map((entry) => ({ ...entry, state: 'queued', queuedAtMs: 800 })),
      claimId: null, claimExpiresAtMs: null, nextAttemptAtMs: null } });
  assert.deepEqual(owners(), []);
  await repository.run(900, (unit) => unit.replaceNotificationOutbox({ ...draft, generation: crypto.randomUUID() }));
  assert.deepEqual(owners(), ['wallet']);
  await repository.run(1_000, (unit) => unit.cancelNotificationOutbox(key.path, 'ready'));
  assert.deepEqual(owners(), []);
});

for (const sourceFirst of [false, true]) {
  test(`owner transfer and outbox replacement commit together with one revision (${sourceFirst ? 'source' : 'outbox'} first)`, async (context) => {
    const { harness, repository } = fixture(context);
    const draft: NotificationOutboxCreate = { ...input(), family: 'ready', entries: [{
      kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: 'card_nft_2:1:order_received', state: 'pending',
    }] };
    await repository.run(100, (unit) => unit.enqueueNotificationOutbox(draft));
    await repository.run(200, async (unit) => {
      if (sourceFirst) await unit.update(key, { owner: 'new-owner' });
      await unit.replaceNotificationOutbox({ ...draft, generation: crypto.randomUUID() });
      if (!sourceFirst) await unit.update(key, { owner: 'new-owner' });
    });
    assert.equal((await repository.notificationOutbox.get(key.path, 'ready'))?.revision, 2);
    assert.deepEqual(harness.database.prepare('SELECT owner FROM commerce_notification_outbox_pending_owners').all().map((row) => row.owner), ['new-owner']);
  });
}

const stripeNow = 1_800_000_000_000;

async function stripeDueFixture(context: test.TestContext, status = 'fulfillment_pending') {
  const { harness, repository } = fixture(context);
  const checkoutKey = commerceKeys.stripeCheckout('card_nft_2', 'cs_due_transition');
  seedCommerceDocument(harness, { key: checkoutKey, data: { status, manualRefundReviewRequired: true } });
  const jobId = crypto.randomUUID();
  const idempotencyKey = 'card_nft_2:cs_due_transition:stripe_manual_review';
  const draft: NotificationOutboxCreate = {
    parentPath: checkoutKey.path, family: 'stripe_terminal', dropId: 'card_nft_2', outcome: 'manual_review',
    generation: crypto.randomUUID(), retryUntilMs: stripeNow + 10_000,
    entries: [{ kind: 'stripe_checkout_manual_review', jobId, idempotencyKey, state: 'pending',
      payload: createNotificationEmailJobV1({ jobId, kind: 'stripe_checkout_manual_review', idempotencyKey,
        recipients: ['review@example.com'], subject: 'Review required', text: 'Saved review', html: '<p>Saved review</p>',
        context: { dropId: 'card_nft_2', sessionId: checkoutKey.documentId } }) }],
  };
  const created = await repository.run(stripeNow, (unit) => unit.enqueueNotificationOutbox(draft));
  const original = await repository.notificationOutbox.compareAndSet({ expected: created, nowMs: stripeNow + 1,
    changes: { attemptCount: 2, claimId: crypto.randomUUID(), claimExpiresAtMs: stripeNow + 100, nextAttemptAtMs: stripeNow + 100 } });
  assert.ok(original);
  const dueRows = () => harness.database.prepare(`SELECT parent_path, family, next_attempt_at_ms
    FROM commerce_notification_outbox_stripe_due ORDER BY parent_path`).all().map((row) => ({ ...row }));
  return { harness, repository, checkoutKey, draft, original, dueRows };
}

test('Stripe due lookup follows source eligibility without changing publication snapshots or budgets', async (context) => {
  const { repository, checkoutKey, original, dueRows } = await stripeDueFixture(context);
  assert.deepEqual(dueRows(), []);
  for (const [updates, eligible] of [
    [{ status: 'fulfillment_failed' }, true],
    [{ manualRefundReviewRequired: false }, false],
    [{ manualRefundReviewRequired: commerceFieldValue.delete() }, false],
    [{ manualRefundReviewRequired: true }, true],
    [{ status: 'processing' }, false],
    [{ status: 'fulfilled' }, false],
    [{ status: 'fulfillment_failed' }, true],
  ] as const) {
    await repository.run(stripeNow + 10, (unit) => unit.update(checkoutKey, updates));
    assert.deepEqual(dueRows(), eligible ? [{ parent_path: checkoutKey.path, family: 'stripe_terminal', next_attempt_at_ms: stripeNow + 100 }] : []);
    assert.deepEqual(await repository.notificationOutbox.get(checkoutKey.path, 'stripe_terminal'), original);
    assert.deepEqual((await repository.queryDueStripeTerminalNotifications(stripeNow + 100)).map((row) => row.key.path), eligible ? [checkoutKey.path] : []);
  }
  const parent = await repository.get(checkoutKey);
  const updated = await repository.notificationOutbox.compareAndSet({ expected: original, nowMs: stripeNow + 20,
    changes: { claimExpiresAtMs: stripeNow + 200, nextAttemptAtMs: stripeNow + 200 } });
  assert.ok(updated);
  assert.deepEqual(dueRows(), [{ parent_path: checkoutKey.path, family: 'stripe_terminal', next_attempt_at_ms: stripeNow + 200 }]);
  assert.deepEqual(await repository.queryDueStripeTerminalNotifications(stripeNow + 100), []);
  assert.equal((await repository.queryDueStripeTerminalNotifications(stripeNow + 200)).length, 1);
  assert.deepEqual(await repository.get(checkoutKey), parent);
  assert.deepEqual(updated.entries, original.entries);
  assert.equal(updated.attemptCount, original.attemptCount);
  assert.equal(updated.retryUntilMs, original.retryUntilMs);
  const exhausted = await repository.notificationOutbox.compareAndSet({ expected: updated, nowMs: stripeNow + 21,
    changes: { attemptCount: 4, retryUntilMs: stripeNow - 1 } });
  assert.ok(exhausted);
  assert.equal((await repository.queryDueStripeTerminalNotifications(stripeNow + 200)).length, 1);
  await repository.run(stripeNow + 22, (unit) => unit.update(checkoutKey, { status: 'processing' }));
  await repository.run(stripeNow + 23, (unit) => unit.update(checkoutKey, { status: 'fulfillment_failed' }));
  assert.deepEqual(await repository.notificationOutbox.get(checkoutKey.path, 'stripe_terminal'), exhausted);
  assert.equal((await repository.queryDueStripeTerminalNotifications(stripeNow + 200)).length, 1);
});

test('Stripe due lookup follows an outcome replacement while source fields stay unchanged', async (context) => {
  const { repository, checkoutKey, draft, dueRows } = await stripeDueFixture(context, 'fulfilled');
  assert.deepEqual(dueRows(), []);
  const parent = await repository.get(checkoutKey);
  const fulfilled = await repository.run(stripeNow + 20, (unit) => unit.replaceNotificationOutbox({
    ...draft, generation: crypto.randomUUID(), outcome: 'fulfilled', entries: [{
      kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: 'card_nft_2:1:order_received', state: 'pending',
    }],
  }));
  assert.deepEqual(dueRows(), [{ parent_path: checkoutKey.path, family: 'stripe_terminal', next_attempt_at_ms: fulfilled.nextAttemptAtMs }]);
  assert.deepEqual(await repository.get(checkoutKey), parent);
  assert.equal((await repository.queryDueStripeTerminalNotifications(stripeNow + 20)).length, 1);
});

for (const sourceFirst of [false, true]) {
  test(`Stripe source and outbox replacement update due eligibility atomically (${sourceFirst ? 'source' : 'outbox'} first)`, async (context) => {
    const { repository, checkoutKey, draft, dueRows } = await stripeDueFixture(context);
    await repository.run(stripeNow + 20, async (unit) => {
      if (sourceFirst) await unit.update(checkoutKey, { status: 'fulfilled' });
      await unit.replaceNotificationOutbox({ ...draft, outcome: 'fulfilled', generation: crypto.randomUUID(), entries: [{
        kind: 'buyer_order_received', jobId: crypto.randomUUID(), idempotencyKey: 'card_nft_2:1:order_received', state: 'pending',
      }] });
      if (!sourceFirst) await unit.update(checkoutKey, { status: 'fulfilled' });
    });
    const stored = await repository.notificationOutbox.get(checkoutKey.path, 'stripe_terminal');
    assert.equal(stored?.revision, 3);
    assert.deepEqual(dueRows(), [{ parent_path: checkoutKey.path, family: 'stripe_terminal', next_attempt_at_ms: stripeNow + 20 }]);
    assert.equal((await repository.queryDueStripeTerminalNotifications(stripeNow + 20)).length, 1);
  });
}

for (const terminal of ['queued', 'failed', 'cancelled', 'deleted'] as const) {
  test(`Stripe ${terminal} publication removes due lookup state`, async (context) => {
    const { harness, repository, checkoutKey, original, dueRows } = await stripeDueFixture(context, 'fulfillment_failed');
    assert.equal(dueRows().length, 1);
    if (terminal === 'cancelled') await repository.run(stripeNow + 20, (unit) => unit.cancelNotificationOutbox(checkoutKey.path, 'stripe_terminal'));
    else if (terminal === 'deleted') {
      pause(harness);
      harness.database.prepare('DELETE FROM commerce_documents WHERE document_path = ?').run(checkoutKey.path);
      assert.deepEqual(harness.database.prepare('PRAGMA foreign_key_check').all(), []);
    } else {
      await repository.notificationOutbox.compareAndSet({ expected: original, nowMs: stripeNow + 20,
        changes: { state: terminal, entries: original.entries.map(({ payload, ...entry }) => ({
          ...entry, state: terminal, ...(terminal === 'failed' ? { payload } : { queuedAtMs: stripeNow + 20 }),
        })), nextAttemptAtMs: null, claimId: null, claimExpiresAtMs: null } });
    }
    assert.deepEqual(dueRows(), []);
  });
}

test('failed Stripe transaction cannot leave a due lookup detached from source state', async (context) => {
  const { repository, checkoutKey, original, draft, dueRows } = await stripeDueFixture(context);
  const unit = await repository.begin(stripeNow + 20);
  await unit.getNotificationOutbox(checkoutKey.path, 'stripe_terminal');
  await unit.update(checkoutKey, { status: 'fulfillment_failed' });
  await unit.replaceNotificationOutbox({ ...draft, generation: crypto.randomUUID() });
  await repository.notificationOutbox.compareAndSet({ expected: original, nowMs: stripeNow + 21,
    changes: { lastErrorCode: 'concurrent-publisher' } });
  await assert.rejects(unit.commit(), CommerceWriteConflict);
  assert.equal((await repository.get(checkoutKey))?.data.status, 'fulfillment_pending');
  assert.deepEqual(dueRows(), []);
});
