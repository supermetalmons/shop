import {
  BOX_MINTER_MAX_ITEMS_PER_BOX,
  BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX,
} from './boxMinterProtocol.ts';
import type { PackStatusBreakdown, PackStatusBreakdownItem } from './contracts.ts';
import { isBase58Bytes } from './solanaRpcProxy.ts';

type ShopApiBaseRequest = {
  owner: string;
  includeDevnet?: boolean;
};

export const SHOP_EXPECTED_ASSET_IDS_MAX = 15;

export type ShopExpectedAssetIds = {
  'mainnet-beta'?: string[];
  devnet?: string[];
};

export type ShopInventoryRequest = ShopApiBaseRequest & {
  expectedAssetIds?: ShopExpectedAssetIds;
};

export type ShopPendingOpenBoxesRequest = ShopApiBaseRequest;

type LegacyShopApiAttribute = {
  trait_type: string;
  value: string;
};

export const SHOP_INVENTORY_NAME_MAX_UTF8_BYTES = 256;
export const SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES = 512;
export const SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES = 64;
export const SHOP_API_MAX_RESPONSE_ITEMS = 6000;
const SHOP_PENDING_OPEN_MIN_DUDE_ASSET_IDS = BOX_MINTER_MIN_OPENABLE_ITEMS_PER_BOX;
export const SHOP_PENDING_OPEN_MAX_DUDE_ASSET_IDS = BOX_MINTER_MAX_ITEMS_PER_BOX;

const UTF8_ENCODER = new TextEncoder();

export function shopApiUtf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function isShopApiStringWithinUtf8Limit(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && shopApiUtf8ByteLength(value) <= maxBytes;
}

export function truncateShopApiStringToUtf8Bytes(value: string, maxBytes: number): string {
  if (shopApiUtf8ByteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = shopApiUtf8ByteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export type ShopInventoryItem = {
  id: string;
  dropId: string;
  name: string;
  kind: 'box' | 'dude' | 'certificate';
  rawImage?: string;
  boxId?: string;
  dudeId?: number;
};

export type ShopPendingOpenBox = {
  dropId: string;
  pendingPda: string;
  boxAssetId: string;
  dudeAssetIds: string[];
  createdSlot?: number;
};

export type ShopInventoryResponse = {
  ok: true;
  items: ShopInventoryItem[];
};

export type ShopPendingOpenBoxesResponse = {
  ok: true;
  items: ShopPendingOpenBox[];
};

export type ShopPackStatusResponse = {
  ok: true;
  packStatus: PackStatusBreakdown | null;
};

type ShopApiErrorCode =
  | 'invalid-request'
  | 'not-found'
  | 'method-not-allowed'
  | 'rate-limited'
  | 'rate-limit-unavailable'
  | 'provider-timeout'
  | 'provider-unavailable';

export type ShopApiErrorResponse = {
  ok: false;
  error: ShopApiErrorCode;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => allowed.has(key));
}

function isExactShopApiBaseRequest(
  value: Record<string, unknown>,
  optional: readonly string[] = [],
): boolean {
  if (!hasExactKeys(value, ['owner'], ['includeDevnet', ...optional])) return false;
  if (typeof value.owner !== 'string') return false;
  return value.includeDevnet === undefined || typeof value.includeDevnet === 'boolean';
}

function isExactShopExpectedAssetIds(
  value: unknown,
  includeDevnet: boolean,
): value is ShopExpectedAssetIds {
  if (!isRecord(value) || !hasExactKeys(value, [], ['mainnet-beta', 'devnet'])) return false;
  const groups = [value['mainnet-beta'], value.devnet].filter((group) => group !== undefined);
  if (!groups.length || (value.devnet !== undefined && !includeDevnet)) return false;
  const seen = new Set<string>();
  let count = 0;
  for (const group of groups) {
    if (!Array.isArray(group) || group.length === 0) return false;
    for (const id of group) {
      if (typeof id !== 'string' || !isBase58Bytes(id, 32) || seen.has(id)) return false;
      seen.add(id);
      count += 1;
      if (count > SHOP_EXPECTED_ASSET_IDS_MAX) return false;
    }
  }
  return count > 0;
}

export function isExactShopInventoryRequest(value: unknown): value is ShopInventoryRequest {
  if (!isRecord(value) || !isExactShopApiBaseRequest(value, ['expectedAssetIds'])) return false;
  return value.expectedAssetIds === undefined ||
    isExactShopExpectedAssetIds(value.expectedAssetIds, value.includeDevnet === true);
}

export function isExactShopPendingOpenBoxesRequest(value: unknown): value is ShopPendingOpenBoxesRequest {
  return isRecord(value) && isExactShopApiBaseRequest(value);
}

function isExactLegacyShopApiAttribute(value: unknown): value is LegacyShopApiAttribute {
  return isRecord(value) &&
    hasExactKeys(value, ['trait_type', 'value']) &&
    typeof value.trait_type === 'string' &&
    typeof value.value === 'string';
}

function isExactShopInventoryItem(value: unknown): value is ShopInventoryItem {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['id', 'dropId', 'name', 'kind'],
    ['rawImage', 'attributes', 'boxId', 'dudeId'],
  )) return false;
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.dropId !== 'string' ||
    value.dropId.length === 0 ||
    !isShopApiStringWithinUtf8Limit(value.name, SHOP_INVENTORY_NAME_MAX_UTF8_BYTES) ||
    value.name.length === 0 ||
    (value.kind !== 'box' && value.kind !== 'dude' && value.kind !== 'certificate')
  ) return false;
  if (
    value.rawImage !== undefined &&
    (!isShopApiStringWithinUtf8Limit(value.rawImage, SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES) || value.rawImage.length === 0)
  ) return false;
  if (
    value.boxId !== undefined &&
    (!isShopApiStringWithinUtf8Limit(value.boxId, SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES) || value.boxId.length === 0)
  ) return false;
  if (value.dudeId !== undefined && (!Number.isSafeInteger(value.dudeId) || Number(value.dudeId) <= 0)) return false;
  return value.attributes === undefined ||
    (Array.isArray(value.attributes) && value.attributes.every(isExactLegacyShopApiAttribute));
}

function isExactShopPendingOpenBox(value: unknown): value is ShopPendingOpenBox {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['dropId', 'pendingPda', 'boxAssetId', 'dudeAssetIds'],
    ['createdSlot'],
  )) return false;
  if (
    typeof value.dropId !== 'string' ||
    value.dropId.length === 0 ||
    typeof value.pendingPda !== 'string' ||
    value.pendingPda.length === 0 ||
    typeof value.boxAssetId !== 'string' ||
    value.boxAssetId.length === 0 ||
    !Array.isArray(value.dudeAssetIds) ||
    value.dudeAssetIds.length < SHOP_PENDING_OPEN_MIN_DUDE_ASSET_IDS ||
    value.dudeAssetIds.length > SHOP_PENDING_OPEN_MAX_DUDE_ASSET_IDS ||
    !value.dudeAssetIds.every((id) => typeof id === 'string' && id.length > 0)
  ) return false;
  return value.createdSlot === undefined ||
    (Number.isSafeInteger(value.createdSlot) && Number(value.createdSlot) >= 0);
}

function isExactShopPackStatusBreakdownItem(value: unknown): value is PackStatusBreakdownItem {
  return isRecord(value) &&
    hasExactKeys(value, ['key', 'label', 'amount', 'percentage']) &&
    (value.key === 'redeemed' || value.key === 'unsealed' || value.key === 'total') &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    Number.isSafeInteger(value.amount) &&
    Number(value.amount) >= 0 &&
    typeof value.percentage === 'number' &&
    Number.isFinite(value.percentage) &&
    value.percentage >= 0;
}

function isExactShopPackStatusBreakdown(value: unknown): value is PackStatusBreakdown {
  if (!isRecord(value) || !hasExactKeys(value, [
    'dropId',
    'total',
    'totalInitialSupply',
    'totalCards',
    'cardsPerPack',
    'unsealedOnline',
    'unsealedCards',
    'redeemedIrl',
    'redeemedIrlNormal',
    'redeemedIrlStripe',
    'redeemedUnsealedCards',
    'redeemedCards',
    'items',
  ])) return false;
  if (
    typeof value.dropId !== 'string' ||
    value.dropId.length === 0 ||
    ![
      value.total,
      value.totalInitialSupply,
      value.totalCards,
      value.cardsPerPack,
      value.unsealedOnline,
      value.unsealedCards,
      value.redeemedIrl,
      value.redeemedIrlNormal,
      value.redeemedIrlStripe,
      value.redeemedUnsealedCards,
      value.redeemedCards,
    ].every((amount) => Number.isSafeInteger(amount) && Number(amount) >= 0) ||
    !Array.isArray(value.items) ||
    value.items.length !== 3 ||
    !value.items.every(isExactShopPackStatusBreakdownItem)
  ) return false;
  return new Set(value.items.map((item) => item.key)).size === 3;
}

export function isExactShopInventoryResponse(value: unknown): value is ShopInventoryResponse {
  return isRecord(value) &&
    hasExactKeys(value, ['ok', 'items']) &&
    value.ok === true &&
    Array.isArray(value.items) &&
    value.items.length <= SHOP_API_MAX_RESPONSE_ITEMS &&
    value.items.every(isExactShopInventoryItem);
}

export function isExactShopPendingOpenBoxesResponse(value: unknown): value is ShopPendingOpenBoxesResponse {
  return isRecord(value) &&
    hasExactKeys(value, ['ok', 'items']) &&
    value.ok === true &&
    Array.isArray(value.items) &&
    value.items.length <= SHOP_API_MAX_RESPONSE_ITEMS &&
    value.items.every(isExactShopPendingOpenBox);
}

export function isExactShopPackStatusResponse(value: unknown): value is ShopPackStatusResponse {
  return isRecord(value) &&
    hasExactKeys(value, ['ok', 'packStatus']) &&
    value.ok === true &&
    (value.packStatus === null || isExactShopPackStatusBreakdown(value.packStatus));
}

export function isExactShopApiErrorResponse(value: unknown): value is ShopApiErrorResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['ok', 'error']) || value.ok !== false) return false;
  return value.error === 'invalid-request' ||
    value.error === 'not-found' ||
    value.error === 'method-not-allowed' ||
    value.error === 'rate-limited' ||
    value.error === 'rate-limit-unavailable' ||
    value.error === 'provider-timeout' ||
    value.error === 'provider-unavailable';
}
