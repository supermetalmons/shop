import { PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE } from '../lib/ponchoDrifellaReveal';
import { FRONTEND_DROPS, normalizeDropId } from './deployment';

export type DropRevealMode = 'animated' | 'static';
export type DropRevealRenderer = 'default' | 'poncho_drifella';
export type DropFigureInventoryImageMode = 'clean_variant' | 'metadata_raw';
export type DropFigureRevealPresentation = 'videos' | 'metadata_stills';
export type DropFigureFulfillmentPreviewMode = 'media_map_folder' | 'metadata_stills';

export type DropRevealFrameSequence = {
  frameCount: number;
  clickMax: number;
  autoplayStart: number;
  mediaStart: number;
  baseUrl?: string;
  ext?: string;
  frames?: string[];
};

export type DropExtraContentOverride = {
  box?: {
    previewImageUrl?: string;
    aspectRatio?: number;
  };
  reveal?: {
    mode?: DropRevealMode;
    renderer?: DropRevealRenderer;
    frameSequence?: Partial<DropRevealFrameSequence>;
  };
  figures?: {
    inventoryImageMode?: DropFigureInventoryImageMode;
    inventoryImageBaseUrl?: string;
    revealPresentation?: DropFigureRevealPresentation;
    fulfillmentPreviewMode?: DropFigureFulfillmentPreviewMode;
    revealVideoBaseUrl?: string;
    fulfillmentMediaBaseUrl?: string;
  };
};

function dropBase(dropId: string): string {
  return FRONTEND_DROPS[normalizeDropId(dropId)]?.paths.base || '';
}

const GREEN_BASE = dropBase('green_boxes_devnet');
const PONCHO_DRIFELLA_DROP_ID_PREFIX = normalizeDropId('Poncho_Drifella');
const PONCHO_DRIFELLA_CLEAN_ITEMS_BASE = 'https://assets.mons.link/drops/poncho/items/clean';
const PONCHO_DRIFELLA_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    previewImageUrl: '/Poncho_Drifella/pack/1_0001.webp',
    aspectRatio: 1,
  },
  reveal: {
    mode: 'animated',
    renderer: 'poncho_drifella',
    frameSequence: PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE,
  },
  figures: {
    inventoryImageMode: 'clean_variant',
    inventoryImageBaseUrl: PONCHO_DRIFELLA_CLEAN_ITEMS_BASE,
    fulfillmentPreviewMode: 'media_map_folder',
    fulfillmentMediaBaseUrl: PONCHO_DRIFELLA_CLEAN_ITEMS_BASE,
  },
};

export const DROPS_EXTRA_CONTENT: Record<string, DropExtraContentOverride> = {
  green_boxes_devnet: {
    box: {
      previewImageUrl: GREEN_BASE ? `${GREEN_BASE}/box/default.png` : undefined,
      aspectRatio: 1,
    },
    reveal: {
      mode: 'static',
    },
    figures: {
      inventoryImageMode: 'metadata_raw',
      revealPresentation: 'metadata_stills',
      fulfillmentPreviewMode: 'metadata_stills',
    },
  },
};

export function isPonchoDrifellaFamilyDropId(dropId?: string): boolean {
  const normalizedDropId = normalizeDropId(dropId || '');
  return normalizedDropId.startsWith(PONCHO_DRIFELLA_DROP_ID_PREFIX);
}

export function getDropExtraContentOverride(dropId?: string): DropExtraContentOverride | undefined {
  const normalizedDropId = normalizeDropId(dropId || '');
  if (!normalizedDropId) return undefined;
  return DROPS_EXTRA_CONTENT[normalizedDropId] || (
    isPonchoDrifellaFamilyDropId(normalizedDropId) ? PONCHO_DRIFELLA_FAMILY_EXTRA_CONTENT : undefined
  );
}
