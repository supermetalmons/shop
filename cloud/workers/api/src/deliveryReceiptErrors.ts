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

export function summarizeDeliveryReceiptError(error: unknown): Record<string, unknown> {
  if (error instanceof DeliveryReceiptError) {
    return {
      kind: error.name,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof Error) return { kind: error.name, message: error.message };
  return { kind: typeof error, message: String(error) };
}
