import type { DeliveryRecoveryOutcome } from '../../../../shared/contracts.js';
import { isSignalCancellationError } from './boundedRequest.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import { rethrowDeferredWorkRegistrationError } from './deferredWork.js';
import type { DeliveryOrderKey } from './deliveryOrderStore.js';
import { DeliveryReceiptError } from './deliveryReceiptErrors.js';
import {
  cancelDeliveryRecoveryAttempt,
  finalizeDeliveryRecoveryAttempt,
  handlePreparedRecoveryFailure,
  type DeliveryRecoveryLease,
} from './deliveryRecoveryStore.js';

export function deliveryRecoveryCleanupContext<T extends CommerceRepositoryContext>(context: T): T {
  return { ...context, nowMs: Date.now(), signal: AbortSignal.timeout(5_000) };
}

function recoveryErrorCode(error: unknown): string | undefined {
  if (error instanceof DeliveryReceiptError) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'deadline-exceeded';
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  return error instanceof Error ? 'internal' : undefined;
}

function recoveryErrorMessage(error: unknown): string | undefined {
  const value = String(error instanceof Error ? error.message : error || '').trim();
  return value ? value.slice(0, 300) : undefined;
}

function recoveryFailureDetails(error: unknown): {
  errorCode: string | undefined;
  message: string | undefined;
  outcome: DeliveryRecoveryOutcome;
} {
  const errorCode = recoveryErrorCode(error);
  const message = recoveryErrorMessage(error);
  const outcome: DeliveryRecoveryOutcome = errorCode === 'failed-precondition' &&
    /delivery record pda not found/i.test(message || '') ? 'missing_delivery' : 'failed';
  return { errorCode, message, outcome };
}

export function deliveryRecoveryFailure(error: unknown): ReturnType<typeof recoveryFailureDetails> {
  rethrowDeferredWorkRegistrationError(error);
  return recoveryFailureDetails(error);
}

export async function runLeasedReceiptRecoveryAttempt<T>(args: {
  context: CommerceRepositoryContext;
  key: DeliveryOrderKey;
  lease: DeliveryRecoveryLease;
  origin: { kind: 'issue' } | { kind: 'recovery'; statusBefore: string };
  operation: () => Promise<T>;
}): Promise<T> {
  try {
    args.context.signal.throwIfAborted();
    const result = await args.operation();
    await finalizeDeliveryRecoveryAttempt(
      deliveryRecoveryCleanupContext(args.context), args.key, args.lease, {},
    ).catch(() => undefined);
    return result;
  } catch (error) {
    if (args.origin.kind === 'recovery') rethrowDeferredWorkRegistrationError(error);
    const cleanup = deliveryRecoveryCleanupContext(args.context);
    if (isSignalCancellationError(args.context.signal, error)) {
      await cancelDeliveryRecoveryAttempt(cleanup, args.key, args.lease).catch(() => undefined);
      throw args.context.signal.reason;
    }
    const failure = recoveryFailureDetails(error);
    if (args.origin.kind === 'recovery' && args.origin.statusBefore === 'prepared') {
      await handlePreparedRecoveryFailure(
        cleanup, args.key, args.lease, failure.outcome, failure.errorCode,
      ).catch(() => undefined);
    }
    await finalizeDeliveryRecoveryAttempt(cleanup, args.key, args.lease, failure).catch(() => undefined);
    throw error;
  }
}
