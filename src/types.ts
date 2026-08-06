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
  FulfillmentShipStationRate,
  GetFulfillmentShipStationLabelRequest,
  GetFulfillmentShipStationLabelResponse,
  GetFulfillmentShipStationRatesRequest,
  GetFulfillmentShipStationRatesResponse,
  IssueReceiptsResult,
  ListCardNft2UnrevealedCardsRequest,
  ListCardNft2UnrevealedCardsResponse,
  PackStatusBreakdown,
  PackStatusBreakdownItem,
  PreparedTxResponse,
  Profile,
  ProfileAddress,
  PurchaseFulfillmentShipStationLabelRequest,
  PurchaseFulfillmentShipStationLabelResponse,
  RecoverDeliveryOrdersArgs,
  RecoverDeliveryOrdersResult,
  StripeCheckoutSessionRequest,
  StripeCheckoutSessionResponse,
  StripeReceiptClaimResult,
  SubscribeToNotificationsRequest,
  SubscribeToNotificationsResponse,
  ShipStationMoney,
} from '../functions/src/shared/contracts';
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
