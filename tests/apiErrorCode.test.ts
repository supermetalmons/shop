import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRIPE_OWNER_MERGE_LIMIT_ERROR_REASON,
  WALLET_SESSION_SUPERSEDED_ERROR_REASON,
  normalizeApiErrorCode,
} from '../shared/apiErrorCode.ts';
import {
  isRetryableApiError,
  isRetryableReceiptIssuanceError,
} from '../src/lib/apiErrors.ts';

test('API error codes preserve string codes and reject non-strings', () => {
  assert.equal(normalizeApiErrorCode('unavailable'), 'unavailable');
  assert.equal(normalizeApiErrorCode(''), '');
  assert.equal(normalizeApiErrorCode(undefined), '');
});

test('frontend API retry classification accepts retryable bare codes', () => {
  assert.equal(isRetryableApiError({ code: 'unavailable' }), true);
  assert.equal(isRetryableApiError({ code: 'resource-exhausted' }), true);
  assert.equal(
    isRetryableApiError({
      code: 'resource-exhausted',
      details: { reason: STRIPE_OWNER_MERGE_LIMIT_ERROR_REASON },
    }),
    false,
  );
  assert.equal(
    isRetryableApiError({
      code: 'aborted',
      details: { reason: WALLET_SESSION_SUPERSEDED_ERROR_REASON },
    }),
    false,
  );
  assert.equal(
    isRetryableApiError({
      code: 'unavailable',
      details: { reason: WALLET_SESSION_SUPERSEDED_ERROR_REASON },
    }),
    false,
  );
  assert.equal(isRetryableApiError({ code: 'aborted' }), true);
  assert.equal(isRetryableApiError({ code: 'failed-precondition' }), false);
  assert.equal(isRetryableApiError({ code: 'invalid-argument' }), false);
});

test('receipt issuance retries temporary transaction indexing failures', () => {
  assert.equal(isRetryableReceiptIssuanceError({ code: 'unavailable' }), true);
  assert.equal(isRetryableReceiptIssuanceError({
    code: 'failed-precondition',
    message: 'Delivery transaction not found or failed.',
  }), true);
  assert.equal(isRetryableReceiptIssuanceError({
    code: 'failed-precondition',
    message: 'Delivery payer does not match owner.',
  }), false);
});
