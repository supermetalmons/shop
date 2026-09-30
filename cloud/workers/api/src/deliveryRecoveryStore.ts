import type { DeliveryRecoveryPatch } from './deliveryOrderUpdates.js';
import {
  DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS,
  DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS,
  nextPreparedDeliveryRecoveryDelayMs,
} from '../../../../shared/deliveryRecovery.js';
import {
  updateDeliveryRecoveryRecord,
  type DeliveryRecoveryRecord,
} from '../../../../shared/deliveryRecoveryState.js';
import type {
  DeliveryRecoveryOutcome,
  RecoverDeliveryOrdersItemResult,
  WalletDeliveryRecoveryState,
} from '../../../../shared/contracts.js';
import {
  CommerceWriteConflict,
  commerceFieldValue,
  type CommerceDocumentData,
  type CommerceJsonValue,
  type CommerceUnitOfWork,
} from './commerceRepository.js';
import { materializeUpdate } from './commerceDocumentCodec.js';
import {
  commerceTimestamp,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import {
  updateDeliveryOrder,
  readDeliveryRecovery,
  type DeliveryOrderDocument,
  type DeliveryOrderKey,
  type RecoverySnapshot,
} from './deliveryOrderStore.js';
import {
  parseDeliveryRecoveryState,
  parseDeliveryOrderOwnership,
  type DeliveryRecoveryState,
} from './deliveryOrderReadModel.js';
import {
  resolveDeliveryOrderDropId,
  resolveDeliveryOrderIdentity,
} from './deliveryOrderSummaries.js';
import { DeliveryReceiptError, mapProviderError } from './deliveryReceiptErrors.js';
import { isSignalCancellationError } from './boundedRequest.js';
import { isRecord } from './dataAccess.js';
import {
  DELIVERY_RECOVERY_PAGE_SIZE,
  DELIVERY_RECOVERY_PHASES,
  encodeDeliveryRecoveryCursor,
  type DeliveryRecoveryCursor,
} from '../../../../shared/deliveryRecoveryPagination.js';

const DELIVERY_RECOVERY_LEASE_MS = 90_000;
const MAX_PREPARED_DELIVERY_RECOVERY_CHECKS = DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS.length;
export const MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL = 2;

export type DeliveryRecoveryLease = {
  parentPath: string;
  generation: string;
  leaseId: string;
  attemptCount: number;
  lastAttemptAtMs: number;
  leaseExpiresAtMs: number;
  previousAttemptCount: CommerceJsonValue | undefined;
  previousLastAttemptAt: CommerceJsonValue | undefined;
  previousAttemptCountJson: string | undefined;
  previousLastAttemptAtJson: string | undefined;
};

export type DeliveryRecoveryLeaseResult =
  | { acquired: true; lease: DeliveryRecoveryLease }
  | { acquired: false; result: RecoverDeliveryOrdersItemResult };

type DeliveryRecoveryEligibility =
  | { eligible: true }
  | { eligible: false; outcome: DeliveryRecoveryOutcome; message: string };

type RecoveryJsonField = { name: string; property: string; value: string };

function recoveryJsonFields(raw: string | null): RecoveryJsonField[] {
  if (raw === null || !isRecord(JSON.parse(raw))) return [];
  const fields: RecoveryJsonField[] = [];
  let offset = raw.indexOf('{') + 1;
  while (offset < raw.length) {
    while (/\s/.test(raw[offset])) offset += 1;
    if (raw[offset] === '}') break;
    const propertyStart = offset;
    offset += 1;
    while (raw[offset] !== '"') offset += raw[offset] === '\\' ? 2 : 1;
    offset += 1;
    const name: string = JSON.parse(raw.slice(propertyStart, offset));
    while (/\s/.test(raw[offset])) offset += 1;
    offset += 1;
    while (/\s/.test(raw[offset])) offset += 1;
    const valueStart = offset;
    let depth = 0;
    let inString = false;
    for (; offset < raw.length; offset += 1) {
      const character = raw[offset];
      if (inString) {
        if (character === '\\') offset += 1;
        else if (character === '"') inString = false;
      } else if (character === '"') {
        inString = true;
      } else if (character === '{' || character === '[') {
        depth += 1;
      } else if (character === '}' || character === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === ',' && depth === 0) {
        break;
      }
    }
    fields.push({ name, property: raw.slice(propertyStart, offset), value: raw.slice(valueStart, offset).trimEnd() });
    if (raw[offset] === '}') break;
    offset += 1;
  }
  return fields;
}

function patchRecoveryJson(
  raw: string | null,
  updates: DeliveryRecoveryPatch,
  nowMs: number,
  restored: Partial<Record<'attemptCount' | 'lastAttemptAt', string | undefined>> = {},
): string {
  const fields = recoveryJsonFields(raw);
  const values = new Map(fields.map((field) => [field.name, field.value]));
  const replacements = new Map<string, string | undefined>();
  const now = commerceTimestamp(nowMs).value;
  for (const [field, update] of Object.entries(updates)) {
    if (update === undefined) continue;
    const current = values.get(field);
    const value = materializeUpdate(current === undefined ? undefined : JSON.parse(current), update, now);
    replacements.set(field, value === undefined ? undefined : JSON.stringify(value));
  }
  for (const [field, value] of Object.entries(restored)) {
    if (value !== undefined) JSON.parse(value);
    replacements.set(field, value);
  }
  const properties: string[] = [];
  const replaced = new Set<string>();
  for (const field of fields) {
    if (!replacements.has(field.name)) {
      properties.push(field.property);
      continue;
    }
    if (replaced.has(field.name)) continue;
    replaced.add(field.name);
    const value = replacements.get(field.name);
    if (value !== undefined) properties.push(`${JSON.stringify(field.name)}:${value}`);
  }
  for (const [field, value] of replacements) {
    if (!replaced.has(field) && value !== undefined) properties.push(`${JSON.stringify(field)}:${value}`);
  }
  return `{${properties.join(',')}}`;
}

export function patchDeliveryRecoveryRecord(
  record: DeliveryRecoveryRecord,
  updates: DeliveryRecoveryPatch,
  nowMs: number,
  leaseId = record.leaseId,
): DeliveryRecoveryRecord {
  return updateDeliveryRecoveryRecord(record, {
    receiptRecoveryJson: patchRecoveryJson(record.receiptRecoveryJson, updates, nowMs), leaseId,
  }, nowMs);
}

function recoverySnapshotWithState(snapshot: RecoverySnapshot, state: DeliveryRecoveryRecord): RecoverySnapshot {
  const data = { ...snapshot.order.data };
  if (state.receiptRecoveryJson === null) delete data.receiptRecovery;
  else data.receiptRecovery = JSON.parse(state.receiptRecoveryJson) as CommerceJsonValue;
  return { ...snapshot, state, order: { ...snapshot.order, data } };
}

export function ownsDeliveryRecoveryLease(snapshot: RecoverySnapshot, lease: DeliveryRecoveryLease): boolean {
  return snapshot.order.key.path === lease.parentPath && snapshot.state.generation === lease.generation &&
    snapshot.state.leaseId === lease.leaseId;
}

export function requireDeliveryRecoveryLease(snapshot: RecoverySnapshot, lease: DeliveryRecoveryLease): void {
  if (!ownsDeliveryRecoveryLease(snapshot, lease)) {
    throw new DeliveryReceiptError('aborted', 'Delivery receipt recovery attempt changed. Retry later.');
  }
}

export function requireSameDeliveryRecoverySnapshot(current: RecoverySnapshot, expected: RecoverySnapshot): void {
  if (current.order.key.path !== expected.order.key.path || current.order.version !== expected.order.version ||
    current.order.updateTime !== expected.order.updateTime || current.pathRevision !== expected.pathRevision ||
    current.state.generation !== expected.state.generation || current.state.revision !== expected.state.revision) {
    throw new CommerceWriteConflict();
  }
}

function hasUnsettledReceiptSubmission(snapshot: RecoverySnapshot): boolean {
  const recovery = snapshot.order.data.receiptRecovery;
  return isRecord(recovery) && recovery.pendingSubmission !== undefined && recovery.pendingSubmission !== null;
}

function preparedDeliveryRecoveryCheckCount(state: DeliveryRecoveryState): number {
  const raw = Number(state.rawPreparedProbeCount || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export async function runDeliveryRecoveryPageQuery(
  context: CommerceRepositoryContext,
  owner: string,
  dropId: string | undefined,
  force: boolean,
  cursor: DeliveryRecoveryCursor | null,
): Promise<Array<{ snapshot: RecoverySnapshot; document: DeliveryOrderDocument; cursor: string }>> {
  const candidates: Array<{ snapshot: RecoverySnapshot; document: DeliveryOrderDocument; cursor: string }> = [];
  const firstPhase = cursor ? DELIVERY_RECOVERY_PHASES.indexOf(cursor.phase) : 0;
  for (let index = firstPhase; index < DELIVERY_RECOVERY_PHASES.length; index += 1) {
    context.signal.throwIfAborted();
    const phase = DELIVERY_RECOVERY_PHASES[index];
    const limit = DELIVERY_RECOVERY_PAGE_SIZE + 1 - candidates.length;
    const snapshots = await context.repository.queryDeliveryRecoveryPage({
      owner,
      dropId,
      phase,
      ...(index === firstPhase && cursor ? { startAfterPath: cursor.path } : {}),
      limit,
    });
    for (const snapshot of snapshots) {
      candidates.push({
        snapshot,
        document: snapshot.order,
        cursor: encodeDeliveryRecoveryCursor({
          version: 1, owner, dropId: dropId ?? null, force, phase, path: snapshot.order.key.path,
        }),
      });
    }
    if (snapshots.length === limit) break;
  }
  return candidates;
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
    const nextCheckAt = recovery.preparedNextCheckAt(nowMs);
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

function stageRecoveryLease(
  transaction: CommerceUnitOfWork,
  snapshot: RecoverySnapshot,
  nowMs: number,
): { lease: DeliveryRecoveryLease; snapshot: RecoverySnapshot } {
  const recovery = parseDeliveryRecoveryState(snapshot.order.data);
  const previousFields = new Map(recoveryJsonFields(snapshot.state.receiptRecoveryJson).map((field) => [field.name, field.value]));
  const rawAttemptCount = Number(recovery.rawAttemptCount || 0);
  const attemptCount = Number.isFinite(rawAttemptCount) && rawAttemptCount > 0
    ? Math.floor(rawAttemptCount) + 1 : 1;
  const leaseExpiresAtMs = nowMs + DELIVERY_RECOVERY_LEASE_MS;
  const leaseId = crypto.randomUUID();
  const state = patchDeliveryRecoveryRecord(snapshot.state, {
    leaseExpiresAt: commerceTimestamp(leaseExpiresAtMs),
    lastAttemptAt: commerceTimestamp(nowMs),
    attemptCount,
  }, nowMs, leaseId);
  transaction.stageRecovery(state);
  return {
    snapshot: recoverySnapshotWithState(snapshot, state),
    lease: {
      parentPath: snapshot.order.key.path,
      generation: state.generation,
      leaseId,
      attemptCount,
      lastAttemptAtMs: nowMs,
      leaseExpiresAtMs,
      previousAttemptCount: recovery.rawAttemptCount,
      previousLastAttemptAt: recovery.rawLastAttemptAt,
      previousAttemptCountJson: previousFields.get('attemptCount'),
      previousLastAttemptAtJson: previousFields.get('lastAttemptAt'),
    },
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
      const snapshot = await readDeliveryRecovery(context, key, transaction);
      if (!snapshot) {
        return { acquired: false, result: {
          dropId: key.dropId ?? '', deliveryId: Number(key.documentId) || 0, statusBefore: 'missing',
          outcome: 'not_found', verification: 'delivery_pda', message: 'delivery order not found',
        } };
      }
      const document = snapshot.order;
      const base = orderResultBase(document);
      if (!base) {
        return { acquired: false, result: {
          dropId: '', deliveryId: Number(document.key.documentId) || 0,
          statusBefore: parseDeliveryRecoveryState(document.data).status ?? 'unknown', outcome: 'failed',
          verification: 'delivery_pda', message: 'delivery order is missing recovery identifiers',
        } };
      }
      const ownership = parseDeliveryOrderOwnership(document.data);
      if (ownership.hasOwner && ownership.owner !== ownerWallet) {
        return { acquired: false, result: {
          ...base, outcome: 'failed', verification: 'delivery_pda',
          message: 'order belongs to a different wallet', errorCode: 'permission-denied',
        } };
      }
      const eligibility = deliveryRecoveryEligibility(document.data, nowMs, force);
      if (!eligibility.eligible) {
        return { acquired: false, result: {
          ...base, outcome: eligibility.outcome, verification: 'delivery_pda', message: eligibility.message,
        } };
      }
      if ((parseDeliveryRecoveryState(document.data).leaseExpiresAtMs ?? 0) > nowMs) {
        return { acquired: false, result: {
          ...base, outcome: 'lease_active', verification: 'delivery_pda',
          message: 'another client is already retrying this order',
        } };
      }
      return { acquired: true, lease: stageRecoveryLease(transaction, snapshot, nowMs).lease };
    });
  } catch (error) {
    if (isSignalCancellationError(context.signal, error)) throw context.signal.reason;
    throw mapProviderError(error, 'Delivery recovery data is temporarily unavailable.');
  }
}

export async function acquireVerifiedReceiptIssuanceLease(
  context: CommerceRepositoryContext,
  verifiedSnapshot: RecoverySnapshot,
  ownerWallet: string,
  nowMs: number,
): Promise<{ lease: DeliveryRecoveryLease; snapshot: RecoverySnapshot }> {
  try {
    return await runCommerceTransaction(context, async (transaction) => {
      const current = await readDeliveryRecovery(context, verifiedSnapshot.order.key, transaction);
      if (!current) throw new CommerceWriteConflict();
      requireSameDeliveryRecoverySnapshot(current, verifiedSnapshot);
      const ownership = parseDeliveryOrderOwnership(current.order.data);
      if (ownership.hasOwner && ownership.owner !== ownerWallet) {
        throw new DeliveryReceiptError('permission-denied', 'Order belongs to a different wallet.');
      }
      if (!orderResultBase(current.order)) {
        throw new DeliveryReceiptError('failed-precondition', 'Delivery order is missing recovery identifiers.');
      }
      if ((parseDeliveryRecoveryState(current.order.data).leaseExpiresAtMs ?? 0) > nowMs) {
        throw new DeliveryReceiptError('aborted', 'Another client is already retrying this order.');
      }
      return stageRecoveryLease(transaction, current, nowMs);
    }, { shouldRetry: () => false });
  } catch (error) {
    if (error instanceof CommerceWriteConflict) {
      throw new DeliveryReceiptError('aborted', 'Delivery order changed during verification. Retry later.');
    }
    throw error;
  }
}

export function cancelDeliveryRecoveryAttempt(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  lease: DeliveryRecoveryLease,
): Promise<void> {
  return runCommerceTransaction(context, async (transaction) => {
    const snapshot = await readDeliveryRecovery(context, key, transaction);
    if (!snapshot || !ownsDeliveryRecoveryLease(snapshot, lease) || hasUnsettledReceiptSubmission(snapshot) ||
      parseDeliveryRecoveryState(snapshot.order.data).leaseExpiresAtMs === null) return;
    transaction.stageRecovery(updateDeliveryRecoveryRecord(snapshot.state, {
      receiptRecoveryJson: patchRecoveryJson(snapshot.state.receiptRecoveryJson, {
        leaseExpiresAt: commerceFieldValue.delete(),
      }, context.nowMs, {
        lastAttemptAt: lease.previousLastAttemptAtJson,
        attemptCount: lease.previousAttemptCountJson,
      }),
      leaseId: null,
    }, context.nowMs));
  });
}

export async function finalizeDeliveryRecoveryAttempt(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  lease: DeliveryRecoveryLease,
  result: { errorCode?: string; message?: string },
): Promise<void> {
  await runCommerceTransaction(context, async (transaction) => {
    const snapshot = await readDeliveryRecovery(context, key, transaction);
    if (!snapshot || !ownsDeliveryRecoveryLease(snapshot, lease) || hasUnsettledReceiptSubmission(snapshot)) return;
    transaction.stageRecovery(patchDeliveryRecoveryRecord(snapshot.state, {
      leaseExpiresAt: commerceFieldValue.delete(),
      lastErrorCode: result.errorCode || commerceFieldValue.delete(),
      lastErrorMessage: result.message || commerceFieldValue.delete(),
    }, context.nowMs, null));
  }, { shouldRetry: () => false });
}

export async function recordPreparedDeliveryRecoveryMiss(
  context: CommerceRepositoryContext,
  snapshot: RecoverySnapshot,
  nowMs: number,
): Promise<number | null> {
  const probeCount = preparedDeliveryRecoveryCheckCount(parseDeliveryRecoveryState(snapshot.order.data));
  const nextProbeCount = probeCount + 1;
  const nextDelayMs = nextPreparedDeliveryRecoveryDelayMs(nextProbeCount);
  await runCommerceTransaction(context, async (transaction) => {
    const current = await readDeliveryRecovery(context, snapshot.order.key, transaction);
    if (!current) throw new CommerceWriteConflict();
    requireSameDeliveryRecoverySnapshot(current, snapshot);
    transaction.stageRecovery(patchDeliveryRecoveryRecord(current.state, {
      preparedProbeCount: nextProbeCount,
      lastPreparedProbeAt: commerceTimestamp(nowMs),
      nextPreparedProbeAt: nextDelayMs === null ? commerceFieldValue.delete() : commerceTimestamp(nowMs + nextDelayMs),
    }, context.nowMs));
    if (nextDelayMs === null) {
      await updateDeliveryOrder(transaction, current.order.key, {
        status: 'prepared_abandoned', preparedRecoveryAbandonedAt: commerceTimestamp(nowMs),
      });
    }
  }, { shouldRetry: () => false });
  return nextDelayMs === null ? null : nowMs + nextDelayMs;
}

export async function fetchDeliveryRecoveryState(
  context: CommerceRepositoryContext,
  ownerWallet: string,
  nowMs: number,
): Promise<WalletDeliveryRecoveryState> {
  return context.repository.queryDeliveryRecoveryState({ owner: ownerWallet, nowMs });
}

function isRetryableRecoveryErrorCode(errorCode: string | undefined): boolean {
  return errorCode === 'aborted' || errorCode === 'deadline-exceeded' || errorCode === 'internal' ||
    errorCode === 'resource-exhausted' || errorCode === 'unavailable';
}

export async function handlePreparedRecoveryFailure(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  lease: DeliveryRecoveryLease,
  outcome: DeliveryRecoveryOutcome,
  errorCode: string | undefined,
  nowMs = Date.now(),
): Promise<void> {
  const snapshot = await readDeliveryRecovery(context, key);
  if (!snapshot || !ownsDeliveryRecoveryLease(snapshot, lease) || snapshot.order.data.status !== 'prepared') return;
  if (outcome === 'missing_delivery') {
    await recordPreparedDeliveryRecoveryMiss(context, snapshot, nowMs);
    return;
  }
  const recovery = parseDeliveryRecoveryState(snapshot.order.data);
  await runCommerceTransaction(context, async (transaction) => {
    const current = await readDeliveryRecovery(context, key, transaction);
    if (!current) throw new CommerceWriteConflict();
    requireSameDeliveryRecoverySnapshot(current, snapshot);
    if (isRetryableRecoveryErrorCode(errorCode)) {
      transaction.stageRecovery(patchDeliveryRecoveryRecord(current.state, {
        nextPreparedProbeAt: commerceTimestamp(Math.max(nowMs + DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS, recovery.leaseExpiresAtMs ?? 0)),
      }, context.nowMs));
    } else {
      transaction.stageRecovery(patchDeliveryRecoveryRecord(current.state, {
        preparedProbeCount: Math.max(preparedDeliveryRecoveryCheckCount(recovery), MAX_PREPARED_DELIVERY_RECOVERY_CHECKS),
        lastPreparedProbeAt: commerceTimestamp(nowMs),
        nextPreparedProbeAt: commerceFieldValue.delete(),
      }, context.nowMs));
      await updateDeliveryOrder(transaction, key, { status: 'prepared_abandoned', preparedRecoveryAbandonedAt: commerceTimestamp(nowMs) });
    }
  }, { shouldRetry: () => false });
}
