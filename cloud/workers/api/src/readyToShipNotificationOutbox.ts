import {
  deliveryOrderDocument,
  deliveryOrderKey,
  readDeliveryOrder,
  updateDeliveryOrder,
  type DeliveryOrderKey,
} from './deliveryOrderStore.js';
import type { ReadyToShipNotificationUpdates } from './deliveryOrderUpdates.js';
import { commerceFieldValue, type CommerceDocumentRecord } from './commerceRepository.js';
import {
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import { DeliveryReceiptError, summarizeDeliveryReceiptError as summarizeError } from './deliveryReceiptErrors.js';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.js';
import { publishClaimedNotificationBatch } from './notificationOutboxPublication.js';
import {
  claimNotificationOutbox,
  updateClaimedNotificationOutbox,
  type NotificationOutboxAdapter,
  type NotificationOutboxClaim,
  type NotificationOutboxTarget,
} from './notificationOutboxStore.js';
import {
  BUYER_ORDER_RECEIVED_EMAIL_JOB_FIELD,
  BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
  READY_TO_SHIP_NOTIFICATION_FAILED,
  READY_TO_SHIP_NOTIFICATION_PENDING,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
  READY_TO_SHIP_NOTIFICATION_QUEUED,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD,
  SHIPPER_READY_TO_SHIP_EMAIL_JOB_FIELD,
  SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
  createReadyToShipNotificationJobs,
  inspectPendingReadyToShipNotifications,
  parseReadyToShipNotificationClaim,
  isReadyToShipNotificationJob,
  type PendingReadyToShipNotification,
  type ReadyToShipNotificationStateField,
} from './readyToShipNotifications.js';

const READY_NOTIFICATION_FAILED_AT_FIELD = 'readyToShipNotificationFailedAt';
const READY_NOTIFICATION_LAST_ERROR_CODE_FIELD = 'readyToShipNotificationLastErrorCode';
const CLEANUP_TIMEOUT_MS = 5_000;
const NOTIFICATION_STATE_FIELDS = [BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD, SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD] as const;
const NOTIFICATION_JOB_FIELDS = {
  [BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD]: BUYER_ORDER_RECEIVED_EMAIL_JOB_FIELD,
  [SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD]: SHIPPER_READY_TO_SHIP_EMAIL_JOB_FIELD,
} as const;

function clearCompletedNotificationClaim(
  fields: Record<string, unknown>,
  values: ReadyToShipNotificationUpdates,
): void {
  if (NOTIFICATION_STATE_FIELDS.some((stateField) => (
    (values[stateField] ?? fields[stateField]) === READY_TO_SHIP_NOTIFICATION_PENDING
  ))) return;
  values[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] = commerceFieldValue.delete();
  values[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD] = commerceFieldValue.delete();
}

export class ReadyToShipNotificationEnqueueError extends DeliveryReceiptError {
  constructor(message = 'Delivery completed, but notification emails could not be queued. Retry to finish notification delivery.') {
    super(
      'unavailable',
      message,
    );
    this.name = 'ReadyToShipNotificationEnqueueError';
  }
}

class ReadyToShipNotificationFinalizationError extends ReadyToShipNotificationEnqueueError {
  constructor() {
    super('Delivery completed and notifications were queued, but their recovery state could not be saved. Retry later.');
    this.name = 'ReadyToShipNotificationFinalizationError';
  }
}

export function notificationPersistenceContext(context: CommerceRepositoryContext): CommerceRepositoryContext {
  return {
    ...context,
    nowMs: Date.now(),
    signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
  };
}

function notificationOutboxTarget(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
): NotificationOutboxTarget {
  return { context, key, read: (transaction) => readDeliveryOrder(context, key, transaction) };
}

function inspectNotificationClaim(document: CommerceDocumentRecord) {
  const fields = deliveryOrderDocument(document).data;
  const claim = parseReadyToShipNotificationClaim(fields);
  return { claimId: claim.claimId, state: { fields, claim } };
}

async function markReadyToShipNotificationsQueued(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  claimId: string,
  pending: readonly PendingReadyToShipNotification[],
): Promise<string[]> {
  return updateClaimedNotificationOutbox({
    target: notificationOutboxTarget(context, key),
    claimId,
    inspect: inspectNotificationClaim,
    lost: () => [],
    update: ({ fields }) => {
      const matching = pending.filter((marker) => (
        fields[marker.stateField] === READY_TO_SHIP_NOTIFICATION_PENDING &&
        fields[marker.jobIdField] === marker.jobId &&
        fields[marker.idempotencyKeyField] === marker.idempotencyKey
      ));
      if (!matching.length) return { result: [] };
      const values: ReadyToShipNotificationUpdates = {};
      for (const marker of matching) {
        values[marker.stateField] = READY_TO_SHIP_NOTIFICATION_QUEUED;
        values[marker.jobIdField] = marker.jobId;
        values[marker.jobField] = commerceFieldValue.delete();
        values[marker.queuedAtField] = commerceFieldValue.serverTimestamp();
      }
      clearCompletedNotificationClaim(fields, values);
      return { values, result: matching.map((marker) => marker.kind) };
    },
  });
}

type ReadyToShipNotificationClaim = NotificationOutboxClaim<PendingReadyToShipNotification[]>;

type ReadyToShipNotificationClaimResult =
  | { outcome: 'busy' | 'manual-review' | 'none' }
  | { outcome: 'claimed'; claim: ReadyToShipNotificationClaim };

async function claimReadyToShipNotifications(args: {
  context: CommerceRepositoryContext;
  deliveryId: number;
  key: DeliveryOrderKey;
  dropId: string;
  nowMs: () => number;
}): Promise<ReadyToShipNotificationClaimResult> {
  const adapter: NotificationOutboxAdapter<PendingReadyToShipNotification[], 'busy' | 'manual-review' | 'none'> = {
    missing: 'none',
    inspect: (document) => {
      const inspection = inspectPendingReadyToShipNotifications(document.data, {
        deliveryId: args.deliveryId,
        dropId: args.dropId,
      });
      if (!inspection.pending.length) return { result: 'none' };
      const claim = parseReadyToShipNotificationClaim(document.data);
      return {
        state: inspection.pending,
        attemptCount: claim.attemptCount,
        retryUntilMs: claim.retryUntilMs,
        activeUntilMs: claim.claimId ? claim.expiresAtMs : null,
      };
    },
    busy: () => 'busy',
    exhausted: (pending) => {
      const values: ReadyToShipNotificationUpdates = {
        [READY_NOTIFICATION_LAST_ERROR_CODE_FIELD]: 'manual-review-required',
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: commerceFieldValue.delete(),
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]: commerceFieldValue.delete(),
        [READY_NOTIFICATION_FAILED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
      };
      for (const marker of pending) {
        values[marker.stateField] = READY_TO_SHIP_NOTIFICATION_FAILED;
        values[marker.jobField] = commerceFieldValue.delete();
      }
      return { result: 'manual-review', values };
    },
    claim: (pending, lease) => ({
      state: pending,
      values: {
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: lease.claimId,
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]: lease.expiresAtMs,
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: lease.attemptCount,
        [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: lease.retryUntilMs,
      } satisfies ReadyToShipNotificationUpdates,
    }),
  };
  const result = await claimNotificationOutbox({
    target: notificationOutboxTarget(args.context, args.key),
    adapter,
    nowMs: () => Math.max(0, Math.floor(args.nowMs())),
  });
  return result.outcome === 'claimed' ? result : { outcome: result.result };
}

async function releaseReadyToShipNotificationClaim(
  context: CommerceRepositoryContext,
  key: DeliveryOrderKey,
  claim: ReadyToShipNotificationClaim,
): Promise<boolean> {
  return updateClaimedNotificationOutbox({
    target: notificationOutboxTarget(context, key),
    claimId: claim.claimId,
    inspect: inspectNotificationClaim,
    lost: () => false,
    update: () => ({
      values: {
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: claim.previousAttemptCount,
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: commerceFieldValue.delete(),
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]: commerceFieldValue.delete(),
      } satisfies ReadyToShipNotificationUpdates,
      result: true,
    }),
  });
}

export async function markPendingReadyToShipNotificationsFailed(
  context: CommerceRepositoryContext,
  documentPath: string,
  errorCode: string,
  targetStateFields?: readonly ReadyToShipNotificationStateField[],
  expectedUpdateTime?: string,
): Promise<string[]> {
  return runCommerceTransaction(context, async (transaction) => {
    const document = await readDeliveryOrder(context, deliveryOrderKey(documentPath), transaction);
    if (!document || (expectedUpdateTime && document.updateTime !== expectedUpdateTime)) return [];
    const stateFields = NOTIFICATION_STATE_FIELDS.filter((fieldPath) => (
      document.data[fieldPath] === READY_TO_SHIP_NOTIFICATION_PENDING &&
      (!targetStateFields || targetStateFields.includes(fieldPath))
    ));
    if (!stateFields.length) return [];
    const values: ReadyToShipNotificationUpdates = {
      [READY_NOTIFICATION_LAST_ERROR_CODE_FIELD]: errorCode,
      [READY_NOTIFICATION_FAILED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
    };
    for (const stateField of stateFields) {
      values[stateField] = READY_TO_SHIP_NOTIFICATION_FAILED;
      values[NOTIFICATION_JOB_FIELDS[stateField]] = commerceFieldValue.delete();
    }
    clearCompletedNotificationClaim(document.data, values);
    await updateDeliveryOrder(transaction, document.key, values);
    return stateFields;
  });
}

async function persistReadyToShipNotificationJobs(args: {
  context: CommerceRepositoryContext;
  key: DeliveryOrderKey;
  claim: ReadyToShipNotificationClaim;
  prepared: readonly { marker: PendingReadyToShipNotification; job: NotificationEmailJobV1 }[];
  nowMs: () => number;
}): Promise<{ pending: PendingReadyToShipNotification[]; jobs: NotificationEmailJobV1[] }> {
  const claimChanged = () => {
    throw new ReadyToShipNotificationEnqueueError('Ready-to-ship notification publication claim changed. Retry later.');
  };
  return updateClaimedNotificationOutbox({
    target: notificationOutboxTarget(args.context, args.key),
    claimId: args.claim.claimId,
    inspect: inspectNotificationClaim,
    lost: claimChanged,
    update: ({ fields, claim }) => {
      if (
        fields.status !== 'ready_to_ship' ||
        claim.expiresAtMs !== args.claim.expiresAtMs
      ) return claimChanged();
      const nowMs = args.nowMs();
      if (nowMs >= args.claim.expiresAtMs || nowMs >= args.claim.retryUntilMs) {
        throw new ReadyToShipNotificationEnqueueError('Ready-to-ship notification publication claim expired. Retry later.');
      }
      const values: ReadyToShipNotificationUpdates = {};
      const pending: PendingReadyToShipNotification[] = [];
      const jobs: NotificationEmailJobV1[] = [];
      for (const { marker, job } of args.prepared) {
        if (
          fields[marker.stateField] !== READY_TO_SHIP_NOTIFICATION_PENDING ||
          fields[marker.jobIdField] !== marker.jobId ||
          fields[marker.idempotencyKeyField] !== marker.idempotencyKey
        ) throw new ReadyToShipNotificationEnqueueError('Ready-to-ship notification identity changed. Retry later.');
        const hasSnapshot = Object.hasOwn(fields, marker.jobField);
        const snapshot = hasSnapshot ? fields[marker.jobField] : job;
        if (!isReadyToShipNotificationJob(snapshot, marker)) {
          values[marker.stateField] = READY_TO_SHIP_NOTIFICATION_FAILED;
          values[marker.jobField] = commerceFieldValue.delete();
          values[READY_NOTIFICATION_LAST_ERROR_CODE_FIELD] = 'invalid-notification-data';
          values[READY_NOTIFICATION_FAILED_AT_FIELD] = commerceFieldValue.serverTimestamp();
          continue;
        }
        if (!hasSnapshot) values[marker.jobField] = snapshot;
        pending.push(marker);
        jobs.push(snapshot);
      }
      clearCompletedNotificationClaim(fields, values);
      return { values, result: { pending, jobs } };
    },
  });
}

export async function publishReadyToShipNotifications(args: {
  context: CommerceRepositoryContext;
  deliveryId: number;
  document: CommerceDocumentRecord;
  dropId: string;
  queue: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
  nowMs?: () => number;
}): Promise<boolean> {
  args.context.signal.throwIfAborted();
  const document = deliveryOrderDocument(args.document);
  const startedAt = performance.now();
  const nowMs = args.nowMs || (() => args.context.nowMs + Math.max(0, Math.floor(performance.now() - startedAt)));
  const expectedIdentity = { deliveryId: args.deliveryId, dropId: args.dropId };
  let initialDocument = document;
  let initialInspection = inspectPendingReadyToShipNotifications(document.data, expectedIdentity);
  let invalidMarkerFinalizationError: unknown;
  if (initialInspection.invalidStateFields.length) {
    const currentDocument = await readDeliveryOrder(args.context, document.key);
    if (!currentDocument) return false;
    initialDocument = currentDocument;
    initialInspection = inspectPendingReadyToShipNotifications(currentDocument.data, expectedIdentity);
  }
  if (initialInspection.invalidStateFields.length) {
    try {
      await markPendingReadyToShipNotificationsFailed(
        notificationPersistenceContext(args.context),
        document.key.path,
        'invalid-notification-data',
        initialInspection.invalidStateFields,
        initialDocument.updateTime,
      );
    } catch (error) {
      invalidMarkerFinalizationError = error;
      console.error({
        event: 'ready_to_ship_notifications_marker_finalization_failed',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        error: summarizeError(error),
      });
    }
  }
  if (!initialInspection.pending.length) {
    console.log({
      event: 'ready_to_ship_notifications_skipped',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      reason: initialInspection.invalidStateFields.length ? 'no-valid-pending-markers' : 'no-pending-markers',
    });
    if (invalidMarkerFinalizationError) throw new ReadyToShipNotificationFinalizationError();
    return false;
  }

  const claimResult = await claimReadyToShipNotifications({
    context: args.context,
    deliveryId: args.deliveryId,
    key: document.key,
    dropId: args.dropId,
    nowMs,
  });
  if (claimResult.outcome !== 'claimed') {
    console.log({
      event: 'ready_to_ship_notifications_skipped',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      reason: claimResult.outcome,
    });
    if (invalidMarkerFinalizationError) throw new ReadyToShipNotificationFinalizationError();
    return false;
  }
  const { claim } = claimResult;
  let pending: PendingReadyToShipNotification[] = [];
  const buildErrors: unknown[] = [];
  const published = await publishClaimedNotificationBatch({
    signal: args.context.signal,
    nowMs,
    expiresAtMs: claim.expiresAtMs,
    retryUntilMs: claim.retryUntilMs,
    createExpiredClaimError: () => new ReadyToShipNotificationEnqueueError(
      'Ready-to-ship notification publication claim expired. Retry later.',
    ),
    prepareAndPersist: async () => {
      const prepared: Array<{ marker: PendingReadyToShipNotification; job: NotificationEmailJobV1 }> = [];
      for (const marker of claim.state) {
        try {
          const markerJobs = marker.job ? [marker.job] : await createReadyToShipNotificationJobs({
            order: claim.document.data,
            deliveryId: args.deliveryId,
            dropId: args.dropId,
            pending: [marker],
          });
          if (markerJobs.length !== 1) throw new Error('ready_notification_job_count_invalid');
          prepared.push({ marker, job: markerJobs[0] });
        } catch (error) {
          buildErrors.push(error);
          console.error({
            event: 'ready_to_ship_notification_build_failed',
            dropId: args.dropId,
            deliveryId: args.deliveryId,
            stateField: marker.stateField,
            error: summarizeError(error),
          });
        }
      }
      if (!prepared.length) {
        console.log({
          event: 'ready_to_ship_notifications_skipped',
          dropId: args.dropId,
          deliveryId: args.deliveryId,
          reason: 'job-build-failed',
        });
        throw new ReadyToShipNotificationEnqueueError(
          'Delivery completed, but notification emails could not be prepared. Retry later.',
        );
      }
      try {
        const stored = await persistReadyToShipNotificationJobs({
          context: args.context,
          key: document.key,
          claim,
          prepared,
          nowMs,
        });
        pending = stored.pending;
        return stored.jobs;
      } catch (error) {
        if (args.context.signal.aborted) throw args.context.signal.reason;
        if (error instanceof ReadyToShipNotificationEnqueueError) throw error;
        console.error({
          event: 'ready_to_ship_notifications_snapshot_persistence_failed',
          dropId: args.dropId,
          deliveryId: args.deliveryId,
          error: summarizeError(error),
        });
        const failure = new ReadyToShipNotificationEnqueueError(
          'Delivery completed, but notification emails could not be saved for delivery. Retry later.',
        );
        failure.cause = error;
        throw failure;
      }
    },
    queue: {
      sendBatch: async (messages) => {
        try {
          return await args.queue.sendBatch(messages);
        } catch (error) {
          console.error({
            event: 'ready_to_ship_notifications_enqueue_failed',
            dropId: args.dropId,
            deliveryId: args.deliveryId,
            error: summarizeError(error),
          });
          throw new ReadyToShipNotificationEnqueueError();
        }
      },
    },
    finalize: async (jobs) => {
      if (!pending.length) return false;
      console.log({
        event: 'ready_to_ship_notifications_queued',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        jobs: jobs.map((job) => ({ jobId: job.jobId, kind: job.kind })),
      });
      const persistenceContext = notificationPersistenceContext(args.context);
      try {
        const finalizedKinds = await markReadyToShipNotificationsQueued(
          persistenceContext,
          document.key,
          claim.claimId,
          pending,
        );
        if (finalizedKinds.length !== pending.length) {
          const latest = await readDeliveryOrder(persistenceContext, document.key);
          const remaining = pending.filter((marker) => (
            latest?.data[marker.stateField] === READY_TO_SHIP_NOTIFICATION_PENDING &&
            latest.data[marker.jobIdField] === marker.jobId &&
            latest.data[marker.idempotencyKeyField] === marker.idempotencyKey
          ));
          if (remaining.length) throw new Error('ready_notification_marker_still_pending');
        }
        if (invalidMarkerFinalizationError) throw invalidMarkerFinalizationError;
      } catch (error) {
        console.error({
          event: 'ready_to_ship_notifications_marker_finalization_failed',
          dropId: args.dropId,
          deliveryId: args.deliveryId,
          error: summarizeError(error),
        });
        throw new ReadyToShipNotificationFinalizationError();
      }
      return true;
    },
    releaseUnusedClaim: async () => {
      await releaseReadyToShipNotificationClaim(
        notificationPersistenceContext(args.context),
        document.key,
        claim,
      ).catch((releaseError) => {
        console.error({
          event: 'ready_to_ship_notifications_claim_release_failed',
          dropId: args.dropId,
          deliveryId: args.deliveryId,
          error: summarizeError(releaseError),
        });
      });
    },
  });
  if (buildErrors.length) {
    throw new ReadyToShipNotificationEnqueueError(
      'Delivery completed, but some notification emails could not be prepared. Retry later.',
    );
  }
  return published;
}
