import { ProfileReadError, type ApiErrorCode } from './dataAccess.js';

type DeliveryReceiptErrorCode = ApiErrorCode;

export class DeliveryReceiptError extends Error {
  constructor(
    readonly code: DeliveryReceiptErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DeliveryReceiptError';
  }
}

export function mapProviderError(error: unknown, message: string): DeliveryReceiptError {
  if (error instanceof DeliveryReceiptError) return error;
  if (error instanceof ProfileReadError) {
    return new DeliveryReceiptError(
      error.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'unavailable',
      message,
    );
  }
  return new DeliveryReceiptError('unavailable', message);
}
