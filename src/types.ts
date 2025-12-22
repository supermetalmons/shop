export type AssetKind = 'box' | 'dude' | 'certificate';

export interface InventoryItem {
  id: string;
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
}

export interface ProfileAddress {
  id: string;
  label: string;
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

export interface DeliveryOrderSummary {
  deliveryId: number;
  status: string;
  createdAt?: number;
  processedAt?: number;
  items: DeliveryOrderItemSummary[];
  fulfillmentStatus?: string;
  fulfillmentUpdatedAt?: number;
}

export interface Profile {
  wallet: string;
  email?: string;
  addresses: ProfileAddress[];
  orders?: DeliveryOrderSummary[];
}

export interface FulfillmentOrderAddress {
  label?: string;
  email?: string;
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
  dudeIds: number[];
}

export interface FulfillmentOrder {
  deliveryId: number;
  owner: string;
  status: string;
  createdAt?: number;
  processedAt?: number;
  fulfillmentStatus?: string;
  fulfillmentUpdatedAt?: number;
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
