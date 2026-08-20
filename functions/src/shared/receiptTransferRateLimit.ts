import { createHash } from 'node:crypto';
import type { SolanaCluster } from './deploymentCore.js';

export const RECEIPT_TRANSFER_CALLER_RATE_LIMIT = 60;
export const RECEIPT_TRANSFER_ASSET_RATE_LIMIT = 20;
export const RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION = 2;

const RECEIPT_TRANSFER_RATE_LIMIT_ROOT = 'system/receiptTransferRateLimits';
const RECEIPT_TRANSFER_CALLER_RATE_LIMIT_ROOT = `${RECEIPT_TRANSFER_RATE_LIMIT_ROOT}/callers`;
const RECEIPT_TRANSFER_ASSET_RATE_LIMIT_ROOT = `${RECEIPT_TRANSFER_RATE_LIMIT_ROOT}/assets`;
const RECEIPT_TRANSFER_CALLER_HASH_DOMAIN = 'receipt-transfer-rate-limit:v2:caller';
const RECEIPT_TRANSFER_ASSET_HASH_DOMAIN = 'receipt-transfer-rate-limit:v2:asset';

export type ReceiptTransferRateLimitCluster = SolanaCluster;
type ReceiptTransferRateLimitScope = 'caller' | 'asset';

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

export type ReceiptTransferRateLimitBucket = {
  scope: ReceiptTransferRateLimitScope;
  subjectHash: string;
  documentPath: string;
  limit: number;
  publicFields?: Record<string, string>;
};

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
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

export function receiptTransferStoredBucketMatches(
  existing: Record<string, unknown> | undefined,
  bucket: ReceiptTransferRateLimitBucket,
): boolean {
  if (
    existing?.schemaVersion !== RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION ||
    existing.scope !== bucket.scope ||
    existing.subjectHash !== bucket.subjectHash
  ) {
    return false;
  }
  return Object.entries(bucket.publicFields ?? {}).every(
    ([key, value]) => existing[key] === value,
  );
}

export function evaluateReceiptTransferRateLimit(
  existing: Record<string, unknown> | null | undefined,
  nowMs: number,
  limit: number,
): ReceiptTransferRateLimitDecision {
  const normalizedNowMs = Math.floor(Number(nowMs));
  if (!Number.isSafeInteger(normalizedNowMs) || normalizedNowMs < 0) {
    throw new Error('Receipt transfer rate-limit time is invalid');
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Receipt transfer rate-limit maximum is invalid');
  }

  const storedWindowStartedAtMs = finiteInteger(existing?.windowStartedAtMs);
  const storedCount = finiteInteger(existing?.count);
  const hasActiveWindow =
    storedWindowStartedAtMs != null &&
    storedWindowStartedAtMs >= 0 &&
    storedWindowStartedAtMs <= normalizedNowMs &&
    normalizedNowMs - storedWindowStartedAtMs < RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS &&
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
      retryAfterMs: Math.max(
        1,
        storedWindowStartedAtMs + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS - normalizedNowMs,
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

export function receiptTransferCallerRateLimitDocumentPath(uid: string): string {
  return `${RECEIPT_TRANSFER_CALLER_RATE_LIMIT_ROOT}/${receiptTransferCallerRateLimitSubjectHash(uid)}`;
}

export function receiptTransferCallerRateLimitBucket(uid: string): ReceiptTransferRateLimitBucket {
  const subjectHash = receiptTransferCallerRateLimitSubjectHash(uid);
  return {
    scope: 'caller',
    subjectHash,
    documentPath: `${RECEIPT_TRANSFER_CALLER_RATE_LIMIT_ROOT}/${subjectHash}`,
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

export function receiptTransferAssetRateLimitDocumentPath(params: {
  uid: string;
  cluster: ReceiptTransferRateLimitCluster;
  ownerWallet: string;
  receiptAssetId: string;
}): string {
  return `${RECEIPT_TRANSFER_ASSET_RATE_LIMIT_ROOT}/${receiptTransferAssetRateLimitSubjectHash(params)}`;
}

export function receiptTransferAssetRateLimitBucket(params: {
  uid: string;
  cluster: ReceiptTransferRateLimitCluster;
  ownerWallet: string;
  receiptAssetId: string;
}): ReceiptTransferRateLimitBucket {
  const subjectHash = receiptTransferAssetRateLimitSubjectHash(params);
  return {
    scope: 'asset',
    subjectHash,
    documentPath: `${RECEIPT_TRANSFER_ASSET_RATE_LIMIT_ROOT}/${subjectHash}`,
    limit: RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
    publicFields: {
      cluster: params.cluster,
      ownerWallet: params.ownerWallet,
      receiptAssetId: params.receiptAssetId,
    },
  };
}
