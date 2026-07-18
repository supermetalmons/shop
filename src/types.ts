import type { FulfillmentStatus } from './lib/fulfillmentStatus';

export type { FulfillmentStatus } from './lib/fulfillmentStatus';

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

export interface PackStatusBreakdownItem {
  key: 'redeemed' | 'unsealed' | 'total';
  label: string;
  amount: number;
  percentage: number;
}

export interface PackStatusBreakdown {
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
}

export interface PackStatusDisplayLabels {
  itemColumnLabel: string;
  ariaLabel: string;
}

export interface ProfileAddress {
  id: string;
  country: string;
  countryCode?: string;
  countryName?: string;
  hint: string;
  encrypted: string;
  email?: string;
}

interface DeliveryOrderItemSummary {
  kind: 'box' | 'dude';
  refId: number;
}

export interface DeliveryOrderSummary {
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
}

interface DeliveryRecoveryState {
  nextCheckAt?: number;
}

export interface Profile {
  wallet: string;
  email?: string;
  orders?: DeliveryOrderSummary[];
  deliveryRecovery?: DeliveryRecoveryState;
}

export interface IssueReceiptsResult {
  processed: boolean;
  deliveryId: number;
  receiptsMinted?: number;
  receiptTxs?: string[];
  closeDeliveryTx?: string | null;
}

type DeliveryRecoveryOutcome =
  | 'recovered'
  | 'failed'
  | 'lease_active'
  | 'attempt_capped'
  | 'not_eligible'
  | 'missing_delivery'
  | 'not_found'
  | 'skipped_status';

export interface RecoverDeliveryOrdersArgs {
  dropId?: string;
  deliveryId?: number;
  force?: boolean;
}

interface RecoverDeliveryOrdersItemResult {
  dropId: string;
  deliveryId: number;
  statusBefore: string;
  outcome: DeliveryRecoveryOutcome;
  verification: 'delivery_pda';
  message?: string;
  errorCode?: string;
}

export interface RecoverDeliveryOrdersResult {
  attempted: number;
  recovered: number;
  remainingProcessing: number;
  nextCheckAt?: number;
  results: RecoverDeliveryOrdersItemResult[];
}

export interface FulfillmentOrderAddress {
  label?: string;
  email?: string;
  phone?: string;
  country?: string;
  countryCode?: string;
  hint?: string;
  encrypted?: string;
  full?: string | null;
}

export interface FulfillmentOrderBox {
  boxId: number;
  assetId?: string;
  claimCode?: string;
  receiptClaimCode?: string;
  receiptClaimStatus?: string;
  dudeIds: number[];
}

export interface FulfillmentOrderCardClaim {
  figureId: number;
  assetId?: string;
  receiptClaimCode?: string;
  receiptClaimStatus?: string;
}

export interface FulfillmentOrder {
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
  fulfillmentInternalStatus?: string;
  address: FulfillmentOrderAddress;
  boxes: FulfillmentOrderBox[];
  looseDudes: number[];
  cardClaims?: FulfillmentOrderCardClaim[];
}

export interface FulfillmentManualReviewCheckout {
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
  address: FulfillmentOrderAddress;
}

export interface FulfillmentOrdersCursor {
  processedAt: {
    seconds: number;
    nanos: number;
  };
  id: string;
}

export interface PreparedTxResponse {
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
}

export interface AdminIrlRedeemPreparedTxResponse extends PreparedTxResponse {
  requestId: string;
  dropId: string;
  adminWallet: string;
  itemCount: number;
  targetKind?: 'pack' | 'card_receipt';
}

export interface AdminIrlRedeemFinalizeResult {
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
}

export interface StripeReceiptClaimResult {
  processed: boolean;
  dropId?: string;
  deliveryId?: number;
  receiptsTransferred?: number;
  receiptTxs?: string[];
  receiptKind?: 'box' | 'figure';
  figureIds?: number[];
  receiptAssetIds?: string[];
}

export interface DeliverySelection {
  itemIds: string[];
  addressId: string;
}
