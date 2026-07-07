import type { FrontendDeploymentConfig } from '../config/deployment';
import { isDropFamily } from '../config/deployment';
import type { DropFigureFulfillmentPreviewMode } from '../config/dropsExtraContent';
import { getMediaIdForFigureId } from './figureMediaMap';
import { figureMetadataCacheKey, figureMetadataHasImage, getCachedFigureMetadata, type FigureMetadataRecord } from './figureMetadata';
import { resolveFigureMediaImageUrlForMediaId } from './dropContent';
import { dropAssetLabel, dropAssetReference, dropMintSelectionLabel } from './dropLabels';

type FulfillmentLabelSource =
  | Partial<
      Pick<FrontendDeploymentConfig, 'dropFamily' | 'dropId' | 'namePrefix' | 'figureNamePrefix' | 'figureMedia' | 'mintSelection'>
    >
  | null
  | undefined;

export type FulfillmentFigureLabelOverrideArgs = {
  figureId: number;
  index: number;
  mediaId: number | null;
  fallbackName: string;
};

export type FulfillmentFigureLabel = FulfillmentFigureLabelOverrideArgs & {
  label: string;
  metadata?: FigureMetadataRecord;
};

export type FulfillmentFigurePreview = FulfillmentFigureLabel & {
  primarySrc?: string;
  fallbackSrc?: string;
  imageSrc?: string;
  alt: string;
};

export function resolveFulfillmentFigureLabel(args: {
  dropId: string;
  drop?: FulfillmentLabelSource;
  figureId: number;
  index?: number;
  previewMode: DropFigureFulfillmentPreviewMode;
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
  labelOverride?: (args: FulfillmentFigureLabelOverrideArgs) => string;
}): FulfillmentFigureLabel {
  const labelSource = { namePrefix: undefined, figureNamePrefix: args.drop?.figureNamePrefix };
  const metadataKey = figureMetadataCacheKey(args.dropId, args.figureId);
  const metadata = args.figureMetadataByKey?.[metadataKey] || getCachedFigureMetadata(args.dropId, args.figureId);
  const fallbackName = metadata?.name || dropAssetReference(labelSource, 'figure', args.figureId);
  const mediaId =
    args.previewMode === 'media_map_folder' ? getMediaIdForFigureId(args.figureId, args.drop?.figureMedia) : null;
  const defaultLabel =
    args.drop?.dropFamily === 'card_nft_2' || isDropFamily(args.drop?.dropId || args.dropId, 'card_nft_2')
      ? String(args.figureId)
      : mediaId
        ? String(mediaId)
        : fallbackName;
  const overrideArgs = {
    figureId: args.figureId,
    index: args.index ?? 0,
    mediaId,
    fallbackName,
  };
  return {
    ...overrideArgs,
    label: args.labelOverride?.(overrideArgs) || defaultLabel,
    ...(metadata ? { metadata } : {}),
  };
}

export function resolveFulfillmentFigurePreview(args: {
  dropId: string;
  drop?: FulfillmentLabelSource;
  figureId: number;
  index?: number;
  previewMode: DropFigureFulfillmentPreviewMode;
  figureMediaBase?: string;
  figureMetadataByKey?: Record<string, FigureMetadataRecord>;
  labelOverride?: (args: FulfillmentFigureLabelOverrideArgs) => string;
}): FulfillmentFigurePreview {
  const resolved = resolveFulfillmentFigureLabel(args);
  const fallbackSrc = figureMetadataHasImage(resolved.metadata) ? resolved.metadata.image : undefined;
  if (args.previewMode === 'media_map_folder') {
    const primarySrc = resolveFigureMediaImageUrlForMediaId(args.figureMediaBase, resolved.mediaId);
    return {
      ...resolved,
      ...(primarySrc ? { primarySrc } : {}),
      ...(fallbackSrc ? { fallbackSrc } : {}),
      ...(primarySrc || fallbackSrc ? { imageSrc: primarySrc || fallbackSrc } : {}),
      alt: resolved.mediaId ? `Media ${resolved.mediaId}` : resolved.fallbackName,
    };
  }

  return {
    ...resolved,
    ...(fallbackSrc ? { fallbackSrc, imageSrc: fallbackSrc } : {}),
    alt: resolved.fallbackName,
  };
}

export function resolveFulfillmentDirectDeliveryBoxLabel(
  source: Pick<FrontendDeploymentConfig, 'namePrefix' | 'figureNamePrefix' | 'mintSelection'> | null | undefined,
  boxId: number,
): { label: string; sizeLabel?: string } {
  const sizeLabel = dropMintSelectionLabel(source, boxId);
  return {
    label: sizeLabel || dropAssetReference(source, 'box', boxId),
    ...(sizeLabel ? { sizeLabel } : {}),
  };
}

export function fulfillmentBoxSecretLabelPrefix(source: FulfillmentLabelSource): string {
  return `${dropAssetLabel(source, 'box', 1, { capitalize: true })} Secret`;
}

export function fulfillmentBoxContentsLabel(source: FulfillmentLabelSource, boxId: number, secretCode: string): string {
  if (secretCode) return `${fulfillmentBoxSecretLabelPrefix(source)} ${secretCode}`;
  return dropAssetReference(source, 'box', boxId, { capitalize: true });
}
