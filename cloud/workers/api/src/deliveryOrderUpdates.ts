import type { FulfillmentStatus } from '../../../../shared/fulfillmentStatus.js';
import type { commerceFieldValue, CommerceJsonValue } from './commerceRepositoryTypes.js';
import type { FulfillmentDeliveryOrderUpdates } from './fulfillmentDeliveryOrderUpdates.js';
import type { ApiErrorCode } from './dataAccess.js';
import type { DeliveryCloseUpdate, DeliveryProcessingUpdate, DeliveryReadyUpdate } from './deliveryReceiptTypes.js';
import type { DeliveryPackStatusProjectionUpdates } from './deliveryPackStatusProjectionTypes.js';

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

export type DeliveryOwnerMergeUpdate = {
  mergedAuthSubject: string;
  owner: string;
  ownerKind: 'wallet';
  ownerMergedAt: ServerTimestamp;
  previousOwner: string;
};

export type DeliveryReceiptClaimFields = {
  namespace: 'stripe_receipt_v1';
  code: string;
  boxId: number;
  status: 'processing' | 'unclaimed' | 'claimed';
  recipient?: string | DeleteField;
  processingLeaseExpiresAt?: Timestamp | DeleteField;
  processingStartedAt?: ServerTimestamp | DeleteField;
  lastClaimError?: { kind: string; code: ApiErrorCode; message: string };
  receiptTxs?: string[];
  receiptKind?: 'box' | 'figure';
  receiptsTransferred?: number;
  figureIds?: number[] | DeleteField;
  claimedAt?: ServerTimestamp;
};

export type DeliveryReceiptClaimValues = Omit<DeliveryReceiptClaimFields, 'namespace' | 'code' | 'boxId' | 'status'>;

export type DeliveryReceiptClaimUpdates = {
  [Field in keyof DeliveryReceiptClaimFields as `stripeReceiptClaim.${Field}`]?: DeliveryReceiptClaimFields[Field];
} & {
  [Field in keyof DeliveryReceiptClaimFields as `stripeReceiptClaimsByBoxId.box_${number}.${Field}`]-?: Exclude<DeliveryReceiptClaimFields[Field], undefined>;
} & { dropId?: string };

export type DeliveryOrderUpdates = (DeliveryOrderFulfillmentUpdates & DeliveryRecoveryPatch &
  FulfillmentDeliveryOrderUpdates) | DeliveryOwnerMergeUpdate | DeliveryProcessingUpdate |
  DeliveryReadyUpdate | DeliveryCloseUpdate | DeliveryReceiptClaimUpdates | DeliveryPackStatusProjectionUpdates;
