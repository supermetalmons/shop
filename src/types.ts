export type { FulfillmentStatus } from './lib/fulfillmentStatus';
export type {
  AddFulfillmentOrderToShipStationRequest,
  AddFulfillmentOrderToShipStationResponse,
  AdminIrlRedeemFinalizeResult,
  AdminIrlRedeemPreparedTxResponse,
  DeliveryOrderSummary,
  DeliverySelection,
  FulfillmentManualReviewCheckout,
  FulfillmentOrder,
  FulfillmentOrderAddress,
  FulfillmentOrderBox,
  FulfillmentOrderCardClaim,
  FulfillmentOrdersCursor,
  FulfillmentShipStationInvalidRate,
  FulfillmentShipStationRate,
  FulfillmentShipStationAddressCorrectionDetails,
  GetAdminProfileViewRequest,
  GetAdminProfileViewResponse,
  GetProfileStateResponse,
  GetFulfillmentShipStationLabelRequest,
  GetFulfillmentShipStationLabelResponse,
  GetFulfillmentShipStationRatesRequest,
  GetFulfillmentShipStationRatesResponse,
  IssueReceiptsResult,
  PackStatusBreakdown,
  PackStatusBreakdownItem,
  PrepareIrlClaimRequest,
  PrepareIrlClaimResponse,
  PreparedTxResponse,
  Profile,
  ProfileAddress,
  ProfileStateProfile,
  ProfileStateSection,
  PurchaseFulfillmentShipStationLabelRequest,
  PurchaseFulfillmentShipStationLabelResponse,
  RecoverDeliveryOrdersArgs,
  RecoverDeliveryOrdersResult,
  ReconcileProfileStateRequest,
  ReconcileProfileStateResponse,
  StripeCheckoutSessionRequest,
  StripeCheckoutSessionResponse,
  StripeReceiptClaimResult,
  SubscribeToNotificationsRequest,
  SubscribeToNotificationsResponse,
  ShipStationMoney,
  ShipStationAddressPatch,
  ShipStationEditableAddressField,
  UpdateFulfillmentAddressRequest,
  UpdateFulfillmentAddressResponse,
  VoidFulfillmentShipStationLabelRequest,
  VoidFulfillmentShipStationLabelResponse,
} from '../functions/src/shared/contracts';
export { SHIPSTATION_EDITABLE_ADDRESS_FIELDS } from '../functions/src/shared/contracts';
export type { ShipStationPackageInput } from '../functions/src/shared/shipstationPackage';

type AssetKind = 'box' | 'dude' | 'certificate';

export type PreviewVideoSource = {
  src: string;
  type?: string;
};

export type InventoryPreviewVideo = {
  sources: readonly PreviewVideoSource[];
  posterSrc?: string;
};

export interface InventoryItem {
  id: string;
  dropId: string;
  name: string;
  kind: AssetKind;
  image?: string;
  previewVideo?: InventoryPreviewVideo;
  attributes?: { trait_type: string; value: string }[];
  boxId?: string;
  dudeId?: number;
  assignedDudes?: string[];
  status?: 'minted' | 'opened' | 'delivered' | 'pending';
}

export interface PendingOpenBox {
  dropId: string;
  pendingPda: string;
  boxAssetId: string;
  dudeAssetIds: string[];
  createdSlot?: number;
}

export interface MintStats {
  minted: number;
  total: number;
  remaining: number;
  maxPerTx?: number;
  priceLamports?: number;
  discountMintsPerWallet?: number;
  mintSelectionAvailability?: Record<string, number>;
}

export interface PackStatusDisplayLabels {
  itemColumnLabel: string;
  ariaLabel: string;
}
