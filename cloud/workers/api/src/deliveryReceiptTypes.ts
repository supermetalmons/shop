import type { commerceFieldValue } from './commerceRepositoryTypes.js';

type ServerTimestamp = ReturnType<typeof commerceFieldValue.serverTimestamp>;

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
  processedAt: ServerTimestamp;
  irlClaimsUpdatedAt?: ServerTimestamp;
};

export type DeliveryCloseUpdate = {
  dropId: string;
  closeDeliveryTx: string;
  deliveryClosedAt: ServerTimestamp;
};
