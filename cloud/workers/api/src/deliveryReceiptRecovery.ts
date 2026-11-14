import { parseDeliveryOrderOwnership, parseDeliveryRecoveryState } from './deliveryOrderReadModel.js';
import { runtimeForDrop, type ProviderContext } from './deliveryReceiptOnchain.js';
import { DeliveryReceiptError, summarizeDeliveryReceiptError as summarizeError } from './deliveryReceiptErrors.js';
import { dropDeliveryOrderPath } from './dropPaths.js';
import type {
  RecoverDeliveryOrdersItemResult,
  RecoverDeliveryOrdersResult,
} from '../../../../shared/contracts.js';
import { resolveRequestWallet, type RequestIdentity } from './requestIdentity.js';
import { isSignalCancellationError } from './boundedRequest.js';
import { secureRandomInt } from './deliveryRandom.js';
import { ReadyToShipNotificationEnqueueError } from './readyToShipNotificationOutbox.js';
import { rethrowDeferredWorkRegistrationError, type DeferredWork } from './deferredWork.js';
import { buildRecoverDeliveryOrdersResult } from '../../../../shared/deliveryRecovery.js';
import {
  DELIVERY_RECOVERY_PAGE_SIZE,
  decodeDeliveryRecoveryCursor,
} from '../../../../shared/deliveryRecoveryPagination.js';
import {
  deliveryOrderKey,
  readDeliveryRecovery,
  type DeliveryOrderDocument,
  type RecoverySnapshot,
} from './deliveryOrderStore.js';
import {
  MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL,
  acquireDeliveryRecoveryLease,
  deliveryRecoveryEligibility,
  fetchDeliveryRecoveryState,
  orderResultBase,
  recordPreparedDeliveryRecoveryMiss,
  runDeliveryRecoveryPageQuery,
} from './deliveryRecoveryStore.js';
import { deliveryRecoveryFailure, runLeasedReceiptRecoveryAttempt } from './deliveryRecoveryAttempt.js';
import {
  type RecoverRequest,
  type DeliveryReceiptsEnv,
  type CommerceContext,
  loadBoundWallet,
} from './deliveryReceiptRequest.js';
import { hasConfirmedDeliveryRecord } from './deliveryReceiptVerification.js';
import { retryIssueReceipts } from './deliveryReceiptIssuance.js';

function isDeliveryRecoveryCancellation(error: unknown, signal: AbortSignal): boolean {
  return isSignalCancellationError(signal, error);
}

export function validateRecoveryRequestMode(body: RecoverRequest): void {
  if (body.deliveryId !== undefined) {
    if (body.dropId === undefined || body.cursor !== undefined) {
      throw new DeliveryReceiptError('invalid-argument', 'Targeted delivery recovery requires dropId and does not accept a cursor.');
    }
    return;
  }
  if (body.cursor === undefined) {
    throw new DeliveryReceiptError('failed-precondition', 'Refresh the page to continue delivery recovery.');
  }
}

export async function recoverReceiptsRequest(
  body: RecoverRequest,
  identity: RequestIdentity,
  env: DeliveryReceiptsEnv,
  commerce: CommerceContext,
  provider: ProviderContext,
  waitUntil: DeferredWork,
  overrides: Partial<{
    hasConfirmedDeliveryRecord: typeof hasConfirmedDeliveryRecord;
    recordPreparedDeliveryRecoveryMiss: typeof recordPreparedDeliveryRecoveryMiss;
    retryIssueReceipts: typeof retryIssueReceipts;
  }> = {},
): Promise<RecoverDeliveryOrdersResult> {
  const recoveryDependencies = {
    hasConfirmedDeliveryRecord,
    recordPreparedDeliveryRecoveryMiss,
    retryIssueReceipts,
    ...overrides,
  };
  const wallet = await resolveRequestWallet(identity, (uid) => loadBoundWallet(commerce, env.OPS_DB, uid));
  validateRecoveryRequestMode(body);
  const filterDropId = body.dropId ? runtimeForDrop(body.dropId).dropId : undefined;
  const force = body.force === true;
  const paginated = body.cursor !== undefined;
  const cursor = typeof body.cursor === 'string' ? decodeDeliveryRecoveryCursor(body.cursor) : null;
  if (paginated && (body.deliveryId !== undefined || (body.cursor !== null && (!cursor ||
    cursor.owner !== wallet || cursor.dropId !== (filterDropId ?? null) || cursor.force !== force)))) {
    throw new DeliveryReceiptError('invalid-argument', 'Invalid delivery recovery cursor.');
  }
  const nowMs = Date.now();
  const results: RecoverDeliveryOrdersItemResult[] = [];
  let attempted = 0;
  let recovered = 0;
  let externalWorkCandidates = 0;
  let visitedCandidates = 0;
  let lastVisitedCursor = body.cursor ?? null;
  let page: Awaited<ReturnType<typeof runDeliveryRecoveryPageQuery>> | undefined;
  let candidates: DeliveryOrderDocument[] = [];
  let targetedSnapshot: RecoverySnapshot | null = null;
  if (paginated) {
    page = await runDeliveryRecoveryPageQuery(commerce, wallet, filterDropId, force, cursor);
    candidates = page.map((candidate) => candidate.document);
  } else if (filterDropId && body.deliveryId !== undefined) {
    targetedSnapshot = await readDeliveryRecovery(commerce, deliveryOrderKey(dropDeliveryOrderPath(filterDropId, body.deliveryId)));
    if (targetedSnapshot) candidates = [targetedSnapshot.order];
    else {
      results.push({
        dropId: filterDropId,
        deliveryId: body.deliveryId,
        statusBefore: 'missing',
        outcome: 'not_found',
        verification: 'delivery_pda',
        message: 'delivery order not found',
      });
    }
  }
  for (const [index, document] of candidates.entries()) {
    if (commerce.signal.aborted) throw commerce.signal.reason;
    if (paginated && index >= DELIVERY_RECOVERY_PAGE_SIZE) break;
    const snapshot = page?.[index].snapshot ?? targetedSnapshot;
    if (!snapshot) throw new DeliveryReceiptError('internal', 'Delivery recovery snapshot is missing.');
    const base = orderResultBase(document);
    const ownership = parseDeliveryOrderOwnership(document.data);
    let preflightResult: RecoverDeliveryOrdersItemResult | undefined;
    if (paginated && base && base.statusBefore !== 'ready_to_ship') {
      const eligibility = deliveryRecoveryEligibility(document.data, nowMs, force);
      const recovery = parseDeliveryRecoveryState(document.data);
      if (!eligibility.eligible) {
        preflightResult = {
          ...base, verification: 'delivery_pda', outcome: eligibility.outcome, message: eligibility.message,
        };
      } else if ((recovery.leaseExpiresAtMs ?? 0) > nowMs) {
        preflightResult = {
          ...base, verification: 'delivery_pda', outcome: 'lease_active',
          message: 'another client is already retrying this order',
        };
      }
    }
    const needsExternalWork = base && (!ownership.hasOwner || ownership.owner === wallet) && !preflightResult;
    if (paginated && needsExternalWork && externalWorkCandidates >= MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL) break;
    if (page) {
      visitedCandidates += 1;
      lastVisitedCursor = page[index].cursor;
      if (needsExternalWork) externalWorkCandidates += 1;
    }
    if (!base) continue;
    if (ownership.hasOwner && ownership.owner !== wallet) {
      results.push({
        ...base,
        outcome: 'failed',
        verification: 'delivery_pda',
        errorCode: 'permission-denied',
        message: 'order belongs to a different wallet',
      });
      continue;
    }
    if (preflightResult) {
      results.push(preflightResult);
      continue;
    }
    if (base.statusBefore === 'ready_to_ship') {
      const result = await recoveryDependencies.retryIssueReceipts({
        request: {
          ownerWallet: wallet,
          deliveryId: base.deliveryId,
          dropId: base.dropId,
          verification: 'delivery_pda',
        },
        env,
        commerce,
        provider,
        waitUntil,
        randomInt: secureRandomInt,
        access: { kind: 'ready' },
      });
      results.push({
        ...base,
        outcome: 'recovered',
        verification: 'delivery_pda',
        message: result.processed ? 'ready-order notifications resumed' : 'order already processed',
      });
      recovered += 1;
      continue;
    }
    const runtime = runtimeForDrop(base.dropId);
    if (base.statusBefore === 'prepared' && !force) {
      let exists: boolean | null = null;
      try {
        exists = await recoveryDependencies.hasConfirmedDeliveryRecord(
          provider,
          runtime,
          base.deliveryId,
          document.data,
        );
      } catch (error) {
        if (isDeliveryRecoveryCancellation(error, commerce.signal)) throw commerce.signal.reason;
        console.warn({
          event: 'delivery_receipt_recovery_eligibility_failed',
          dropId: base.dropId,
          deliveryId: base.deliveryId,
          error: summarizeError(error),
        });
      }
      if (commerce.signal.aborted) throw commerce.signal.reason;
      if (exists === false) {
        const nextCheckAt = await recoveryDependencies.recordPreparedDeliveryRecoveryMiss(
          commerce,
          snapshot,
          nowMs,
        ).catch((error) => {
          if (isDeliveryRecoveryCancellation(error, commerce.signal)) throw commerce.signal.reason;
          console.warn({
            event: 'delivery_receipt_recovery_probe_failed',
            dropId: base.dropId,
            deliveryId: base.deliveryId,
            error: summarizeError(error),
          });
          return null;
        });
        results.push({
          ...base,
          outcome: 'not_eligible',
          verification: 'delivery_pda',
          message: nextCheckAt === null
            ? 'prepared order never produced a confirmed on-chain delivery record'
            : 'prepared order has no confirmed on-chain delivery record yet',
        });
        continue;
      }
    }
    if (attempted >= MAX_DELIVERY_RECOVERY_ORDERS_PER_CALL) {
      results.push({
        ...base,
        outcome: 'attempt_capped',
        verification: 'delivery_pda',
        message: 'recovery attempt cap reached for this pass',
      });
      continue;
    }
    const lease = await acquireDeliveryRecoveryLease(commerce, document.key, wallet, nowMs, force);
    if (!lease.acquired) {
      results.push(lease.result);
      continue;
    }
    attempted += 1;
    try {
      const result = await runLeasedReceiptRecoveryAttempt({
        context: commerce, key: document.key, lease: lease.lease,
        origin: { kind: 'recovery', statusBefore: base.statusBefore },
        operation: () => recoveryDependencies.retryIssueReceipts({
          request: {
            ownerWallet: wallet, deliveryId: base.deliveryId, dropId: base.dropId, verification: 'delivery_pda',
          },
          env, commerce, provider, waitUntil, randomInt: secureRandomInt,
          access: { kind: 'leased', lease: lease.lease },
        }),
      });
      recovered += 1;
      results.push({
        ...base, outcome: 'recovered', verification: 'delivery_pda',
        message: result.processed ? 'receipts issued' : 'order already processed',
      });
    } catch (error) {
      rethrowDeferredWorkRegistrationError(error);
      if (isDeliveryRecoveryCancellation(error, commerce.signal)) throw commerce.signal.reason;
      const { errorCode, message, outcome } = deliveryRecoveryFailure(error);
      if (error instanceof ReadyToShipNotificationEnqueueError) throw error;
      results.push({
        ...base,
        outcome,
        verification: 'delivery_pda',
        ...(errorCode ? { errorCode } : {}),
        ...(message ? { message } : {}),
      });
      console.warn({
        event: 'delivery_receipt_recovery_failed',
        dropId: base.dropId,
        deliveryId: base.deliveryId,
        error: summarizeError(error),
      });
    }
  }
  if (commerce.signal.aborted) throw commerce.signal.reason;
  const walletRecovery = await fetchDeliveryRecoveryState(commerce, wallet, Date.now());
  return {
    ...buildRecoverDeliveryOrdersResult({ attempted, recovered, walletRecovery, results }),
    ...(page ? { nextCursor: visitedCandidates < page.length ? lastVisitedCursor : null } : {}),
  };
}
