import { executeCommerceD1Batch } from './commerceD1Batch.js';
import { reportCommerceReadFailure, unavailableCommerce } from './commerceRepositorySupport.js';

type CommerceReadGuard = Readonly<{
  createStatement: () => D1PreparedStatement;
  validate: (result: D1Result<Record<string, unknown>>) => void;
}>;

type CommerceGuardedReadOptions = Readonly<{
  guards: readonly [CommerceReadGuard, ...CommerceReadGuard[]];
  invalidResult: () => Error;
  requireMeta?: boolean;
}>;

export async function executeGuardedCommerceRead(
  db: Pick<D1Database, 'batch'>,
  createStatement: () => D1PreparedStatement,
  options: CommerceGuardedReadOptions,
): Promise<D1Result<Record<string, unknown>>> {
  const [primaryGuard, ...additionalGuards] = options.guards;
  const results = await executeCommerceD1Batch(db, () => [
    primaryGuard.createStatement(), createStatement(),
    ...additionalGuards.map((guard) => guard.createStatement()),
  ], {
    invalidResult: options.invalidResult,
    requireMeta: options.requireMeta,
    mapBatchError: (cause) => {
      reportCommerceReadFailure(cause);
      return unavailableCommerce(cause);
    },
  });
  primaryGuard.validate(results[0]);
  additionalGuards.forEach((guard, index) => guard.validate(results[index + 2]));
  return results[1];
}
