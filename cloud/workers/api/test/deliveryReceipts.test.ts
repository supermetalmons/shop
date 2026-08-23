import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
  decodeBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.ts';
import { IRL_CLAIM_CODE_NAMESPACE, IRL_CLAIM_CODE_DIGITS } from '../src/claimCodes.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import {
  DELIVERY_RECEIPTS_ISSUE_PATH,
  DELIVERY_RECEIPTS_RECOVER_PATH,
  deliveryReceiptRuntime,
  deliveryReceiptTestHooks,
  handleDeliveryReceiptRequest,
  processDeliveryPackStatusProjectionMessage,
} from '../src/deliveryReceipts.ts';
import { FirebaseIdTokenError } from '../src/firebaseIdToken.ts';

const OWNER = Keypair.generate().publicKey.toBase58();
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));
const BUYER_NOTIFICATION_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const SHIPPER_NOTIFICATION_JOB_ID = '123e4567-e89b-42d3-a456-426614174001';
type ReadyNotificationPublishArgs = Parameters<
  typeof deliveryReceiptTestHooks.publishReadyToShipNotifications
>[0];

function notificationQueue(overrides: Partial<Queue> = {}): Queue {
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  return {
    metrics: async () => metrics,
    send: async () => ({ metadata: { metrics } }),
    sendBatch: async () => ({ metadata: { metrics } }),
    ...overrides,
  };
}

function request(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer firebase-token',
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...init.headers,
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function env(overrides: Partial<Pick<Env,
  'COSIGNER_SECRET' | 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON' | 'HELIUS_API_KEY' | 'NOTIFICATION_EMAIL_QUEUE' | 'REVEAL_BACKGROUND_QUEUE'
>> = {}) {
  return {
    COSIGNER_SECRET: bs58.encode(Keypair.generate().secretKey),
    FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: '{"credential":"test"}',
    HELIUS_API_KEY: 'helius-test-key',
    NOTIFICATION_EMAIL_QUEUE: notificationQueue(),
    REVEAL_BACKGROUND_QUEUE: notificationQueue(),
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdToken: async () => ({ uid: 'firebase-uid' }),
    issue: async () => ({
      processed: true as const,
      deliveryId: 7,
      receiptsMinted: 3,
      receiptTxs: [SIGNATURE],
      closeDeliveryTx: null,
    }),
    recover: async () => ({
      attempted: 1,
      recovered: 1,
      remainingProcessing: 0,
      walletRecovery: { remainingProcessing: 0, nextCheckAt: null },
      results: [{
        dropId: 'card_nft_2',
        deliveryId: 7,
        statusBefore: 'processing',
        outcome: 'recovered' as const,
        verification: 'delivery_pda' as const,
        message: 'receipts issued',
      }],
    }),
    ...overrides,
  };
}

function u32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function u64LE(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value, 0);
  return buffer;
}

function borshString(value: string): Buffer {
  const encoded = Buffer.from(value);
  return Buffer.concat([u32LE(encoded.length), encoded]);
}

function configData(admin: Keypair, dropId: string): Buffer {
  const runtime = deliveryReceiptTestHooks.runtimeForDrop(dropId);
  const treasury = new PublicKey(runtime.config.treasury);
  const payload = Buffer.concat([
    Buffer.from(BOX_MINTER_CONFIG_DISCRIMINATOR),
    admin.publicKey.toBuffer(),
    treasury.toBuffer(),
    runtime.collectionMint.toBuffer(),
    u64LE(1n),
    u64LE(1n),
    Buffer.alloc(32),
    u32LE(runtime.maxSupply),
    Buffer.from([runtime.config.maxPerTx, runtime.itemsPerBox]),
    u32LE(0),
    borshString(runtime.config.namePrefix),
    borshString(runtime.config.symbol),
    borshString(runtime.config.metadataBase),
    Buffer.from([1, 1, runtime.config.discountMintsPerWallet]),
    borshString(runtime.config.figureNamePrefix),
    Buffer.alloc(37),
  ]);
  assert.equal(payload.length <= BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED, true);
  return Buffer.concat([
    payload,
    Buffer.alloc(BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED - payload.length),
  ]);
}

function rpcAccount(owner: PublicKey, data: Buffer) {
  return {
    data: [data.toString('base64'), 'base64'],
    executable: false,
    lamports: 1,
    owner: owner.toBase58(),
    rentEpoch: 0,
    space: data.length,
  };
}

function collectionData(): Buffer {
  const data = Buffer.alloc(49);
  data[0] = 5;
  return data;
}

test('issue route preserves the authenticated request and response contract', async () => {
  let observed: unknown;
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_ISSUE_PATH, {
      owner: OWNER,
      deliveryId: 7,
      signature: SIGNATURE,
      dropId: 'card_nft_2',
    }),
    env(),
    DELIVERY_RECEIPTS_ISSUE_PATH,
    () => undefined,
    dependencies({
      issue: async (body: unknown) => {
        observed = body;
        return {
          processed: true,
          deliveryId: 7,
          receiptsMinted: 3,
          receiptTxs: [SIGNATURE],
          closeDeliveryTx: null,
        };
      },
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.dropId, 'card_nft_2');
  assert.equal(result.deliveryId, 7);
  assert.equal(result.verification, 'signature');
  assert.deepEqual(observed, {
    owner: OWNER,
    deliveryId: 7,
    signature: SIGNATURE,
    dropId: 'card_nft_2',
  });
  assert.deepEqual(await result.response.json(), {
    processed: true,
    deliveryId: 7,
    receiptsMinted: 3,
    receiptTxs: [SIGNATURE],
    closeDeliveryTx: null,
  });
});

test('recovery route accepts the empty filter and reports recovery metrics', async () => {
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {}),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    dependencies(),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.verification, 'delivery_pda');
  assert.equal(result.attempted, 1);
  assert.equal(result.recovered, 1);
  const payload = await result.response.json() as { walletRecovery: { nextCheckAt: null } };
  assert.equal(payload.walletRecovery.nextCheckAt, null);
});

test('ready-to-ship persistence atomically includes both notification outboxes', async () => {
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  const commits: Array<{ writes: Array<Record<string, any>> }> = [];
  const context = {
    accessTokenProvider: {
      get: async () => 'google-access-token',
      invalidate: () => undefined,
    },
    nowMs: Date.now(),
    providerFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      assert.equal(url.endsWith('/documents:commit'), true);
      commits.push(JSON.parse(String(init?.body)));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-22T00:00:01.000Z' });
    },
    serviceAccountJson: '{"credential":"test"}',
    signal: new AbortController().signal,
  };
  const document = {
    id: '7',
    path: 'drops/card_nft_2/deliveryOrders/7',
    updateTime: '2026-08-22T00:00:00.000Z',
    fields: {
      deliveryId: 7,
      owner: OWNER,
      status: 'processing',
      addressSnapshot: { email: 'buyer@example.com' },
      items: [{ kind: 'box', refId: 3 }],
    },
  };
  const ready = await deliveryReceiptTestHooks.markDeliveryReady(context, document, runtime, {
    signature: SIGNATURE,
    receiptsMinted: 1,
    receiptTxs: [SIGNATURE],
    irlClaims: [],
  });
  assert.equal(commits.length, 1);
  const write = commits[0].writes[0];
  assert.equal(write.update.fields.status.stringValue, 'ready_to_ship');
  assert.equal(write.update.fields.buyerOrderReceivedEmailState.stringValue, 'pending');
  assert.equal(write.update.fields.shipperReadyToShipEmailState.stringValue, 'pending');
  assert.ok(write.updateMask.fieldPaths.includes('buyerOrderReceivedEmailQueuedAt'));
  assert.ok(write.updateMask.fieldPaths.includes('shipperReadyToShipEmailQueuedAt'));
  assert.equal(ready.fields.status, 'ready_to_ship');
  assert.equal(ready.fields.buyerOrderReceivedEmailState, 'pending');
  assert.equal(ready.fields.shipperReadyToShipEmailState, 'pending');
});

test('notification queue failure maps both delivery routes to retryable 503 after completion', async () => {
  const queue = notificationQueue({
    sendBatch: async () => {
      throw new Error('queue unavailable');
    },
  });
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_ISSUE_PATH, {
      owner: OWNER,
      deliveryId: 7,
      signature: SIGNATURE,
      dropId: 'card_nft_2',
    }),
    env({ NOTIFICATION_EMAIL_QUEUE: queue }),
    DELIVERY_RECEIPTS_ISSUE_PATH,
    () => undefined,
    dependencies({
      issue: async (
        _body: unknown,
        _identity: unknown,
        workerEnv: Env,
        firestore: ReadyNotificationPublishArgs['context'],
      ) => {
        await deliveryReceiptTestHooks.publishReadyToShipNotifications({
          context: firestore,
          deliveryId: 7,
          document: {
            id: '7',
            path: 'drops/card_nft_2/deliveryOrders/7',
            updateTime: '2026-08-22T00:00:00.000Z',
            fields: {
              deliveryId: 7,
              owner: OWNER,
              status: 'ready_to_ship',
              addressSnapshot: { email: 'buyer@example.com' },
              items: [{ kind: 'box', refId: 3 }],
              buyerOrderReceivedEmailState: 'pending',
              buyerOrderReceivedEmailJobId: BUYER_NOTIFICATION_JOB_ID,
              buyerOrderReceivedEmailIdempotencyKey: 'card_nft_2:7:order_received',
            },
          },
          dropId: 'card_nft_2',
          queue: workerEnv.NOTIFICATION_EMAIL_QUEUE,
        });
        throw new Error('unreachable');
      },
    }),
  );
  assert.equal(result.response.status, 503);
  assert.deepEqual(await result.response.json(), {
    error: {
      code: 'unavailable',
      message: 'Delivery completed, but notification emails could not be queued. Retry to finish notification delivery.',
    },
  });
  const recovery = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    dependencies({
      recover: async () => {
        throw new deliveryReceiptTestHooks.ReadyToShipNotificationEnqueueError();
      },
    }),
  );
  assert.equal(recovery.response.status, 503);
  assert.deepEqual(await recovery.response.json(), {
    error: {
      code: 'unavailable',
      message: 'Delivery completed, but notification emails could not be queued. Retry to finish notification delivery.',
    },
  });
});

test('successful queue publication remains successful when marker finalization fails', async () => {
  let queueSends = 0;
  const context: ReadyNotificationPublishArgs['context'] = {
    accessTokenProvider: {
      get: async () => 'google-access-token',
      invalidate: () => undefined,
    },
    nowMs: Date.now(),
    providerFetch: async (input) => {
      const url = String(input);
      if (url.includes('/deliveryOrders/7')) {
        return Response.json({
          name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
          updateTime: '2026-08-22T00:00:00.000Z',
          fields: {
            deliveryId: { integerValue: '7' },
            status: { stringValue: 'ready_to_ship' },
            buyerOrderReceivedEmailState: { stringValue: 'pending' },
            buyerOrderReceivedEmailJobId: { stringValue: BUYER_NOTIFICATION_JOB_ID },
            buyerOrderReceivedEmailIdempotencyKey: { stringValue: 'card_nft_2:7:order_received' },
          },
        });
      }
      if (url.endsWith('/documents:commit')) {
        return Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    serviceAccountJson: '{"credential":"test"}',
    signal: new AbortController().signal,
  };
  await assert.doesNotReject(deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context,
    deliveryId: 7,
    document: {
      id: '7',
      path: 'drops/card_nft_2/deliveryOrders/7',
      updateTime: '2026-08-22T00:00:00.000Z',
      fields: {
        deliveryId: 7,
        owner: OWNER,
        status: 'ready_to_ship',
        addressSnapshot: { email: 'buyer@example.com' },
        items: [{ kind: 'box', refId: 3 }],
        buyerOrderReceivedEmailState: 'pending',
        buyerOrderReceivedEmailJobId: BUYER_NOTIFICATION_JOB_ID,
        buyerOrderReceivedEmailIdempotencyKey: 'card_nft_2:7:order_received',
      },
    },
    dropId: 'card_nft_2',
    queue: notificationQueue({
      sendBatch: async () => {
        queueSends += 1;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
  }));
  assert.equal(queueSends, 1);
});

test('ready-to-ship issue requests use the production Firestore and bounded Solana adapters idempotently', async () => {
  const signer = Keypair.generate();
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  const configuration = configData(signer, runtime.dropId);
  const commits: Array<Record<string, unknown>> = [];
  const queued: Array<Record<string, unknown>> = [];
  let rpcCalls = 0;
  const providerFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/documents:beginTransaction')) {
      return Response.json({ transaction: 'pack-status-transaction' });
    }
    if (url.includes('/packStatusEvents/redeemedIrlNormal_7')) {
      return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    }
    if (url.includes('/authSessions/')) {
      return Response.json({
        name: 'projects/mons-shop/databases/(default)/documents/authSessions/firebase-uid',
        updateTime: '2026-08-22T00:00:00.000Z',
        fields: { wallet: { stringValue: OWNER } },
      });
    }
    if (url.includes('/drops/card_nft_2/deliveryOrders/7')) {
      return Response.json({
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
        updateTime: '2026-08-22T00:00:00.000Z',
        fields: {
          dropId: { stringValue: 'card_nft_2' },
          deliveryId: { integerValue: '7' },
          owner: { stringValue: OWNER },
          status: { stringValue: 'ready_to_ship' },
          addressSnapshot: { mapValue: { fields: { email: { stringValue: 'buyer@example.com' } } } },
          items: { arrayValue: { values: [{ mapValue: { fields: {
            kind: { stringValue: 'box' },
            refId: { integerValue: '3' },
          } } }] } },
          buyerOrderReceivedEmailState: { stringValue: 'pending' },
          buyerOrderReceivedEmailJobId: { stringValue: BUYER_NOTIFICATION_JOB_ID },
          buyerOrderReceivedEmailIdempotencyKey: { stringValue: 'card_nft_2:7:order_received' },
          shipperReadyToShipEmailState: { stringValue: 'pending' },
          shipperReadyToShipEmailJobId: { stringValue: SHIPPER_NOTIFICATION_JOB_ID },
          shipperReadyToShipEmailIdempotencyKey: { stringValue: 'card_nft_2:7:ready_to_ship' },
          receiptsMinted: { integerValue: '3' },
          receiptTxs: { arrayValue: { values: [{ stringValue: SIGNATURE }] } },
        },
      });
    }
    if (url.endsWith('/documents:commit')) {
      commits.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ writeResults: [{}], commitTime: '2026-08-22T00:00:01.000Z' });
    }
    if (url.includes('helius-rpc.com')) {
      rpcCalls += 1;
      const body = JSON.parse(String(init?.body)) as { id: string | number; method: string };
      if (body.method === 'getMultipleAccounts') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            context: { slot: 1 },
            value: [
              rpcAccount(new PublicKey(MPL_CORE_PROGRAM_ADDRESS), collectionData()),
              rpcAccount(runtime.boxMinterProgramId, configuration),
            ],
          },
        });
      }
      assert.equal(body.method, 'getAccountInfo');
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          context: { slot: 1 },
          value: null,
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_ISSUE_PATH, {
      owner: OWNER,
      deliveryId: 7,
      signature: SIGNATURE,
      dropId: 'card_nft_2',
    }),
    env({
      COSIGNER_SECRET: bs58.encode(signer.secretKey),
      NOTIFICATION_EMAIL_QUEUE: notificationQueue({
        sendBatch: async (messages) => {
          queued.push(...Array.from(messages, (message) => message.body as Record<string, unknown>));
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      }),
    }),
    DELIVERY_RECEIPTS_ISSUE_PATH,
    () => undefined,
    {
      accessTokenProvider: {
        get: async () => 'google-access-token',
        invalidate: () => undefined,
      },
      providerFetch,
      verifyIdToken: async () => ({ uid: 'firebase-uid' }),
    },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    processed: true,
    deliveryId: 7,
    receiptsMinted: 3,
    receiptTxs: [SIGNATURE],
    closeDeliveryTx: null,
  });
  assert.equal(rpcCalls, 2);
  assert.deepEqual(queued.map((job) => ({
    jobId: job.jobId,
    kind: job.kind,
    idempotencyKey: job.idempotencyKey,
  })), [
    {
      jobId: BUYER_NOTIFICATION_JOB_ID,
      kind: 'buyer_order_received',
      idempotencyKey: 'card_nft_2:7:order_received',
    },
    {
      jobId: SHIPPER_NOTIFICATION_JOB_ID,
      kind: 'shipper_ready_to_ship',
      idempotencyKey: 'card_nft_2:7:ready_to_ship',
    },
  ]);
  assert.equal(commits.length, 1);
  assert.match(JSON.stringify(commits), /buyerOrderReceivedEmailQueuedAt/);
  assert.match(JSON.stringify(commits), /shipperReadyToShipEmailQueuedAt/);
});

test('delivery pack-status Queue repairs normal orders and skips direct-card receipts', async () => {
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  await assert.doesNotReject(deliveryReceiptRuntime.countNormalIrlPackStatus({
    accessTokenProvider: { get: async () => 'token', invalidate: () => undefined },
    nowMs: 1_700_000_000_000,
    providerFetch: async () => assert.fail('direct-card receipts must not access projection stores'),
    serviceAccountJson: 'credential',
    signal: new AbortController().signal,
  }, runtime, 7, {
    source: 'admin_irl_redeem',
    adminIrlRedeem: { targetKind: 'card_receipt' },
    items: [{ kind: 'dude', refId: 1 }],
  }));

  let acks = 0;
  const retries: Array<QueueRetryOptions | undefined> = [];
  const commits: unknown[] = [];
  const message: Message<unknown> = {
    id: 'pack-status-job',
    timestamp: new Date(),
    attempts: 1,
    body: {
      version: 1,
      kind: 'delivery_pack_status_projection',
      dropId: 'card_nft_2',
      deliveryId: 7,
      enqueuedAtMs: 1_700_000_000_000,
    },
    ack: () => { acks += 1; },
    retry: (options) => { retries.push(options); },
  };
  await processDeliveryPackStatusProjectionMessage(message, {
    FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: 'credential',
  }, {
    accessTokenProvider: { get: async () => 'token', invalidate: () => undefined },
    nowMs: () => 1_700_000_000_000,
    providerFetch: async (input, init) => {
      const url = String(input);
      if (url.includes('/deliveryOrders/7')) {
        return Response.json({
          name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
          updateTime: '2026-08-22T00:00:00.000Z',
          fields: {
            status: { stringValue: 'ready_to_ship' },
            items: { arrayValue: { values: [{ mapValue: { fields: { kind: { stringValue: 'box' }, refId: { integerValue: '1' } } } }] } },
          },
        });
      }
      if (url.endsWith('/documents:beginTransaction')) return Response.json({ transaction: 'transaction' });
      if (url.includes('/packStatusEvents/redeemedIrlNormal_7')) {
        return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
      }
      if (url.endsWith('/documents:commit')) {
        commits.push(JSON.parse(String(init?.body)));
        return Response.json({ writeResults: [{}] });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    log: () => undefined,
  });
  assert.equal(acks, 1);
  assert.deepEqual(retries, []);
  assert.match(JSON.stringify(commits), /redeemedIrlNormal/);
});

test('explicit recovery uses the production Firestore adapter and preserves not-found scheduling', async () => {
  let queryCalls = 0;
  const providerFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/authSessions/')) {
      return Response.json({
        name: 'projects/mons-shop/databases/(default)/documents/authSessions/firebase-uid',
        updateTime: '2026-08-22T00:00:00.000Z',
        fields: { wallet: { stringValue: OWNER } },
      });
    }
    if (url.includes('/drops/card_nft_2/deliveryOrders/7')) {
      return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    }
    if (url.endsWith('/documents:runQuery')) {
      queryCalls += 1;
      const payload = JSON.parse(String(init?.body)) as {
        structuredQuery: {
          select: { fields: Array<{ fieldPath: string }> };
          where: { compositeFilter: { filters: Array<{ fieldFilter: { field: { fieldPath: string }; op: string } }> } };
        };
      };
      assert.deepEqual(payload.structuredQuery.select.fields, [
        { fieldPath: 'status' },
        { fieldPath: 'createdAt' },
        { fieldPath: 'processingAt' },
        { fieldPath: 'receiptRecovery' },
      ]);
      assert.equal(payload.structuredQuery.where.compositeFilter.filters[1]?.fieldFilter.field.fieldPath, 'status');
      assert.equal(payload.structuredQuery.where.compositeFilter.filters[1]?.fieldFilter.op, 'IN');
      return Response.json([]);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    {
      accessTokenProvider: {
        get: async () => 'google-access-token',
        invalidate: () => undefined,
      },
      providerFetch,
      verifyIdToken: async () => ({ uid: 'firebase-uid' }),
    },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    attempted: 0,
    recovered: 0,
    remainingProcessing: 0,
    walletRecovery: { remainingProcessing: 0, nextCheckAt: null },
    results: [{
      dropId: 'card_nft_2',
      deliveryId: 7,
      statusBefore: 'missing',
      outcome: 'not_found',
      verification: 'delivery_pda',
      message: 'delivery order not found',
    }],
  });
  assert.equal(queryCalls, 1);
});

test('forced recovery validates the delivery PDA and finalizes an already-burned order through production adapters', async () => {
  const signer = Keypair.generate();
  const asset = Keypair.generate().publicKey.toBase58();
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_binder_devnet');
  const [deliveryPda] = deliveryReceiptTestHooks.deriveDeliveryPda(runtime, 7);
  const configuration = configData(signer, runtime.dropId);
  const deliveryRecord = Buffer.alloc(50);
  Buffer.from('2b0f869afad50393', 'hex').copy(deliveryRecord, 0);
  const ownerKey = new PublicKey(OWNER);
  ownerKey.toBuffer().copy(deliveryRecord, 8);
  deliveryRecord.writeBigUInt64LE(1234n, 40);
  deliveryRecord.writeUInt16LE(1, 48);
  const commits: Array<Record<string, unknown>> = [];
  let deliveryAccountReads = 0;
  const orderDocument = {
    name: `projects/mons-shop/databases/(default)/documents/drops/${runtime.dropId}/deliveryOrders/7`,
    updateTime: '2026-08-22T00:00:00.000Z',
    fields: {
      dropId: { stringValue: runtime.dropId },
      deliveryId: { integerValue: '7' },
      owner: { stringValue: OWNER },
      status: { stringValue: 'prepared' },
      itemIds: { arrayValue: { values: [{ stringValue: asset }] } },
      items: { arrayValue: { values: [{ mapValue: { fields: {
        assetId: { stringValue: asset },
        kind: { stringValue: 'box' },
        refId: { integerValue: '1' },
      } } }] } },
      deliveryPda: { stringValue: deliveryPda.toBase58() },
      deliveryLamports: { integerValue: '1234' },
      createdAt: { timestampValue: '2026-08-22T00:00:00.000Z' },
      receiptRecovery: { mapValue: { fields: {
        preparedProbeCount: { integerValue: '0' },
      } } },
    },
  };
  const providerFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/authSessions/')) {
      return Response.json({
        name: 'projects/mons-shop/databases/(default)/documents/authSessions/firebase-uid',
        updateTime: '2026-08-22T00:00:00.000Z',
        fields: { wallet: { stringValue: OWNER } },
      });
    }
    if (url.includes(`/drops/${runtime.dropId}/deliveryOrders/7`)) {
      return Response.json(orderDocument);
    }
    if (url.endsWith('/documents:beginTransaction')) {
      return Response.json({ transaction: `transaction-${commits.length}` });
    }
    if (url.endsWith('/documents:rollback')) return Response.json({});
    if (url.endsWith('/documents:commit')) {
      commits.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ writeResults: [{}], commitTime: '2026-08-22T00:00:01.000Z' });
    }
    if (url.endsWith('/documents:runQuery')) return Response.json([]);
    if (url.includes('helius-rpc.com')) {
      const rpc = JSON.parse(String(init?.body)) as { id: string | number; method: string; params: unknown[] };
      if (rpc.method === 'getMultipleAccounts') {
        const publicKeys = rpc.params[0] as string[];
        return Response.json({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            context: { slot: 1 },
            value: publicKeys.length === 2
              ? [
                  rpcAccount(new PublicKey(MPL_CORE_PROGRAM_ADDRESS), collectionData()),
                  rpcAccount(runtime.boxMinterProgramId, configuration),
                ]
              : [null],
          },
        });
      }
      assert.equal(rpc.method, 'getAccountInfo');
      const publicKey = String(rpc.params[0]);
      let value = null;
      if (publicKey === deliveryPda.toBase58() && deliveryAccountReads === 0) {
        deliveryAccountReads += 1;
        value = rpcAccount(runtime.boxMinterProgramId, deliveryRecord);
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { context: { slot: 1 }, value } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {
      dropId: runtime.dropId,
      deliveryId: 7,
      force: true,
    }),
    env({ COSIGNER_SECRET: bs58.encode(signer.secretKey) }),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    {
      accessTokenProvider: {
        get: async () => 'google-access-token',
        invalidate: () => undefined,
      },
      providerFetch,
      verifyIdToken: async () => ({ uid: 'firebase-uid' }),
    },
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    attempted: number;
    recovered: number;
    results: Array<{ outcome: string }>;
  };
  assert.equal(payload.attempted, 1);
  assert.equal(payload.recovered, 1);
  assert.equal(payload.results[0]?.outcome, 'recovered');
  assert.equal(commits.some((commit) => JSON.stringify(commit).includes('ready_to_ship')), true);
  assert.equal(commits.some((commit) => JSON.stringify(commit).includes('receiptsMinted')), true);
});

test('receipt routes reject methods and strict invalid payloads before service execution', async () => {
  let called = false;
  const method = await handleDeliveryReceiptRequest(
    new Request(`https://api.mons.shop${DELIVERY_RECEIPTS_ISSUE_PATH}`),
    env(),
    DELIVERY_RECEIPTS_ISSUE_PATH,
    () => undefined,
    dependencies({ issue: async () => { called = true; throw new Error('unexpected'); } }),
  );
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get('allow'), 'POST, OPTIONS');

  const invalid = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_ISSUE_PATH, {
      owner: OWNER,
      deliveryId: 7,
      signature: SIGNATURE,
      dropId: 'card_nft_2',
      extra: true,
    }),
    env(),
    DELIVERY_RECEIPTS_ISSUE_PATH,
    () => undefined,
    dependencies({ issue: async () => { called = true; throw new Error('unexpected'); } }),
  );
  assert.equal(invalid.response.status, 400);
  assert.equal((await invalid.response.json() as { error: { code: string } }).error.code, 'invalid-argument');
  assert.equal(called, false);

  for (const body of [
    {
      owner: OWNER,
      deliveryId: 7,
      signature: SIGNATURE,
      dropId: ' CARD_NFT_2 ',
    },
    {
      owner: OWNER,
      deliveryId: 0x1_0000_0000,
      signature: SIGNATURE,
      dropId: 'card_nft_2',
    },
  ]) {
    const noncanonical = await handleDeliveryReceiptRequest(
      request(DELIVERY_RECEIPTS_ISSUE_PATH, body),
      env(),
      DELIVERY_RECEIPTS_ISSUE_PATH,
      () => undefined,
      dependencies({ issue: async () => { called = true; throw new Error('unexpected'); } }),
    );
    assert.equal(noncanonical.response.status, 400);
  }
  assert.equal(called, false);
});

test('receipt errors omit internal details from the public envelope', async () => {
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_ISSUE_PATH, {
      owner: OWNER,
      deliveryId: 7,
      signature: SIGNATURE,
      dropId: 'card_nft_2',
    }),
    env(),
    DELIVERY_RECEIPTS_ISSUE_PATH,
    () => undefined,
    dependencies({
      issue: async () => {
        throw new deliveryReceiptTestHooks.DeliveryReceiptError(
          'failed-precondition',
          'Receipt validation failed.',
          { assetId: OWNER, lastLogs: ['sensitive'] },
        );
      },
    }),
  );
  assert.equal(result.response.status, 409);
  assert.deepEqual(await result.response.json(), {
    error: { code: 'failed-precondition', message: 'Receipt validation failed.' },
  });
});

test('malformed 64-byte cosigner secrets remain availability failures', () => {
  const malformed = bs58.encode(new Uint8Array(64).fill(1));
  assert.throws(
    () => deliveryReceiptTestHooks.decodeCosigner(malformed),
    (error: unknown) => error instanceof deliveryReceiptTestHooks.DeliveryReceiptError && error.code === 'unavailable',
  );
});

test('read-only Firestore rollback is best effort', async () => {
  let calls = 0;
  await assert.doesNotReject(deliveryReceiptTestHooks.rollbackTransactionBestEffort({
    accessTokenProvider: {
      get: async () => 'google-access-token',
      invalidate: () => undefined,
    },
    nowMs: Date.now(),
    providerFetch: async () => {
      calls += 1;
      return Response.json({ error: { status: 'INVALID_ARGUMENT' } }, { status: 400 });
    },
    serviceAccountJson: '{}',
    signal: new AbortController().signal,
  }, 'transaction'));
  assert.equal(calls, 1);
});

test('pending ready notification recovery queries both outbox marker states', async () => {
  let query: Record<string, any> | undefined;
  const result = await deliveryReceiptTestHooks.runPendingReadyNotificationQuery({
    accessTokenProvider: {
      get: async () => 'google-access-token',
      invalidate: () => undefined,
    },
    nowMs: Date.now(),
    providerFetch: async (input, init) => {
      assert.equal(String(input).endsWith('/documents:runQuery'), true);
      query = JSON.parse(String(init?.body));
      return Response.json([]);
    },
    serviceAccountJson: '{"credential":"test"}',
    signal: new AbortController().signal,
  }, OWNER);
  assert.deepEqual(result, []);
  const filters = query?.structuredQuery.where.compositeFilter.filters;
  assert.equal(filters[0].fieldFilter.field.fieldPath, 'owner');
  assert.equal(filters[1].fieldFilter.field.fieldPath, 'status');
  assert.equal(filters[1].fieldFilter.value.stringValue, 'ready_to_ship');
  assert.deepEqual(
    filters[2].compositeFilter.filters.map((entry: Record<string, any>) => entry.fieldFilter.field.fieldPath),
    ['buyerOrderReceivedEmailState', 'shipperReadyToShipEmailState'],
  );
});

test('receipt routes enforce bounded JSON and required runtime configuration', async () => {
  const oversized = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, { dropId: 'x'.repeat(5000) }),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    dependencies(),
  );
  assert.equal(oversized.response.status, 400);

  const unavailable = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {}),
    env({ HELIUS_API_KEY: '' }),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    dependencies(),
  );
  assert.equal(unavailable.response.status, 503);
  assert.equal((await unavailable.response.json() as { error: { code: string } }).error.code, 'unavailable');
});

test('receipt routes map invalid authentication and provider authentication failures', async () => {
  const invalid = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {}),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    dependencies({ verifyIdToken: async () => { throw new FirebaseIdTokenError('invalid-token'); } }),
  );
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.authOutcome, 'rejected');

  const provider = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {}),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    dependencies({ verifyIdToken: async () => { throw new FirebaseIdTokenError('provider-unavailable'); } }),
  );
  assert.equal(provider.response.status, 503);
  assert.equal(provider.authOutcome, 'provider-failure');
});

test('receipt route deadline is stable and retryable', async () => {
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {}),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    dependencies({
      timeoutMs: 5,
      verifyIdToken: async (_authorization: unknown, _fetch: unknown, signal: AbortSignal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    }),
  );
  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});

test('delivery recovery eligibility preserves backoff, prepared probes, and force behavior', () => {
  assert.deepEqual(
    deliveryReceiptTestHooks.deliveryRecoveryEligibility({
      status: 'processing',
      receiptRecovery: { lastAttemptAt: 99_000 },
    }, 100_000, false),
    { eligible: false, outcome: 'not_eligible', message: 'processing order retry backoff is active' },
  );
  assert.deepEqual(
    deliveryReceiptTestHooks.deliveryRecoveryEligibility({
      status: 'prepared',
      createdAt: 100,
      receiptRecovery: { preparedProbeCount: 3 },
    }, 100_000, false),
    { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' },
  );
  assert.deepEqual(
    deliveryReceiptTestHooks.deliveryRecoveryEligibility({ status: 'prepared_abandoned' }, 100_000, true),
    { eligible: true },
  );
});

test('prepared recovery failures reread the leased order and preserve retryable scheduling', async () => {
  const path = 'drops/card_nft_2/deliveryOrders/7';
  const updateTime = '2026-08-22T00:00:01.000Z';
  const commits: Array<Record<string, unknown>> = [];
  const context = {
    accessTokenProvider: {
      get: async () => 'google-access-token',
      invalidate: () => undefined,
    },
    nowMs: 1_000,
    providerFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'GET' && url.includes(path)) {
        return Response.json({
          name: `projects/mons-shop/databases/(default)/documents/${path}`,
          updateTime,
          fields: {
            status: { stringValue: 'prepared' },
            receiptRecovery: { mapValue: { fields: {
              preparedProbeCount: { integerValue: '0' },
              leaseExpiresAt: { timestampValue: '1970-01-01T00:01:30.000Z' },
            } } },
          },
        });
      }
      if (url.endsWith('/documents:commit')) {
        commits.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ writeResults: [{}], commitTime: updateTime });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    serviceAccountJson: '{}',
    signal: new AbortController().signal,
  };
  await deliveryReceiptTestHooks.handlePreparedRecoveryFailure(
    context,
    path,
    'missing_delivery',
    'failed-precondition',
    1_000,
  );
  await deliveryReceiptTestHooks.handlePreparedRecoveryFailure(
    context,
    path,
    'failed',
    'unavailable',
    2_000,
  );
  assert.equal(commits.length, 2);
  const firstWrite = (commits[0].writes as Array<Record<string, unknown>>)[0];
  const secondWrite = (commits[1].writes as Array<Record<string, unknown>>)[0];
  assert.deepEqual(firstWrite.currentDocument, { updateTime });
  assert.deepEqual(secondWrite.currentDocument, { updateTime });
  assert.deepEqual((firstWrite.updateMask as { fieldPaths: string[] }).fieldPaths, [
    'receiptRecovery.preparedProbeCount',
    'receiptRecovery.lastPreparedProbeAt',
    'receiptRecovery.nextPreparedProbeAt',
  ]);
  assert.deepEqual((secondWrite.updateMask as { fieldPaths: string[] }).fieldPaths, [
    'receiptRecovery.nextPreparedProbeAt',
  ]);
  const secondFields = (secondWrite.update as {
    fields: { receiptRecovery: { mapValue: { fields: { nextPreparedProbeAt: { timestampValue: string } } } } };
  }).fields;
  assert.equal(
    secondFields.receiptRecovery.mapValue.fields.nextPreparedProbeAt.timestampValue,
    '1970-01-01T00:01:30.000Z',
  );
});

test('stored assignment validation rejects malformed or duplicate ids', () => {
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  assert.throws(
    () => deliveryReceiptTestHooks.normalizeAssignedDudeIds([1, 1, 2], runtime, OWNER),
    /Stored figure assignment is invalid/,
  );
  const valid = Array.from({ length: runtime.itemsPerBox }, (_, index) => index + 1);
  assert.deepEqual(deliveryReceiptTestHooks.normalizeAssignedDudeIds(valid, runtime, OWNER), valid);
});

test('stored delivery item ids reject malformed subsets and duplicates', () => {
  const first = Keypair.generate().publicKey.toBase58();
  const second = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(deliveryReceiptTestHooks.storedDeliveryItemIds({ itemIds: [first, second] }), [first, second]);
  assert.throws(
    () => deliveryReceiptTestHooks.storedDeliveryItemIds({ itemIds: [first, 'invalid'] }),
    /invalid itemIds/,
  );
  assert.throws(
    () => deliveryReceiptTestHooks.storedDeliveryItemIds({ itemIds: [first, first] }),
    /duplicate itemIds/,
  );
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
  assert.equal(deliveryReceiptTestHooks.assignmentClaimCompatible({
    namespace: IRL_CLAIM_CODE_NAMESPACE,
    code: expected.code,
    dropId: expected.dropId,
    boxId: expected.boxId,
    deliveryId: expected.deliveryId,
    owner: OWNER,
    dudeIds: expected.dudeIds,
  }, expected, OWNER), true);
});

test('receipt issuance rejects committed on-chain configuration drift', () => {
  const signer = Keypair.generate();
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  const decoded = decodeBoxMinterConfigData(configData(signer, runtime.dropId));
  const onchain = {
    admin: new PublicKey(decoded.admin),
    coreCollection: new PublicKey(decoded.coreCollection),
    decoded,
  };
  assert.doesNotThrow(() => deliveryReceiptTestHooks.assertOnchainConfigMatchesRuntime(runtime, onchain));
  assert.throws(() => deliveryReceiptTestHooks.assertOnchainConfigMatchesRuntime(runtime, {
    ...onchain,
    decoded: { ...decoded, maxSupply: decoded.maxSupply + 1 },
  }), /does not match/);
});

test('secure random assignment indices stay within the requested range', () => {
  for (let index = 0; index < 100; index += 1) {
    const value = deliveryReceiptTestHooks.secureRandomInt(7);
    assert.equal(Number.isInteger(value), true);
    assert.equal(value >= 0 && value < 7, true);
  }
  const claimCodeRange = 10 ** IRL_CLAIM_CODE_DIGITS;
  for (let index = 0; index < 100; index += 1) {
    const value = deliveryReceiptTestHooks.secureRandomInt(claimCodeRange);
    assert.equal(Number.isInteger(value), true);
    assert.equal(value >= 0 && value < claimCodeRange, true);
  }
  assert.throws(() => deliveryReceiptTestHooks.secureRandomInt(0), /range is invalid/);
});

test('receipt batches shrink after transient retries are exhausted', () => {
  const error = new deliveryReceiptTestHooks.ReceiptBatchRetryExhaustedError(new Error('account in use'));
  assert.equal(deliveryReceiptTestHooks.shouldShrinkReceiptBatch(error), true);
});

test('delivery record decoding validates discriminator, payer, fee, and item count', () => {
  const payer = Keypair.generate().publicKey;
  const data = Buffer.alloc(50);
  Buffer.from('2b0f869afad50393', 'hex').copy(data, 0);
  payer.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(1234n, 40);
  data.writeUInt16LE(3, 48);
  const decoded = deliveryReceiptTestHooks.decodeDeliveryRecord(data);
  assert.equal(decoded.payer.toBase58(), payer.toBase58());
  assert.equal(decoded.deliveryFeeLamports, 1234);
  assert.equal(decoded.itemCount, 3);
  assert.throws(() => deliveryReceiptTestHooks.decodeDeliveryRecord(Buffer.alloc(50)), /invalid/);

  const owner = new PublicKey(OWNER);
  const other = Keypair.generate().publicKey;
  assert.doesNotThrow(() => deliveryReceiptTestHooks.assertDeliveryPayers(OWNER, owner, owner));
  assert.throws(() => deliveryReceiptTestHooks.assertDeliveryPayers(OWNER, other, owner), /fee payer/);
  assert.throws(() => deliveryReceiptTestHooks.assertDeliveryPayers(OWNER, owner, other), /Delivery payer/);

  assert.doesNotThrow(() => deliveryReceiptTestHooks.assertDeliverArgsMatchOrder({
    decoded: { deliveryId: 7, feeLamports: 1234, deliveryBump: 255 },
    deliveryId: 7,
    expectedDeliveryBump: 255,
    order: { deliveryLamports: 1234 },
  }));
  assert.doesNotThrow(() => deliveryReceiptTestHooks.assertDeliverArgsMatchOrder({
    decoded: { deliveryId: 7, feeLamports: 1234, deliveryBump: 255 },
    deliveryId: 7,
    expectedDeliveryBump: 255,
    order: { shippingLamports: 1234 },
  }));
  assert.throws(() => deliveryReceiptTestHooks.assertDeliverArgsMatchOrder({
    decoded: { deliveryId: 7, feeLamports: 1, deliveryBump: 255 },
    deliveryId: 7,
    expectedDeliveryBump: 255,
    order: { deliveryLamports: 1234 },
  }), /Delivery fee mismatch/);
  assert.throws(() => deliveryReceiptTestHooks.assertDeliverArgsMatchOrder({
    decoded: { deliveryId: 7, feeLamports: 1234, deliveryBump: 1 },
    deliveryId: 7,
    expectedDeliveryBump: 255,
    order: { deliveryLamports: 1234 },
  }), /Delivery PDA bump mismatch/);
});
