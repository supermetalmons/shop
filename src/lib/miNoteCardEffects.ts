import { DRIF_EFFECT_KEYS, type DrifCardConfig } from '../drifCards.ts';

export const MI_NOTE_CARDS_DEFAULT = Object.freeze({
  id: 'mi-note-cards-default',
  effectKey: DRIF_EFFECT_KEYS.miNoteCardsDefault,
  source: 'mi_note_cards',
  setId: 'swshp',
  number: 'swsh179',
  rarity: 'mi-note-cards-default',
  supertype: 'pokémon',
  subtypes: 'basic v single strike',
  trainerGallery: false,
  typeClass: 'fire',
} satisfies DrifCardConfig['effect']);
