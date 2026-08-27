import { PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE } from '../lib/ponchoDrifellaReveal.ts';
import { INTERACTIVE_CARD_PACK_REVEAL_TIMING } from '../lib/interactiveCardPackReveal.ts';
import {
  CARD_NFT_2_PACK_BASE_URL,
  CARD_NFT_2_PACK_RECEIPT_MEDIA,
  CARD_NFT_BINDER_CLEAN_IMAGE_URL,
  CARD_NFT_BINDER_PREVIEW_ASPECT_RATIO,
  CARD_NFT_BINDER_RECEIPT_IMAGE_URL,
  CLEAR_CARDS_CARD_CLEAN_BASE_URL,
  CLEAR_CARDS_PACK_CLEAN_IMAGE_URL,
  CLEAR_CARDS_PACK_PREVIEW_ASPECT_RATIO,
  CLEAR_CARDS_RECEIPT_IMAGE_BASE_URL,
  DRIFELLA_SHIRT_CLEAN_IMAGE_URL,
  DRIFELLA_SHIRT_RECEIPT_IMAGE_BASE_URL,
  LITTLE_SWAG_BOXES_BOX_RECEIPT_IMAGE_URL,
  LITTLE_SWAG_BOXES_CDN_BASE_URL,
  LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL,
  LITTLE_SWAG_BOXES_RECEIPT_BASE_URL,
  LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL,
  LITTLE_SWAG_HOODIE_RECEIPT_IMAGE_BASE_URL,
  LITTLE_SWAG_HOODIE_RECEIPT_MEDIA,
  PONCHO_DRIFELLA_CLEAN_ITEMS_BASE_URL,
  PONCHO_DRIFELLA_PACK_INITIAL_IMAGE_URL,
  PONCHO_DRIFELLA_PACK_RECEIPT_IMAGE_URL,
  PONCHO_DRIFELLA_PACK_TIGHT_IMAGE_URL,
  PONCHO_DRIFELLA_RECEIPT_BASE_URL,
} from './dropMediaDefaults.ts';
import { isDropFamily, normalizeDropId, type MediaMapConfig } from './deployment.ts';

export type DropRevealMode = 'animated' | 'static';
export type DropRevealRenderer = 'default' | 'poncho_drifella' | 'interactive_card_pack' | 'clear_card_3d';
export type DropBoxInventoryImagePathMode = 'file' | 'folder_initial';
export type DropCertificateBoxInventoryImagePathMode = 'file' | 'receipt_file' | 'receipt_pack_file';
export type DropFigureRevealPresentation = 'videos' | 'metadata_stills';
export type DropFigureFulfillmentPreviewMode = 'media_map_folder' | 'metadata_stills';

export type DropRevealFrameTiming = {
  frameCount: number;
  clickMax: number;
  autoplayStart: number;
  mediaStart: number;
};

export type DropRevealFrameSequence = DropRevealFrameTiming & {
  baseUrl?: string;
  ext?: string;
  frames?: string[];
};

export type DropRevealFrameSourceSequence = DropRevealFrameTiming & (
  | { frames: string[]; baseUrl?: string; ext?: string }
  | { baseUrl: string; ext: string; frames?: string[] }
);

export type DropRevealSoundProfile = {
  clickVolume: number;
  revealVolume: number;
};

export function usesInteractiveCardPackRevealFlow(renderer: DropRevealRenderer | undefined): boolean {
  return INTERACTIVE_CARD_PACK_REVEAL_RENDERERS.has(renderer as DropRevealRenderer);
}

export function usesClearCard3dRevealFlow(renderer: DropRevealRenderer | undefined): boolean {
  return renderer === 'clear_card_3d';
}

export function usesAssetGatedRevealFlow(renderer: DropRevealRenderer | undefined): boolean {
  return usesInteractiveCardPackRevealFlow(renderer) || usesClearCard3dRevealFlow(renderer);
}

const INTERACTIVE_CARD_PACK_REVEAL_RENDERERS = new Set<DropRevealRenderer>([
  'interactive_card_pack',
  'poncho_drifella',
]);

export type DropExtraContentOverride = {
  mediaBaseUrl?: string;
  box?: {
    previewImageUrl?: string;
    inventoryImageBaseUrl?: string;
    inventoryImagePathMode?: DropBoxInventoryImagePathMode;
    aspectRatio?: number;
  };
  mintPanel?: {
    previewImageUrl?: string;
    aspectRatio?: number;
  };
  reveal?: {
    mode?: DropRevealMode;
    renderer?: DropRevealRenderer;
    frameTiming?: Partial<DropRevealFrameTiming>;
    frameSequence?: Partial<DropRevealFrameSequence>;
    sound?: Partial<DropRevealSoundProfile>;
  };
  figures?: {
    inventoryImageBaseUrl?: string;
    inventoryImageUrl?: string;
    revealPresentation?: DropFigureRevealPresentation;
    fulfillmentPreviewMode?: DropFigureFulfillmentPreviewMode;
    revealVideoBaseUrl?: string;
    fulfillmentMediaBaseUrl?: string;
  };
  certificates?: {
    inventoryImageBaseUrl?: string;
    inventoryImageUrl?: string;
    boxInventoryImageBaseUrl?: string;
    boxInventoryImagePathMode?: DropCertificateBoxInventoryImagePathMode;
    boxInventoryImageUrl?: string;
    boxInventoryMedia?: MediaMapConfig;
  };
};

const PONCHO_DRIFELLA_PACK_PREVIEW_ASPECT_RATIO = 637 / 1092;
const DRIFELLA_SHIRT_CLEAN_IMAGE_ASPECT_RATIO = 1585 / 1242;
const HOODIE_CLEAN_IMAGE_ASPECT_RATIO = 1445 / 877;
const DRIFELLA_SHIRT_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    previewImageUrl: DRIFELLA_SHIRT_CLEAN_IMAGE_URL,
    aspectRatio: DRIFELLA_SHIRT_CLEAN_IMAGE_ASPECT_RATIO,
  },
  mintPanel: {
    previewImageUrl: DRIFELLA_SHIRT_CLEAN_IMAGE_URL,
    aspectRatio: DRIFELLA_SHIRT_CLEAN_IMAGE_ASPECT_RATIO,
  },
  certificates: {
    boxInventoryImageBaseUrl: DRIFELLA_SHIRT_RECEIPT_IMAGE_BASE_URL,
    boxInventoryMedia: { strategy: 'direct' },
  },
};
const PONCHO_DRIFELLA_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    previewImageUrl: PONCHO_DRIFELLA_PACK_INITIAL_IMAGE_URL,
    aspectRatio: 1,
  },
  mintPanel: {
    previewImageUrl: PONCHO_DRIFELLA_PACK_TIGHT_IMAGE_URL,
    aspectRatio: PONCHO_DRIFELLA_PACK_PREVIEW_ASPECT_RATIO,
  },
  reveal: {
    mode: 'animated',
    renderer: 'interactive_card_pack',
    frameSequence: PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE,
    sound: {
      revealVolume: 0.3,
    },
  },
  figures: {
    inventoryImageBaseUrl: PONCHO_DRIFELLA_CLEAN_ITEMS_BASE_URL,
    fulfillmentPreviewMode: 'media_map_folder',
    fulfillmentMediaBaseUrl: PONCHO_DRIFELLA_CLEAN_ITEMS_BASE_URL,
  },
  certificates: {
    inventoryImageBaseUrl: PONCHO_DRIFELLA_RECEIPT_BASE_URL,
    boxInventoryImageUrl: PONCHO_DRIFELLA_PACK_RECEIPT_IMAGE_URL,
  },
};
const LITTLE_SWAG_HOODIES_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    previewImageUrl: LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL,
    aspectRatio: HOODIE_CLEAN_IMAGE_ASPECT_RATIO,
  },
  mintPanel: {
    previewImageUrl: LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL,
    aspectRatio: HOODIE_CLEAN_IMAGE_ASPECT_RATIO,
  },
  figures: {
    inventoryImageUrl: LITTLE_SWAG_HOODIE_CLEAN_IMAGE_URL,
  },
  certificates: {
    boxInventoryImageBaseUrl: LITTLE_SWAG_HOODIE_RECEIPT_IMAGE_BASE_URL,
    boxInventoryImagePathMode: 'receipt_file',
    boxInventoryMedia: LITTLE_SWAG_HOODIE_RECEIPT_MEDIA,
  },
};
const LITTLE_SWAG_BOXES_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  mediaBaseUrl: LITTLE_SWAG_BOXES_CDN_BASE_URL,
  figures: {
    inventoryImageBaseUrl: LITTLE_SWAG_BOXES_FIGURE_CLEAN_BASE_URL,
  },
  certificates: {
    inventoryImageBaseUrl: LITTLE_SWAG_BOXES_RECEIPT_BASE_URL,
    boxInventoryImageUrl: LITTLE_SWAG_BOXES_BOX_RECEIPT_IMAGE_URL,
  },
};
const CARD_NFT_2_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    inventoryImageBaseUrl: CARD_NFT_2_PACK_BASE_URL,
    inventoryImagePathMode: 'folder_initial',
    aspectRatio: 1,
  },
  reveal: {
    mode: 'animated',
    renderer: 'interactive_card_pack',
    frameTiming: INTERACTIVE_CARD_PACK_REVEAL_TIMING,
  },
  certificates: {
    boxInventoryImageBaseUrl: CARD_NFT_2_PACK_BASE_URL,
    boxInventoryImagePathMode: 'receipt_pack_file',
    boxInventoryMedia: CARD_NFT_2_PACK_RECEIPT_MEDIA,
  },
};
const CARD_NFT_BINDER_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    previewImageUrl: CARD_NFT_BINDER_CLEAN_IMAGE_URL,
    aspectRatio: CARD_NFT_BINDER_PREVIEW_ASPECT_RATIO,
  },
  mintPanel: {
    previewImageUrl: CARD_NFT_BINDER_CLEAN_IMAGE_URL,
    aspectRatio: CARD_NFT_BINDER_PREVIEW_ASPECT_RATIO,
  },
  certificates: {
    inventoryImageUrl: CARD_NFT_BINDER_RECEIPT_IMAGE_URL,
  },
};
const CLEAR_CARDS_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    previewImageUrl: CLEAR_CARDS_PACK_CLEAN_IMAGE_URL,
    aspectRatio: CLEAR_CARDS_PACK_PREVIEW_ASPECT_RATIO,
  },
  mintPanel: {
    previewImageUrl: CLEAR_CARDS_PACK_CLEAN_IMAGE_URL,
    aspectRatio: CLEAR_CARDS_PACK_PREVIEW_ASPECT_RATIO,
  },
  reveal: {
    mode: 'animated',
    renderer: 'clear_card_3d',
  },
  figures: {
    inventoryImageBaseUrl: CLEAR_CARDS_CARD_CLEAN_BASE_URL,
    fulfillmentPreviewMode: 'media_map_folder',
    fulfillmentMediaBaseUrl: CLEAR_CARDS_CARD_CLEAN_BASE_URL,
  },
  certificates: {
    inventoryImageBaseUrl: CLEAR_CARDS_RECEIPT_IMAGE_BASE_URL,
  },
};

function getDropFamilyExtraContentOverride(normalizedDropId: string): DropExtraContentOverride | undefined {
  if (isDropFamily(normalizedDropId, 'drifella_shirt')) return DRIFELLA_SHIRT_FAMILY_EXTRA_CONTENT;
  if (isDropFamily(normalizedDropId, 'poncho_drifella')) return PONCHO_DRIFELLA_FAMILY_EXTRA_CONTENT;
  if (isDropFamily(normalizedDropId, 'little_swag_boxes')) return LITTLE_SWAG_BOXES_FAMILY_EXTRA_CONTENT;
  if (isDropFamily(normalizedDropId, 'little_swag_hoodies')) return LITTLE_SWAG_HOODIES_FAMILY_EXTRA_CONTENT;
  if (isDropFamily(normalizedDropId, 'card_nft_2')) return CARD_NFT_2_FAMILY_EXTRA_CONTENT;
  if (isDropFamily(normalizedDropId, 'card_nft_binder')) return CARD_NFT_BINDER_FAMILY_EXTRA_CONTENT;
  if (isDropFamily(normalizedDropId, 'clear_cards')) return CLEAR_CARDS_FAMILY_EXTRA_CONTENT;
  return undefined;
}

export function getDropExtraContentOverride(dropId?: string): DropExtraContentOverride | undefined {
  const normalizedDropId = normalizeDropId(dropId || '');
  if (!normalizedDropId) return undefined;
  return getDropFamilyExtraContentOverride(normalizedDropId);
}
