import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { parseReceiptClaimFailureOutboxRow } from '../../../../shared/receiptClaimFailureOutbox.ts';
import { commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { reconcileReceiptClaimFailureNotifications } from '../src/receiptClaimFailureNotifications.ts';
import { receiptClaimFailureDiscoveryQuery, ReceiptClaimFailureOutboxStore } from '../src/receiptClaimFailureOutboxStore.ts';
import { createCommerceD1Harness, seedCommerceDocument, type CommerceD1CallObservation } from './commerceD1Harness.ts';

const NOW = 1_800_000_000_000;
const WINDOW = 15 * 60_000;
const LEASE = 10 * 60_000;
const RECIPIENT = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const CODE = 'ABCDEF-1234567890';
const OPERATION = 'src-v1-11111111-1111-4111-8111-111111111111';

function legacy(overrides: CommerceDocumentData = {}): CommerceDocumentData {
  return {
    namespace: 'stripe_receipt_v1', code: CODE, dropId: 'card_nft_2', deliveryId: 7, boxId: 16,
    recipient: RECIPIENT, status: 'processing', processingStartedAt: NOW - WINDOW - 1,
    processingLeaseExpiresAt: NOW - 1, processingAttemptId: crypto.randomUUID(),
    ...overrides,
  };
}

function workflow(phase: 'pending' | 'failed' | 'manual_review', overrides: CommerceDocumentData = {}): CommerceDocumentData {
  return {
    operationId: OPERATION, generation: 1, phase, createdAtMs: NOW - WINDOW - 1,
    deadlineAtMs: NOW - 1, error: { code: 'unavailable', message: `Never publish ${CODE}` },
    submission: { signature: '1'.repeat(88), signedTransactionBase64: `secret-bytes-${CODE}` },
    ...overrides,
  };
}

function fixture(t: TestContext) {
  let observe: ((observation: CommerceD1CallObservation) => void) | undefined;
  const harness = createCommerceD1Harness({ observeCall: (observation) => observe?.(observation) });
  t.after(() => harness.database.close());
  const jobs: NotificationEmailJobV1[] = [];
  const logs: Record<string, unknown>[] = [];
  const summaries: Array<Awaited<ReturnType<typeof reconcileReceiptClaimFailureNotifications>>> = [];
  let send: ((jobs: NotificationEmailJobV1[]) => Promise<void>) | undefined;
  const env = {
    COMMERCE_DB: harness.db,
    NOTIFICATION_EMAIL_QUEUE: {
      async sendBatch(messages: Iterable<MessageSendRequest<NotificationEmailJobV1>>) {
        const batch = Array.from(messages, (message) => message.body);
        jobs.push(...batch);
        await send?.(batch);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  };
  const seed = (data: CommerceDocumentData, code = CODE, version = 1) => seedCommerceDocument(harness, {
    key: commerceKeys.claimCode(code), data: { ...data, code }, version,
  });
  const run = (now = NOW, signal = new AbortController().signal,
    options: Parameters<typeof reconcileReceiptClaimFailureNotifications>[2] = {}) => reconcileReceiptClaimFailureNotifications(env, signal, {
    nowMs: () => now, monotonicNowMs: () => 0, log: (entry) => logs.push(entry),
    onResult: (result) => { summaries.push(result); }, ...options,
  });
  const records = () => harness.database.prepare('SELECT * FROM commerce_receipt_claim_failure_outbox ORDER BY event_id')
    .all().map(parseReceiptClaimFailureOutboxRow);
  const document = () => String(harness.database.prepare('SELECT document_json FROM commerce_documents WHERE document_path = ?')
    .get(commerceKeys.claimCode(CODE).path)?.document_json);
  return { ...harness, jobs, logs, summaries, seed, run, records, document,
    observe: (callback: typeof observe) => { observe = callback; },
    onSend: (callback: typeof send) => { send = callback; } };
}

test('legacy detection requires fifteen minutes and an expired lease, leaves claims untouched, and sends once', async (t) => {
  const f = fixture(t);
  f.seed(legacy());
  f.seed(legacy({ processingStartedAt: NOW - WINDOW + 1 }), 'ABCDEF-1234567891');
  f.seed(legacy({ processingLeaseExpiresAt: NOW + 1 }), 'ABCDEF-1234567892');
  f.seed(legacy({ status: 'unclaimed' }), 'ABCDEF-1234567893');
  const before = f.document();
  assert.equal((await f.run()).completed, 1);
  assert.equal(f.jobs.length, 1);
  const [alert] = f.records();
  assert.equal(alert.state, 'queued');
  assert.equal(alert.snapshot.phase, 'legacy_processing');
  assert.match(alert.eventId, /^legacy:[a-f0-9]{64}$/);
  assert.equal(f.document(), before);
  await f.run();
  assert.equal(f.jobs.length, 1);
  assert.equal(f.records().length, 1);
  assert.deepEqual(f.jobs[0].recipients, ['development@support.mons.shop']);
  assert.equal(JSON.stringify(f.jobs).includes(CODE), false);
  assert.equal(JSON.stringify(f.logs).includes(CODE), false);
});

test('terminal failure capture and overdue discovery use the same event and retain safe snapshots', async (t) => {
  const f = fixture(t);
  f.seed(legacy({ receiptClaimWorkflowV1: workflow('pending') }));
  const before = f.document();
  assert.equal((await f.run()).completed, 1);
  assert.equal(f.document(), before);
  assert.equal(f.records()[0].snapshot.phase, 'overdue');
  f.seed(legacy({ receiptClaimWorkflowV1: workflow('manual_review') }), CODE, 2);
  await f.run();
  assert.equal(f.jobs.length, 1);
  assert.equal(f.records()[0].eventId, `${OPERATION}:g1`);
  assert.equal(JSON.stringify(f.jobs).includes('secret-bytes'), false);
  assert.equal(JSON.stringify(f.jobs).includes(CODE), false);
  assert.equal(JSON.stringify(f.records()[0].snapshot).includes('Never publish'), false);
});

test('terminal backfill discovers an existing failure without an intent', async (t) => {
  const f = fixture(t);
  f.database.exec('DROP TRIGGER commerce_receipt_claim_failure_capture_insert');
  f.seed(legacy({ receiptClaimWorkflowV1: workflow('failed', { error: { code: CODE, message: CODE } }) }));
  assert.equal(f.records().length, 0);
  assert.equal((await f.run()).completed, 1);
  assert.equal(f.records()[0].snapshot.errorCode, 'internal');
  assert.equal(f.records()[0].snapshot.phase, 'failed');
});

test('concurrent reconcilers acquire one publication lease', async (t) => {
  const f = fixture(t);
  f.seed(legacy());
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.records()[0].attemptCount, 1);
  assert.equal(f.records()[0].state, 'queued');
});

test('queue failures retain the immutable job and retry only after the lease expires', async (t) => {
  const f = fixture(t);
  f.seed(legacy());
  f.onSend(async () => { throw new Error('queue unavailable'); });
  await assert.rejects(f.run(), /notification reconciliation failed/);
  const original = structuredClone(f.jobs[0]);
  assert.equal(f.records()[0].state, 'pending');
  assert.deepEqual(f.records()[0].job, original);
  await f.run(NOW + LEASE - 1);
  assert.equal(f.jobs.length, 1);
  f.onSend(undefined);
  assert.equal((await f.run(NOW + LEASE)).completed, 1);
  assert.deepEqual(f.jobs[1], original);
  assert.equal(f.records()[0].attemptCount, 2);
});

test('lost queue acknowledgement retries the same provider idempotency key and payload', async (t) => {
  const f = fixture(t);
  f.seed(legacy());
  let failAck = true;
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.includes("SET state = 'queued'") && failAck) {
      failAck = false;
      throw new Error('lost acknowledgement');
    }
  });
  await assert.rejects(f.run(), /notification reconciliation failed/);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.records()[0].state, 'pending');
  await f.run(NOW + LEASE);
  assert.equal(f.jobs.length, 2);
  assert.deepEqual(f.jobs[1], f.jobs[0]);
  assert.equal(f.records()[0].state, 'queued');
});

test('a completion between discovery and insertion cannot create an alert', async (t) => {
  const f = fixture(t);
  const source = legacy();
  f.seed(source);
  let changed = false;
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.startsWith('INSERT INTO commerce_receipt_claim_failure_outbox') && !changed) {
      changed = true;
      f.seed({ ...source, status: 'claimed' }, CODE, 2);
    }
  });
  await f.run();
  assert.equal(changed, true);
  assert.equal(f.records().length, 0);
  assert.equal(f.jobs.length, 0);
});

test('completion immediately before payload persistence cancels an unsent alert', async (t) => {
  const f = fixture(t);
  const source = legacy();
  f.seed(source);
  let changed = false;
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.includes('SET job_json = COALESCE') && !changed) {
      changed = true;
      f.seed({ ...source, status: 'claimed' }, CODE, 2);
    }
  });
  await f.run();
  assert.equal(changed, true);
  assert.equal(f.records()[0].state, 'cancelled');
  assert.equal(f.jobs.length, 0);
});

test('an explicit retry generation supersedes an unsent terminal alert', async (t) => {
  const f = fixture(t);
  f.seed(legacy({ receiptClaimWorkflowV1: workflow('manual_review') }));
  assert.equal(f.records().length, 1);
  f.seed(legacy({ receiptClaimWorkflowV1: workflow('pending', { generation: 2, deadlineAtMs: NOW + WINDOW }) }), CODE, 2);
  await f.run();
  assert.equal(f.records()[0].state, 'cancelled');
  assert.equal(f.jobs.length, 0);
});

test('four ambiguous publication attempts exhaust safely without repeated messages', async (t) => {
  const f = fixture(t);
  f.seed(legacy());
  f.onSend(async () => { throw new Error('queue unavailable'); });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(f.run(NOW + LEASE * attempt), /notification reconciliation failed/);
  }
  const result = await f.run(NOW + LEASE * 4);
  assert.equal(result.failed, 1);
  assert.equal(f.records()[0].state, 'failed');
  assert.equal(f.records()[0].lastErrorCode, 'publication-exhausted');
  assert.equal(f.jobs.length, 4);
  assert.ok(f.jobs.every((job) => JSON.stringify(job) === JSON.stringify(f.jobs[0])));
});

test('aborted discovery never writes or sends', async (t) => {
  const f = fixture(t);
  f.seed(legacy());
  await assert.rejects(f.run(NOW, AbortSignal.abort(new Error('stopped'))), /stopped/);
  assert.equal(f.records().length, 0);
  assert.equal(f.jobs.length, 0);
});

test('cancellation after taking a lease releases the unsent attempt and preserves its job', async (t) => {
  const f = fixture(t);
  f.seed(legacy());
  const controller = new AbortController();
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.includes('SET job_json = COALESCE')) controller.abort(new Error('stopped'));
  });
  await assert.rejects(f.run(NOW, controller.signal), /stopped/);
  assert.equal(f.jobs.length, 0);
  const [record] = f.records();
  assert.equal(record.state, 'pending');
  assert.equal(record.attemptCount, 0);
  assert.equal(record.claimId, null);
  assert.ok(record.job);
  f.observe(undefined);
  await f.run();
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(f.jobs[0], record.job);
});

test('bounded discovery advances past previously notified claims on later passes', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 20; index += 1) {
    f.seed(legacy({ deliveryId: 20 + index, boxId: 30 + index }), `ABCDEF-${String(index).padStart(10, '0')}`);
  }
  await f.run();
  assert.equal(f.jobs.length, 8);
  await f.run();
  assert.equal(f.jobs.length, 16);
  await f.run();
  assert.equal(f.jobs.length, 20);
  assert.equal(new Set(f.jobs.map((job) => job.idempotencyKey)).size, 20);
});

test('a later explicit retry failure gets a new incident without reusing the previous email identity', async (t) => {
  const f = fixture(t);
  f.seed(legacy({ receiptClaimWorkflowV1: workflow('manual_review') }));
  await f.run();
  f.seed(legacy({ receiptClaimWorkflowV1: workflow('failed', { generation: 2 }) }), CODE, 2);
  await f.run();
  assert.equal(f.jobs.length, 2);
  assert.notEqual(f.jobs[0].idempotencyKey, f.jobs[1].idempotencyKey);
  await f.run();
  assert.equal(f.jobs.length, 2);
});

test('discovery queries use their partial indexes without temporary sorts', (t) => {
  const f = fixture(t);
  for (const kind of ['legacy', 'terminal', 'overdue'] as const) {
    const plan = f.database.prepare(`EXPLAIN QUERY PLAN ${receiptClaimFailureDiscoveryQuery(kind)}`).all(NOW, NOW - WINDOW, 8);
    const details = plan.map((row) => String(row.detail)).join('\n');
    assert.match(details, new RegExp(`commerce_receipt_claim_failure_${kind}_scan`));
    assert.equal(details.includes('USE TEMP B-TREE'), false);
  }
});

test('malformed oldest source records cannot occupy the discovery page ahead of a valid claim', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 12; index += 1) {
    f.seed(legacy({ recipient: `invalid-${index}`, processingStartedAt: NOW - WINDOW - 100 }),
      `ABCDEF-${String(index).padStart(10, '0')}`);
  }
  f.seed(legacy());
  assert.equal((await f.run()).completed, 1);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.records().length, 1);
  assert.equal(f.records()[0].snapshot.recipient, RECIPIENT);
});

test('a failed discovery insert does not block another valid candidate or reveal sensitive fields in logs', async (t) => {
  const f = fixture(t);
  f.seed(legacy({ processingStartedAt: NOW - WINDOW - 2 }));
  f.seed(legacy({ deliveryId: 8, boxId: 17 }), 'ABCDEF-1234567891');
  let failed = false;
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.startsWith('INSERT INTO commerce_receipt_claim_failure_outbox') && !failed) {
      failed = true;
      throw new Error(`Private failure ${CODE}`);
    }
  });
  await assert.rejects(f.run(), /notification reconciliation failed/);
  assert.equal(failed, true);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].context.deliveryId, 8);
  assert.equal(JSON.stringify(f.logs).includes(CODE), false);
  assert.equal(JSON.stringify(f.logs).includes('claimCodes/'), false);
});

test('a malformed outbox row is isolated and quarantined while the next valid notification publishes', async (t) => {
  const f = fixture(t);
  f.seed(legacy({ receiptClaimWorkflowV1: workflow('failed', {
    operationId: 'src-v1-' + '0'.repeat(36),
  }) }));
  f.seed(legacy({ deliveryId: 8, receiptClaimWorkflowV1: workflow('failed') }), 'ABCDEF-1234567891');
  await assert.rejects(f.run(), /notification reconciliation failed/);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].context.deliveryId, 8);
  const quarantined = f.database.prepare("SELECT state, last_error_code FROM commerce_receipt_claim_failure_outbox WHERE event_id = ?")
    .get('src-v1-' + '0'.repeat(36) + ':g1');
  assert.equal(quarantined?.state, 'failed');
  assert.equal(quarantined?.last_error_code, 'invalid-notification-data');
  assert.equal(JSON.stringify(f.logs).includes(CODE), false);
  assert.equal(JSON.stringify(f.logs).includes('claimCodes/'), false);
  await f.run();
  assert.equal(f.jobs.length, 1);
});

function seedTerminalBacklog(f: ReturnType<typeof fixture>, count: number): void {
  for (let index = 0; index < count; index += 1) {
    f.seed(legacy({ deliveryId: 20 + index, receiptClaimWorkflowV1: workflow('failed', {
      operationId: `src-v1-${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }) }), `ABCDEF-${String(index).padStart(10, '0')}`);
  }
  f.database.prepare(`UPDATE commerce_receipt_claim_failure_outbox
    SET next_attempt_at_ms = ?, revision = revision + 1`).run(NOW - 500);
}

function leafErrors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(leafErrors) : [error];
}

test('publication pages equal due timestamps, caps inspections, and reports the remaining backlog', async (t) => {
  const f = fixture(t);
  seedTerminalBacklog(f, 33);
  const first = await f.run();
  assert.deepEqual(first, {
    attempted: 32, completed: 32, deferred: 0, skipped: 0, failed: 0,
    inspected: 32, pages: 4, stopReason: 'item-limit', hasMore: true, oldestDueAgeMs: 500,
  });
  assert.deepEqual(f.jobs.map((job) => job.context.deliveryId), Array.from({ length: 32 }, (_, index) => 20 + index));
  assert.deepEqual(f.summaries, [first]);
  const second = await f.run();
  assert.equal(second.completed, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.oldestDueAgeMs, null);
  assert.equal(f.summaries.length, 2);
  assert.equal(new Set(f.jobs.map((job) => job.idempotencyKey)).size, 33);
});

test('publication advances past a failed oldest row and probes backlog behind its cursor', async (t) => {
  const f = fixture(t);
  seedTerminalBacklog(f, 10);
  const failure = new Error('oldest claim unavailable');
  let failed = false;
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.includes('SET revision = revision + 1, attempt_count = ?') && !failed) {
      failed = true;
      throw failure;
    }
  });
  await assert.rejects(f.run(), (error) => leafErrors(error).includes(failure));
  assert.deepEqual(f.jobs.map((job) => job.context.deliveryId), Array.from({ length: 9 }, (_, index) => 21 + index));
  assert.equal(f.summaries.length, 1);
  assert.deepEqual(f.summaries[0], {
    attempted: 10, completed: 9, deferred: 0, skipped: 0, failed: 1,
    inspected: 10, pages: 2, stopReason: 'failed', hasMore: true, oldestDueAgeMs: 500,
  });
});

test('discovery and publication share one soft budget and finish the active publication', async (t) => {
  const f = fixture(t);
  seedTerminalBacklog(f, 10);
  let elapsedMs = 0;
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.includes('AS claim_path')) elapsedMs = 19_000;
  });
  f.onSend(async () => { elapsedMs = 21_000; });
  const result = await f.run(NOW, undefined, { monotonicNowMs: () => elapsedMs });
  assert.equal(result.completed, 1);
  assert.equal(result.stopReason, 'time-limit');
  assert.equal(result.hasMore, true);
  assert.equal(f.records()[0].state, 'queued');
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(f.summaries, [result]);
});

test('discovery can exhaust the budget before any publication page while still reporting backlog', async (t) => {
  const f = fixture(t);
  seedTerminalBacklog(f, 2);
  let elapsedMs = 0;
  let dueQueries = 0;
  f.observe((entry) => {
    if (!('sql' in entry)) return;
    if (entry.sql.includes('AS claim_path')) elapsedMs = 20_000;
    if (entry.sql.includes('SELECT *') && entry.sql.includes('commerce_receipt_claim_failure_outbox_due')) {
      dueQueries += 1;
    }
  });
  const result = await f.run(NOW, undefined, { monotonicNowMs: () => elapsedMs });
  assert.equal(result.attempted, 0);
  assert.equal(result.pages, 0);
  assert.equal(result.stopReason, 'time-limit');
  assert.equal(result.hasMore, true);
  assert.equal(result.oldestDueAgeMs, 500);
  assert.equal(dueQueries, 1);
  assert.equal(f.jobs.length, 0);
});

test('discovery and publication errors are retained together and report one final result', async (t) => {
  const f = fixture(t);
  f.seed(legacy());
  f.seed(legacy({ deliveryId: 8 }), 'ABCDEF-1234567891');
  const discoveryFailure = new Error('discovery insertion unavailable');
  const publicationFailure = new Error('queue unavailable');
  let failed = false;
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.startsWith('INSERT INTO commerce_receipt_claim_failure_outbox') && !failed) {
      failed = true;
      throw discoveryFailure;
    }
  });
  f.onSend(async () => { throw publicationFailure; });
  await assert.rejects(f.run(), (error) => {
    assert.deepEqual(leafErrors(error), [discoveryFailure, publicationFailure]);
    return true;
  });
  assert.equal(f.summaries.length, 1);
  assert.equal(f.summaries[0].failed, 1);
  assert.equal(f.summaries[0].stopReason, 'failed');
  assert.equal(f.jobs.length, 1);
});

test('a failed quarantine retains its parse error and does not prevent later publication pages', async (t) => {
  const f = fixture(t);
  f.seed(legacy({ receiptClaimWorkflowV1: workflow('failed', {
    operationId: 'src-v1-' + '0'.repeat(36),
  }) }));
  seedTerminalBacklog(f, 10);
  const failure = new Error('quarantine unavailable');
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.includes("last_error_code = 'invalid-notification-data'")) throw failure;
  });
  await assert.rejects(f.run(), (error) => {
    const errors = leafErrors(error);
    assert.equal(errors.length, 2);
    assert.match(String(errors[0]), /Invalid receipt claim failure snapshot/);
    assert.equal(errors[1], failure);
    return true;
  });
  assert.equal(f.jobs.length, 10);
  assert.equal(f.summaries.length, 1);
  assert.equal(f.summaries[0].failed, 1);
  assert.equal(f.summaries[0].hasMore, true);
});

test('backlog probe failures leave publication successful with unknown backlog', async (t) => {
  const f = fixture(t);
  f.seed(legacy());
  f.observe((entry) => {
    if ('sql' in entry && entry.sql.includes('commerce_receipt_claim_failure_outbox_due') && f.jobs.length > 0) {
      throw new Error('backlog unavailable');
    }
  });
  const result = await f.run();
  assert.equal(result.completed, 1);
  assert.equal(result.stopReason, 'drained');
  assert.equal(result.hasMore, null);
  assert.equal(result.oldestDueAgeMs, null);
  assert.deepEqual(f.summaries, [result]);
});

test('due cursor queries use the partial index without a temporary sort', async (t) => {
  const f = fixture(t);
  const store = new ReceiptClaimFailureOutboxStore(f.db);
  let checked = false;
  f.observe((entry) => {
    if (!('sql' in entry) || !entry.sql.includes('(next_attempt_at_ms, event_id) >')) return;
    const details = f.database.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(NOW, NOW - 500, 'previous', 8)
      .map((row) => String(row.detail)).join('\n');
    assert.match(details, /commerce_receipt_claim_failure_outbox_due/);
    assert.doesNotMatch(details, /USE TEMP B-TREE/);
    checked = true;
  });
  await store.queryDue({ dueAtMs: NOW, limit: 8, startAfter: { nextAttemptAtMs: NOW - 500, eventId: 'previous' } });
  assert.equal(checked, true);
});
