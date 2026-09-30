import {
  OPS_EXPIRY_CLEANUP_STATEMENTS,
  type OpsExpiryCleanupKey,
} from '../../../../shared/opsExpiryCleanupSql.js';

export async function cleanupExpiredOpsRecords(
  db: Pick<D1Database, 'prepare' | 'batch'>,
  keys: readonly OpsExpiryCleanupKey[],
  cutoffMs: number,
): Promise<{ deletedCounts: number[]; limitReached: boolean; hasMore: boolean }> {
  if (keys.length === 0) return { deletedCounts: [], limitReached: false, hasMore: false };
  if (new Set(keys).size !== keys.length) {
    throw new Error('OPS expiry cleanup contains duplicate tables.');
  }
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) {
    throw new RangeError('OPS expiry cleanup cutoff must be a non-negative safe integer.');
  }
  const definitions = keys.map((key) => OPS_EXPIRY_CLEANUP_STATEMENTS[key]);
  const results = await db.batch<{ has_more?: unknown }>([
    ...definitions.map(({ sql, limit }) => db.prepare(sql).bind(cutoffMs, limit)),
    db.prepare(`SELECT (${definitions.map(({ tableName }) =>
      `EXISTS(SELECT 1 FROM ${tableName} WHERE expires_at_ms <= ?)`
    ).join(' OR ')}) AS has_more`).bind(...definitions.map(() => cutoffMs)),
  ]);
  if (!Array.isArray(results) || results.length !== definitions.length + 1) {
    throw new Error('OPS expiry cleanup returned an invalid result.');
  }
  for (const result of results) {
    if (result?.success !== true) throw new Error('OPS expiry cleanup returned an invalid result.');
  }
  const deletedCounts = definitions.map(({ limit }, index) => {
    const count = results[index]?.meta?.changes;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > limit) {
      throw new Error('OPS expiry cleanup returned an invalid result.');
    }
    return count;
  });
  const backlog = results[definitions.length].results;
  const hasMoreValue = backlog?.[0]?.has_more;
  if (!Array.isArray(backlog) || backlog.length !== 1 ||
    (hasMoreValue !== 0 && hasMoreValue !== 1 && hasMoreValue !== false && hasMoreValue !== true)) {
    throw new Error('OPS expiry cleanup returned an invalid result.');
  }
  return {
    deletedCounts,
    limitReached: deletedCounts.some((count, index) => count === definitions[index].limit),
    hasMore: hasMoreValue === 1 || hasMoreValue === true,
  };
}
