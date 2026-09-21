import type { ApiErrorCode } from './dataAccess.js';

type DeliveryPrepareErrorCode = ApiErrorCode;

export class DeliveryPrepareError extends Error {
  constructor(
    readonly code: DeliveryPrepareErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DeliveryPrepareError';
  }
}
