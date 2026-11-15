import { AdminIrlRedeemFinalizeError, type AdminIrlRedeemFinalizeErrorCode } from './adminIrlRedeemFinalizeWorkflowState.js';
import { isSignalCancellationError } from './boundedRequest.js';
import { isRecord, ProfileReadError, type ApiErrorCode } from './dataAccess.js';
import { DeliveryReceiptError } from './deliveryReceiptErrors.js';

type AdminIrlRedeemPrepareErrorCode = ApiErrorCode;

export class AdminIrlRedeemPrepareError extends Error {
  constructor(
    readonly code: AdminIrlRedeemPrepareErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AdminIrlRedeemPrepareError';
  }
}
export class PendingFinalizeSubmissionError extends AdminIrlRedeemFinalizeError {
  constructor(cause?: unknown) {
    super('aborted', 'A submitted Admin IRL redeem transaction is still being reconciled.');
    this.name = 'PendingFinalizeSubmissionError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
}

export function summarizeAdminIrlRedeemFinalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof AdminIrlRedeemFinalizeError) {
    return { kind: error.name, code: error.code };
  }
  if (error instanceof DeliveryReceiptError || error instanceof ProfileReadError) {
    return { kind: error.name, code: error.code };
  }
  if (error instanceof Error) return { kind: error.name };
  return { kind: typeof error };
}

export function normalizeAdminIrlRedeemFinalizeError(error: unknown, fallback: string): AdminIrlRedeemFinalizeError {
  if (error instanceof AdminIrlRedeemFinalizeError) return error;
  if (error instanceof DeliveryReceiptError) {
    return new AdminIrlRedeemFinalizeError(error.code, error.message, error.details);
  }
  if (error instanceof ProfileReadError) {
    return new AdminIrlRedeemFinalizeError(error.code, error.message, error.details);
  }
  if (isRecord(error) && typeof error.code === 'string') {
    const code = error.code as AdminIrlRedeemFinalizeErrorCode;
    if ([
      'invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'aborted',
      'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal',
    ].includes(code)) {
      return new AdminIrlRedeemFinalizeError(
        code,
        typeof error.message === 'string' ? error.message : fallback,
        error.details,
      );
    }
  }
  return new AdminIrlRedeemFinalizeError('internal', fallback);
}

export function rethrowAdminIrlRedeemFinalizeCancellation(signal: AbortSignal, error: unknown): void {
  if (isSignalCancellationError(signal, error)) throw signal.reason;
}
