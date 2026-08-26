import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness } from './commerceD1Harness.ts';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
  decodeBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.ts';
import { IRL_CLAIM_CODE_NAMESPACE, IRL_CLAIM_CODE_DIGITS } from '../src/claimCodes.ts';
import {
  DELIVERY_RECEIPTS_ISSUE_PATH,
  DELIVERY_RECEIPTS_RECOVER_PATH,
  deliveryReceiptRuntime,
  deliveryReceiptTestHooks,
  handleDeliveryReceiptRequest,
} from '../src/deliveryReceipts.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import {
  compareAndSetReadyNotificationCursor,
  loadReadyNotificationControl,
} from '../src/d1ReadyNotificationControl.ts';
import {
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD,
} from '../src/readyToShipNotifications.ts';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';

const OWNER = Keypair.generate().publicKey.toBase58();
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));
const READY_NOTIFICATION_NOW_MS = 1_700_000_000_000;
const READY_NOTIFICATION_RETRY_UNTIL_MS = 8_000_000_000_000;
function notificationQueue(overrides: Partial<Queue> = {}): Queue {
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  return {
    metrics: async () => metrics,
    send: async () => ({ metadata: { metrics } }),
    sendBatch: async () => ({ metadata: { metrics } }),
    ...overrides,
  };
}

function projectionDataDb(args: {
  delay?: () => Promise<void>;
  failures?: number;
  hasEvent?: boolean;
} = {}) {
  let attempts = 0;
  let applied = 0;
  let failures = args.failures || 0;
  let hasEvent = args.hasEvent || false;
  const statement = {
    bind() {
      return this;
    },
    async run() {
      attempts += 1;
      await args.delay?.();
      if (failures > 0) {
        failures -= 1;
        throw new Error('d1 unavailable');
      }
      const changes = hasEvent ? 0 : 1;
      if (changes) {
        hasEvent = true;
        applied += 1;
      }
      return {
        success: true,
        results: [],
        meta: { changes },
      };
    },
  };
  return {
    db: { prepare: () => statement } as unknown as Env['DATA_DB'],
    get applied() { return applied; },
    get attempts() { return attempts; },
  };
}

function readyNotificationOrderFields(deliveryId: number, includeShipper = false): Record<string, unknown> {
  return {
    dropId: 'card_nft_2',
    deliveryId,
    owner: OWNER,
    status: 'ready_to_ship',
    processedAt: 1_700_000_000_000,
    addressSnapshot: { email: 'buyer@example.com' },
    items: [{ kind: 'box', refId: deliveryId }],
    buyerOrderReceivedEmailState: 'pending',
    buyerOrderReceivedEmailJobId: `00000000-0000-4000-8000-${String(deliveryId).padStart(12, '0')}`,
    buyerOrderReceivedEmailIdempotencyKey: `card_nft_2:${deliveryId}:order_received`,
    [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: READY_NOTIFICATION_RETRY_UNTIL_MS,
    [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: 0,
    ...(includeShipper ? {
      shipperReadyToShipEmailState: 'pending',
      shipperReadyToShipEmailJobId: `00000000-0000-4000-9000-${String(deliveryId).padStart(12, '0')}`,
      shipperReadyToShipEmailIdempotencyKey: `card_nft_2:${deliveryId}:ready_to_ship`,
    } : {}),
  };
}

function readyNotificationD1Result(
  results: Array<Record<string, unknown>> = [],
  changes = 0,
): D1Result<Record<string, unknown>> {
  return {
    success: true,
    results,
    meta: {
      changed_db: changes > 0,
      changes,
      duration: 0,
      last_row_id: 0,
      rows_read: results.length,
      rows_written: changes,
      size_after: 0,
    },
  };
}

type ReadyNotificationD1Execute = (
  statement: ReadyNotificationTestStatement,
) => D1Result<Record<string, unknown>> | Promise<D1Result<Record<string, unknown>>>;

class ReadyNotificationTestStatement implements D1PreparedStatement {
  constructor(
    readonly query: string,
    private readonly execute: ReadyNotificationD1Execute,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new ReadyNotificationTestStatement(this.query, this.execute, values);
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = (await this.execute(this)).results[0];
    if (!row) return null;
    return (colName === undefined ? row : row[colName]) as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.execute(this);
    return { ...result, results: result.results as T[] };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.run<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const rows = (await this.execute(this)).results;
    const columnNames = Object.keys(rows[0] || {});
    const values = rows.map((row) => columnNames.map((columnName) => row[columnName]) as T);
    return options?.columnNames ? [columnNames, ...values] : values;
  }
}

class ReadyNotificationTestDatabase implements D1Database {
  constructor(
    private readonly execute: ReadyNotificationD1Execute,
    private readonly batchSizes: number[],
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new ReadyNotificationTestStatement(query, this.execute);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batchSizes.push(statements.length);
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }

  exec(): Promise<D1ExecResult> {
    throw new Error('Unexpected D1 exec');
  }

  withSession(): D1DatabaseSession {
    throw new Error('Unexpected D1 session');
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error('Unexpected D1 dump');
  }
}

function readyNotificationControlHarness(args: {
  cursorPath?: string | null;
  exists?: boolean;
  failCursorWrites?: number;
  onCursor?: () => void;
  paused?: boolean;
  revision?: number;
} = {}) {
  let cursorPath = args.cursorPath || null;
  let exists = args.exists ?? true;
  let failCursorWrites = args.failCursorWrites || 0;
  let paused = args.paused || false;
  let revision = args.revision || 1;
  let insertAttempts = 0;
  const batchSizes: number[] = [];
  const reads: boolean[] = [];
  const execute = (statement: ReadyNotificationTestStatement): D1Result<Record<string, unknown>> => {
    if (statement.query.includes('FROM wallet_sessions')) {
      return readyNotificationD1Result([{
        auth_subject: 'auth-uid',
        wallet: OWNER,
        expires_at_ms: 253_402_300_799_999,
        updated_at_ms: READY_NOTIFICATION_NOW_MS,
        wallet_revision: 1,
        reconcile_lease_id: null,
        reconcile_lease_expires_at_ms: null,
      }]);
    }
    if (statement.query.includes('INSERT INTO worker_controls')) {
      insertAttempts += 1;
      if (exists) return readyNotificationD1Result();
      exists = true;
      paused = false;
      cursorPath = null;
      revision = 1;
      return readyNotificationD1Result([], 1);
    }
    if (statement.query.includes('SELECT control_key, paused, cursor_path, revision')) {
      if (!exists) return readyNotificationD1Result();
      reads.push(paused);
      return readyNotificationD1Result([{
        control_key: 'ready_notifications',
        cursor_path: cursorPath,
        paused: paused ? 1 : 0,
        revision,
      }]);
    }
    if (statement.query.includes('UPDATE worker_controls')) {
      if (failCursorWrites > 0) {
        failCursorWrites -= 1;
        return readyNotificationD1Result();
      }
      const [nextCursorPath, , , controlKey, expectedRevision] = statement.values;
      if (
        !exists ||
        paused ||
        controlKey !== 'ready_notifications' ||
        expectedRevision !== revision ||
        typeof nextCursorPath !== 'string'
      ) return readyNotificationD1Result();
      cursorPath = nextCursorPath;
      revision += 1;
      args.onCursor?.();
      return readyNotificationD1Result([], 1);
    }
    throw new Error(`Unexpected D1 query: ${statement.query}`);
  };
  const db = new ReadyNotificationTestDatabase(execute, batchSizes);
  return {
    batchSizes,
    db,
    reads,
    get cursorPath() { return cursorPath; },
    get exists() { return exists; },
    get insertAttempts() { return insertAttempts; },
    get revision() { return revision; },
    setPaused(value: boolean) {
      paused = value;
      revision += 1;
    },
  };
}

test('D1 notification control loads and advances its cursor with revision CAS', async () => {
  const control = readyNotificationControlHarness();
  assert.deepEqual(await loadReadyNotificationControl(control.db, READY_NOTIFICATION_NOW_MS), {
    cursorPath: null,
    paused: false,
    revision: 1,
  });
  assert.equal(await compareAndSetReadyNotificationCursor(
    control.db,
    'drops/card_nft_2/deliveryOrders/7',
    1,
    READY_NOTIFICATION_NOW_MS + 1,
  ), true);
  assert.equal(await compareAndSetReadyNotificationCursor(
    control.db,
    'drops/card_nft_2/deliveryOrders/8',
    1,
    READY_NOTIFICATION_NOW_MS + 2,
  ), false);
  assert.deepEqual(await loadReadyNotificationControl(control.db, READY_NOTIFICATION_NOW_MS + 3), {
    cursorPath: 'drops/card_nft_2/deliveryOrders/7',
    paused: false,
    revision: 2,
  });
});

test('D1 notification control rejects malformed cursor paths and does not advance while paused', async () => {
  const malformed = readyNotificationControlHarness({ cursorPath: 'deliveryOrders/7' });
  await assert.rejects(
    loadReadyNotificationControl(malformed.db, READY_NOTIFICATION_NOW_MS),
    /invalid_ready_notification_control/,
  );
  const paused = readyNotificationControlHarness({ paused: true });
  assert.equal(await compareAndSetReadyNotificationCursor(
    paused.db,
    'drops/card_nft_2/deliveryOrders/7',
    1,
    READY_NOTIFICATION_NOW_MS,
  ), false);
  await assert.rejects(
    compareAndSetReadyNotificationCursor(
      paused.db,
      'deliveryOrders/7',
      1,
      READY_NOTIFICATION_NOW_MS,
    ),
    /invalid_ready_notification_control_cursor/,
  );
  const noncanonical = readyNotificationControlHarness({
    cursorPath: 'drops/Card_NFT_2/deliveryOrders/7',
  });
  await assert.rejects(
    loadReadyNotificationControl(noncanonical.db, READY_NOTIFICATION_NOW_MS),
    /invalid_ready_notification_control/,
  );
  await assert.rejects(
    compareAndSetReadyNotificationCursor(
      paused.db,
      'drops/Card_NFT_2/deliveryOrders/7',
      1,
      READY_NOTIFICATION_NOW_MS,
    ),
    /invalid_ready_notification_control_cursor/,
  );
});

function request(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
      ...init.headers,
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function env(overrides: Partial<Pick<Env,
  'COMMERCE_DB' | 'COSIGNER_SECRET' | 'DATA_DB' | 'HELIUS_API_KEY' | 'NOTIFICATION_EMAIL_QUEUE' | 'OPS_DB'
>> = {}) {
  return {
    COMMERCE_DB: createCommerceD1(),
    COSIGNER_SECRET: bs58.encode(Keypair.generate().secretKey),
    HELIUS_API_KEY: 'helius-test-key',
    NOTIFICATION_EMAIL_QUEUE: notificationQueue(),
    OPS_DB: readyNotificationControlHarness().db,
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'auth-uid' }),
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

async function nativeDeliveryContext(fields: Record<string, unknown>) {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(READY_NOTIFICATION_NOW_MS, async (unit) => {
    await unit.create(commerceKeys.deliveryOrder('card_nft_2', '7'), fields as any);
  });
  return {
    harness,
    context: {
      commerceDb: harness.db,
      nowMs: READY_NOTIFICATION_NOW_MS,
      providerFetch: async () => assert.fail('commerce persistence must not use provider fetch'),
      signal: new AbortController().signal,
      dataDb: undefined as D1Database | undefined,
    },
  };
}

test('native ready-to-ship persistence includes notification and pack-status outboxes', async () => {
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
    addressSnapshot: { email: 'buyer@example.com' },
    items: [{ kind: 'box', refId: 3 }],
  });
  const document = await deliveryReceiptRuntime.readDocument(
    native.context,
    'drops/card_nft_2/deliveryOrders/7',
  );
  assert.ok(document);
  await deliveryReceiptTestHooks.markDeliveryReady(native.context, document, runtime, {
    signature: SIGNATURE,
    receiptsMinted: 1,
    receiptTxs: [SIGNATURE],
    irlClaims: [],
  });
  const ready = await deliveryReceiptRuntime.readDocument(
    native.context,
    'drops/card_nft_2/deliveryOrders/7',
  );
  assert.equal(ready?.fields.status, 'ready_to_ship');
  assert.equal(ready?.fields.buyerOrderReceivedEmailState, 'pending');
  assert.equal(ready?.fields.shipperReadyToShipEmailState, 'pending');
  assert.equal(ready?.fields.packStatusProjectionState, 'pending');
  assert.equal(ready?.fields.packStatusProjectionNextAttemptAtMs, READY_NOTIFICATION_NOW_MS);
});

test('native ready-notification publication claims, queues, and finalizes atomically', async () => {
  const native = await nativeDeliveryContext(readyNotificationOrderFields(7));
  const document = await deliveryReceiptRuntime.readDocument(
    native.context,
    'drops/card_nft_2/deliveryOrders/7',
  );
  assert.ok(document);
  const control = readyNotificationControlHarness();
  const jobs: unknown[] = [];
  assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: native.context,
    deliveryId: 7,
    document,
    dropId: 'card_nft_2',
    opsDb: control.db,
    queue: notificationQueue({
      sendBatch: async (messages) => {
        jobs.push(...Array.from(messages, (message) => message.body));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
  }), true);
  const finalized = await deliveryReceiptRuntime.readDocument(
    native.context,
    'drops/card_nft_2/deliveryOrders/7',
  );
  assert.equal(jobs.length, 1);
  assert.equal(finalized?.fields.buyerOrderReceivedEmailState, 'queued');
  assert.equal(finalized?.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
});

test('native pack-status projection applies once and marks the delivery complete', async () => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    status: 'ready_to_ship',
    packStatusProjectionState: 'pending',
    packStatusProjectionNextAttemptAtMs: READY_NOTIFICATION_NOW_MS,
    packStatusProjectionFailureCount: 0,
    items: [{ kind: 'box', refId: 1 }],
  });
  const projection = projectionDataDb();
  native.context.dataDb = projection.db;
  assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: native.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    nowMs: () => READY_NOTIFICATION_NOW_MS,
  }), 'completed');
  const completed = await deliveryReceiptRuntime.readDocument(
    native.context,
    'drops/card_nft_2/deliveryOrders/7',
  );
  assert.equal(projection.applied, 1);
  assert.equal(completed?.fields.packStatusProjectionState, 'completed');
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

test('read-only commerce rollback is best effort', async () => {
  const context = {
    commerceDb: createCommerceD1(),
    nowMs: Date.now(),
    providerFetch: async () => Response.json({}),
    signal: new AbortController().signal,
  };
  const transaction = await deliveryReceiptRuntime.beginTransaction(context);
  await assert.doesNotReject(deliveryReceiptTestHooks.rollbackTransactionBestEffort(context, transaction));
});

test('pending ready recovery queries all outbox marker states', async () => {
  const native = await nativeDeliveryContext(readyNotificationOrderFields(7, true));
  const result = await deliveryReceiptTestHooks.runPendingReadyNotificationQuery(native.context, OWNER);
  assert.equal(result.length, 1);
  assert.equal(result[0].fields.buyerOrderReceivedEmailState, 'pending');
  assert.equal(result[0].fields.shipperReadyToShipEmailState, 'pending');
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
    dependencies({ verifyIdentity: async () => { throw new RequestIdentityError('invalid-token'); } }),
  );
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.authOutcome, 'rejected');

  const provider = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {}),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    () => undefined,
    dependencies({ verifyIdentity: async () => { throw new RequestIdentityError('provider-unavailable'); } }),
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
      verifyIdentity: async (_authorization: unknown, _fetch: unknown, signal: AbortSignal) =>
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
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'prepared',
    receiptRecovery: { preparedProbeCount: 0, leaseExpiresAt: 90_000 },
  });
  await deliveryReceiptTestHooks.handlePreparedRecoveryFailure(
    native.context,
    path,
    'missing_delivery',
    'failed-precondition',
    1_000,
  );
  await deliveryReceiptTestHooks.handlePreparedRecoveryFailure(
    native.context,
    path,
    'failed',
    'unavailable',
    2_000,
  );
  const recovered = await deliveryReceiptRuntime.readDocument(native.context, path);
  const recovery = recovered?.fields.receiptRecovery as Record<string, unknown>;
  assert.equal(recovery.preparedProbeCount, 1);
  assert.equal(recovery.lastPreparedProbeAt, 1_000);
  assert.equal(recovery.nextPreparedProbeAt, 90_000);
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
