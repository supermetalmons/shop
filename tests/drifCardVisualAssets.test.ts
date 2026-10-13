import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRIF_GRAIN_URL,
  DRIF_GLITTER_URL,
  DRIF_EFFECTS,
  CARD_NFT_2_NEUTRAL_CARD_EFFECT,
  getDrifCardAssetSources,
  getDrifCardVisualAssetSources,
  type DrifCardConfig,
} from '../src/drifCards.ts';
import { PONCHO_DRIFELLA_CDN_BASE_URL } from '../src/config/dropMediaDefaults.ts';
import { MI_NOTE_CARDS_DEFAULT } from '../src/lib/miNoteCardEffects.ts';

const card: DrifCardConfig = {
  imageSrc: 'https://images.example/front.webp',
  foilSrc: 'https://images.example/foil.webp',
  textureSrc: 'https://images.example/mask.webp',
  effect: DRIF_EFFECTS['swshp-SWSH179']!,
};

test('visual asset sources use canonical shared textures', () => {
  assert.equal(DRIF_GRAIN_URL, `${PONCHO_DRIFELLA_CDN_BASE_URL}/misc/grain.webp`);
  assert.equal(DRIF_GLITTER_URL, `${PONCHO_DRIFELLA_CDN_BASE_URL}/misc/glitter.png`);
  assert.deepEqual(getDrifCardAssetSources(card), [card.imageSrc, card.textureSrc, card.foilSrc]);
});

for (const [effect, expected] of [
  [DRIF_EFFECTS['swshp-SWSH179']!, [card.imageSrc, card.textureSrc, DRIF_GRAIN_URL]],
  [MI_NOTE_CARDS_DEFAULT, [card.imageSrc, card.textureSrc, DRIF_GRAIN_URL]],
  [DRIF_EFFECTS['pgo-24']!, [card.imageSrc, card.textureSrc]],
  [DRIF_EFFECTS['swsh6-196']!, [card.imageSrc, card.textureSrc, card.foilSrc]],
  [DRIF_EFFECTS['swsh4-9']!, [card.imageSrc, card.textureSrc, card.foilSrc, DRIF_GLITTER_URL]],
  [CARD_NFT_2_NEUTRAL_CARD_EFFECT, [card.imageSrc]],
] as const) {
  test(`${effect.effectKey} only waits for textures used by its effect`, () => {
    assert.deepEqual(getDrifCardVisualAssetSources({ ...card, effect }), expected);
  });
}

test('visual sources support cards without holo layers, undefined cards, and duplicate assets', () => {
  assert.deepEqual(getDrifCardVisualAssetSources({ imageSrc: card.imageSrc, effect: card.effect }), [
    card.imageSrc, DRIF_GRAIN_URL,
  ]);
  assert.deepEqual(getDrifCardVisualAssetSources(undefined), []);
  assert.deepEqual(getDrifCardVisualAssetSources({ ...card, foilSrc: DRIF_GRAIN_URL, textureSrc: DRIF_GRAIN_URL }), [
    card.imageSrc, DRIF_GRAIN_URL,
  ]);
});
