import type { EthereumArtworkAspectRatio, EthereumArtworkCategory } from './reveal.ts';

export const ETHEREUM_111K_DROP_ID = '111k_devnet' as const;
const ARTWORK_COUNT = 111_111;
const CRATE_COUNT = 5_555;
const WAREHOUSE_COUNT = 505;
export const ETHEREUM_MAX_MONUMENTS = 18;
export const ETHEREUM_CRATES_PER_MONUMENT = 111;
const ARTWORK_RECEIPT_COUNT = 2 * ARTWORK_COUNT;
const ARTWORK_RECEIPT_OFFSET = 1_000_000n;
const CRATE_RECEIPT_OFFSET = 2_000_000n;
const MONUMENT_RECEIPT_OFFSET = 3_000_000n;
export const ETHEREUM_MAX_MINT_QUANTITY = 15;
export const ETHEREUM_MAX_UNBOX_QUANTITY = 15;
export const ETHEREUM_MAX_DELIVERY_ITEMS = 50;
export const ETHEREUM_MAX_TOKEN_INFO_BATCH_SIZE = 150;
export const ETHEREUM_MAX_EXPECTED_IDS = 500;
export const ETHEREUM_MAX_INVENTORY_EXPECTED_IDS = 2 * ETHEREUM_MAX_EXPECTED_IDS;
export const ETHEREUM_INVENTORY_EXPECTED_REQUEST_SIZE = 100;
export const ETHEREUM_AUTHORIZATION_TTL_SECONDS = 600;

export type Hex = `0x${string}`;
export const ETHEREUM_MINT_KINDS = ['crate', 'warehouse', 'monument'] as const;
export type EthereumMintKind = typeof ETHEREUM_MINT_KINDS[number];
export type EthereumItemKind = 'artwork' | EthereumMintKind | 'artwork_receipt' | 'crate_receipt' | 'monument_receipt';
export type EthereumDeliveryKind = 'artwork' | 'crate' | 'monument';
export const ETHEREUM_ITEM_KINDS: readonly EthereumItemKind[] = [
  'artwork', 'crate', 'warehouse', 'artwork_receipt', 'crate_receipt', 'monument', 'monument_receipt',
];

export function isEthereumDeliveryKind(kind: EthereumItemKind): kind is EthereumDeliveryKind {
  return kind === 'artwork' || kind === 'crate' || kind === 'monument';
}

export function ethereumItemKind(value: number): EthereumItemKind | null {
  return ETHEREUM_ITEM_KINDS[value - 1] ?? null;
}

export function ethereumItemDisplayIdMaximum(kind: EthereumItemKind): number {
  if (kind === 'warehouse') return WAREHOUSE_COUNT;
  if (kind === 'monument' || kind === 'monument_receipt') return ETHEREUM_MAX_MONUMENTS;
  if (kind === 'crate' || kind === 'crate_receipt') return CRATE_COUNT;
  return kind === 'artwork_receipt' ? ARTWORK_RECEIPT_COUNT : ARTWORK_COUNT;
}

export function ethereumMetadataTokenId(kind: EthereumItemKind, displayId: number): string {
  if (!ETHEREUM_ITEM_KINDS.includes(kind) || !Number.isInteger(displayId) || displayId < 1 ||
    displayId > ethereumItemDisplayIdMaximum(kind)) throw new Error('Invalid item number');
  if (kind === 'artwork') return String(displayId);
  if (kind === 'crate') return String(ARTWORK_COUNT + displayId);
  if (kind === 'warehouse') return String(ARTWORK_COUNT + CRATE_COUNT + displayId);
  if (kind === 'monument') return String(ARTWORK_COUNT + CRATE_COUNT + WAREHOUSE_COUNT + displayId);
  if (kind === 'monument_receipt') return (MONUMENT_RECEIPT_OFFSET + BigInt(displayId)).toString();
  return ((kind === 'artwork_receipt' ? ARTWORK_RECEIPT_OFFSET : CRATE_RECEIPT_OFFSET) + BigInt(displayId)).toString();
}

export function normalizeEthereumAddress(value: unknown): Hex | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase() as Hex : null;
}

export function requireEthereumAddress(value: unknown): Hex {
  const address = normalizeEthereumAddress(value);
  if (!address) throw new Error('Invalid Ethereum address');
  return address;
}

export function normalizeEthereumTokenId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)) return null;
  try {
    const id = BigInt(value);
    return id > 0n && id < (1n << 256n) ? id.toString() : null;
  } catch { return null; }
}

export function ethereumAssetId(chainId: number, contract: string, tokenId: string): string {
  const id = normalizeEthereumTokenId(tokenId);
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !id) throw new Error('Invalid Ethereum asset identity');
  return `eip155:${chainId}:${requireEthereumAddress(contract)}:${id}`;
}

function crateArtworkIds(crateId: number): number[] {
  if (!Number.isInteger(crateId) || crateId < 1 || crateId > CRATE_COUNT) throw new Error('Invalid crate number');
  const count = crateId === CRATE_COUNT ? 31 : 20;
  return Array.from({ length: count }, (_, index) => (crateId - 1) * 20 + index + 1);
}

export function physicalCrateArtworkIds(crateId: number): number[] {
  return crateArtworkIds(crateId).map(id => ARTWORK_COUNT + id);
}

export function ethereumReceiptTokenId(kind: EthereumDeliveryKind, displayId: number): string {
  const maximum = ethereumItemDisplayIdMaximum(kind);
  if (!Number.isInteger(displayId) || displayId < 1 || displayId > maximum) throw new Error('Invalid item number');
  const offset = kind === 'artwork' ? ARTWORK_RECEIPT_OFFSET : kind === 'crate' ? CRATE_RECEIPT_OFFSET : MONUMENT_RECEIPT_OFFSET;
  return (offset + BigInt(displayId)).toString();
}

export function formatEtherAmount(wei: string | bigint, fractionDigits = 6): string {
  const amount = BigInt(wei);
  if (amount < 0n) throw new Error('Invalid ETH amount');
  const whole = amount / 10n ** 18n;
  const fraction = (amount % 10n ** 18n).toString().padStart(18, '0').slice(0, Math.max(0, Math.min(18, fractionDigits))).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

export function ethereumHexQuantity(value: bigint | number | string): Hex {
  const parsed = BigInt(value);
  if (parsed < 0n) throw new Error('Invalid Ethereum quantity');
  return `0x${parsed.toString(16)}`;
}

export type EthereumMetadata = {
  name: string;
  description?: string;
  image: string;
  animation_url?: string;
  aspectRatio?: EthereumArtworkAspectRatio;
  category?: EthereumArtworkCategory;
  revealStatus?: 'unrevealed' | 'revealed';
  attributes?: Array<{ trait_type: string; value: string | number }>;
};

export type EthereumInventoryItem = EthereumMetadata & {
  id: string;
  chainId: number;
  contractAddress: string;
  owner: string;
  tokenId: string;
  kind: EthereumItemKind;
  displayId: number;
};

export type EthereumDeliveryQuote = {
  orderId: number;
  wallet: string;
  fee: string;
  deadline: number;
  receiptIdsHash: string;
};

export const ETHEREUM_FUNCTIONS = {
  mintCrates: 'mintCrates(uint256)',
  mintCratesDiscounted: 'mintCratesDiscounted(uint256,bytes32[])',
  mintWarehouses: 'mintWarehouses(uint256)',
  mintMonuments: 'mintMonuments(uint256)',
  unboxCrate: 'unboxCrate(uint256)',
  unboxCrates: 'unboxCrates(uint256[])',
  unboxWarehouse: 'unboxWarehouse(uint256)',
  unboxMonument: 'unboxMonument(uint256)',
  transfer: 'safeTransferFrom(address,address,uint256)',
  redeemForDelivery: 'redeemForDelivery(uint256[],(uint256,address,uint256,uint256,bytes32),bytes)',
  claimCrateReceipt: 'claimCrateReceipt(uint256,bytes32,uint256,bytes)',
  tokenInfo: 'getTokenInfo(uint256)',
  tokenInfos: 'getTokenInfos(uint256[])',
  tokenURI: 'tokenURI(uint256)',
  previewTokenURI: 'previewTokenURI(uint8,uint256)',
  previewTokenURIs: 'previewTokenURIs(uint8[],uint256[])',
  stats: 'stats(address)',
} as const;
