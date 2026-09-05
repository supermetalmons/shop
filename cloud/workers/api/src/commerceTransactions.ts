import {
  CommerceRepositoryError,
  CommerceWriteConflict,
  type D1CommerceRepository,
  commerceFieldValue,
  commerceKeyFromPath,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
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

export type CommerceRepositoryContext = {
  nowMs: number;
  repository: D1CommerceRepository;
  signal: AbortSignal;
};

export function requireCommerceKey(path: string): CommerceDocumentKey {
  const key = commerceKeyFromPath(path);
  if (!key) throw new Error('Invalid commerce document path.');
  return key;
}

export async function readCommerceRecord(
  context: CommerceRepositoryContext,
  key: CommerceDocumentKey,
  transaction?: CommerceUnitOfWork,
): Promise<CommerceDocumentRecord | null> {
  if (!transaction) return context.repository.get(key);
  try {
    return await transaction.get(key);
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
}

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

export function commerceTimestamp(milliseconds: number): CommerceUpdateValue {
  const seconds = Math.floor(milliseconds / 1000);
  return commerceFieldValue.timestamp(
    seconds,
    (milliseconds - seconds * 1000) * 1_000_000,
  );
}
