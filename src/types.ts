export type AssetKind = 'box' | 'dude' | 'certificate';

export interface InventoryItem {
  id: string;
  dropId: string;
  name: string;
  kind: AssetKind;
  image?: string;
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

export interface ProfileAddress {
  id: string;
  country: string;
  countryCode?: string;
  countryName?: string;
  hint: string;
  encrypted: string;
  email?: string;
}

export interface DeliveryOrderItemSummary {
  kind: 'box' | 'dude';
  refId: number;
}

export type FulfillmentStatus = 'Preparing' | 'Shipped';

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
  fulfillmentUpdatedAt?: number;
}

export interface DeliveryRecoveryState {
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

export type DeliveryRecoveryOutcome =
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

export interface RecoverDeliveryOrdersItemResult {
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

export interface FulfillmentOrder {
  dropId: string;
  deliveryId: number;
  owner: string;
  status: string;
  createdAt?: number;
  processedAt?: number;
  fulfillmentStatus?: FulfillmentStatus;
  fulfillmentUpdatedAt?: number;
  fulfillmentInternalStatus?: string;
  address: FulfillmentOrderAddress;
  boxes: FulfillmentOrderBox[];
  looseDudes: number[];
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

export interface DeliverySelection {
  itemIds: string[];
  addressId: string;
}
