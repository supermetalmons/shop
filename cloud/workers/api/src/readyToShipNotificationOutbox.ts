import {
  deliveryOrderDocument, deliveryOrderKey, readDeliveryOrder,
} from './deliveryOrderStore.js';
import type { CommerceDocumentRecord } from './commerceRepository.js';
import { type CommerceRepositoryContext } from './commerceTransactions.js';
import { DeliveryReceiptError } from './deliveryReceiptErrors.js';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.js';
import { notificationOutboxState } from '../../../../shared/notificationOutbox.js';
import { publishClaimedNotificationBatch } from './notificationOutboxPublication.js';
import {
  claimNotificationOutbox, markClaimedNotificationQueued, persistClaimedNotificationJobs,
  releaseNotificationOutboxClaim,
} from './notificationOutboxStore.js';
import {
  BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD, SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
  createReadyToShipNotificationJobs, readyToShipNotificationMarker,
  type ReadyToShipNotificationStateField,
} from './readyToShipNotifications.js';

export class ReadyToShipNotificationEnqueueError extends DeliveryReceiptError {
  constructor(message = 'Delivery completed, but notification emails could not be queued. Retry to finish notification delivery.') {
    super('unavailable', message);
    this.name = 'ReadyToShipNotificationEnqueueError';
  }
}

export function notificationPersistenceContext(context: CommerceRepositoryContext): CommerceRepositoryContext {
  return { ...context, nowMs: Date.now(), signal: AbortSignal.timeout(5_000) };
}

export async function markPendingReadyToShipNotificationsFailed(
  context: CommerceRepositoryContext,
  documentPath: string,
  errorCode: string,
  targetStateFields?: readonly ReadyToShipNotificationStateField[],
  expectedUpdateTime?: string,
): Promise<string[]> {
  const key = deliveryOrderKey(documentPath);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const document = await readDeliveryOrder(context, key);
    if (!document || (expectedUpdateTime && document.updateTime !== expectedUpdateTime)) return [];
    const record = await context.repository.notificationOutbox.get(key.path, 'ready');
    if (!record || record.state !== 'pending') return [];
    const changed: string[] = [];
    const entries = record.entries.map((entry) => {
      const stateField = entry.kind === 'buyer_order_received'
        ? BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD : SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD;
      if (entry.state !== 'pending' || (targetStateFields && !targetStateFields.includes(stateField))) return entry;
      changed.push(stateField);
      const { payload: _payload, ...identity } = entry;
      return { ...identity, state: 'failed' as const, errorCode };
    });
    if (!changed.length) return [];
    const state = notificationOutboxState(entries);
    const updated = await context.repository.notificationOutbox.compareAndSet({
      expected: record, parentVersion: document.version, nowMs: context.nowMs,
      changes: { entries, state, lastErrorCode: errorCode,
        ...(state !== 'pending' ? { nextAttemptAtMs: null, claimId: null, claimExpiresAtMs: null } : {}) },
    });
    if (updated) return changed;
  }
  throw new ReadyToShipNotificationEnqueueError('Notification failure state changed. Retry later.');
}

async function publishReadyNotifications(args: {
  context: CommerceRepositoryContext;
  deliveryId: number;
  document: CommerceDocumentRecord;
  dropId: string;
  queue: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
  nowMs?: () => number;
}): Promise<boolean> {
  args.context.signal.throwIfAborted();
  const supplied = deliveryOrderDocument(args.document);
  const document = await readDeliveryOrder(args.context, supplied.key);
  if (!document || document.data.status !== 'ready_to_ship') return false;
  const startedAt = performance.now();
  const nowMs = args.nowMs || (() => args.context.nowMs + Math.max(0, Math.floor(performance.now() - startedAt)));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const record = await args.context.repository.notificationOutbox.get(document.key.path, 'ready');
    if (!record || record.state !== 'pending') return false;
    const entries = record.entries.map((entry) => {
      if (entry.state !== 'pending') return entry;
      const suffix = entry.kind === 'buyer_order_received' ? 'order_received' : 'ready_to_ship';
      const valid = entry.idempotencyKey === `${args.dropId}:${args.deliveryId}:${suffix}` &&
        (!entry.payload || (entry.payload.context.dropId === args.dropId && entry.payload.context.deliveryId === args.deliveryId));
      if (valid) return entry;
      const { payload: _payload, ...identity } = entry;
      return { ...identity, state: 'failed' as const, errorCode: 'invalid-notification-data' };
    });
    if (entries.every((entry, index) => entry === record.entries[index])) break;
    const state = notificationOutboxState(entries);
    const updated = await args.context.repository.notificationOutbox.compareAndSet({
      expected: record, nowMs: nowMs(), parentVersion: document.version,
      changes: { entries, state, lastErrorCode: 'invalid-notification-data',
        ...(state !== 'pending' ? { claimId: null, claimExpiresAtMs: null, nextAttemptAtMs: null } : {}) },
    });
    if (updated) break;
  }
  const claimed = await claimNotificationOutbox({
    repository: args.context.repository, parentPath: document.key.path,
    family: 'ready', nowMs, signal: args.context.signal, parentVersion: document.version,
  });
  if (claimed.outcome !== 'claimed') return false;
  const { claim } = claimed;
  const options = { repository: args.context.repository, claim, nowMs };
  const buildErrors: unknown[] = [];
  const result = await publishClaimedNotificationBatch({
    signal: args.context.signal, nowMs,
    expiresAtMs: claim.claimExpiresAtMs!, retryUntilMs: claim.retryUntilMs,
    queue: args.queue,
    createExpiredClaimError: () => new ReadyToShipNotificationEnqueueError('Notification publication claim expired. Retry later.'),
    prepareAndPersist: async () => {
      const current = await readDeliveryOrder(args.context, document.key);
      if (!current || current.data.status !== 'ready_to_ship') throw new ReadyToShipNotificationEnqueueError('Delivery order changed. Retry later.');
      const jobs: NotificationEmailJobV1[] = [];
      for (const entry of claim.entries) {
        if (entry.state !== 'pending') continue;
        try {
          const marker = readyToShipNotificationMarker(entry);
          const prepared = entry.payload ? [entry.payload] : await createReadyToShipNotificationJobs({
            order: current.data, deliveryId: args.deliveryId, dropId: args.dropId, pending: [marker],
          });
          if (prepared.length !== 1) throw new Error('ready_notification_job_count_invalid');
          jobs.push(prepared[0]);
        } catch (error) {
          buildErrors.push(error);
        }
      }
      if (!jobs.length) throw new ReadyToShipNotificationEnqueueError('Notification emails could not be prepared. Retry later.');
      const stored = await persistClaimedNotificationJobs({ ...options, jobs, parentVersion: current.version });
      if (!stored) throw new ReadyToShipNotificationEnqueueError('Notification publication claim changed. Retry later.');
      return stored.entries.filter((entry) => jobs.some((job) => job.jobId === entry.jobId))
        .map((entry) => entry.payload!).filter(Boolean);
    },
    finalize: async (jobs) => {
      const updated = await markClaimedNotificationQueued({ ...options, jobs });
      if (!updated) throw new ReadyToShipNotificationEnqueueError('Notifications were queued, but their recovery state could not be saved. Retry later.');
      console.log({ event: 'ready_to_ship_notifications_queued', dropId: args.dropId,
        deliveryId: args.deliveryId, jobs: jobs.map(({ jobId, kind }) => ({ jobId, kind })) });
      return jobs.length > 0;
    },
    releaseUnusedClaim: async () => { await releaseNotificationOutboxClaim(options); },
  });
  if (buildErrors.length) throw new ReadyToShipNotificationEnqueueError('Some notification emails could not be prepared. Retry later.');
  return result;
}

export async function publishReadyToShipNotifications(args: Parameters<typeof publishReadyNotifications>[0]): Promise<boolean> {
  try {
    return await publishReadyNotifications(args);
  } catch (error) {
    if (args.context.signal.aborted) throw args.context.signal.reason;
    if (error instanceof ReadyToShipNotificationEnqueueError) throw error;
    const unavailable = new ReadyToShipNotificationEnqueueError();
    unavailable.cause = error;
    throw unavailable;
  }
}
