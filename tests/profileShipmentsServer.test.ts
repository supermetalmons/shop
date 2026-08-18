import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runProfileStateReconciliationFlow,
  runVerifiedSolanaAuthProfileFlow,
} from '../functions/src/profileLifecycle.ts';
import {
  WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS,
  WalletSessionWriteSupersededError,
  establishVerifiedWalletSession,
  readWalletSessionBaseline,
  resolveWalletSessionBinding,
  writeWalletSessionAndProfileIfCurrent,
} from '../functions/src/walletSessions.ts';
import { WALLET_SESSION_SUPERSEDED_ERROR_REASON } from '../functions/src/shared/callableErrorCode.ts';
import {
  buildRecoverDeliveryOrdersResult,
  buildWalletDeliveryRecoveryState,
} from '../functions/src/deliveryRecovery.ts';
import { dropDeliveryOrderPath } from '../functions/src/dropPaths.ts';
import {
  isPositiveSafeInteger,
  parseCanonicalPositiveInteger,
} from '../functions/src/shared/positiveInteger.ts';

const OWNER_ONE = '11111111111111111111111111111111';
const OWNER_TWO = 'So11111111111111111111111111111111111111112';
const OWNER_THREE = 'Stake11111111111111111111111111111111111111';

function timestamp(millis: number) {
  return { toMillis: () => millis };
}

function createWalletSessionDb(initialDocuments: Record<string, Record<string, unknown>> = {}) {
  let nextVersion = 1;
  let commitCount = 0;
  let failNextCommit = false;
  const documents = new Map<string, { data: Record<string, unknown>; version: number }>();
  for (const [path, data] of Object.entries(initialDocuments)) {
    documents.set(path, { data: { ...data }, version: nextVersion++ });
  }

  const snapshot = (path: string) => {
    const entry = documents.get(path);
    return entry
      ? {
          exists: true,
          data: () => ({ ...entry.data }),
          updateTime: { seconds: entry.version, nanoseconds: 0 },
        }
      : { exists: false, data: () => undefined, updateTime: undefined };
  };

  const db = {
    doc(path: string) {
      return { path, get: async () => snapshot(path) };
    },
    async runTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      const writes: Array<{ path: string; data: Record<string, unknown>; merge: boolean }> = [];
      const result = await callback({
        get: async (ref: { path: string }) => snapshot(ref.path),
        set: (
          ref: { path: string },
          data: Record<string, unknown>,
          options?: { merge?: boolean },
        ) => {
          writes.push({ path: ref.path, data, merge: options?.merge === true });
        },
      });
      if (failNextCommit) {
        failNextCommit = false;
        throw new Error('transaction commit failed');
      }
      for (const write of writes) {
        const current = documents.get(write.path)?.data;
        documents.set(write.path, {
          data: write.merge ? { ...(current || {}), ...write.data } : { ...write.data },
          version: nextVersion++,
        });
      }
      commitCount += 1;
      return result;
    },
  };

  return {
    db,
    get commitCount() {
      return commitCount;
    },
    data(path: string) {
      return documents.get(path)?.data;
    },
    set(path: string, data: Record<string, unknown>) {
      documents.set(path, { data: { ...data }, version: nextVersion++ });
    },
    failCommit() {
      failNextCommit = true;
    },
  };
}

test('positive delivery ids are canonical across parsing and path construction', () => {
  assert.equal(isPositiveSafeInteger(42), true);
  assert.equal(isPositiveSafeInteger(0), false);
  assert.equal(parseCanonicalPositiveInteger('42'), 42);
  for (const value of ['0', '042', '+42', '-42', '4.2', ' 42 ', '9007199254740992']) {
    assert.equal(parseCanonicalPositiveInteger(value), null);
  }
  assert.equal(dropDeliveryOrderPath('drop', 42), 'drops/drop/deliveryOrders/42');
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => dropDeliveryOrderPath('drop', value), /positive safe integer/);
  }
});

test('verified Solana auth session mode skips every legacy profile task', async () => {
  const calls: string[] = [];
  const response = await runVerifiedSolanaAuthProfileFlow(
    { wallet: OWNER_ONE, responseMode: 'session' },
    {
      invalidSessionMergeError: () => new Error('invalid combination'),
      establishSession: async () => {
        calls.push('establishSession');
      },
      loadProfile: async () => {
        calls.push('loadProfile');
        return { exists: true, data: { email: 'owner@example.com' } };
      },
      mergeStripeDeliveryOrders: async () => {
        calls.push('mergeStripeDeliveryOrders');
      },
      buildLegacyResponse: async () => {
        calls.push('buildLegacyResponse');
        return { profile: { wallet: OWNER_ONE } };
      },
    },
  );

  assert.deepEqual(response, { wallet: OWNER_ONE });
  assert.deepEqual(calls, ['establishSession']);
});

test('verified Solana auth keeps the default legacy response flow and rejects session merging', async () => {
  const calls: string[] = [];
  const legacyResponse = { profile: { wallet: OWNER_ONE, orders: [] } };
  const deps = {
    invalidSessionMergeError: () => new Error('invalid combination'),
    establishSession: async () => {
      calls.push('establishSession');
    },
    loadProfile: async () => {
      calls.push('loadProfile');
      return { exists: true, data: { email: 'owner@example.com' } };
    },
    mergeStripeDeliveryOrders: async () => {
      calls.push('mergeStripeDeliveryOrders');
    },
    buildLegacyResponse: async (profileData: any) => {
      calls.push(`buildLegacyResponse:${profileData.email}`);
      return legacyResponse;
    },
  };

  assert.deepEqual(
    await runVerifiedSolanaAuthProfileFlow(
      { wallet: OWNER_ONE, mergeStripeDeliveryOrders: true },
      deps,
    ),
    legacyResponse,
  );
  assert.deepEqual(calls, [
    'establishSession',
    'loadProfile',
    'mergeStripeDeliveryOrders',
    'buildLegacyResponse:owner@example.com',
  ]);

  calls.length = 0;
  await assert.rejects(
    runVerifiedSolanaAuthProfileFlow(
      { wallet: OWNER_ONE, responseMode: 'session', mergeStripeDeliveryOrders: true },
      deps,
    ),
    /invalid combination/,
  );
  assert.deepEqual(calls, []);
});

test('profile reconciliation merges Stripe ownership before loading recovery state', async () => {
  const calls: string[] = [];
  const result = await runProfileStateReconciliationFlow(
    { mergeStripeDeliveryOrders: true, includeDeliveryRecovery: true },
    {
      mergeStripeDeliveryOrders: async () => {
        calls.push('merge');
        return 2;
      },
      loadDeliveryRecovery: async () => {
        calls.push('recovery');
        return { nextCheckAt: 123 };
      },
    },
  );
  assert.deepEqual(calls, ['merge', 'recovery']);
  assert.deepEqual(result, {
    mergedStripeDeliveryOrders: 2,
    deliveryRecovery: { nextCheckAt: 123 },
  });
});

test('wallet recovery scheduling selects the earliest deadline across drops and clears globally', () => {
  const walletRecovery = buildWalletDeliveryRecoveryState({
    remainingProcessing: 2,
    nextCheckCandidates: [9_000, 3_000, 6_000, null],
  });
  assert.deepEqual(walletRecovery, { remainingProcessing: 2, nextCheckAt: 3_000 });
  assert.deepEqual(
    buildRecoverDeliveryOrdersResult({
      attempted: 1,
      recovered: 0,
      walletRecovery,
      results: [],
    }),
    {
      attempted: 1,
      recovered: 0,
      remainingProcessing: 2,
      nextCheckAt: 3_000,
      walletRecovery,
      results: [],
    },
  );

  const missingTarget = {
    dropId: 'drop-a',
    deliveryId: 42,
    statusBefore: 'missing',
    outcome: 'not_found' as const,
    verification: 'delivery_pda' as const,
  };
  assert.deepEqual(
    buildRecoverDeliveryOrdersResult({
      attempted: 0,
      recovered: 0,
      walletRecovery,
      results: [missingTarget],
    }),
    {
      attempted: 0,
      recovered: 0,
      remainingProcessing: 2,
      nextCheckAt: 3_000,
      walletRecovery,
      results: [missingTarget],
    },
  );

  const settled = buildWalletDeliveryRecoveryState({
    remainingProcessing: 0,
    nextCheckCandidates: [],
  });
  assert.deepEqual(settled, { remainingProcessing: 0, nextCheckAt: null });
  assert.deepEqual(
    buildRecoverDeliveryOrdersResult({
      attempted: 0,
      recovered: 0,
      walletRecovery: settled,
      results: [],
    }),
    {
      attempted: 0,
      recovered: 0,
      remainingProcessing: 0,
      walletRecovery: settled,
      results: [],
    },
  );
});

test('wallet session resolution accepts absent-document legacy fallback or canonical bound sessions', () => {
  assert.deepEqual(
    resolveWalletSessionBinding({
      uid: OWNER_ONE,
      sessionExists: false,
      sessionData: null,
    }),
    { wallet: OWNER_ONE, source: 'legacy_uid' },
  );
  assert.deepEqual(
    resolveWalletSessionBinding({
      uid: 'firebase-uid',
      sessionExists: false,
      sessionData: null,
    }),
    { wallet: null, reason: 'legacy_uid_invalid' },
  );
  assert.deepEqual(
    resolveWalletSessionBinding({
      uid: 'firebase-uid',
      sessionExists: true,
      sessionData: { wallet: OWNER_TWO },
    }),
    { wallet: OWNER_TWO, source: 'session' },
  );
});

test('wallet session resolution rejects existing unbound or invalid wallet documents without UID fallback', () => {
  for (const sessionData of [
    {},
    { wallet: '' },
  ]) {
    assert.deepEqual(
      resolveWalletSessionBinding({ uid: OWNER_ONE, sessionExists: true, sessionData }),
      { wallet: null, reason: 'missing_wallet' },
    );
  }
  assert.deepEqual(
    resolveWalletSessionBinding({
      uid: OWNER_ONE,
      sessionExists: true,
      sessionData: { wallet: 'not-a-wallet' },
    }),
    { wallet: null, reason: 'invalid_wallet' },
  );
  assert.deepEqual(
    resolveWalletSessionBinding({
      uid: OWNER_ONE,
      sessionExists: true,
      sessionData: { wallet: ` ${OWNER_ONE}` },
    }),
    { wallet: null, reason: 'invalid_wallet' },
  );
});

test('wallet session resolution ignores missing, malformed, and past legacy expiry metadata', () => {
  for (const expiresAt of [
    undefined,
    new Date(10_001),
    timestamp(Number.NaN),
    timestamp(Number.POSITIVE_INFINITY),
    { toMillis: () => { throw new Error('malformed'); } },
    timestamp(0),
  ]) {
    assert.deepEqual(
      resolveWalletSessionBinding({
        uid: 'firebase-uid',
        sessionExists: true,
        sessionData: { wallet: OWNER_ONE, ...(expiresAt === undefined ? {} : { expiresAt }) },
      }),
      { wallet: OWNER_ONE, source: 'session' },
    );
  }
});

test('wallet session baselines make overlapping different-wallet writes first-committer safe', async () => {
  const uid = 'firebase-uid';
  const sessionPath = `authSessions/${uid}`;
  const state = createWalletSessionDb({
    [sessionPath]: {
      wallet: OWNER_ONE,
      updatedAt: timestamp(10_000),
      expiresAt: timestamp(50_000),
    },
  });
  const firstBaseline = await readWalletSessionBaseline(state.db as any, uid);
  const secondBaseline = await readWalletSessionBaseline(state.db as any, uid);

  await writeWalletSessionAndProfileIfCurrent({
    db: state.db as any,
    uid,
    wallet: OWNER_TWO,
    baseline: firstBaseline,
  });
  await assert.rejects(
    writeWalletSessionAndProfileIfCurrent({
      db: state.db as any,
      uid,
      wallet: OWNER_THREE,
      baseline: secondBaseline,
    }),
    WalletSessionWriteSupersededError,
  );

  assert.equal(state.commitCount, 1);
  assert.equal(state.data(sessionPath)?.wallet, OWNER_TWO);
  assert.equal(state.data(`profiles/${OWNER_TWO}`)?.wallet, OWNER_TWO);
  assert.equal(state.data(`profiles/${OWNER_THREE}`), undefined);
});

test('wallet session baseline changes do not block same-wallet renewal', async () => {
  const uid = 'firebase-uid';
  const sessionPath = `authSessions/${uid}`;
  const state = createWalletSessionDb({
    [sessionPath]: { wallet: OWNER_ONE, expiresAt: timestamp(50_000) },
  });
  const baseline = await readWalletSessionBaseline(state.db as any, uid);
  state.set(sessionPath, { wallet: OWNER_TWO, expiresAt: timestamp(60_000) });

  await writeWalletSessionAndProfileIfCurrent({
    db: state.db as any,
    uid,
    wallet: OWNER_TWO,
    baseline,
  });

  assert.equal(state.data(sessionPath)?.wallet, OWNER_TWO);
  assert.equal(
    (state.data(sessionPath)?.expiresAt as any).toMillis(),
    WALLET_SESSION_COMPATIBILITY_EXPIRES_AT_MS,
  );
  assert.ok(state.data(sessionPath)?.updatedAt);
  assert.equal(state.data(`profiles/${OWNER_TWO}`)?.wallet, OWNER_TWO);
});

test('wallet session and profile writes fail atomically', async () => {
  const uid = 'firebase-uid';
  const sessionPath = `authSessions/${uid}`;
  const state = createWalletSessionDb({
    [sessionPath]: { wallet: OWNER_ONE, expiresAt: timestamp(50_000) },
  });
  const baseline = await readWalletSessionBaseline(state.db as any, uid);
  state.failCommit();

  await assert.rejects(
    writeWalletSessionAndProfileIfCurrent({
      db: state.db as any,
      uid,
      wallet: OWNER_TWO,
      baseline,
    }),
    /transaction commit failed/,
  );

  assert.equal(state.commitCount, 0);
  assert.equal(state.data(sessionPath)?.wallet, OWNER_ONE);
  assert.equal(state.data(`profiles/${OWNER_TWO}`), undefined);
});

test('wallet session writers reject noncanonical wallet text before opening a transaction', async () => {
  const uid = 'firebase-uid';
  const state = createWalletSessionDb();
  const baseline = await readWalletSessionBaseline(state.db as any, uid);
  await assert.rejects(
    writeWalletSessionAndProfileIfCurrent({
      db: state.db as any,
      uid,
      wallet: ` ${OWNER_ONE}`,
      baseline,
    }),
    /must be canonical/,
  );
  assert.equal(state.commitCount, 0);
});

test('wallet session baseline rejects a competing creation after an absent read', async () => {
  const uid = 'firebase-uid';
  const sessionPath = `authSessions/${uid}`;
  const state = createWalletSessionDb();
  const baseline = await readWalletSessionBaseline(state.db as any, uid);
  state.set(sessionPath, { wallet: OWNER_TWO, expiresAt: timestamp(60_000) });

  await assert.rejects(
    writeWalletSessionAndProfileIfCurrent({
      db: state.db as any,
      uid,
      wallet: OWNER_ONE,
      baseline,
    }),
    WalletSessionWriteSupersededError,
  );
  assert.equal(state.data(sessionPath)?.wallet, OWNER_TWO);
  assert.equal(state.data(`profiles/${OWNER_ONE}`), undefined);
});

test('wallet session establishment reads its baseline before verification and writing', async () => {
  const calls: string[] = [];
  await establishVerifiedWalletSession({
    readBaseline: async () => {
      calls.push('baseline');
      return { version: 1 };
    },
    verifySignature: () => {
      calls.push('verify');
      return true;
    },
    invalidSignatureError: () => new Error('invalid signature'),
    writeSession: async (baseline) => {
      calls.push(`write:${baseline.version}`);
    },
  });
  assert.deepEqual(calls, ['baseline', 'verify', 'write:1']);

  calls.length = 0;
  await assert.rejects(
    establishVerifiedWalletSession({
      readBaseline: async () => {
        calls.push('baseline');
        return { version: 2 };
      },
      verifySignature: () => {
        calls.push('verify');
        return false;
      },
      invalidSignatureError: () => new Error('invalid signature'),
      writeSession: async () => {
        calls.push('write');
      },
    }),
    /invalid signature/,
  );
  assert.deepEqual(calls, ['baseline', 'verify']);
  assert.equal(WALLET_SESSION_SUPERSEDED_ERROR_REASON, 'wallet-session-superseded');
});
