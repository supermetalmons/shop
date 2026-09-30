import assert from 'node:assert/strict';
import test from 'node:test';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../../../shared/opsExpiryCleanupSql.ts';
import { cleanupExpiredOpsRecords } from '../src/opsExpiryCleanup.ts';

function database(response: unknown, failure?: Error) {
  const prepared: Array<{ sql: string; values: unknown[] }> = [];
  const metadata = new WeakMap<D1PreparedStatement, { sql: string; values: unknown[] }>();
  const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
  const db: Pick<D1Database, 'prepare' | 'batch'> = {
    prepare(sql) {
      const entry = { sql, values: [] as unknown[] };
      const statement = {
        bind(...values: unknown[]) {
          entry.values = values;
          return statement;
        },
      } as D1PreparedStatement;
      prepared.push(entry);
      metadata.set(statement, entry);
      return statement;
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      batches.push(statements.map((statement) => metadata.get(statement)!));
      if (failure) throw failure;
      return response as D1Result<T>[];
    },
  };
  return { db, prepared, batches };
}

function deleted(changes: unknown) {
  return { success: true, results: [], meta: { changes } };
}

function backlog(hasMore: unknown) {
  return { success: true, results: [{ has_more: hasMore }] };
}

test('OPS expiry cleanup keeps grouped deletes and one backlog query in the same batch', async () => {
  const limit = OPS_EXPIRY_CLEANUP_STATEMENTS.staffAuthChallenges.limit;
  const fixture = database([deleted(3), deleted(limit), backlog(1)]);
  assert.deepEqual(await cleanupExpiredOpsRecords(fixture.db,
    ['staffAuthSessions', 'staffAuthChallenges'], 123_456), {
    deletedCounts: [3, limit], limitReached: true, hasMore: true,
  });
  assert.equal(fixture.batches.length, 1);
  const statements = fixture.batches[0];
  assert.equal(statements.length, 3);
  assert.match(statements[0].sql, /^DELETE FROM staff_auth_sessions/);
  assert.match(statements[1].sql, /^DELETE FROM staff_auth_challenges/);
  assert.match(statements[2].sql,
    /^SELECT \(EXISTS\(SELECT 1 FROM staff_auth_sessions WHERE expires_at_ms <= \?\) OR EXISTS\(SELECT 1 FROM staff_auth_challenges WHERE expires_at_ms <= \?\)\) AS has_more$/);
  assert.deepEqual(statements.map(({ values }) => values), [[123_456, limit], [123_456, limit], [123_456, 123_456]]);
});

test('OPS expiry cleanup distinguishes full deletion batches from remaining backlog', async () => {
  const limit = OPS_EXPIRY_CLEANUP_STATEMENTS.anonymousAuthSessions.limit;
  for (const [count, remaining] of [[0, 0], [limit, 0], [limit, 1]]) {
    const fixture = database([deleted(count), backlog(remaining)]);
    assert.deepEqual(await cleanupExpiredOpsRecords(fixture.db, ['anonymousAuthSessions'], 0), {
      deletedCounts: [count], limitReached: count === limit, hasMore: remaining === 1,
    });
    assert.equal(fixture.batches.length, 1);
    assert.equal(fixture.batches[0].length, 2);
  }
});

test('OPS expiry cleanup counts metadata without requiring unused DELETE rows or SELECT metadata', async () => {
  for (const value of [0, 1, false, true]) {
    const fixture = database([{ success: true, results: null, meta: { changes: 7 } }, backlog(value)]);
    assert.deepEqual(await cleanupExpiredOpsRecords(fixture.db, ['rateLimitBuckets'], 1_000), {
      deletedCounts: [7], limitReached: false, hasMore: value === 1 || value === true,
    });
  }
});

test('OPS expiry cleanup skips empty groups without preparing or executing statements', async () => {
  const fixture = database(undefined);
  assert.deepEqual(await cleanupExpiredOpsRecords(fixture.db, [], Number.NaN), {
    deletedCounts: [], limitReached: false, hasMore: false,
  });
  assert.deepEqual(fixture.prepared, []);
  assert.deepEqual(fixture.batches, []);
});

test('OPS expiry cleanup rejects duplicate tables before exceeding their deletion limit', async () => {
  const fixture = database(undefined);
  await assert.rejects(cleanupExpiredOpsRecords(fixture.db,
    ['staffAuthSessions', 'staffAuthSessions'], 1_000), {
    name: 'Error', message: 'OPS expiry cleanup contains duplicate tables.',
  });
  assert.deepEqual(fixture.prepared, []);
  assert.deepEqual(fixture.batches, []);
});

test('OPS expiry cleanup rejects invalid cutoffs before preparing statements', async () => {
  for (const cutoff of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const fixture = database(undefined);
    await assert.rejects(cleanupExpiredOpsRecords(fixture.db, ['anonymousAuthSessions'], cutoff), {
      name: 'RangeError', message: 'OPS expiry cleanup cutoff must be a non-negative safe integer.',
    });
    assert.deepEqual(fixture.prepared, []);
    assert.deepEqual(fixture.batches, []);
  }
});

test('OPS expiry cleanup rejects malformed responses instead of reporting zero deletions', async (context) => {
  const limit = OPS_EXPIRY_CLEANUP_STATEMENTS.anonymousAuthSessions.limit;
  const invalidResults: Record<string, unknown> = {
    'missing batch': undefined,
    'missing statement': [deleted(0)],
    'sparse backlog statement': Object.assign(new Array(2), { 0: deleted(0) }),
    'extra statement': [deleted(0), backlog(0), backlog(0)],
    'unsuccessful delete': [{ ...deleted(0), success: false }, backlog(0)],
    'unsuccessful backlog': [deleted(0), { ...backlog(0), success: false }],
    'missing delete metadata': [{ success: true, results: [] }, backlog(0)],
    'missing delete count': [deleted(undefined), backlog(0)],
    'negative delete count': [deleted(-1), backlog(0)],
    'fractional delete count': [deleted(0.5), backlog(0)],
    'non-finite delete count': [deleted(Number.NaN), backlog(0)],
    'string delete count': [deleted('1'), backlog(0)],
    'excessive delete count': [deleted(limit + 1), backlog(0)],
    'missing backlog rows': [deleted(0), { success: true }],
    'empty backlog rows': [deleted(0), { success: true, results: [] }],
    'extra backlog row': [deleted(0), { success: true, results: [{ has_more: 0 }, { has_more: 0 }] }],
    'missing backlog value': [deleted(0), backlog(undefined)],
    'string backlog value': [deleted(0), backlog('0')],
    'invalid backlog value': [deleted(0), backlog(2)],
  };
  for (const [name, response] of Object.entries(invalidResults)) {
    await context.test(name, async () => {
      const fixture = database(response);
      await assert.rejects(cleanupExpiredOpsRecords(fixture.db, ['anonymousAuthSessions'], 1_000), {
        name: 'Error', message: 'OPS expiry cleanup returned an invalid result.',
      });
    });
  }
});

test('OPS expiry cleanup propagates the original batch rejection without retrying', async () => {
  const failure = new Error('D1 unavailable');
  const fixture = database(undefined, failure);
  await assert.rejects(cleanupExpiredOpsRecords(fixture.db, ['rateLimitBuckets'], 1_000),
    (error) => error === failure);
  assert.equal(fixture.batches.length, 1);
});
