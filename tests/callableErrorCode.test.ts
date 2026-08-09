import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRIPE_OWNER_MERGE_LIMIT_ERROR_REASON,
  WALLET_SESSION_SUPERSEDED_ERROR_REASON,
  normalizeCallableErrorCode,
} from '../functions/src/shared/callableErrorCode.ts';
import { isRetryableCallableError } from '../src/lib/callableErrors.ts';

test('callable error codes normalize Firebase client prefixes once', () => {
  assert.equal(normalizeCallableErrorCode('functions/unavailable'), 'unavailable');
  assert.equal(normalizeCallableErrorCode('unavailable'), 'unavailable');
  assert.equal(normalizeCallableErrorCode(''), '');
  assert.equal(normalizeCallableErrorCode(undefined), '');
});

test('frontend callable retry classification accepts prefixed and bare codes', () => {
  assert.equal(isRetryableCallableError({ code: 'functions/unavailable' }), true);
  assert.equal(isRetryableCallableError({ code: 'unavailable' }), true);
  assert.equal(isRetryableCallableError({ code: 'functions/resource-exhausted' }), true);
  assert.equal(
    isRetryableCallableError({
      code: 'functions/resource-exhausted',
      details: { reason: STRIPE_OWNER_MERGE_LIMIT_ERROR_REASON },
    }),
    false,
  );
  assert.equal(
    isRetryableCallableError({
      code: 'functions/aborted',
      details: { reason: WALLET_SESSION_SUPERSEDED_ERROR_REASON },
    }),
    false,
  );
  assert.equal(
    isRetryableCallableError({
      code: 'unavailable',
      details: { reason: WALLET_SESSION_SUPERSEDED_ERROR_REASON },
    }),
    false,
  );
  assert.equal(isRetryableCallableError({ code: 'functions/aborted' }), true);
  assert.equal(isRetryableCallableError({ code: 'functions/failed-precondition' }), false);
  assert.equal(isRetryableCallableError({ code: 'functions/invalid-argument' }), false);
});
