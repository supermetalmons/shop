import assert from 'node:assert/strict';
import test from 'node:test';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../../../shared/opsExpiryCleanupSql.ts';
import { runScheduledReconciliations, type ScheduledReconcilers } from '../src/workerScheduled.ts';

type CleanupTable = 'rate_limit_buckets' | 'staff_auth_sessions' | 'anonymous_auth_sessions';
const CLEANUP_TABLES: CleanupTable[] = ['rate_limit_buckets', 'staff_auth_sessions', 'anonymous_auth_sessions'];

function cleanupDatabase(options: {
  onBatch?: (table: CleanupTable) => void | Promise<void>;
  deleted?: Partial<Record<CleanupTable | 'staff_auth_challenges', number>>;
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
          const deleted = options.deleted?.[deletedTable as CleanupTable | 'staff_auth_challenges'] || 0;
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

test('OPS cleanup preserves completion and backlog logs while commerce is paused', async (context) => {
  const logs: unknown[] = [];
  const errors: unknown[] = [];
  context.mock.method(console, 'log', (entry: unknown) => { logs.push(entry); });
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
  assert.deepEqual(logs, [
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
