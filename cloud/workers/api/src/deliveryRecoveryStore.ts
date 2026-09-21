import {
  DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS,
  DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS,
  buildWalletDeliveryRecoveryState,
  nextPreparedDeliveryRecoveryDelayMs,
  preparedDeliveryRecoveryNextCheckMs,
  processingDeliveryRecoveryNextCheckMs,
} from '../../../../shared/deliveryRecovery.js';
import type {
  DeliveryRecoveryOutcome,
  RecoverDeliveryOrdersItemResult,
  WalletDeliveryRecoveryState,
} from '../../../../shared/contracts.js';
import {
  CommerceWriteConflict,
  commerceFieldValue,
  type CommerceDocumentData,
  type CommerceDocumentRecord,
  type CommerceJsonValue,
} from './commerceRepository.js';
import {
  commerceTimestamp,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import {
  deliveryOrderDocument,
  readDeliveryOrder,
  type DeliveryOrderDocument,
  type DeliveryOrderKey,
} from './deliveryOrderStore.js';
import {
  parseDeliveryRecoveryState,
  type DeliveryRecoveryState,
} from './deliveryOrderReadModel.js';
import {
  resolveDeliveryOrderDropId,
  resolveDeliveryOrderIdentity,
} from './deliveryOrderSummaries.js';
import { mapProviderError } from './deliveryReceiptErrors.js';
import { isSignalCancellationError } from './boundedRequest.js';

const PENDING_READY_NOTIFICATION_QUERY_PAGE_SIZE = 8;
const DELIVERY_RECOVERY_LEASE_MS = 90_000;
const MAX_PREPARED_DELIVERY_RECOVERY_CHECKS = DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS.length;
export const MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL = 2;

type DeleteField = ReturnType<typeof commerceFieldValue.delete>;
type TimestampWrite = ReturnType<typeof commerceTimestamp>;

type DeliveryRecoveryPatch = {
  status?: 'prepared_abandoned';
  preparedRecoveryAbandonedAt?: TimestampWrite;
  'receiptRecovery.leaseExpiresAt'?: TimestampWrite | DeleteField;
  'receiptRecovery.lastAttemptAt'?: CommerceJsonValue | TimestampWrite | DeleteField;
  'receiptRecovery.attemptCount'?: CommerceJsonValue | DeleteField;
  'receiptRecovery.lastErrorCode'?: string | DeleteField;
  'receiptRecovery.lastErrorMessage'?: string | DeleteField;
  'receiptRecovery.preparedProbeCount'?: number;
  'receiptRecovery.lastPreparedProbeAt'?: TimestampWrite;
  'receiptRecovery.nextPreparedProbeAt'?: TimestampWrite | DeleteField;
};

export type DeliveryRecoveryLease = {
  attemptCount: number;
  lastAttemptAtMs: number;
  leaseExpiresAtMs: number;
  previousAttemptCount: CommerceJsonValue | undefined;
  previousLastAttemptAt: CommerceJsonValue | undefined;
};

export type DeliveryRecoveryLeaseResult =
  | { acquired: true; lease: DeliveryRecoveryLease }
  | { acquired: false; result: RecoverDeliveryOrdersItemResult };

type DeliveryRecoveryEligibility =
  | { eligible: true }
  | { eligible: false; outcome: DeliveryRecoveryOutcome; message: string };

function preparedDeliveryRecoveryCheckCount(state: DeliveryRecoveryState): number {
  const raw = Number(state.rawPreparedProbeCount || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function processingDeliveryRecoveryReferenceMs(state: DeliveryRecoveryState): number {
  return Math.max(state.createdAtMs ?? 0, state.processingAtMs ?? 0, state.lastAttemptAtMs ?? 0);
}

function deliveryRecoveryPriorityMs(order: CommerceDocumentData): number {
  const state = parseDeliveryRecoveryState(order);
  if (state.status === 'processing') return processingDeliveryRecoveryReferenceMs(state);
  if (state.status === 'prepared') return preparedDeliveryRecoveryNextCheckMs(order) ?? (state.createdAtMs ?? 0);
  return state.createdAtMs ?? 0;
}

function decodeDeliveryOrderQuery(
  value: readonly CommerceDocumentRecord[],
  requireIdentity: boolean,
): DeliveryOrderDocument[] {
  const documents: DeliveryOrderDocument[] = [];
  for (const document of value) {
    if (requireIdentity && !('identity' in resolveDeliveryOrderIdentity(document.key.documentId, document.data, document.key.path))) {
      continue;
    }
    documents.push(deliveryOrderDocument(document));
  }
  return documents;
}

export async function runPendingReadyNotificationQuery(
  context: CommerceRepositoryContext,
  ownerWallet: string,
): Promise<DeliveryOrderDocument[]> {
  const documents: DeliveryOrderDocument[] = [];
  let startAfterPath: string | undefined;
  while (documents.length < MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL) {
    const value = await context.repository.queryPendingReadyNotifications({
      owner: ownerWallet,
      limit: PENDING_READY_NOTIFICATION_QUERY_PAGE_SIZE,
      ...(startAfterPath ? { startAfterPath } : {}),
    });
    const remaining = MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL - documents.length;
    documents.push(...decodeDeliveryOrderQuery(value, true).slice(0, remaining));
    if (value.length < PENDING_READY_NOTIFICATION_QUERY_PAGE_SIZE) break;
    startAfterPath = value[value.length - 1]?.key.path;
    if (!startAfterPath) break;
  }
  return documents;
}

export async function runDeliveryRecoveryOrderQuery(
  context: CommerceRepositoryContext,
  ownerWallet: string,
  requireIdentity = false,
): Promise<DeliveryOrderDocument[]> {
  const value = await context.repository.queryDeliveryRecoveryOrders(ownerWallet);
  return decodeDeliveryOrderQuery(value, requireIdentity);
}

export function compareDeliveryRecoveryCandidates(
  left: DeliveryOrderDocument,
  right: DeliveryOrderDocument,
): number {
  const leftStatus = parseDeliveryRecoveryState(left.data).status ?? '';
  const rightStatus = parseDeliveryRecoveryState(right.data).status ?? '';
  if (leftStatus !== rightStatus) {
    if (leftStatus === 'processing') return -1;
    if (rightStatus === 'processing') return 1;
  }
  const priority = deliveryRecoveryPriorityMs(left.data) - deliveryRecoveryPriorityMs(right.data);
  return priority || (left.key.path < right.key.path ? -1 : left.key.path > right.key.path ? 1 : 0);
}

export function deliveryRecoveryEligibility(
  order: CommerceDocumentData,
  nowMs: number,
  force: boolean,
): DeliveryRecoveryEligibility {
  const recovery = parseDeliveryRecoveryState(order);
  const status = recovery.status ?? 'unknown';
  if (status === 'processing') {
    if (force) return { eligible: true };
    const lastAttemptAt = recovery.lastAttemptAtMs ?? 0;
    if (lastAttemptAt > 0 && nowMs - lastAttemptAt < DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS) {
      return { eligible: false, outcome: 'not_eligible', message: 'processing order retry backoff is active' };
    }
    return { eligible: true };
  }
  if (status === 'prepared') {
    if (force) return { eligible: true };
    const nextCheckAt = preparedDeliveryRecoveryNextCheckMs(order);
    if (nextCheckAt === null) {
      return { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' };
    }
    if (nextCheckAt > nowMs) {
      return { eligible: false, outcome: 'not_eligible', message: 'prepared order is not due for recovery yet' };
    }
    return { eligible: true };
  }
  if (status === 'prepared_abandoned') {
    return force
      ? { eligible: true }
      : { eligible: false, outcome: 'not_eligible', message: 'prepared order recovery checks are exhausted' };
  }
  return {
    eligible: false,
    outcome: 'skipped_status',
    message: `order status \`${status}\` is not recoverable`,
  };
}

export function orderResultBase(document: DeliveryOrderDocument): {
  dropId: string;
  deliveryId: number;
  statusBefore: string;
} | null {
  const identity = resolveDeliveryOrderIdentity(document.key.documentId, document.data, document.key.path);
  if (!('identity' in identity)) return null;
  if (resolveDeliveryOrderDropId(document.data, document.key.path) !== identity.identity.dropId) return null;
  return {
    dropId: identity.identity.dropId,
    deliveryId: identity.identity.deliveryId,
    statusBefore: parseDeliveryRecoveryState(document.data).status ?? 'unknown',
  };
}

export async function acquireDeliveryRecoveryLease(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  ownerWallet: string,
  nowMs: number,
  force: boolean,
): Promise<DeliveryRecoveryLeaseResult> {
  try {
    return await runCommerceTransaction<DeliveryRecoveryLeaseResult>(context, async (transaction) => {
      const document = await readDeliveryOrder(context, key, transaction);
      if (!document) {
        return {
          acquired: false,
          result: {
            dropId: key.dropId ?? '',
            deliveryId: Number(key.documentId) || 0,
            statusBefore: 'missing',
            outcome: 'not_found',
            verification: 'delivery_pda',
            message: 'delivery order not found',
          },
        };
      }
      const base = orderResultBase(document);
      if (!base) {
        return {
          acquired: false,
          result: {
            dropId: '',
            deliveryId: Number(document.key.documentId) || 0,
            statusBefore: parseDeliveryRecoveryState(document.data).status ?? 'unknown',
            outcome: 'failed',
            verification: 'delivery_pda',
            message: 'delivery order is missing recovery identifiers',
          },
        };
      }
      if (document.data.owner && document.data.owner !== ownerWallet) {
        return {
          acquired: false,
          result: {
            ...base,
            outcome: 'failed',
            verification: 'delivery_pda',
            message: 'order belongs to a different wallet',
            errorCode: 'permission-denied',
          },
        };
      }
      const eligibility = deliveryRecoveryEligibility(document.data, nowMs, force);
      if (!eligibility.eligible) {
        return {
          acquired: false,
          result: {
            ...base,
            outcome: eligibility.outcome,
            verification: 'delivery_pda',
            message: eligibility.message,
          },
        };
      }
      const recovery = parseDeliveryRecoveryState(document.data);
      if ((recovery.leaseExpiresAtMs ?? 0) > nowMs) {
        return {
          acquired: false,
          result: {
            ...base,
            outcome: 'lease_active',
            verification: 'delivery_pda',
            message: 'another client is already retrying this order',
          },
        };
      }
      const rawAttemptCount = Number(recovery.rawAttemptCount || 0);
      const attemptCount = Number.isFinite(rawAttemptCount) && rawAttemptCount > 0
        ? Math.floor(rawAttemptCount) + 1
        : 1;
      const leaseExpiresAtMs = nowMs + DELIVERY_RECOVERY_LEASE_MS;
      const updates = {
        'receiptRecovery.leaseExpiresAt': commerceTimestamp(leaseExpiresAtMs),
        'receiptRecovery.lastAttemptAt': commerceTimestamp(nowMs),
        'receiptRecovery.attemptCount': attemptCount,
      } satisfies DeliveryRecoveryPatch;
      await transaction.update(document.key, updates);
      return {
        acquired: true,
        lease: {
          attemptCount,
          lastAttemptAtMs: nowMs,
          leaseExpiresAtMs,
          previousAttemptCount: recovery.rawAttemptCount,
          previousLastAttemptAt: recovery.rawLastAttemptAt,
        },
      };
    });
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    throw mapProviderError(error, 'Delivery recovery data is temporarily unavailable.');
  }
}

export function cancelDeliveryRecoveryAttempt(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  lease: DeliveryRecoveryLease,
): Promise<void> {
  return runCommerceTransaction(context, async (transaction) => {
    const document = await readDeliveryOrder(context, key, transaction);
    if (!document) return;
    const recovery = parseDeliveryRecoveryState(document.data);
    if (
      recovery.leaseExpiresAtMs === null || recovery.leaseExpiresAtMs < lease.leaseExpiresAtMs ||
      recovery.lastAttemptAtMs !== lease.lastAttemptAtMs ||
      Number(recovery.rawAttemptCount) !== lease.attemptCount
    ) return;
    const updates = {
      'receiptRecovery.leaseExpiresAt': commerceFieldValue.delete(),
      'receiptRecovery.lastAttemptAt': lease.previousLastAttemptAt === undefined
        ? commerceFieldValue.delete()
        : lease.previousLastAttemptAt,
      'receiptRecovery.attemptCount': lease.previousAttemptCount === undefined
        ? commerceFieldValue.delete()
        : lease.previousAttemptCount,
    } satisfies DeliveryRecoveryPatch;
    await transaction.update(document.key, updates);
  });
}

export async function finalizeDeliveryRecoveryAttempt(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  result: { errorCode?: string; message?: string },
): Promise<void> {
  await runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    await transaction.getMany([key]);
    const updates = {
      'receiptRecovery.leaseExpiresAt': commerceFieldValue.delete(),
      'receiptRecovery.lastErrorCode': result.errorCode || commerceFieldValue.delete(),
      'receiptRecovery.lastErrorMessage': result.message || commerceFieldValue.delete(),
    } satisfies DeliveryRecoveryPatch;
    await transaction.update(key, updates);
  }, { shouldRetry: () => false });
}

export async function recordPreparedDeliveryRecoveryMiss(
  context: CommerceRepositoryContext,
  document: DeliveryOrderDocument,
  nowMs: number,
): Promise<number | null> {
  const probeCount = preparedDeliveryRecoveryCheckCount(parseDeliveryRecoveryState(document.data));
  const nextProbeCount = probeCount + 1;
  const nextDelayMs = nextPreparedDeliveryRecoveryDelayMs(nextProbeCount);
  const updates: DeliveryRecoveryPatch = {
    'receiptRecovery.preparedProbeCount': nextProbeCount,
    'receiptRecovery.lastPreparedProbeAt': commerceTimestamp(nowMs),
    ...(nextDelayMs === null
      ? {
          status: 'prepared_abandoned',
          preparedRecoveryAbandonedAt: commerceTimestamp(nowMs),
          'receiptRecovery.nextPreparedProbeAt': commerceFieldValue.delete(),
        }
      : {
          'receiptRecovery.nextPreparedProbeAt': commerceTimestamp(nowMs + nextDelayMs),
        }),
  };
  await runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    const [current] = await transaction.getMany([document.key]);
    if (current?.updateTime !== document.updateTime) throw new CommerceWriteConflict();
    await transaction.update(document.key, updates);
  }, { shouldRetry: () => false });
  return nextDelayMs === null ? null : nowMs + nextDelayMs;
}

async function stopPreparedDeliveryRecoveryChecks(
  context: CommerceRepositoryContext,
  document: DeliveryOrderDocument,
  nowMs: number,
): Promise<void> {
  const probeCount = Math.max(
    preparedDeliveryRecoveryCheckCount(parseDeliveryRecoveryState(document.data)),
    MAX_PREPARED_DELIVERY_RECOVERY_CHECKS,
  );
  await runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    const [current] = await transaction.getMany([document.key]);
    if (current?.updateTime !== document.updateTime) throw new CommerceWriteConflict();
    const updates = {
      status: 'prepared_abandoned',
      preparedRecoveryAbandonedAt: commerceTimestamp(nowMs),
      'receiptRecovery.preparedProbeCount': probeCount,
      'receiptRecovery.lastPreparedProbeAt': commerceTimestamp(nowMs),
      'receiptRecovery.nextPreparedProbeAt': commerceFieldValue.delete(),
    } satisfies DeliveryRecoveryPatch;
    await transaction.update(document.key, updates);
  }, { shouldRetry: () => false });
}

async function deferPreparedDeliveryRecovery(
  context: CommerceRepositoryContext,
  document: DeliveryOrderDocument,
  nowMs: number,
): Promise<void> {
  const recovery = parseDeliveryRecoveryState(document.data);
  const nextCheckAt = Math.max(
    nowMs + DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS,
    recovery.leaseExpiresAtMs ?? 0,
  );
  await runCommerceTransaction({ repository: context.repository, nowMs: context.nowMs }, async (transaction) => {
    const [current] = await transaction.getMany([document.key]);
    if (current?.updateTime !== document.updateTime) throw new CommerceWriteConflict();
    const updates = {
      'receiptRecovery.nextPreparedProbeAt': commerceTimestamp(nextCheckAt),
    } satisfies DeliveryRecoveryPatch;
    await transaction.update(document.key, updates);
  }, { shouldRetry: () => false });
}

export async function fetchDeliveryRecoveryState(
  context: CommerceRepositoryContext,
  ownerWallet: string,
  nowMs: number,
): Promise<WalletDeliveryRecoveryState> {
  const documents = await runDeliveryRecoveryOrderQuery(context, ownerWallet);
  const processing = documents.filter((document) => document.data.status === 'processing');
  const prepared = documents.filter((document) => document.data.status === 'prepared');
  return buildWalletDeliveryRecoveryState({
    remainingProcessing: processing.length,
    nextCheckCandidates: [
      ...processing.map((document) => processingDeliveryRecoveryNextCheckMs(document.data, nowMs)),
      ...prepared.map((document) => preparedDeliveryRecoveryNextCheckMs(document.data)),
    ],
  });
}

function isRetryableRecoveryErrorCode(errorCode: string | undefined): boolean {
  return errorCode === 'aborted' ||
    errorCode === 'deadline-exceeded' ||
    errorCode === 'internal' ||
    errorCode === 'resource-exhausted' ||
    errorCode === 'unavailable';
}

export async function handlePreparedRecoveryFailure(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  outcome: DeliveryRecoveryOutcome,
  errorCode: string | undefined,
  nowMs = Date.now(),
): Promise<void> {
  const current = await readDeliveryOrder(context, key);
  if (current?.data.status !== 'prepared') return;
  if (outcome === 'missing_delivery') {
    await recordPreparedDeliveryRecoveryMiss(context, current, nowMs);
  } else if (isRetryableRecoveryErrorCode(errorCode)) {
    await deferPreparedDeliveryRecovery(context, current, nowMs);
  } else {
    await stopPreparedDeliveryRecoveryChecks(context, current, nowMs);
  }
}
