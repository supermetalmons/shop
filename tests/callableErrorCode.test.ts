import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCallableErrorCode } from '../functions/src/shared/callableErrorCode.ts';
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
  assert.equal(isRetryableCallableError({ code: 'functions/invalid-argument' }), false);
});
