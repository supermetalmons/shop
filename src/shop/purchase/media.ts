import {
  STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT,
  resolveStripeCheckoutUnitAmountCents,
  type StripeCheckoutMode as StripePaymentMode
} from '../../../shared/stripeCheckoutCore';
import { type MintPanelBoxMedia } from '../../components/MintPanel';
import {
  type FrontendDeploymentConfig
} from '../../config/deployment';
import {
  CARD_NFT_2_PACK_COMPACT_VIDEO_SCALE,
  CARD_NFT_2_PACK_VIDEO_ASPECT_RATIO,
  CARD_NFT_2_PACK_VIDEO_POSTER_URL,
  CARD_NFT_2_PACK_VIDEO_SCALE,
  CARD_NFT_2_PACK_VIDEO_SOURCES,
  CARD_NFT_2_PACK_WEBM_FIRST_VIDEO_SOURCES,
} from '../../lib/cardNft2Packs';
import {
  InventoryPreviewVideo,
  PreviewVideoSource
} from '../../types';

export type CardNft2PackVideoSources = readonly PreviewVideoSource[];

export function stripeCheckoutUnitAmountCentsForDrop(
  drop: FrontendDeploymentConfig | null | undefined,
  mode: StripePaymentMode | null,
): number | null {
  if (!drop || !mode) return null;
  return resolveStripeCheckoutUnitAmountCents({
    mode,
    testConfiguredUnitAmountCents:
      import.meta.env.STRIPE_TEST_UNIT_AMOUNT_CENTS ?? import.meta.env.VITE_STRIPE_TEST_UNIT_AMOUNT_CENTS,
    testFallbackUnitAmountCents: STRIPE_TEST_UNIT_AMOUNT_CENTS_DEFAULT,
    liveConfiguredUnitAmountCents: drop.stripeLiveUnitAmountCents,
  });
}

export function formatStripeUsdAmountCents(amountCents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
}

export function cardNft2PackVideoSourcesForBrowser(): CardNft2PackVideoSources {
  if (typeof document === 'undefined') return CARD_NFT_2_PACK_VIDEO_SOURCES;
  const video = document.createElement('video');
  return video.canPlayType(CARD_NFT_2_PACK_VIDEO_SOURCES[0].type)
    ? CARD_NFT_2_PACK_VIDEO_SOURCES
    : CARD_NFT_2_PACK_WEBM_FIRST_VIDEO_SOURCES;
}

export function createCardNft2PackInventoryPreviewVideo(sources: CardNft2PackVideoSources): InventoryPreviewVideo {
  return {
    sources,
    posterSrc: CARD_NFT_2_PACK_VIDEO_POSTER_URL,
  };
}

export function resolveMintPreviewMedia(
  media: MintPanelBoxMedia,
  usesCardNft2Video: boolean,
  cardNft2PackVideoSources: CardNft2PackVideoSources,
): MintPanelBoxMedia {
  if (!usesCardNft2Video) return media;

  return {
    ...media,
    imageSrc: CARD_NFT_2_PACK_VIDEO_POSTER_URL,
    videoSources: cardNft2PackVideoSources,
    videoPosterSrc: CARD_NFT_2_PACK_VIDEO_POSTER_URL,
    mediaScale: CARD_NFT_2_PACK_VIDEO_SCALE,
    compactMediaScale: CARD_NFT_2_PACK_COMPACT_VIDEO_SCALE,
    aspectRatio: CARD_NFT_2_PACK_VIDEO_ASPECT_RATIO,
  };
}
