import { API_DROPS } from './dropConfig.js';
import { runtimeForDrop, type DeliveryRuntime } from './deliveryReceiptOnchain.js';
import { DeliveryReceiptError, summarizeDeliveryReceiptError as summarizeError } from './deliveryReceiptErrors.js';
import { resolveDeliveryOrderIdentity } from './deliveryOrderSummaries.js';
import {
  PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD,
  PACK_STATUS_PROJECTION_PENDING,
  PACK_STATUS_PROJECTION_STATE_FIELD,
} from '../../../../shared/deliveryPackStatusProjectionReconciliation.js';
import {
  isAdminIrlRedeemDeliveryOrderSource,
  isStripeOffchainDeliveryOrderSource,
} from '../../../../shared/fulfillmentSources.js';
import {
  countDeliveryOrderBoxItems,
  countDeliveryOrderDudeItems,
  packStatusCardsPerPack,
  shouldTrackPackStatusForDrop,
  type PackStatusEvent,
} from '../../../../shared/packStatus.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { raceWithSignal } from './boundedRequest.js';
import { isRecord } from './dataAccess.js';
import {
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentRecord,
  type CommerceDocumentWriteData,
} from './commerceRepository.js';
import {
  readCommerceRecord,
  requireCommerceKey,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import { applyPackStatusProjection } from './packStatusProjection.js';
import { registerDeferredWork, type DeferredWork } from './deferredWork.js';

const CLEANUP_TIMEOUT_MS = 5_000;
const PACK_STATUS_TIMEOUT_MS = 10_000;
const PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE = 4;
const PACK_STATUS_PROJECTION_RECONCILIATION_CONCURRENCY = 2;
const PACK_STATUS_PROJECTION_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;
const PACK_STATUS_PROJECTION_COMPLETED = 'completed';
const PACK_STATUS_PROJECTION_FAILED = 'failed';
const PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD = 'packStatusProjectionFailureCount';
const PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD = 'packStatusProjectionCompletedAt';
const PACK_STATUS_PROJECTION_FAILED_AT_FIELD = 'packStatusProjectionFailedAt';
const PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD = 'packStatusProjectionLastErrorCode';

class DeliveryPackStatusProjectionInvalidError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DeliveryPackStatusProjectionInvalidError';
  }
}

type DeliveryPackStatusContext = CommerceRepositoryContext & {
  dataDb?: D1Database;
};

function cleanupContext(context: DeliveryPackStatusContext): DeliveryPackStatusContext {
  return {
    ...context,
    nowMs: Date.now(),
    signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
  };
}

function shouldProjectNormalIrlPackStatus(
  runtime: DeliveryRuntime,
  order: Record<string, unknown>,
): boolean {
  if (!shouldTrackPackStatusForDrop({
    dropId: runtime.dropId,
    cluster: runtime.cluster,
    itemsPerBox: runtime.itemsPerBox,
    maxSupply: runtime.maxSupply,
  })) return false;
  if (isStripeOffchainDeliveryOrderSource(order.source)) return false;
  if (
    isAdminIrlRedeemDeliveryOrderSource(order.source) &&
    isRecord(order.adminIrlRedeem) &&
    order.adminIrlRedeem.targetKind === 'card_receipt'
  ) return false;
  return true;
}

export function createDeliveryPackStatusProjectionOutbox(
  runtime: DeliveryRuntime,
  order: Record<string, unknown>,
  nowMs = Date.now(),
): CommerceDocumentWriteData {
  if (!shouldProjectNormalIrlPackStatus(runtime, order)) return {};
  if (countDeliveryOrderBoxItems(order.items) < 1 && countDeliveryOrderDudeItems(order.items) < 1) {
    return {};
  }
  const nextAttemptAtMs = Number.isSafeInteger(nowMs) && nowMs >= 0 ? nowMs : Date.now();
  return {
    [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_PENDING,
    [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: nextAttemptAtMs,
    [PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD]: 0,
    [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.delete(),
    [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.delete(),
    [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: commerceFieldValue.delete(),
  };
}

async function countNormalIrlPackStatus(
  context: DeliveryPackStatusContext,
  runtime: DeliveryRuntime,
  deliveryId: number,
  order: Record<string, unknown>,
): Promise<void> {
  if (!shouldProjectNormalIrlPackStatus(runtime, order)) return;
  const packQuantity = countDeliveryOrderBoxItems(order.items);
  const cardQuantity = countDeliveryOrderDudeItems(order.items);
  if (packQuantity < 1 && cardQuantity < 1) return;
  const event: PackStatusEvent = {
    dropId: runtime.dropId,
    type: 'redeemedIrlNormal',
    eventKey: String(deliveryId),
    quantity: packQuantity * packStatusCardsPerPack(runtime) + cardQuantity,
    increments: {
      ...(packQuantity ? { redeemedIrlNormal: packQuantity } : {}),
      ...(cardQuantity ? { redeemedUnsealedCards: cardQuantity } : {}),
    },
    deliveryId,
    createdAtMs: context.nowMs,
  };
  await applyPackStatusProjection({
    dataDb: context.dataDb,
    event,
    log: (entry) => console.warn(entry),
  });
}

function deliveryPackStatusProjectionFailureCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function deliveryPackStatusProjectionNextAttemptAtMs(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function deliveryPackStatusProjectionErrorCode(error: unknown): string {
  if (error instanceof DeliveryPackStatusProjectionInvalidError) return error.code;
  if (error instanceof DeliveryReceiptError) return error.code;
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'deadline-exceeded';
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  if (error instanceof Error && error.message === 'pack_status_data_db_not_configured') {
    return 'data-db-unavailable';
  }
  if (error instanceof Error && error.message === 'pack_status_d1_write_failed') return 'd1-write-failed';
  return 'internal';
}

async function transitionDeliveryPackStatusProjection(
  context: DeliveryPackStatusContext,
  documentPath: string,
  options: {
    values: CommerceDocumentWriteData;
    requiredState: string;
  },
): Promise<boolean> {
  return runCommerceTransaction(context, async (transaction) => {
    const document = await readCommerceRecord(context, requireCommerceKey(documentPath), transaction);
    if (!document || document.data[PACK_STATUS_PROJECTION_STATE_FIELD] !== options.requiredState) return false;
    await transaction.update(document.key, options.values);
    return true;
  });
}

async function markDeliveryPackStatusProjectionCompleted(
  context: DeliveryPackStatusContext,
  documentPath: string,
): Promise<boolean> {
  return transitionDeliveryPackStatusProjection(context, documentPath, {
    values: {
      [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_COMPLETED,
      [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
    },
    requiredState: PACK_STATUS_PROJECTION_PENDING,
  });
}

async function markDeliveryPackStatusProjectionFailed(
  context: DeliveryPackStatusContext,
  documentPath: string,
  errorCode: string,
): Promise<boolean> {
  return transitionDeliveryPackStatusProjection(context, documentPath, {
    values: {
      [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_FAILED,
      [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: errorCode,
      [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
    },
    requiredState: PACK_STATUS_PROJECTION_PENDING,
  });
}

async function clearDeliveryPackStatusProjection(
  context: DeliveryPackStatusContext,
  documentPath: string,
): Promise<boolean> {
  return transitionDeliveryPackStatusProjection(context, documentPath, {
    values: {
      [PACK_STATUS_PROJECTION_STATE_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: commerceFieldValue.delete(),
    },
    requiredState: PACK_STATUS_PROJECTION_PENDING,
  });
}

async function recordDeliveryPackStatusProjectionTransientFailure(args: {
  attemptStartedAtMs: number;
  context: DeliveryPackStatusContext;
  documentPath: string;
  errorCode: string;
}): Promise<boolean> {
  return runCommerceTransaction(args.context, async (transaction) => {
    const document = await readCommerceRecord(args.context, requireCommerceKey(args.documentPath), transaction);
    if (!document || document.data[PACK_STATUS_PROJECTION_STATE_FIELD] !== PACK_STATUS_PROJECTION_PENDING) {
      return false;
    }
    if (
      deliveryPackStatusProjectionNextAttemptAtMs(
        document.data[PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD],
      ) > args.attemptStartedAtMs
    ) return false;
    const failureCount = deliveryPackStatusProjectionFailureCount(
      document.data[PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD],
    );
    const backoffMs = PACK_STATUS_PROJECTION_BACKOFF_MS[
      Math.min(failureCount, PACK_STATUS_PROJECTION_BACKOFF_MS.length - 1)
    ];
    await transaction.update(document.key, {
      [PACK_STATUS_PROJECTION_STATE_FIELD]: PACK_STATUS_PROJECTION_PENDING,
      [PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD]: args.attemptStartedAtMs + backoffMs,
      [PACK_STATUS_PROJECTION_FAILURE_COUNT_FIELD]: Math.min(Number.MAX_SAFE_INTEGER, failureCount + 1),
      [PACK_STATUS_PROJECTION_LAST_ERROR_CODE_FIELD]: args.errorCode,
      [PACK_STATUS_PROJECTION_COMPLETED_AT_FIELD]: commerceFieldValue.delete(),
      [PACK_STATUS_PROJECTION_FAILED_AT_FIELD]: commerceFieldValue.delete(),
    });
    return true;
  });
}

type DeliveryPackStatusProjectionOutcome = 'completed' | 'failed' | 'not-due' | 'not-needed' | 'pending';

export async function projectPendingDeliveryPackStatus(args: {
  context: DeliveryPackStatusContext;
  deliveryId: number;
  dropId: string;
  log?: (entry: Record<string, unknown>) => void;
  nowMs?: () => number;
}): Promise<DeliveryPackStatusProjectionOutcome> {
  const log = args.log || ((entry: Record<string, unknown>) => console.log(entry));
  const attemptStartedAtMs = (args.nowMs || Date.now)();
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(args.context.signal.reason);
  };
  args.context.signal.addEventListener('abort', onAbort, { once: true });
  if (args.context.signal.aborted) onAbort();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Pack-status projection timed out', 'TimeoutError')),
    PACK_STATUS_TIMEOUT_MS,
  );
  const context: DeliveryPackStatusContext = {
    ...args.context,
    nowMs: attemptStartedAtMs,
    signal: controller.signal,
  };
  const key = commerceKeys.deliveryOrder(args.dropId, String(args.deliveryId));
  const documentPath = key.path;
  try {
    const order = await raceWithSignal(readCommerceRecord(context, key), context.signal);
    if (!order) return 'not-needed';
    const state = order.data[PACK_STATUS_PROJECTION_STATE_FIELD];
    if (state !== PACK_STATUS_PROJECTION_PENDING) return 'not-needed';
    if (
      deliveryPackStatusProjectionNextAttemptAtMs(
        order.data[PACK_STATUS_PROJECTION_NEXT_ATTEMPT_AT_MS_FIELD],
      ) > attemptStartedAtMs
    ) return 'not-due';
    if (order.data.status !== 'ready_to_ship') {
      throw new DeliveryPackStatusProjectionInvalidError(
        'invalid-order-status',
        'Pack-status projection order is not ready to ship.',
      );
    }
    const resolution = resolveDeliveryOrderIdentity(order.key.documentId, order.data, order.key.path);
    if (
      !('identity' in resolution) ||
      resolution.identity.dropId !== args.dropId ||
      resolution.identity.deliveryId !== args.deliveryId
    ) {
      throw new DeliveryPackStatusProjectionInvalidError(
        'invalid-order-identity',
        'Pack-status projection order identity is invalid.',
      );
    }
    let runtime: DeliveryRuntime;
    try {
      runtime = runtimeForDrop(args.dropId);
    } catch {
      throw new DeliveryPackStatusProjectionInvalidError(
        'invalid-drop',
        'Pack-status projection drop is invalid.',
      );
    }
    if (!shouldProjectNormalIrlPackStatus(runtime, order.data)) {
      await raceWithSignal(clearDeliveryPackStatusProjection(context, order.key.path), context.signal);
      log({
        event: 'delivery_pack_status_projection_skipped',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
      });
      return 'not-needed';
    }
    if (
      countDeliveryOrderBoxItems(order.data.items) < 1 &&
      countDeliveryOrderDudeItems(order.data.items) < 1
    ) {
      throw new DeliveryPackStatusProjectionInvalidError(
        'invalid-order-items',
        'Pack-status projection order has no countable items.',
      );
    }
    if (!context.dataDb) throw new Error('pack_status_data_db_not_configured');
    await raceWithSignal(
      countNormalIrlPackStatus(context, runtime, args.deliveryId, order.data),
      context.signal,
    );
    await raceWithSignal(markDeliveryPackStatusProjectionCompleted(context, order.key.path), context.signal);
    log({
      event: 'delivery_pack_status_projection_completed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
    });
    return 'completed';
  } catch (error) {
    const errorCode = deliveryPackStatusProjectionErrorCode(error);
    const persistenceContext = cleanupContext(args.context);
    if (error instanceof DeliveryPackStatusProjectionInvalidError) {
      await raceWithSignal(
        markDeliveryPackStatusProjectionFailed(persistenceContext, documentPath, errorCode),
        persistenceContext.signal,
      );
      log({
        event: 'delivery_pack_status_projection_failed',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        errorCode,
        error: summarizeError(error),
      });
      return 'failed';
    }
    await raceWithSignal(
      recordDeliveryPackStatusProjectionTransientFailure({
        attemptStartedAtMs,
        context: persistenceContext,
        documentPath,
        errorCode,
      }),
      persistenceContext.signal,
    );
    log({
      event: 'delivery_pack_status_projection_retry_scheduled',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      errorCode,
      error: summarizeError(error),
    });
    return 'pending';
  } finally {
    clearTimeout(timeout);
    args.context.signal.removeEventListener('abort', onAbort);
  }
}

async function runDueDeliveryPackStatusProjectionQuery(
  context: DeliveryPackStatusContext,
  dropId: string,
  dueAtMs: number,
  limit: number,
): Promise<CommerceDocumentRecord[]> {
  return context.repository.queryDuePackStatusProjections({
    dropId,
    dueAtMs,
    limit,
  });
}

export async function reconcilePendingDeliveryPackStatusProjections(
  env: Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>,
  signal: AbortSignal,
  overrides: {
    dropIds?: readonly string[];
    log?: (entry: Record<string, unknown>) => void;
    nowMs?: () => number;
    providerFetch?: ProfileProviderFetch;
  } = {},
): Promise<number> {
  const nowMs = overrides.nowMs || Date.now;
  const dueAtMs = nowMs();
  const log = overrides.log || ((entry: Record<string, unknown>) => console.log(entry));
  const context: DeliveryPackStatusContext = {
    repository: new D1CommerceRepository(env.COMMERCE_DB),
    nowMs: dueAtMs,
    signal,
    dataDb: env.DATA_DB,
  };
  const lanes = await Promise.all(
    (overrides.dropIds || Object.keys(API_DROPS).sort()).flatMap((dropId) => {
      const runtime = runtimeForDrop(dropId);
      if (!shouldTrackPackStatusForDrop(runtime)) return [];
      return [runDueDeliveryPackStatusProjectionQuery(
        context,
        runtime.dropId,
        dueAtMs,
        PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE,
      ).then((documents) => ({ documents, dropId: runtime.dropId }))];
    }),
  );
  const candidates: Array<{ deliveryId: number; dropId: string }> = [];
  const errors: unknown[] = [];
  let inspected = 0;
  while (
    inspected < PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE &&
    lanes.some((lane) => lane.documents.length)
  ) {
    for (const lane of lanes) {
      if (inspected >= PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE) break;
      const document = lane.documents.shift();
      if (!document) continue;
      inspected += 1;
      const resolution = resolveDeliveryOrderIdentity(document.key.documentId, document.data, document.key.path);
      if (!('identity' in resolution) || resolution.identity.dropId !== lane.dropId) {
        try {
          await markDeliveryPackStatusProjectionFailed(
            cleanupContext(context),
            document.key.path,
            'invalid-order-identity',
          );
        } catch (error) {
          errors.push(error);
        }
        continue;
      }
      candidates.push({
        deliveryId: resolution.identity.deliveryId,
        dropId: lane.dropId,
      });
    }
  }
  let nextCandidate = 0;
  const worker = async () => {
    while (nextCandidate < candidates.length) {
      if (signal.aborted) {
        errors.push(signal.reason);
        return;
      }
      const candidate = candidates[nextCandidate];
      nextCandidate += 1;
      try {
        await projectPendingDeliveryPackStatus({
          ...candidate,
          context,
          log,
          nowMs,
        });
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PACK_STATUS_PROJECTION_RECONCILIATION_CONCURRENCY, candidates.length) },
      worker,
    ),
  );
  if (errors.length) throw new AggregateError(errors, 'Pack-status projection reconciliation failed');
  return candidates.length;
}

export function scheduleDeliveryPackStatusProjection(args: {
  context: DeliveryPackStatusContext;
  deliveryId: number;
  dropId: string;
  waitUntil: DeferredWork;
}): void {
  const task = projectPendingDeliveryPackStatus({
    ...args,
    context: { ...args.context, signal: new AbortController().signal },
  }).catch((error) => {
    console.error({
      event: 'delivery_pack_status_projection_background_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: summarizeError(error),
    });
  });
  registerDeferredWork(args.waitUntil, task);
}
