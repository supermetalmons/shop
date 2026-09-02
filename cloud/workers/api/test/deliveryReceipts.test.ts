import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCommerceD1,
  createCommerceD1Harness,
  seedCommerceDocument,
  seedCommerceDocuments,
} from './commerceD1Harness.ts';
import {
  createDeferredWorkCollector,
  failOnDeferredWork,
  isDeferredWorkRegistrationError,
} from './deferredWork.ts';
import bs58 from 'bs58';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
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
import { registerDeferredWork } from '../src/deferredWork.ts';
import {
  compareAndSetReadyNotificationCursor,
  loadReadyNotificationCursor,
} from '../src/d1ReadyNotificationCursor.ts';
import {
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD,
} from '../src/readyToShipNotifications.ts';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';

const OWNER = Keypair.generate().publicKey.toBase58();
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));
const SECOND_SIGNATURE = bs58.encode(new Uint8Array(64).fill(8));
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

function readyNotificationCursorHarness(args: {
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
  const execute = (statement: ReadyNotificationTestStatement): D1Result<Record<string, unknown>> => {
    if (statement.query.includes('FROM auth_wallet_bindings')) {
      return readyNotificationD1Result([{
        auth_subject: 'auth-uid',
        wallet: OWNER,
        updated_at_ms: READY_NOTIFICATION_NOW_MS,
        revision: 1,
        reconcile_lease_id: null,
        reconcile_lease_expires_at_ms: null,
      }]);
    }
    if (statement.query.includes('INSERT INTO worker_controls')) {
      insertAttempts += 1;
      if (exists) return readyNotificationD1Result();
      exists = true;
      cursorPath = null;
      revision = 1;
      return readyNotificationD1Result([], 1);
    }
    if (statement.query.includes('SELECT control_key, cursor_path, revision')) {
      if (!exists) return readyNotificationD1Result();
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
    get cursorPath() { return cursorPath; },
    get exists() { return exists; },
    get insertAttempts() { return insertAttempts; },
    get revision() { return revision; },
  };
}

test('D1 notification cursor loads and advances with revision CAS', async () => {
  const cursor = readyNotificationCursorHarness();
  assert.deepEqual(await loadReadyNotificationCursor(cursor.db, READY_NOTIFICATION_NOW_MS), {
    cursorPath: null,
    revision: 1,
  });
  assert.equal(await compareAndSetReadyNotificationCursor(
    cursor.db,
    'drops/card_nft_2/deliveryOrders/7',
    1,
    READY_NOTIFICATION_NOW_MS + 1,
  ), true);
  assert.equal(await compareAndSetReadyNotificationCursor(
    cursor.db,
    'drops/card_nft_2/deliveryOrders/8',
    1,
    READY_NOTIFICATION_NOW_MS + 2,
  ), false);
  assert.deepEqual(await loadReadyNotificationCursor(cursor.db, READY_NOTIFICATION_NOW_MS + 3), {
    cursorPath: 'drops/card_nft_2/deliveryOrders/7',
    revision: 2,
  });
});

test('D1 notification cursor rejects malformed state and ignores the legacy paused column', async () => {
  const malformed = readyNotificationCursorHarness({ cursorPath: 'deliveryOrders/7' });
  await assert.rejects(
    loadReadyNotificationCursor(malformed.db, READY_NOTIFICATION_NOW_MS),
    /invalid_ready_notification_cursor/,
  );
  const legacyPaused = readyNotificationCursorHarness({ paused: true });
  assert.equal(await compareAndSetReadyNotificationCursor(
    legacyPaused.db,
    'drops/card_nft_2/deliveryOrders/7',
    1,
    READY_NOTIFICATION_NOW_MS,
  ), true);
  await assert.rejects(
    compareAndSetReadyNotificationCursor(
      legacyPaused.db,
      'deliveryOrders/7',
      1,
      READY_NOTIFICATION_NOW_MS,
    ),
    /invalid_ready_notification_cursor_path/,
  );
  const noncanonical = readyNotificationCursorHarness({
    cursorPath: 'drops/Card_NFT_2/deliveryOrders/7',
  });
  await assert.rejects(
    loadReadyNotificationCursor(noncanonical.db, READY_NOTIFICATION_NOW_MS),
    /invalid_ready_notification_cursor/,
  );
  await assert.rejects(
    compareAndSetReadyNotificationCursor(
      legacyPaused.db,
      'drops/Card_NFT_2/deliveryOrders/7',
      2,
      READY_NOTIFICATION_NOW_MS,
    ),
    /invalid_ready_notification_cursor_path/,
  );
  const missing = readyNotificationCursorHarness({ exists: false });
  assert.deepEqual(await loadReadyNotificationCursor(missing.db, READY_NOTIFICATION_NOW_MS), {
    cursorPath: null,
    revision: 1,
  });
  assert.equal(missing.insertAttempts, 1);
  assert.deepEqual(missing.batchSizes, [2]);
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
    OPS_DB: readyNotificationCursorHarness().db,
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
    failOnDeferredWork,
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

test('receipt handler propagates deferred-work registration failures', async () => {
  const cause = new Error('waitUntil rejected receipt work');
  await assert.rejects(
    handleDeliveryReceiptRequest(
      request(DELIVERY_RECEIPTS_ISSUE_PATH, {
        owner: OWNER,
        deliveryId: 7,
        signature: SIGNATURE,
        dropId: 'card_nft_2',
      }),
      env(),
      DELIVERY_RECEIPTS_ISSUE_PATH,
      () => { throw cause; },
      dependencies({
        issue: async (...args: Parameters<typeof deliveryReceiptTestHooks.issueReceiptsRequest>) => {
          registerDeferredWork(args[5], Promise.resolve());
          assert.fail('registration failure must stop receipt processing');
        },
      }),
    ),
    (error: unknown) =>
      isDeferredWorkRegistrationError(error, cause),
  );
});

test('recovery failure normalization propagates deferred-work registration failures', () => {
  const cause = new Error('waitUntil rejected recovered receipt work');
  let registrationError: unknown;
  try {
    registerDeferredWork(() => { throw cause; }, Promise.resolve());
  } catch (error) {
    registrationError = error;
  }
  assert.throws(
    () => deliveryReceiptTestHooks.deliveryRecoveryFailure(registrationError),
    (error: unknown) => isDeferredWorkRegistrationError(error, cause),
  );
});

test('recovery route accepts the empty filter and reports recovery metrics', async () => {
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {}),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    failOnDeferredWork,
    dependencies(),
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.verification, 'delivery_pda');
  assert.equal(result.attempted, 1);
  assert.equal(result.recovered, 1);
  const payload = await result.response.json() as { walletRecovery: { nextCheckAt: null } };
  assert.equal(payload.walletRecovery.nextCheckAt, null);
});

async function nativeDeliveryContext(
  fields: Record<string, unknown>,
  options: Parameters<typeof createCommerceD1Harness>[0] = {},
) {
  const harness = createCommerceD1Harness(options);
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

test('unfiltered recovery uses indexed owner candidates, identity filtering, ordering, and the attempt cap', async () => {
  const harness = createCommerceD1Harness();
  let pendingBatch = Promise.resolve();
  let batchNumber = 0;
  const database = {
    prepare: (query: string) => harness.db.prepare(query),
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      batchNumber += 1;
      const currentBatch = batchNumber;
      const result = pendingBatch.then(() => harness.db.batch<T>(statements));
      pendingBatch = result.then(() => {
        if (currentBatch === 1) {
          seedCommerceDocument(harness, {
            key: commerceKeys.deliveryOrder('card_nft_2', '3'),
            data: readyNotificationOrderFields(3, true) as never,
            version: 2,
          });
        }
      }, () => undefined);
      return result;
    },
  } as D1Database;
  let recoveryQueries = 0;
  const repository = new class extends D1CommerceRepository {
    override async queryDeliveryRecoveryOrders(owner: string) {
      recoveryQueries += 1;
      return super.queryDeliveryRecoveryOrders(owner);
    }
  }(database);
  const otherOwner = Keypair.generate().publicKey.toBase58();
  seedCommerceDocuments(harness, [
    { key: commerceKeys.deliveryOrder('card_nft_2', '1'), data: { deliveryId: 1, owner: OWNER, status: 'processing', createdAt: 10 } },
    { key: commerceKeys.deliveryOrder('card_nft_2', '2'), data: { deliveryId: 2, owner: OWNER, status: 'processing', createdAt: 20 } },
    { key: commerceKeys.deliveryOrder('card_nft_2', '3'), data: { deliveryId: 3, owner: OWNER, status: 'processing', createdAt: 30 } },
    { key: commerceKeys.deliveryOrder('card_nft_2', '4'), data: { deliveryId: 4, owner: OWNER, status: 'prepared', createdAt: 40 } },
    { key: commerceKeys.deliveryOrder('card_nft_2', '6'), data: { deliveryId: 6, owner: otherOwner, status: 'processing' } },
    { key: commerceKeys.deliveryOrder('card_nft_2', 'malformed'), data: { owner: OWNER, status: 'processing' } },
  ]);
  const signal = new AbortController().signal;
  const context = {
    commerceDb: database,
    repository,
    nowMs: READY_NOTIFICATION_NOW_MS,
    providerFetch: async () => assert.fail('unexpected provider fetch'),
    signal,
    dataDb: undefined as D1Database | undefined,
  };
  const retried: number[] = [];
  const result = await deliveryReceiptTestHooks.recoverReceiptsRequest(
    {},
    { kind: 'staff-wallet', wallet: OWNER },
    env({ COMMERCE_DB: database }),
    context,
    { apiKey: 'helius', fetch: async () => assert.fail('unexpected provider fetch'), signal },
    failOnDeferredWork,
    {
      hasConfirmedDeliveryRecord: async () => true,
      retryIssueReceipts: async ({ request: retryRequest }) => {
        retried.push(retryRequest.deliveryId);
        return {
          processed: true,
          deliveryId: retryRequest.deliveryId,
          receiptsMinted: 1,
          receiptTxs: [],
          closeDeliveryTx: null,
        };
      },
    },
  );

  assert.deepEqual(retried, [1, 2, 3]);
  assert.equal(result.attempted, 2);
  assert.equal(result.recovered, 3);
  assert.deepEqual(result.results.map(({ deliveryId, outcome }) => ({ deliveryId, outcome })), [
    { deliveryId: 1, outcome: 'recovered' },
    { deliveryId: 2, outcome: 'recovered' },
    { deliveryId: 3, outcome: 'recovered' },
    { deliveryId: 4, outcome: 'attempt_capped' },
  ]);
  assert.equal(recoveryQueries, 2);
});

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
  const jobs: unknown[] = [];
  assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
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
  const finalized = await deliveryReceiptRuntime.readDocument(
    native.context,
    'drops/card_nft_2/deliveryOrders/7',
  );
  assert.equal(jobs.length, 1);
  assert.equal(finalized?.fields.buyerOrderReceivedEmailState, 'queued');
  assert.equal(finalized?.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
});

test('pre-enqueue cancellation releases the ready-notification claim and attempt', async () => {
  const native = await nativeDeliveryContext(readyNotificationOrderFields(7));
  const document = await deliveryReceiptRuntime.readDocument(
    native.context,
    'drops/card_nft_2/deliveryOrders/7',
  );
  assert.ok(document);
  const cancellation = new DOMException('request cancelled', 'AbortError');
  const controller = new AbortController();
  controller.abort(cancellation);
  native.context.signal = controller.signal;
  let queueCalls = 0;
  await assert.rejects(
    deliveryReceiptTestHooks.publishReadyToShipNotifications({
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
  const released = await deliveryReceiptRuntime.readDocument(
    native.context,
    'drops/card_nft_2/deliveryOrders/7',
  );
  assert.equal(queueCalls, 0);
  assert.equal(released?.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD], 0);
  assert.equal(released?.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
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

test('pack-status projection persists retry state when a non-cooperative D1 write is cancelled', async () => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    status: 'ready_to_ship',
    packStatusProjectionState: 'pending',
    packStatusProjectionNextAttemptAtMs: 0,
    packStatusProjectionFailureCount: 0,
    items: [{ kind: 'box', refId: 1 }],
  });
  const controller = new AbortController();
  const cancellation = new DOMException('caller cancelled', 'AbortError');
  const projection = projectionDataDb({
    delay: () => new Promise<void>(() => controller.abort(cancellation)),
  });
  native.context.dataDb = projection.db;
  native.context.signal = controller.signal;

  const outcome = await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: native.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    nowMs: () => READY_NOTIFICATION_NOW_MS,
  });
  const pending = await deliveryReceiptRuntime.readDocument(
    { ...native.context, signal: new AbortController().signal },
    'drops/card_nft_2/deliveryOrders/7',
  );

  assert.equal(outcome, 'pending');
  assert.equal(projection.attempts, 1);
  assert.equal(pending?.fields.packStatusProjectionState, 'pending');
  assert.equal(pending?.fields.packStatusProjectionFailureCount, 1);
  assert.equal(pending?.fields.packStatusProjectionLastErrorCode, 'aborted');
  assert.equal(pending?.fields.packStatusProjectionNextAttemptAtMs, READY_NOTIFICATION_NOW_MS + 5 * 60_000);
});

test('scheduled pack-status projection survives request cancellation', async () => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    status: 'ready_to_ship',
    packStatusProjectionState: 'pending',
    packStatusProjectionNextAttemptAtMs: 0,
    packStatusProjectionFailureCount: 0,
    items: [{ kind: 'box', refId: 1 }],
  });
  const projection = projectionDataDb();
  const controller = new AbortController();
  native.context.dataDb = projection.db;
  native.context.signal = controller.signal;
  const deferred = createDeferredWorkCollector();
  controller.abort(new Error('client disconnected'));

  deliveryReceiptTestHooks.scheduleDeliveryPackStatusProjection({
    context: native.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    waitUntil: deferred.defer,
  });
  await deferred.drain();

  const completed = await deliveryReceiptRuntime.readDocument(
    { ...native.context, signal: new AbortController().signal },
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
    failOnDeferredWork,
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
    failOnDeferredWork,
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
      failOnDeferredWork,
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
    failOnDeferredWork,
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
  let authorityReads = 0;
  const harness = createCommerceD1Harness({
    observeStatement: ({ method, sql }) => {
      if (method === 'first' && sql.includes('FROM commerce_authority_control')) authorityReads += 1;
    },
  });
  const context = {
    commerceDb: harness.db,
    nowMs: Date.now(),
    providerFetch: async () => Response.json({}),
    signal: new AbortController().signal,
  };
  const transaction = await deliveryReceiptRuntime.beginTransaction(context);
  authorityReads = 0;
  await assert.doesNotReject(deliveryReceiptTestHooks.rollbackTransactionBestEffort(context, transaction));
  assert.equal(authorityReads, 0);
});

test('existing assignment revalidates paused authority before returning', async () => {
  let harness: ReturnType<typeof createCommerceD1Harness>;
  let armed = false;
  harness = createCommerceD1Harness({
    observeBatchAfterCommit: ({ statements }) => {
      if (
        armed &&
        statements.length === 2 &&
        statements.some(({ sql }) => sql.includes('commerce_document_path_revisions')) &&
        statements.some(({ sql }) => sql.includes('FROM commerce_documents'))
      ) {
        armed = false;
        const nowMsSql = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
        harness.database.exec(`INSERT INTO commerce_authority_control_lease VALUES (
          1, '123e4567-e89b-42d3-a456-426614174000', ${nowMsSql}, ${nowMsSql} + 60000
        )`);
        harness.database.exec(`UPDATE commerce_authority_control SET
          authority_state = 'paused', revision = revision + 1, paused_at_ms = NULL,
          updated_at_ms = ${nowMsSql} WHERE singleton = 1`);
        harness.database.exec('DELETE FROM commerce_authority_control_lease');
      }
    },
  });
  seedCommerceDocument(harness, {
    key: commerceKeys.boxAssignment('drop', 'box'),
    data: { dudeIds: [1] },
  });
  armed = true;
  const assign = deliveryReceiptRuntime.assignDudesForBox;
  const context = {
    commerceDb: harness.db,
    repository: new D1CommerceRepository(harness.db),
    nowMs: 1_700_000_000_000,
    providerFetch: fetch,
    signal: new AbortController().signal,
  } as Parameters<typeof assign>[0];
  const runtime = {
    config: { dropFamily: 'poncho_drifella' },
    dropId: 'drop',
    itemsPerBox: 1,
    maxDudeId: 2,
  } as Parameters<typeof assign>[1];
  await assert.rejects(
    assign(context, runtime, 'box', () => 0),
    (error: unknown) =>
      error instanceof deliveryReceiptTestHooks.DeliveryReceiptError && error.code === 'unavailable',
  );
});

test('pending ready recovery queries all outbox marker states', async () => {
  const native = await nativeDeliveryContext(readyNotificationOrderFields(7, true));
  const result = await deliveryReceiptTestHooks.runPendingReadyNotificationQuery(native.context, OWNER);
  assert.equal(result.length, 1);
  assert.equal(result[0].fields.buyerOrderReceivedEmailState, 'pending');
  assert.equal(result[0].fields.shipperReadyToShipEmailState, 'pending');
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
        } as any,
      );
    }
    await unit.create(
      commerceKeys.deliveryOrder('card_nft_2', '9'),
      readyNotificationOrderFields(9) as any,
    );
  });
  const context = {
    commerceDb: harness.db,
    nowMs: READY_NOTIFICATION_NOW_MS,
    providerFetch: async () => assert.fail('commerce persistence must not use provider fetch'),
    signal: new AbortController().signal,
    dataDb: undefined as D1Database | undefined,
  };
  const result = await deliveryReceiptTestHooks.runPendingReadyNotificationQuery(context, OWNER);
  assert.deepEqual(result.map((document) => document.id), ['9']);
});

test('receipt routes enforce bounded JSON and required runtime configuration', async () => {
  const oversized = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, { dropId: 'x'.repeat(5000) }),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    failOnDeferredWork,
    dependencies(),
  );
  assert.equal(oversized.response.status, 400);

  const unavailable = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {}),
    env({ HELIUS_API_KEY: '' }),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    failOnDeferredWork,
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
    failOnDeferredWork,
    dependencies({ verifyIdentity: async () => { throw new RequestIdentityError('invalid-token'); } }),
  );
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.authOutcome, 'rejected');

  const provider = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_RECOVER_PATH, {}),
    env(),
    DELIVERY_RECEIPTS_RECOVER_PATH,
    failOnDeferredWork,
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
    failOnDeferredWork,
    dependencies({
      timeoutMs: 5,
      verifyIdentity: async (_authorization: unknown, _fetch: unknown, signal: AbortSignal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    }),
  );
  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});

test('receipt route deadlines retain exactly one stalled issue or recovery operation', async () => {
  for (const path of [DELIVERY_RECEIPTS_ISSUE_PATH, DELIVERY_RECEIPTS_RECOVER_PATH] as const) {
    const deferred = createDeferredWorkCollector();
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const issueResult = {
      processed: true as const,
      deliveryId: 7,
      receiptsMinted: 3,
      receiptTxs: [SIGNATURE],
      closeDeliveryTx: null,
    };
    const recoverResult = {
      attempted: 0,
      recovered: 0,
      remainingProcessing: 0,
      walletRecovery: { remainingProcessing: 0, nextCheckAt: null },
      results: [],
    };
    const stalled = new Promise<typeof issueResult | typeof recoverResult>((resolve) => {
      release = () => resolve(path === DELIVERY_RECEIPTS_ISSUE_PATH ? issueResult : recoverResult);
    });
    const pending = handleDeliveryReceiptRequest(
      request(path, path === DELIVERY_RECEIPTS_ISSUE_PATH ? {
        owner: OWNER,
        deliveryId: 7,
        signature: SIGNATURE,
        dropId: 'card_nft_2',
      } : {}),
      env(),
      path,
      deferred.defer,
      dependencies({
        timeoutMs: 5,
        issue: async () => {
          markStarted();
          return stalled as Promise<typeof issueResult>;
        },
        recover: async () => {
          markStarted();
          return stalled as Promise<typeof recoverResult>;
        },
      }),
    );

    await started;
    const result = await pending;
    assert.equal(result.response.status, 504);
    assert.equal(deferred.promises.length, 1);
    release();
    await deferred.drain();
    assert.equal(deferred.promises.length, 1);
  }
});

test('receipt provider body cancellation wins a reader cancellation result', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected during provider body');
  const reading = deliveryReceiptTestHooks.readBoundedProviderResponse(
    new Response(new ReadableStream<Uint8Array>({ start() {} })),
    controller.signal,
  );

  controller.abort(reason);

  await assert.rejects(reading, (error: unknown) => error === reason);
});

test('receipt provider stream failures retain the temporary unavailable message', async () => {
  const streamFailure = new Error('provider stream failed');
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(streamFailure);
    },
  }));

  await assert.rejects(
    deliveryReceiptTestHooks.readBoundedProviderResponse(
      response,
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof deliveryReceiptTestHooks.DeliveryReceiptError &&
      error.code === 'unavailable' &&
      error.message === 'Receipt provider is temporarily unavailable.',
  );
});

test('receipt wallet binding preserves the error that wins an abort race', async () => {
  const controller = new AbortController();
  const d1Failure = new Error('D1 wallet binding failed first');
  const clientReason = new Error('late client disconnect');
  const statement = {
    bind() {
      return this;
    },
    first() {
      return new Promise((_resolve, reject) => {
        reject(d1Failure);
        controller.abort(clientReason);
      });
    },
  } as unknown as D1PreparedStatement;
  const context = {
    commerceDb: createCommerceD1(),
    nowMs: READY_NOTIFICATION_NOW_MS,
    providerFetch: fetch,
    signal: controller.signal,
  } as Parameters<typeof deliveryReceiptTestHooks.loadBoundWallet>[0];

  await assert.rejects(
    deliveryReceiptTestHooks.loadBoundWallet(
      context,
      { prepare: () => statement } as unknown as D1Database,
      'auth-user',
    ),
    (error: unknown) =>
      error instanceof deliveryReceiptTestHooks.DeliveryReceiptError && error.code === 'unavailable',
  );

  const cancelledController = new AbortController();
  const cancellation = new Error('client disconnected during wallet binding');
  const cancelledStatement = {
    bind() {
      return this;
    },
    first() {
      cancelledController.abort(cancellation);
      return Promise.reject(cancellation);
    },
  } as unknown as D1PreparedStatement;
  await assert.rejects(
    deliveryReceiptTestHooks.loadBoundWallet(
      { ...context, signal: cancelledController.signal },
      { prepare: () => cancelledStatement } as unknown as D1Database,
      'auth-user',
    ),
    (error: unknown) => error === cancellation,
  );
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

  await deliveryReceiptTestHooks.persistPendingReceiptSubmission(native.context, path, pending);
  let stored = await deliveryReceiptRuntime.readDocument(native.context, path);
  assert.deepEqual(
    (stored?.fields.receiptRecovery as Record<string, unknown>).pendingSubmission,
    pending,
  );
  assert.deepEqual(stored?.fields.receiptTxs, [SIGNATURE]);

  await deliveryReceiptTestHooks.settlePendingReceiptSubmission(
    native.context,
    path,
    pending,
    'confirmed',
  );
  await deliveryReceiptTestHooks.settlePendingReceiptSubmission(
    native.context,
    path,
    pending,
    'confirmed',
  );

  stored = await deliveryReceiptRuntime.readDocument(native.context, path);
  assert.deepEqual(stored?.fields.receiptTxs, [SIGNATURE, SECOND_SIGNATURE]);
  assert.deepEqual(
    deliveryReceiptTestHooks.confirmedReceiptTransactions(stored?.fields || {}),
    [SIGNATURE, SECOND_SIGNATURE],
  );
  assert.equal((stored?.fields.receiptRecovery as Record<string, unknown> | undefined)?.pendingSubmission, undefined);
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
  await deliveryReceiptTestHooks.persistPendingReceiptSubmission(native.context, path, pending);

  const stored = await deliveryReceiptRuntime.readDocument(native.context, path);
  assert.deepEqual(
    (stored?.fields.receiptRecovery as Record<string, unknown>).pendingSubmission,
    pending,
  );
});

test('receipt submission retry reconciliation distinguishes confirmed, expired, and unresolved', async () => {
  const pending = {
    signature: SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };
  const connection = (overrides: Partial<Pick<Connection,
    'getMultipleAccountsInfo' | 'getSignatureStatuses' | 'isBlockhashValid'
  >>) => ({
    getMultipleAccountsInfo: async () => [{ data: Buffer.alloc(1) }],
    getSignatureStatuses: async () => ({ context: { apiVersion: 'test', slot: 1 }, value: [null] }),
    isBlockhashValid: async () => ({ context: { apiVersion: 'test', slot: 1 }, value: true }),
    ...overrides,
  }) as unknown as Connection;

  assert.equal(await deliveryReceiptTestHooks.probePendingReceiptSubmission(
    connection({ getMultipleAccountsInfo: async () => [null] }),
    pending,
  ), 'confirmed');
  for (const confirmations of [null, 2]) {
    let postStateChecks = 0;
    assert.equal(await deliveryReceiptTestHooks.probePendingReceiptSubmission(
      connection({
        getMultipleAccountsInfo: async () => {
          postStateChecks += 1;
          return [null];
        },
        getSignatureStatuses: async () => ({
          context: { apiVersion: 'test', slot: 1 },
          value: [{ confirmations, err: null, slot: 1 }],
        }),
      }),
      pending,
    ), 'confirmed');
    assert.equal(postStateChecks, 0);
  }
  assert.equal(await deliveryReceiptTestHooks.probePendingReceiptSubmission(
    connection({
      getMultipleAccountsInfo: async () => { throw new Error('unexpected post-state fallback'); },
      getSignatureStatuses: async () => ({
        context: { apiVersion: 'test', slot: 1 },
        value: [{ confirmationStatus: 'processed', confirmations: null, err: null, slot: 1 }],
      }),
    }),
    pending,
  ), 'unresolved');
  assert.equal(await deliveryReceiptTestHooks.probePendingReceiptSubmission(
    connection({ isBlockhashValid: async () => ({ context: { apiVersion: 'test', slot: 1 }, value: false }) }),
    pending,
  ), 'expired');
  assert.equal(await deliveryReceiptTestHooks.probePendingReceiptSubmission(
    connection({}),
    pending,
  ), 'unresolved');
  assert.equal(await deliveryReceiptTestHooks.probePendingReceiptSubmission(
    connection({
      getMultipleAccountsInfo: async () => [null],
      getSignatureStatuses: async () => ({
        context: { apiVersion: 'test', slot: 1 },
        value: [{ confirmations: null, err: { InstructionError: [0, 'Custom'] }, slot: 1 } as never],
      }),
    }),
    pending,
  ), 'expired');
});

test('receipt confirmation polling accepts rooted legacy signature statuses', async () => {
  for (const confirmations of [null, 2]) {
    let transactionLookups = 0;
    const result = await deliveryReceiptTestHooks.waitForSignature({
      getSignatureStatuses: async () => ({
        context: { apiVersion: 'test', slot: 1 },
        value: [{ confirmations, err: null, slot: 1 }],
      }),
      getTransaction: async () => {
        transactionLookups += 1;
        return null;
      },
    } as unknown as Connection, SIGNATURE, new AbortController().signal, 100);
    assert.deepEqual(result, { ok: true });
    assert.equal(transactionLookups, 0);
  }
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
  await deliveryReceiptTestHooks.persistPendingReceiptSubmission(native.context, path, pending);
  await deliveryReceiptTestHooks.settlePendingReceiptSubmission(
    native.context,
    path,
    pending,
    'expired',
  );
  const stored = await deliveryReceiptRuntime.readDocument(native.context, path);
  assert.equal((stored?.fields.receiptRecovery as Record<string, unknown>).pendingSubmission, undefined);
  assert.deepEqual(stored?.fields.receiptTxs, undefined);
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

test('delivery recovery cancellation stops probes and restores its lease attempt', async () => {
  const recover = deliveryReceiptTestHooks.recoverReceiptsRequest;
  const identity = { kind: 'staff-wallet' as const, wallet: OWNER };

  for (const stage of ['eligibility', 'probe'] as const) {
    const native = await nativeDeliveryContext({
      deliveryId: 7,
      owner: OWNER,
      status: 'prepared',
      receiptRecovery: { preparedProbeCount: 0 },
    });
    const controller = new AbortController();
    const reason = new Error(`${stage} cancelled`);
    native.context.signal = controller.signal;
    await assert.rejects(
      recover(
        { dropId: 'card_nft_2', deliveryId: 7 },
        identity,
        env({ COMMERCE_DB: native.harness.db }),
        native.context,
        { apiKey: 'helius', fetch: async () => assert.fail('unexpected fetch'), signal: controller.signal },
        failOnDeferredWork,
        stage === 'eligibility'
          ? {
              hasConfirmedDeliveryRecord: async () => {
                controller.abort(reason);
                throw reason;
              },
            }
          : {
              hasConfirmedDeliveryRecord: async () => false,
              recordPreparedDeliveryRecoveryMiss: async () => {
                controller.abort(reason);
                throw reason;
              },
            },
      ),
      (error: unknown) => error === reason,
    );
    const stored = await deliveryReceiptRuntime.readDocument(
      { ...native.context, signal: new AbortController().signal },
      'drops/card_nft_2/deliveryOrders/7',
    );
    assert.equal((stored?.fields.receiptRecovery as Record<string, unknown>).preparedProbeCount, 0);
  }

  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
    receiptRecovery: { attemptCount: 2, lastAttemptAt: 1 },
  });
  const controller = new AbortController();
  const reason = new Error('receipt issue cancelled');
  native.context.signal = controller.signal;
  await assert.rejects(
    recover(
      { dropId: 'card_nft_2', deliveryId: 7 },
      identity,
      env({ COMMERCE_DB: native.harness.db }),
      native.context,
      { apiKey: 'helius', fetch: async () => assert.fail('unexpected fetch'), signal: controller.signal },
      failOnDeferredWork,
      {
        retryIssueReceipts: async () => {
          controller.abort(reason);
          throw reason;
        },
      },
    ),
    (error: unknown) => error === reason,
  );
  const stored = await deliveryReceiptRuntime.readDocument(
    { ...native.context, signal: new AbortController().signal },
    'drops/card_nft_2/deliveryOrders/7',
  );
  const recovery = stored?.fields.receiptRecovery as Record<string, unknown>;
  assert.equal(recovery.leaseExpiresAt, undefined);
  assert.equal(recovery.lastAttemptAt, 1);
  assert.equal(recovery.attemptCount, 2);
  assert.equal(recovery.lastErrorCode, undefined);
  assert.equal(recovery.nextPreparedProbeAt, undefined);

  const issueNative = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
    receiptRecovery: { attemptCount: 4, lastAttemptAt: 2 },
  });
  const issueController = new AbortController();
  const issueReason = new Error('direct issue cancelled');
  issueNative.context.signal = issueController.signal;
  await assert.rejects(
    deliveryReceiptTestHooks.issueReceiptsRequest(
      { owner: OWNER, deliveryId: 7, signature: SIGNATURE, dropId: 'card_nft_2' },
      identity,
      env({ COMMERCE_DB: issueNative.harness.db }),
      issueNative.context,
      { apiKey: 'helius', fetch: async () => assert.fail('unexpected fetch'), signal: issueController.signal },
      failOnDeferredWork,
      {
        retryIssueReceipts: async () => {
          issueController.abort(issueReason);
          throw issueReason;
        },
      },
    ),
    (error: unknown) => error === issueReason,
  );
  const issueStored = await deliveryReceiptRuntime.readDocument(
    { ...issueNative.context, signal: new AbortController().signal },
    'drops/card_nft_2/deliveryOrders/7',
  );
  const issueRecovery = issueStored?.fields.receiptRecovery as Record<string, unknown>;
  assert.equal(issueRecovery.leaseExpiresAt, undefined);
  assert.equal(issueRecovery.lastAttemptAt, 2);
  assert.equal(issueRecovery.attemptCount, 4);
  assert.equal(issueRecovery.lastErrorCode, undefined);
});

test('receipt batch cancellation after send preserves its deterministic submission', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected after receipt send');
  const signer = Keypair.generate();
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  let preparedSignature = '';
  let submittedSignature = '';

  await assert.rejects(
    deliveryReceiptTestHooks.sendReceiptBatch({
      connection: {
        getLatestBlockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 123,
        }),
        sendTransaction: async (transaction: { signatures: Uint8Array[] }) => {
          submittedSignature = bs58.encode(transaction.signatures[0]);
          assert.equal(preparedSignature, submittedSignature);
          controller.abort(reason);
          return submittedSignature;
        },
      } as unknown as Parameters<typeof deliveryReceiptTestHooks.sendReceiptBatch>[0]['connection'],
      runtime,
      signer,
      owner: signer.publicKey,
      coreCollection: Keypair.generate().publicKey,
      batch: [{
        asset: Keypair.generate().publicKey,
        kind: 'box',
        refId: 1,
      }],
      signal: controller.signal,
      lifecycle: {
        prepare: async (pending) => { preparedSignature = pending.signature; },
        reconcile: async () => assert.fail('cancelled submission reached reconciliation'),
        settle: async () => assert.fail('cancelled submission was settled'),
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof deliveryReceiptTestHooks.DeliveryReceiptError);
      assert.equal(error.cause, reason);
      assert.equal((error.details as Record<string, unknown>).signature, submittedSignature);
      assert.equal((error.details as Record<string, unknown>).maybeSubmitted, true);
      return true;
    },
  );
});

test('receipt batch cancellation before broadcast survives a lost settlement acknowledgement', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled before receipt broadcast');
  let armed = false;
  let lostAcknowledgement = false;
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
  }, {
    observeBatchAfterCommit: (observation) => {
      if (!armed || !observation.statements.some(({ sql }) => sql.includes('INSERT INTO commerce_commit_guards'))) return;
      armed = false;
      lostAcknowledgement = true;
      throw new Error('lost receipt settlement acknowledgement');
    },
  });
  native.context.signal = controller.signal;
  const path = 'drops/card_nft_2/deliveryOrders/7';
  const signer = Keypair.generate();
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');

  await assert.rejects(
    deliveryReceiptTestHooks.sendReceiptBatch({
      connection: {
        getLatestBlockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 123,
        }),
        sendTransaction: async () => assert.fail('cancelled receipt reached broadcast'),
      } as unknown as Parameters<typeof deliveryReceiptTestHooks.sendReceiptBatch>[0]['connection'],
      runtime,
      signer,
      owner: signer.publicKey,
      coreCollection: Keypair.generate().publicKey,
      batch: [{
        asset: Keypair.generate().publicKey,
        kind: 'box',
        refId: 1,
      }],
      signal: controller.signal,
      lifecycle: {
        prepare: async (pending) => {
          await deliveryReceiptTestHooks.persistPendingReceiptSubmission(native.context, path, pending);
          armed = true;
          controller.abort(reason);
        },
        reconcile: async () => assert.fail('cancelled receipt reached reconciliation'),
        settle: (pending, outcome) => deliveryReceiptTestHooks.settlePendingReceiptSubmission(
          { ...native.context, signal: new AbortController().signal },
          path,
          pending,
          outcome,
        ),
      },
    }),
    (error) => error === reason,
  );

  const stored = await deliveryReceiptRuntime.readDocument(
    { ...native.context, signal: new AbortController().signal },
    path,
  );
  assert.equal(lostAcknowledgement, true);
  assert.equal((stored?.fields.receiptRecovery as Record<string, unknown>).pendingSubmission, undefined);
  assert.equal(stored?.fields.receiptTxs, undefined);
});

test('receipt batch keeps write-ahead state when D1 promotion fails after confirmation', async () => {
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
  });
  const path = 'drops/card_nft_2/deliveryOrders/7';
  const signer = Keypair.generate();
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  const persistenceError = new Error('D1 promotion failed');
  let submittedSignature = '';

  await assert.rejects(
    deliveryReceiptTestHooks.sendReceiptBatch({
      connection: {
        getLatestBlockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 123,
        }),
        sendTransaction: async (transaction: { signatures: Uint8Array[] }) => {
          submittedSignature = bs58.encode(transaction.signatures[0]);
          return submittedSignature;
        },
        getSignatureStatuses: async () => ({
          context: { apiVersion: 'test', slot: 1 },
          value: [{ confirmationStatus: 'confirmed', confirmations: 1, err: null, slot: 1 }],
        }),
      } as unknown as Parameters<typeof deliveryReceiptTestHooks.sendReceiptBatch>[0]['connection'],
      runtime,
      signer,
      owner: signer.publicKey,
      coreCollection: Keypair.generate().publicKey,
      batch: [{
        asset: Keypair.generate().publicKey,
        kind: 'box',
        refId: 1,
      }],
      signal: native.context.signal,
      lifecycle: {
        prepare: (pending) => deliveryReceiptTestHooks.persistPendingReceiptSubmission(
          native.context,
          path,
          pending,
        ),
        reconcile: async () => assert.fail('confirmed submission reached reconciliation'),
        settle: async (_pending, outcome) => {
          assert.equal(outcome, 'confirmed');
          throw persistenceError;
        },
      },
    }),
    (error) => error === persistenceError,
  );

  const stored = await deliveryReceiptRuntime.readDocument(native.context, path);
  const recovery = stored?.fields.receiptRecovery as Record<string, unknown>;
  assert.equal((recovery.pendingSubmission as Record<string, unknown>).signature, submittedSignature);
  assert.equal(stored?.fields.receiptTxs, undefined);
});

test('receipt batch never promotes a failed signature from missing account evidence', async () => {
  const controller = new AbortController();
  const stop = new Error('stop after definitive settlement');
  const signer = Keypair.generate();
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  const settled: string[] = [];

  await assert.rejects(
    deliveryReceiptTestHooks.sendReceiptBatch({
      connection: {
        getLatestBlockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 123,
        }),
        sendTransaction: async () => SIGNATURE,
        getSignatureStatuses: async () => ({
          context: { apiVersion: 'test', slot: 1 },
          value: [{ confirmationStatus: null, confirmations: null, err: { InstructionError: [0, 'Custom'] }, slot: 1 }],
        }),
        getTransaction: async () => ({ meta: { err: { InstructionError: [0, 'Custom'] }, logMessages: [] } }),
        getMultipleAccountsInfo: async () => assert.fail('failed signature reached account evidence'),
      } as unknown as Parameters<typeof deliveryReceiptTestHooks.sendReceiptBatch>[0]['connection'],
      runtime,
      signer,
      owner: signer.publicKey,
      coreCollection: Keypair.generate().publicKey,
      batch: [{
        asset: Keypair.generate().publicKey,
        kind: 'box',
        refId: 1,
      }],
      signal: controller.signal,
      lifecycle: {
        prepare: async () => undefined,
        reconcile: async () => assert.fail('failed signature reached reconciliation'),
        settle: async (_pending, outcome) => {
          settled.push(outcome);
          controller.abort(stop);
        },
      },
    }),
    (error) => error === stop,
  );
  assert.deepEqual(settled, ['expired']);
});

test('ambiguous receipt cancellation keeps its lease and unrelated errors win abort races', async () => {
  const identity = { kind: 'staff-wallet' as const, wallet: OWNER };
  const ambiguousNative = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
    receiptRecovery: { attemptCount: 2, lastAttemptAt: 1 },
  });
  const ambiguousController = new AbortController();
  const ambiguousReason = new Error('receipt submission disconnected');
  ambiguousNative.context.signal = ambiguousController.signal;
  ambiguousNative.context.nowMs = Date.now();
  const ambiguousError = new deliveryReceiptTestHooks.DeliveryReceiptError(
    'aborted',
    'Receipt submission status is unknown.',
    { signature: SIGNATURE, maybeSubmitted: true },
  );
  Object.defineProperty(ambiguousError, 'cause', { value: ambiguousReason });
  const pendingSubmission = {
    signature: SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };

  await assert.rejects(
    deliveryReceiptTestHooks.issueReceiptsRequest(
      { owner: OWNER, deliveryId: 7, signature: SIGNATURE, dropId: 'card_nft_2' },
      identity,
      env({ COMMERCE_DB: ambiguousNative.harness.db }),
      ambiguousNative.context,
      { apiKey: 'helius', fetch: async () => assert.fail('unexpected fetch'), signal: ambiguousController.signal },
      failOnDeferredWork,
      {
        retryIssueReceipts: async () => {
          await deliveryReceiptTestHooks.persistPendingReceiptSubmission(
            ambiguousNative.context,
            'drops/card_nft_2/deliveryOrders/7',
            pendingSubmission,
          );
          ambiguousController.abort(ambiguousReason);
          throw ambiguousError;
        },
      },
    ),
    (error) => error === ambiguousReason,
  );
  const ambiguousStored = await deliveryReceiptRuntime.readDocument(
    { ...ambiguousNative.context, signal: new AbortController().signal },
    'drops/card_nft_2/deliveryOrders/7',
  );
  const ambiguousRecovery = ambiguousStored?.fields.receiptRecovery as Record<string, unknown>;
  assert.equal(Number(ambiguousRecovery.leaseExpiresAt) > Date.now() + 3 * 60_000, true);
  assert.equal(ambiguousRecovery.attemptCount, 3);
  assert.deepEqual(ambiguousRecovery.pendingSubmission, pendingSubmission);

  const domainNative = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
    receiptRecovery: { attemptCount: 4, lastAttemptAt: 2 },
  });
  const domainController = new AbortController();
  const domainReason = new Error('late disconnect');
  const domainError = new deliveryReceiptTestHooks.DeliveryReceiptError(
    'deadline-exceeded',
    'Provider deadline won.',
  );
  domainNative.context.signal = domainController.signal;
  await assert.rejects(
    deliveryReceiptTestHooks.issueReceiptsRequest(
      { owner: OWNER, deliveryId: 7, signature: SIGNATURE, dropId: 'card_nft_2' },
      identity,
      env({ COMMERCE_DB: domainNative.harness.db }),
      domainNative.context,
      { apiKey: 'helius', fetch: async () => assert.fail('unexpected fetch'), signal: domainController.signal },
      failOnDeferredWork,
      {
        retryIssueReceipts: async () => {
          domainController.abort(domainReason);
          throw domainError;
        },
      },
    ),
    (error) => error === domainError,
  );
  const domainStored = await deliveryReceiptRuntime.readDocument(
    { ...domainNative.context, signal: new AbortController().signal },
    'drops/card_nft_2/deliveryOrders/7',
  );
  const domainRecovery = domainStored?.fields.receiptRecovery as Record<string, unknown>;
  assert.equal(domainRecovery.leaseExpiresAt, undefined);
  assert.equal(domainRecovery.attemptCount, 5);
  assert.equal(domainRecovery.lastErrorCode, 'deadline-exceeded');
});

test('settled receipt submission cancellation restores the owning recovery lease', async () => {
  const identity = { kind: 'staff-wallet' as const, wallet: OWNER };
  const native = await nativeDeliveryContext({
    deliveryId: 7,
    owner: OWNER,
    status: 'processing',
    receiptRecovery: { attemptCount: 2, lastAttemptAt: 1 },
  });
  const controller = new AbortController();
  const reason = new Error('cancelled after receipt settlement');
  native.context.signal = controller.signal;
  native.context.nowMs = Date.now();
  const path = 'drops/card_nft_2/deliveryOrders/7';
  const pending = {
    signature: SIGNATURE,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 123,
    assetIds: [Keypair.generate().publicKey.toBase58()],
  };

  await assert.rejects(
    deliveryReceiptTestHooks.issueReceiptsRequest(
      { owner: OWNER, deliveryId: 7, signature: SIGNATURE, dropId: 'card_nft_2' },
      identity,
      env({ COMMERCE_DB: native.harness.db }),
      native.context,
      { apiKey: 'helius', fetch: async () => assert.fail('unexpected fetch'), signal: controller.signal },
      failOnDeferredWork,
      {
        retryIssueReceipts: async () => {
          await deliveryReceiptTestHooks.persistPendingReceiptSubmission(native.context, path, pending);
          await deliveryReceiptTestHooks.settlePendingReceiptSubmission(
            native.context,
            path,
            pending,
            'confirmed',
          );
          controller.abort(reason);
          throw reason;
        },
      },
    ),
    (error) => error === reason,
  );

  const stored = await deliveryReceiptRuntime.readDocument(
    { ...native.context, signal: new AbortController().signal },
    path,
  );
  const recovery = stored?.fields.receiptRecovery as Record<string, unknown>;
  assert.equal(recovery.leaseExpiresAt, undefined);
  assert.equal(recovery.lastAttemptAt, 1);
  assert.equal(recovery.attemptCount, 2);
  assert.deepEqual(stored?.fields.receiptTxs, [SIGNATURE]);
  assert.equal(recovery.pendingSubmission, undefined);
});

test('native assignment initializes a missing dude pool', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const assign = deliveryReceiptRuntime.assignDudesForBox;
  const context = {
    commerceDb: harness.db,
    repository,
    nowMs: 1_700_000_000_000,
    providerFetch: fetch,
    signal: new AbortController().signal,
  } as Parameters<typeof assign>[0];
  const runtime = {
    config: { dropFamily: 'poncho_drifella' },
    dropId: 'drop',
    itemsPerBox: 1,
    maxDudeId: 2,
  } as Parameters<typeof assign>[1];

  assert.deepEqual(await assign(context, runtime, 'box', () => 0), [1]);
  assert.deepEqual((await repository.get(commerceKeys.dudePool('drop')))?.data.available, [2]);
  assert.deepEqual((await repository.get(commerceKeys.boxAssignment('drop', 'box')))?.data.dudeIds, [1]);
});

test('native assignment preserves exact cancellation reasons', async () => {
  const assign = deliveryReceiptRuntime.assignDudesForBox;
  const controller = new AbortController();
  const reason = new Error('assignment cancelled');
  controller.abort(reason);
  const context = {
    commerceDb: {} as D1Database,
    nowMs: 1_700_000_000_000,
    providerFetch: fetch,
    signal: controller.signal,
  } as Parameters<typeof assign>[0];
  const runtime = {
    config: { dropFamily: 'poncho_drifella' },
    dropId: 'drop',
    itemsPerBox: 1,
    maxDudeId: 2,
  } as Parameters<typeof assign>[1];

  await assert.rejects(
    assign(context, runtime, 'box', () => 0),
    (error) => error === reason,
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
