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

for (const useSnapshot of [false, true]) {
  test(`claiming ${useSnapshot ? 'with' : 'without'} a snapshot preserves the claim and retry budget`, async (context) => {
    const fixture = await notificationFixture(context, 'ready');
    const initialRecord = await fixture.read();
    const get = context.mock.method(fixture.repository.notificationOutbox, 'get');
    const compareAndSet = context.mock.method(fixture.repository.notificationOutbox, 'compareAndSet');
    const result = await claimNotificationOutbox({
      repository: fixture.repository, parentPath: fixture.parentKey.path, family: 'ready', nowMs: fixture.nowMs,
      ...(useSnapshot ? { initialRecord } : {}),
    });
    assert.equal(result.outcome, 'claimed');
    if (result.outcome !== 'claimed') throw new Error('Expected notification claim.');
    assert.equal(get.mock.callCount(), useSnapshot ? 0 : 1);
    assert.equal(compareAndSet.mock.callCount(), 1);
    assert.equal(result.previousAttemptCount, initialRecord.attemptCount);
    assert.equal(result.claim.attemptCount, initialRecord.attemptCount + 1);
    assert.equal(result.claim.generation, initialRecord.generation);
    assert.deepEqual(await fixture.read(), result.claim);
  });
}

for (const field of ['parentPath', 'family'] as const) {
  test(`claiming rejects a snapshot with the wrong ${field} before accessing the database`, async (context) => {
    const fixture = await notificationFixture(context, 'ready');
    const initialRecord = await fixture.read();
    const get = context.mock.method(fixture.repository.notificationOutbox, 'get');
    const compareAndSet = context.mock.method(fixture.repository.notificationOutbox, 'compareAndSet');
    await assert.rejects(claimNotificationOutbox({
      repository: fixture.repository, parentPath: fixture.parentKey.path, family: 'ready', nowMs: fixture.nowMs,
      initialRecord: { ...initialRecord, ...(field === 'parentPath' ? { parentPath: 'other' } : { family: 'shipped' as const }) },
    }), /snapshot_identity_invalid/);
    assert.equal(get.mock.callCount(), 0);
    assert.equal(compareAndSet.mock.callCount(), 0);
  });
}

for (const transition of ['claimed', 'cancelled', 'replaced', 'exhausted'] as const) {
  test(`a stale initial snapshot refreshes an outbox that was ${transition}`, async (context) => {
    const fixture = await notificationFixture(context, 'ready');
    const initialRecord = await fixture.read();
    const args = {
      repository: fixture.repository, parentPath: fixture.parentKey.path, family: 'ready' as const, nowMs: fixture.nowMs,
    };
    if (transition === 'claimed') {
      await claimNotificationOutbox(args);
    } else if (transition === 'cancelled') {
      await fixture.repository.run(fixture.nowMs(), (unit) => unit.cancelNotificationOutbox(fixture.parentKey.path, 'ready'));
    } else if (transition === 'replaced') {
      await fixture.repository.run(fixture.nowMs(), (unit) => unit.replaceNotificationOutbox({
        ...fixture.intent, generation: crypto.randomUUID(),
      }));
    } else {
      await fixture.mutate({ attemptCount: 4 });
    }
    const before = await fixture.read();
    const get = context.mock.method(fixture.repository.notificationOutbox, 'get');
    const compareAndSet = context.mock.method(fixture.repository.notificationOutbox, 'compareAndSet');
    const result = await claimNotificationOutbox({ ...args, initialRecord });
    assert.equal(get.mock.callCount(), 1);
    assert.equal(compareAndSet.mock.callCount(), transition === 'claimed' || transition === 'cancelled' ? 1 : 2);
    if (transition === 'replaced') {
      assert.equal(result.outcome, 'claimed');
      if (result.outcome !== 'claimed') throw new Error('Expected notification claim.');
      assert.equal(result.claim.generation, before.generation);
      assert.notEqual(result.claim.generation, initialRecord.generation);
      assert.deepEqual(result.claim.entries, before.entries);
    } else if (transition === 'exhausted') {
      assert.equal(result.outcome, 'failed');
      const stored = await fixture.read();
      assert.equal(stored.state, 'failed');
      assert.equal(stored.attemptCount, 4);
      assert.equal(stored.claimId, null);
    } else {
      assert.equal(result.outcome, transition === 'claimed' ? 'busy' : 'none');
      assert.deepEqual(await fixture.read(), before);
    }
  });
}

test('initial snapshots retain parent-version fencing and the six-attempt limit', async (context) => {
  const fixture = await notificationFixture(context, 'ready');
  const parent = await fixture.repository.get(fixture.parentKey);
  assert.ok(parent);
  const initialRecord = await fixture.read();
  await fixture.updateOrder({ unrelated: true });
  const get = context.mock.method(fixture.repository.notificationOutbox, 'get');
  const compareAndSet = context.mock.method(fixture.repository.notificationOutbox, 'compareAndSet');
  const result = await claimNotificationOutbox({
    repository: fixture.repository, parentPath: fixture.parentKey.path, family: 'ready', nowMs: fixture.nowMs,
    initialRecord, parentVersion: parent.version,
  });
  assert.equal(result.outcome, 'busy');
  assert.equal(compareAndSet.mock.callCount(), 6);
  assert.equal(get.mock.callCount(), 6);
  assert.ok(compareAndSet.mock.calls.every((call) => call.arguments[0].parentVersion === parent.version));
  assert.deepEqual(await fixture.read(), initialRecord);
});

for (const abortAt of ['start', 'conflict'] as const) {
  test(`snapshot claiming stops when cancelled at ${abortAt}`, async (context) => {
    const fixture = await notificationFixture(context, 'ready');
    const initialRecord = await fixture.read();
    const controller = new AbortController();
    const reason = new Error('request-cancelled');
    const get = context.mock.method(fixture.repository.notificationOutbox, 'get');
    const compareAndSet = context.mock.method(fixture.repository.notificationOutbox, 'compareAndSet', async () => {
      controller.abort(reason);
      return null;
    });
    if (abortAt === 'start') controller.abort(reason);
    await assert.rejects(claimNotificationOutbox({
      repository: fixture.repository, parentPath: fixture.parentKey.path, family: 'ready', nowMs: fixture.nowMs,
      initialRecord, signal: controller.signal,
    }), (error) => error === reason);
    assert.equal(get.mock.callCount(), 0);
    assert.equal(compareAndSet.mock.callCount(), abortAt === 'start' ? 0 : 1);
    assert.deepEqual(await fixture.read(), initialRecord);
  });
}

for (const operation of ['write', 'refresh'] as const) {
  test(`snapshot claiming propagates database ${operation} failures without retrying them`, async (context) => {
    const fixture = await notificationFixture(context, 'ready');
    const initialRecord = await fixture.read();
    const failure = new Error('database-unavailable');
    const get = context.mock.method(fixture.repository.notificationOutbox, 'get', async () => { throw failure; });
    const compareAndSet = context.mock.method(fixture.repository.notificationOutbox, 'compareAndSet', async () => {
      if (operation === 'write') throw failure;
      return null;
    });
    await assert.rejects(claimNotificationOutbox({
      repository: fixture.repository, parentPath: fixture.parentKey.path, family: 'ready', nowMs: fixture.nowMs, initialRecord,
    }), (error) => error === failure);
    assert.equal(compareAndSet.mock.callCount(), 1);
    assert.equal(get.mock.callCount(), operation === 'write' ? 0 : 1);
  });
}

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
