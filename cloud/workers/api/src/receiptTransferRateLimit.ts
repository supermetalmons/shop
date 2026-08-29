import { createHash } from 'node:crypto';
import type { SolanaCluster } from '../../../../shared/deploymentCore.js';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../../../shared/opsExpiryCleanupSql.js';

export const RECEIPT_TRANSFER_CALLER_RATE_LIMIT = 60;
export const RECEIPT_TRANSFER_ASSET_RATE_LIMIT = 20;
export const RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION = 2;
const RECEIPT_TRANSFER_RATE_LIMIT_CLEANUP_GRACE_MS = 2 * 60 * 1000;
export const RECEIPT_TRANSFER_RATE_LIMIT_CLEANUP_LIMIT =
  OPS_EXPIRY_CLEANUP_STATEMENTS.rateLimitBuckets.limit;

const RECEIPT_TRANSFER_CALLER_HASH_DOMAIN = 'receipt-transfer-rate-limit:v2:caller';
const RECEIPT_TRANSFER_ASSET_HASH_DOMAIN = 'receipt-transfer-rate-limit:v2:asset';

export type ReceiptTransferRateLimitCluster = SolanaCluster;

export type ReceiptTransferRateLimitDecision =
  | {
      allowed: true;
      count: number;
      windowStartedAtMs: number;
    }
  | {
      allowed: false;
      count: number;
      retryAfterMs: number;
      windowStartedAtMs: number;
    };

type ReceiptTransferCallerRateLimitBucket = {
  scope: 'caller';
  subjectHash: string;
  limit: number;
};

type ReceiptTransferAssetRateLimitBucket = {
  scope: 'asset';
  subjectHash: string;
  limit: number;
  cluster: ReceiptTransferRateLimitCluster;
  ownerWallet: string;
  receiptAssetId: string;
};

export type ReceiptTransferRateLimitBucket =
  | ReceiptTransferCallerRateLimitBucket
  | ReceiptTransferAssetRateLimitBucket;

export type ReceiptTransferRateLimitCleanupResult = {
  deletedCount: number;
  limitReached: boolean;
  hasMore: boolean;
};

type ReceiptTransferRateLimitD1Result<T> = {
  results: T[];
};

export type ReceiptTransferRateLimitD1Statement = {
  bind(...values: unknown[]): ReceiptTransferRateLimitD1Statement;
};

export type ReceiptTransferRateLimitD1Database = {
  prepare(query: string): ReceiptTransferRateLimitD1Statement;
  batch<T = unknown>(
    statements: ReceiptTransferRateLimitD1Statement[],
  ): Promise<ReceiptTransferRateLimitD1Result<T>[]>;
};

type ReceiptTransferRateLimitRow = {
  scope: unknown;
  subject_hash: unknown;
  schema_version: unknown;
  cluster: unknown;
  owner_wallet: unknown;
  receipt_asset_id: unknown;
  window_started_at_ms: unknown;
  expires_at_ms: unknown;
  request_count: unknown;
};

const ACTIVE_BUCKET_SQL = `
  rate_limit_buckets.schema_version = excluded.schema_version
  AND rate_limit_buckets.cluster IS excluded.cluster
  AND rate_limit_buckets.owner_wallet IS excluded.owner_wallet
  AND rate_limit_buckets.receipt_asset_id IS excluded.receipt_asset_id
  AND rate_limit_buckets.window_started_at_ms >= 0
  AND rate_limit_buckets.expires_at_ms = rate_limit_buckets.window_started_at_ms + ${RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS}
  AND rate_limit_buckets.expires_at_ms > excluded.window_started_at_ms
  AND rate_limit_buckets.request_count BETWEEN 1 AND ?
`;

const CONSUME_BUCKET_SQL = `
  INSERT INTO rate_limit_buckets (
    scope,
    subject_hash,
    schema_version,
    cluster,
    owner_wallet,
    receipt_asset_id,
    window_started_at_ms,
    expires_at_ms,
    request_count,
    updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(scope, subject_hash) DO UPDATE SET
    schema_version = excluded.schema_version,
    cluster = excluded.cluster,
    owner_wallet = excluded.owner_wallet,
    receipt_asset_id = excluded.receipt_asset_id,
    window_started_at_ms = CASE
      WHEN (${ACTIVE_BUCKET_SQL}) THEN rate_limit_buckets.window_started_at_ms
      ELSE excluded.window_started_at_ms
    END,
    expires_at_ms = CASE
      WHEN (${ACTIVE_BUCKET_SQL}) THEN rate_limit_buckets.expires_at_ms
      ELSE excluded.expires_at_ms
    END,
    request_count = CASE
      WHEN (${ACTIVE_BUCKET_SQL}) THEN rate_limit_buckets.request_count + 1
      ELSE 1
    END,
    updated_at_ms = CASE
      WHEN (${ACTIVE_BUCKET_SQL}) THEN MAX(rate_limit_buckets.updated_at_ms, excluded.updated_at_ms)
      ELSE excluded.updated_at_ms
    END
  WHERE NOT (${ACTIVE_BUCKET_SQL}) OR rate_limit_buckets.request_count < ?
  RETURNING
    scope,
    subject_hash,
    schema_version,
    cluster,
    owner_wallet,
    receipt_asset_id,
    window_started_at_ms,
    expires_at_ms,
    request_count
`;

const SELECT_BUCKET_SQL = `
  SELECT
    scope,
    subject_hash,
    schema_version,
    cluster,
    owner_wallet,
    receipt_asset_id,
    window_started_at_ms,
    expires_at_ms,
    request_count
  FROM rate_limit_buckets
  WHERE scope = ? AND subject_hash = ?
`;

const SELECT_CLEANUP_BACKLOG_SQL = `
  SELECT EXISTS(
    SELECT 1
    FROM rate_limit_buckets
    WHERE expires_at_ms <= ?
    LIMIT 1
  ) AS has_more
`;

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function normalizedNow(value: number): number {
  const normalized = Math.floor(Number(value));
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    !Number.isSafeInteger(normalized + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS)
  ) {
    throw new Error('Receipt transfer rate-limit time is invalid');
  }
  return normalized;
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Receipt transfer rate-limit maximum is invalid');
  }
}

function hashTuple(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(domain);
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update(':');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function bucketFields(bucket: ReceiptTransferRateLimitBucket): {
  cluster: string | null;
  ownerWallet: string | null;
  receiptAssetId: string | null;
} {
  if (!/^[a-f0-9]{64}$/.test(bucket.subjectHash)) {
    throw new Error('Receipt transfer rate-limit bucket is invalid');
  }
  validateLimit(bucket.limit);
  if (bucket.scope === 'caller') {
    return { cluster: null, ownerWallet: null, receiptAssetId: null };
  }
  if (!bucket.cluster || !bucket.ownerWallet || !bucket.receiptAssetId) {
    throw new Error('Receipt transfer rate-limit bucket is invalid');
  }
  return {
    cluster: bucket.cluster,
    ownerWallet: bucket.ownerWallet,
    receiptAssetId: bucket.receiptAssetId,
  };
}

function parseBucketRow(
  row: ReceiptTransferRateLimitRow | undefined,
  bucket: ReceiptTransferRateLimitBucket,
  nowMs: number,
): { count: number; windowStartedAtMs: number; expiresAtMs: number } | null {
  if (!row) return null;
  const fields = bucketFields(bucket);
  const windowStartedAtMs = finiteInteger(row.window_started_at_ms);
  const expiresAtMs = finiteInteger(row.expires_at_ms);
  const count = finiteInteger(row.request_count);
  if (
    row.scope !== bucket.scope ||
    row.subject_hash !== bucket.subjectHash ||
    row.schema_version !== RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION ||
    row.cluster !== fields.cluster ||
    row.owner_wallet !== fields.ownerWallet ||
    row.receipt_asset_id !== fields.receiptAssetId ||
    windowStartedAtMs == null ||
    windowStartedAtMs < 0 ||
    expiresAtMs == null ||
    expiresAtMs !== windowStartedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS ||
    expiresAtMs <= nowMs ||
    count == null ||
    count < 1 ||
    count > bucket.limit
  ) {
    throw new Error('Receipt transfer rate-limit database returned an invalid bucket');
  }
  return { count, windowStartedAtMs, expiresAtMs };
}

export function evaluateReceiptTransferRateLimit(
  existing: Record<string, unknown> | null | undefined,
  nowMs: number,
  limit: number,
): ReceiptTransferRateLimitDecision {
  const normalizedNowMs = normalizedNow(nowMs);
  validateLimit(limit);
  const storedWindowStartedAtMs = finiteInteger(existing?.windowStartedAtMs);
  const storedCount = finiteInteger(existing?.count);
  const hasActiveWindow =
    storedWindowStartedAtMs != null &&
    storedWindowStartedAtMs >= 0 &&
    Number.isSafeInteger(storedWindowStartedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS) &&
    storedWindowStartedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS > normalizedNowMs &&
    storedCount != null &&
    storedCount >= 1 &&
    storedCount <= limit;

  if (!hasActiveWindow) {
    return {
      allowed: true,
      count: 1,
      windowStartedAtMs: normalizedNowMs,
    };
  }

  if (storedCount >= limit) {
    return {
      allowed: false,
      count: storedCount,
      retryAfterMs: Math.min(
        RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
        Math.max(
          1,
          storedWindowStartedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS - normalizedNowMs,
        ),
      ),
      windowStartedAtMs: storedWindowStartedAtMs,
    };
  }

  return {
    allowed: true,
    count: storedCount + 1,
    windowStartedAtMs: storedWindowStartedAtMs,
  };
}

export function receiptTransferCallerRateLimitSubjectHash(uid: string): string {
  return hashTuple(RECEIPT_TRANSFER_CALLER_HASH_DOMAIN, [uid]);
}

export function receiptTransferCallerRateLimitBucket(uid: string): ReceiptTransferRateLimitBucket {
  return {
    scope: 'caller',
    subjectHash: receiptTransferCallerRateLimitSubjectHash(uid),
    limit: RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
  };
}

export function receiptTransferAssetRateLimitSubjectHash(params: {
  uid: string;
  cluster: ReceiptTransferRateLimitCluster;
  ownerWallet: string;
  receiptAssetId: string;
}): string {
  return hashTuple(RECEIPT_TRANSFER_ASSET_HASH_DOMAIN, [
    params.uid,
    params.cluster,
    params.ownerWallet,
    params.receiptAssetId,
  ]);
}

export function receiptTransferAssetRateLimitBucket(params: {
  uid: string;
  cluster: ReceiptTransferRateLimitCluster;
  ownerWallet: string;
  receiptAssetId: string;
}): ReceiptTransferRateLimitBucket {
  return {
    scope: 'asset',
    subjectHash: receiptTransferAssetRateLimitSubjectHash(params),
    limit: RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
    cluster: params.cluster,
    ownerWallet: params.ownerWallet,
    receiptAssetId: params.receiptAssetId,
  };
}

export async function consumeReceiptTransferRateLimit(
  database: ReceiptTransferRateLimitD1Database,
  bucket: ReceiptTransferRateLimitBucket,
  nowMs: number,
): Promise<ReceiptTransferRateLimitDecision> {
  const normalizedNowMs = normalizedNow(nowMs);
  const fields = bucketFields(bucket);
  const expiresAtMs = normalizedNowMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS;
  const [consumeResult, selectedResult] = await database.batch<ReceiptTransferRateLimitRow>([
    database.prepare(CONSUME_BUCKET_SQL).bind(
      bucket.scope,
      bucket.subjectHash,
      RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION,
      fields.cluster,
      fields.ownerWallet,
      fields.receiptAssetId,
      normalizedNowMs,
      expiresAtMs,
      normalizedNowMs,
      bucket.limit,
      bucket.limit,
      bucket.limit,
      bucket.limit,
      bucket.limit,
      bucket.limit,
    ),
    database.prepare(SELECT_BUCKET_SQL).bind(bucket.scope, bucket.subjectHash),
  ]);
  if (!consumeResult || !selectedResult || consumeResult.results.length > 1 || selectedResult.results.length !== 1) {
    throw new Error('Receipt transfer rate-limit database returned an invalid result');
  }
  const selected = parseBucketRow(selectedResult.results[0], bucket, normalizedNowMs);
  if (!selected) throw new Error('Receipt transfer rate-limit database returned an invalid result');
  if (consumeResult.results.length === 0) {
    if (selected.count !== bucket.limit) {
      throw new Error('Receipt transfer rate-limit database returned an invalid denial');
    }
    return {
      allowed: false,
      count: selected.count,
      retryAfterMs: Math.min(
        RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
        Math.max(1, selected.expiresAtMs - normalizedNowMs),
      ),
      windowStartedAtMs: selected.windowStartedAtMs,
    };
  }
  const consumed = parseBucketRow(consumeResult.results[0], bucket, normalizedNowMs);
  if (
    !consumed ||
    consumed.count !== selected.count ||
    consumed.windowStartedAtMs !== selected.windowStartedAtMs ||
    consumed.expiresAtMs !== selected.expiresAtMs
  ) {
    throw new Error('Receipt transfer rate-limit database returned an inconsistent result');
  }
  return {
    allowed: true,
    count: consumed.count,
    windowStartedAtMs: consumed.windowStartedAtMs,
  };
}

export async function cleanupExpiredReceiptTransferRateLimitBuckets(
  database: ReceiptTransferRateLimitD1Database,
  nowMs: number,
): Promise<ReceiptTransferRateLimitCleanupResult> {
  const normalizedNowMs = normalizedNow(nowMs);
  const cutoffMs = Math.max(0, normalizedNowMs - RECEIPT_TRANSFER_RATE_LIMIT_CLEANUP_GRACE_MS);
  const [deleteResult, backlogResult] = await database.batch<{ subject_hash?: unknown; has_more?: unknown }>([
    database.prepare(OPS_EXPIRY_CLEANUP_STATEMENTS.rateLimitBuckets.sql)
      .bind(cutoffMs, RECEIPT_TRANSFER_RATE_LIMIT_CLEANUP_LIMIT),
    database.prepare(SELECT_CLEANUP_BACKLOG_SQL).bind(cutoffMs),
  ]);
  if (
    !deleteResult ||
    !backlogResult ||
    deleteResult.results.length > RECEIPT_TRANSFER_RATE_LIMIT_CLEANUP_LIMIT ||
    backlogResult.results.length !== 1
  ) {
    throw new Error('Receipt transfer rate-limit cleanup returned an invalid result');
  }
  const hasMoreValue = backlogResult.results[0]?.has_more;
  if (hasMoreValue !== 0 && hasMoreValue !== 1 && hasMoreValue !== false && hasMoreValue !== true) {
    throw new Error('Receipt transfer rate-limit cleanup returned an invalid backlog result');
  }
  const deletedCount = deleteResult.results.length;
  return {
    deletedCount,
    limitReached: deletedCount === RECEIPT_TRANSFER_RATE_LIMIT_CLEANUP_LIMIT,
    hasMore: hasMoreValue === 1 || hasMoreValue === true,
  };
}
