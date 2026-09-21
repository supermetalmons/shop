import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  acquireDeliveryRecoveryLease,
  cancelDeliveryRecoveryAttempt,
  deliveryRecoveryEligibility,
  finalizeDeliveryRecoveryAttempt,
  handlePreparedRecoveryFailure,
  recordPreparedDeliveryRecoveryMiss,
  runPendingReadyNotificationQuery,
} from '../src/deliveryRecoveryStore.ts';
import {
  deliveryOrderKey,
  readDeliveryOrder,
} from '../src/deliveryReceiptStore.ts';
import { readCommerceRecord, requireCommerceKey } from '../src/commerceTransactions.ts';
import { CommerceWriteConflict, D1CommerceRepository, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { createCommerceD1Harness, seedCommerceDocument, type CommerceD1CallObservation } from './commerceD1Harness.ts';
import {
  OWNER, SIGNATURE, SECOND_SIGNATURE, READY_NOTIFICATION_NOW_MS,
  nativeDeliveryContext, readyNotificationOrderFields,
} from './deliveryStoreTestSupport.ts';

test('recovery mutation contracts require delivery keys and typed lease fields', () => {
  type RecoveryKey = Parameters<typeof acquireDeliveryRecoveryLease>[1];
  type Lease = Parameters<typeof cancelDeliveryRecoveryAttempt>[2];
  type Finalization = Parameters<typeof finalizeDeliveryRecoveryAttempt>[2];
  const boundaries: [
    ReturnType<typeof commerceKeys.stripeCheckout> extends RecoveryKey ? false : true,
    string extends RecoveryKey ? false : true,
    string extends Lease['leaseExpiresAtMs'] ? false : true,
    'lastErrorCode' extends keyof Finalization ? false : true,
    number extends Finalization['errorCode'] ? false : true,
  ] = [true, true, true, true, true];
  assert.deepEqual(boundaries, [true, true, true, true, true]);
});

test('recovery leases preserve sparse and legacy raw fields when cancellation restores the order', async (context) => {
  const fixtures: CommerceDocumentData[] = [
    {},
    { attemptCount: '2.9', lastAttemptAt: null },
    { attemptCount: { legacy: true }, lastAttemptAt: '90000' },
    { attemptCount: 0, lastAttemptAt: 0 },
  ];
  for (const original of fixtures) {
    const recovery = { ...original, custom: { keep: true } };
    const native = await nativeDeliveryContext({
      deliveryId: 7, status: 'processing', receiptRecovery: recovery, custom: ['keep'],
    });
    context.after(() => native.harness.database.close());
    const key = deliveryOrderKey('drops/card_nft_2/deliveryOrders/7');
    const result = await acquireDeliveryRecoveryLease(native.context, key, OWNER, 100_000, false);
    assert.equal(result.acquired, true);
    if (!result.acquired) assert.fail('legacy recovery fields must remain recoverable');
    assert.equal(result.lease.attemptCount, original.attemptCount === '2.9' ? 3 : 1);
    assert.deepEqual(result.lease.previousAttemptCount, original.attemptCount);
    assert.deepEqual(result.lease.previousLastAttemptAt, original.lastAttemptAt);
    await cancelDeliveryRecoveryAttempt(native.context, key, result.lease);
    const stored = await readDeliveryOrder(native.context, key);
    assert.deepEqual(stored?.data.receiptRecovery, recovery);
    assert.deepEqual(stored?.data.custom, ['keep']);
  }
});

test('recovery eligibility tolerates malformed and unknown legacy states without broad schema validation', () => {
  for (const receiptRecovery of [null, [], 'legacy', { lastAttemptAt: '99000' }]) {
    assert.deepEqual(deliveryRecoveryEligibility({ status: 'processing', receiptRecovery }, 100_000, false), { eligible: true });
  }
  for (const status of [undefined, 4, 'future-status']) {
    const order: CommerceDocumentData = status === undefined ? {} : { status };
    assert.deepEqual(deliveryRecoveryEligibility(order, 100_000, true), {
      eligible: false,
      outcome: 'skipped_status',
      message: `order status \`${typeof status === 'string' ? status : 'unknown'}\` is not recoverable`,
    });
  }
});

test('prepared recovery writes preserve newer document revisions without retrying', async (context) => {
  const native = await nativeDeliveryContext({ deliveryId: 7, status: 'prepared', receiptRecovery: { preparedProbeCount: 0 } });
  context.after(() => native.harness.database.close());
  const key = deliveryOrderKey('drops/card_nft_2/deliveryOrders/7');
  const before = await readDeliveryOrder(native.context, key);
  assert.ok(before);
  seedCommerceDocument(native.harness, {
    key,
    data: { ...before.data, receiptRecovery: { preparedProbeCount: 2, futureField: true } },
    version: before.version + 1,
  });
  await assert.rejects(
    recordPreparedDeliveryRecoveryMiss(native.context, before, 100_000),
    (error: unknown) => error instanceof CommerceWriteConflict,
  );
  const stored = await readDeliveryOrder(native.context, key);
  assert.deepEqual(stored?.data.receiptRecovery, { preparedProbeCount: 2, futureField: true });
  assert.equal(stored?.version, before.version + 1);
});

test('pending ready recovery queries all outbox marker states', async () => {
  const native = await nativeDeliveryContext(readyNotificationOrderFields(7, true));
  const result = await runPendingReadyNotificationQuery(native.context, OWNER);
  assert.equal(result.length, 1);
  assert.equal(result[0].data.buyerOrderReceivedEmailState, 'pending');
  assert.equal(result[0].data.shipperReadyToShipEmailState, 'pending');
});

test('pending ready recovery pages past malformed identities', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(READY_NOTIFICATION_NOW_MS, async (unit) => {
    for (let deliveryId = 1; deliveryId <= 8; deliveryId += 1) {
      await unit.create(
        commerceKeys.deliveryOrder('card_nft_2', String(deliveryId)),
        {
          ...readyNotificationOrderFields(deliveryId),
          deliveryId: 999,
        },
      );
    }
    await unit.create(
      commerceKeys.deliveryOrder('card_nft_2', '9'),
      readyNotificationOrderFields(9),
    );
  });
  const context = {
    repository: new D1CommerceRepository(harness.db),
    nowMs: READY_NOTIFICATION_NOW_MS,
    providerFetch: async () => assert.fail('commerce persistence must not use provider fetch'),
    signal: new AbortController().signal,
    dataDb: undefined as D1Database | undefined,
  };
  const result = await runPendingReadyNotificationQuery(context, OWNER);
  assert.deepEqual(result.map((document) => document.key.documentId), ['9']);
});

test('recovery cancellation reads its document once', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const pending = {
    signature: SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    status: 'processing',
    receiptRecovery: {
      pendingSubmission: pending,
      attemptCount: 2,
      lastAttemptAt: 100,
      leaseExpiresAt: 200,
    },
  }, { observeCall: (call) => calls.push(call) });
  calls.length = 0;
  const path = 'drops/card_nft_2/deliveryOrders/7';
  await cancelDeliveryRecoveryAttempt(
    native.context,
    deliveryOrderKey(path),
    {
      attemptCount: 2,
      lastAttemptAtMs: 100,
      leaseExpiresAtMs: 200,
      previousAttemptCount: 1,
      previousLastAttemptAt: 50,
    },
  );
  const reads = calls.flatMap((call) => call.method === 'batch' ? call.statements : [call])
    .filter(({ sql }) => sql.includes('document_json') && /\b(?:FROM|JOIN) commerce_documents\b/.test(sql));
  assert.equal(reads.length, 1);
});

test('recovery cancellation retries preserve a competing submission and recovery lease', async () => {
  const pending = {
    signature: SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  const competing = { ...pending, signature: SECOND_SIGNATURE };
  const fields = {
    deliveryId: 7,
    status: 'processing',
    receiptRecovery: {
      pendingSubmission: pending,
      attemptCount: 2,
      lastAttemptAt: 100,
      leaseExpiresAt: 200,
    },
  };
  let armed = false;
  let changed = false;
  const native = await nativeDeliveryContext(fields, {
    observeBatchAfterCommit: ({ statements }) => {
      if (!armed || changed || !statements.some(({ sql }) =>
        sql.includes('document_json') && /\b(?:FROM|JOIN) commerce_documents\b/.test(sql))) return;
      changed = true;
      seedCommerceDocument(native.harness, {
        key: commerceKeys.deliveryOrder('card_nft_2', '7'),
        data: {
          ...fields,
          receiptRecovery: {
            pendingSubmission: competing,
            attemptCount: 3,
            lastAttemptAt: 300,
            leaseExpiresAt: 400,
          },
        },
        version: 2,
      });
    },
  });
  armed = true;
  const path = 'drops/card_nft_2/deliveryOrders/7';
  await cancelDeliveryRecoveryAttempt(
    native.context,
    deliveryOrderKey(path),
    {
      attemptCount: 2,
      lastAttemptAtMs: 100,
      leaseExpiresAtMs: 200,
      previousAttemptCount: 1,
      previousLastAttemptAt: 50,
    },
  );
  assert.equal(changed, true);
  const stored = await readCommerceRecord(native.context, requireCommerceKey(path));
  assert.deepEqual(stored?.data.receiptRecovery, {
    pendingSubmission: competing,
    attemptCount: 3,
    lastAttemptAt: 300,
    leaseExpiresAt: 400,
  });
  assert.equal(stored?.data.receiptTxs, undefined);
});

test('delivery recovery eligibility preserves backoff, prepared probes, and force behavior', () => {
  assert.deepEqual(
    deliveryRecoveryEligibility({
      status: 'processing',
      receiptRecovery: { lastAttemptAt: 99_000 },
    }, 100_000, false),
    { eligible: false, outcome: 'not_eligible', message: 'processing order retry backoff is active' },
  );
  assert.deepEqual(
    deliveryRecoveryEligibility(
      {
        status: 'prepared',
        createdAt: 100,
        receiptRecovery: { preparedProbeCount: 3 },
      },
      100_000,
      false,
    ),
    { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' },
  );
  assert.deepEqual(
    deliveryRecoveryEligibility({ status: 'prepared_abandoned' }, 100_000, true),
    { eligible: true },
  );
});

test('prepared recovery failures reread the leased order and preserve retryable scheduling', async () => {
  const path = 'drops/card_nft_2/deliveryOrders/7';
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'prepared',
    receiptRecovery: { preparedProbeCount: 0, leaseExpiresAt: 90_000 },
  });
  await handlePreparedRecoveryFailure(native.context, deliveryOrderKey(path), 'missing_delivery', 'failed-precondition', 1_000);
  await handlePreparedRecoveryFailure(native.context, deliveryOrderKey(path), 'failed', 'unavailable', 2_000);
  const recovered = await readCommerceRecord(native.context, requireCommerceKey(path));
  const recovery = recovered?.data.receiptRecovery as Record<string, unknown>;
  assert.equal(recovery.preparedProbeCount, 1);
  assert.equal(recovery.lastPreparedProbeAt, 1_000);
  assert.equal(recovery.nextPreparedProbeAt, 90_000);
});
