import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRecoverDeliveryOrdersResult,
  buildWalletDeliveryRecoveryState,
  preparedDeliveryRecoveryNextCheckMs,
  processingDeliveryRecoveryNextCheckMs,
} from '../shared/deliveryRecovery.ts';
import { dropDeliveryOrderPath } from '../cloud/workers/api/src/dropPaths.ts';
import {
  parseSolanaSignInMessage,
  resolveWalletSessionBinding,
  validateSolanaSignInMessage,
  WalletLifecycleValidationError,
} from '../shared/walletLifecycle.ts';
import {
  isPositiveSafeInteger,
  parseCanonicalPositiveInteger,
} from '../shared/positiveInteger.ts';

const OWNER_ONE = '11111111111111111111111111111111';
const OWNER_TWO = 'So11111111111111111111111111111111111111112';

test('positive delivery ids are canonical across parsing and path construction', () => {
  assert.equal(isPositiveSafeInteger(42), true);
  assert.equal(isPositiveSafeInteger(0), false);
  assert.equal(parseCanonicalPositiveInteger('42'), 42);
  for (const value of ['0', '042', '+42', '-42', '4.2', ' 42 ', '9007199254740992']) {
    assert.equal(parseCanonicalPositiveInteger(value), null);
  }
  assert.equal(dropDeliveryOrderPath('drop', 42), 'drops/drop/deliveryOrders/42');
});

test('wallet recovery scheduling remains runtime-neutral and deterministic', () => {
  assert.equal(processingDeliveryRecoveryNextCheckMs({
    status: 'processing',
    receiptRecovery: { lastAttemptAt: 1_000, leaseExpiresAt: 20_000 },
  }, 10_000), 31_000);
  assert.equal(preparedDeliveryRecoveryNextCheckMs({
    status: 'prepared',
    createdAt: 1_000,
    receiptRecovery: { preparedProbeCount: 1 },
  }, 10_000), 121_000);
  const walletRecovery = buildWalletDeliveryRecoveryState({
    remainingProcessing: 2,
    nextCheckCandidates: [9_000, 3_000, 6_000, null],
  });
  assert.deepEqual(walletRecovery, { remainingProcessing: 2, nextCheckAt: 3_000 });
  assert.deepEqual(buildRecoverDeliveryOrdersResult({
    attempted: 1,
    recovered: 0,
    walletRecovery,
    results: [],
  }), {
    attempted: 1,
    recovered: 0,
    remainingProcessing: 2,
    nextCheckAt: 3_000,
    walletRecovery,
    results: [],
  });
});

test('wallet session resolution preserves bound and legacy wallet behavior', () => {
  assert.deepEqual(resolveWalletSessionBinding({
    uid: OWNER_ONE,
    sessionExists: false,
    sessionData: null,
  }), { wallet: OWNER_ONE, source: 'legacy_uid' });
  assert.deepEqual(resolveWalletSessionBinding({
    uid: 'firebase-uid',
    sessionExists: false,
    sessionData: null,
  }), { wallet: null, reason: 'legacy_uid_invalid' });
  assert.deepEqual(resolveWalletSessionBinding({
    uid: 'firebase-uid',
    sessionExists: true,
    sessionData: { wallet: OWNER_TWO },
  }), { wallet: OWNER_TWO, source: 'session' });
  for (const sessionData of [{}, { wallet: '' }, { wallet: ` ${OWNER_ONE}` }]) {
    assert.ok('reason' in resolveWalletSessionBinding({ uid: OWNER_ONE, sessionExists: true, sessionData }));
  }
});

test('shared sign-in parsing validates wallet, session, domain, and timestamp', () => {
  const nowMs = Date.parse('2026-08-20T12:00:00.000Z');
  const message = parseSolanaSignInMessage(
    `Sign in to mons.shop as ${OWNER_ONE}\nDomain: mons.shop\nTimestamp: 2026-08-20T12:00:00.000Z\nSession: uid`,
  );
  assert.doesNotThrow(() => validateSolanaSignInMessage({
    message,
    nowMs,
    originHostname: 'mons.shop',
    uid: 'uid',
    wallet: OWNER_ONE,
  }));
  assert.throws(() => validateSolanaSignInMessage({
    message,
    nowMs,
    originHostname: 'www.mons.shop',
    uid: 'uid',
    wallet: OWNER_ONE,
  }), WalletLifecycleValidationError);
});
