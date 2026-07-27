import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
  RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
  RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
  enforceReceiptTransferAssetRateLimit,
  enforceReceiptTransferCallerRateLimit,
  evaluateReceiptTransferRateLimit,
  receiptTransferAssetRateLimitDocumentPath,
  receiptTransferAssetRateLimitSubjectHash,
  receiptTransferCallerRateLimitDocumentPath,
  receiptTransferCallerRateLimitSubjectHash,
  type ReceiptTransferRateLimitCluster,
} from '../functions/src/receiptTransferRateLimit.ts';

const requireFromFunctions = createRequire(new URL('../functions/package.json', import.meta.url));
const { HttpsError } = requireFromFunctions('firebase-functions/v2/https') as {
  HttpsError: new (code: 'aborted', message: string) => Error;
};

type StoredDocument = Record<string, unknown>;
type AssetSubject = {
  uid: string;
  cluster: ReceiptTransferRateLimitCluster;
  ownerWallet: string;
  receiptAssetId: string;
};

const DEFAULT_UID = 'anonymous-firebase-uid';
const DEFAULT_OWNER = 'owner-wallet';
const DEFAULT_ASSET = 'receipt-1';

class MemoryFirestore {
  readonly docs = new Map<string, StoredDocument>();
  writes = 0;
  transactionError: unknown = null;
  private transactionTail: Promise<void> = Promise.resolve();

  doc(path: string) {
    return { path };
  }

  async runTransaction<T>(operation: (tx: any) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      if (this.transactionError) throw this.transactionError;
      const writes: Array<{ path: string; data: StoredDocument }> = [];
      const result = await operation({
        get: async (ref: { path: string }) => {
          const data = this.docs.get(ref.path);
          return {
            exists: Boolean(data),
            data: () => data,
          };
        },
        set: (ref: { path: string }, data: StoredDocument) => {
          writes.push({ path: ref.path, data: { ...data } });
        },
      });
      for (const write of writes) {
        this.docs.set(write.path, write.data);
        this.writes += 1;
      }
      return result;
    } finally {
      release();
    }
  }
}

function loggerSpy() {
  const calls: Array<{ message: string; args: unknown[] }> = [];
  return {
    calls,
    logger: {
      error: (message: string, ...args: unknown[]) => {
        calls.push({ message, args });
      },
    },
  };
}

function assetSubject(overrides: Partial<AssetSubject> = {}): AssetSubject {
  return {
    uid: overrides.uid ?? DEFAULT_UID,
    cluster: overrides.cluster ?? 'devnet',
    ownerWallet: overrides.ownerWallet ?? DEFAULT_OWNER,
    receiptAssetId: overrides.receiptAssetId ?? DEFAULT_ASSET,
  };
}

function callerBucket(db: MemoryFirestore, uid = DEFAULT_UID) {
  return db.docs.get(receiptTransferCallerRateLimitDocumentPath(uid));
}

function assetBucket(db: MemoryFirestore, subject: AssetSubject = assetSubject()) {
  return db.docs.get(receiptTransferAssetRateLimitDocumentPath(subject));
}

async function enforceCaller(params: {
  db: MemoryFirestore;
  nowMs: number;
  uid?: string;
  logger?: ReturnType<typeof loggerSpy>['logger'];
}) {
  return enforceReceiptTransferCallerRateLimit({
    db: params.db as any,
    logger: params.logger ?? loggerSpy().logger,
    uid: params.uid ?? DEFAULT_UID,
    nowMs: params.nowMs,
  });
}

async function enforceAsset(params: {
  db: MemoryFirestore;
  nowMs: number;
  subject?: AssetSubject;
  logger?: ReturnType<typeof loggerSpy>['logger'];
}) {
  return enforceReceiptTransferAssetRateLimit({
    db: params.db as any,
    logger: params.logger ?? loggerSpy().logger,
    ...(params.subject ?? assetSubject()),
    nowMs: params.nowMs,
  });
}

function assertRateLimited(error: unknown, retryAfterMs: number) {
  const callableError = error as { code?: unknown; details?: unknown };
  assert.equal(callableError.code, 'resource-exhausted');
  assert.deepEqual(callableError.details, { retryAfterMs });
  return true;
}

test('fixed-window evaluation uses the supplied bucket limit and resets at the boundary', () => {
  const first = evaluateReceiptTransferRateLimit(
    undefined,
    1_000,
    RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
  );
  assert.deepEqual(first, {
    allowed: true,
    count: 1,
    windowStartedAtMs: 1_000,
  });

  const lastAllowed = evaluateReceiptTransferRateLimit(
    {
      count: RECEIPT_TRANSFER_ASSET_RATE_LIMIT - 1,
      windowStartedAtMs: 1_000,
    },
    2_000,
    RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
  );
  assert.deepEqual(lastAllowed, {
    allowed: true,
    count: RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
    windowStartedAtMs: 1_000,
  });

  assert.deepEqual(
    evaluateReceiptTransferRateLimit(
      {
        count: lastAllowed.count,
        windowStartedAtMs: lastAllowed.windowStartedAtMs,
      },
      2_000,
      RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
    ),
    {
      allowed: false,
      count: RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
      retryAfterMs: RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS - 1_000,
      windowStartedAtMs: 1_000,
    },
  );

  assert.deepEqual(
    evaluateReceiptTransferRateLimit(
      {
        count: RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
        windowStartedAtMs: 1_000,
      },
      1_000 + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
      RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
    ),
    {
      allowed: true,
      count: 1,
      windowStartedAtMs: 1_000 + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
    },
  );
});

test('caller limiter permits sixty requests, denies without writing, and reuses the bucket next window', async () => {
  const db = new MemoryFirestore();
  const startedAtMs = 50_000;
  for (let index = 0; index < RECEIPT_TRANSFER_CALLER_RATE_LIMIT; index += 1) {
    await enforceCaller({ db, nowMs: startedAtMs + index });
  }

  assert.equal(callerBucket(db)?.count, RECEIPT_TRANSFER_CALLER_RATE_LIMIT);
  assert.equal(db.writes, RECEIPT_TRANSFER_CALLER_RATE_LIMIT);
  await assert.rejects(
    enforceCaller({
      db,
      nowMs: startedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS / 2,
    }),
    (error) => assertRateLimited(error, RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS / 2),
  );
  assert.equal(callerBucket(db)?.count, RECEIPT_TRANSFER_CALLER_RATE_LIMIT);
  assert.equal(db.writes, RECEIPT_TRANSFER_CALLER_RATE_LIMIT);

  await enforceCaller({
    db,
    nowMs: startedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
  });
  assert.equal(callerBucket(db)?.count, 1);
  assert.equal(
    callerBucket(db)?.windowStartedAtMs,
    startedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
  );
});

test('asset limiter permits twenty requests and atomically rejects concurrent overflow', async () => {
  const db = new MemoryFirestore();
  const startedAtMs = 10_000;
  const results = await Promise.allSettled(
    Array.from({ length: RECEIPT_TRANSFER_ASSET_RATE_LIMIT + 1 }, (_, index) =>
      enforceAsset({ db, nowMs: startedAtMs + index }),
    ),
  );

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, RECEIPT_TRANSFER_ASSET_RATE_LIMIT);
  assert.equal(rejected.length, 1);
  assertRateLimited(
    (rejected[0] as PromiseRejectedResult).reason,
    RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS - RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
  );
  assert.equal(assetBucket(db)?.count, RECEIPT_TRANSFER_ASSET_RATE_LIMIT);
  assert.equal(db.writes, RECEIPT_TRANSFER_ASSET_RATE_LIMIT);
});

test('v2 domain-separated hashes isolate caller, uid, owner, cluster, and asset boundaries', () => {
  const callerHash = receiptTransferCallerRateLimitSubjectHash(DEFAULT_UID);
  const base = assetSubject();
  const assetHash = receiptTransferAssetRateLimitSubjectHash(base);
  assert.match(callerHash, /^[a-f0-9]{64}$/);
  assert.match(assetHash, /^[a-f0-9]{64}$/);
  assert.notEqual(callerHash, assetHash);
  assert.notEqual(
    assetHash,
    receiptTransferAssetRateLimitSubjectHash({ ...base, uid: 'another-uid' }),
  );
  assert.notEqual(
    assetHash,
    receiptTransferAssetRateLimitSubjectHash({ ...base, ownerWallet: 'another-owner' }),
  );
  assert.notEqual(
    assetHash,
    receiptTransferAssetRateLimitSubjectHash({ ...base, cluster: 'mainnet-beta' }),
  );
  assert.notEqual(
    assetHash,
    receiptTransferAssetRateLimitSubjectHash({ ...base, receiptAssetId: 'receipt-2' }),
  );
  assert.match(receiptTransferCallerRateLimitDocumentPath(DEFAULT_UID), /\/callers\//);
  assert.match(receiptTransferAssetRateLimitDocumentPath(base), /\/assets\//);
});

test('asset quotas are isolated by caller even for the same public receipt', async () => {
  const db = new MemoryFirestore();
  const first = assetSubject({ uid: 'first-uid' });
  const second = assetSubject({ uid: 'second-uid' });
  await enforceAsset({ db, nowMs: 1_000, subject: first });
  await enforceAsset({ db, nowMs: 1_000, subject: second });

  assert.equal(assetBucket(db, first)?.count, 1);
  assert.equal(assetBucket(db, second)?.count, 1);
  assert.equal(db.docs.size, 2);
});

test('aggregate caller bucket stops asset rotation before another asset bucket is created', async () => {
  const db = new MemoryFirestore();
  const startedAtMs = 5_000;
  for (let index = 0; index < RECEIPT_TRANSFER_CALLER_RATE_LIMIT; index += 1) {
    await enforceCaller({ db, nowMs: startedAtMs + index });
    await enforceAsset({
      db,
      nowMs: startedAtMs + index,
      subject: assetSubject({ receiptAssetId: `receipt-${index}` }),
    });
  }

  await assert.rejects(
    enforceCaller({ db, nowMs: startedAtMs + 1_000 }),
    (error) =>
      assertRateLimited(
        error,
        RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS - 1_000,
      ),
  );
  assert.equal(
    assetBucket(db, assetSubject({ receiptAssetId: 'receipt-overflow' })),
    undefined,
  );
  assert.equal(db.docs.size, RECEIPT_TRANSFER_CALLER_RATE_LIMIT + 1);
});

test('stored v1 or malformed buckets reset to a clean v2 window', async () => {
  const db = new MemoryFirestore();
  const callerPath = receiptTransferCallerRateLimitDocumentPath(DEFAULT_UID);
  db.docs.set(callerPath, {
    schemaVersion: 1,
    scope: 'caller',
    subjectHash: receiptTransferCallerRateLimitSubjectHash(DEFAULT_UID),
    count: RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
    windowStartedAtMs: 500,
  });
  await enforceCaller({ db, nowMs: 1_000 });
  assert.deepEqual(callerBucket(db), {
    schemaVersion: 2,
    scope: 'caller',
    subjectHash: receiptTransferCallerRateLimitSubjectHash(DEFAULT_UID),
    windowStartedAtMs: 1_000,
    count: 1,
    updatedAtMs: 1_000,
  });

  const subject = assetSubject();
  const assetPath = receiptTransferAssetRateLimitDocumentPath(subject);
  db.docs.set(assetPath, {
    schemaVersion: 2,
    scope: 'asset',
    subjectHash: receiptTransferAssetRateLimitSubjectHash(subject),
    cluster: subject.cluster,
    ownerWallet: subject.ownerWallet,
    receiptAssetId: subject.receiptAssetId,
    count: null,
    windowStartedAtMs: 500,
  });
  await enforceAsset({ db, nowMs: 2_000, subject });
  assert.equal(assetBucket(db, subject)?.count, 1);
  assert.equal(assetBucket(db, subject)?.windowStartedAtMs, 2_000);

  for (const corruptCount of [0, RECEIPT_TRANSFER_ASSET_RATE_LIMIT + 1]) {
    db.docs.set(assetPath, {
      schemaVersion: 2,
      scope: 'asset',
      subjectHash: receiptTransferAssetRateLimitSubjectHash(subject),
      cluster: subject.cluster,
      ownerWallet: subject.ownerWallet,
      receiptAssetId: subject.receiptAssetId,
      count: corruptCount,
      windowStartedAtMs: 2_000,
    });
    await enforceAsset({ db, nowMs: 3_000 + corruptCount, subject });
    assert.equal(assetBucket(db, subject)?.count, 1);
    assert.equal(assetBucket(db, subject)?.windowStartedAtMs, 3_000 + corruptCount);
  }
});

test('stored buckets include v2 metadata and public asset fields without the raw uid', async () => {
  const db = new MemoryFirestore();
  const subject = assetSubject({ uid: 'do-not-store-this-uid' });
  await enforceCaller({ db, nowMs: 1_000, uid: subject.uid });
  await enforceAsset({ db, nowMs: 1_000, subject });

  const storedCaller = callerBucket(db, subject.uid);
  const storedAsset = assetBucket(db, subject);
  assert.equal(storedCaller?.schemaVersion, 2);
  assert.equal(storedCaller?.scope, 'caller');
  assert.equal(storedAsset?.schemaVersion, 2);
  assert.equal(storedAsset?.scope, 'asset');
  assert.equal(storedAsset?.cluster, subject.cluster);
  assert.equal(storedAsset?.ownerWallet, subject.ownerWallet);
  assert.equal(storedAsset?.receiptAssetId, subject.receiptAssetId);
  assert.doesNotMatch(
    JSON.stringify(Array.from(db.docs.entries())),
    /do-not-store-this-uid/,
  );
});

test('Firestore failures are logged without the uid and fail closed as unavailable', async () => {
  for (const transactionError of [
    new Error('Firestore unavailable'),
    new HttpsError('aborted', 'Firestore transaction aborted'),
  ]) {
    const db = new MemoryFirestore();
    db.transactionError = transactionError;
    const spy = loggerSpy();

    await assert.rejects(
      enforceCaller({
        db,
        nowMs: 1_000,
        uid: 'private-uid',
        logger: spy.logger,
      }),
      (error: unknown) => {
        const callableError = error as { code?: unknown; message?: unknown };
        assert.equal(callableError.code, 'unavailable');
        assert.match(String(callableError.message), /temporarily unavailable/i);
        return true;
      },
    );
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].message, 'prepareReceiptTransferTx:rate_limit_firestore_error');
    assert.doesNotMatch(JSON.stringify(spy.calls), /private-uid/);
    assert.equal(db.writes, 0);
  }
});
