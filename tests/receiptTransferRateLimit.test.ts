import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
  RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
  RECEIPT_TRANSFER_RATE_LIMIT_CLEANUP_LIMIT,
  RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
  cleanupExpiredReceiptTransferRateLimitBuckets,
  consumeReceiptTransferRateLimit,
  evaluateReceiptTransferRateLimit,
  receiptTransferAssetRateLimitBucket,
  receiptTransferAssetRateLimitSubjectHash,
  receiptTransferCallerRateLimitBucket,
  receiptTransferCallerRateLimitSubjectHash,
  type ReceiptTransferRateLimitD1Database,
  type ReceiptTransferRateLimitD1Statement,
} from '../cloud/workers/api/src/receiptTransferRateLimit.ts';

const UID = 'anonymous-firebase-uid';
const OWNER = 'owner-wallet';
const ASSET = 'receipt-1';

function assetSubject(overrides: Partial<{
  uid: string;
  cluster: 'devnet' | 'testnet' | 'mainnet-beta';
  ownerWallet: string;
  receiptAssetId: string;
}> = {}) {
  return {
    uid: overrides.uid ?? UID,
    cluster: overrides.cluster ?? 'devnet' as const,
    ownerWallet: overrides.ownerWallet ?? OWNER,
    receiptAssetId: overrides.receiptAssetId ?? ASSET,
  };
}

function scriptedDatabase(batches: Array<Array<Array<Record<string, unknown>>>>) {
  const metadata = new WeakMap<ReceiptTransferRateLimitD1Statement, { query: string; values: unknown[] }>();
  const calls: Array<Array<{ query: string; values: unknown[] }>> = [];
  const database: ReceiptTransferRateLimitD1Database = {
    prepare(query) {
      const statement: ReceiptTransferRateLimitD1Statement = {
        bind(...values) {
          metadata.set(statement, { query, values });
          return statement;
        },
      };
      metadata.set(statement, { query, values: [] });
      return statement;
    },
    async batch<T>(statements: ReceiptTransferRateLimitD1Statement[]) {
      calls.push(statements.map((statement) => metadata.get(statement)!));
      const results = batches.shift();
      if (!results) throw new Error('Unexpected D1 batch');
      return results.map((rows) => ({ results: rows as T[] }));
    },
  };
  return { calls, database };
}

test('receipt transfer fixed windows preserve caller and asset quotas', () => {
  const startedAtMs = 1_000;
  let caller: Record<string, unknown> | undefined;
  for (let count = 1; count <= RECEIPT_TRANSFER_CALLER_RATE_LIMIT; count += 1) {
    const decision = evaluateReceiptTransferRateLimit(caller, startedAtMs + count - 1, RECEIPT_TRANSFER_CALLER_RATE_LIMIT);
    assert.equal(decision.allowed, true);
    caller = { count: decision.count, windowStartedAtMs: decision.windowStartedAtMs };
  }
  assert.deepEqual(
    evaluateReceiptTransferRateLimit(caller, startedAtMs + 1_000, RECEIPT_TRANSFER_CALLER_RATE_LIMIT),
    {
      allowed: false,
      count: RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
      retryAfterMs: RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS - 1_000,
      windowStartedAtMs: startedAtMs,
    },
  );
  assert.deepEqual(
    evaluateReceiptTransferRateLimit(
      { count: RECEIPT_TRANSFER_ASSET_RATE_LIMIT, windowStartedAtMs: startedAtMs },
      startedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
      RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
    ),
    {
      allowed: true,
      count: 1,
      windowStartedAtMs: startedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
    },
  );
});

test('receipt transfer fixed windows stay monotonic for reversed request arrival', () => {
  const newerStartedAtMs = 2_000;
  const olderSampledAtMs = 1_000;
  assert.deepEqual(
    evaluateReceiptTransferRateLimit(
      { count: 1, windowStartedAtMs: newerStartedAtMs },
      olderSampledAtMs,
      RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
    ),
    {
      allowed: true,
      count: 2,
      windowStartedAtMs: newerStartedAtMs,
    },
  );
  assert.deepEqual(
    evaluateReceiptTransferRateLimit(
      { count: RECEIPT_TRANSFER_ASSET_RATE_LIMIT, windowStartedAtMs: newerStartedAtMs },
      olderSampledAtMs,
      RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
    ),
    {
      allowed: false,
      count: RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
      retryAfterMs: RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
      windowStartedAtMs: newerStartedAtMs,
    },
  );
});

test('receipt transfer rate-limit subjects preserve v2 domain separation', () => {
  const base = assetSubject();
  const callerHash = receiptTransferCallerRateLimitSubjectHash(UID);
  const assetHash = receiptTransferAssetRateLimitSubjectHash(base);
  assert.match(callerHash, /^[a-f0-9]{64}$/);
  assert.match(assetHash, /^[a-f0-9]{64}$/);
  assert.notEqual(callerHash, assetHash);
  assert.notEqual(assetHash, receiptTransferAssetRateLimitSubjectHash({ ...base, uid: 'other' }));
  assert.notEqual(assetHash, receiptTransferAssetRateLimitSubjectHash({ ...base, ownerWallet: 'other' }));
  assert.notEqual(assetHash, receiptTransferAssetRateLimitSubjectHash({ ...base, cluster: 'mainnet-beta' }));
  assert.notEqual(assetHash, receiptTransferAssetRateLimitSubjectHash({ ...base, receiptAssetId: 'other' }));
});

test('receipt transfer D1 buckets retain only hashed caller and public asset identity', () => {
  const caller = receiptTransferCallerRateLimitBucket(UID);
  const asset = receiptTransferAssetRateLimitBucket(assetSubject());
  assert.equal(caller.limit, RECEIPT_TRANSFER_CALLER_RATE_LIMIT);
  assert.equal(asset.limit, RECEIPT_TRANSFER_ASSET_RATE_LIMIT);
  assert.deepEqual(caller, {
    scope: 'caller',
    subjectHash: receiptTransferCallerRateLimitSubjectHash(UID),
    limit: RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
  });
  assert.equal(asset.scope, 'asset');
  if (asset.scope !== 'asset') assert.fail('Expected asset bucket');
  assert.equal(asset.cluster, 'devnet');
  assert.equal(asset.ownerWallet, OWNER);
  assert.equal(asset.receiptAssetId, ASSET);
  assert.doesNotMatch(JSON.stringify(asset), new RegExp(UID));
});

test('receipt transfer D1 consumption uses one atomic UPSERT and read batch', async () => {
  const nowMs = 1_700_000_000_000;
  const caller = receiptTransferCallerRateLimitBucket(UID);
  const admittedRow = {
    scope: 'caller',
    subject_hash: caller.subjectHash,
    schema_version: 2,
    cluster: null,
    owner_wallet: null,
    receipt_asset_id: null,
    window_started_at_ms: nowMs,
    expires_at_ms: nowMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
    request_count: 1,
  };
  const admitted = scriptedDatabase([[[admittedRow], [admittedRow]]]);
  assert.deepEqual(
    await consumeReceiptTransferRateLimit(admitted.database, caller, nowMs),
    { allowed: true, count: 1, windowStartedAtMs: nowMs },
  );
  assert.equal(admitted.calls.length, 1);
  assert.equal(admitted.calls[0].length, 2);
  assert.match(admitted.calls[0][0].query, /ON CONFLICT\(scope, subject_hash\).*RETURNING/s);
  assert.match(admitted.calls[0][1].query, /SELECT[\s\S]*FROM rate_limit_buckets/);
  assert.equal(admitted.calls[0][0].values.length, 15);
  assert.doesNotMatch(JSON.stringify(admitted.calls), new RegExp(UID));

  const deniedRow = { ...admittedRow, request_count: RECEIPT_TRANSFER_CALLER_RATE_LIMIT };
  const denied = scriptedDatabase([[[], [deniedRow]]]);
  assert.deepEqual(
    await consumeReceiptTransferRateLimit(denied.database, caller, nowMs + 1_000),
    {
      allowed: false,
      count: RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
      retryAfterMs: RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS - 1_000,
      windowStartedAtMs: nowMs,
    },
  );
});

test('receipt transfer D1 cleanup is bounded and reports remaining backlog', async () => {
  const nowMs = 1_700_000_000_000;
  const deletedRows = Array.from(
    { length: RECEIPT_TRANSFER_RATE_LIMIT_CLEANUP_LIMIT },
    (_, index) => ({ subject_hash: String(index).padStart(64, '0') }),
  );
  const scripted = scriptedDatabase([[[...deletedRows], [{ has_more: 1 }]]]);
  assert.deepEqual(
    await cleanupExpiredReceiptTransferRateLimitBuckets(scripted.database, nowMs),
    {
      deletedCount: RECEIPT_TRANSFER_RATE_LIMIT_CLEANUP_LIMIT,
      limitReached: true,
      hasMore: true,
    },
  );
  assert.equal(scripted.calls[0][0].values[0], nowMs - 2 * 60 * 1_000);
  assert.equal(scripted.calls[0][1].values[0], nowMs - 2 * 60 * 1_000);
  assert.match(scripted.calls[0][0].query, /LIMIT 1000[\s\S]*RETURNING subject_hash/);
});

test('receipt transfer evaluator rejects invalid limits and times', () => {
  assert.throws(() => evaluateReceiptTransferRateLimit(undefined, -1, 1));
  assert.throws(() => evaluateReceiptTransferRateLimit(undefined, 1, 0));
  assert.throws(() => evaluateReceiptTransferRateLimit(undefined, Number.NaN, 1));
});
