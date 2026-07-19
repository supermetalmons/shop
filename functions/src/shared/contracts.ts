import type { FulfillmentStatus } from './fulfillmentStatus.js';

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

export type ListCardNft2UnrevealedCardsRequest = {
  limit?: number;
  cursor?: number;
};

export type ListCardNft2UnrevealedCardsResponse = {
  ids: number[];
  nextCursor?: number;
  hasMore: boolean;
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

export type StripeCheckoutSessionServerResponse = Omit<StripeCheckoutSessionResponse, 'livemode'> & {
  livemode: boolean;
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

export type DeliveryRecoveryState = {
  nextCheckAt?: number;
};

export type Profile = {
  wallet: string;
  email?: string;
  orders?: DeliveryOrderSummary[];
  deliveryRecovery?: DeliveryRecoveryState;
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
  fulfillmentInternalStatus?: string;
  address: FulfillmentOrderAddress;
  boxes: FulfillmentOrderBox[];
  looseDudes: number[];
  /**
   * Optional for compatibility with fulfillment responses created before
   * direct card receipt claims were introduced.
   */
  cardClaims?: FulfillmentOrderCardClaim[];
};

export type FulfillmentOrderWithCardClaims = Omit<FulfillmentOrder, 'cardClaims'> & {
  cardClaims: FulfillmentOrderCardClaim[];
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
