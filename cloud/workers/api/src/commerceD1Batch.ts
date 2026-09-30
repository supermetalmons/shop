import { isRecord } from './dataAccess.js';

type CommerceD1BatchOptions = {
  invalidResult: () => Error;
  mapBatchError?: (cause: unknown) => unknown;
  requireMeta?: boolean;
};

export async function executeCommerceD1Batch(
  db: Pick<D1Database, 'batch'>,
  statements: D1PreparedStatement[] | (() => D1PreparedStatement[]),
  options: CommerceD1BatchOptions,
): Promise<D1Result<Record<string, unknown>>[]> {
  let results: D1Result<Record<string, unknown>>[];
  let expectedResults: number;
  try {
    const prepared = typeof statements === 'function' ? statements() : statements;
    if (prepared.length === 0) return [];
    expectedResults = prepared.length;
    results = await db.batch<Record<string, unknown>>(prepared);
  } catch (cause) {
    if (options.mapBatchError) throw options.mapBatchError(cause);
    throw cause;
  }
  if (!Array.isArray(results) || results.length !== expectedResults) throw options.invalidResult();
  for (const result of results) {
    if (!isRecord(result) || result.success !== true || !Array.isArray(result.results) ||
      (options.requireMeta && !isRecord(result.meta))) {
      throw options.invalidResult();
    }
  }
  return results;
}
