import { isRecord, ProfileReadError, type ApiErrorCode } from './dataAccess.js';
import { DeliveryReceiptError } from './deliveryReceiptErrors.js';

type ClaimErrorCode = ApiErrorCode;

export class StripeReceiptClaimError extends Error {
  constructor(
    readonly code: ClaimErrorCode,
    message: string,
    readonly details?: unknown,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'StripeReceiptClaimError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
}

export function normalizeStripeReceiptClaimError(error: unknown, fallback: string): StripeReceiptClaimError {
  if (error instanceof StripeReceiptClaimError) return error;
  if (error instanceof DeliveryReceiptError) {
    return new StripeReceiptClaimError(error.code, error.message, error.details, error.cause);
  }
  if (error instanceof ProfileReadError) {
    return new StripeReceiptClaimError(error.code, error.message, error.details, error.cause);
  }
  if (isRecord(error) && typeof error.code === 'string') {
    const code = error.code as ClaimErrorCode;
    if ([
      'invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'aborted',
      'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal',
    ].includes(code)) {
      return new StripeReceiptClaimError(
        code,
        typeof error.message === 'string' ? error.message : fallback,
        error.details,
        error instanceof Error ? error.cause : undefined,
      );
    }
  }
  return new StripeReceiptClaimError('internal', fallback, undefined, error);
}

export function summarizeStripeReceiptClaimError(error: unknown) {
  const normalized = normalizeStripeReceiptClaimError(error, 'Receipt claim failed.');
  return { kind: normalized.name, code: normalized.code, message: normalized.message };
}
