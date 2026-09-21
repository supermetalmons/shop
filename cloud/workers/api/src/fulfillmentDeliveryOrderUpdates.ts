import type {
  FulfillmentShipStationLabel,
  FulfillmentShipStationRate,
  ShipStationMoney,
} from '../../../../shared/contracts.js';
import type { ShipStationPackageInput } from '../../../../shared/shipstationPackage.js';
import type { commerceFieldValue } from './commerceRepository.js';

type DeletedField = ReturnType<typeof commerceFieldValue.delete>;
type TimestampUpdate = number | ReturnType<typeof commerceFieldValue.serverTimestamp>;

type StoredShipStationLabel = FulfillmentShipStationLabel & {
  purchasedAt: number;
  recordedBy: string;
};

export type FulfillmentDeliveryOrderUpdates = {
  dropId?: string;
  'addressSnapshot.encrypted'?: string;
  'addressSnapshot.hint'?: string;
  fulfillmentAddressUpdatedBy?: string;
  fulfillmentAddressUpdatedAt?: TimestampUpdate;
  fulfillmentTrackingCode?: string | DeletedField;
  'shipstation.shipmentId'?: string;
  'shipstation.externalShipmentId'?: string;
  'shipstation.shipmentNumber'?: string;
  'shipstation.createdBy'?: string;
  'shipstation.createdAt'?: TimestampUpdate;
  'shipstation.claimId'?: string | DeletedField;
  'shipstation.claimedBy'?: string | DeletedField;
  'shipstation.claimedAt'?: TimestampUpdate | DeletedField;
  'shipstation.claimFenceId'?: string | DeletedField;
  'shipstation.lastError'?: string | DeletedField;
  'shipstation.lastErrorAt'?: TimestampUpdate | DeletedField;
  'shipstation.package'?: ShipStationPackageInput | DeletedField;
  'shipstation.packageCount'?: number;
  'shipstation.rateQuotes'?: Array<Pick<FulfillmentShipStationRate, 'rateId' | 'shipmentId' | 'totalAmount'>> | DeletedField;
  'shipstation.rateRequest'?: DeletedField;
  'shipstation.rateRequest.requestId'?: string;
  'shipstation.rateRequest.createdAt'?: string | DeletedField;
  'shipstation.rateRequest.shipmentId'?: string;
  'shipstation.rateRequest.inputHash'?: string;
  'shipstation.rateRequest.package'?: ShipStationPackageInput;
  'shipstation.rateRequest.requestedAt'?: TimestampUpdate;
  'shipstation.ratesClaimId'?: string | DeletedField;
  'shipstation.ratesClaimedAt'?: TimestampUpdate | DeletedField;
  'shipstation.ratesClaimedBy'?: string | DeletedField;
  'shipstation.ratesClaimFenceId'?: string | DeletedField;
  'shipstation.ratesUpdatedBy'?: string;
  'shipstation.ratesUpdatedAt'?: TimestampUpdate;
  'shipstation.label'?: StoredShipStationLabel;
  'shipstation.labelPurchase'?: DeletedField;
  'shipstation.labelPurchase.status'?: 'purchasing' | 'unknown' | 'failed';
  'shipstation.labelPurchase.requestId'?: string;
  'shipstation.labelPurchase.rateId'?: string;
  'shipstation.labelPurchase.expectedTotal'?: ShipStationMoney;
  'shipstation.labelPurchase.claimedBy'?: string;
  'shipstation.labelPurchase.claimedAt'?: TimestampUpdate;
  'shipstation.labelPurchase.lastError'?: string | DeletedField;
  'shipstation.labelPurchase.lastErrorAt'?: TimestampUpdate | DeletedField;
  'shipstation.labelPurchase.lastErrorBy'?: string | DeletedField;
  'shipstation.labelPurchase.checkedAt'?: TimestampUpdate | DeletedField;
  'shipstation.labelPurchase.checkedBy'?: string | DeletedField;
};
