import { isDropFamily } from '../config/deployment';

const PONCHO_DRIFELLA_SOUND_BASE_URL = 'https://cdn.lil.org/nft/poncho_drifella/sounds';

export const PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL = `${PONCHO_DRIFELLA_SOUND_BASE_URL}/crash.mp3`;
export const PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS = [
  `${PONCHO_DRIFELLA_SOUND_BASE_URL}/hit1.mp3`,
  `${PONCHO_DRIFELLA_SOUND_BASE_URL}/hit2.mp3`,
  `${PONCHO_DRIFELLA_SOUND_BASE_URL}/hit3.mp3`,
] as const;

const CARD_NFT_2_SOUND_BASE_URL = 'https://cdn.lil.org/nft/card_nft_2/sounds';

export const CARD_NFT_2_BOX_SOUND_REVEAL_URL = `${CARD_NFT_2_SOUND_BASE_URL}/crash.mp3`;
export const CARD_NFT_2_BOX_SOUND_CLICK_URLS = [
  `${CARD_NFT_2_SOUND_BASE_URL}/hit1.mp3`,
  `${CARD_NFT_2_SOUND_BASE_URL}/hit2.mp3`,
  `${CARD_NFT_2_SOUND_BASE_URL}/hit3.mp3`,
] as const;
export const CARD_NFT_2_CARD_SOUND_SWIPE_URL = `${CARD_NFT_2_SOUND_BASE_URL}/swipe.mp3`;
export const CARD_NFT_2_CARD_SOUND_SPREAD_URL = `${CARD_NFT_2_SOUND_BASE_URL}/spread.mp3`;

export type InteractiveCardPackRevealSoundUrls = {
  click: readonly string[];
  reveal: string;
  cardSwipe?: string;
  cardSpread?: string;
};

export function interactiveCardPackRevealSoundUrlsForDropId(dropId?: string): InteractiveCardPackRevealSoundUrls {
  if (isDropFamily(dropId, 'card_nft_2')) {
    return {
      click: CARD_NFT_2_BOX_SOUND_CLICK_URLS,
      reveal: CARD_NFT_2_BOX_SOUND_REVEAL_URL,
      cardSwipe: CARD_NFT_2_CARD_SOUND_SWIPE_URL,
      cardSpread: CARD_NFT_2_CARD_SOUND_SPREAD_URL,
    };
  }
  return {
    click: PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS,
    reveal: PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL,
  };
}

export function pickRandomInteractiveCardPackClickSoundUrl(dropId?: string, random: () => number = Math.random) {
  const { click } = interactiveCardPackRevealSoundUrlsForDropId(dropId);
  return click[Math.floor(random() * click.length)] || click[0];
}
