import type { FulfillmentStatus } from '../../../../shared/fulfillmentStatus.js';
import type { commerceFieldValue, CommerceJsonValue } from './commerceRepositoryTypes.js';
import type { FulfillmentDeliveryOrderUpdates } from './fulfillmentDeliveryOrderUpdates.js';
import type { ApiErrorCode } from './dataAccess.js';
import type { DeliveryCloseUpdate, DeliveryProcessingUpdate, DeliveryReadyUpdate } from './deliveryReceiptTypes.js';

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
  'leaseExpiresAt'?: Timestamp | DeleteField;
  'lastAttemptAt'?: CommerceJsonValue | Timestamp | DeleteField;
  'attemptCount'?: CommerceJsonValue | DeleteField;
  'lastErrorCode'?: string | DeleteField;
  'lastErrorMessage'?: string | DeleteField;
  'preparedProbeCount'?: number | DeleteField;
  'lastPreparedProbeAt'?: Timestamp | DeleteField;
  'nextPreparedProbeAt'?: Timestamp | DeleteField;
  'pendingSubmission'?: CommerceJsonValue | DeleteField;
  'status'?: DeleteField;
};

export type PreparedDeliveryRecoveryUpdate = {
  status: 'prepared_abandoned';
  preparedRecoveryAbandonedAt: Timestamp;
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

export type DeliveryOrderUpdates = (DeliveryOrderFulfillmentUpdates &
  FulfillmentDeliveryOrderUpdates) | DeliveryOwnerMergeUpdate | DeliveryProcessingUpdate |
  DeliveryReadyUpdate | DeliveryCloseUpdate | DeliveryReceiptClaimUpdates | PreparedDeliveryRecoveryUpdate;
