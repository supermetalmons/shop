import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import type { SolanaCluster } from './shared/deploymentCore.js';

export const RECEIPT_TRANSFER_CALLER_RATE_LIMIT = 60;
export const RECEIPT_TRANSFER_ASSET_RATE_LIMIT = 20;
export const RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION = 2;
const RECEIPT_TRANSFER_RATE_LIMIT_ROOT = 'system/receiptTransferRateLimits';
const RECEIPT_TRANSFER_CALLER_RATE_LIMIT_ROOT = `${RECEIPT_TRANSFER_RATE_LIMIT_ROOT}/callers`;
const RECEIPT_TRANSFER_ASSET_RATE_LIMIT_ROOT = `${RECEIPT_TRANSFER_RATE_LIMIT_ROOT}/assets`;
const RECEIPT_TRANSFER_CALLER_HASH_DOMAIN = 'receipt-transfer-rate-limit:v2:caller';
const RECEIPT_TRANSFER_ASSET_HASH_DOMAIN = 'receipt-transfer-rate-limit:v2:asset';

export type ReceiptTransferRateLimitCluster = SolanaCluster;
export type ReceiptTransferRateLimitScope = 'caller' | 'asset';

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

type ReceiptTransferRateLimitLogger = {
  error: (message: string, ...args: unknown[]) => void;
};

type ReceiptTransferRateLimitBucket = {
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

function storedBucketMatches(
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

async function enforceReceiptTransferRateLimit(params: {
  db: Firestore;
  logger: ReceiptTransferRateLimitLogger;
  bucket: ReceiptTransferRateLimitBucket;
  nowMs?: number;
}): Promise<void> {
  let decision: ReceiptTransferRateLimitDecision;

  try {
    const nowMs = params.nowMs ?? Date.now();
    const ref = params.db.doc(params.bucket.documentPath);
    decision = await params.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const rawExisting = snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
      const existing = storedBucketMatches(rawExisting, params.bucket)
        ? rawExisting
        : undefined;
      const next = evaluateReceiptTransferRateLimit(existing, nowMs, params.bucket.limit);
      if (next.allowed) {
        tx.set(ref, {
          schemaVersion: RECEIPT_TRANSFER_RATE_LIMIT_SCHEMA_VERSION,
          scope: params.bucket.scope,
          subjectHash: params.bucket.subjectHash,
          ...params.bucket.publicFields,
          windowStartedAtMs: next.windowStartedAtMs,
          count: next.count,
          updatedAtMs: nowMs,
        });
      }
      return next;
    });
  } catch (err) {
    const errorForLog = err instanceof Error ? err : new Error(String(err));
    try {
      params.logger.error('prepareReceiptTransferTx:rate_limit_firestore_error', errorForLog, {
        scope: params.bucket.scope,
        subjectHash: params.bucket.subjectHash,
      });
    } catch {
      // Logging must not replace the stable callable error below.
    }
    throw new HttpsError(
      'unavailable',
      'Receipt transfers are temporarily unavailable. Please retry shortly.',
    );
  }

  if (decision.allowed === false) {
    throw new HttpsError(
      'resource-exhausted',
      'Too many receipt transfer attempts. Please wait before trying again.',
      {
        retryAfterMs: decision.retryAfterMs,
      },
    );
  }
}

export async function enforceReceiptTransferCallerRateLimit(params: {
  db: Firestore;
  logger: ReceiptTransferRateLimitLogger;
  uid: string;
  nowMs?: number;
}): Promise<void> {
  const subjectHash = receiptTransferCallerRateLimitSubjectHash(params.uid);
  await enforceReceiptTransferRateLimit({
    db: params.db,
    logger: params.logger,
    nowMs: params.nowMs,
    bucket: {
      scope: 'caller',
      subjectHash,
      documentPath: `${RECEIPT_TRANSFER_CALLER_RATE_LIMIT_ROOT}/${subjectHash}`,
      limit: RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
    },
  });
}

export async function enforceReceiptTransferAssetRateLimit(params: {
  db: Firestore;
  logger: ReceiptTransferRateLimitLogger;
  uid: string;
  cluster: ReceiptTransferRateLimitCluster;
  ownerWallet: string;
  receiptAssetId: string;
  nowMs?: number;
}): Promise<void> {
  const subject = {
    uid: params.uid,
    cluster: params.cluster,
    ownerWallet: params.ownerWallet,
    receiptAssetId: params.receiptAssetId,
  };
  const subjectHash = receiptTransferAssetRateLimitSubjectHash(subject);
  await enforceReceiptTransferRateLimit({
    db: params.db,
    logger: params.logger,
    nowMs: params.nowMs,
    bucket: {
      scope: 'asset',
      subjectHash,
      documentPath: `${RECEIPT_TRANSFER_ASSET_RATE_LIMIT_ROOT}/${subjectHash}`,
      limit: RECEIPT_TRANSFER_ASSET_RATE_LIMIT,
      publicFields: {
        cluster: params.cluster,
        ownerWallet: params.ownerWallet,
        receiptAssetId: params.receiptAssetId,
      },
    },
  });
}
