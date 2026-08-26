export class ProfileReadError extends Error {
  constructor(
    readonly code:
      | 'invalid-argument'
      | 'unauthenticated'
      | 'permission-denied'
      | 'not-found'
      | 'aborted'
      | 'failed-precondition'
      | 'resource-exhausted'
      | 'deadline-exceeded'
      | 'unavailable'
      | 'internal',
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProfileReadError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
