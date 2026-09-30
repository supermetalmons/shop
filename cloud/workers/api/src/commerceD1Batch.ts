import { isRecord } from './dataAccess.js';

type CommerceD1BatchOptions = {
  invalidResult: () => Error;
  mapBatchError?: (cause: unknown) => unknown;
  requireMeta?: boolean;
  allowNullResultsAt?: readonly number[];
};

type CommerceD1NullableBatchResult = Omit<D1Result<Record<string, unknown>>, 'results'> & {
  results: Record<string, unknown>[] | null;
};

export function executeCommerceD1Batch(
  db: Pick<D1Database, 'batch'>,
  statements: D1PreparedStatement[] | (() => D1PreparedStatement[]),
  options: CommerceD1BatchOptions & { allowNullResultsAt?: never },
): Promise<D1Result<Record<string, unknown>>[]>;
export function executeCommerceD1Batch(
  db: Pick<D1Database, 'batch'>,
  statements: D1PreparedStatement[] | (() => D1PreparedStatement[]),
  options: CommerceD1BatchOptions,
): Promise<CommerceD1NullableBatchResult[]>;
export async function executeCommerceD1Batch(
  db: Pick<D1Database, 'batch'>,
  statements: D1PreparedStatement[] | (() => D1PreparedStatement[]),
  options: CommerceD1BatchOptions,
): Promise<CommerceD1NullableBatchResult[]> {
  let results: CommerceD1NullableBatchResult[];
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
  for (const [index, result] of results.entries()) {
    if (!isRecord(result) || result.success !== true ||
      (!Array.isArray(result.results) && !(result.results === null && options.allowNullResultsAt?.includes(index))) ||
      (options.requireMeta && !isRecord(result.meta))) {
      throw options.invalidResult();
    }
  }
  return results;
}
