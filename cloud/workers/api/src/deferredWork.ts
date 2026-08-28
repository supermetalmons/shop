export type DeferredWork = (promise: Promise<unknown>) => void;

class DeferredWorkRegistrationError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('Deferred work registration failed.');
    this.name = 'DeferredWorkRegistrationError';
    this.cause = cause;
  }
}

export function registerDeferredWork(defer: DeferredWork, promise: Promise<unknown>): void {
  try {
    defer(promise);
  } catch (error) {
    throw new DeferredWorkRegistrationError(error);
  }
}

export function rethrowDeferredWorkRegistrationError(error: unknown): void {
  if (error instanceof DeferredWorkRegistrationError) throw error;
}
