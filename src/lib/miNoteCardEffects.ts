import { CARD_NFT_2_NEUTRAL_CARD_EFFECT, DRIF_EFFECTS } from '../drifCards.ts';

export const MI_NOTE_CARD_EFFECTS = [
  { name: 'V Regular', effect: DRIF_EFFECTS['swshp-SWSH179'] },
  { name: 'Trainer Full Art', effect: DRIF_EFFECTS['swsh6-196'] },
  { name: 'Lighting only', effect: CARD_NFT_2_NEUTRAL_CARD_EFFECT },
] as const;
