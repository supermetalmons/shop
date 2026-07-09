import {
  getFunctionsDrop,
  normalizeDropId,
  type FunctionsDropConfig,
} from './config/deployment.js';
import type { BuyerOrderEmailItem } from './notificationEmails.js';

// Keep these production-safe preview rules aligned with the fulfillment dashboard.
// tests/notifications.test.ts compares this resolver against the frontend helpers.
type DeliveryOrderItem = {
  kind: 'box' | 'dude';
  refId: number;
};

type OrderEmailSelection = {
  dropId: string;
};

type OrderEmailItemContext = {
  boxes: DeliveryOrderItem[];
  looseFigureIds: number[];
  assignedFigureIdsByBoxId: Map<number, number[]>;
};

type MediaMapConfig = {
  strategy?: 'direct' | 'cyclic';
  count?: number;
  overrides?: Record<number, number>;
};

const CARD_NFT_2_CDN_BASE_URL = 'https://cdn.lil.org/nft/card_nft_2';
const CARD_NFT_2_PACK_BASE_URL = `${CARD_NFT_2_CDN_BASE_URL}/pack`;
const CARD_NFT_2_FRONT_BASE_URL = `${CARD_NFT_2_CDN_BASE_URL}/fronts_1400`;
const CARD_NFT_2_MAX_CARD_ID = 11133;
const CARD_NFT_2_BOX_MEDIA: MediaMapConfig = {
  strategy: 'cyclic',
  count: 4,
};

const LITTLE_SWAG_BOXES_CDN_BASE_URL = 'https://cdn.lil.org/nft/little_swag_boxes';
const LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL = `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/figures/clean`;
const LITTLE_SWAG_BOXES_BOX_PREVIEW_URL = `${LITTLE_SWAG_BOXES_CDN_BASE_URL}/box/tight.webp`;
const LITTLE_SWAG_BOXES_FIGURE_MEDIA: MediaMapConfig = {
  strategy: 'cyclic',
  count: 333,
  overrides: {
    344: 1,
    353: 90,
    360: 3,
    505: 163,
    650: 285,
    660: 13,
    661: 206,
    662: 82,
    663: 175,
    664: 19,
    665: 92,
    666: 86,
    677: 1,
    686: 90,
    693: 3,
    838: 163,
    983: 285,
    993: 49,
    994: 206,
    995: 21,
    996: 175,
    997: 19,
    998: 92,
    999: 86,
  },
};

const LITTLE_SWAG_HOODIE_CDN_BASE_URL = 'https://cdn.lil.org/nft/little_swag_hoodie';
const LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL = `${LITTLE_SWAG_HOODIE_CDN_BASE_URL}/images/hoodie_clean.webp`;

const PONCHO_DRIFELLA_CDN_BASE_URL = 'https://cdn.lil.org/nft/poncho_drifella';
const PONCHO_DRIFELLA_CLEAN_ITEMS_BASE = `${PONCHO_DRIFELLA_CDN_BASE_URL}/items/clean`;
const PONCHO_DRIFELLA_PACK_PREVIEW_URL = `${PONCHO_DRIFELLA_CDN_BASE_URL}/pack/initial.webp`;

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
}

function getMediaIdForTokenId(tokenId: unknown, mediaMap?: MediaMapConfig): number | null {
  const normalizedTokenId = normalizePositiveInteger(tokenId);
  if (!normalizedTokenId) return null;

  const override = normalizePositiveInteger(mediaMap?.overrides?.[normalizedTokenId]);
  if (override) return override;

  if (mediaMap?.strategy === 'cyclic') {
    const count = normalizePositiveInteger(mediaMap.count);
    if (count) return ((normalizedTokenId - 1) % count) + 1;
  }

  return normalizedTokenId;
}

function listDeliveryOrderItems(order: any): DeliveryOrderItem[] {
  const items = Array.isArray(order?.items) ? order.items : [];
  return items
    .map((item: any) => {
      if (!item || (item.kind !== 'box' && item.kind !== 'dude')) return null;
      const refId = normalizePositiveInteger(item.refId);
      return refId ? ({ kind: item.kind, refId } as DeliveryOrderItem) : null;
    })
    .filter((item): item is DeliveryOrderItem => Boolean(item));
}

function assignedFigureIdsByBoxId(order: any): Map<number, number[]> {
  const result = new Map<number, number[]>();
  const claims = Array.isArray(order?.irlClaims) ? order.irlClaims : [];
  for (const claim of claims) {
    const boxId = normalizePositiveInteger(claim?.boxId);
    if (!boxId) continue;
    const dudeIds = (Array.isArray(claim?.dudeIds) ? claim.dudeIds : [])
      .map((id: unknown) => normalizePositiveInteger(id))
      .filter((id): id is number => Boolean(id))
      .sort((a, b) => a - b);
    if (dudeIds.length) result.set(boxId, dudeIds);
  }
  return result;
}

function orderEmailItemContext(order: any): OrderEmailItemContext {
  const deliveryItems = listDeliveryOrderItems(order);
  return {
    boxes: deliveryItems
      .filter((item) => item.kind === 'box')
      .sort((a, b) => a.refId - b.refId),
    looseFigureIds: deliveryItems
      .filter((item) => item.kind === 'dude')
      .map((item) => item.refId)
      .sort((a, b) => a - b),
    assignedFigureIdsByBoxId: assignedFigureIdsByBoxId(order),
  };
}

function isDirectDeliveryItemsPerBox(itemsPerBox?: number): boolean {
  const parsed = Number(itemsPerBox);
  return Number.isFinite(parsed) && Math.floor(parsed) === 0;
}

function capitalize(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function normalizeWord(value: unknown, fallback: string): string {
  const trimmed = String(value ?? '').trim();
  return trimmed || fallback;
}

function pluralize(word: string): string {
  if (!word) return word;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

function dropAssetLabel(
  source: Pick<FunctionsDropConfig, 'namePrefix' | 'figureNamePrefix'> | undefined,
  kind: 'box' | 'figure',
  count = 1,
): string {
  const singular = kind === 'box' ? normalizeWord(source?.namePrefix, 'box') : normalizeWord(source?.figureNamePrefix, 'figure');
  return count === 1 ? singular : pluralize(singular);
}

function dropAssetReference(
  source: Pick<FunctionsDropConfig, 'namePrefix' | 'figureNamePrefix'> | undefined,
  kind: 'box' | 'figure',
  reference: string | number,
): string {
  return `${capitalize(dropAssetLabel(source, kind, 1))} ${reference}`;
}

function dropMintSelectionLabel(
  source: Pick<FunctionsDropConfig, 'mintSelection'> | undefined,
  reference: number,
): string | undefined {
  const selection = source?.mintSelection;
  if (selection?.kind !== 'size') return undefined;
  return selection.options.find((option) => reference >= option.startId && reference <= option.endId)?.label;
}

function cardNft2AssetUrl(cardId: unknown): string | undefined {
  const normalizedCardId = normalizePositiveInteger(cardId);
  if (!normalizedCardId || normalizedCardId > CARD_NFT_2_MAX_CARD_ID) return undefined;
  return `${CARD_NFT_2_FRONT_BASE_URL}/${String(normalizedCardId).padStart(4, '0')}.webp`;
}

function boxThumbnailUrl(dropId: string, drop: FunctionsDropConfig | undefined, boxId: number): string | undefined {
  const family = drop?.dropFamily || normalizeDropId(dropId);
  if (family === 'card_nft_2') {
    const mediaId = getMediaIdForTokenId(boxId, CARD_NFT_2_BOX_MEDIA);
    return mediaId ? `${CARD_NFT_2_PACK_BASE_URL}/${mediaId}/initial.webp` : undefined;
  }
  if (family === 'little_swag_boxes') return LITTLE_SWAG_BOXES_BOX_PREVIEW_URL;
  if (family === 'little_swag_hoodies') return LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL;
  if (family === 'poncho_drifella') return PONCHO_DRIFELLA_PACK_PREVIEW_URL;
  return undefined;
}

function figureThumbnailUrl(dropId: string, drop: FunctionsDropConfig | undefined, figureId: number): string | undefined {
  const family = drop?.dropFamily || normalizeDropId(dropId);
  if (family === 'card_nft_2') return cardNft2AssetUrl(figureId);
  if (family === 'little_swag_boxes') {
    const mediaId = getMediaIdForTokenId(figureId, LITTLE_SWAG_BOXES_FIGURE_MEDIA) || figureId;
    return `${LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL}/${mediaId}.webp`;
  }
  if (family === 'little_swag_hoodies') return LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL;
  if (family === 'poncho_drifella') return `${PONCHO_DRIFELLA_CLEAN_ITEMS_BASE}/${figureId}.webp`;
  return undefined;
}

function orderFigureLabel(drop: FunctionsDropConfig | undefined, figureId: number): string {
  const family = drop?.dropFamily;
  const reference =
    family === 'little_swag_boxes'
      ? getMediaIdForTokenId(figureId, LITTLE_SWAG_BOXES_FIGURE_MEDIA) || figureId
      : figureId;
  return dropAssetReference(drop, 'figure', reference);
}

function orderFigureItem(dropId: string, drop: FunctionsDropConfig | undefined, figureId: number): BuyerOrderEmailItem {
  const thumbnailUrl = figureThumbnailUrl(dropId, drop, figureId);
  return {
    label: orderFigureLabel(drop, figureId),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function orderBoxItem(
  dropId: string,
  drop: FunctionsDropConfig | undefined,
  boxId: number,
  label: string,
): BuyerOrderEmailItem {
  const thumbnailUrl = boxThumbnailUrl(dropId, drop, boxId);
  return {
    label,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function orderBoxFallbackItem(
  dropId: string,
  drop: FunctionsDropConfig | undefined,
  boxId: number,
): BuyerOrderEmailItem {
  return orderBoxItem(dropId, drop, boxId, dropAssetReference(drop, 'box', boxId));
}

function orderDirectDeliveryItem(
  dropId: string,
  drop: FunctionsDropConfig | undefined,
  boxId: number,
): BuyerOrderEmailItem {
  return orderBoxItem(dropId, drop, boxId, dropMintSelectionLabel(drop, boxId) || dropAssetReference(drop, 'box', boxId));
}

export async function buildOrderEmailItems(
  order: any,
  selectedOrder: OrderEmailSelection,
): Promise<BuyerOrderEmailItem[]> {
  const dropId = normalizeDropId(selectedOrder.dropId);
  const drop = getFunctionsDrop(dropId);
  const context = orderEmailItemContext(order);
  const isDirectDelivery = isDirectDeliveryItemsPerBox(drop?.itemsPerBox);
  const emailItems: BuyerOrderEmailItem[] = [];

  if (isDirectDelivery) {
    for (const box of context.boxes) {
      emailItems.push(orderDirectDeliveryItem(dropId, drop, box.refId));
    }
  } else {
    for (const box of context.boxes) {
      const assignedFigureIds = context.assignedFigureIdsByBoxId.get(box.refId) || [];
      if (!assignedFigureIds.length) {
        emailItems.push(orderBoxFallbackItem(dropId, drop, box.refId));
        continue;
      }
      assignedFigureIds.forEach((figureId) => emailItems.push(orderFigureItem(dropId, drop, figureId)));
    }
  }

  context.looseFigureIds.forEach((figureId) => emailItems.push(orderFigureItem(dropId, drop, figureId)));
  return emailItems;
}

export const buildBuyerOrderEmailItems = buildOrderEmailItems;
