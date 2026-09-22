import type { FulfillmentStatus } from '../../../../shared/fulfillmentStatus.js';
import type { commerceFieldValue, CommerceJsonValue } from './commerceRepository.js';
import type { FulfillmentDeliveryOrderUpdates } from './fulfillmentDeliveryOrderUpdates.js';

type DeleteField = ReturnType<typeof commerceFieldValue.delete>;
type ServerTimestamp = ReturnType<typeof commerceFieldValue.serverTimestamp>;
type Timestamp = ReturnType<typeof commerceFieldValue.timestamp>;

export type DeliveryOrderFulfillmentUpdates = {
  dropId?: string;
  fulfillmentUpdatedBy?: string;
  fulfillmentStatus?: FulfillmentStatus | DeleteField;
  fulfillmentUpdatedAt?: ServerTimestamp;
  fulfillmentTrackingCode?: string | DeleteField;
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

export type DeliveryOrderUpdates = DeliveryOrderFulfillmentUpdates & DeliveryRecoveryPatch &
  FulfillmentDeliveryOrderUpdates;
