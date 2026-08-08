import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClearCardLightingPreset,
  DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID,
} from '../src/clearCardLighting.ts';
import { clearCardDropPreviewLightingPresetId } from '../src/components/ClearCardDropPreview.tsx';

test('light storefront preset keeps the supplied white-background lighting values', () => {
  const config = createClearCardLightingPreset('dgpm-light-upcoming-white-bg');

  assert.equal(config.renderer.toneMapping, 'aces');
  assert.equal(config.renderer.exposure, 1.25);
  assert.equal(config.environment.mode, 'room');
  assert.equal(config.environment.rotation, 121);
  assert.deepEqual(config.point.position, { x: -6.5, y: 1.2, z: 3 });
  assert.equal(config.point.intensity, 17);
  assert.equal(config.point.decay, 0.4);
  assert.equal(config.spot.intensity, 110);
  assert.equal(config.transmission.cardAlpha, 0.3);
  assert.equal(config.transmission.packAlpha, 0.13);
});

test('final candidate duplicates the light storefront preset', () => {
  const source = createClearCardLightingPreset('dgpm-light-upcoming-white-bg');
  const candidate = createClearCardLightingPreset('final_candidate');

  assert.deepEqual(candidate, source);
});

test('final v1 uses the updated unpacking lighting', () => {
  const expected = createClearCardLightingPreset('dgpm-light-upcoming-white-bg');
  expected.renderer.exposure = 1;
  expected.environment.intensity = 1.8;
  expected.spot.intensity = 109;
  expected.transmission.packAlpha = 0.76;

  const finalV1 = createClearCardLightingPreset('final_v1');

  assert.deepEqual(finalV1, expected);
});

test('final v2 duplicates final v1 with lower pack alpha', () => {
  const expected = createClearCardLightingPreset('final_v1');
  expected.transmission.packAlpha = 0.55;

  const finalV2 = createClearCardLightingPreset('final_v2');

  assert.deepEqual(finalV2, expected);
});

test('final v3 adapts pack alpha to the color scheme and is the default', () => {
  const expectedLight = createClearCardLightingPreset('final_v1');
  expectedLight.transmission.packAlpha = 0.55;
  const expectedDark = createClearCardLightingPreset('final_v1');
  expectedDark.transmission.packAlpha = 0.76;

  const light = createClearCardLightingPreset('final_v3');
  const dark = createClearCardLightingPreset('final_v3', { darkMode: true });

  assert.equal(DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID, 'final_v3');
  assert.deepEqual(light, expectedLight);
  assert.deepEqual(dark, expectedDark);
  assert.deepEqual(createClearCardLightingPreset(), light);
});

test('MintPanel Clear Cards preview preserves its theme-specific lighting', () => {
  assert.equal(clearCardDropPreviewLightingPresetId(true), 'light-upcoming');
  assert.equal(
    clearCardDropPreviewLightingPresetId(false),
    'dgpm-light-upcoming-white-bg',
  );
});
