import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyProfileShipmentSyncPlan,
  buildProfileShipment,
  classifyProfileShipmentSource,
  deliveryOrderSummaryFromProfileShipment,
  planConvergentProfileShipmentSync,
  profileShipmentDocumentId,
  profileShipmentMatchesProjection,
  toDeliveryOrderSummary,
} from '../functions/src/profileShipments.ts';
import {
  runLegacyGetProfileFlow,
  runProfileShipmentsResponseFlow,
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
const ORDER_PATH = 'drops/card_nft_2/deliveryOrders/42';

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

test('profile shipment projection allowlists the existing order summary and computes sortAt', () => {
  const projection = buildProfileShipment(
    '42',
    {
      owner: OWNER_ONE,
      deliveryId: '42',
      status: 'ready_to_ship',
      stripeCheckoutSessionId: ' cs_allowed ',
      createdAt: timestamp(100),
      processingAt: timestamp(200),
      processedAt: timestamp(300),
      items: [
        { kind: 'box', refId: '4.9', claimCode: 'item-secret' },
        { kind: 'dude', refId: 8 },
        { kind: 'box', refId: 0 },
        { kind: 'other', refId: 9 },
      ],
      fulfillmentStatus: 'Shipped',
      fulfillmentTrackingCode: ' https://tracking.example/42 ',
      fulfillmentUpdatedAt: timestamp(400),
      addressSnapshot: { full: 'secret address' },
      claimCode: 'secret-claim',
      stripeCustomerId: 'cus_secret',
      stripePaymentIntentId: 'pi_secret',
      receiptRecovery: { lastErrorMessage: 'secret recovery details' },
      source: 'stripe_offchain',
    },
    ORDER_PATH,
  );

  assert.ok(projection);
  assert.equal(projection.ownerWallet, OWNER_ONE);
  assert.equal(projection.documentId, profileShipmentDocumentId(ORDER_PATH));
  assert.deepEqual(projection.data, {
    dropId: 'card_nft_2',
    deliveryId: 42,
    status: 'ready_to_ship',
    stripeCheckoutSessionId: 'cs_allowed',
    createdAt: 100,
    processingAt: 200,
    processedAt: 300,
    items: [
      { kind: 'box', refId: 4 },
      { kind: 'dude', refId: 8 },
    ],
    fulfillmentStatus: 'Shipped',
    fulfillmentTrackingCode: 'https://tracking.example/42',
    fulfillmentUpdatedAt: 400,
    sortAt: 300,
  });
  for (const sensitiveField of [
    'owner',
    'source',
    'addressSnapshot',
    'claimCode',
    'stripeCustomerId',
    'stripePaymentIntentId',
    'receiptRecovery',
  ]) {
    assert.equal(Object.hasOwn(projection.data, sensitiveField), false);
  }
});

test('profile shipment projection omits stale optional fields on replacement', () => {
  const projection = buildProfileShipment(
    '42',
    {
      owner: OWNER_ONE,
      status: 'processing',
      items: [],
    },
    ORDER_PATH,
  );

  assert.ok(projection);
  assert.deepEqual(projection.data, {
    dropId: 'card_nft_2',
    deliveryId: 42,
    status: 'processing',
    items: [],
    sortAt: 0,
  });
});

test('profile shipment equality suppresses only exact destination replacements', () => {
  const expected = {
    dropId: 'card_nft_2',
    deliveryId: 42,
    status: 'processing',
    items: [{ kind: 'box' as const, refId: 4 }],
    sortAt: 100,
  };

  assert.equal(profileShipmentMatchesProjection({ ...expected }, expected), true);
  assert.equal(
    profileShipmentMatchesProjection(
      {
        sortAt: 100,
        items: [{ refId: 4, kind: 'box' }],
        status: 'processing',
        deliveryId: 42,
        dropId: 'card_nft_2',
      },
      expected,
    ),
    true,
  );
  assert.equal(profileShipmentMatchesProjection({ ...expected, claimCode: 'stale-secret' }, expected), false);
  assert.equal(profileShipmentMatchesProjection({ ...expected, items: [] }, expected), false);
  assert.equal(profileShipmentMatchesProjection(null, expected), false);
});

test('profile shipment sortAt falls back through processing and creation timestamps', () => {
  const processingProjection = buildProfileShipment(
    '42',
    {
      owner: OWNER_ONE,
      status: 'processing',
      createdAt: timestamp(100),
      processingAt: timestamp(200),
      items: [],
    },
    ORDER_PATH,
  );
  const createdProjection = buildProfileShipment(
    '42',
    {
      owner: OWNER_ONE,
      status: 'processing',
      createdAt: timestamp(100),
      items: [],
    },
    ORDER_PATH,
  );
  assert.equal(processingProjection?.data.sortAt, 200);
  assert.equal(createdProjection?.data.sortAt, 100);
});

test('profile shipment projection excludes unsupported orders and invalid owners', () => {
  const baseOrder = { owner: OWNER_ONE, status: 'processing', items: [] };
  assert.equal(buildProfileShipment('42', { ...baseOrder, status: 'prepared' }, ORDER_PATH), null);
  assert.equal(buildProfileShipment('42', { ...baseOrder, source: 'admin_irl_redeem' }, ORDER_PATH), null);
  assert.equal(buildProfileShipment('42', { ...baseOrder, owner: 'firebase:user-id' }, ORDER_PATH), null);
  assert.equal(
    buildProfileShipment(
      '42',
      { ...baseOrder, dropId: 'card_nft_2' },
      'archives/card_nft_2/deliveryOrders/42',
    ),
    null,
  );
  assert.equal(buildProfileShipment('42', { ...baseOrder, dropId: 'another_drop' }, ORDER_PATH), null);
  assert.equal(toDeliveryOrderSummary('42', baseOrder, 'invalid/path'), null);
});

test('profile shipment source classification separates expected exclusions from invalid active orders', () => {
  assert.deepEqual(
    classifyProfileShipmentSource(
      '42',
      { owner: OWNER_ONE, status: 'prepared', items: [] },
      ORDER_PATH,
    ),
    { kind: 'excluded' },
  );
  assert.deepEqual(
    classifyProfileShipmentSource(
      '42',
      { owner: 'firebase:uid', source: 'stripe_offchain', status: 'ready_to_ship', items: [] },
      ORDER_PATH,
    ),
    { kind: 'excluded' },
  );
  assert.deepEqual(
    classifyProfileShipmentSource(
      '42',
      { owner: 'firebase:', source: 'stripe_offchain', status: 'ready_to_ship', items: [] },
      ORDER_PATH,
    ),
    { kind: 'invalid', reason: 'invalid_owner' },
  );
  assert.deepEqual(
    classifyProfileShipmentSource(
      '42',
      { owner: 'invalid-owner', status: 'processing', items: [] },
      ORDER_PATH,
    ),
    { kind: 'invalid', reason: 'invalid_owner' },
  );
  assert.deepEqual(
    classifyProfileShipmentSource(
      '42',
      { owner: OWNER_ONE, status: 'processing', dropId: 'different_drop', items: [] },
      ORDER_PATH,
    ),
    { kind: 'invalid', reason: 'drop_id_mismatch' },
  );
  assert.deepEqual(
    classifyProfileShipmentSource(
      '42',
      { owner: OWNER_ONE, status: 'processing', deliveryId: 4.2, items: [] },
      ORDER_PATH,
    ),
    { kind: 'invalid', reason: 'invalid_delivery_id' },
  );
});

test('profile shipment identity rejects noncanonical, unsafe, and mismatched delivery ids', () => {
  const baseOrder = { owner: OWNER_ONE, status: 'processing', items: [] };
  for (const documentId of ['0', '042', '4.2', '9007199254740992']) {
    assert.deepEqual(
      classifyProfileShipmentSource(
        documentId,
        baseOrder,
        `drops/card_nft_2/deliveryOrders/${documentId}`,
      ),
      { kind: 'invalid', reason: 'invalid_delivery_id' },
    );
  }
  for (const deliveryId of [0, -1, 4.2, Number.MAX_SAFE_INTEGER + 1, null, '042', ' 42 ']) {
    assert.deepEqual(
      classifyProfileShipmentSource(
        '42',
        { ...baseOrder, deliveryId },
        ORDER_PATH,
      ),
      { kind: 'invalid', reason: 'invalid_delivery_id' },
    );
  }
  assert.deepEqual(
    classifyProfileShipmentSource('42', { ...baseOrder, deliveryId: 43 }, ORDER_PATH),
    { kind: 'invalid', reason: 'delivery_id_mismatch' },
  );
  assert.deepEqual(
    classifyProfileShipmentSource('43', baseOrder, ORDER_PATH),
    { kind: 'invalid', reason: 'delivery_id_mismatch' },
  );
  assert.deepEqual(
    classifyProfileShipmentSource(
      '01',
      { owner: OWNER_ONE, status: 'prepared', items: [] },
      'drops/card_nft_2/deliveryOrders/01',
    ),
    { kind: 'invalid', reason: 'invalid_delivery_id' },
  );
});

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

test('profile shipment sync plans owner moves, status changes, and deletion idempotently', () => {
  const beforeOrder = { owner: OWNER_ONE, status: 'processing', items: [] };
  const afterOrder = { owner: OWNER_TWO, status: 'ready_to_ship', items: [] };
  const ownerMove = planConvergentProfileShipmentSync({
    docId: '42',
    docPath: ORDER_PATH,
    beforeOrder,
    afterOrder,
    currentOrder: afterOrder,
  });

  assert.deepEqual(ownerMove.deletes, [
    { ownerWallet: OWNER_ONE, documentId: profileShipmentDocumentId(ORDER_PATH) },
  ]);
  assert.equal(ownerMove.upsert?.ownerWallet, OWNER_TWO);
  assert.deepEqual(
    planConvergentProfileShipmentSync({
      docId: '42',
      docPath: ORDER_PATH,
      beforeOrder,
      afterOrder,
      currentOrder: afterOrder,
    }),
    ownerMove,
  );

  const statusChangeOrder = { ...beforeOrder, status: 'shipped' };
  const statusChange = planConvergentProfileShipmentSync({
    docId: '42',
    docPath: ORDER_PATH,
    beforeOrder,
    afterOrder: statusChangeOrder,
    currentOrder: statusChangeOrder,
  });
  assert.equal(statusChange.deletes.length, 1);
  assert.equal(statusChange.upsert, null);

  const deletion = planConvergentProfileShipmentSync({
    docId: '42',
    docPath: ORDER_PATH,
    beforeOrder,
    afterOrder: null,
    currentOrder: null,
  });
  assert.equal(deletion.deletes.length, 1);
  assert.equal(deletion.upsert, null);

  const replacementOrder = { ...beforeOrder, fulfillmentTrackingCode: 'new-code' };
  const replacement = planConvergentProfileShipmentSync({
    docId: '42',
    docPath: ORDER_PATH,
    beforeOrder,
    afterOrder: replacementOrder,
    currentOrder: replacementOrder,
  });
  assert.deepEqual(replacement.deletes, []);
  assert.equal(replacement.upsert?.data.fulfillmentTrackingCode, 'new-code');
});

test('delayed projection events converge on the transaction current owner', () => {
  const delayedReplay = planConvergentProfileShipmentSync({
    docId: '42',
    docPath: ORDER_PATH,
    beforeOrder: { owner: OWNER_ONE, status: 'processing', items: [] },
    afterOrder: { owner: OWNER_TWO, status: 'ready_to_ship', items: [] },
    currentOrder: { owner: OWNER_THREE, status: 'ready_to_ship', items: [] },
  });
  assert.deepEqual(
    delayedReplay.deletes.map((target) => target.ownerWallet),
    [OWNER_ONE, OWNER_TWO],
  );
  assert.equal(delayedReplay.upsert?.ownerWallet, OWNER_THREE);
  assert.equal(
    delayedReplay.deletes.some((target) => target.ownerWallet === OWNER_THREE),
    false,
  );

  const projectedOwners = new Set([OWNER_ONE, OWNER_TWO, OWNER_THREE]);
  delayedReplay.deletes.forEach((target) => projectedOwners.delete(target.ownerWallet));
  if (delayedReplay.upsert) projectedOwners.add(delayedReplay.upsert.ownerWallet);
  assert.deepEqual([...projectedOwners], [OWNER_THREE]);
});

test('admin projection decoding strips sortAt and every unknown field', () => {
  const summary = deliveryOrderSummaryFromProfileShipment({
    dropId: 'card_nft_2',
    deliveryId: 42,
    status: 'ready_to_ship',
    items: [{ kind: 'box', refId: 2, claimCode: 'secret' }],
    createdAt: 100,
    sortAt: 100,
    addressSnapshot: { full: 'secret address' },
    stripePaymentIntentId: 'pi_secret',
  });

  assert.deepEqual(summary, {
    dropId: 'card_nft_2',
    deliveryId: 42,
    status: 'ready_to_ship',
    stripeCheckoutSessionId: undefined,
    createdAt: 100,
    processingAt: undefined,
    processedAt: undefined,
    items: [{ kind: 'box', refId: 2 }],
    fulfillmentStatus: undefined,
    fulfillmentTrackingCode: undefined,
    fulfillmentUpdatedAt: undefined,
  });
  assert.equal(Object.hasOwn(summary || {}, 'sortAt'), false);
  assert.equal(Object.hasOwn(summary || {}, 'addressSnapshot'), false);
  assert.equal(Object.hasOwn(summary || {}, 'stripePaymentIntentId'), false);
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

test('legacy getProfile flow preserves own-profile creation, merge ordering, and response data', async () => {
  const calls: string[] = [];
  const response = await runLegacyGetProfileFlow(
    {
      callerWallet: OWNER_ONE,
      profileWallet: OWNER_ONE,
      mergeStripeDeliveryOrders: true,
    },
    {
      loadProfile: async () => {
        calls.push('loadProfile');
        return { exists: false, data: {} };
      },
      ensureProfile: async () => {
        calls.push('ensureProfile');
      },
      mergeStripeDeliveryOrders: async () => {
        calls.push('mergeStripeDeliveryOrders');
      },
      buildResponse: async (profileData) => {
        calls.push('buildResponse');
        return { profile: { ...profileData, wallet: OWNER_ONE, orders: [] } };
      },
    },
  );

  assert.deepEqual(response, { profile: { wallet: OWNER_ONE, orders: [] } });
  assert.deepEqual(calls, [
    'loadProfile',
    'ensureProfile',
    'mergeStripeDeliveryOrders',
    'buildResponse',
  ]);
});

test('legacy getProfile flow never creates or merges a cross-wallet admin view', async () => {
  const calls: string[] = [];
  const response = await runLegacyGetProfileFlow(
    {
      callerWallet: OWNER_ONE,
      profileWallet: OWNER_TWO,
      mergeStripeDeliveryOrders: true,
    },
    {
      loadProfile: async () => {
        calls.push('loadProfile');
        return { exists: false, data: {} };
      },
      ensureProfile: async () => {
        calls.push('ensureProfile');
      },
      mergeStripeDeliveryOrders: async () => {
        calls.push('mergeStripeDeliveryOrders');
      },
      buildResponse: async () => {
        calls.push('buildResponse');
        return { profile: { wallet: OWNER_TWO, orders: [] } };
      },
    },
  );

  assert.deepEqual(response, { profile: { wallet: OWNER_TWO, orders: [] } });
  assert.deepEqual(calls, ['loadProfile', 'buildResponse']);
});

test('shipment response mode validates its owner and returns only the active wallet history', async () => {
  const loadCalls: string[] = [];
  const deps = {
    invalidMergeError: () => new Error('merge not allowed'),
    missingOwnerError: () => new Error('owner required'),
    sessionMismatchError: () => new Error('session mismatch'),
    normalizeWallet: (wallet: string) => wallet,
    loadOrders: async (wallet: string) => {
      loadCalls.push(wallet);
      return [{ deliveryId: 1 }];
    },
  };

  assert.deepEqual(
    await runProfileShipmentsResponseFlow(
      { sessionWallet: OWNER_ONE, rawOwnerWallet: ` ${OWNER_ONE} ` },
      deps,
    ),
    { responseMode: 'shipments', wallet: OWNER_ONE, orders: [{ deliveryId: 1 }] },
  );
  await assert.rejects(
    runProfileShipmentsResponseFlow(
      { sessionWallet: OWNER_ONE, rawOwnerWallet: OWNER_ONE, mergeStripeDeliveryOrders: true },
      deps,
    ),
    /merge not allowed/,
  );
  await assert.rejects(
    runProfileShipmentsResponseFlow({ sessionWallet: OWNER_ONE }, deps),
    /owner required/,
  );
  await assert.rejects(
    runProfileShipmentsResponseFlow(
      { sessionWallet: OWNER_ONE, rawOwnerWallet: OWNER_TWO },
      deps,
    ),
    /session mismatch/,
  );
  assert.deepEqual(loadCalls, [OWNER_ONE]);
});

test('projection transaction applier reads destinations before exact deletes and writes', async () => {
  const deletedPath = `profiles/${OWNER_ONE}/shipments/old`;
  const upsertPath = `profiles/${OWNER_TWO}/shipments/new`;
  const calls: string[] = [];
  const db = {
    doc: (path: string) => ({ path }),
  };
  const tx = {
    getAll: async (...refs: Array<{ path: string }>) => {
      calls.push(`read:${refs.map((ref) => ref.path).join(',')}`);
      return refs.map((ref) => ({
        ref,
        exists: ref.path === deletedPath || ref.path === upsertPath,
        data: () => ({ stale: true }),
      }));
    },
    delete: (ref: { path: string }) => {
      calls.push(`delete:${ref.path}`);
    },
    set: (ref: { path: string }, data: unknown) => {
      calls.push(`set:${ref.path}:${JSON.stringify(data)}`);
    },
  };

  await applyProfileShipmentSyncPlan(db as any, tx as any, {
    deletes: [{ ownerWallet: OWNER_ONE, documentId: 'old' }],
    upsert: {
      ownerWallet: OWNER_TWO,
      documentId: 'new',
      data: { dropId: 'drop', deliveryId: 1, status: 'processing', items: [], sortAt: 1 },
    },
  });

  assert.match(calls[0], /^read:/);
  assert.deepEqual(calls.slice(1).map((call) => call.split(':', 2).join(':')), [
    `delete:profiles/${OWNER_ONE}/shipments/old`,
    `set:profiles/${OWNER_TWO}/shipments/new`,
  ]);
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
