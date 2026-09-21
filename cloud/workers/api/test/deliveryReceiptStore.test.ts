import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import {
  assignmentClaimCompatible,
  confirmedReceiptTransactions,
  deliveryOrderDocument,
  deliveryOrderKey,
  markDeliveryProcessing,
  markDeliveryReady,
  pendingReceiptSubmission,
  persistPendingReceiptSubmission,
  readDeliveryOrder,
  recordDeliveryClose,
  settlePendingReceiptSubmission,
  type DeliveryReceiptCompletion,
} from '../src/deliveryReceiptStore.ts';
import { readCommerceRecord, requireCommerceKey } from '../src/commerceTransactions.ts';
import { DeliveryReceiptError, runtimeForDrop } from '../src/deliveryReceiptOnchain.ts';
import { commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { publishReadyToShipNotifications } from '../src/readyToShipNotificationOutbox.ts';
import {
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
} from '../src/readyToShipNotifications.ts';
import { IRL_CLAIM_CODE_NAMESPACE } from '../src/claimCodes.ts';
import { seedCommerceDocument, type CommerceD1CallObservation } from './commerceD1Harness.ts';
import {
  OWNER, SIGNATURE, SECOND_SIGNATURE, READY_NOTIFICATION_NOW_MS,
  nativeDeliveryContext, notificationQueue, readyNotificationOrderFields, deliveryCleanupContext,
} from './deliveryStoreTestSupport.ts';

test('receipt mutation contracts require delivery keys and typed completion fields', () => {
  type CloseKey = Parameters<typeof recordDeliveryClose>[1];
  type PersistKey = Parameters<typeof persistPendingReceiptSubmission>[1];
  type CheckoutKey = ReturnType<typeof commerceKeys.stripeCheckout>;
  const boundaries: [
    CheckoutKey extends CloseKey ? false : true,
    string extends PersistKey ? false : true,
    'receiptMinted' extends keyof DeliveryReceiptCompletion ? false : true,
    string extends DeliveryReceiptCompletion['receiptsMinted'] ? false : true,
    number[] extends DeliveryReceiptCompletion['receiptTxs'] ? false : true,
  ] = [true, true, true, true, true];
  assert.deepEqual(boundaries, [true, true, true, true, true]);
});

test('delivery document adapters preserve sparse data, unknown fields, and repository metadata', async (context) => {
  const fixtures: CommerceDocumentData[] = [
    {},
    { status: 'future-status', receiptRecovery: 'legacy', processedAt: 1_600_000_000_000, custom: { flag: true, tags: [1, null] } },
  ];
  for (const fields of fixtures) {
    const native = await nativeDeliveryContext(fields);
    context.after(() => native.harness.database.close());
    const key = deliveryOrderKey('drops/card_nft_2/deliveryOrders/7');
    const record = await native.context.repository.get(key);
    assert.ok(record);
    const document = deliveryOrderDocument(record);
    assert.deepEqual(document, record);
    assert.equal(document.data, record.data);
    assert.deepEqual(await readDeliveryOrder(native.context, key), record);
    assert.deepEqual(document.data, fields);
    assert.throws(() => deliveryOrderDocument({
      ...record,
      key: commerceKeys.stripeCheckout('card_nft_2', 'session'),
    }), /Invalid delivery order document kind/);
  }
  assert.throws(() => deliveryOrderKey('drops/card_nft_2/stripeCheckouts/session'), /Invalid delivery order document path/);
});

test('receipt readers preserve legacy normalization and reject malformed pending submissions', () => {
  const pending = {
    signature: SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  assert.deepEqual(confirmedReceiptTransactions({ receiptTxs: [SIGNATURE, null, 'invalid', SIGNATURE, SECOND_SIGNATURE] }), [SIGNATURE, SECOND_SIGNATURE]);
  for (const receiptRecovery of [undefined, null, [], 'legacy', { pendingSubmission: null }]) {
    assert.equal(pendingReceiptSubmission({ receiptRecovery }), undefined);
  }
  assert.deepEqual(pendingReceiptSubmission({
    receiptRecovery: {
      pendingSubmission: {
        ...pending,
        signature: ` ${SIGNATURE} `,
        lastValidBlockHeight: '123.9',
        assetIds: pending.assetIds.map((assetId) => ` ${assetId} `),
        futureField: true,
      }
    }
  }), pending);
  for (const malformed of [[], 'legacy', { ...pending, signature: 'invalid' }, { ...pending, assetIds: [...pending.assetIds, ...pending.assetIds] }]) {
    assert.throws(
      () => pendingReceiptSubmission({ receiptRecovery: { pendingSubmission: malformed } }),
      (error: unknown) => error instanceof DeliveryReceiptError && error.code === 'failed-precondition',
    );
  }
});

test('receipt status writes retain unrelated fields and apply nested deletion and timestamp transforms', async (context) => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'prepared',
    custom: { nested: ['keep'] },
    receiptRecovery: {
      custom: { keep: true },
      preparedProbeCount: 2,
      lastPreparedProbeAt: 30,
      nextPreparedProbeAt: 40,
      status: 'legacy',
      leaseExpiresAt: 50,
      lastErrorCode: 'unavailable',
      lastErrorMessage: 'retry',
    },
  });
  context.after(() => native.harness.database.close());
  const key = deliveryOrderKey('drops/card_nft_2/deliveryOrders/7');
  const initial = await readDeliveryOrder(native.context, key);
  assert.ok(initial);
  const runtime = runtimeForDrop('card_nft_2');
  await markDeliveryProcessing(native.context, initial, runtime, SIGNATURE);
  const processing = await readDeliveryOrder(native.context, key);
  assert.ok(processing);
  assert.equal(processing.data.processingAt, Date.parse(processing.updateTime));
  assert.deepEqual(processing.data.receiptRecovery, {
    custom: { keep: true }, leaseExpiresAt: 50, lastErrorCode: 'unavailable', lastErrorMessage: 'retry',
  });
  const ready = await markDeliveryReady(native.context, processing, runtime, {
    signature: null, receiptsMinted: 0, receiptTxs: [], irlClaims: [],
  });
  assert.equal(ready.createTime, processing.createTime);
  assert.equal(ready.updateTime, processing.updateTime);
  assert.equal(ready.version, processing.version);
  assert.deepEqual(ready.processedAt, processing.processedAt);
  const readyStored = await readDeliveryOrder(native.context, key);
  assert.ok(readyStored);
  assert.equal(readyStored.data.processedAt, Date.parse(readyStored.updateTime));
  await recordDeliveryClose(native.context, key, runtime.dropId, SECOND_SIGNATURE);
  const stored = await readDeliveryOrder(native.context, key);
  assert.ok(stored);
  assert.deepEqual(stored.data.custom, { nested: ['keep'] });
  assert.deepEqual(stored.data.receiptRecovery, { custom: { keep: true } });
  assert.equal(stored.data.processingAt, processing.data.processingAt);
  assert.equal(stored.data.processedAt, readyStored.data.processedAt);
  assert.equal(stored.data.deliveryClosedAt, Date.parse(stored.updateTime));
  assert.equal(stored.data.deliverySignature, SIGNATURE);
  assert.equal(stored.data.closeDeliveryTx, SECOND_SIGNATURE);
});

test('native ready-to-ship persistence includes notification and pack-status outboxes', async () => {
  for (const signal of [new AbortController().signal, AbortSignal.abort(new Error('request cancelled'))]) {
    const runtime = runtimeForDrop('card_nft_2');
    const native = await nativeDeliveryContext({
      deliveryId: 7,
      owner: OWNER,
      status: 'processing',
      addressSnapshot: { email: 'buyer@example.com' },
      items: [{ kind: 'box', refId: 3 }],
    });
    const document = await readCommerceRecord(
      native.context,
      requireCommerceKey('drops/card_nft_2/deliveryOrders/7'),
    );
    assert.ok(document);
    native.context.signal = signal;
    await markDeliveryReady(
      native.context,
      deliveryOrderDocument(document),
      runtime,
      {
        signature: SIGNATURE,
        receiptsMinted: 1,
        receiptTxs: [SIGNATURE],
        irlClaims: [],
      },
    );
    const ready = await readCommerceRecord(
      native.context,
      requireCommerceKey('drops/card_nft_2/deliveryOrders/7'),
    );
    assert.equal(ready?.data.status, 'ready_to_ship');
    assert.equal(ready?.data.buyerOrderReceivedEmailState, 'pending');
    assert.equal(ready?.data.shipperReadyToShipEmailState, 'pending');
    assert.equal(ready?.data.packStatusProjectionState, 'pending');
    assert.equal(ready?.data.packStatusProjectionNextAttemptAtMs, READY_NOTIFICATION_NOW_MS);
  }
});

test('native ready-notification publication claims, queues, and finalizes atomically', async () => {
  const native = await nativeDeliveryContext(readyNotificationOrderFields(7));
  const document = await readCommerceRecord(
    native.context,
    requireCommerceKey('drops/card_nft_2/deliveryOrders/7'),
  );
  assert.ok(document);
  const jobs: unknown[] = [];
  assert.equal(await publishReadyToShipNotifications({
    context: native.context,
    deliveryId: 7,
    document,
    dropId: 'card_nft_2',
    queue: notificationQueue({
      sendBatch: async (messages) => {
        jobs.push(...Array.from(messages, (message) => message.body));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
  }), true);
  const finalized = await readCommerceRecord(
    native.context,
    requireCommerceKey('drops/card_nft_2/deliveryOrders/7'),
  );
  assert.equal(jobs.length, 1);
  assert.equal(finalized?.data.buyerOrderReceivedEmailState, 'queued');
  assert.equal(finalized?.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
});

test('pre-enqueue cancellation releases the ready-notification claim and attempt', async () => {
  const native = await nativeDeliveryContext(readyNotificationOrderFields(7));
  const document = await readCommerceRecord(
    native.context,
    requireCommerceKey('drops/card_nft_2/deliveryOrders/7'),
  );
  assert.ok(document);
  const cancellation = new DOMException('request cancelled', 'AbortError');
  const controller = new AbortController();
  controller.abort(cancellation);
  native.context.signal = controller.signal;
  let queueCalls = 0;
  await assert.rejects(
    publishReadyToShipNotifications({
      context: native.context,
      deliveryId: 7,
      document,
      dropId: 'card_nft_2',
      queue: notificationQueue({
        sendBatch: async () => {
          queueCalls += 1;
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      }),
    }),
    (error: unknown) => error === cancellation,
  );
  const released = await readCommerceRecord(
    native.context,
    requireCommerceKey('drops/card_nft_2/deliveryOrders/7'),
  );
  assert.equal(queueCalls, 0);
  assert.equal(released?.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD], 0);
  assert.equal(released?.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
});

test('receipt submissions are persisted before broadcast and promoted idempotently', async () => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
    receiptTxs: [SIGNATURE],
  });
  const path = 'drops/card_nft_2/deliveryOrders/7';
  const pending = {
    signature: SECOND_SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };

  await persistPendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, () => deliveryCleanupContext(native.context));
  let stored = await readCommerceRecord(native.context, requireCommerceKey(path));
  assert.deepEqual(
    (stored?.data.receiptRecovery as Record<string, unknown>).pendingSubmission,
    pending,
  );
  assert.deepEqual(stored?.data.receiptTxs, [SIGNATURE]);

  await settlePendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, 'confirmed', () => deliveryCleanupContext(native.context));
  await settlePendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, 'confirmed', () => deliveryCleanupContext(native.context));

  stored = await readCommerceRecord(native.context, requireCommerceKey(path));
  assert.deepEqual(stored?.data.receiptTxs, [SIGNATURE, SECOND_SIGNATURE]);
  assert.deepEqual(
    confirmedReceiptTransactions(stored?.data || {}),
    [SIGNATURE, SECOND_SIGNATURE],
  );
  assert.equal((stored?.data.receiptRecovery as Record<string, unknown> | undefined)?.pendingSubmission, undefined);
});

test('receipt submission intent recovers a lost D1 commit acknowledgement', async () => {
  let armed = false;
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
  }, {
    observeBatchAfterCommit: (observation) => {
      if (!armed || !observation.statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) return;
      armed = false;
      throw new Error('lost receipt intent acknowledgement');
    },
  });
  const path = 'drops/card_nft_2/deliveryOrders/7';
  const pending = {
    signature: SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };

  armed = true;
  await persistPendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, () => deliveryCleanupContext(native.context));

  const stored = await readCommerceRecord(native.context, requireCommerceKey(path));
  assert.deepEqual(
    (stored?.data.receiptRecovery as Record<string, unknown>).pendingSubmission,
    pending,
  );
});

test('confirmed receipt settlement survives a lost D1 acknowledgement and replay', async () => {
  let armed = false;
  let lostAcknowledgement = false;
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
    receiptTxs: [SIGNATURE],
  }, {
    observeBatchAfterCommit: ({ statements }) => {
      if (!armed || !statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) return;
      armed = false;
      lostAcknowledgement = true;
      throw new Error('lost confirmed receipt settlement acknowledgement');
    },
  });
  const path = 'drops/card_nft_2/deliveryOrders/7';
  const pending = {
    signature: SECOND_SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  await persistPendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, () => deliveryCleanupContext(native.context));

  armed = true;
  await settlePendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, 'confirmed', () => deliveryCleanupContext(native.context));
  assert.equal(lostAcknowledgement, true);
  const settled = await readCommerceRecord(native.context, requireCommerceKey(path));
  assert.deepEqual(settled?.data.receiptTxs, [SIGNATURE, SECOND_SIGNATURE]);
  assert.equal((settled?.data.receiptRecovery as Record<string, unknown>).pendingSubmission, undefined);

  await settlePendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, 'confirmed', () => deliveryCleanupContext(native.context));
  const replayed = await readCommerceRecord(native.context, requireCommerceKey(path));
  assert.deepEqual(replayed, settled);
});

test('expired receipt submissions clear without being promoted', async () => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
  });
  const path = 'drops/card_nft_2/deliveryOrders/7';
  const pending = {
    signature: SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  await persistPendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, () => deliveryCleanupContext(native.context));
  await settlePendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, 'expired', () => deliveryCleanupContext(native.context));
  const stored = await readCommerceRecord(native.context, requireCommerceKey(path));
  assert.equal((stored?.data.receiptRecovery as Record<string, unknown>).pendingSubmission, undefined);
  assert.deepEqual(stored?.data.receiptTxs, undefined);
});

test('receipt persistence and settlement each read their document once', async () => {
  for (const operation of ['persist', 'settle']) {
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
    if (operation === 'persist') {
      await persistPendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, () => deliveryCleanupContext(native.context));
    } else {
      await settlePendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, 'confirmed', () => deliveryCleanupContext(native.context));
    }
    const reads = calls.flatMap((call) => call.method === 'batch' ? call.statements : [call])
      .filter(({ sql }) => sql.includes('document_json') && /\b(?:FROM|JOIN) commerce_documents\b/.test(sql));
    assert.equal(reads.length, 1, operation);
  }
});

test('receipt retries preserve a competing submission and recovery lease', async () => {
  for (const operation of ['persist', 'settle']) {
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
    await assert.rejects(
      operation === 'persist'
        ? persistPendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, () => deliveryCleanupContext(native.context))
        : settlePendingReceiptSubmission(native.context, deliveryOrderKey(path), pending, 'confirmed', () => deliveryCleanupContext(native.context)),
      (error: unknown) => error instanceof DeliveryReceiptError && error.code === 'aborted',
    );
    assert.equal(changed, true, operation);
    const stored = await readCommerceRecord(native.context, requireCommerceKey(path));
    assert.deepEqual(stored?.data.receiptRecovery, {
      pendingSubmission: competing,
      attemptCount: 3,
      lastAttemptAt: 300,
      leaseExpiresAt: 400,
    });
    assert.equal(stored?.data.receiptTxs, undefined);
  }
});

test('existing assignment claim metadata is idempotently compatible without a box asset field', () => {
  const expected = {
    code: '0000000001',
    dropId: 'card_nft_2',
    boxAssetId: OWNER,
    boxId: 1,
    deliveryId: 7,
    dudeIds: [1, 2, 3],
  };
  assert.equal(assignmentClaimCompatible(
    {
      namespace: IRL_CLAIM_CODE_NAMESPACE,
      code: expected.code,
      dropId: expected.dropId,
      boxId: expected.boxId,
      deliveryId: expected.deliveryId,
      owner: OWNER,
      dudeIds: expected.dudeIds,
    },
    expected,
    OWNER,
  ), true);
});
