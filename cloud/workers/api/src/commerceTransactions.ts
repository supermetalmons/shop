import {
  CommerceRepositoryError,
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeyFromPath,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
  type CommerceDocumentWriteData,
  type CommerceUnitOfWork,
  type CommerceUpdateValue,
} from './commerceRepository.js';
import { isSignalCancellationError } from './boundedRequest.js';
import { ProfileReadError } from './dataAccess.js';

const COMMERCE_TRANSACTION_ATTEMPTS = 6;
const COMMERCE_TRANSACTION_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

export type CommerceRetrySleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export type CommerceConflictRetryOptions = {
  shouldRetry?: (error: CommerceWriteConflict) => boolean;
  signal?: AbortSignal;
  sleep?: CommerceRetrySleep;
};

export type CommerceTransactionTarget = {
  nowMs: number | (() => number);
  repository: Pick<D1CommerceRepository, 'run'>;
  signal?: AbortSignal;
};

export type CommerceDocumentContext = {
  commerceDb: D1Database;
  nowMs: number;
  repository?: D1CommerceRepository;
  signal: AbortSignal;
};

export type CommerceDocument = {
  fields: CommerceDocumentData;
  id: string;
  path: string;
  updateTime: string;
};

export type CommerceWrite = {
  expectedUpdateTime?: string;
  mustExist?: boolean;
  operation: 'create' | 'update';
  path: string;
  values: CommerceDocumentWriteData;
};

export type CommerceWriteTransactionResult<T> = {
  result: T;
  writes?: readonly CommerceWrite[];
};

function commerceTransactionDelayMs(failedAttempt: number): number {
  return COMMERCE_TRANSACTION_RETRY_DELAYS_MS[
    Math.min(
      Math.max(0, Math.floor(failedAttempt)),
      COMMERCE_TRANSACTION_RETRY_DELAYS_MS.length - 1,
    )
  ];
}

function sleepForCommerceRetry(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function retryCommerceConflicts<T>(
  operation: (attempt: number) => Promise<T>,
  options: CommerceConflictRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep || sleepForCommerceRetry;
  for (let attempt = 0; attempt < COMMERCE_TRANSACTION_ATTEMPTS; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      if (!(error instanceof CommerceWriteConflict)) throw error;
      if (options.shouldRetry && !options.shouldRetry(error)) throw error;
      if (attempt + 1 >= COMMERCE_TRANSACTION_ATTEMPTS) throw error;
      await sleep(commerceTransactionDelayMs(attempt), options.signal);
    }
  }
  throw new CommerceWriteConflict();
}

export function runCommerceTransaction<T>(
  target: CommerceTransactionTarget,
  operation: (transaction: CommerceUnitOfWork) => Promise<T>,
  options: Omit<CommerceConflictRetryOptions, 'signal'> = {},
): Promise<T> {
  return retryCommerceConflicts(
    () => target.repository.run(
      typeof target.nowMs === 'function' ? target.nowMs() : target.nowMs,
      operation,
    ),
    { ...options, signal: target.signal },
  );
}

export function commerceRepository(
  context: Pick<CommerceDocumentContext, 'commerceDb' | 'repository'>,
): D1CommerceRepository {
  return context.repository || new D1CommerceRepository(context.commerceDb);
}

export function beginCommerceTransaction(
  context: CommerceDocumentContext,
): Promise<CommerceUnitOfWork> {
  return commerceRepository(context).begin(context.nowMs);
}

export function rollbackCommerceTransaction(
  _context: CommerceDocumentContext,
  transaction: CommerceUnitOfWork,
): Promise<void> {
  transaction.rollback();
  return Promise.resolve();
}

function commerceDocumentKey(path: string): CommerceDocumentKey {
  const key = commerceKeyFromPath(path);
  if (!key) throw new Error('Invalid commerce document path.');
  return key;
}

export function commerceDocument(record: CommerceDocumentRecord | null): CommerceDocument | null {
  return record ? {
    fields: record.data,
    id: record.key.documentId,
    path: record.key.path,
    updateTime: record.updateTime,
  } : null;
}

export async function readCommerceDocument(
  context: CommerceDocumentContext,
  path: string,
  transaction?: CommerceUnitOfWork,
): Promise<CommerceDocument | null> {
  const key = commerceDocumentKey(path);
  if (!transaction) return commerceDocument(await commerceRepository(context).get(key));
  let record: CommerceDocumentRecord | null;
  try {
    record = await transaction.get(key);
  } catch (error) {
    if (
      error instanceof ProfileReadError ||
      error instanceof CommerceWriteConflict ||
      isSignalCancellationError(context.signal, error)
    ) throw error;
    const unavailable = new CommerceRepositoryError('unavailable', 'Commerce data is temporarily unavailable.');
    unavailable.cause = error;
    throw unavailable;
  }
  return commerceDocument(record);
}

export async function readCommerceDocuments(
  transaction: CommerceUnitOfWork,
  paths: readonly string[],
): Promise<Array<CommerceDocument | null>> {
  const records = await transaction.getMany(paths.map(commerceDocumentKey));
  return records.map(commerceDocument);
}

async function applyCommerceWrites(
  transaction: CommerceUnitOfWork,
  writes: readonly CommerceWrite[],
): Promise<void> {
  if (!writes.length) return;
  const keys = writes.map((write) => commerceDocumentKey(write.path));
  const documents = await transaction.getMany(keys);
  for (const [index, write] of writes.entries()) {
    if (write.expectedUpdateTime && documents[index]?.updateTime !== write.expectedUpdateTime) {
      throw new CommerceWriteConflict();
    }
  }
  for (const [index, write] of writes.entries()) {
    const key = keys[index];
    if (write.operation === 'create') await transaction.create(key, write.values);
    else if (write.mustExist || write.expectedUpdateTime) await transaction.update(key, write.values);
    else await transaction.set(key, write.values, { merge: true });
  }
}

export async function commitCommerceWrites(
  context: CommerceDocumentContext,
  writes: readonly CommerceWrite[],
  transaction?: CommerceUnitOfWork,
): Promise<void> {
  const unit = transaction || await commerceRepository(context).begin(context.nowMs);
  try {
    await applyCommerceWrites(unit, writes);
    await unit.commit();
  } catch (error) {
    unit.rollback();
    throw error;
  }
}

export function runCommerceWriteTransaction<T>(
  context: CommerceDocumentContext,
  operation: (
    transaction: CommerceUnitOfWork,
  ) => Promise<CommerceWriteTransactionResult<T>>,
  options: Omit<CommerceConflictRetryOptions, 'signal'> = {},
): Promise<T> {
  return runCommerceTransaction({
    nowMs: context.nowMs,
    repository: commerceRepository(context),
    signal: context.signal,
  }, async (transaction) => {
    const { result, writes = [] } = await operation(transaction);
    await applyCommerceWrites(transaction, writes);
    return result;
  }, options);
}

export function commerceTimestamp(milliseconds: number): CommerceUpdateValue {
  const seconds = Math.floor(milliseconds / 1000);
  return commerceFieldValue.timestamp(
    seconds,
    (milliseconds - seconds * 1000) * 1_000_000,
  );
}

export function createCommerceWrite(args: {
  path: string;
  values: CommerceDocumentWriteData;
}): CommerceWrite {
  return {
    operation: 'create',
    path: args.path,
    values: { ...args.values },
  };
}

export function updateCommerceWrite(args: {
  expectedUpdateTime?: string;
  mustExist?: boolean;
  path: string;
  values: CommerceDocumentWriteData;
}): CommerceWrite {
  return {
    operation: 'update',
    path: args.path,
    values: { ...args.values },
    ...(args.expectedUpdateTime ? { expectedUpdateTime: args.expectedUpdateTime } : {}),
    ...(args.mustExist ? { mustExist: true } : {}),
  };
}
