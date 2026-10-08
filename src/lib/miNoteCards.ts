import { DRIF_EFFECTS, DRIF_EFFECT_KEYS, type DrifCardConfig } from '../drifCards.ts';

export const MI_NOTE_CARD_COUNT = 1430;

export function sampleMiNoteIndex(count: number, random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.max(0, Math.min(count - 1, Math.floor(value * count))) : 0;
}

export function sampleMiNoteCardId(random: () => number = Math.random): number {
  return sampleMiNoteIndex(MI_NOTE_CARD_COUNT, random) + 1;
}

export function createMiNoteCard(
  id: number,
  effect: DrifCardConfig['effect'] = DRIF_EFFECTS['swshp-SWSH179'],
): DrifCardConfig {
  const baseUrl = 'https://cdn.lil.org/nft/mi_note_cards';
  const base: DrifCardConfig = { imageSrc: `${baseUrl}/fronts/${id}.webp`, effect, glowType: 'metal' };
  return effect.effectKey === DRIF_EFFECT_KEYS.lightingOnly ? base : {
    ...base,
    foilSrc: `${baseUrl}/foils/${id}.webp`,
    textureSrc: `${baseUrl}/masks/${id}.webp`,
  };
}
