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

export interface MintStats {
  minted: number;
  total: number;
  remaining: number;
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

export interface Profile {
  wallet: string;
  email?: string;
  addresses: ProfileAddress[];
}

export interface PreparedTxResponse {
  encodedTx: string;
  feeLamports?: number;
  deliveryLamports?: number;
  assignedDudeIds?: number[];
  certificates?: number[];
  message?: string;
  allowedQuantity?: number;
  recorded?: number;
  attemptId?: string;
  lockExpiresAt?: number;
  orderId?: string;
  certificateId?: string;
}

export interface DeliverySelection {
  itemIds: string[];
  addressId: string;
}
