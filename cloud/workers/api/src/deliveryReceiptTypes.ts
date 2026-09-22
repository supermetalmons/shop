import type { commerceFieldValue } from './commerceRepositoryTypes.js';

type ServerTimestamp = ReturnType<typeof commerceFieldValue.serverTimestamp>;
type DeletedField = ReturnType<typeof commerceFieldValue.delete>;

export type DeliveryIrlClaim = {
  code: string;
  boxId: number;
  boxAssetId: string;
  dudeIds: number[];
};

export type DeliveryProcessingUpdate = {
  dropId: string;
  status: 'processing';
  deliverySignature?: string;
  'receiptRecovery.lastPreparedProbeAt': DeletedField;
  'receiptRecovery.preparedProbeCount': DeletedField;
  'receiptRecovery.nextPreparedProbeAt': DeletedField;
  'receiptRecovery.status': DeletedField;
  processingAt?: ServerTimestamp;
};

export type DeliveryReadyFields = {
  dropId: string;
  status: 'ready_to_ship';
  deliverySignature?: string;
  receiptsMinted: number;
  receiptTxs: string[];
  irlClaims?: DeliveryIrlClaim[];
};

export type DeliveryReadyUpdate = DeliveryReadyFields & {
  'receiptRecovery.leaseExpiresAt': DeletedField;
  'receiptRecovery.lastErrorCode': DeletedField;
  'receiptRecovery.lastErrorMessage': DeletedField;
  'receiptRecovery.lastPreparedProbeAt': DeletedField;
  'receiptRecovery.preparedProbeCount': DeletedField;
  'receiptRecovery.nextPreparedProbeAt': DeletedField;
  'receiptRecovery.status': DeletedField;
  processedAt: ServerTimestamp;
  irlClaimsUpdatedAt?: ServerTimestamp;
};

export type DeliveryCloseUpdate = {
  dropId: string;
  closeDeliveryTx: string;
  deliveryClosedAt: ServerTimestamp;
};
