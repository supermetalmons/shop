import assert from 'node:assert/strict';
import test from 'node:test';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../../../shared/opsExpiryCleanupSql.ts';
import { runScheduledReconciliations, type ScheduledReconcilers } from '../src/workerScheduled.ts';

type CleanupTable = 'rate_limit_buckets' | 'staff_auth_sessions' | 'anonymous_auth_sessions' | 'mi_note_auth_sessions';
const CLEANUP_TABLES: CleanupTable[] = ['rate_limit_buckets', 'staff_auth_sessions', 'anonymous_auth_sessions', 'mi_note_auth_sessions'];

function cleanupDatabase(options: {
  onBatch?: (table: CleanupTable) => void | Promise<void>;
  deleted?: Partial<Record<CleanupTable | 'staff_auth_challenges' | 'mi_note_auth_challenges', number>>;
  hasMore?: boolean;
} = {}) {
  const calls: CleanupTable[] = [];
  let active = 0;
  let maxActive = 0;
  const db = {
    prepare(sql: string) {
      return { sql, bind() { return this; } };
    },
    async batch(statements: Array<{ sql: string }>) {
      const table = statements[0].sql.match(/^DELETE FROM (\w+)/)?.[1] as CleanupTable;
      assert.ok(CLEANUP_TABLES.includes(table));
      calls.push(table);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await options.onBatch?.(table);
        return statements.map(({ sql }) => {
          const deletedTable = sql.match(/^DELETE FROM (\w+)/)?.[1];
          const deleted = options.deleted?.[deletedTable as CleanupTable | 'staff_auth_challenges' | 'mi_note_auth_challenges'] || 0;
          return {
            success: true,
            meta: { changes: deleted },
            results: deletedTable === 'rate_limit_buckets'
              ? Array.from({ length: deleted }, () => ({ subject_hash: 'expired' }))
              : deletedTable ? [] : [{ has_more: options.hasMore ? 1 : 0 }],
          };
        });
      } finally {
        active -= 1;
      }
    },
  } as unknown as D1Database;
  return { db, calls, maxActive: () => maxActive };
}

function commerceReconcilers(calls: string[] = []): Omit<ScheduledReconcilers, 'ops'> {
  return {
    notifications: async () => { calls.push('notifications'); return 0; },
    packStatus: async () => { calls.push('packStatus'); return 0; },
    stripe: async () => { calls.push('stripe'); return { enqueued: 0, failed: 0 }; },
    stripeNotifications: async () => { calls.push('stripeNotifications'); return 0; },
    shippedNotifications: async () => { calls.push('shippedNotifications'); return 0; },
    receiptClaims: async () => { calls.push('receiptClaims'); return 0; },
    preorders: async () => { calls.push('preorders'); return 0; },
  };
}

function assertOpsFailures(error: unknown, failures: unknown[]): boolean {
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, 'Scheduled reconciliation failed');
  assert.equal(error.errors.length, 1);
  const opsError: unknown = error.errors[0];
  assert.ok(opsError instanceof AggregateError);
  assert.equal(opsError.message, 'Scheduled OPS cleanup failed');
  assert.deepEqual(opsError.errors, failures);
  return true;
}

test('scheduled jobs report their own result counts and preserve immediate invocation order', async (context) => {
  const logs: Array<Record<string, unknown>> = [];
  context.mock.method(console, 'log', (entry: Record<string, unknown>) => { logs.push(entry); });
  const calls: string[] = [];
  const reconciliation = runScheduledReconciliations({} as Env, new AbortController().signal, {
    stripe: async () => { calls.push('stripe'); return { enqueued: 2, failed: 1 }; },
    stripeNotifications: async () => { calls.push('stripeNotifications'); return 3; },
    shippedNotifications: async () => { calls.push('shippedNotifications'); return 4; },
    packStatus: async () => { calls.push('packStatus'); return 5; },
    notifications: async () => { calls.push('notifications'); return 6; },
    receiptClaims: async () => { calls.push('receiptClaims'); return 7; },
    preorders: async () => { calls.push('preorders'); return 0; },
    ops: async () => { calls.push('ops'); },
  });
  assert.deepEqual(calls, [
    'stripe', 'stripeNotifications', 'shippedNotifications', 'packStatus',
    'notifications', 'receiptClaims', 'preorders', 'ops',
  ]);
  await reconciliation;
  assert.equal(logs.length, 8);
  for (const entry of logs) {
    assert.equal(entry.event, 'scheduled_reconciliation_job');
    assert.equal(entry.outcome, 'succeeded');
    assert.equal(typeof entry.durationMs, 'number');
    assert.ok(Number.isFinite(entry.durationMs));
    assert.ok((entry.durationMs as number) >= 0);
  }
  assert.deepEqual(Object.fromEntries(logs.map(({ job, durationMs: _durationMs, ...entry }) => [job, entry])), {
    stripe: { event: 'scheduled_reconciliation_job', outcome: 'succeeded', enqueued: 2, failed: 1 },
    stripeNotifications: { event: 'scheduled_reconciliation_job', outcome: 'succeeded', processedCount: 3 },
    shippedNotifications: { event: 'scheduled_reconciliation_job', outcome: 'succeeded', processedCount: 4 },
    packStatus: { event: 'scheduled_reconciliation_job', outcome: 'succeeded', processedCount: 5 },
    notifications: { event: 'scheduled_reconciliation_job', outcome: 'succeeded', processedCount: 6 },
    receiptClaims: { event: 'scheduled_reconciliation_job', outcome: 'succeeded', processedCount: 7 },
    preorders: { event: 'scheduled_reconciliation_job', outcome: 'succeeded', processedCount: 0 },
    ops: { event: 'scheduled_reconciliation_job', outcome: 'succeeded' },
  });
});

test('failed scheduled jobs report only error names and preserve original failures', async (context) => {
  const errors: Array<Record<string, unknown>> = [];
  context.mock.method(console, 'log', () => {});
  context.mock.method(console, 'error', (entry: Record<string, unknown>) => { errors.push(entry); });
  const stripeFailure = new TypeError('private provider details');
  const opsFailure = { secret: 'private cleanup details' };
  await assert.rejects(runScheduledReconciliations({} as Env, new AbortController().signal, {
    ...commerceReconcilers(),
    stripe: async () => { throw stripeFailure; },
    ops: async () => { throw opsFailure; },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], stripeFailure);
    assert.equal(error.errors[1], opsFailure);
    return true;
  });
  assert.deepEqual(errors.map(({ durationMs: _durationMs, ...entry }) => entry), [
    { event: 'scheduled_reconciliation_job', job: 'stripe', outcome: 'failed', errorName: 'TypeError' },
    { event: 'scheduled_reconciliation_job', job: 'ops', outcome: 'failed', errorName: 'UnknownError' },
  ]);
});

test('scheduled job logging cannot change successful results or replace failures', async (context) => {
  const loggerFailure = new Error('logger unavailable');
  context.mock.method(console, 'log', () => { throw loggerFailure; });
  context.mock.method(console, 'error', () => { throw loggerFailure; });
  await runScheduledReconciliations({} as Env, new AbortController().signal, {
    ...commerceReconcilers(),
    ops: async () => {},
  });
  const jobFailure = new Error('job failed');
  await assert.rejects(runScheduledReconciliations({} as Env, new AbortController().signal, {
    ...commerceReconcilers(),
    stripe: async () => { throw jobFailure; },
    ops: async () => {},
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0], jobFailure);
    return true;
  });
});

test('synchronous commerce failure still skips later commerce jobs and waits for OPS', async (context) => {
  const errors: Array<Record<string, unknown>> = [];
  context.mock.method(console, 'log', () => {});
  context.mock.method(console, 'error', (entry: Record<string, unknown>) => { errors.push(entry); });
  const failure = new Error('synchronous commerce failure');
  const opsFinished = Promise.withResolvers<void>();
  const calls: string[] = [];
  let settled = false;
  const reconciliation = runScheduledReconciliations({} as Env, new AbortController().signal, {
    ...commerceReconcilers(calls),
    stripe: () => { calls.push('stripe'); throw failure; },
    ops: () => { calls.push('ops'); return opsFinished.promise; },
  }).finally(() => { settled = true; });
  const rejection = assert.rejects(reconciliation, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0], failure);
    return true;
  });
  assert.deepEqual(calls, ['stripe', 'ops']);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  opsFinished.resolve();
  await rejection;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].job, 'stripe');
  assert.equal(errors[0].outcome, 'failed');
});

test('synchronous OPS failure remains the direct rejection', async (context) => {
  const errors: Array<Record<string, unknown>> = [];
  context.mock.method(console, 'log', () => {});
  context.mock.method(console, 'error', (entry: Record<string, unknown>) => { errors.push(entry); });
  const failure = new Error('synchronous OPS failure');
  await assert.rejects(runScheduledReconciliations({} as Env, new AbortController().signal, {
    ...commerceReconcilers(),
    ops: () => { throw failure; },
  }), (error: unknown) => error === failure);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].job, 'ops');
  assert.equal(errors[0].outcome, 'failed');
});

test('OPS cleanup continues sequentially after failures and aggregates all errors', async () => {
  const rateLimitFailure = new Error('rate-limit cleanup failed');
  const staffFailure = new Error('staff cleanup failed');
  const harness = cleanupDatabase({
    onBatch: (table) => {
      if (table === 'rate_limit_buckets') throw rateLimitFailure;
      if (table === 'staff_auth_sessions') throw staffFailure;
    },
  });
  await assert.rejects(
    runScheduledReconciliations({ OPS_DB: harness.db } as Env, new AbortController().signal, commerceReconcilers()),
    (error) => assertOpsFailures(error, [rateLimitFailure, staffFailure]),
  );
  assert.deepEqual(harness.calls, CLEANUP_TABLES);
  assert.equal(harness.maxActive(), 1);
});

test('OPS cleanup awaits the active batch after cancellation and retains prior failures', async () => {
  const controller = new AbortController();
  const rateLimitFailure = new Error('rate-limit cleanup failed');
  const abortReason = new Error('scheduled deadline exceeded');
  const staffStarted = Promise.withResolvers<void>();
  const staffFinished = Promise.withResolvers<void>();
  const harness = cleanupDatabase({
    onBatch: async (table) => {
      if (table === 'rate_limit_buckets') throw rateLimitFailure;
      if (table === 'staff_auth_sessions') {
        staffStarted.resolve();
        await staffFinished.promise;
      }
    },
  });
  let settled = false;
  const reconciliation = runScheduledReconciliations(
    { OPS_DB: harness.db } as Env,
    controller.signal,
    commerceReconcilers(),
  ).finally(() => { settled = true; });
  const rejection = assert.rejects(reconciliation, (error) => assertOpsFailures(error, [rateLimitFailure, abortReason]));
  await staffStarted.promise;
  controller.abort(abortReason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(harness.calls, ['rate_limit_buckets', 'staff_auth_sessions']);
  staffFinished.resolve();
  await rejection;
  assert.deepEqual(harness.calls, ['rate_limit_buckets', 'staff_auth_sessions']);
  assert.equal(harness.maxActive(), 1);
});

test('OPS cleanup records a batch rejection matching the abort reason only once', async () => {
  const controller = new AbortController();
  const abortReason = new Error('scheduled deadline exceeded');
  const harness = cleanupDatabase({
    onBatch: () => {
      controller.abort(abortReason);
      throw abortReason;
    },
  });
  await assert.rejects(
    runScheduledReconciliations({ OPS_DB: harness.db } as Env, controller.signal, commerceReconcilers()),
    (error) => assertOpsFailures(error, [abortReason]),
  );
  assert.deepEqual(harness.calls, ['rate_limit_buckets']);
});

test('OPS cleanup does not start a batch when already cancelled', async () => {
  const controller = new AbortController();
  const abortReason = new Error('already cancelled');
  controller.abort(abortReason);
  const harness = cleanupDatabase();
  await assert.rejects(
    runScheduledReconciliations({ OPS_DB: harness.db } as Env, controller.signal, commerceReconcilers()),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [abortReason]);
      return true;
    },
  );
  assert.deepEqual(harness.calls, []);
});

test('OPS cleanup runs while commerce authority is pending', async () => {
  const authority = Promise.withResolvers<{ authority_state: string; revision: number; documents_revision: number }>();
  const opsFinished = Promise.withResolvers<void>();
  const commerceCalls: string[] = [];
  let settled = false;
  const reconciliation = runScheduledReconciliations({
    COMMERCE_DB: { prepare: () => ({ first: () => authority.promise }) },
  } as unknown as Env, new AbortController().signal, {
    ...commerceReconcilers(commerceCalls),
    ops: async () => { opsFinished.resolve(); },
  }).finally(() => { settled = true; });
  await opsFinished.promise;
  assert.equal(settled, false);
  assert.deepEqual(commerceCalls, []);
  authority.resolve({ authority_state: 'd1', revision: 1, documents_revision: 0 });
  await reconciliation;
  assert.equal(commerceCalls.length, 7);
});

test('commerce authority failure waits for independent OPS cleanup and retains both failures', async (context) => {
  const logs: Array<Record<string, unknown>> = [];
  context.mock.method(console, 'log', (entry: Record<string, unknown>) => { logs.push(entry); });
  context.mock.method(console, 'error', (entry: Record<string, unknown>) => { logs.push(entry); });
  const opsStarted = Promise.withResolvers<void>();
  const opsFinished = Promise.withResolvers<void>();
  const opsFailure = new Error('ops cleanup failed');
  const commerceCalls: string[] = [];
  let settled = false;
  const reconciliation = runScheduledReconciliations({
    COMMERCE_DB: { prepare: () => ({ first: async () => { throw new Error('commerce offline'); } }) },
  } as unknown as Env, new AbortController().signal, {
    ...commerceReconcilers(commerceCalls),
    ops: async () => {
      opsStarted.resolve();
      await opsFinished.promise;
      throw opsFailure;
    },
  }).finally(() => { settled = true; });
  const rejection = assert.rejects(reconciliation, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'Scheduled reconciliation failed');
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0].code, 'unavailable');
    assert.equal(error.errors[1], opsFailure);
    return true;
  });
  await opsStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(commerceCalls, []);
  opsFinished.resolve();
  await rejection;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].job, 'ops');
  assert.equal(logs[0].outcome, 'failed');
});

test('commerce reconciliation and OPS failures retain their existing aggregate shape', async () => {
  const stripeFailure = new Error('stripe reconciliation failed');
  const notificationFailure = new Error('notification reconciliation failed');
  const rateLimitFailure = new Error('rate-limit cleanup failed');
  const harness = cleanupDatabase({
    onBatch: (table) => { if (table === 'rate_limit_buckets') throw rateLimitFailure; },
  });
  await assert.rejects(runScheduledReconciliations({ OPS_DB: harness.db } as Env,
    new AbortController().signal, {
      ...commerceReconcilers(),
      stripe: async () => { throw stripeFailure; },
      notifications: async () => { throw notificationFailure; },
    }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    assert.deepEqual(error.errors.slice(0, 2), [stripeFailure, notificationFailure]);
    assert.ok(error.errors[2] instanceof AggregateError);
    assert.equal(error.errors[2].message, 'Scheduled OPS cleanup failed');
    assert.deepEqual(error.errors[2].errors, [rateLimitFailure]);
    return true;
  });
  assert.deepEqual(harness.calls, CLEANUP_TABLES);
});

test('OPS cleanup preserves completion and backlog logs while commerce is paused', async (context) => {
  const logs: Array<Record<string, unknown>> = [];
  const errors: unknown[] = [];
  context.mock.method(console, 'log', (entry: Record<string, unknown>) => { logs.push(entry); });
  context.mock.method(console, 'error', (entry: unknown) => { errors.push(entry); });
  const rateLimitCount = OPS_EXPIRY_CLEANUP_STATEMENTS.rateLimitBuckets.limit;
  const staffCount = OPS_EXPIRY_CLEANUP_STATEMENTS.staffAuthSessions.limit;
  const anonymousCount = OPS_EXPIRY_CLEANUP_STATEMENTS.anonymousAuthSessions.limit;
  const harness = cleanupDatabase({
    deleted: {
      rate_limit_buckets: rateLimitCount,
      staff_auth_sessions: staffCount,
      staff_auth_challenges: 2,
      anonymous_auth_sessions: anonymousCount,
    },
    hasMore: true,
  });
  const commerceCalls: string[] = [];
  await runScheduledReconciliations({
    OPS_DB: harness.db,
    COMMERCE_DB: {
      prepare: () => ({
        first: async () => ({ authority_state: 'paused', revision: 1, documents_revision: 0 }),
      }),
    },
  } as unknown as Env, new AbortController().signal, commerceReconcilers(commerceCalls));
  assert.deepEqual(commerceCalls, []);
  assert.deepEqual(harness.calls, CLEANUP_TABLES);
  assert.equal(harness.maxActive(), 1);
  const staffCounts = { sessionsDeleted: staffCount, challengesDeleted: 2, limitReached: true, hasMore: true };
  const anonymousCounts = { deletedCount: anonymousCount, limitReached: true, hasMore: true };
  const jobLogs = logs.filter((entry) => entry.event === 'scheduled_reconciliation_job');
  assert.equal(jobLogs.length, 1);
  assert.equal(jobLogs[0].job, 'ops');
  assert.equal(jobLogs[0].outcome, 'succeeded');
  assert.deepEqual(logs.filter((entry) => entry.event !== 'scheduled_reconciliation_job'), [
    { event: 'receipt_transfer_rate_limit_cleanup_completed', deletedCount: rateLimitCount, limitReached: true, hasMore: true },
    { event: 'staff_auth_cleanup_completed', ...staffCounts },
    { event: 'anonymous_auth_cleanup_completed', ...anonymousCounts },
  ]);
  assert.deepEqual(errors, [
    { event: 'receipt_transfer_rate_limit_cleanup_backlog', deletedCount: rateLimitCount },
    { event: 'staff_auth_cleanup_backlog', ...staffCounts },
    { event: 'anonymous_auth_cleanup_backlog', ...anonymousCounts },
  ]);
});
