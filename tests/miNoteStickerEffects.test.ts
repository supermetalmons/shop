import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS,
  normalizeMiNoteStickerEffectSettings,
} from '../src/lib/miNoteStickerEffects.ts';

const chosenSettings = {
  mode: 'prism' as const,
  width: 0.055,
  outerness: 0.13,
  softness: 1,
  strength: 0.66,
  scale: 1.5,
  hue: 0,
  variation: 0,
  motion: 0.9,
  shine: 0,
};

test('the prism default retains the exact approved tuning', () => {
  assert.deepEqual(DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, chosenSettings);
  assert.deepEqual(normalizeMiNoteStickerEffectSettings(chosenSettings), chosenSettings);
});

test('normalization defaults invalid inputs and clamps finite settings without mutating input', () => {
  for (const value of [undefined, null, [], 'prism', 1, {}, { mode: 'unknown' }]) {
    assert.deepEqual(normalizeMiNoteStickerEffectSettings(value), chosenSettings);
  }
  for (const key of Object.keys(chosenSettings).filter(key => key !== 'mode')) {
    for (const value of [null, '', '0.5', true, NaN, Infinity, -Infinity]) {
      assert.deepEqual(normalizeMiNoteStickerEffectSettings({ [key]: value }), chosenSettings);
    }
  }
  const input = {
    mode: 'pearl', width: 1, outerness: -1, softness: -1, strength: 2,
    scale: 99, hue: -1, variation: 2, motion: 3, shine: -1, extra: 'ignored',
  };
  const snapshot = { ...input };
  assert.deepEqual(normalizeMiNoteStickerEffectSettings(input), {
    mode: 'prism', width: 0.055, outerness: 0, softness: 0.2, strength: 1,
    scale: 3, hue: 0, variation: 1, motion: 2, shine: 0,
  });
  assert.deepEqual(input, snapshot);
  assert.notEqual(normalizeMiNoteStickerEffectSettings(null), DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
});
