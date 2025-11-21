export type AssetKind = 'box' | 'dude' | 'certificate';

export interface InventoryItem {
  id: string;
  name: string;
  kind: AssetKind;
  image?: string;
  attributes?: string[];
  boxId?: string;
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
  hint: string;
  encrypted: string;
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
  assignedDudeIds?: string[];
  certificates?: string[];
  message?: string;
}

export interface DeliverySelection {
  itemIds: string[];
  addressId: string;
}
