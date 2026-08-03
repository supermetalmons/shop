import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createClearCardLightingPreset,
  DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID,
} from '../src/clearCardLighting.ts';

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

test('the dark storefront preset remains the existing default', () => {
  assert.equal(DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID, 'light-upcoming');
  assert.deepEqual(createClearCardLightingPreset().point.position, { x: -3.9, y: 5.5, z: 3 });
});
