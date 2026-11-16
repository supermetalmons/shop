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

export class StripeCheckoutProcessingAttemptOwnershipCheckError extends Error {
  readonly cause?: unknown;

  constructor(cause: unknown) {
    super('Could not verify Stripe checkout fulfillment processing lease ownership');
    this.name = 'StripeCheckoutProcessingAttemptOwnershipCheckError';
    this.cause = cause;
  }
}

export class StaleStripeCheckoutProcessingAttemptError extends Error {
  constructor() {
    super('Stripe checkout fulfillment attempt no longer owns the processing lease');
    this.name = 'StaleStripeCheckoutProcessingAttemptError';
  }
}
