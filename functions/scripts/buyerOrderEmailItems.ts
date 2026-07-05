import {
  getFrontendDrop,
  type FrontendDeploymentConfig,
} from '../../src/config/deployment.ts';
import { normalizeBoxDisplayImage, resolveDropContent } from '../../src/lib/dropContent.ts';
import { dropAssetReference } from '../../src/lib/dropLabels.ts';
import {
  figureMetadataCacheKey,
  loadFigureMetadataBatch,
  type FigureMetadataRecord,
} from '../../src/lib/figureMetadata.ts';
import {
  resolveFulfillmentDirectDeliveryBoxLabel,
  resolveFulfillmentFigurePreview,
} from '../../src/lib/fulfillmentLabels.ts';
import { isDirectDeliveryItemsPerBox } from '../../src/lib/shipping.ts';
import type { BuyerOrderEmailItem } from '../src/notificationEmails.ts';

type DeliveryOrderItem = {
  kind: 'box' | 'dude';
  refId: number;
};

type BuyerOrderEmailSelection = {
  dropId: string;
};

type BuyerOrderEmailItemContext = {
  boxes: DeliveryOrderItem[];
  looseFigureIds: number[];
  assignedFigureIdsByBoxId: Map<number, number[]>;
};

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
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

function buyerOrderEmailItemContext(order: any): BuyerOrderEmailItemContext {
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

function figureIdsForBuyerOrderEmail(
  context: BuyerOrderEmailItemContext,
  drop: FrontendDeploymentConfig | undefined,
): number[] {
  if (isDirectDeliveryItemsPerBox(drop?.itemsPerBox)) {
    return context.looseFigureIds;
  }

  const assignedFigureIds = context.boxes.flatMap((box) => context.assignedFigureIdsByBoxId.get(box.refId) || []);
  return [...assignedFigureIds, ...context.looseFigureIds];
}

async function loadBuyerOrderFigureMetadata(
  dropId: string,
  drop: FrontendDeploymentConfig | undefined,
  context: BuyerOrderEmailItemContext,
): Promise<Record<string, FigureMetadataRecord>> {
  const content = resolveDropContent(drop || dropId);
  if (content.figures.fulfillmentPreviewMode !== 'metadata_stills') return {};

  const targets = figureIdsForBuyerOrderEmail(context, drop).map((figureId) => ({ dropId, figureId }));
  if (!targets.length) return {};

  const records = await loadFigureMetadataBatch(targets);
  return Object.fromEntries(records.map((record) => [figureMetadataCacheKey(record.dropId, record.id), record]));
}

function buyerOrderFigureLabel(
  drop: FrontendDeploymentConfig | undefined,
  label: string | number | undefined,
  figureId: number,
): string {
  const normalizedLabel = String(label ?? '').trim();
  if (normalizedLabel && !/^\d+$/.test(normalizedLabel)) return normalizedLabel;
  return dropAssetReference(drop, 'figure', normalizedLabel || figureId);
}

function buyerOrderFigureItem(args: {
  dropId: string;
  drop: FrontendDeploymentConfig | undefined;
  figureId: number;
  index: number;
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
}): BuyerOrderEmailItem {
  const content = resolveDropContent(args.drop || args.dropId);
  const preview = resolveFulfillmentFigurePreview({
    dropId: args.dropId,
    drop: args.drop,
    figureId: args.figureId,
    index: args.index,
    previewMode: content.figures.fulfillmentPreviewMode,
    figureMediaBase: content.figures.fulfillmentMediaBaseUrl,
    figureMetadataByKey: args.figureMetadataByKey,
  });
  return {
    label: buyerOrderFigureLabel(args.drop, preview.label, args.figureId),
    ...(preview.imageSrc ? { thumbnailUrl: preview.imageSrc } : {}),
  };
}

function buyerOrderBoxItem(dropId: string, boxId: number, label: string): BuyerOrderEmailItem {
  const thumbnailUrl = normalizeBoxDisplayImage({ dropId, boxId });
  return {
    label,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function buyerOrderBoxFallbackItem(
  dropId: string,
  drop: FrontendDeploymentConfig | undefined,
  boxId: number,
): BuyerOrderEmailItem {
  return buyerOrderBoxItem(dropId, boxId, dropAssetReference(drop, 'box', boxId));
}

function buyerOrderDirectDeliveryItem(
  dropId: string,
  drop: FrontendDeploymentConfig | undefined,
  boxId: number,
): BuyerOrderEmailItem {
  const { label } = resolveFulfillmentDirectDeliveryBoxLabel(drop, boxId);
  return buyerOrderBoxItem(dropId, boxId, label);
}

export async function buildBuyerOrderEmailItems(
  order: any,
  selectedOrder: BuyerOrderEmailSelection,
): Promise<BuyerOrderEmailItem[]> {
  const drop = getFrontendDrop(selectedOrder.dropId);
  const context = buyerOrderEmailItemContext(order);
  const figureMetadataByKey = await loadBuyerOrderFigureMetadata(selectedOrder.dropId, drop, context);
  const isDirectDelivery = isDirectDeliveryItemsPerBox(drop?.itemsPerBox);
  const emailItems: BuyerOrderEmailItem[] = [];
  let figureIndex = 0;
  const addFigureItem = (figureId: number) => {
    emailItems.push(
      buyerOrderFigureItem({
        dropId: selectedOrder.dropId,
        drop,
        figureId,
        index: figureIndex,
        figureMetadataByKey,
      }),
    );
    figureIndex += 1;
  };

  if (isDirectDelivery) {
    for (const box of context.boxes) {
      emailItems.push(buyerOrderDirectDeliveryItem(selectedOrder.dropId, drop, box.refId));
    }
  } else {
    for (const box of context.boxes) {
      const assignedFigureIds = context.assignedFigureIdsByBoxId.get(box.refId) || [];
      if (!assignedFigureIds.length) {
        emailItems.push(buyerOrderBoxFallbackItem(selectedOrder.dropId, drop, box.refId));
        continue;
      }
      assignedFigureIds.forEach(addFigureItem);
    }
  }

  context.looseFigureIds.forEach(addFigureItem);

  return emailItems;
}
