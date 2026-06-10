import { isDropFamily } from '../config/deployment';

export const PONCHO_DRIFELLA_BOX_SOUND_REVEAL_URL = '/Poncho_Drifella/sounds/crash.mp3';
export const PONCHO_DRIFELLA_BOX_SOUND_CLICK_URLS = [
  '/Poncho_Drifella/sounds/hit1.mp3',
  '/Poncho_Drifella/sounds/hit2.mp3',
  '/Poncho_Drifella/sounds/hit3.mp3',
] as const;

export const CARD_NFT_2_BOX_SOUND_REVEAL_URL = '/card_nft_2/sounds/crash.mp3';
export const CARD_NFT_2_BOX_SOUND_CLICK_URLS = [
  '/card_nft_2/sounds/hit1.mp3',
  '/card_nft_2/sounds/hit2.mp3',
  '/card_nft_2/sounds/hit3.mp3',
] as const;
export const CARD_NFT_2_CARD_SOUND_SWIPE_URL = '/card_nft_2/sounds/swipe.mp3';
export const CARD_NFT_2_CARD_SOUND_SPREAD_URL = '/card_nft_2/sounds/spread.mp3';

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
