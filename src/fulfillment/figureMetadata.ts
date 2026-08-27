import type { FrontendDeploymentConfig } from '../config/deployment';
import { getMediaIdForFigureId } from '../lib/figureMediaMap';
import {
  figureMetadataCacheKey,
  figureMetadataHasImage,
  getCachedFigureMetadata,
  type FigureMetadataRecord,
  type FigureMetadataTarget,
} from '../lib/figureMetadata';
import { resolveDropContent } from '../lib/dropContent';
import { isDirectDeliveryItemsPerBox } from '../../shared/shipping.ts';

export function collectFulfillmentFigureMetadataTargets(args: {
  entries: ReadonlyArray<{ drop: FrontendDeploymentConfig; figureIds: readonly number[] }>;
  figureMetadataByKey: Readonly<Record<string, FigureMetadataRecord>>;
}): FigureMetadataTarget[] {
  const targets = new Map<string, FigureMetadataTarget>();
  args.entries.forEach(({ drop, figureIds }) => {
    if (isDirectDeliveryItemsPerBox(drop.itemsPerBox)) return;

    const dropContent = resolveDropContent(drop);
    const shouldUseMetadataFallback = dropContent.figures.fulfillmentPreviewMode === 'metadata_stills';
    figureIds.forEach((figureIdRaw) => {
      const figureId = Math.floor(Number(figureIdRaw));
      if (!Number.isFinite(figureId) || figureId <= 0) return;
      if (!shouldUseMetadataFallback) {
        const hasMappedMedia = Boolean(
          dropContent.figures.fulfillmentMediaBaseUrl && getMediaIdForFigureId(figureId, drop.figureMedia),
        );
        if (hasMappedMedia) return;
      }
      const key = figureMetadataCacheKey(drop.dropId, figureId);
      const cached = args.figureMetadataByKey[key] || getCachedFigureMetadata(drop.dropId, figureId);
      if (figureMetadataHasImage(cached)) return;
      targets.set(key, { dropId: drop.dropId, figureId });
    });
  });
  return Array.from(targets.values());
}

export function mergeFigureMetadataRecords(
  prev: Record<string, FigureMetadataRecord>,
  records: readonly FigureMetadataRecord[],
): Record<string, FigureMetadataRecord> {
  let changed = false;
  const next = { ...prev };
  records.forEach((record) => {
    const key = figureMetadataCacheKey(record.dropId, record.id);
    const existing = next[key];
    if (
      figureMetadataHasImage(existing) &&
      existing.image === record.image &&
      existing.name === record.name &&
      existing.attributes === record.attributes
    ) {
      return;
    }
    next[key] = record;
    changed = true;
  });
  return changed ? next : prev;
}
