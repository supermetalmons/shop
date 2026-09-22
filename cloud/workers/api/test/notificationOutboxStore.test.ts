import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import {
  claimNotificationOutbox,
  markClaimedNotificationQueued,
  persistClaimedNotificationJobs,
  updateClaimedNotificationOutbox,
} from '../src/notificationOutboxStore.ts';
import { notificationFixture } from './notificationOutboxTestSupport.ts';

async function claimedFixture(context: test.TestContext) {
  const fixture = await notificationFixture(context, 'ready');
  const claimed = await claimNotificationOutbox({
    repository: fixture.repository, parentPath: fixture.parentKey.path, family: 'ready', nowMs: fixture.nowMs,
  });
  assert.equal(claimed.outcome, 'claimed');
  if (claimed.outcome !== 'claimed') throw new Error('Expected notification claim.');
  const jobs = claimed.claim.entries.map((entry) => createNotificationEmailJobV1({
    jobId: entry.jobId, kind: entry.kind, idempotencyKey: entry.idempotencyKey,
    recipients: ['buyer@example.com'], subject: 'Order ready', text: 'Your order is ready.', html: '<p>Your order is ready.</p>',
    context: { dropId: fixture.intent.dropId, deliveryId: 7 },
  }));
  const observe = () => ({
    get: context.mock.method(fixture.repository.notificationOutbox, 'get'),
    compareAndSet: context.mock.method(fixture.repository.notificationOutbox, 'compareAndSet'),
  });
  return { ...fixture, claim: claimed.claim, jobs, observe };
}

test('claimed updates use the supplied snapshot without reading before a successful write', async (context) => {
  const fixture = await claimedFixture(context);
  const { get, compareAndSet } = fixture.observe();
  const updated = await persistClaimedNotificationJobs(fixture);
  assert.ok(updated);
  assert.equal(updated.revision, fixture.claim.revision + 1);
  assert.deepEqual(updated.entries.map((entry) => entry.payload), fixture.jobs);
  assert.equal(get.mock.callCount(), 0);
  assert.equal(compareAndSet.mock.callCount(), 1);
  assert.deepEqual(await fixture.read(), updated);
});

test('a same-claim conflict preserves another publisher entry update when replanning', async (context) => {
  const fixture = await claimedFixture(context);
  const persisted = await persistClaimedNotificationJobs(fixture);
  assert.ok(persisted);
  const buyerQueued = await markClaimedNotificationQueued({ ...fixture, claim: persisted, jobs: [fixture.jobs[0]] });
  assert.ok(buyerQueued);
  fixture.setTime(fixture.nowMs() + 1);
  const { get, compareAndSet } = fixture.observe();
  const queued = await markClaimedNotificationQueued({ ...fixture, claim: persisted, jobs: [fixture.jobs[1]] });
  assert.ok(queued);
  assert.equal(queued.state, 'queued');
  assert.deepEqual(queued.entries[0], buyerQueued.entries[0]);
  assert.equal(queued.entries[1].state, 'queued');
  assert.equal(queued.entries[1].queuedAtMs, fixture.nowMs());
  assert.equal(queued.claimId, null);
  assert.equal(queued.revision, buyerQueued.revision + 1);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(compareAndSet.mock.callCount(), 2);
  assert.deepEqual(await fixture.read(), queued);
});

test('marking queued accepts a pre-persist claim after refreshing its missing payload snapshot', async (context) => {
  const fixture = await claimedFixture(context);
  const persisted = await persistClaimedNotificationJobs(fixture);
  assert.ok(persisted);
  const { get, compareAndSet } = fixture.observe();
  const queued = await markClaimedNotificationQueued(fixture);
  assert.ok(queued);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.revision, persisted.revision + 1);
  assert.ok(queued.entries.every((entry) => entry.state === 'queued' && entry.payload === undefined));
  assert.equal(get.mock.callCount(), 1);
  assert.equal(compareAndSet.mock.callCount(), 1);
  assert.deepEqual(await fixture.read(), queued);
});

for (const transition of ['cancelled', 'replaced', 'reclaimed', 'released', 'queued', 'deleted'] as const) {
  test(`a stale claim cannot update an outbox that was ${transition}`, async (context) => {
    const fixture = await claimedFixture(context);
    if (transition === 'cancelled') {
      await fixture.repository.run(fixture.nowMs(), (unit) => unit.cancelNotificationOutbox(fixture.parentKey.path, 'ready'));
    } else if (transition === 'replaced') {
      await fixture.repository.run(fixture.nowMs(), (unit) => unit.replaceNotificationOutbox({
        ...fixture.intent, generation: crypto.randomUUID(),
      }));
    } else if (transition === 'reclaimed') {
      await fixture.mutate({ claimId: crypto.randomUUID() });
    } else if (transition === 'released') {
      await fixture.mutate({ claimId: null, claimExpiresAtMs: null, nextAttemptAtMs: fixture.nowMs() });
    } else if (transition === 'queued') {
      const persisted = await persistClaimedNotificationJobs(fixture);
      assert.ok(persisted);
      await markClaimedNotificationQueued({ ...fixture, claim: persisted });
    } else {
      fixture.harness.database.exec(`INSERT INTO commerce_authority_control_lease VALUES (
        1, '123e4567-e89b-42d3-a456-426614174000',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000
      );
      UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1;
      UPDATE commerce_authority_control SET paused_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1;
      DELETE FROM commerce_documents;
      UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1;
      DELETE FROM commerce_authority_control_lease;`);
    }
    const before = await fixture.repository.notificationOutbox.get(fixture.parentKey.path, 'ready');
    const { get, compareAndSet } = fixture.observe();
    assert.equal(await updateClaimedNotificationOutbox({ ...fixture, update: () => ({ lastErrorCode: 'stale-publisher' }) }), null);
    assert.equal(get.mock.callCount(), 1);
    assert.equal(compareAndSet.mock.callCount(), 1);
    assert.deepEqual(await fixture.repository.notificationOutbox.get(fixture.parentKey.path, 'ready'), before);
  });
}

test('parent-version conflicts exhaust six writes and five refreshes without changing the outbox', async (context) => {
  const fixture = await claimedFixture(context);
  const { get, compareAndSet } = fixture.observe();
  assert.equal(await updateClaimedNotificationOutbox({
    ...fixture, parentVersion: 999, update: () => ({ lastErrorCode: 'must-not-write' }),
  }), null);
  assert.equal(compareAndSet.mock.callCount(), 6);
  assert.equal(get.mock.callCount(), 5);
  assert.ok(compareAndSet.mock.calls.every((call) => call.arguments[0].parentVersion === 999));
  assert.deepEqual(await fixture.read(), fixture.claim);
});

test('a callback failure refreshes once and propagates the fresh failure without writing', async (context) => {
  const fixture = await claimedFixture(context);
  const { get, compareAndSet } = fixture.observe();
  const initialError = new Error('stale-snapshot');
  const freshError = new Error('invalid-fresh-snapshot');
  let updates = 0;
  await assert.rejects(updateClaimedNotificationOutbox({
    ...fixture,
    update: () => { throw ++updates === 1 ? initialError : freshError; },
  }), (error) => error === freshError);
  assert.equal(updates, 2);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(compareAndSet.mock.callCount(), 0);
  assert.deepEqual(await fixture.read(), fixture.claim);
});

test('a snapshot callback failure stops quietly when its refreshed claim was cancelled', async (context) => {
  const fixture = await claimedFixture(context);
  await fixture.repository.run(fixture.nowMs(), (unit) => unit.cancelNotificationOutbox(fixture.parentKey.path, 'ready'));
  const { get, compareAndSet } = fixture.observe();
  assert.equal(await markClaimedNotificationQueued(fixture), null);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(compareAndSet.mock.callCount(), 0);
});

for (const operation of ['write', 'refresh'] as const) {
  test(`a database ${operation} failure propagates without retries`, async (context) => {
    const fixture = await claimedFixture(context);
    const failure = new Error('database-unavailable');
    const batch = context.mock.method(fixture.harness.db, 'batch', async () => { throw failure; });
    const { get, compareAndSet } = fixture.observe();
    await assert.rejects(updateClaimedNotificationOutbox({
      ...fixture,
      update: () => {
        if (operation === 'refresh') throw new Error('refresh-required');
        return { lastErrorCode: 'must-not-write' };
      },
    }), (error) => error === failure);
    assert.equal(batch.mock.callCount(), 1);
    assert.equal(get.mock.callCount(), Number(operation === 'refresh'));
    assert.equal(compareAndSet.mock.callCount(), Number(operation === 'write'));
  });
}
