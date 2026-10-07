import { DRIF_EFFECTS, DRIF_EFFECT_KEYS, type DrifCardConfig } from '../drifCards.ts';
import type { MiNoteDemoCardId } from './miNoteCardReveal.ts';
import front1302 from '../../mi_note_cards_demo/front/1302.webp';
import front1325 from '../../mi_note_cards_demo/front/1325.webp';
import front1327 from '../../mi_note_cards_demo/front/1327.webp';
import foil1302 from '../../mi_note_cards_demo/foil/1302.webp';
import foil1325 from '../../mi_note_cards_demo/foil/1325.webp';
import foil1327 from '../../mi_note_cards_demo/foil/1327.webp';
import mask1302 from '../../mi_note_cards_demo/mask/1302.webp';
import mask1325 from '../../mi_note_cards_demo/mask/1325.webp';
import mask1327 from '../../mi_note_cards_demo/mask/1327.webp';

export const MI_NOTE_DEMO_CARDS = {
  1302: { id: 1302, name: 'Emo★Purple Drifella', imageSrc: front1302, foilSrc: foil1302, textureSrc: mask1302 },
  1325: { id: 1325, name: 'The Dratini Player', imageSrc: front1325, foilSrc: foil1325, textureSrc: mask1325 },
  1327: { id: 1327, name: 'Strawberry Saint', imageSrc: front1327, foilSrc: foil1327, textureSrc: mask1327 },
} satisfies Record<MiNoteDemoCardId, {
  id: MiNoteDemoCardId;
  name: string;
  imageSrc: string;
  foilSrc: string;
  textureSrc: string;
}>;

export function createMiNoteDemoCard(
  id: MiNoteDemoCardId,
  effect: DrifCardConfig['effect'] = DRIF_EFFECTS['swshp-SWSH179'],
): DrifCardConfig {
  const artwork = MI_NOTE_DEMO_CARDS[id];
  const base: DrifCardConfig = { imageSrc: artwork.imageSrc, effect, glowType: 'metal' };
  return effect.effectKey === DRIF_EFFECT_KEYS.lightingOnly ? base : {
    ...base,
    foilSrc: artwork.foilSrc,
    textureSrc: artwork.textureSrc,
  };
}
