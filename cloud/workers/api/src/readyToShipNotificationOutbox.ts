import { commerceFieldValue, type CommerceDocumentWriteData } from './commerceRepository.js';
import {
  commitCommerceWrites as commitWrites,
  readCommerceDocument as readDocument,
  retryCommerceConflicts,
  updateCommerceWrite as updateWrite,
  type CommerceDocument,
  type CommerceDocumentContext,
} from './commerceTransactions.js';
import { DeliveryReceiptError, summarizeDeliveryReceiptError as summarizeError } from './deliveryReceiptErrors.js';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.js';
import {
  BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
  READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
  READY_TO_SHIP_NOTIFICATION_FAILED,
  READY_TO_SHIP_NOTIFICATION_MAX_PUBLISH_ATTEMPTS,
  READY_TO_SHIP_NOTIFICATION_PENDING,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD,
  READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD,
  READY_TO_SHIP_NOTIFICATION_QUEUED,
  READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS,
  READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD,
  SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
  createReadyToShipNotificationJobs,
  inspectPendingReadyToShipNotifications,
  type PendingReadyToShipNotification,
} from './readyToShipNotifications.js';

const READY_NOTIFICATION_FAILED_AT_FIELD = 'readyToShipNotificationFailedAt';
const READY_NOTIFICATION_LAST_ERROR_CODE_FIELD = 'readyToShipNotificationLastErrorCode';
const CLEANUP_TIMEOUT_MS = 5_000;

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

export function notificationPersistenceContext(context: CommerceDocumentContext): CommerceDocumentContext {
  return {
    ...context,
    nowMs: Date.now(),
    signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
  };
}

async function markReadyToShipNotificationsQueued(
  context: CommerceDocumentContext,
  documentPath: string,
  claimId: string,
  pending: readonly PendingReadyToShipNotification[],
): Promise<string[]> {
  return retryCommerceConflicts(async () => {
    const document = await readDocument(context, documentPath);
    if (
      !document ||
      document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] !== claimId
    ) return [];
    const matching = pending.filter((marker) => (
      document.fields[marker.stateField] === READY_TO_SHIP_NOTIFICATION_PENDING &&
      document.fields[marker.jobIdField] === marker.jobId &&
      document.fields[marker.idempotencyKeyField] === marker.idempotencyKey
    ));
    if (!matching.length) return [];
    const matchingStateFields = new Set(matching.map((marker) => marker.stateField));
    const hasRemainingPendingMarker = [
      BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
      SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
    ].some((stateField) => (
      document.fields[stateField] === READY_TO_SHIP_NOTIFICATION_PENDING &&
      !matchingStateFields.has(stateField)
    ));
    const values: CommerceDocumentWriteData = Object.fromEntries(matching.flatMap((marker) => [
      [marker.stateField, READY_TO_SHIP_NOTIFICATION_QUEUED],
      [marker.jobIdField, marker.jobId],
      [marker.queuedAtField, commerceFieldValue.serverTimestamp()],
    ]));
    if (!hasRemainingPendingMarker) {
      values[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] = commerceFieldValue.delete();
      values[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD] = commerceFieldValue.delete();
    }
    await commitWrites(context, [updateWrite({
      path: documentPath,
      values,
      expectedUpdateTime: document.updateTime,
    })]);
    return matching.map((marker) => marker.kind);
  }, { signal: context.signal });
}

type ReadyToShipNotificationClaim = {
  claimId: string;
  document: CommerceDocument;
  pending: PendingReadyToShipNotification[];
  previousAttemptCount: number;
};

type ReadyToShipNotificationClaimResult =
  | { outcome: 'busy' | 'manual-review' | 'none' }
  | { outcome: 'claimed'; claim: ReadyToShipNotificationClaim };

function readyToShipNotificationNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

async function claimReadyToShipNotifications(args: {
  context: CommerceDocumentContext;
  deliveryId: number;
  documentPath: string;
  dropId: string;
}): Promise<ReadyToShipNotificationClaimResult> {
  const nowMs = Math.max(0, Math.floor(args.context.nowMs));
  return retryCommerceConflicts(async () => {
    const document = await readDocument(args.context, args.documentPath);
    if (!document) return { outcome: 'none' };
    const inspection = inspectPendingReadyToShipNotifications(document.fields, {
      deliveryId: args.deliveryId,
      dropId: args.dropId,
    });
    if (!inspection.pending.length) return { outcome: 'none' };
    const activeClaimId = document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD];
    const claimExpiresAtMs = readyToShipNotificationNonNegativeInteger(
      document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD],
    );
    if (typeof activeClaimId === 'string' && activeClaimId && claimExpiresAtMs !== null && claimExpiresAtMs > nowMs) {
      return { outcome: 'busy' };
    }
    const retryUntilMs = readyToShipNotificationNonNegativeInteger(
      document.fields[READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD],
    );
    const attemptCount = readyToShipNotificationNonNegativeInteger(
      document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD],
    );
    if (
      retryUntilMs === null ||
      attemptCount === null ||
      attemptCount >= READY_TO_SHIP_NOTIFICATION_MAX_PUBLISH_ATTEMPTS ||
      (attemptCount > 0 && retryUntilMs <= nowMs)
    ) {
      const stateFields = inspection.pending.map((marker) => marker.stateField);
      await commitWrites(args.context, [updateWrite({
        path: args.documentPath,
        values: {
          ...Object.fromEntries(stateFields.map((stateField) => [stateField, READY_TO_SHIP_NOTIFICATION_FAILED])),
          [READY_NOTIFICATION_LAST_ERROR_CODE_FIELD]: 'manual-review-required',
          [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: commerceFieldValue.delete(),
          [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]: commerceFieldValue.delete(),
          [READY_NOTIFICATION_FAILED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
        },
        expectedUpdateTime: document.updateTime,
      })]);
      return { outcome: 'manual-review' };
    }
    const claimId = crypto.randomUUID();
    await commitWrites(args.context, [updateWrite({
      path: args.documentPath,
      values: {
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: claimId,
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]:
          nowMs + READY_TO_SHIP_NOTIFICATION_CLAIM_LEASE_MS,
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: attemptCount + 1,
        [READY_TO_SHIP_NOTIFICATION_RETRY_UNTIL_MS_FIELD]: attemptCount === 0
          ? nowMs + READY_TO_SHIP_NOTIFICATION_RETRY_WINDOW_MS
          : retryUntilMs,
      },
      expectedUpdateTime: document.updateTime,
    })]);
    return {
      outcome: 'claimed',
      claim: {
        claimId,
        document,
        pending: inspection.pending,
        previousAttemptCount: attemptCount,
      },
    };
  }, { signal: args.context.signal });
}

async function releaseReadyToShipNotificationClaim(
  context: CommerceDocumentContext,
  documentPath: string,
  claim: ReadyToShipNotificationClaim,
): Promise<boolean> {
  return retryCommerceConflicts(async () => {
    const document = await readDocument(context, documentPath);
    if (
      !document ||
      document.fields[READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD] !== claim.claimId
    ) return false;
    await commitWrites(context, [updateWrite({
      path: documentPath,
      values: {
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_ATTEMPT_COUNT_FIELD]: claim.previousAttemptCount,
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_ID_FIELD]: commerceFieldValue.delete(),
        [READY_TO_SHIP_NOTIFICATION_PUBLISH_CLAIM_EXPIRES_AT_MS_FIELD]: commerceFieldValue.delete(),
      },
      expectedUpdateTime: document.updateTime,
    })]);
    return true;
  }, { signal: context.signal });
}

export async function markPendingReadyToShipNotificationsFailed(
  context: CommerceDocumentContext,
  documentPath: string,
  errorCode: string,
  targetStateFields?: readonly string[],
): Promise<string[]> {
  return retryCommerceConflicts(async () => {
    const document = await readDocument(context, documentPath);
    if (!document) return [];
    const stateFields = [
      BUYER_ORDER_RECEIVED_EMAIL_STATE_FIELD,
      SHIPPER_READY_TO_SHIP_EMAIL_STATE_FIELD,
    ].filter((fieldPath) => (
      document.fields[fieldPath] === READY_TO_SHIP_NOTIFICATION_PENDING &&
      (!targetStateFields || targetStateFields.includes(fieldPath))
    ));
    if (!stateFields.length) return [];
    await commitWrites(context, [updateWrite({
      path: documentPath,
      values: {
        ...Object.fromEntries(
          stateFields.map((fieldPath) => [fieldPath, READY_TO_SHIP_NOTIFICATION_FAILED]),
        ),
        [READY_NOTIFICATION_LAST_ERROR_CODE_FIELD]: errorCode,
        [READY_NOTIFICATION_FAILED_AT_FIELD]: commerceFieldValue.serverTimestamp(),
      },
      expectedUpdateTime: document.updateTime,
    })]);
    return stateFields;
  }, { signal: context.signal });
}

export async function publishReadyToShipNotifications(args: {
  context: CommerceDocumentContext;
  deliveryId: number;
  document: CommerceDocument;
  dropId: string;
  queue: Pick<Queue<NotificationEmailJobV1>, 'sendBatch'>;
}): Promise<boolean> {
  const expectedIdentity = { deliveryId: args.deliveryId, dropId: args.dropId };
  let initialInspection = inspectPendingReadyToShipNotifications(args.document.fields, expectedIdentity);
  let invalidMarkerFinalizationError: unknown;
  if (initialInspection.invalidStateFields.length) {
    const currentDocument = await readDocument(args.context, args.document.path);
    if (!currentDocument) return false;
    initialInspection = inspectPendingReadyToShipNotifications(currentDocument.fields, expectedIdentity);
  }
  if (initialInspection.invalidStateFields.length) {
    try {
      await markPendingReadyToShipNotificationsFailed(
        notificationPersistenceContext(args.context),
        args.document.path,
        'invalid-notification-data',
        initialInspection.invalidStateFields,
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
    documentPath: args.document.path,
    dropId: args.dropId,
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
  const pending: PendingReadyToShipNotification[] = [];
  const jobs: Awaited<ReturnType<typeof createReadyToShipNotificationJobs>> = [];
  const buildErrors: unknown[] = [];
  for (const marker of claim.pending) {
    try {
      const markerJobs = await createReadyToShipNotificationJobs({
        order: claim.document.fields,
        deliveryId: args.deliveryId,
        dropId: args.dropId,
        pending: [marker],
      });
      if (markerJobs.length !== 1) throw new Error('ready_notification_job_count_invalid');
      pending.push(marker);
      jobs.push(markerJobs[0]);
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
  try {
    args.context.signal.throwIfAborted();
  } catch (error) {
    await releaseReadyToShipNotificationClaim(
      notificationPersistenceContext(args.context),
      args.document.path,
      claim,
    ).catch((releaseError) => {
      console.error({
        event: 'ready_to_ship_notifications_claim_release_failed',
        dropId: args.dropId,
        deliveryId: args.deliveryId,
        error: summarizeError(releaseError),
      });
    });
    throw error;
  }
  if (!jobs.length) {
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
    await args.queue.sendBatch(jobs.map((job) => ({ body: job, contentType: 'json' })));
  } catch (error) {
    console.error({
      event: 'ready_to_ship_notifications_enqueue_failed',
      dropId: args.dropId,
      deliveryId: args.deliveryId,
      error: summarizeError(error),
    });
    throw new ReadyToShipNotificationEnqueueError();
  }
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
      args.document.path,
      claim.claimId,
      pending,
    );
    if (finalizedKinds.length !== pending.length) {
      const latest = await readDocument(persistenceContext, args.document.path);
      const remaining = pending.filter((marker) => (
        latest?.fields[marker.stateField] === READY_TO_SHIP_NOTIFICATION_PENDING &&
        latest.fields[marker.jobIdField] === marker.jobId &&
        latest.fields[marker.idempotencyKeyField] === marker.idempotencyKey
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
  if (buildErrors.length) {
    throw new ReadyToShipNotificationEnqueueError(
      'Delivery completed, but some notification emails could not be prepared. Retry later.',
    );
  }
  return true;
}
