import {
  getFrontendDrop,
  resolveDropAssetUrl
} from '../../config/deployment';
import {
  normalizeCertificateDisplayImage
} from '../../lib/dropContent';
import {
  dropAssetReference
} from '../../lib/dropLabels';
import {
  InventoryItem
} from '../../types';
import { ReceiptViewerSource } from '../reveal/types';

export function normalizeClaimedReceiptIds(ids: number[] | undefined): number[] {
  if (!Array.isArray(ids)) return [];
  const normalized = new Set<number>();
  ids.forEach((id) => {
    const figureId = Math.floor(Number(id));
    if (Number.isFinite(figureId) && figureId > 0) normalized.add(figureId);
  });
  return Array.from(normalized);
}

function findFirstNewClaimedReceipt(
  items: readonly InventoryItem[],
  dropId: string,
  previousReceiptIds: ReadonlySet<string>,
  burnedReceiptId?: string,
): InventoryItem | undefined {
  for (const item of items) {
    if (item.kind !== 'certificate' || item.dropId !== dropId) continue;
    if (item.id !== burnedReceiptId && !previousReceiptIds.has(item.id)) {
      return item;
    }
  }
  return undefined;
}

function findClaimedReceiptsByFigureId(items: readonly InventoryItem[], dropId: string): Map<number, InventoryItem> {
  const receiptByFigureId = new Map<number, InventoryItem>();
  items.forEach((item) => {
    if (item.kind !== 'certificate' || item.dropId !== dropId) return;
    if (typeof item.dudeId === 'number' && !receiptByFigureId.has(item.dudeId)) {
      receiptByFigureId.set(item.dudeId, item);
    }
  });
  return receiptByFigureId;
}

export function buildClaimedReceiptPreviewItems(
  snapshot: readonly InventoryItem[],
  dropId: string,
  claimedFigureIds: readonly number[],
  previousReceiptIds: ReadonlySet<string>,
  burnedReceiptId?: string,
  fallbackImages?: ReadonlyMap<number, string>,
): ReceiptViewerSource[] {
  if (!claimedFigureIds.length) {
    const item = findFirstNewClaimedReceipt(snapshot, dropId, previousReceiptIds, burnedReceiptId);
    return item ? [{ id: item.id, dropId: item.dropId, name: item.name, image: item.image }] : [];
  }

  const receiptByFigureId = findClaimedReceiptsByFigureId(snapshot, dropId);
  return claimedFigureIds.map((figureId) => {
    const item = receiptByFigureId.get(figureId);
    const fallbackImage = fallbackImages?.get(figureId);
    if (item) {
      return {
        id: item.id,
        dropId: item.dropId,
        name: item.name,
        image: item.image || fallbackImage,
      };
    }
    return {
      id: `claimed-receipt-${dropId}-${figureId}`,
      dropId,
      name: dropAssetReference(getFrontendDrop(dropId), 'figure', figureId),
      image: fallbackImage,
    };
  });
}

export async function loadClaimedReceiptImage(dropId: string, figureId: number): Promise<string | undefined> {
  const deterministicImage = normalizeCertificateDisplayImage({ dropId, figureId });
  if (deterministicImage) return deterministicImage;

  const drop = getFrontendDrop(dropId);
  if (!drop) return undefined;

  const metadataUrl = resolveDropAssetUrl(`${drop.paths.receiptsFiguresJsonBase}${figureId}.json`);
  if (!metadataUrl) return undefined;
  try {
    const resp = await fetch(metadataUrl);
    if (!resp.ok) return undefined;
    const metadata = (await resp.json()) as { image?: unknown; };
    return normalizeCertificateDisplayImage({
      dropId,
      imageRaw: typeof metadata.image === 'string' ? metadata.image : undefined,
      figureId,
    });
  } catch {
    return undefined;
  }
}
