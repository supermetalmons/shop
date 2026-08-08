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

test('final v1 uses the updated unpacking lighting and is the default', () => {
  const expected = createClearCardLightingPreset('dgpm-light-upcoming-white-bg');
  expected.renderer.exposure = 1;
  expected.environment.intensity = 1.8;
  expected.spot.intensity = 109;
  expected.transmission.packAlpha = 0.76;

  const finalV1 = createClearCardLightingPreset('final_v1');

  assert.equal(DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID, 'final_v1');
  assert.deepEqual(finalV1, expected);
  assert.deepEqual(createClearCardLightingPreset(), finalV1);
});

test('MintPanel Clear Cards preview preserves its theme-specific lighting', () => {
  assert.equal(clearCardDropPreviewLightingPresetId(true), 'light-upcoming');
  assert.equal(
    clearCardDropPreviewLightingPresetId(false),
    'dgpm-light-upcoming-white-bg',
  );
});
