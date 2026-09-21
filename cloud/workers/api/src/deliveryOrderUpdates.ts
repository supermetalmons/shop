import type { FulfillmentStatus } from '../../../../shared/fulfillmentStatus.js';
import type { NotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.js';
import type { commerceFieldValue, CommerceJsonValue } from './commerceRepository.js';
import type { FulfillmentDeliveryOrderUpdates } from './fulfillmentDeliveryOrderUpdates.js';

type DeleteField = ReturnType<typeof commerceFieldValue.delete>;
type ServerTimestamp = ReturnType<typeof commerceFieldValue.serverTimestamp>;
type Timestamp = ReturnType<typeof commerceFieldValue.timestamp>;
type NotificationState = 'pending' | 'queued' | 'failed';

export type DeliveryOrderFulfillmentUpdates = {
  dropId?: string;
  fulfillmentUpdatedBy?: string;
  fulfillmentStatus?: FulfillmentStatus | DeleteField;
  fulfillmentUpdatedAt?: ServerTimestamp;
  fulfillmentTrackingCode?: string | DeleteField;
  buyerOrderShippedEmailState?: 'pending' | 'queued' | DeleteField;
  buyerOrderShippedEmailJobId?: string | DeleteField;
  buyerOrderShippedEmailIdempotencyKey?: string | DeleteField;
  buyerOrderShippedEmailQueuedAt?: DeleteField | ServerTimestamp;
};

export type DeliveryRecoveryPatch = {
  status?: 'prepared_abandoned';
  preparedRecoveryAbandonedAt?: Timestamp;
  'receiptRecovery.leaseExpiresAt'?: Timestamp | DeleteField;
  'receiptRecovery.lastAttemptAt'?: CommerceJsonValue | Timestamp | DeleteField;
  'receiptRecovery.attemptCount'?: CommerceJsonValue | DeleteField;
  'receiptRecovery.lastErrorCode'?: string | DeleteField;
  'receiptRecovery.lastErrorMessage'?: string | DeleteField;
  'receiptRecovery.preparedProbeCount'?: number;
  'receiptRecovery.lastPreparedProbeAt'?: Timestamp;
  'receiptRecovery.nextPreparedProbeAt'?: Timestamp | DeleteField;
};

export type ReadyToShipNotificationUpdates = {
  buyerOrderReceivedEmailState?: NotificationState;
  shipperReadyToShipEmailState?: NotificationState;
  buyerOrderReceivedEmailJobId?: string;
  shipperReadyToShipEmailJobId?: string;
  buyerOrderReceivedEmailJob?: NotificationEmailJobV1 | DeleteField;
  shipperReadyToShipEmailJob?: NotificationEmailJobV1 | DeleteField;
  buyerOrderReceivedEmailIdempotencyKey?: string;
  shipperReadyToShipEmailIdempotencyKey?: string;
  buyerOrderReceivedEmailQueuedAt?: ServerTimestamp | DeleteField;
  shipperReadyToShipEmailQueuedAt?: ServerTimestamp | DeleteField;
  readyToShipNotificationRetryUntilMs?: number;
  readyToShipNotificationPublishAttemptCount?: number;
  readyToShipNotificationPublishClaimId?: string | DeleteField;
  readyToShipNotificationPublishClaimExpiresAtMs?: number | DeleteField;
  readyToShipNotificationFailedAt?: ServerTimestamp;
  readyToShipNotificationLastErrorCode?: string;
};

export type DeliveryOrderUpdates = DeliveryOrderFulfillmentUpdates & DeliveryRecoveryPatch &
  ReadyToShipNotificationUpdates & FulfillmentDeliveryOrderUpdates;
