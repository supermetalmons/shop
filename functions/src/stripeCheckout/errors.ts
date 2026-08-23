export type StripeCheckoutFulfillmentErrorCode =
  | 'aborted'
  | 'deadline-exceeded'
  | 'failed-precondition'
  | 'internal'
  | 'invalid-argument'
  | 'resource-exhausted'
  | 'unavailable';

export class StripeCheckoutFulfillmentError extends Error {
  constructor(
    readonly code: StripeCheckoutFulfillmentErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StripeCheckoutFulfillmentError';
  }
}
