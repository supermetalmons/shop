import assert from 'node:assert/strict';
import type { DeferredWork } from '../src/deferredWork.ts';

export const failOnDeferredWork: DeferredWork = (promise) => {
  void promise.catch(() => undefined);
  assert.fail('Unexpected deferred work');
};

export function createDeferredWorkCollector() {
  const promises: Promise<unknown>[] = [];
  const defer: DeferredWork = (promise) => {
    promises.push(promise);
  };
  const drain = async (): Promise<void> => {
    for (let index = 0; index < promises.length; index += 1) {
      await promises[index];
    }
  };
  return { defer, drain, promises };
}

export function isDeferredWorkRegistrationError(error: unknown, cause: unknown): boolean {
  return error instanceof Error &&
    error.name === 'DeferredWorkRegistrationError' &&
    'cause' in error &&
    error.cause === cause;
}
