
export function pickRandomSoundUrl(soundUrls: readonly string[]) {
  return soundUrls[Math.floor(Math.random() * soundUrls.length)] || soundUrls[0]!;
}

export const DEFAULT_BOX_SOUND_REVEAL_URL = 'https://cdn.lil.org/nft/little_swag_boxes/sounds/unbox1p.mp3';

export const DEFAULT_BOX_SOUND_CLICK_URL = 'https://cdn.lil.org/nft/little_swag_boxes/sounds/click.mp3';

export const REVEAL_CLOSE_FALLBACK_MS = 380;

export const PONCHO_OUTSIDE_TAP_DISMISS_LOCK_MS = 1_300;
