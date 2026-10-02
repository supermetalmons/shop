import { parseDeliveryOrderProjectionView, type DeliveryOrderProjectionView } from './deliveryOrderProjectionView.js';
import { readDeliveryOrder } from './deliveryOrderStore.js';
import { API_DROPS } from './dropConfig.js';
import { runtimeForDrop, type DeliveryRuntime } from './deliveryReceiptOnchain.js';
import { DeliveryReceiptError, summarizeDeliveryReceiptError as summarizeError } from './deliveryReceiptErrors.js';
import { resolveDeliveryOrderIdentity } from './deliveryOrderSummaries.js';
import type { PackStatusOutboxMutation, PackStatusOutboxRecord } from '../../../../shared/packStatusOutbox.js';
import {
  isAdminIrlRedeemDeliveryOrderSource,
  isStripeOffchainDeliveryOrderSource,
} from '../../../../shared/fulfillmentSources.js';
import {
  packStatusCardsPerPack,
  shouldTrackPackStatusForDrop,
  type PackStatusEvent,
} from '../../../../shared/packStatus.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { createTimedAbortScope, raceWithSignal } from './boundedRequest.js';
import {
  D1CommerceRepository,
  commerceKeys,
} from './commerceRepository.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import { applyPackStatusProjection } from './packStatusProjection.js';
import { registerDeferredWork, type DeferredWork } from './deferredWork.js';

const CLEANUP_TIMEOUT_MS = 5_000;
const PACK_STATUS_TIMEOUT_MS = 10_000;
const PACK_STATUS_PROJECTION_RECONCILIATION_BATCH_SIZE = 4;
const PACK_STATUS_PROJECTION_RECONCILIATION_CONCURRENCY = 2;
const PACK_STATUS_PROJECTION_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;

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
  order: DeliveryOrderProjectionView,
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
    order.adminTargetKind === 'card_receipt'
  ) return false;
  return true;
}

export function shouldEnqueueDeliveryPackStatusProjection(
  runtime: DeliveryRuntime,
  data: Record<string, unknown>,
): boolean {
  const order = parseDeliveryOrderProjectionView(data);
  return shouldProjectNormalIrlPackStatus(runtime, order) && (order.packQuantity > 0 || order.cardQuantity > 0);
}

async function countNormalIrlPackStatus(
  context: DeliveryPackStatusContext,
  runtime: DeliveryRuntime,
  deliveryId: number,
  order: DeliveryOrderProjectionView,
): Promise<void> {
  if (!shouldProjectNormalIrlPackStatus(runtime, order)) return;
  const packQuantity = order.packQuantity;
  const cardQuantity = order.cardQuantity;
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
  expected: PackStatusOutboxRecord,
  changes: PackStatusOutboxMutation,
): Promise<boolean> {
  return Boolean(await context.repository.packStatusOutbox.compareAndSet({ expected, changes, nowMs: context.nowMs }));
}

async function observedProjectionOutcome(
  context: DeliveryPackStatusContext,
  parentPath: string,
): Promise<DeliveryPackStatusProjectionOutcome> {
  const current = await raceWithSignal(context.repository.packStatusOutbox.get(parentPath), context.signal);
  return !current || current.state === 'cancelled' ? 'not-needed' : current.state;
}

function terminalProjectionMutation(
  outbox: PackStatusOutboxRecord,
  state: 'completed' | 'failed' | 'cancelled',
  nowMs: number,
  errorCode: string | null = null,
): PackStatusOutboxMutation {
  return { state, failureCount: outbox.failureCount, nextAttemptAtMs: null,
    completedAtMs: state === 'completed' ? nowMs : null, failedAtMs: state === 'failed' ? nowMs : null,
    lastErrorCode: errorCode };
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
  const scope = createTimedAbortScope(args.context.signal, {
    timeoutMs: PACK_STATUS_TIMEOUT_MS,
    timeoutMessage: 'Pack-status projection timed out',
  });
  const context: DeliveryPackStatusContext = {
    ...args.context,
    nowMs: attemptStartedAtMs,
    signal: scope.signal,
  };
  const key = commerceKeys.deliveryOrder(args.dropId, String(args.deliveryId));
  const documentPath = key.path;
  let outbox: PackStatusOutboxRecord | null = null;
  try {
    outbox = await raceWithSignal(context.repository.packStatusOutbox.get(documentPath), context.signal);
    if (!outbox || outbox.state !== 'pending') return 'not-needed';
    if (outbox.nextAttemptAtMs! > attemptStartedAtMs) return 'not-due';
    const order = await raceWithSignal(readDeliveryOrder(context, key), context.signal);
    if (!order) return 'not-needed';
    const projection = parseDeliveryOrderProjectionView(order.data);
    if (projection.status !== 'ready_to_ship') {
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
    if (!shouldProjectNormalIrlPackStatus(runtime, projection)) {
      if (!await raceWithSignal(transitionDeliveryPackStatusProjection(context, outbox,
        terminalProjectionMutation(outbox, 'cancelled', context.nowMs)), context.signal)) {
        return await observedProjectionOutcome(context, documentPath);
      }
      log({
        event: 'delivery_pack_status_projection_skipped',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
      });
      return 'not-needed';
    }
    if (
      projection.packQuantity < 1 &&
      projection.cardQuantity < 1
    ) {
      throw new DeliveryPackStatusProjectionInvalidError(
        'invalid-order-items',
        'Pack-status projection order has no countable items.',
      );
    }
    if (!context.dataDb) throw new Error('pack_status_data_db_not_configured');
    await raceWithSignal(
      countNormalIrlPackStatus(context, runtime, args.deliveryId, projection),
      context.signal,
    );
    if (!await raceWithSignal(transitionDeliveryPackStatusProjection(context, outbox,
      terminalProjectionMutation(outbox, 'completed', context.nowMs)), context.signal)) {
      return await observedProjectionOutcome(context, documentPath);
    }
    log({
      event: 'delivery_pack_status_projection_completed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
    });
    return 'completed';
  } catch (error) {
    if (!outbox) throw error;
    const errorCode = deliveryPackStatusProjectionErrorCode(error);
    const persistenceContext = cleanupContext(args.context);
    if (error instanceof DeliveryPackStatusProjectionInvalidError) {
      if (!await raceWithSignal(transitionDeliveryPackStatusProjection(persistenceContext, outbox,
        terminalProjectionMutation(outbox, 'failed', persistenceContext.nowMs, errorCode)), persistenceContext.signal)) {
        return await observedProjectionOutcome(persistenceContext, documentPath);
      }
      log({
        event: 'delivery_pack_status_projection_failed',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        errorCode,
        error: summarizeError(error),
      });
      return 'failed';
    }
    const backoffMs = PACK_STATUS_PROJECTION_BACKOFF_MS[
      Math.min(outbox.failureCount, PACK_STATUS_PROJECTION_BACKOFF_MS.length - 1)
    ];
    if (!await raceWithSignal(transitionDeliveryPackStatusProjection(persistenceContext, outbox, {
      state: 'pending', failureCount: Math.min(Number.MAX_SAFE_INTEGER, outbox.failureCount + 1),
      nextAttemptAtMs: attemptStartedAtMs + backoffMs, completedAtMs: null, failedAtMs: null, lastErrorCode: errorCode,
    }), persistenceContext.signal)) return await observedProjectionOutcome(persistenceContext, documentPath);
    log({
      event: 'delivery_pack_status_projection_retry_scheduled',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      errorCode,
      error: summarizeError(error),
    });
    return 'pending';
  } finally {
    scope.dispose();
  }
}

async function runDueDeliveryPackStatusProjectionQuery(
  context: DeliveryPackStatusContext,
  dropId: string,
  dueAtMs: number,
  limit: number,
): Promise<PackStatusOutboxRecord[]> {
  return context.repository.packStatusOutbox.queryDue({
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
      const documentId = document.parentPath.split('/').at(-1)!;
      const resolution = resolveDeliveryOrderIdentity(documentId, {}, document.parentPath);
      if (!('identity' in resolution) || resolution.identity.dropId !== lane.dropId) {
        try {
          const cleanup = cleanupContext(context);
          await transitionDeliveryPackStatusProjection(cleanup, document,
            terminalProjectionMutation(document, 'failed', cleanup.nowMs, 'invalid-order-identity'));
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
