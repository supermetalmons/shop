export const DOGE_DAY_2026_WIP_CONFIG = Object.freeze({
  collectionName: 'Doge Day 2026',
  cardCount: 207,
  itemsPerPack: 2,
  packCount: 1,
  packLabel: 'pack',
  cardReadyMinDelayMs: 1_000,
  cardReadyMaxDelayMs: 1_300,
  clickVolume: 0.42,
  revealVolume: 0.3,
});

const STARTER_MEDIA_BASE_URL = 'https://cdn.lil.org/nft/poncho_drifella';
export const DOGE_DAY_2026_STARTER_CARD_BASE_URL = STARTER_MEDIA_BASE_URL;
export const DOGE_DAY_2026_WIP_SOUNDS = Object.freeze({
  click: Object.freeze([
    `${STARTER_MEDIA_BASE_URL}/sounds/hit1.mp3`,
    `${STARTER_MEDIA_BASE_URL}/sounds/hit2.mp3`,
    `${STARTER_MEDIA_BASE_URL}/sounds/hit3.mp3`,
  ]),
  reveal: `${STARTER_MEDIA_BASE_URL}/sounds/crash.mp3`,
  cardSwipe: 'https://cdn.lil.org/nft/card_nft_2/sounds/swipe.mp3',
  cardSpread: 'https://cdn.lil.org/nft/card_nft_2/sounds/spread.mp3',
});

export function pickDogeDay2026ClickSound(random: () => number = Math.random) {
  const { click } = DOGE_DAY_2026_WIP_SOUNDS;
  return click[Math.floor(random() * click.length)] || click[0];
}
