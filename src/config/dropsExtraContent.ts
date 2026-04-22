import { PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE } from '../lib/ponchoDrifellaReveal';
import { isDropFamily, normalizeDropId } from './deployment';

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

export type DropRevealSoundProfile = {
  clickVolume: number;
  revealVolume: number;
};

export type DropExtraContentOverride = {
  box?: {
    previewImageUrl?: string;
    aspectRatio?: number;
  };
  mintPanel?: {
    previewImageUrl?: string;
    aspectRatio?: number;
  };
  reveal?: {
    mode?: DropRevealMode;
    renderer?: DropRevealRenderer;
    frameSequence?: Partial<DropRevealFrameSequence>;
    sound?: Partial<DropRevealSoundProfile>;
  };
  figures?: {
    inventoryImageMode?: DropFigureInventoryImageMode;
    inventoryImageBaseUrl?: string;
    inventoryImageUrl?: string;
    revealPresentation?: DropFigureRevealPresentation;
    fulfillmentPreviewMode?: DropFigureFulfillmentPreviewMode;
    revealVideoBaseUrl?: string;
    fulfillmentMediaBaseUrl?: string;
  };
  certificates?: {
    inventoryImageUrl?: string;
  };
};

const PONCHO_DRIFELLA_CLEAN_ITEMS_BASE = 'https://assets.mons.link/drops/poncho/items/clean';
const HOODIE_CLEAN_IMAGE_URL = 'https://bafybeiegstwuc3a6qzcztylkrchlgrrd46ibakoplmupqgsy473wcdo5gy.ipfs.dweb.link/hoodie_clean.webp';
const HOODIE_RECEIPT_IMAGE_URL = 'https://bafybeiegstwuc3a6qzcztylkrchlgrrd46ibakoplmupqgsy473wcdo5gy.ipfs.dweb.link/hoodie_receipt.webp';
const HOODIE_CLEAN_IMAGE_ASPECT_RATIO = 1445 / 884;
const PONCHO_DRIFELLA_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    previewImageUrl: '/Poncho_Drifella/pack/initial.webp',
    aspectRatio: 1,
  },
  reveal: {
    mode: 'animated',
    renderer: 'poncho_drifella',
    frameSequence: PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE,
    sound: {
      revealVolume: 0.3,
    },
  },
  figures: {
    inventoryImageMode: 'clean_variant',
    inventoryImageBaseUrl: PONCHO_DRIFELLA_CLEAN_ITEMS_BASE,
    fulfillmentPreviewMode: 'media_map_folder',
    fulfillmentMediaBaseUrl: PONCHO_DRIFELLA_CLEAN_ITEMS_BASE,
  },
};
const LSW_COBALT_FIGURE_HOODIE_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    previewImageUrl: HOODIE_CLEAN_IMAGE_URL,
    aspectRatio: HOODIE_CLEAN_IMAGE_ASPECT_RATIO,
  },
  mintPanel: {
    previewImageUrl: HOODIE_CLEAN_IMAGE_URL,
    aspectRatio: HOODIE_CLEAN_IMAGE_ASPECT_RATIO,
  },
  figures: {
    inventoryImageUrl: HOODIE_CLEAN_IMAGE_URL,
  },
  certificates: {
    inventoryImageUrl: HOODIE_RECEIPT_IMAGE_URL,
  },
};

export const DROPS_EXTRA_CONTENT: Record<string, DropExtraContentOverride> = {
};

export function getDropExtraContentOverride(dropId?: string): DropExtraContentOverride | undefined {
  const normalizedDropId = normalizeDropId(dropId || '');
  if (!normalizedDropId) return undefined;
  return DROPS_EXTRA_CONTENT[normalizedDropId] || (
    isDropFamily(normalizedDropId, 'poncho_drifella')
      ? PONCHO_DRIFELLA_FAMILY_EXTRA_CONTENT
      : isDropFamily(normalizedDropId, 'lsw_cobalt_figure_hoodie')
        ? LSW_COBALT_FIGURE_HOODIE_FAMILY_EXTRA_CONTENT
        : undefined
  );
}
