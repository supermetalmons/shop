import { PONCHO_DRIFELLA_REVEAL_FRAME_SEQUENCE } from '../lib/ponchoDrifellaReveal';
import { INTERACTIVE_CARD_PACK_REVEAL_TIMING } from '../lib/interactiveCardPackReveal';
import { CARD_NFT_2_PACK_BASE_URL } from './dropMediaDefaults.ts';
import { isDropFamily, normalizeDropId } from './deployment';

export type DropRevealMode = 'animated' | 'static';
export type DropRevealRenderer = 'default' | 'poncho_drifella' | 'interactive_card_pack';
export type DropBoxInventoryImagePathMode = 'file' | 'folder_initial';
export type DropFigureInventoryImageMode = 'clean_variant' | 'metadata_raw';
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

const INTERACTIVE_CARD_PACK_REVEAL_RENDERERS = new Set<DropRevealRenderer>([
  'interactive_card_pack',
  'poncho_drifella',
]);

export type DropExtraContentOverride = {
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
const PONCHO_DRIFELLA_PACK_PREVIEW_IMAGE_URL = '/Poncho_Drifella/pack/tight.webp';
const PONCHO_DRIFELLA_PACK_PREVIEW_ASPECT_RATIO = 637 / 1092;
const HOODIE_CLEAN_IMAGE_URL = 'https://silver-real-rhinoceros-781.mypinata.cloud/ipfs/bafybeiaka2o45fhcmufpvthgp53xslhnblmqzeg4dri2rqozd7yqndjck4/hoodie_clean.webp';
const HOODIE_CLEAN_IMAGE_ASPECT_RATIO = 1445 / 877;
const PONCHO_DRIFELLA_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
  box: {
    previewImageUrl: '/Poncho_Drifella/pack/initial.webp',
    aspectRatio: 1,
  },
  mintPanel: {
    previewImageUrl: PONCHO_DRIFELLA_PACK_PREVIEW_IMAGE_URL,
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
    inventoryImageMode: 'clean_variant',
    inventoryImageBaseUrl: PONCHO_DRIFELLA_CLEAN_ITEMS_BASE,
    fulfillmentPreviewMode: 'media_map_folder',
    fulfillmentMediaBaseUrl: PONCHO_DRIFELLA_CLEAN_ITEMS_BASE,
  },
};
const LITTLE_SWAG_HOODIES_FAMILY_EXTRA_CONTENT: DropExtraContentOverride = {
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
};

export const DROPS_EXTRA_CONTENT: Record<string, DropExtraContentOverride> = {
};

export function getDropExtraContentOverride(dropId?: string): DropExtraContentOverride | undefined {
  const normalizedDropId = normalizeDropId(dropId || '');
  if (!normalizedDropId) return undefined;
  const dropOverride = DROPS_EXTRA_CONTENT[normalizedDropId];
  if (dropOverride) return dropOverride;
  if (isDropFamily(normalizedDropId, 'poncho_drifella')) return PONCHO_DRIFELLA_FAMILY_EXTRA_CONTENT;
  if (isDropFamily(normalizedDropId, 'little_swag_hoodies')) return LITTLE_SWAG_HOODIES_FAMILY_EXTRA_CONTENT;
  if (isDropFamily(normalizedDropId, 'card_nft_2')) return CARD_NFT_2_FAMILY_EXTRA_CONTENT;
  return undefined;
}
