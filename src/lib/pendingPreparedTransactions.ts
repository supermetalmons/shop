import {
  isBase58Bytes,
  isNonZeroBase58Bytes,
} from '../../functions/src/shared/solanaRpcProxy.ts';

const PENDING_PREPARED_TRANSACTION_STORAGE_PREFIX = 'monsPendingPreparedTransaction:v1';
export const PENDING_PREPARED_TRANSACTION_PREPARING_TTL_MS = 5 * 60_000;

type PendingPreparedTransactionBase = {
  wallet: string;
  dropId: string;
  createdAt: number;
  operationId: string;
  blockhashContextSlot: number;
};

type PendingPreparedTransactionSubmission = {
  signature: string;
  recentBlockhash: string;
};

export type PendingPreparingDeliveryTransaction = PendingPreparedTransactionBase & {
  kind: 'delivery';
  phase: 'preparing';
  deliveryId: number;
  itemIds: string[];
};

export type PendingSubmittedDeliveryTransaction = Omit<PendingPreparingDeliveryTransaction, 'phase'> &
  PendingPreparedTransactionSubmission & {
    phase: 'submitted';
  };

export type PendingPreparingClaimTransaction = PendingPreparedTransactionBase & {
  kind: 'claim';
  phase: 'preparing';
  certificates: number[];
  certificateId: string;
};

export type PendingSubmittedClaimTransaction = Omit<PendingPreparingClaimTransaction, 'phase'> &
  PendingPreparedTransactionSubmission & {
    phase: 'submitted';
  };

export type PendingPreparingTransaction =
  | PendingPreparingDeliveryTransaction
  | PendingPreparingClaimTransaction;

export type PendingSubmittedTransaction =
  | PendingSubmittedDeliveryTransaction
  | PendingSubmittedClaimTransaction;

export type PendingPreparedTransaction = PendingPreparingTransaction | PendingSubmittedTransaction;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const DROP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_CREATED_AT = 8_640_000_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function parseBase(value: Record<string, unknown>): PendingPreparedTransactionBase | null {
  if (
    !isBase58Bytes(value.wallet, 32) ||
    typeof value.dropId !== 'string' ||
    !DROP_ID_PATTERN.test(value.dropId) ||
    typeof value.operationId !== 'string' ||
    !OPERATION_ID_PATTERN.test(value.operationId) ||
    !Number.isSafeInteger(value.blockhashContextSlot) ||
    Number(value.blockhashContextSlot) < 0 ||
    !Number.isSafeInteger(value.createdAt) ||
    Number(value.createdAt) < 1 ||
    Number(value.createdAt) > MAX_CREATED_AT
  ) return null;
  return {
    wallet: value.wallet,
    dropId: value.dropId,
    createdAt: Number(value.createdAt),
    operationId: value.operationId,
    blockhashContextSlot: Number(value.blockhashContextSlot),
  };
}

function parseSubmission(value: Record<string, unknown>): PendingPreparedTransactionSubmission | null {
  if (
    !isNonZeroBase58Bytes(value.signature, 64) ||
    !isNonZeroBase58Bytes(value.recentBlockhash, 32)
  ) return null;
  return {
    signature: value.signature,
    recentBlockhash: value.recentBlockhash,
  };
}

function parseDelivery(value: Record<string, unknown>, base: PendingPreparedTransactionBase) {
  if (
    !Number.isSafeInteger(value.deliveryId) ||
    Number(value.deliveryId) < 1 ||
    Number(value.deliveryId) >= 2 ** 31 ||
    !Array.isArray(value.itemIds) ||
    value.itemIds.length < 1 ||
    value.itemIds.length > 24 ||
    !value.itemIds.every((itemId) => isBase58Bytes(itemId, 32)) ||
    new Set(value.itemIds).size !== value.itemIds.length
  ) return null;
  return {
    ...base,
    deliveryId: Number(value.deliveryId),
    itemIds: [...value.itemIds] as string[],
  };
}

function parseClaim(value: Record<string, unknown>, base: PendingPreparedTransactionBase) {
  if (
    !Array.isArray(value.certificates) ||
    value.certificates.length < 1 ||
    value.certificates.length > 32 ||
    !value.certificates.every((certificate) => Number.isSafeInteger(certificate) && Number(certificate) > 0) ||
    new Set(value.certificates).size !== value.certificates.length ||
    !isBase58Bytes(value.certificateId, 32)
  ) return null;
  return {
    ...base,
    certificates: [...value.certificates] as number[],
    certificateId: value.certificateId,
  };
}

export function parsePendingPreparedTransaction(value: unknown): PendingPreparedTransaction | null {
  if (!isRecord(value)) return null;
  const base = parseBase(value);
  if (!base || (value.phase !== 'preparing' && value.phase !== 'submitted')) return null;
  const submissionKeys = value.phase === 'submitted' ? ['signature', 'recentBlockhash'] : [];
  const submission = value.phase === 'submitted' ? parseSubmission(value) : null;
  if (value.phase === 'submitted' && !submission) return null;
  if (value.kind === 'delivery') {
    if (!hasExactKeys(value, [
      'kind',
      'phase',
      'wallet',
      'dropId',
      'createdAt',
      'operationId',
      'blockhashContextSlot',
      'deliveryId',
      'itemIds',
      ...submissionKeys,
    ])) return null;
    const delivery = parseDelivery(value, base);
    if (!delivery) return null;
    return value.phase === 'submitted'
      ? { kind: 'delivery', phase: 'submitted', ...delivery, ...submission! }
      : { kind: 'delivery', phase: 'preparing', ...delivery };
  }
  if (value.kind === 'claim') {
    if (!hasExactKeys(value, [
      'kind',
      'phase',
      'wallet',
      'dropId',
      'createdAt',
      'operationId',
      'blockhashContextSlot',
      'certificates',
      'certificateId',
      ...submissionKeys,
    ])) return null;
    const claim = parseClaim(value, base);
    if (!claim) return null;
    return value.phase === 'submitted'
      ? { kind: 'claim', phase: 'submitted', ...claim, ...submission! }
      : { kind: 'claim', phase: 'preparing', ...claim };
  }
  return null;
}

export function pendingPreparedTransactionStorageKey(wallet: string): string {
  return `${PENDING_PREPARED_TRANSACTION_STORAGE_PREFIX}:${wallet}`;
}

function browserStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

export function loadPendingPreparedTransaction(
  wallet: string,
  storage: StorageLike | null = browserStorage(),
): PendingPreparedTransaction | null {
  if (!storage || !isBase58Bytes(wallet, 32)) return null;
  const key = pendingPreparedTransactionStorageKey(wallet);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = parsePendingPreparedTransaction(JSON.parse(raw));
    if (parsed?.wallet === wallet) return parsed;
    storage.removeItem(key);
    return null;
  } catch {
    try {
      storage.removeItem(key);
    } catch {}
    return null;
  }
}

export function persistPendingPreparedTransaction(
  entry: PendingPreparedTransaction,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage || !parsePendingPreparedTransaction(entry)) return false;
  try {
    storage.setItem(pendingPreparedTransactionStorageKey(entry.wallet), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

export function replacePendingPreparedTransaction(
  expected: PendingPreparingTransaction,
  next: PendingSubmittedTransaction,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage || !samePendingPreparedTransaction(expected, next)) return false;
  const current = loadPendingPreparedTransaction(expected.wallet, storage);
  if (!current || !samePendingPreparedTransaction(current, expected)) return false;
  return persistPendingPreparedTransaction(next, storage);
}

export function samePendingPreparedTransaction(
  current: PendingPreparedTransaction,
  expected: PendingPreparedTransaction,
): boolean {
  if (
    current.wallet !== expected.wallet ||
    current.kind !== expected.kind ||
    current.dropId !== expected.dropId ||
    current.createdAt !== expected.createdAt ||
    current.operationId !== expected.operationId ||
    current.blockhashContextSlot !== expected.blockhashContextSlot
  ) return false;
  if (
    (current.kind === 'delivery' && expected.kind === 'delivery' && (
      current.deliveryId !== expected.deliveryId ||
      current.itemIds.length !== expected.itemIds.length ||
      current.itemIds.some((itemId, index) => itemId !== expected.itemIds[index])
    )) ||
    (current.kind === 'claim' && expected.kind === 'claim' && (
      current.certificateId !== expected.certificateId ||
      current.certificates.length !== expected.certificates.length ||
      current.certificates.some((certificate, index) => certificate !== expected.certificates[index])
    ))
  ) return false;
  if (current.phase === 'submitted' && expected.phase === 'submitted') {
    return current.signature === expected.signature;
  }
  return true;
}

export function forgetPendingPreparedTransaction(
  expected: PendingPreparedTransaction,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  const current = loadPendingPreparedTransaction(expected.wallet, storage);
  if (current && !samePendingPreparedTransaction(current, expected)) return true;
  try {
    storage.removeItem(pendingPreparedTransactionStorageKey(expected.wallet));
    return true;
  } catch {
    return false;
  }
}

export function pendingPreparingTransactionExpired(
  entry: PendingPreparedTransaction,
  now = Date.now(),
): boolean {
  return entry.phase === 'preparing' && now >= entry.createdAt + PENDING_PREPARED_TRANSACTION_PREPARING_TTL_MS;
}

export function pendingSubmittedClaim(
  entry: PendingPreparedTransaction | null,
  wallet: string,
): PendingSubmittedClaimTransaction | null {
  return entry?.phase === 'submitted' && entry.kind === 'claim' && entry.wallet === wallet ? entry : null;
}

export function pendingDeliveryAssetIds(
  entry: PendingPreparedTransaction | null,
  wallet: string | null | undefined,
): Set<string> {
  return entry?.kind === 'delivery' && entry.wallet === wallet ? new Set(entry.itemIds) : new Set();
}
