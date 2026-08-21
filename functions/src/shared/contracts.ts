import type { FulfillmentStatus } from './fulfillmentStatus.js';
import type { ShipStationPackageInput } from './shipstationPackage.js';

export type PackStatusBreakdownItem = {
  key: 'redeemed' | 'unsealed' | 'total';
  label: string;
  amount: number;
  percentage: number;
};

export type PackStatusBreakdown = {
  dropId: string;
  total: number;
  totalInitialSupply: number;
  totalCards: number;
  cardsPerPack: number;
  unsealedOnline: number;
  unsealedCards: number;
  redeemedIrl: number;
  redeemedIrlNormal: number;
  redeemedIrlStripe: number;
  redeemedUnsealedCards: number;
  redeemedCards: number;
  items: PackStatusBreakdownItem[];
};

export type SubscribeToNotificationsRequest = {
  email: string;
};

export type SubscribeToNotificationsResponse = {
  subscribed: true;
};

export type StripeCheckoutSessionRequest = {
  dropId: string;
  variantKey?: string;
  quantity?: number;
  returnUrl?: string;
};

/**
 * Older callable deployments did not return `livemode`, so clients keep
 * accepting it as optional even though current Functions always include it.
 */
export type StripeCheckoutSessionResponse = {
  id: string;
  url: string;
  livemode?: boolean;
};

export type ProfileAddress = {
  id: string;
  country: string;
  countryCode?: string;
  countryName?: string;
  hint: string;
  encrypted: string;
  email?: string;
};

export type DeliveryOrderItemSummary = {
  kind: 'box' | 'dude';
  refId: number;
};

export type DeliveryOrderSummary = {
  dropId: string;
  deliveryId: number;
  status: string;
  stripeCheckoutSessionId?: string;
  createdAt?: number;
  processingAt?: number;
  processedAt?: number;
  items: DeliveryOrderItemSummary[];
  fulfillmentStatus?: FulfillmentStatus;
  fulfillmentTrackingCode?: string;
  fulfillmentUpdatedAt?: number;
};

export type GetProfileShipmentsResponse = {
  responseMode: 'shipments';
  wallet: string;
  orders: DeliveryOrderSummary[];
};

export type ProfileStateSection<T> =
  | { status: 'ready'; value: T }
  | { status: 'error'; error: { code: 'deadline-exceeded' | 'unavailable'; message: string } };

export type ProfileStateProfile = {
  wallet: string;
  email?: string;
};

export type GetProfileStateResponse = {
  responseMode: 'profile-state';
  sessionWallet: string | null;
  profile: ProfileStateSection<ProfileStateProfile> | null;
  shipments: ProfileStateSection<DeliveryOrderSummary[]> | null;
};

export type DeliveryRecoveryState = {
  nextCheckAt?: number;
};

export type WalletDeliveryRecoveryState = {
  remainingProcessing: number;
  nextCheckAt: number | null;
};

export type Profile = {
  wallet: string;
  email?: string;
  orders?: DeliveryOrderSummary[];
  deliveryRecovery?: DeliveryRecoveryState;
};

export type ReconcileProfileStateRequest = {
  mergeStripeDeliveryOrders?: boolean;
  includeDeliveryRecovery?: boolean;
};

export type ReconcileProfileStateResponse = {
  mergedStripeDeliveryOrders: number;
  deliveryRecovery?: {
    nextCheckAt: number;
  };
};

export type GetAdminProfileViewRequest = {
  ownerWallet: string;
};

export type GetAdminProfileViewResponse = {
  profile: Profile;
};

export type IssueReceiptsResult = {
  processed: boolean;
  deliveryId: number;
  receiptsMinted?: number;
  receiptTxs?: string[];
  closeDeliveryTx?: string | null;
};

export type DeliveryRecoveryOutcome =
  | 'recovered'
  | 'failed'
  | 'lease_active'
  | 'attempt_capped'
  | 'not_eligible'
  | 'missing_delivery'
  | 'not_found'
  | 'skipped_status';

export type RecoverDeliveryOrdersArgs = {
  dropId?: string;
  deliveryId?: number;
  force?: boolean;
};

export type RecoverDeliveryOrdersItemResult = {
  dropId: string;
  deliveryId: number;
  statusBefore: string;
  outcome: DeliveryRecoveryOutcome;
  verification: 'delivery_pda';
  message?: string;
  errorCode?: string;
};

export type RecoverDeliveryOrdersResult = {
  attempted: number;
  recovered: number;
  remainingProcessing: number;
  nextCheckAt?: number;
  walletRecovery: WalletDeliveryRecoveryState;
  results: RecoverDeliveryOrdersItemResult[];
};

export type FulfillmentOrderAddress = {
  label?: string;
  email?: string;
  phone?: string;
  country?: string;
  countryCode?: string;
  hint?: string;
  encrypted?: string;
  full?: string | null;
};

export type FulfillmentOrderBox = {
  boxId: number;
  assetId?: string;
  claimCode?: string;
  receiptClaimCode?: string;
  receiptClaimStatus?: string;
  dudeIds: number[];
};

export type FulfillmentOrderCardClaim = {
  figureId: number;
  assetId?: string;
  receiptClaimCode?: string;
  receiptClaimStatus?: string;
};

export type ShipStationMoney = {
  currency: string;
  amount: number;
};

export type FulfillmentShipStationRate = {
  rateId: string;
  shipmentId: string;
  carrierId: string;
  carrierCode: string;
  carrierName: string;
  carrierNickname?: string;
  serviceCode: string;
  serviceName: string;
  packageType?: string;
  rateType?: string;
  zone?: number;
  carrierDeliveryDays?: string;
  shipDate?: string;
  negotiatedRate?: boolean;
  trackable?: boolean;
  shippingAmount: ShipStationMoney;
  insuranceAmount: ShipStationMoney;
  confirmationAmount: ShipStationMoney;
  otherAmount: ShipStationMoney;
  taxAmount?: ShipStationMoney;
  totalAmount: ShipStationMoney;
  deliveryDays?: number;
  estimatedDeliveryDate?: string;
  guaranteedService: boolean;
  warningMessages: string[];
};

export type FulfillmentShipStationInvalidRate = {
  carrierId: string;
  carrierCode: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  errorMessages: string[];
  responseIssue?: true;
};

export type FulfillmentShipStationLabel = {
  labelId: string;
  shipmentId: string;
  status: 'processing' | 'completed' | 'error' | 'voided';
  rateId?: string;
  trackingNumber?: string;
  carrierId?: string;
  carrierCode?: string;
  carrierName?: string;
  serviceCode?: string;
  serviceName?: string;
  shipmentCost?: ShipStationMoney;
  insuranceCost?: ShipStationMoney;
  totalCost?: ShipStationMoney;
  purchasedAt?: number;
  purchasedBy?: string;
};

export type FulfillmentOrder = {
  dropId: string;
  deliveryId: number;
  owner: string;
  source?: string;
  status: string;
  createdAt?: number;
  processedAt?: number;
  fulfillmentStatus?: FulfillmentStatus;
  fulfillmentTrackingCode?: string;
  fulfillmentUpdatedAt?: number;
  buyerOrderShippedEmailState?: 'pending' | 'queued';
  fulfillmentInternalStatus?: string;
  shipstationShipmentId?: string;
  shipstationAddedAt?: number;
  shipstationPackage?: ShipStationPackageInput;
  shipstationPackageCount?: number;
  shipstationLabel?: FulfillmentShipStationLabel;
  shipstationPurchaseUnknown?: boolean;
  address: FulfillmentOrderAddress;
  boxes: FulfillmentOrderBox[];
  looseDudes: number[];
  /**
   * Optional for compatibility with fulfillment responses created before
   * direct card receipt claims were introduced.
   */
  cardClaims?: FulfillmentOrderCardClaim[];
};

export type StripeCheckoutManualReviewAddress = {
  email?: string;
  country?: string;
  countryCode?: string;
  full?: string | null;
};

export type StripeCheckoutManualReviewSummary = {
  dropId: string;
  sessionId: string;
  owner: string;
  firebaseUid?: string;
  quantity?: number;
  amountTotal?: number;
  currency?: string;
  createdAt?: number;
  failedAt?: number;
  manualRefundReviewReason?: string;
  errorMessage?: string;
  address: StripeCheckoutManualReviewAddress;
};

export type FulfillmentManualReviewCheckout = Omit<StripeCheckoutManualReviewSummary, 'address'> & {
  address: FulfillmentOrderAddress;
};

export type UpdateFulfillmentAddressRequest = {
  dropId: string;
  deliveryId: number;
  full: string;
};

export type UpdateFulfillmentAddressResponse = {
  deliveryId: number;
  address: FulfillmentOrderAddress;
};

export const SHIPSTATION_EDITABLE_ADDRESS_FIELDS = [
  'name',
  'address_line1',
  'address_line2',
  'address_line3',
  'city_locality',
  'state_province',
  'postal_code',
  'country_code',
] as const;

export type ShipStationEditableAddressField = typeof SHIPSTATION_EDITABLE_ADDRESS_FIELDS[number];

export type ShipStationAddressPatch = Partial<Record<ShipStationEditableAddressField, string>>;

export type FulfillmentShipStationAddressCorrectionDetails = {
  kind: 'shipstation-address-correction';
  fields: ShipStationEditableAddressField[];
};

export type AddFulfillmentOrderToShipStationRequest = {
  dropId: string;
  deliveryId: number;
  /** Defaults are used when omitted. */
  package?: ShipStationPackageInput;
  addressPatch?: ShipStationAddressPatch;
};

export type AddFulfillmentOrderToShipStationResponse = {
  deliveryId: number;
  shipmentId: string;
  /** True when the order was already in ShipStation and no new shipment was created. */
  alreadyAdded: boolean;
  shipstationAddedAt?: number;
};

export type GetFulfillmentShipStationRatesRequest = {
  dropId: string;
  deliveryId: number;
  package?: ShipStationPackageInput;
};

export type GetFulfillmentShipStationRatesResponse = {
  deliveryId: number;
  shipmentId: string;
  package?: ShipStationPackageInput;
  packageCount: number;
  rates: FulfillmentShipStationRate[];
  invalidRates: FulfillmentShipStationInvalidRate[];
  label?: FulfillmentShipStationLabel;
  labelDownloadUrl?: string;
  purchaseUnknown?: boolean;
};

export type PurchaseFulfillmentShipStationLabelRequest = {
  dropId: string;
  deliveryId: number;
  rateId: string;
  expectedTotal: ShipStationMoney;
  requestId: string;
};

export type PurchaseFulfillmentShipStationLabelResponse = {
  deliveryId: number;
  shipmentId: string;
  label: FulfillmentShipStationLabel;
  labelDownloadUrl?: string;
  alreadyPurchased: boolean;
};

export type GetFulfillmentShipStationLabelRequest = {
  dropId: string;
  deliveryId: number;
};

export type GetFulfillmentShipStationLabelResponse = {
  deliveryId: number;
  shipmentId: string;
  label?: FulfillmentShipStationLabel;
  labelDownloadUrl?: string;
  purchaseUnknown?: boolean;
};

export type VoidFulfillmentShipStationLabelRequest = {
  dropId: string;
  deliveryId: number;
  labelId: string;
};

export type VoidFulfillmentShipStationLabelResponse = {
  deliveryId: number;
  shipmentId: string;
  label: FulfillmentShipStationLabel & { status: 'voided' };
};

export type FulfillmentOrdersCursor = {
  processedAt: {
    seconds: number;
    nanos: number;
  };
  id: string;
};

export type PreparedTxResponse = {
  encodedTx: string;
  dropId?: string;
  feeLamports?: number;
  deliveryLamports?: number;
  deliveryId?: number;
  certificates?: number[];
  message?: string;
  allowedQuantity?: number;
  orderId?: string;
  certificateId?: string;
};

export type PrepareDeliveryRequest = DeliverySelection & {
  owner: string;
  dropId: string;
};

export const DELIVERY_PREPARE_ATTEMPT_HEADER = 'X-Mons-Delivery-Prepare-Attempt';

export type PrepareDeliveryResponse = {
  encodedTx: string;
  deliveryLamports: number;
  deliveryId: number;
};

export type PrepareIrlClaimRequest = {
  owner: string;
  code: string;
};

export type PrepareIrlClaimResponse = {
  encodedTx: string;
  dropId: string;
  certificates: number[];
  certificateId: string;
  message: string;
};

export type PrepareReceiptTransferRequest = {
  owner: string;
  dropId: string;
  receiptAssetId: string;
  destination: string;
};

export type PrepareReceiptTransferResponse = {
  encodedTx: string;
  dropId: string;
  certificateId: string;
};

export type AdminIrlRedeemPreparedTxResponse = PreparedTxResponse & {
  requestId: string;
  dropId: string;
  adminWallet: string;
  itemCount: number;
  targetKind?: 'pack' | 'card_receipt';
};

export type AdminIrlRedeemFinalizeResult = {
  processed: boolean;
  dropId?: string;
  requestId?: string;
  deliveryId?: number;
  receiptTxs?: string[];
  claimCodes?: string[];
  boxes?: Array<{
    boxId: number;
    receiptAssetId?: string;
    claimCode?: string;
    dudeIds?: number[];
  }>;
  cards?: Array<{
    figureId: number;
    receiptAssetId: string;
    claimCode?: string;
  }>;
};

export type StripeReceiptClaimResult = {
  processed: boolean;
  dropId?: string;
  deliveryId?: number;
  receiptsTransferred?: number;
  receiptTxs?: string[];
  receiptKind?: 'box' | 'figure';
  figureIds?: number[];
  receiptAssetIds?: string[];
};

export type DeliverySelection = {
  itemIds: string[];
  addressId: string;
};
