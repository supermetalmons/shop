import assert from 'node:assert/strict';
import test from 'node:test';
import { WalletLifecycleValidationError } from '../../../../shared/walletLifecycle.ts';
import { STRIPE_CHECKOUT_RETRY_HEADER } from '../../../../shared/contracts.ts';
import { StripeCheckoutSessionError } from '../../../../shared/stripeCheckoutSession.ts';
import { ProfileReadError, type ApiErrorCode } from '../src/dataAccess.ts';
import { PROFILE_STATE_PATH, handleProfileReadRequest } from '../src/profileReads.ts';
import { ADMIN_DELIVERY_ORDER_OWNERS_PATH, handleStaffReadRequest } from '../src/staffReads.ts';
import { PROFILE_ADDRESSES_PATH, handleProfileWriteRequest } from '../src/profileWrites.ts';
import { PROFILE_RECONCILE_PATH, handleProfileLifecycleRequest } from '../src/profileLifecycle.ts';
import { RequestIdentityError, type verifyRequestIdentity } from '../src/requestIdentity.ts';
import { ShipStationProfileError } from '../src/shipstation/common.ts';
import { handleStripeCheckoutSession } from '../src/stripeCheckout.ts';
import { handleStripeReceiptClaim } from '../src/stripeReceiptClaim.ts';
import { StripeReceiptClaimError } from '../src/stripeReceiptClaimErrors.ts';
import { failOnDeferredWork } from './deferredWork.ts';

const database = {} as D1Database;
const identity = { kind: 'anonymous' as const, authSubject: 'error-contract-subject' };
const checkoutEnv = {
  COMMERCE_DB: database,
  HELIUS_API_KEY: '',
  COSIGNER_SECRET: '',
  ADDRESS_DECRYPTION_SECRET: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_RESTRICTED_KEY: '',
  STRIPE_SECRET_KEY_LIVE: '',
  STRIPE_RESTRICTED_KEY_LIVE: '',
};

function request(path: string, body: unknown = {}): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://mons.shop' },
    body: JSON.stringify(body),
  });
}

async function throwAfterDeadline(signal: AbortSignal, error: unknown): Promise<never> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }
  throw error;
}

function profileRequest(kind: 'read' | 'staff-read' | 'write' | 'lifecycle', error: unknown, authenticated: boolean, timedOut = false) {
  const dependencies = {
    timeoutMs: timedOut ? 1 : 1000,
    nowMs: () => 1_700_000_000_000,
    verifyIdentity: (async (_request, _db, signal) => {
      if (timedOut) return throwAfterDeadline(signal, error);
      if (!authenticated) throw error;
      return kind === 'staff-read'
        ? { kind: 'staff-wallet', wallet: 'So11111111111111111111111111111111111111112' }
        : identity;
    }) satisfies typeof verifyRequestIdentity,
    createCommerceRepository: () => { throw error; },
    providerFetch: async () => assert.fail('Error contract must not contact a provider'),
  };
  const env = { COMMERCE_DB: database, OPS_DB: database };
  if (kind === 'read') {
    return handleProfileReadRequest(request(PROFILE_STATE_PATH), env, PROFILE_STATE_PATH, {}, dependencies);
  }
  if (kind === 'staff-read') {
    return handleStaffReadRequest(request(ADMIN_DELIVERY_ORDER_OWNERS_PATH), env, ADMIN_DELIVERY_ORDER_OWNERS_PATH, {}, dependencies);
  }
  if (kind === 'write') {
    return handleProfileWriteRequest(request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'cipher', country: 'US', hint: 'hint',
    }), env, PROFILE_ADDRESSES_PATH, {}, dependencies);
  }
  return handleProfileLifecycleRequest(request(PROFILE_RECONCILE_PATH), env, PROFILE_RECONCILE_PATH, {}, dependencies);
}

test('profile error contracts preserve route-specific outcomes, status, and details', async () => {
  const codes: ApiErrorCode[] = ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found',
    'failed-precondition', 'resource-exhausted', 'aborted', 'unavailable', 'internal'];
  for (const kind of ['read', 'staff-read', 'write', 'lifecycle'] as const) {
    const rejected = kind === 'read' || kind === 'staff-read'
      ? ['invalid-argument', 'unauthenticated', 'permission-denied']
      : ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'aborted'];
    for (const authenticated of [false, true]) {
      for (const code of codes) {
        const details = { reason: 'original-details' };
        const result = await profileRequest(kind, new ProfileReadError(code, 503, 'Original message.', details), authenticated);
        assert.equal(result.response.status, 503, `${kind}: ${code}`);
        assert.deepEqual(await result.response.json(), { ok: false, error: { code, message: 'Original message.', details } });
        assert.equal(result.authOutcome, !authenticated || rejected.includes(code) ? 'rejected' : 'provider-failure', `${kind}: ${code}`);
      }
    }
  }
});

test('profile known errors and identity failures preserve precedence over an expired deadline', async () => {
  for (const kind of ['read', 'staff-read', 'write', 'lifecycle'] as const) {
    const known = await profileRequest(kind, new ProfileReadError('not-found', 404, 'Original message.'), false, true);
    assert.equal(known.response.status, 404);
    assert.deepEqual(await known.response.json(), { ok: false, error: { code: 'not-found', message: 'Original message.' } });
    for (const identityKind of ['invalid-token', 'provider-timeout', 'provider-unavailable'] as const) {
      const result = await profileRequest(kind, new RequestIdentityError(identityKind), false, true);
      assert.equal(result.response.status, identityKind === 'invalid-token' ? 401 : identityKind === 'provider-timeout' ? 504 : 502);
      assert.equal(result.authOutcome, (kind === 'read' || kind === 'staff-read') && identityKind !== 'invalid-token' ? 'provider-failure' : 'rejected');
    }
  }
});

test('profile domain exceptions preserve ShipStation and wallet validation outcomes', async () => {
  for (const authenticated of [false, true]) {
    const result = await profileRequest('write', new ShipStationProfileError('failed-precondition', 409, 'Provider configuration.'), authenticated);
    assert.equal(result.authOutcome, 'provider-failure');
    assert.equal(result.response.status, 409);
  }
  for (const [code, status] of [['invalid-argument', 400], ['permission-denied', 403], ['failed-precondition', 409]] as const) {
    const result = await profileRequest('lifecycle', new WalletLifecycleValidationError(code, 'Wallet validation.'), true);
    assert.equal(result.authOutcome, 'rejected');
    assert.equal(result.response.status, status);
    assert.deepEqual(await result.response.json(), { ok: false, error: { code, message: 'Wallet validation.' } });
  }
});

test('checkout identity errors win expired deadlines without retry guidance', async () => {
  for (const kind of ['invalid-token', 'provider-timeout', 'provider-unavailable'] as const) {
    const result = await handleStripeCheckoutSession(request('/checkout/session'), checkoutEnv, {}, {
      timeoutMs: 1,
      verifyIdentity: async (_request, _db, signal) => throwAfterDeadline(signal, new RequestIdentityError(kind)),
    });
    assert.equal(result.response.status, kind === 'invalid-token' ? 401 : kind === 'provider-timeout' ? 504 : 502);
    assert.equal(result.authOutcome, kind === 'invalid-token' ? 'rejected' : 'provider-failure');
    assert.equal(result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
  }
});

test('checkout pre-auth domain, unknown, and expired-deadline outcomes remain distinct', async () => {
  for (const [error, code, status, authOutcome] of [
    [new StripeCheckoutSessionError('unavailable', 'Checkout unavailable.', { reference: 'checkout' }), 'unavailable', 502, 'provider-failure'],
    [new StripeCheckoutSessionError('failed-precondition', 'Checkout blocked.'), 'failed-precondition', 409, 'rejected'],
    [new ProfileReadError('permission-denied', 403, 'Private message.'), 'unavailable', 502, 'provider-failure'],
    [new Error('Private failure.'), 'internal', 500, 'provider-failure'],
  ] as const) {
    const result = await handleStripeCheckoutSession(request('/checkout/session'), checkoutEnv, {}, {
      verifyIdentity: async () => { throw error; },
    });
    assert.equal(result.response.status, status);
    assert.equal(result.authOutcome, authOutcome);
    const body = await result.response.json() as { error: { code: string; details?: unknown } };
    assert.equal(body.error.code, code);
    if (error instanceof StripeCheckoutSessionError) assert.deepEqual(body.error.details, error.details);
    assert.equal(result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), null);
  }
  const result = await handleStripeCheckoutSession(request('/checkout/session'), checkoutEnv, {}, {
    timeoutMs: 1,
    verifyIdentity: async (_request, _db, signal) => throwAfterDeadline(signal, new StripeCheckoutSessionError('failed-precondition', 'Checkout blocked.')),
  });
  assert.equal(result.response.status, 504);
  assert.equal(result.authOutcome, 'rejected');
  assert.equal(result.response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), 'same-operation');
});

test('receipt claim errors preserve details, pre-auth outcomes, and normalized internal logging', async (context) => {
  const logs: unknown[] = [];
  context.mock.method(console, 'error', (entry: unknown) => logs.push(entry));
  for (const authenticated of [false, true]) {
    for (const code of ['invalid-argument', 'unauthenticated', 'not-found', 'aborted', 'internal'] as const) {
      const error = new StripeReceiptClaimError(code, 'Claim failed.', { reason: 'original-details' });
      const result = await handleStripeReceiptClaim(request('/stripe/receipt/claim', {
        code: 'ABCDEF-1234567890', recipient: 'So11111111111111111111111111111111111111112',
      }), { COMMERCE_DB: database, HELIUS_API_KEY: 'helius', COSIGNER_SECRET: 'cosigner' }, failOnDeferredWork, {}, {
        verifyIdentity: async () => { if (!authenticated) throw error; return identity; },
        claim: async () => { throw error; },
      });
      assert.deepEqual(await result.response.json(), { ok: false, error: { code, message: error.message, details: error.details } });
      assert.equal(result.authOutcome, code === 'unauthenticated' || (authenticated && ['invalid-argument', 'not-found'].includes(code)) ? 'rejected' : 'provider-failure');
      assert.equal(result.outcome, code);
      assert.equal(result.response.headers.get('Timing-Allow-Origin'), '*');
    }
  }
  assert.equal(logs.length, 2);
});

test('receipt claim deadline wins identity errors and preserves the pre-auth provider outcome', async () => {
  const result = await handleStripeReceiptClaim(request('/stripe/receipt/claim', {
    code: 'ABCDEF-1234567890', recipient: 'So11111111111111111111111111111111111111112',
  }), { COMMERCE_DB: database, HELIUS_API_KEY: 'helius', COSIGNER_SECRET: 'cosigner' }, failOnDeferredWork, {}, {
    timeoutMs: 1,
    verifyIdentity: async (_request, _db, signal) => throwAfterDeadline(signal, new RequestIdentityError('invalid-token')),
  });
  assert.equal(result.response.status, 504);
  assert.equal(result.authOutcome, 'provider-failure');
  assert.deepEqual(await result.response.json(), { ok: false, error: { code: 'deadline-exceeded', message: 'Receipt claim request timed out.' } });
});
