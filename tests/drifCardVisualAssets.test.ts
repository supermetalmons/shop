import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRIF_GRAIN_URL,
  DRIF_GLITTER_URL,
  DRIF_EFFECTS,
  getDrifCardAssetSources,
  getDrifCardVisualAssetSources,
  type DrifCardConfig,
} from '../src/drifCards.ts';
import { PONCHO_DRIFELLA_CDN_BASE_URL } from '../src/config/dropMediaDefaults.ts';

const card: DrifCardConfig = {
  imageSrc: 'https://images.example/front.webp',
  foilSrc: 'https://images.example/foil.webp',
  textureSrc: 'https://images.example/mask.webp',
  effect: DRIF_EFFECTS['swshp-SWSH179']!,
};

test('visual asset sources include canonical grain and glitter alongside every holo layer', () => {
  assert.equal(DRIF_GRAIN_URL, `${PONCHO_DRIFELLA_CDN_BASE_URL}/misc/grain.webp`);
  assert.equal(DRIF_GLITTER_URL, `${PONCHO_DRIFELLA_CDN_BASE_URL}/misc/glitter.png`);
  assert.deepEqual(getDrifCardVisualAssetSources(card), [
    card.imageSrc, card.textureSrc, card.foilSrc, DRIF_GRAIN_URL, DRIF_GLITTER_URL,
  ]);
  assert.deepEqual(getDrifCardAssetSources(card), [card.imageSrc, card.textureSrc, card.foilSrc]);
});

test('visual sources support cards without holo layers, undefined cards, and duplicate assets', () => {
  assert.deepEqual(getDrifCardVisualAssetSources({ imageSrc: card.imageSrc, effect: card.effect }), [
    card.imageSrc, DRIF_GRAIN_URL, DRIF_GLITTER_URL,
  ]);
  assert.deepEqual(getDrifCardVisualAssetSources(undefined), []);
  assert.deepEqual(getDrifCardVisualAssetSources({ ...card, foilSrc: DRIF_GRAIN_URL, textureSrc: DRIF_GRAIN_URL }), [
    card.imageSrc, DRIF_GRAIN_URL, DRIF_GLITTER_URL,
  ]);
});
