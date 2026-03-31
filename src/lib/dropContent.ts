import { type FrontendDropConfig, getFrontendDrop, normalizeDropId } from '../config/deployment';
import {
  DROPS_EXTRA_CONTENT,
  type DropExtraContentOverride,
  type DropFigureFulfillmentPreviewMode,
  type DropFigureInventoryImageMode,
  type DropFigureRevealPresentation,
  type DropRevealFrameSequence,
  type DropRevealMode,
} from '../config/dropsExtraContent';

export type ResolvedDropContent = {
  box: {
    previewImageUrl?: string;
    aspectRatio: number;
  };
  reveal: {
    mode: DropRevealMode;
    frameSequence?: DropRevealFrameSequence;
  };
  figures: {
    inventoryImageMode: DropFigureInventoryImageMode;
    revealPresentation: DropFigureRevealPresentation;
    fulfillmentPreviewMode: DropFigureFulfillmentPreviewMode;
    revealVideoBaseUrl?: string;
    fulfillmentMediaBaseUrl?: string;
  };
};

const LEGACY_BOX_ASPECT_RATIO = 1440 / 1030;
const LITTLE_SWAG_BOXES_DROP_ID_PREFIX = 'little_swag_boxes';
const resolvedContentByDropId = new Map<string, ResolvedDropContent>();

function asPositiveNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
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
  if (!normalizedPath) return trimTrailingSlashes(normalizedBaseUrl);
  return `${trimTrailingSlashes(normalizedBaseUrl)}/${trimLeadingSlashes(normalizedPath)}`;
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
  const baseUrl = asOptionalString(merged.baseUrl);
  const ext = asOptionalString(merged.ext);
  if (!baseUrl || !ext) return undefined;
  const frameCount = Math.max(1, Math.floor(asPositiveNumber(merged.frameCount, 1)));
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
    baseUrl,
    ext,
    frameCount,
    clickMax,
    autoplayStart,
    mediaStart,
  };
}

export function isLittleSwagBoxesFamilyDropId(dropId?: string): boolean {
  const normalizedDropId = normalizeDropId(dropId || '');
  return (
    normalizedDropId === LITTLE_SWAG_BOXES_DROP_ID_PREFIX ||
    normalizedDropId.startsWith(`${LITTLE_SWAG_BOXES_DROP_ID_PREFIX}_`)
  );
}

function defaultAnimatedDropContent(drop: FrontendDropConfig): ResolvedDropContent {
  const base = drop.paths.base;
  return {
    box: {
      previewImageUrl: `${base}/box/tight.webp`,
      aspectRatio: LEGACY_BOX_ASPECT_RATIO,
    },
    reveal: {
      mode: 'animated',
      frameSequence: {
        baseUrl: `${base}/box/`,
        ext: 'webp',
        frameCount: 21,
        clickMax: 8,
        autoplayStart: 9,
        mediaStart: 10,
      },
    },
    figures: {
      inventoryImageMode: 'clean_variant',
      revealPresentation: 'videos',
      fulfillmentPreviewMode: 'media_map_folder',
      revealVideoBaseUrl: `${base}/figures/small-rotating/`,
      fulfillmentMediaBaseUrl: `${base}/figures/clean`,
    },
  };
}

function defaultStaticDropContent(): ResolvedDropContent {
  return {
    box: {
      previewImageUrl: undefined,
      aspectRatio: 1,
    },
    reveal: {
      mode: 'static',
      frameSequence: undefined,
    },
    figures: {
      inventoryImageMode: 'metadata_raw',
      revealPresentation: 'metadata_stills',
      fulfillmentPreviewMode: 'metadata_stills',
      revealVideoBaseUrl: undefined,
      fulfillmentMediaBaseUrl: undefined,
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
      aspectRatio: asPositiveNumber(override.box?.aspectRatio, base.box.aspectRatio),
    },
    reveal: {
      mode: nextMode,
      ...(nextMode === 'animated' && nextFrameSequence ? { frameSequence: nextFrameSequence } : {}),
    },
    figures: {
      inventoryImageMode: override.figures?.inventoryImageMode || base.figures.inventoryImageMode,
      revealPresentation: override.figures?.revealPresentation || base.figures.revealPresentation,
      fulfillmentPreviewMode: override.figures?.fulfillmentPreviewMode || base.figures.fulfillmentPreviewMode,
      revealVideoBaseUrl: asOptionalString(override.figures?.revealVideoBaseUrl) ?? base.figures.revealVideoBaseUrl,
      fulfillmentMediaBaseUrl:
        asOptionalString(override.figures?.fulfillmentMediaBaseUrl) ?? base.figures.fulfillmentMediaBaseUrl,
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
    ? isLittleSwagBoxesFamilyDropId(drop.dropId)
      ? defaultAnimatedDropContent(drop)
      : defaultStaticDropContent()
    : defaultStaticDropContent();

  const resolved = applyDropExtraContentOverride(base, DROPS_EXTRA_CONTENT[normalizedDropId]);
  if (normalizedDropId) {
    resolvedContentByDropId.set(normalizedDropId, resolved);
  }
  return resolved;
}

export function normalizeFigureDisplayImage(dropId: string, imageRaw?: string): string | undefined {
  if (!imageRaw) return imageRaw;
  const content = resolveDropContent(dropId);
  if (content.figures.inventoryImageMode !== 'clean_variant') return imageRaw;
  if (imageRaw.includes('/figures/clean/')) return imageRaw;
  return imageRaw.includes('/figures/') ? imageRaw.replace('/figures/', '/figures/clean/') : imageRaw;
}
