import {
  getFunctionsDrop,
  normalizeDropId,
  type FunctionsDropConfig,
} from './config/deployment.js';
import type {
  BuyerVisibleOrderEmailItem,
  NotificationEmailItem,
  ShipperVisibleOrderEmailItem,
} from './notificationEmails.js';
import { cardNft2AssetUrl } from './shared/cardNft2AssetCore.js';
import {
  CARD_NFT_2_BOX_MEDIA,
  CARD_NFT_2_PACK_BASE_URL,
  LITTLE_SWAG_BOXES_BOX_PREVIEW_IMAGE_URL,
  LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL,
  LITTLE_SWAG_BOXES_FIGURE_MEDIA,
  LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL,
  PONCHO_DRIFELLA_CLEAN_ITEMS_BASE_URL,
  PONCHO_DRIFELLA_PACK_INITIAL_IMAGE_URL,
} from './shared/dropMediaDefaults.js';
import {
  dropAssetReference,
  dropMintSelectionLabel,
} from './shared/dropLabels.js';
import {
  getMediaIdForTokenId,
  normalizePositiveInteger,
} from './shared/mediaMap.js';
import { isDirectDeliveryItemsPerBox } from './shared/shipping.js';

// Keep these email previews limited to what the buyer could already see at order time.
type DeliveryOrderItem = {
  kind: 'box' | 'dude';
  refId: number;
};

type OrderEmailSelection = {
  dropId: string;
};

type OrderEmailAudience = 'buyer' | 'shipper';

type OrderEmailItemContext = {
  boxes: DeliveryOrderItem[];
  looseFigureIds: number[];
};

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
  };
}

function boxThumbnailUrl(dropId: string, drop: FunctionsDropConfig | undefined, boxId: number): string | undefined {
  const family = drop?.dropFamily || normalizeDropId(dropId);
  if (family === 'card_nft_2') {
    const mediaId = getMediaIdForTokenId(boxId, CARD_NFT_2_BOX_MEDIA);
    return mediaId ? `${CARD_NFT_2_PACK_BASE_URL}/${mediaId}/initial.webp` : undefined;
  }
  if (family === 'little_swag_boxes') return LITTLE_SWAG_BOXES_BOX_PREVIEW_IMAGE_URL;
  if (family === 'little_swag_hoodies') return LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL;
  if (family === 'poncho_drifella') return PONCHO_DRIFELLA_PACK_INITIAL_IMAGE_URL;
  return undefined;
}

function figureThumbnailUrl(dropId: string, drop: FunctionsDropConfig | undefined, figureId: number): string | undefined {
  const family = drop?.dropFamily || normalizeDropId(dropId);
  if (family === 'card_nft_2') return cardNft2AssetUrl('img', figureId);
  if (family === 'little_swag_boxes') {
    const mediaId = getMediaIdForTokenId(figureId, LITTLE_SWAG_BOXES_FIGURE_MEDIA) || figureId;
    return `${LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL}/${mediaId}.webp`;
  }
  if (family === 'little_swag_hoodies') return LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL;
  if (family === 'poncho_drifella') return `${PONCHO_DRIFELLA_CLEAN_ITEMS_BASE_URL}/${figureId}.webp`;
  return undefined;
}

function orderFigureLabel(
  drop: FunctionsDropConfig | undefined,
  figureId: number,
  audience: OrderEmailAudience,
): string {
  const family = drop?.dropFamily;
  const reference =
    audience === 'shipper' && family === 'little_swag_boxes'
      ? getMediaIdForTokenId(figureId, LITTLE_SWAG_BOXES_FIGURE_MEDIA) || figureId
      : figureId;
  return dropAssetReference(drop, 'figure', reference);
}

function orderFigureItem(
  dropId: string,
  drop: FunctionsDropConfig | undefined,
  figureId: number,
  audience: OrderEmailAudience,
): NotificationEmailItem {
  const thumbnailUrl = figureThumbnailUrl(dropId, drop, figureId);
  return {
    label: orderFigureLabel(drop, figureId, audience),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function orderBoxItem(
  dropId: string,
  drop: FunctionsDropConfig | undefined,
  boxId: number,
  label: string,
): NotificationEmailItem {
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
): NotificationEmailItem {
  return orderBoxItem(dropId, drop, boxId, dropAssetReference(drop, 'box', boxId));
}

function orderDirectDeliveryItem(
  dropId: string,
  drop: FunctionsDropConfig | undefined,
  boxId: number,
): NotificationEmailItem {
  return orderBoxItem(dropId, drop, boxId, dropMintSelectionLabel(drop, boxId) || dropAssetReference(drop, 'box', boxId));
}

function buildAudienceVisibleOrderEmailItems(
  order: any,
  selectedOrder: OrderEmailSelection,
  audience: OrderEmailAudience,
): NotificationEmailItem[] {
  const dropId = normalizeDropId(selectedOrder.dropId);
  const drop = getFunctionsDrop(dropId);
  const context = orderEmailItemContext(order);
  const isDirectDelivery = isDirectDeliveryItemsPerBox(drop?.itemsPerBox);
  const emailItems: NotificationEmailItem[] = [];

  if (isDirectDelivery) {
    for (const box of context.boxes) {
      emailItems.push(orderDirectDeliveryItem(dropId, drop, box.refId));
    }
  } else {
    for (const box of context.boxes) {
      emailItems.push(orderBoxFallbackItem(dropId, drop, box.refId));
    }
  }

  context.looseFigureIds.forEach((figureId) => emailItems.push(orderFigureItem(dropId, drop, figureId, audience)));
  return emailItems;
}

export async function buildBuyerVisibleOrderEmailItems(
  order: any,
  selectedOrder: OrderEmailSelection,
): Promise<BuyerVisibleOrderEmailItem[]> {
  return buildAudienceVisibleOrderEmailItems(order, selectedOrder, 'buyer') as BuyerVisibleOrderEmailItem[];
}

export async function buildShipperVisibleOrderEmailItems(
  order: any,
  selectedOrder: OrderEmailSelection,
): Promise<ShipperVisibleOrderEmailItem[]> {
  return buildAudienceVisibleOrderEmailItems(order, selectedOrder, 'shipper') as ShipperVisibleOrderEmailItem[];
}
