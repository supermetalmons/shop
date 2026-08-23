import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
  RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
  RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
  evaluateReceiptTransferRateLimit,
  receiptTransferAssetRateLimitBucket,
  receiptTransferAssetRateLimitDocumentPath,
  receiptTransferAssetRateLimitSubjectHash,
  receiptTransferCallerRateLimitBucket,
  receiptTransferCallerRateLimitDocumentPath,
  receiptTransferCallerRateLimitSubjectHash,
  receiptTransferStoredBucketMatches,
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
  assert.match(receiptTransferCallerRateLimitDocumentPath(UID), /\/callers\//);
  assert.match(receiptTransferAssetRateLimitDocumentPath(base), /\/assets\//);
});

test('receipt transfer rate-limit buckets retain production paths and public fields', () => {
  const caller = receiptTransferCallerRateLimitBucket(UID);
  const asset = receiptTransferAssetRateLimitBucket(assetSubject());
  assert.equal(caller.limit, RECEIPT_TRANSFER_CALLER_RATE_LIMIT);
  assert.equal(asset.limit, RECEIPT_TRANSFER_ASSET_RATE_LIMIT);
  assert.equal(caller.documentPath, receiptTransferCallerRateLimitDocumentPath(UID));
  assert.equal(asset.documentPath, receiptTransferAssetRateLimitDocumentPath(assetSubject()));
  assert.deepEqual(asset.publicFields, {
    cluster: 'devnet',
    ownerWallet: OWNER,
    receiptAssetId: ASSET,
  });
  assert.doesNotMatch(JSON.stringify(asset), new RegExp(UID));
});

test('receipt transfer stored bucket matching resets legacy and malformed documents', () => {
  const caller = receiptTransferCallerRateLimitBucket(UID);
  assert.equal(receiptTransferStoredBucketMatches({
    schemaVersion: 2,
    scope: 'caller',
    subjectHash: caller.subjectHash,
    count: 1,
    windowStartedAtMs: 1,
  }, caller), true);
  assert.equal(receiptTransferStoredBucketMatches({
    schemaVersion: 1,
    scope: 'caller',
    subjectHash: caller.subjectHash,
  }, caller), false);
  const asset = receiptTransferAssetRateLimitBucket(assetSubject());
  assert.equal(receiptTransferStoredBucketMatches({
    schemaVersion: 2,
    scope: 'asset',
    subjectHash: asset.subjectHash,
    cluster: 'devnet',
    ownerWallet: OWNER,
    receiptAssetId: ASSET,
  }, asset), true);
  assert.equal(receiptTransferStoredBucketMatches({
    schemaVersion: 2,
    scope: 'asset',
    subjectHash: asset.subjectHash,
    cluster: 'devnet',
    ownerWallet: OWNER,
    receiptAssetId: 'other',
  }, asset), false);
});

test('receipt transfer evaluator rejects invalid limits and times', () => {
  assert.throws(() => evaluateReceiptTransferRateLimit(undefined, -1, 1));
  assert.throws(() => evaluateReceiptTransferRateLimit(undefined, 1, 0));
  assert.throws(() => evaluateReceiptTransferRateLimit(undefined, Number.NaN, 1));
});
