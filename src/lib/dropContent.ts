import {
  type FrontendDropConfig,
  getFrontendDrop,
  isDropFamily,
  normalizeDropId,
  resolveDropAssetUrl,
} from '../config/deployment.ts';
import {
  getDropExtraContentOverride,
  usesInteractiveCardPackRevealFlow,
  type DropBoxInventoryImagePathMode,
  type DropCertificateBoxInventoryImagePathMode,
  type DropExtraContentOverride,
  type DropFigureFulfillmentPreviewMode,
  type DropFigureRevealPresentation,
  type DropRevealFrameSequence,
  type DropRevealFrameSourceSequence,
  type DropRevealFrameTiming,
  type DropRevealMode,
  type DropRevealRenderer,
  type DropRevealSoundProfile,
} from '../config/dropsExtraContent.ts';
import { cardNft2AssetUrl } from './cardNft2Assets.ts';
import { getMediaIdForFigureId } from './figureMediaMap.ts';
import { isKnownCdnUrl, rewriteLegacyDisplayMediaUrl } from './legacyDisplayMediaPaths.ts';
import { getMediaIdForTokenId } from './mediaMap.ts';

export type ResolvedDropContent = {
  box: {
    previewImageUrl?: string;
    inventoryImageBaseUrl?: string;
    inventoryImagePathMode?: DropBoxInventoryImagePathMode;
    aspectRatio: number;
  };
  mintPanel: {
    previewImageUrl?: string;
    aspectRatio: number;
  };
  reveal: {
    mode: DropRevealMode;
    renderer: DropRevealRenderer;
    frameTiming?: DropRevealFrameTiming;
    frameSequence?: DropRevealFrameSourceSequence;
    sound: DropRevealSoundProfile;
  };
  figures: {
    inventoryImageBaseUrl?: string;
    inventoryImageUrl?: string;
    revealPresentation: DropFigureRevealPresentation;
    fulfillmentPreviewMode: DropFigureFulfillmentPreviewMode;
    revealVideoBaseUrl?: string;
    fulfillmentMediaBaseUrl?: string;
  };
  certificates: {
    inventoryImageBaseUrl?: string;
    inventoryImageUrl?: string;
    boxInventoryImageBaseUrl?: string;
    boxInventoryImagePathMode?: DropCertificateBoxInventoryImagePathMode;
    boxInventoryImageUrl?: string;
    boxInventoryMedia?: FrontendDropConfig['boxMedia'];
  };
};

const LEGACY_BOX_ASPECT_RATIO = 1440 / 1030;
const CARD_NFT_2_IMAGE_FILENAME_RE = /^(\d+)\.webp$/i;
const DEFAULT_DROP_REVEAL_SOUND_PROFILE: DropRevealSoundProfile = {
  clickVolume: 0.42,
  revealVolume: 0.42,
};
const resolvedContentByDropId = new Map<string, ResolvedDropContent>();

function asPositiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function asPositiveInteger(value: unknown): number | undefined {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function asNonNegativeNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function trimLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function pathFromRawDisplayMediaUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.replace(/[?#].*$/, '');
  }
}

function cardNft2ImageUrlFromRawDisplayMediaUrl(url: string | undefined): string | undefined {
  const normalizedUrl = asOptionalString(url);
  if (!normalizedUrl) return undefined;
  const path = trimTrailingSlashes(pathFromRawDisplayMediaUrl(normalizedUrl));
  const filename = path.split('/').pop() || '';
  const match = filename.match(CARD_NFT_2_IMAGE_FILENAME_RE);
  if (!match?.[1]) return undefined;
  return cardNft2AssetUrl('img', Number(match[1]));
}

export function resolveDisplayMediaUrl(url: string | undefined): string | undefined {
  const normalizedUrl = asOptionalString(url);
  if (!normalizedUrl) return undefined;
  if (isKnownCdnUrl(normalizedUrl)) return normalizedUrl;
  const rewrittenUrl = rewriteLegacyDisplayMediaUrl(normalizedUrl);
  if (rewrittenUrl) return rewrittenUrl;
  return resolveDropAssetUrl(normalizedUrl);
}

export function joinDropAssetUrl(baseUrl: string | undefined, path: string): string | undefined {
  const normalizedBaseUrl = asOptionalString(baseUrl);
  const normalizedPath = String(path || '').trim();
  if (!normalizedBaseUrl) return undefined;
  const joined = !normalizedPath
    ? trimTrailingSlashes(normalizedBaseUrl)
    : `${trimTrailingSlashes(normalizedBaseUrl)}/${trimLeadingSlashes(normalizedPath)}`;
  return resolveDisplayMediaUrl(joined);
}

export function resolveFigureMediaImageUrl(
  baseUrl: string | undefined,
  figureId: number | undefined,
  figureMedia: FrontendDropConfig['figureMedia'] | undefined,
): string | undefined {
  const normalizedFigureId = asPositiveInteger(figureId);
  if (!normalizedFigureId) return undefined;
  const mediaId = getMediaIdForFigureId(normalizedFigureId, figureMedia) || normalizedFigureId;
  return resolveFigureMediaImageUrlForMediaId(baseUrl, mediaId);
}

export function resolveFigureMediaImageUrlForMediaId(
  baseUrl: string | undefined,
  mediaId: number | null | undefined,
): string | undefined {
  const normalizedMediaId = asPositiveInteger(mediaId);
  if (!normalizedMediaId) return undefined;
  return joinDropAssetUrl(baseUrl, `${normalizedMediaId}.webp`);
}

function certificateBoxImagePath(mediaId: number, mode: DropCertificateBoxInventoryImagePathMode | undefined): string {
  if (mode === 'receipt_file') return `receipt_${mediaId}.webp`;
  if (mode === 'receipt_pack_file') return `receipt_pack_${mediaId}.webp`;
  return `${mediaId}.webp`;
}

function resolveCertificateBoxMediaImageUrl(args: {
  baseUrl: string | undefined;
  boxId?: string | number;
  boxMedia?: FrontendDropConfig['boxMedia'];
  pathMode?: DropCertificateBoxInventoryImagePathMode;
}): string | undefined {
  const mediaId = getMediaIdForTokenId(args.boxId, args.boxMedia);
  if (!mediaId) return undefined;
  return joinDropAssetUrl(args.baseUrl, certificateBoxImagePath(mediaId, args.pathMode));
}

function resolveCertificateMediaImageUrl(args: {
  baseUrl: string | undefined;
  boxImageBaseUrl?: string;
  boxImagePathMode?: DropCertificateBoxInventoryImagePathMode;
  boxImageUrl?: string;
  boxMedia?: FrontendDropConfig['boxMedia'];
  figureId?: number;
  boxId?: string | number;
  figureMedia?: FrontendDropConfig['figureMedia'];
}): string | undefined {
  const figureImage = resolveFigureMediaImageUrl(args.baseUrl, args.figureId, args.figureMedia);
  if (figureImage) return figureImage;

  const mappedBoxImage = resolveCertificateBoxMediaImageUrl({
    baseUrl: args.boxImageBaseUrl,
    boxId: args.boxId,
    boxMedia: args.boxMedia,
    pathMode: args.boxImagePathMode,
  });
  if (mappedBoxImage) return mappedBoxImage;

  const boxImage = resolveDisplayMediaUrl(args.boxImageUrl);
  if (!boxImage) return undefined;
  const hasFigureCertificateId = Boolean(asPositiveInteger(args.figureId));
  const hasBoxCertificateId = Boolean(asPositiveInteger(args.boxId));
  return !hasFigureCertificateId || hasBoxCertificateId ? boxImage : undefined;
}

function mergeFrameSequence(
  base: DropRevealFrameSequence | undefined,
  override: Partial<DropRevealFrameSequence> | undefined,
  timingOverride: Partial<DropRevealFrameTiming> | undefined,
): DropRevealFrameSequence | undefined {
  if (!base && !override && !timingOverride) return undefined;
  const merged = {
    ...(base || {}),
    ...(override || {}),
    ...(timingOverride || {}),
  } as Partial<DropRevealFrameSequence>;
  const frames = Array.isArray(merged.frames)
    ? merged.frames.map((frame) => asOptionalString(frame)).filter((frame): frame is string => Boolean(frame))
    : undefined;
  const baseUrl = asOptionalString(merged.baseUrl);
  const ext = asOptionalString(merged.ext);
  const hasExplicitFrames = Boolean(frames?.length);
  const hasSequentialFrames = Boolean(baseUrl && ext);
  const hasTimingMetadata = Boolean(
    !hasExplicitFrames &&
      !hasSequentialFrames &&
      (merged.frameCount !== undefined ||
        merged.clickMax !== undefined ||
        merged.autoplayStart !== undefined ||
        merged.mediaStart !== undefined),
  );
  if (!hasExplicitFrames && !hasSequentialFrames && !hasTimingMetadata) return undefined;
  const frameCountFallback = frames?.length || 1;
  const frameCount = hasExplicitFrames
    ? frames!.length
    : Math.max(1, Math.floor(asPositiveNumber(merged.frameCount, frameCountFallback)));
  const clickMax = Math.min(frameCount, Math.max(1, Math.floor(asPositiveNumber(merged.clickMax, 1))));
  const autoplayStartMin = Math.min(frameCount, clickMax + 1);
  const autoplayStart = Math.min(
    frameCount,
    Math.max(autoplayStartMin, Math.floor(asPositiveNumber(merged.autoplayStart, autoplayStartMin))),
  );
  const mediaStart = Math.min(
    frameCount,
    Math.max(autoplayStart, Math.floor(asPositiveNumber(merged.mediaStart, autoplayStart))),
  );
  return {
    frameCount,
    clickMax,
    autoplayStart,
    mediaStart,
    ...(hasExplicitFrames ? { frames } : hasSequentialFrames ? { baseUrl, ext } : {}),
  };
}

function pickFrameTiming(frameSequence: DropRevealFrameSequence): DropRevealFrameTiming {
  return {
    frameCount: frameSequence.frameCount,
    clickMax: frameSequence.clickMax,
    autoplayStart: frameSequence.autoplayStart,
    mediaStart: frameSequence.mediaStart,
  };
}

function hasFrameSources(frameSequence: DropRevealFrameSequence | undefined): frameSequence is DropRevealFrameSourceSequence {
  return Boolean(frameSequence?.frames?.length || (frameSequence?.baseUrl && frameSequence.ext));
}

function defaultAnimatedDropContent(drop: FrontendDropConfig, mediaBaseUrl?: string): ResolvedDropContent {
  const base = resolveDisplayMediaUrl(mediaBaseUrl) || drop.paths.base;
  const frameSequence = {
    baseUrl: joinDropAssetUrl(base, 'box/'),
    ext: 'webp',
    frameCount: 21,
    clickMax: 8,
    autoplayStart: 9,
    mediaStart: 10,
  };
  return {
    box: {
      previewImageUrl: joinDropAssetUrl(base, 'box/tight.webp'),
      inventoryImageBaseUrl: undefined,
      inventoryImagePathMode: 'file',
      aspectRatio: LEGACY_BOX_ASPECT_RATIO,
    },
    mintPanel: {
      previewImageUrl: joinDropAssetUrl(base, 'box/tight.webp'),
      aspectRatio: LEGACY_BOX_ASPECT_RATIO,
    },
    reveal: {
      mode: 'animated',
      renderer: 'default',
      frameTiming: pickFrameTiming(frameSequence),
      ...(hasFrameSources(frameSequence) ? { frameSequence } : {}),
      sound: DEFAULT_DROP_REVEAL_SOUND_PROFILE,
    },
    figures: {
      inventoryImageBaseUrl: undefined,
      inventoryImageUrl: undefined,
      revealPresentation: 'videos',
      fulfillmentPreviewMode: 'media_map_folder',
      revealVideoBaseUrl: joinDropAssetUrl(base, 'figures/small-rotating/'),
      fulfillmentMediaBaseUrl: joinDropAssetUrl(base, 'figures/clean'),
    },
    certificates: {
      inventoryImageBaseUrl: undefined,
      inventoryImageUrl: undefined,
      boxInventoryImageBaseUrl: undefined,
      boxInventoryImagePathMode: undefined,
      boxInventoryImageUrl: undefined,
      boxInventoryMedia: undefined,
    },
  };
}

function defaultStaticDropContent(): ResolvedDropContent {
  return {
    box: {
      previewImageUrl: undefined,
      inventoryImageBaseUrl: undefined,
      inventoryImagePathMode: 'file',
      aspectRatio: 1,
    },
    mintPanel: {
      previewImageUrl: undefined,
      aspectRatio: 1,
    },
    reveal: {
      mode: 'static',
      renderer: 'default',
      frameSequence: undefined,
      sound: DEFAULT_DROP_REVEAL_SOUND_PROFILE,
    },
    figures: {
      inventoryImageBaseUrl: undefined,
      inventoryImageUrl: undefined,
      revealPresentation: 'metadata_stills',
      fulfillmentPreviewMode: 'metadata_stills',
      revealVideoBaseUrl: undefined,
      fulfillmentMediaBaseUrl: undefined,
    },
    certificates: {
      inventoryImageBaseUrl: undefined,
      inventoryImageUrl: undefined,
      boxInventoryImageBaseUrl: undefined,
      boxInventoryImagePathMode: undefined,
      boxInventoryImageUrl: undefined,
      boxInventoryMedia: undefined,
    },
  };
}

function applyDropExtraContentOverride(
  base: ResolvedDropContent,
  override: DropExtraContentOverride | undefined,
): ResolvedDropContent {
  if (!override) return base;
  const nextMode = override.reveal?.mode || base.reveal.mode;
  const nextRenderer = override.reveal?.renderer || base.reveal.renderer;
  const frameSequenceBase = usesInteractiveCardPackRevealFlow(nextRenderer)
    ? undefined
    : base.reveal.frameSequence;
  const nextFrameTimingAndSources = mergeFrameSequence(
    frameSequenceBase,
    override.reveal?.frameSequence,
    override.reveal?.frameTiming,
  );
  const nextFrameSequence = hasFrameSources(nextFrameTimingAndSources) ? nextFrameTimingAndSources : undefined;
  return {
    box: {
      previewImageUrl: resolveDisplayMediaUrl(override.box?.previewImageUrl) ?? base.box.previewImageUrl,
      inventoryImageBaseUrl: resolveDisplayMediaUrl(override.box?.inventoryImageBaseUrl) ?? base.box.inventoryImageBaseUrl,
      inventoryImagePathMode: override.box?.inventoryImagePathMode || base.box.inventoryImagePathMode,
      aspectRatio: asPositiveNumber(override.box?.aspectRatio, base.box.aspectRatio),
    },
    mintPanel: {
      previewImageUrl: resolveDisplayMediaUrl(override.mintPanel?.previewImageUrl) ?? base.mintPanel.previewImageUrl,
      aspectRatio: asPositiveNumber(override.mintPanel?.aspectRatio, base.mintPanel.aspectRatio),
    },
    reveal: {
      mode: nextMode,
      renderer: nextRenderer,
      sound: {
        clickVolume: asNonNegativeNumber(override.reveal?.sound?.clickVolume, base.reveal.sound.clickVolume),
        revealVolume: asNonNegativeNumber(override.reveal?.sound?.revealVolume, base.reveal.sound.revealVolume),
      },
      ...(nextMode === 'animated' && nextFrameTimingAndSources
        ? { frameTiming: pickFrameTiming(nextFrameTimingAndSources) }
        : {}),
      ...(nextMode === 'animated' && nextFrameSequence ? { frameSequence: nextFrameSequence } : {}),
    },
    figures: {
      inventoryImageBaseUrl:
        resolveDisplayMediaUrl(override.figures?.inventoryImageBaseUrl) ?? base.figures.inventoryImageBaseUrl,
      inventoryImageUrl: resolveDisplayMediaUrl(override.figures?.inventoryImageUrl) ?? base.figures.inventoryImageUrl,
      revealPresentation: override.figures?.revealPresentation || base.figures.revealPresentation,
      fulfillmentPreviewMode: override.figures?.fulfillmentPreviewMode || base.figures.fulfillmentPreviewMode,
      revealVideoBaseUrl: resolveDisplayMediaUrl(override.figures?.revealVideoBaseUrl) ?? base.figures.revealVideoBaseUrl,
      fulfillmentMediaBaseUrl:
        resolveDisplayMediaUrl(override.figures?.fulfillmentMediaBaseUrl) ?? base.figures.fulfillmentMediaBaseUrl,
    },
    certificates: {
      inventoryImageBaseUrl:
        resolveDisplayMediaUrl(override.certificates?.inventoryImageBaseUrl) ?? base.certificates.inventoryImageBaseUrl,
      inventoryImageUrl:
        resolveDisplayMediaUrl(override.certificates?.inventoryImageUrl) ?? base.certificates.inventoryImageUrl,
      boxInventoryImageBaseUrl:
        resolveDisplayMediaUrl(override.certificates?.boxInventoryImageBaseUrl) ??
        base.certificates.boxInventoryImageBaseUrl,
      boxInventoryImagePathMode:
        override.certificates?.boxInventoryImagePathMode || base.certificates.boxInventoryImagePathMode,
      boxInventoryImageUrl:
        resolveDisplayMediaUrl(override.certificates?.boxInventoryImageUrl) ?? base.certificates.boxInventoryImageUrl,
      boxInventoryMedia: override.certificates?.boxInventoryMedia || base.certificates.boxInventoryMedia,
    },
  };
}

export function resolveDropContent(dropOrId?: FrontendDropConfig | string): ResolvedDropContent {
  const drop =
    typeof dropOrId === 'string'
      ? getFrontendDrop(dropOrId)
      : dropOrId && typeof dropOrId === 'object'
        ? dropOrId
        : undefined;
  const normalizedDropId = normalizeDropId(drop?.dropId || (typeof dropOrId === 'string' ? dropOrId : ''));
  const cached = resolvedContentByDropId.get(normalizedDropId);
  if (cached) return cached;

  const override = getDropExtraContentOverride(normalizedDropId);
  const base = drop
    ? isDropFamily(drop, 'little_swag_boxes')
      ? defaultAnimatedDropContent(drop, override?.mediaBaseUrl)
      : defaultStaticDropContent()
    : defaultStaticDropContent();

  const resolved = applyDropExtraContentOverride(base, override);
  if (normalizedDropId) {
    resolvedContentByDropId.set(normalizedDropId, resolved);
  }
  return resolved;
}

export type BoxDisplayImageInput = {
  dropId: string;
  imageRaw?: string;
  boxId?: string | number;
};

export type CertificateDisplayImageInput = {
  dropId: string;
  imageRaw?: string;
  figureId?: number;
  boxId?: string | number;
};

function resolveBoxMediaId(drop: FrontendDropConfig | undefined, boxId?: string | number): number | null {
  return getMediaIdForTokenId(boxId, drop?.boxMedia);
}

export function resolveBoxMediaIdForDrop(
  dropOrId: FrontendDropConfig | string | undefined,
  boxId?: string | number,
): number | null {
  const drop =
    typeof dropOrId === 'string'
      ? getFrontendDrop(dropOrId)
      : dropOrId && typeof dropOrId === 'object'
        ? dropOrId
        : undefined;
  return resolveBoxMediaId(drop, boxId);
}

export function normalizeBoxDisplayImage({ dropId, imageRaw, boxId }: BoxDisplayImageInput): string | undefined {
  const drop = getFrontendDrop(dropId);
  const content = resolveDropContent(drop || dropId);
  const boxMediaId = content.box.inventoryImageBaseUrl ? resolveBoxMediaId(drop, boxId) : null;
  if (boxMediaId) {
    const boxImagePath =
      content.box.inventoryImagePathMode === 'folder_initial'
        ? `${boxMediaId}/initial.webp`
        : `${boxMediaId}.webp`;
    const resolvedBoxImage = joinDropAssetUrl(content.box.inventoryImageBaseUrl, boxImagePath);
    if (resolvedBoxImage) return resolvedBoxImage;
  }
  return content.box.previewImageUrl || resolveDisplayMediaUrl(imageRaw) || undefined;
}

export function mintPanelPreviewImage(dropId: string): string | undefined {
  const content = resolveDropContent(dropId);
  return content.mintPanel.previewImageUrl || content.box.previewImageUrl;
}

export function mintPanelPreviewAspectRatio(dropId: string): number {
  const content = resolveDropContent(dropId);
  return content.mintPanel.previewImageUrl ? content.mintPanel.aspectRatio : content.box.aspectRatio;
}

export function normalizeFigureDisplayImage(dropId: string, imageRaw?: string, figureId?: number): string | undefined {
  if (isDropFamily(dropId, 'card_nft_2')) {
    return cardNft2AssetUrl('img', figureId) || cardNft2ImageUrlFromRawDisplayMediaUrl(imageRaw);
  }

  const drop = getFrontendDrop(dropId);
  const content = resolveDropContent(drop || dropId);
  if (content.figures.inventoryImageUrl) return content.figures.inventoryImageUrl;

  const mappedFigureImage = resolveFigureMediaImageUrl(
    content.figures.inventoryImageBaseUrl,
    figureId,
    drop?.figureMedia,
  );
  if (mappedFigureImage) return mappedFigureImage;

  return resolveDisplayMediaUrl(imageRaw);
}

export function normalizeCertificateDisplayImage({
  dropId,
  imageRaw,
  figureId,
  boxId,
}: CertificateDisplayImageInput): string | undefined {
  const cardNft2Receipt = isDropFamily(dropId, 'card_nft_2')
    ? cardNft2AssetUrl('receipt', figureId)
    : undefined;
  if (cardNft2Receipt) return cardNft2Receipt;

  const drop = getFrontendDrop(dropId);
  const content = resolveDropContent(drop || dropId);
  if (content.certificates.inventoryImageUrl) return content.certificates.inventoryImageUrl;

  const certificateImage = resolveCertificateMediaImageUrl({
    baseUrl: content.certificates.inventoryImageBaseUrl,
    boxImageBaseUrl: content.certificates.boxInventoryImageBaseUrl,
    boxImagePathMode: content.certificates.boxInventoryImagePathMode,
    boxImageUrl: content.certificates.boxInventoryImageUrl,
    boxMedia: content.certificates.boxInventoryMedia || drop?.boxMedia,
    figureId,
    boxId,
    figureMedia: drop?.figureMedia,
  });
  if (certificateImage) return certificateImage;

  return resolveDisplayMediaUrl(imageRaw);
}
