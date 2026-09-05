import { commerceFieldValue, type CommerceDocumentRecord, type CommerceDocumentWriteData } from './commerceRepository.js';
import {
  readCommerceRecord,
  requireCommerceKey,
  runCommerceTransaction,
  type CommerceRepositoryContext,
} from './commerceTransactions.js';
import { DeliveryReceiptError, summarizeDeliveryReceiptError as summarizeError } from './deliveryReceiptErrors.js';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.js';
import { planNotificationPublicationClaim, publishClaimedNotificationBatch } from './notificationOutboxPublication.js';
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
  isReadyToShipNotificationJob,
  type PendingReadyToShipNotification,
} from './readyToShipNotifications.js';

const READY_NOTIFICATION_FAILED_AT_FIELD = 'readyToShipNotificationFailedAt';
const READY_NOTIFICATION_LAST_ERROR_CODE_FIELD = 'readyToShipNotificationLastErrorCode';
const CLEANUP_TIMEOUT_MS = 5_000;
const NOTIFICATION_JOB_FIELDS: Readonly<Record<string, string>> = {
  [BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD]: BUYER_ORDER_RECEIVED_EMAIL_JOB_FIELD,
  [SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD]: SHIPPER_READY_TO_SHIP_EMAIL_JOB_FIELD,
};

function clearCompletedNotificationClaim(
  fields: Record<string, unknown>,
  values: CommerceDocumentWriteData,
): void {
  if (Object.keys(NOTIFICATION_JOB_FIELDS).some((stateField) => (
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

async function markReadyToShipNotificationsQueued(
  context: CommerceRepositoryContext,
  documentPath: string,
  claimId: string,
  pending: readonly PendingReadyToShipNotification[],
): Promise<string[]> {
  return runCommerceTransaction(context, async (transaction) => {
    const document = await readCommerceRecord(context, requireCommerceKey(documentPath), transaction);
    if (
      !document ||
      document.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] !== claimId
    ) return [];
    const matching = pending.filter((marker) => (
      document.data[marker.stateField] === READY_TO_SHIP_NOTIFICATION_PENDING &&
      document.data[marker.jobIdField] === marker.jobId &&
      document.data[marker.idempotencyKeyField] === marker.idempotencyKey
    ));
    if (!matching.length) return [];
    const values: CommerceDocumentWriteData = Object.fromEntries(matching.flatMap((marker) => [
      [marker.stateField, READY_TO_SHIP_NOTIFICATION_QUEUED],
      [marker.jobIdField, marker.jobId],
      [marker.jobField, commerceFieldValue.delete()],
      [marker.queuedAtField, commerceFieldValue.serverTimestamp()],
    ]));
    clearCompletedNotificationClaim(document.data, values);
    await transaction.update(document.key, values);
    return matching.map((marker) => marker.kind);
  });
}

type ReadyToShipNotificationClaim = {
  claimId: string;
  document: CommerceDocumentRecord;
  pending: PendingReadyToShipNotification[];
  previousAttemptCount: number;
  expiresAtMs: number;
  retryUntilMs: number;
};

type ReadyToShipNotificationClaimResult =
  | { outcome: 'busy' | 'manual-review' | 'none' }
  | { outcome: 'claimed'; claim: ReadyToShipNotificationClaim };

function readyToShipNotificationNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

async function claimReadyToShipNotifications(args: {
  context: CommerceRepositoryContext;
  deliveryId: number;
  documentPath: string;
  dropId: string;
  nowMs: () => number;
}): Promise<ReadyToShipNotificationClaimResult> {
  return runCommerceTransaction<ReadyToShipNotificationClaimResult>(args.context, async (transaction) => {
    const document = await readCommerceRecord(args.context, requireCommerceKey(args.documentPath), transaction);
    if (!document) return { outcome: 'none' };
    const inspection = inspectPendingReadyToShipNotifications(document.data, {
      deliveryId: args.deliveryId,
      dropId: args.dropId,
    });
    if (!inspection.pending.length) return { outcome: 'none' };
    const activeClaimId = document.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD];
    const claimExpiresAtMs = readyToShipNotificationNonNegativeInteger(
      document.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD],
    );
    const retryUntilMs = readyToShipNotificationNonNegativeInteger(
      document.data[READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD],
    );
    const attemptCount = readyToShipNotificationNonNegativeInteger(
      document.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD],
    );
    const plan = planNotificationPublicationClaim({
      nowMs: Math.max(0, Math.floor(args.nowMs())),
      attemptCount,
      retryUntilMs,
      activeUntilMs: typeof activeClaimId === 'string' && activeClaimId ? claimExpiresAtMs : null,
    });
    if (plan.outcome === 'busy') return { outcome: 'busy' };
    if (plan.outcome === 'exhausted') {
      await transaction.update(document.key, {
        ...Object.fromEntries(inspection.pending.flatMap((marker) => [
          [marker.stateField, READY_TO_SHIP_NOTIFICATION_FAILED],
          [marker.jobField, commerceFieldValue.delete()],
        ])),
        [READY_NOTIFICATION_LAST_ERROR_CODE_FIELD]: 'manual-review-required',
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: commerceFieldValue.delete(),
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]: commerceFieldValue.delete(),
        [READY_NOTIFICATION_FAILED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
      });
      return { outcome: 'manual-review' };
    }
    const claimId = crypto.randomUUID();
    await transaction.update(document.key, {
      [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: claimId,
      [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]: plan.expiresAtMs,
      [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: plan.attemptCount,
      [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: plan.retryUntilMs,
    });
    return {
      outcome: 'claimed',
      claim: {
        claimId,
        document,
        pending: inspection.pending,
        previousAttemptCount: plan.attemptCount - 1,
        expiresAtMs: plan.expiresAtMs,
        retryUntilMs: plan.retryUntilMs,
      },
    };
  });
}

async function releaseReadyToShipNotificationClaim(
  context: CommerceRepositoryContext,
  documentPath: string,
  claim: ReadyToShipNotificationClaim,
): Promise<boolean> {
  return runCommerceTransaction(context, async (transaction) => {
    const document = await readCommerceRecord(context, requireCommerceKey(documentPath), transaction);
    if (
      !document ||
      document.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] !== claim.claimId
    ) return false;
    await transaction.update(document.key, {
      [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: claim.previousAttemptCount,
      [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: commerceFieldValue.delete(),
      [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]: commerceFieldValue.delete(),
    });
    return true;
  });
}

export async function markPendingReadyToShipNotificationsFailed(
  context: CommerceRepositoryContext,
  documentPath: string,
  errorCode: string,
  targetStateFields?: readonly string[],
  expectedUpdateTime?: string,
): Promise<string[]> {
  return runCommerceTransaction(context, async (transaction) => {
    const document = await readCommerceRecord(context, requireCommerceKey(documentPath), transaction);
    if (!document || (expectedUpdateTime && document.updateTime !== expectedUpdateTime)) return [];
    const stateFields = Object.keys(NOTIFICATION_JOB_FIELDS).filter((fieldPath) => (
      document.data[fieldPath] === READY_TO_SHIP_NOTIFICATION_PENDING &&
      (!targetStateFields || targetStateFields.includes(fieldPath))
    ));
    if (!stateFields.length) return [];
    const values: CommerceDocumentWriteData = {
      ...Object.fromEntries(stateFields.flatMap((fieldPath) => [
        [fieldPath, READY_TO_SHIP_NOTIFICATION_FAILED],
        [NOTIFICATION_JOB_FIELDS[fieldPath], commerceFieldValue.delete()],
      ])),
      [READY_NOTIFICATION_LAST_ERROR_CODE_FIELD]: errorCode,
      [READY_NOTIFICATION_FAILED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
    };
    clearCompletedNotificationClaim(document.data, values);
    await transaction.update(document.key, values);
    return stateFields;
  });
}

async function persistReadyToShipNotificationJobs(args: {
  context: CommerceRepositoryContext;
  documentPath: string;
  claim: ReadyToShipNotificationClaim;
  prepared: readonly { marker: PendingReadyToShipNotification; job: NotificationEmailJobV1 }[];
  nowMs: () => number;
}): Promise<{ pending: PendingReadyToShipNotification[]; jobs: NotificationEmailJobV1[] }> {
  return runCommerceTransaction(args.context, async (transaction) => {
    const document = await readCommerceRecord(args.context, requireCommerceKey(args.documentPath), transaction);
    if (
      !document || document.data.status !== 'ready_to_ship' ||
      document.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] !== args.claim.claimId ||
      document.data[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD] !== args.claim.expiresAtMs
    ) throw new ReadyToShipNotificationEnqueueError('Ready-to-ship notification publication claim changed. Retry later.');
    const nowMs = args.nowMs();
    if (nowMs >= args.claim.expiresAtMs || nowMs >= args.claim.retryUntilMs) {
      throw new ReadyToShipNotificationEnqueueError('Ready-to-ship notification publication claim expired. Retry later.');
    }
    const values: CommerceDocumentWriteData = {};
    const pending: PendingReadyToShipNotification[] = [];
    const jobs: NotificationEmailJobV1[] = [];
    for (const { marker, job } of args.prepared) {
      if (
        document.data[marker.stateField] !== READY_TO_SHIP_NOTIFICATION_PENDING ||
        document.data[marker.jobIdField] !== marker.jobId ||
        document.data[marker.idempotencyKeyField] !== marker.idempotencyKey
      ) throw new ReadyToShipNotificationEnqueueError('Ready-to-ship notification identity changed. Retry later.');
      const hasSnapshot = Object.hasOwn(document.data, marker.jobField);
      const snapshot = hasSnapshot ? document.data[marker.jobField] : job;
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
    clearCompletedNotificationClaim(document.data, values);
    if (Object.keys(values).length) await transaction.update(document.key, values);
    return { pending, jobs };
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
  const startedAt = performance.now();
  const nowMs = args.nowMs || (() => args.context.nowMs + Math.max(0, Math.floor(performance.now() - startedAt)));
  const expectedIdentity = { deliveryId: args.deliveryId, dropId: args.dropId };
  let initialDocument = args.document;
  let initialInspection = inspectPendingReadyToShipNotifications(args.document.data, expectedIdentity);
  let invalidMarkerFinalizationError: unknown;
  if (initialInspection.invalidStateFields.length) {
    const currentDocument = await readCommerceRecord(args.context, args.document.key);
    if (!currentDocument) return false;
    initialDocument = currentDocument;
    initialInspection = inspectPendingReadyToShipNotifications(currentDocument.data, expectedIdentity);
  }
  if (initialInspection.invalidStateFields.length) {
    try {
      await markPendingReadyToShipNotificationsFailed(
        notificationPersistenceContext(args.context),
        args.document.key.path,
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
    documentPath: args.document.key.path,
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
      for (const marker of claim.pending) {
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
          documentPath: args.document.key.path,
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
          args.document.key.path,
          claim.claimId,
          pending,
        );
        if (finalizedKinds.length !== pending.length) {
          const latest = await readCommerceRecord(persistenceContext, args.document.key);
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
        args.document.key.path,
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
