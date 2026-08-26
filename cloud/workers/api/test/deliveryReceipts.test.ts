import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, firestoreProviderCommerceRequester } from './commerceD1Harness.ts';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  BOX_MINTER_CONFIG_ACCOUNT_SIZE_DROP_SEED,
  BOX_MINTER_CONFIG_DISCRIMINATOR,
  decodeBoxMinterConfigData,
} from '../../../../shared/boxMinterConfigCodec.ts';
import { buildDeliveryPackStatusProjectionReconciliationQuery } from '../../../../shared/deliveryPackStatusProjectionReconciliation.ts';
import { IRL_CLAIM_CODE_NAMESPACE, IRL_CLAIM_CODE_DIGITS } from '../src/claimCodes.ts';
import { MPL_CORE_PROGRAM_ADDRESS } from '../../../../shared/solanaProgramAddresses.ts';
import {
  DELIVERY_RECEIPTS_ISSUE_PATH,
  DELIVERY_RECEIPTS_RECOVER_PATH,
  deliveryReceiptRuntime,
  deliveryReceiptTestHooks,
  handleDeliveryReceiptRequest,
  reconcilePendingDeliveryPackStatusProjections,
  reconcilePendingReadyToShipNotifications,
  scheduleDeliveryPackStatusProjection,
} from '../src/deliveryReceipts.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import {
  compareAndSetReadyNotificationCursor,
  loadReadyNotificationControl,
} from '../src/d1ReadyNotificationControl.ts';
import {
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
  READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD,
} from '../src/readyToShipNotifications.ts';

const OWNER = Keypair.generate().publicKey.toBase58();
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(7));
const BUYER_NOTIFICATION_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const SHIPPER_NOTIFICATION_JOB_ID = '123e4567-e89b-42d3-a456-426614174001';
const FIRESTORE_DOCUMENT_NAME_PREFIX = 'projects/mons-shop/databases/(default)/documents/';
const READY_NOTIFICATION_NOW_MS = 1_700_000_000_000;
const READY_NOTIFICATION_RETRY_UNTIL_MS = 8_000_000_000_000;
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

function decodedFirestoreTestValue(value: Record<string, any>): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  return undefined;
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

function projectionHarness(args: {
  d1?: ReturnType<typeof projectionDataDb>;
  failCompletionWrites?: number;
  fields?: Record<string, unknown>;
} = {}) {
  const nowMs = 1_700_000_000_000;
  const d1 = args.d1 || projectionDataDb();
  const commits: Array<Record<string, any>> = [];
  let failCompletionWrites = args.failCompletionWrites || 0;
  const fields: Record<string, unknown> = {
    dropId: 'card_nft_2',
    deliveryId: 7,
    status: 'ready_to_ship',
    packStatusProjectionState: 'pending',
    packStatusProjectionNextAttemptAtMs: nowMs,
    packStatusProjectionFailureCount: 0,
    items: [{ kind: 'box', refId: 1 }],
    ...args.fields,
  };
  const providerFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/documents:beginTransaction')) return Response.json({ transaction: 'transaction' });
    if (url.endsWith('/documents:rollback')) return Response.json({});
    if (url.includes('/deliveryOrders/7') && init?.method === 'GET') {
      return Response.json({
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
        updateTime: '2026-08-22T00:00:00.000Z',
        fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [
          key,
          deliveryReceiptRuntime.firestoreValue(value),
        ])),
      });
    }
    if (url.endsWith('/documents:commit')) {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      commits.push(body);
      const completedWrite = body.writes.some((write: Record<string, any>) => (
        write.update?.fields?.packStatusProjectionState?.stringValue === 'completed'
      ));
      if (completedWrite && failCompletionWrites > 0) {
        failCompletionWrites -= 1;
        return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
      }
      for (const write of body.writes) {
        if (!String(write.update?.name || '').includes('/deliveryOrders/7')) continue;
        for (const fieldPath of write.updateMask?.fieldPaths || []) {
          const encoded = write.update.fields?.[fieldPath];
          if (encoded === undefined) delete fields[fieldPath];
          else fields[fieldPath] = decodedFirestoreTestValue(encoded);
        }
        for (const transform of write.updateTransforms || []) {
          fields[transform.fieldPath] = new Date(nowMs).toISOString();
        }
      }
      return Response.json({ writeResults: [{}] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return {
    commits,
    context: {
      requestCommerceDocument: firestoreProviderCommerceRequester,
      commerceDb: createCommerceD1(),
      nowMs,
      providerFetch,
      signal: new AbortController().signal,
      dataDb: d1.db,
    },
    d1,
    fields,
    allowCompletionWrites() { failCompletionWrites = 0; },
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
        firebase_uid: 'firebase-uid',
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

function readyNotificationHarness(args: {
  documents?: Array<{ deliveryId: number; fields?: Record<string, unknown>; includeShipper?: boolean }>;
  failQueuedWrites?: number;
  failCursorWrites?: number;
  pauseAfterClaim?: boolean;
  paused?: boolean;
} = {}) {
  let failQueuedWrites = args.failQueuedWrites || 0;
  let revision = 0;
  const commits: Array<Record<string, any>> = [];
  const events: string[] = [];
  const queries: Array<Record<string, any>> = [];
  const control = readyNotificationControlHarness({
    failCursorWrites: args.failCursorWrites,
    onCursor: () => events.push('cursor'),
    paused: args.paused,
  });
  const documents = new Map<string, { fields: Record<string, unknown>; updateTime: string }>();
  for (const entry of args.documents || [{ deliveryId: 7 }]) {
    const path = `drops/card_nft_2/deliveryOrders/${entry.deliveryId}`;
    const fields = {
      ...readyNotificationOrderFields(entry.deliveryId, entry.includeShipper),
      ...entry.fields,
    };
    for (const [fieldPath, value] of Object.entries(fields)) {
      if (value === undefined) delete fields[fieldPath];
    }
    documents.set(path, {
      fields,
      updateTime: `2026-08-22T00:00:${String(entry.deliveryId).padStart(2, '0')}.000Z`,
    });
  }
  const encodedDocument = (path: string) => {
    const document = documents.get(path);
    if (!document) return null;
    return {
      name: `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`,
      updateTime: document.updateTime,
      fields: Object.fromEntries(Object.entries(document.fields).map(([key, value]) => [
        key,
        deliveryReceiptRuntime.firestoreValue(value),
      ])),
    };
  };
  const decodedDocument = (deliveryId: number): ReadyNotificationPublishArgs['document'] => {
    const path = `drops/card_nft_2/deliveryOrders/${deliveryId}`;
    const document = documents.get(path);
    assert.ok(document);
    return { id: String(deliveryId), path, fields: { ...document.fields }, updateTime: document.updateTime };
  };
  const applyDeliveryWrite = (write: Record<string, any>, path: string): Response => {
    const document = documents.get(path);
    if (!document) return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    if (write.currentDocument?.updateTime && write.currentDocument.updateTime !== document.updateTime) {
      return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 409 });
    }
    const queuedWrite = [
      write.update?.fields?.buyerOrderReceivedEmailState?.stringValue,
      write.update?.fields?.shipperReadyToShipEmailState?.stringValue,
    ].includes('queued');
    if (queuedWrite && failQueuedWrites > 0) {
      failQueuedWrites -= 1;
      return Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 });
    }
    for (const fieldPath of write.updateMask?.fieldPaths || []) {
      const encoded = write.update?.fields?.[fieldPath];
      if (encoded === undefined) delete document.fields[fieldPath];
      else document.fields[fieldPath] = decodedFirestoreTestValue(encoded);
    }
    for (const transform of write.updateTransforms || []) {
      document.fields[transform.fieldPath] = new Date(READY_NOTIFICATION_NOW_MS).toISOString();
    }
    revision += 1;
    document.updateTime = `2026-08-22T02:00:${String(revision).padStart(2, '0')}.000Z`;
    if (write.update?.fields?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]) {
      events.push('claim');
      if (args.pauseAfterClaim) control.setPaused(true);
    } else if (queuedWrite) events.push('queued-marker');
    else if ([
      write.update?.fields?.buyerOrderReceivedEmailState?.stringValue,
      write.update?.fields?.shipperReadyToShipEmailState?.stringValue,
    ].includes('failed')) events.push('failed-marker');
    else events.push('delivery-write');
    return Response.json({ writeResults: [{}] });
  };
  const providerFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith(':runQuery')) {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      queries.push(body);
      const cursor = body.structuredQuery.startAt?.values?.[0]?.referenceValue as string | undefined;
      const cursorDocumentPath = cursor?.slice(FIRESTORE_DOCUMENT_NAME_PREFIX.length);
      const limit = Number(body.structuredQuery.limit || 8);
      return Response.json([...documents.entries()]
        .filter(([, document]) => (
          document.fields.status === 'ready_to_ship' &&
          (
            document.fields.buyerOrderReceivedEmailState === 'pending' ||
            document.fields.shipperReadyToShipEmailState === 'pending'
          )
        ))
        .sort(([left], [right]) => left.localeCompare(right))
        .filter(([path]) => !cursorDocumentPath || path > cursorDocumentPath)
        .slice(0, limit)
        .map(([path]) => ({ document: encodedDocument(path) })));
    }
    const documentMatch = url.match(/\/documents\/(drops\/card_nft_2\/deliveryOrders\/\d+)$/);
    if (documentMatch && init?.method === 'GET') {
      const document = encodedDocument(documentMatch[1]);
      return document
        ? Response.json(document)
        : Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    }
    if (url.endsWith('/documents:commit')) {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      commits.push(body);
      const write = body.writes[0];
      const path = String(write.update?.name || '').slice(FIRESTORE_DOCUMENT_NAME_PREFIX.length);
      return applyDeliveryWrite(write, path);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    commits,
    controlReads: control.reads,
    decodedDocument,
    events,
    fields(deliveryId = 7) {
      return documents.get(`drops/card_nft_2/deliveryOrders/${deliveryId}`)?.fields;
    },
    providerFetch,
    opsDb: control.db,
    queries,
    setPaused(value: boolean) {
      control.setPaused(value);
    },
    get controlRevision() { return control.revision; },
    get cursorPath() { return control.cursorPath; },
  };
}

function readyNotificationContext(
  harness: ReturnType<typeof readyNotificationHarness>,
  nowMs = READY_NOTIFICATION_NOW_MS,
): ReadyNotificationPublishArgs['context'] {
  return {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    commerceDb: createCommerceD1(),
    nowMs,
    providerFetch: harness.providerFetch,
    signal: new AbortController().signal,
  };
}

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
    requestCommerceDocument: firestoreProviderCommerceRequester,
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }),
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

test('ready-to-ship persistence atomically includes notification and pack-status outboxes', async () => {
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  const commits: Array<{ writes: Array<Record<string, any>> }> = [];
  const context = {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    commerceDb: createCommerceD1(),
    nowMs: Date.now(),
    providerFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      assert.equal(url.endsWith('/documents:commit'), true);
      commits.push(JSON.parse(String(init?.body)));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-22T00:00:01.000Z' });
    },
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
  assert.equal(write.update.fields.packStatusProjectionState.stringValue, 'pending');
  assert.equal(Number(write.update.fields.packStatusProjectionNextAttemptAtMs.integerValue), context.nowMs);
  assert.equal(Number(write.update.fields.packStatusProjectionFailureCount.integerValue), 0);
  assert.ok(write.updateMask.fieldPaths.includes('buyerOrderReceivedEmailQueuedAt'));
  assert.ok(write.updateMask.fieldPaths.includes('shipperReadyToShipEmailQueuedAt'));
  assert.ok(write.updateMask.fieldPaths.includes('packStatusProjectionCompletedAt'));
  assert.ok(write.updateMask.fieldPaths.includes('packStatusProjectionFailedAt'));
  assert.ok(write.updateMask.fieldPaths.includes('packStatusProjectionLastErrorCode'));
  assert.equal(ready.fields.status, 'ready_to_ship');
  assert.equal(ready.fields.buyerOrderReceivedEmailState, 'pending');
  assert.equal(ready.fields.shipperReadyToShipEmailState, 'pending');
  assert.equal(ready.fields.packStatusProjectionState, 'pending');
  assert.equal(ready.fields.packStatusProjectionNextAttemptAtMs, context.nowMs);
  assert.equal(ready.fields.packStatusProjectionFailureCount, 0);
});

test('notification queue failure maps both delivery routes to retryable 503 after completion', async () => {
  const harness = readyNotificationHarness();
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
    env({ NOTIFICATION_EMAIL_QUEUE: queue, OPS_DB: harness.opsDb }),
    DELIVERY_RECEIPTS_ISSUE_PATH,
    () => undefined,
    dependencies({
      requestCommerceDocument: firestoreProviderCommerceRequester,
      providerFetch: harness.providerFetch,
      issue: async (
        _body: unknown,
        _identity: unknown,
        workerEnv: Env,
        firestore: ReadyNotificationPublishArgs['context'],
      ) => {
        await deliveryReceiptTestHooks.publishReadyToShipNotifications({
          context: firestore,
          deliveryId: 7,
          document: harness.decodedDocument(7),
          dropId: 'card_nft_2',
          opsDb: workerEnv.OPS_DB,
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
  assert.equal(typeof harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], 'string');
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

test('paused notification control fails the direct HTTP publisher closed', async () => {
  const harness = readyNotificationHarness({ paused: true });
  let queueSends = 0;
  const result = await handleDeliveryReceiptRequest(
    request(DELIVERY_RECEIPTS_ISSUE_PATH, {
      owner: OWNER,
      deliveryId: 7,
      signature: SIGNATURE,
      dropId: 'card_nft_2',
    }),
    env({
      NOTIFICATION_EMAIL_QUEUE: notificationQueue({
        sendBatch: async () => {
          queueSends += 1;
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      }),
      OPS_DB: harness.opsDb,
    }),
    DELIVERY_RECEIPTS_ISSUE_PATH,
    () => undefined,
    dependencies({
      requestCommerceDocument: firestoreProviderCommerceRequester,
      providerFetch: harness.providerFetch,
      issue: async (
        _body: unknown,
        _identity: unknown,
        workerEnv: Env,
        firestore: ReadyNotificationPublishArgs['context'],
      ) => {
        await deliveryReceiptTestHooks.publishReadyToShipNotifications({
          context: firestore,
          deliveryId: 7,
          document: harness.decodedDocument(7),
          dropId: 'card_nft_2',
          opsDb: workerEnv.OPS_DB,
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
      message: 'Delivery completed, but notification publication is paused or unavailable. Retry later.',
    },
  });
  assert.equal(queueSends, 0);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD], 0);
});

test('queued and markerless ready retries succeed during a pause without reading control', async () => {
  let providerCalls = 0;
  const control = readyNotificationControlHarness({ paused: true });
  const context: ReadyNotificationPublishArgs['context'] = {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    commerceDb: createCommerceD1(),
    nowMs: READY_NOTIFICATION_NOW_MS,
    providerFetch: async () => {
      providerCalls += 1;
      throw new Error('control must not be read');
    },
    signal: new AbortController().signal,
  };
  for (const fields of [
    {
      ...readyNotificationOrderFields(7),
      buyerOrderReceivedEmailState: 'queued',
    },
    {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'ready_to_ship',
    },
  ]) {
    assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
      context,
      deliveryId: 7,
      document: {
        id: '7',
        path: 'drops/card_nft_2/deliveryOrders/7',
        updateTime: '2026-08-22T00:00:00.000Z',
        fields,
      },
      dropId: 'card_nft_2',
      opsDb: control.db,
      queue: notificationQueue(),
    }), false);
  }
  assert.equal(providerCalls, 0);
  assert.deepEqual(control.reads, []);
});

test('a stale pending snapshot does not consult paused control after another publisher settles it', async () => {
  const harness = readyNotificationHarness();
  const staleDocument = harness.decodedDocument(7);
  let queueSends = 0;
  const queue = notificationQueue({
    sendBatch: async () => {
      queueSends += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  });
  assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: readyNotificationContext(harness),
    deliveryId: 7,
    document: staleDocument,
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue,
  }), true);
  harness.setPaused(true);
  assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: readyNotificationContext(harness),
    deliveryId: 7,
    document: staleDocument,
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue,
  }), false);
  assert.equal(queueSends, 1);
  assert.deepEqual(harness.controlReads, [false]);
});

test('successful queue publication retains its active claim when marker finalization fails', async () => {
  let queueSends = 0;
  const harness = readyNotificationHarness({ failQueuedWrites: 1 });
  const context: ReadyNotificationPublishArgs['context'] = {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    commerceDb: createCommerceD1(),
    nowMs: READY_NOTIFICATION_NOW_MS,
    providerFetch: harness.providerFetch,
    signal: new AbortController().signal,
  };
  await assert.rejects(deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context,
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue: notificationQueue({
      sendBatch: async () => {
        queueSends += 1;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
  }), (error: unknown) => (
    error instanceof deliveryReceiptTestHooks.ReadyToShipNotificationEnqueueError &&
    /recovery state could not be saved/i.test(error.message)
  ));
  assert.equal(queueSends, 1);
  assert.equal(typeof harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], 'string');
  assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context,
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue: notificationQueue({
      sendBatch: async () => {
        queueSends += 1;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
  }), false);
  assert.equal(queueSends, 1);
});

test('one CAS winner publishes across concurrent direct and scheduled recovery', async () => {
  const harness = readyNotificationHarness();
  let queueSends = 0;
  const queue = notificationQueue({
    sendBatch: async () => {
      queueSends += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  });
  await Promise.all([
    deliveryReceiptTestHooks.publishReadyToShipNotifications({
      context: readyNotificationContext(harness),
      deliveryId: 7,
      document: harness.decodedDocument(7),
      dropId: 'card_nft_2',
      opsDb: harness.opsDb,
      queue,
    }),
    reconcilePendingReadyToShipNotifications({
      COMMERCE_DB: createCommerceD1(),
      NOTIFICATION_EMAIL_QUEUE: queue,
      OPS_DB: harness.opsDb,
    }, new AbortController().signal, {
      requestCommerceDocument: firestoreProviderCommerceRequester,
      nowMs: () => READY_NOTIFICATION_NOW_MS,
      providerFetch: harness.providerFetch,
    }),
  ]);
  assert.equal(queueSends, 1);
  assert.equal(harness.fields()?.buyerOrderReceivedEmailState, 'queued');
  assert.equal(harness.events.filter((event) => event === 'claim').length, 1);
});

test('an expired claim republishes the same stable Queue job identity', async () => {
  const harness = readyNotificationHarness({ documents: [{ deliveryId: 7, fields: {
    [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: 'old-claim',
    [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]: READY_NOTIFICATION_NOW_MS - 1,
    [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: 1,
  } }] });
  const jobs: Array<Record<string, unknown>> = [];
  assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: readyNotificationContext(harness),
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue: notificationQueue({
      sendBatch: async (messages) => {
        jobs.push(...Array.from(messages, (message) => message.body as Record<string, unknown>));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
  }), true);
  assert.deepEqual(jobs.map((job) => ({
    idempotencyKey: job.idempotencyKey,
    jobId: job.jobId,
  })), [{
    idempotencyKey: 'card_nft_2:7:order_received',
    jobId: '00000000-0000-4000-8000-000000000007',
  }]);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD], 2);
});

test('attempt and retry-window exhaustion require manual review without Queue publication', async () => {
  for (const fields of [
    { [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: 4 },
    {
      [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: 1,
      [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: READY_NOTIFICATION_NOW_MS,
    },
  ]) {
    const harness = readyNotificationHarness({ documents: [{ deliveryId: 7, fields }] });
    let queueSends = 0;
    assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
      context: readyNotificationContext(harness),
      deliveryId: 7,
      document: harness.decodedDocument(7),
      dropId: 'card_nft_2',
      opsDb: harness.opsDb,
      queue: notificationQueue({ sendBatch: async () => {
        queueSends += 1;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      } }),
    }), false);
    assert.equal(queueSends, 0);
    assert.equal(harness.fields()?.buyerOrderReceivedEmailState, 'failed');
    assert.equal(harness.fields()?.readyToShipNotificationLastErrorCode, 'manual-review-required');
  }
});

test('an expired never-attempted notification gets one fresh publication window', async () => {
  const harness = readyNotificationHarness({ documents: [{ deliveryId: 7, fields: {
    [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: READY_NOTIFICATION_NOW_MS,
  } }] });
  let queueSends = 0;
  assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: readyNotificationContext(harness),
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue: notificationQueue({ sendBatch: async () => {
      queueSends += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    } }),
  }), true);
  assert.equal(queueSends, 1);
  assert.equal(
    harness.fields()?.[READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD],
    READY_NOTIFICATION_NOW_MS + READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
  );
});

test('a pause observed after claiming releases the claim before Queue publication', async () => {
  const harness = readyNotificationHarness({ pauseAfterClaim: true });
  let queueSends = 0;
  await assert.rejects(deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: readyNotificationContext(harness),
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue: notificationQueue({ sendBatch: async () => {
      queueSends += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    } }),
  }), /paused or unavailable/i);
  assert.equal(queueSends, 0);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD], 0);
});

test('an unavailable D1 control releases the claim and fails publication closed', async () => {
  const harness = readyNotificationHarness();
  const unavailable = new ReadyNotificationTestDatabase(
    () => { throw new Error('D1 unavailable'); },
    [],
  );
  let queueSends = 0;
  await assert.rejects(deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: readyNotificationContext(harness),
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb: unavailable,
    queue: notificationQueue({ sendBatch: async () => {
      queueSends += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    } }),
  }), /paused or unavailable/i);
  assert.equal(queueSends, 0);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD], 0);
});

test('an abort during the D1 control read releases the claim before Queue publication', async () => {
  const harness = readyNotificationHarness();
  const controller = new AbortController();
  let releaseRead: (() => void) | undefined;
  let markReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const controlRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const opsDb = new ReadyNotificationTestDatabase(
    async (statement) => {
      markReadStarted?.();
      await controlRead;
      if (statement.query.includes('INSERT INTO worker_controls')) {
        return readyNotificationD1Result();
      }
      if (statement.query.includes('SELECT control_key, paused, cursor_path, revision')) {
        return readyNotificationD1Result([{
          control_key: 'ready_notifications',
          cursor_path: null,
          paused: 0,
          revision: 1,
        }]);
      }
      throw new Error(`Unexpected D1 query: ${statement.query}`);
    },
    [],
  );
  let queueSends = 0;
  const publication = deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: {
      ...readyNotificationContext(harness),
      signal: controller.signal,
    },
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb,
    queue: notificationQueue({
      sendBatch: async () => {
        queueSends += 1;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
  });
  await readStarted;
  controller.abort(new DOMException('timed out', 'TimeoutError'));
  releaseRead?.();
  await assert.rejects(publication, (error: unknown) => (
    error instanceof DOMException && error.name === 'TimeoutError'
  ));
  assert.equal(queueSends, 0);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD], 0);
});

test('content construction failures remain pending under the active claim', async () => {
  const harness = readyNotificationHarness({ documents: [{
    deliveryId: 7,
    fields: { addressSnapshot: {} },
  }] });
  await assert.rejects(deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: readyNotificationContext(harness),
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue: notificationQueue(),
  }), /could not be prepared/i);
  assert.equal(harness.fields()?.buyerOrderReceivedEmailState, 'pending');
  assert.equal(typeof harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], 'string');
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD], 1);
});

test('paused unbuildable notifications release their claim without consuming an attempt', async () => {
  const harness = readyNotificationHarness({
    documents: [{ deliveryId: 7, fields: { addressSnapshot: {} } }],
    paused: true,
  });
  let queueSends = 0;
  await assert.rejects(deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: readyNotificationContext(harness),
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue: notificationQueue({ sendBatch: async () => {
      queueSends += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    } }),
  }), /paused or unavailable/i);
  assert.equal(queueSends, 0);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD], undefined);
  assert.equal(harness.fields()?.[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD], 0);
});

test('legacy pending markers without retry metadata never publish automatically', async () => {
  const harness = readyNotificationHarness({ documents: [{ deliveryId: 7, fields: {
    [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: undefined,
    [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: undefined,
  } }] });
  let queueSends = 0;
  assert.equal(await deliveryReceiptTestHooks.publishReadyToShipNotifications({
    context: readyNotificationContext(harness),
    deliveryId: 7,
    document: harness.decodedDocument(7),
    dropId: 'card_nft_2',
    opsDb: harness.opsDb,
    queue: notificationQueue({ sendBatch: async () => {
      queueSends += 1;
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    } }),
  }), false);
  assert.equal(queueSends, 0);
  assert.equal(harness.fields()?.buyerOrderReceivedEmailState, 'failed');
  assert.equal(harness.fields()?.readyToShipNotificationLastErrorCode, 'manual-review-required');
});

test('notification reconciliation creates its missing D1 control atomically before scanning', async () => {
  const control = readyNotificationControlHarness({ exists: false });
  let queryCalls = 0;
  const processed = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: createCommerceD1(),
    NOTIFICATION_EMAIL_QUEUE: notificationQueue(),
    OPS_DB: control.db,
  }, new AbortController().signal, {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    nowMs: () => 1_700_000_000_000,
    providerFetch: async (input) => {
      const url = String(input);
      if (url.endsWith(':runQuery')) {
        queryCalls += 1;
        return Response.json([]);
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  assert.equal(processed, 0);
  assert.equal(control.exists, true);
  assert.equal(control.insertAttempts, 1);
  assert.deepEqual(control.batchSizes, [2]);
  assert.deepEqual(control.reads, [false]);
  assert.equal(queryCalls, 1);
});

test('paused notification control stops cron publication without scanning', async () => {
  const control = readyNotificationControlHarness({ paused: true });
  let queueSends = 0;
  const logs: Record<string, unknown>[] = [];
  const processed = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: createCommerceD1(),
    NOTIFICATION_EMAIL_QUEUE: notificationQueue({
      sendBatch: async () => {
        queueSends += 1;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
    OPS_DB: control.db,
  }, new AbortController().signal, {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    log: (entry) => logs.push(entry),
    nowMs: () => 1_700_000_000_000,
    providerFetch: async () => { throw new Error('Firestore must not be scanned'); },
  });
  assert.equal(processed, 0);
  assert.deepEqual(control.reads, [true]);
  assert.equal(queueSends, 0);
  assert.deepEqual(logs, [{ event: 'ready_to_ship_notifications_reconciliation_paused' }]);
});

test('scheduled ready-notification reconciliation queues before finalization and persists its cursor', async () => {
  const harness = readyNotificationHarness({ documents: [{ deliveryId: 7, includeShipper: true }] });
  const queued: Array<Record<string, unknown>> = [];
  const processed = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: createCommerceD1(),
    NOTIFICATION_EMAIL_QUEUE: notificationQueue({
      sendBatch: async (messages) => {
        queued.push(...Array.from(messages, (message) => message.body as Record<string, unknown>));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
    OPS_DB: harness.opsDb,
  }, new AbortController().signal, {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    nowMs: () => READY_NOTIFICATION_NOW_MS,
    providerFetch: harness.providerFetch,
  });
  assert.equal(processed, 1);
  assert.deepEqual(queued.map((job) => ({ jobId: job.jobId, kind: job.kind })), [
    { jobId: '00000000-0000-4000-8000-000000000007', kind: 'buyer_order_received' },
    { jobId: '00000000-0000-4000-9000-000000000007', kind: 'shipper_ready_to_ship' },
  ]);
  assert.deepEqual(harness.events, ['claim', 'queued-marker', 'cursor']);
  assert.equal(harness.commits.length, 2);
  const claimWrite = harness.commits[0].writes[0];
  assert.equal(typeof claimWrite.update.fields.readyToShipNotificationPublishClaimId.stringValue, 'string');
  assert.equal(claimWrite.update.fields.readyToShipNotificationPublishAttemptCount.integerValue, '1');
  const markerWrite = harness.commits[1].writes[0];
  assert.equal(markerWrite.update.fields.buyerOrderReceivedEmailState.stringValue, 'queued');
  assert.equal(markerWrite.update.fields.shipperReadyToShipEmailState.stringValue, 'queued');
  assert.equal(markerWrite.update.fields.readyToShipNotificationPublishClaimId, undefined);
  assert.ok(markerWrite.updateMask.fieldPaths.includes('readyToShipNotificationPublishClaimId'));
  assert.equal(harness.cursorPath, 'drops/card_nft_2/deliveryOrders/7');
  assert.equal(harness.controlRevision, 2);
});

test('persisted notification cursor advances past four failures and reaches later work next run', async () => {
  const harness = readyNotificationHarness({
    documents: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((deliveryId) => ({ deliveryId })),
  });
  const attempts: number[] = [];
  const workerEnv = {
    COMMERCE_DB: createCommerceD1(),
    NOTIFICATION_EMAIL_QUEUE: notificationQueue({
      sendBatch: async (messages) => {
        const job = Array.from(messages)[0].body as { context: { deliveryId: number } };
        attempts.push(job.context.deliveryId);
        if (job.context.deliveryId <= 4) throw new Error('persistent queue failure');
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
    OPS_DB: harness.opsDb,
  };
  const overrides = {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    nowMs: () => READY_NOTIFICATION_NOW_MS,
    providerFetch: harness.providerFetch,
  };
  await assert.rejects(
    reconcilePendingReadyToShipNotifications(workerEnv, new AbortController().signal, overrides),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 4,
  );
  assert.equal(harness.cursorPath, 'drops/card_nft_2/deliveryOrders/4');
  assert.equal(
    await reconcilePendingReadyToShipNotifications(workerEnv, new AbortController().signal, overrides),
    4,
  );
  assert.deepEqual(attempts, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([5, 6, 7, 8].map((deliveryId) => (
    harness.fields(deliveryId)?.buyerOrderReceivedEmailState
  )), ['queued', 'queued', 'queued', 'queued']);
  assert.equal(harness.cursorPath, 'drops/card_nft_2/deliveryOrders/8');
  const cursorQuery = harness.queries.find((query) => query.structuredQuery.startAt);
  assert.deepEqual(cursorQuery?.structuredQuery.startAt, {
    before: false,
    values: [{
      referenceValue: `${FIRESTORE_DOCUMENT_NAME_PREFIX}drops/card_nft_2/deliveryOrders/4`,
    }],
  });
  assert.equal(harness.queries.at(-1)?.structuredQuery.limit, 3);
});

test('notification cursor compare-and-set preserves progress from a concurrent cron', async () => {
  const harness = readyNotificationHarness({ failCursorWrites: 1 });
  const processed = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: createCommerceD1(),
    NOTIFICATION_EMAIL_QUEUE: notificationQueue(),
    OPS_DB: harness.opsDb,
  }, new AbortController().signal, {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    nowMs: () => READY_NOTIFICATION_NOW_MS,
    providerFetch: harness.providerFetch,
  });
  assert.equal(processed, 1);
  assert.equal(harness.cursorPath, null);
  assert.equal(harness.fields()?.buyerOrderReceivedEmailState, 'queued');
});

test('scheduled ready-notification reconciliation terminalizes poison rows before publishing', async () => {
  const harness = readyNotificationHarness({
    documents: [1, 2, 3, 4, 5].map((deliveryId) => ({
      deliveryId,
      fields: deliveryId <= 4 ? { deliveryId: 999 } : {},
    })),
  });
  const published: number[] = [];
  const processed = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: createCommerceD1(),
    NOTIFICATION_EMAIL_QUEUE: notificationQueue({
      sendBatch: async (messages) => {
        const job = Array.from(messages)[0].body as { context: { deliveryId: number } };
        published.push(job.context.deliveryId);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
    OPS_DB: harness.opsDb,
  }, new AbortController().signal, {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    nowMs: () => READY_NOTIFICATION_NOW_MS,
    providerFetch: harness.providerFetch,
  });
  assert.equal(processed, 1);
  assert.deepEqual([1, 2, 3, 4].map((deliveryId) => (
    harness.fields(deliveryId)?.buyerOrderReceivedEmailState
  )), ['failed', 'failed', 'failed', 'failed']);
  assert.deepEqual(published, [5]);
  assert.equal(harness.fields(5)?.buyerOrderReceivedEmailState, 'queued');
});

test('scheduled reconciliation fails a wrong valid key and publishes its valid sibling', async () => {
  const harness = readyNotificationHarness({ documents: [{
    deliveryId: 7,
    includeShipper: true,
    fields: { buyerOrderReceivedEmailIdempotencyKey: 'card_nft_2:6:order_received' },
  }] });
  const published: string[] = [];
  const processed = await reconcilePendingReadyToShipNotifications({
    COMMERCE_DB: createCommerceD1(),
    NOTIFICATION_EMAIL_QUEUE: notificationQueue({
      sendBatch: async (messages) => {
        published.push(...Array.from(messages, (message) => String((message.body as { kind: string }).kind)));
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    }),
    OPS_DB: harness.opsDb,
  }, new AbortController().signal, {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    nowMs: () => READY_NOTIFICATION_NOW_MS,
    providerFetch: harness.providerFetch,
  });
  assert.equal(processed, 1);
  assert.deepEqual(published, ['shipper_ready_to_ship']);
  assert.equal(harness.fields()?.buyerOrderReceivedEmailState, 'failed');
  assert.equal(harness.fields()?.shipperReadyToShipEmailState, 'queued');
  assert.deepEqual(harness.events, ['failed-marker', 'claim', 'queued-marker', 'cursor']);
});

test('ready-to-ship issue requests use the production Firestore and bounded Solana adapters idempotently', async () => {
  const signer = Keypair.generate();
  const runtime = deliveryReceiptTestHooks.runtimeForDrop('card_nft_2');
  const configuration = configData(signer, runtime.dropId);
  const commits: Array<Record<string, unknown>> = [];
  const queued: Array<Record<string, unknown>> = [];
  const projectionDb = projectionDataDb();
  const deferred: Promise<unknown>[] = [];
  let projectionState = 'pending';
  let rpcCalls = 0;
  let deliveryRevision = 0;
  const notificationFields: Record<string, unknown> = {
    buyerOrderReceivedEmailState: 'pending',
    buyerOrderReceivedEmailJobId: BUYER_NOTIFICATION_JOB_ID,
    buyerOrderReceivedEmailIdempotencyKey: 'card_nft_2:7:order_received',
    shipperReadyToShipEmailState: 'pending',
    shipperReadyToShipEmailJobId: SHIPPER_NOTIFICATION_JOB_ID,
    shipperReadyToShipEmailIdempotencyKey: 'card_nft_2:7:ready_to_ship',
    [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: READY_NOTIFICATION_RETRY_UNTIL_MS,
    [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: 0,
  };
  const providerFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/drops/card_nft_2/deliveryOrders/7')) {
      return Response.json({
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
        updateTime: `2026-08-22T00:00:${String(deliveryRevision).padStart(2, '0')}.000Z`,
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
          ...Object.fromEntries(Object.entries(notificationFields).map(([key, value]) => [
            key,
            deliveryReceiptRuntime.firestoreValue(value),
          ])),
          packStatusProjectionState: { stringValue: projectionState },
          packStatusProjectionNextAttemptAtMs: { integerValue: '0' },
          packStatusProjectionFailureCount: { integerValue: '0' },
          receiptsMinted: { integerValue: '3' },
          receiptTxs: { arrayValue: { values: [{ stringValue: SIGNATURE }] } },
        },
      });
    }
    if (url.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as Record<string, any>;
      commits.push(commit);
      for (const write of commit.writes) {
        projectionState = write.update?.fields?.packStatusProjectionState?.stringValue || projectionState;
        if (!String(write.update?.name || '').includes('/deliveryOrders/7')) continue;
        for (const fieldPath of write.updateMask?.fieldPaths || []) {
          if (!(
            fieldPath.startsWith('buyerOrderReceivedEmail') ||
            fieldPath.startsWith('shipperReadyToShipEmail') ||
            fieldPath.startsWith('readyToShipNotification')
          )) continue;
          const encoded = write.update?.fields?.[fieldPath];
          if (encoded === undefined) delete notificationFields[fieldPath];
          else notificationFields[fieldPath] = decodedFirestoreTestValue(encoded);
        }
        deliveryRevision += 1;
      }
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
      DATA_DB: projectionDb.db,
      NOTIFICATION_EMAIL_QUEUE: notificationQueue({
        sendBatch: async (messages) => {
          queued.push(...Array.from(messages, (message) => message.body as Record<string, unknown>));
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      }),
    }),
    DELIVERY_RECEIPTS_ISSUE_PATH,
    (promise) => deferred.push(promise),
    {
      requestCommerceDocument: firestoreProviderCommerceRequester,
      providerFetch,
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }),
    },
  );
  await Promise.all(deferred);
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
  assert.equal(commits.length, 3);
  assert.match(JSON.stringify(commits), /buyerOrderReceivedEmailQueuedAt/);
  assert.match(JSON.stringify(commits), /shipperReadyToShipEmailQueuedAt/);
  assert.doesNotMatch(JSON.stringify(commits), /packStatusEvents|meta\/packStatus/);
  assert.match(JSON.stringify(commits), /packStatusProjectionState.*completed/);
  assert.match(JSON.stringify(commits), /packStatusProjectionCompletedAt/);
  assert.equal(projectionState, 'completed');
  assert.equal(projectionDb.applied, 1);
});

test('direct pack-status background work completes the D1 projection', async () => {
  const harness = projectionHarness();
  const deferred: Promise<unknown>[] = [];
  scheduleDeliveryPackStatusProjection({
    context: harness.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    waitUntil: (promise) => deferred.push(promise),
  });
  await Promise.all(deferred);
  assert.equal(harness.fields.packStatusProjectionState, 'completed');
  assert.equal(harness.fields.packStatusProjectionNextAttemptAtMs, undefined);
  assert.doesNotMatch(JSON.stringify(harness.commits), /packStatusEvents|meta\/packStatus/);
  assert.equal(harness.d1.applied, 1);
});

test('transient D1 projection failures back off and replay idempotently', async () => {
  const nowMs = 1_700_000_000_000;
  const harness = projectionHarness({ d1: projectionDataDb({ failures: 1 }) });
  assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: harness.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    log: () => undefined,
    nowMs: () => nowMs,
  }), 'pending');
  assert.equal(harness.fields.packStatusProjectionState, 'pending');
  assert.equal(harness.fields.packStatusProjectionFailureCount, 1);
  assert.equal(harness.fields.packStatusProjectionNextAttemptAtMs, nowMs + 5 * 60_000);
  assert.equal(harness.fields.packStatusProjectionLastErrorCode, 'd1-write-failed');
  assert.equal(harness.d1.applied, 0);

  assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: harness.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    log: () => undefined,
    nowMs: () => nowMs + 60_000,
  }), 'not-due');
  assert.equal(harness.d1.attempts, 1);

  assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: harness.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    log: () => undefined,
    nowMs: () => nowMs + 5 * 60_000,
  }), 'completed');
  assert.equal(harness.fields.packStatusProjectionState, 'completed');
  assert.equal(harness.d1.applied, 1);
  assert.equal(harness.d1.attempts, 2);
});

test('transient pack-status backoff caps at 24 hours', async () => {
  const nowMs = 1_700_000_000_000;
  const harness = projectionHarness({ fields: {
    packStatusProjectionFailureCount: 99,
    packStatusProjectionNextAttemptAtMs: nowMs,
  } });
  assert.equal(await deliveryReceiptTestHooks.recordDeliveryPackStatusProjectionTransientFailure({
    attemptStartedAtMs: nowMs,
    context: harness.context,
    documentPath: 'drops/card_nft_2/deliveryOrders/7',
    errorCode: 'unavailable',
  }), true);
  assert.equal(harness.fields.packStatusProjectionFailureCount, 100);
  assert.equal(harness.fields.packStatusProjectionNextAttemptAtMs, nowMs + 24 * 60 * 60_000);
});

test('a missing D1 binding remains pending until the binding is restored', async () => {
  const nowMs = 1_700_000_000_000;
  const harness = projectionHarness();
  assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: { ...harness.context, dataDb: undefined },
    deliveryId: 7,
    dropId: 'card_nft_2',
    log: () => undefined,
    nowMs: () => nowMs,
  }), 'pending');
  assert.equal(harness.fields.packStatusProjectionLastErrorCode, 'data-db-unavailable');
  assert.equal(harness.d1.applied, 0);

  assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: harness.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    log: () => undefined,
    nowMs: () => Number(harness.fields.packStatusProjectionNextAttemptAtMs),
  }), 'completed');
  assert.equal(harness.d1.applied, 1);
  assert.equal(harness.fields.packStatusProjectionState, 'completed');
});

test('concurrent direct projections apply the D1 event once', async () => {
  const harness = projectionHarness();
  const project = () => deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: harness.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    log: () => undefined,
    nowMs: () => harness.context.nowMs,
  });
  await Promise.all([project(), project()]);
  assert.equal(harness.d1.applied, 1);
  assert.equal(harness.fields.packStatusProjectionState, 'completed');
});

test('completion-write crashes leave pending work that replays without double applying', async () => {
  const nowMs = 1_700_000_000_000;
  const harness = projectionHarness({ failCompletionWrites: 10 });
  assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: harness.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    log: () => undefined,
    nowMs: () => nowMs,
  }), 'pending');
  assert.equal(harness.fields.packStatusProjectionState, 'pending');
  assert.equal(harness.d1.applied, 1);

  harness.allowCompletionWrites();
  assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: harness.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    log: () => undefined,
    nowMs: () => Number(harness.fields.packStatusProjectionNextAttemptAtMs),
  }), 'completed');
  assert.equal(harness.fields.packStatusProjectionState, 'completed');
  assert.equal(harness.d1.applied, 1);
  assert.equal(harness.d1.attempts, 2);
});

test('permanently invalid pending projections become terminal failures', async () => {
  const harness = projectionHarness({ fields: { status: 'processing' } });
  assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
    context: harness.context,
    deliveryId: 7,
    dropId: 'card_nft_2',
    log: () => undefined,
    nowMs: () => harness.context.nowMs,
  }), 'failed');
  assert.equal(harness.fields.packStatusProjectionState, 'failed');
  assert.equal(harness.fields.packStatusProjectionLastErrorCode, 'invalid-order-status');
  assert.equal(harness.fields.packStatusProjectionNextAttemptAtMs, undefined);
  assert.equal(harness.d1.attempts, 0);
});

test('normal projection excludes Stripe and Admin IRL card-receipt orders', async () => {
  for (const fields of [
    { source: 'stripe_offchain' },
    { source: 'admin_irl_redeem', adminIrlRedeem: { targetKind: 'card_receipt' } },
  ]) {
    const harness = projectionHarness({ fields });
    assert.equal(await deliveryReceiptTestHooks.projectPendingDeliveryPackStatus({
      context: harness.context,
      deliveryId: 7,
      dropId: 'card_nft_2',
      log: () => undefined,
      nowMs: () => harness.context.nowMs,
    }), 'not-needed');
    assert.equal(harness.fields.packStatusProjectionState, undefined);
    assert.equal(harness.d1.attempts, 0);
  }
});

test('due pack-status reconciliation uses a bounded projection and completes directly', async () => {
  const harness = projectionHarness();
  let query: Record<string, any> | undefined;
  let queryUrl = '';
  const processed = await reconcilePendingDeliveryPackStatusProjections({
    COMMERCE_DB: createCommerceD1(),
    DATA_DB: harness.d1.db,
  }, new AbortController().signal, {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    dropIds: ['card_nft_2'],
    log: () => undefined,
    nowMs: () => harness.context.nowMs,
    providerFetch: async (input, init) => {
      const url = String(input);
      if (!url.endsWith(':runQuery')) return harness.context.providerFetch(input, init);
      queryUrl = url;
      query = JSON.parse(String(init?.body));
      return Response.json([{ document: {
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
        updateTime: '2026-08-22T00:00:00.000Z',
        fields: {
          deliveryId: { integerValue: '7' },
          packStatusProjectionState: { stringValue: 'pending' },
          packStatusProjectionNextAttemptAtMs: { integerValue: String(harness.context.nowMs) },
        },
      } }]);
    },
  });
  assert.equal(processed, 1);
  assert.equal(harness.fields.packStatusProjectionState, 'completed');
  assert.equal(queryUrl.endsWith('/documents/drops/card_nft_2:runQuery'), true);
  assert.deepEqual(query, buildDeliveryPackStatusProjectionReconciliationQuery({
    dueAtMs: harness.context.nowMs,
    limit: 4,
  }));
});

test('pack-status reconciliation query rejects invalid bounds', () => {
  assert.throws(() => buildDeliveryPackStatusProjectionReconciliationQuery({ dueAtMs: -1, limit: 1 }));
  assert.throws(() => buildDeliveryPackStatusProjectionReconciliationQuery({ dueAtMs: 0, limit: 0 }));
});

test('scheduled reconciliation terminalizes malformed due rows', async () => {
  const nowMs = 1_700_000_000_000;
  let failed = 0;
  const processed = await reconcilePendingDeliveryPackStatusProjections({
    COMMERCE_DB: createCommerceD1(),
    DATA_DB: projectionDataDb().db,
  }, new AbortController().signal, {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    dropIds: ['card_nft_2'],
    log: () => undefined,
    nowMs: () => nowMs,
    providerFetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith(':runQuery')) {
        return Response.json([{ document: {
          name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/not-a-number',
          updateTime: '2026-08-22T00:00:00.000Z',
          fields: {
            packStatusProjectionState: { stringValue: 'pending' },
            packStatusProjectionNextAttemptAtMs: { integerValue: String(nowMs) },
          },
        } }]);
      }
      if (url.includes('/deliveryOrders/not-a-number') && init?.method === 'GET') {
        return Response.json({
          name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/not-a-number',
          updateTime: '2026-08-22T00:00:00.000Z',
          fields: {
            packStatusProjectionState: { stringValue: 'pending' },
            packStatusProjectionNextAttemptAtMs: { integerValue: String(nowMs) },
          },
        });
      }
      assert.equal(url.endsWith('/documents:commit'), true);
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      assert.equal(body.writes[0].update.fields.packStatusProjectionState.stringValue, 'failed');
      assert.equal(body.writes[0].update.fields.packStatusProjectionLastErrorCode.stringValue, 'invalid-order-identity');
      failed += 1;
      return Response.json({ writeResults: [{}] });
    },
  });
  assert.equal(processed, 0);
  assert.equal(failed, 1);
});

test('scheduled projection reconciliation round-robins drops within global and concurrency bounds', async () => {
  const nowMs = 1_700_000_000_000;
  const rows = new Map<string, number[]>([
    ['card_nft_2', [1, 2, 3, 4, 5, 6, 7, 8]],
    ['little_swag_boxes', [21]],
    ['poncho_drifella', [31]],
  ]);
  const requested: string[] = [];
  let active = 0;
  let maxActive = 0;
  const processed = await reconcilePendingDeliveryPackStatusProjections({
    COMMERCE_DB: createCommerceD1(),
    DATA_DB: projectionDataDb().db,
  }, new AbortController().signal, {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    dropIds: [...rows.keys()],
    nowMs: () => nowMs,
    providerFetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith(':runQuery')) {
        const dropId = decodeURIComponent(url.match(/\/drops\/([^/:]+):runQuery$/)?.[1] || '');
        const query = JSON.parse(String(init?.body)) as Record<string, any>;
        assert.equal(query.structuredQuery.limit, 4);
        assert.deepEqual(query.structuredQuery.select.fields, [
          { fieldPath: 'packStatusProjectionState' },
          { fieldPath: 'packStatusProjectionNextAttemptAtMs' },
          { fieldPath: 'deliveryId' },
        ]);
        return Response.json((rows.get(dropId) || []).map((deliveryId) => ({ document: {
          name: `projects/mons-shop/databases/(default)/documents/drops/${dropId}/deliveryOrders/${deliveryId}`,
          updateTime: '2026-08-22T00:00:00.000Z',
          fields: {
            deliveryId: { integerValue: String(deliveryId) },
            packStatusProjectionState: { stringValue: 'pending' },
            packStatusProjectionNextAttemptAtMs: { integerValue: String(nowMs) },
          },
        } })));
      }
      const match = url.match(/\/documents\/drops\/([^/]+)\/deliveryOrders\/(\d+)$/);
      assert.ok(match);
      const key = `${decodeURIComponent(match[1])}:${Number(match[2])}`;
      requested.push(key);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    },
  });
  assert.equal(processed, 4);
  assert.equal(requested.length, 4);
  assert.equal(new Set(requested).size, 4);
  assert.equal(requested.includes('little_swag_boxes:21'), true);
  assert.equal(requested.includes('poncho_drifella:31'), true);
  assert.equal(maxActive, 2);
});

test('explicit recovery uses the production Firestore adapter and preserves not-found scheduling', async () => {
  let queryCalls = 0;
  const providerFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/drops/card_nft_2/deliveryOrders/7')) {
      return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    }
    if (url.endsWith('/documents:runQuery')) {
      queryCalls += 1;
      const payload = JSON.parse(String(init?.body)) as {
        structuredQuery: {
          select?: { fields: Array<{ fieldPath: string }> };
          where: { compositeFilter: { filters: Array<{ fieldFilter: { field: { fieldPath: string }; op: string } }> } };
        };
      };
      const serialized = JSON.stringify(payload);
      if (serialized.includes('buyerOrderReceivedEmailState')) {
        assert.equal(payload.structuredQuery.where.compositeFilter.filters[1]?.fieldFilter.op, 'EQUAL');
      } else {
        assert.deepEqual(payload.structuredQuery.select?.fields, [
          { fieldPath: 'status' },
          { fieldPath: 'createdAt' },
          { fieldPath: 'processingAt' },
          { fieldPath: 'receiptRecovery' },
        ]);
        assert.equal(payload.structuredQuery.where.compositeFilter.filters[1]?.fieldFilter.field.fieldPath, 'status');
        assert.equal(payload.structuredQuery.where.compositeFilter.filters[1]?.fieldFilter.op, 'IN');
      }
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
      requestCommerceDocument: firestoreProviderCommerceRequester,
      providerFetch,
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }),
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
      requestCommerceDocument: firestoreProviderCommerceRequester,
      providerFetch,
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: 'firebase-uid' }),
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
    requestCommerceDocument: firestoreProviderCommerceRequester,
    commerceDb: createCommerceD1(),
    nowMs: Date.now(),
    providerFetch: async () => {
      calls += 1;
      return Response.json({ error: { status: 'INVALID_ARGUMENT' } }, { status: 400 });
    },
    signal: new AbortController().signal,
  }, 'transaction'));
  assert.equal(calls, 1);
});

test('pending ready recovery queries all outbox marker states', async () => {
  let query: Record<string, any> | undefined;
  const result = await deliveryReceiptTestHooks.runPendingReadyNotificationQuery({
    requestCommerceDocument: firestoreProviderCommerceRequester,
    commerceDb: createCommerceD1(),
    nowMs: Date.now(),
    providerFetch: async (input, init) => {
      assert.equal(String(input).endsWith('/documents:runQuery'), true);
      query = JSON.parse(String(init?.body));
      return Response.json([]);
    },
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
  assert.equal(query?.structuredQuery.limit, 2);
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
  const updateTime = '2026-08-22T00:00:01.000Z';
  const commits: Array<Record<string, unknown>> = [];
  const context = {
    requestCommerceDocument: firestoreProviderCommerceRequester,
    commerceDb: createCommerceD1(),
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
