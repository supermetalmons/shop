import { type FrontendDropConfig, getFrontendDrop, isDropFamily, normalizeDropId, resolveDropAssetUrl } from '../config/deployment';
import {
  getDropExtraContentOverride,
  type DropExtraContentOverride,
  type DropFigureFulfillmentPreviewMode,
  type DropFigureInventoryImageMode,
  type DropFigureRevealPresentation,
  type DropRevealFrameSequence,
  type DropRevealMode,
  type DropRevealRenderer,
  type DropRevealSoundProfile,
} from '../config/dropsExtraContent';
import { getMediaIdForTokenId } from './mediaMap';

export type ResolvedDropContent = {
  box: {
    previewImageUrl?: string;
    inventoryImageBaseUrl?: string;
    aspectRatio: number;
  };
  mintPanel: {
    previewImageUrl?: string;
    aspectRatio: number;
  };
  reveal: {
    mode: DropRevealMode;
    renderer: DropRevealRenderer;
    frameSequence?: DropRevealFrameSequence;
    sound: DropRevealSoundProfile;
  };
  figures: {
    inventoryImageMode: DropFigureInventoryImageMode;
    inventoryImageBaseUrl?: string;
    inventoryImageUrl?: string;
    revealPresentation: DropFigureRevealPresentation;
    fulfillmentPreviewMode: DropFigureFulfillmentPreviewMode;
    revealVideoBaseUrl?: string;
    fulfillmentMediaBaseUrl?: string;
  };
  certificates: {
    inventoryImageUrl?: string;
  };
};

const LEGACY_BOX_ASPECT_RATIO = 1440 / 1030;
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

export function joinDropAssetUrl(baseUrl: string | undefined, path: string): string | undefined {
  const normalizedBaseUrl = asOptionalString(baseUrl);
  const normalizedPath = String(path || '').trim();
  if (!normalizedBaseUrl) return undefined;
  const joined = !normalizedPath
    ? trimTrailingSlashes(normalizedBaseUrl)
    : `${trimTrailingSlashes(normalizedBaseUrl)}/${trimLeadingSlashes(normalizedPath)}`;
  return resolveDropAssetUrl(joined);
}

function mergeFrameSequence(
  base: DropRevealFrameSequence | undefined,
  override: Partial<DropRevealFrameSequence> | undefined,
): DropRevealFrameSequence | undefined {
  if (!base && !override) return undefined;
  const merged = {
    ...(base || {}),
    ...(override || {}),
  } as Partial<DropRevealFrameSequence>;
  const frames = Array.isArray(merged.frames)
    ? merged.frames.map((frame) => asOptionalString(frame)).filter((frame): frame is string => Boolean(frame))
    : undefined;
  const baseUrl = asOptionalString(merged.baseUrl);
  const ext = asOptionalString(merged.ext);
  const hasExplicitFrames = Boolean(frames?.length);
  const hasSequentialFrames = Boolean(baseUrl && ext);
  if (!hasExplicitFrames && !hasSequentialFrames) return undefined;
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
    ...(hasExplicitFrames ? { frames } : { baseUrl, ext }),
  };
}

function defaultAnimatedDropContent(drop: FrontendDropConfig): ResolvedDropContent {
  const base = drop.paths.base;
  return {
    box: {
      previewImageUrl: joinDropAssetUrl(base, 'box/tight.webp'),
      inventoryImageBaseUrl: undefined,
      aspectRatio: LEGACY_BOX_ASPECT_RATIO,
    },
    mintPanel: {
      previewImageUrl: joinDropAssetUrl(base, 'box/tight.webp'),
      aspectRatio: LEGACY_BOX_ASPECT_RATIO,
    },
    reveal: {
      mode: 'animated',
      renderer: 'default',
      frameSequence: {
        baseUrl: joinDropAssetUrl(base, 'box/'),
        ext: 'webp',
        frameCount: 21,
        clickMax: 8,
        autoplayStart: 9,
        mediaStart: 10,
      },
      sound: DEFAULT_DROP_REVEAL_SOUND_PROFILE,
    },
    figures: {
      inventoryImageMode: 'clean_variant',
      inventoryImageBaseUrl: undefined,
      inventoryImageUrl: undefined,
      revealPresentation: 'videos',
      fulfillmentPreviewMode: 'media_map_folder',
      revealVideoBaseUrl: joinDropAssetUrl(base, 'figures/small-rotating/'),
      fulfillmentMediaBaseUrl: joinDropAssetUrl(base, 'figures/clean'),
    },
    certificates: {
      inventoryImageUrl: undefined,
    },
  };
}

function defaultStaticDropContent(): ResolvedDropContent {
  return {
    box: {
      previewImageUrl: undefined,
      inventoryImageBaseUrl: undefined,
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
      inventoryImageMode: 'metadata_raw',
      inventoryImageBaseUrl: undefined,
      inventoryImageUrl: undefined,
      revealPresentation: 'metadata_stills',
      fulfillmentPreviewMode: 'metadata_stills',
      revealVideoBaseUrl: undefined,
      fulfillmentMediaBaseUrl: undefined,
    },
    certificates: {
      inventoryImageUrl: undefined,
    },
  };
}

function applyDropExtraContentOverride(
  base: ResolvedDropContent,
  override: DropExtraContentOverride | undefined,
): ResolvedDropContent {
  if (!override) return base;
  const nextMode = override.reveal?.mode || base.reveal.mode;
  const nextFrameSequence = mergeFrameSequence(base.reveal.frameSequence, override.reveal?.frameSequence);
  return {
    box: {
      previewImageUrl: asOptionalString(override.box?.previewImageUrl) ?? base.box.previewImageUrl,
      inventoryImageBaseUrl: asOptionalString(override.box?.inventoryImageBaseUrl) ?? base.box.inventoryImageBaseUrl,
      aspectRatio: asPositiveNumber(override.box?.aspectRatio, base.box.aspectRatio),
    },
    mintPanel: {
      previewImageUrl: asOptionalString(override.mintPanel?.previewImageUrl) ?? base.mintPanel.previewImageUrl,
      aspectRatio: asPositiveNumber(override.mintPanel?.aspectRatio, base.mintPanel.aspectRatio),
    },
    reveal: {
      mode: nextMode,
      renderer: override.reveal?.renderer || base.reveal.renderer,
      sound: {
        clickVolume: asNonNegativeNumber(override.reveal?.sound?.clickVolume, base.reveal.sound.clickVolume),
        revealVolume: asNonNegativeNumber(override.reveal?.sound?.revealVolume, base.reveal.sound.revealVolume),
      },
      ...(nextMode === 'animated' && nextFrameSequence ? { frameSequence: nextFrameSequence } : {}),
    },
    figures: {
      inventoryImageMode: override.figures?.inventoryImageMode || base.figures.inventoryImageMode,
      inventoryImageBaseUrl: asOptionalString(override.figures?.inventoryImageBaseUrl) ?? base.figures.inventoryImageBaseUrl,
      inventoryImageUrl: asOptionalString(override.figures?.inventoryImageUrl) ?? base.figures.inventoryImageUrl,
      revealPresentation: override.figures?.revealPresentation || base.figures.revealPresentation,
      fulfillmentPreviewMode: override.figures?.fulfillmentPreviewMode || base.figures.fulfillmentPreviewMode,
      revealVideoBaseUrl: asOptionalString(override.figures?.revealVideoBaseUrl) ?? base.figures.revealVideoBaseUrl,
      fulfillmentMediaBaseUrl:
        asOptionalString(override.figures?.fulfillmentMediaBaseUrl) ?? base.figures.fulfillmentMediaBaseUrl,
    },
    certificates: {
      inventoryImageUrl:
        asOptionalString(override.certificates?.inventoryImageUrl) ?? base.certificates.inventoryImageUrl,
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

  const base = drop
    ? isDropFamily(drop, 'little_swag_boxes')
      ? defaultAnimatedDropContent(drop)
      : defaultStaticDropContent()
    : defaultStaticDropContent();

  const resolved = applyDropExtraContentOverride(base, getDropExtraContentOverride(normalizedDropId));
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

export function normalizeBoxDisplayImage({ dropId, imageRaw, boxId }: BoxDisplayImageInput): string | undefined {
  const drop = getFrontendDrop(dropId);
  const content = resolveDropContent(drop || dropId);
  const fallbackImage = content.box.previewImageUrl || resolveDropAssetUrl(imageRaw || '') || undefined;
  const boxMediaId = content.box.inventoryImageBaseUrl ? getMediaIdForTokenId(boxId, drop?.boxMedia) : null;
  if (boxMediaId) {
    return joinDropAssetUrl(content.box.inventoryImageBaseUrl, `${boxMediaId}.webp`) || fallbackImage;
  }
  return fallbackImage;
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
  const content = resolveDropContent(dropId);
  if (content.figures.inventoryImageUrl) {
    return resolveDropAssetUrl(content.figures.inventoryImageUrl);
  }
  const normalizedFigureId = asPositiveInteger(figureId);
  if (content.figures.inventoryImageBaseUrl && normalizedFigureId) {
    return joinDropAssetUrl(content.figures.inventoryImageBaseUrl, `${normalizedFigureId}.webp`) || imageRaw;
  }
  const resolvedImage = resolveDropAssetUrl(imageRaw || '');
  if (!resolvedImage) return undefined;
  if (content.figures.inventoryImageMode !== 'clean_variant') return resolvedImage;
  if (resolvedImage.includes('/figures/clean/')) return resolvedImage;
  return resolvedImage.includes('/figures/') ? resolvedImage.replace('/figures/', '/figures/clean/') : resolvedImage;
}

export function normalizeCertificateDisplayImage(dropId: string, imageRaw?: string): string | undefined {
  const content = resolveDropContent(dropId);
  const resolvedImage = resolveDropAssetUrl(imageRaw || '');
  return content.certificates.inventoryImageUrl || resolvedImage || undefined;
}
