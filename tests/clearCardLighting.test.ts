import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createClearCardLightingPreset,
  DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID,
  parseClearCardLightingConfigJson,
  serializeClearCardLightingConfig,
} from '../src/clearCardLighting.ts';

const approved = JSON.parse(readFileSync(new URL('./fixtures/clearCardLighting.json', import.meta.url), 'utf8'));

test('storefront lighting exactly preserves the approved light and dark configurations', () => {
  assert.deepEqual(createClearCardLightingPreset(), approved.light);
  assert.deepEqual(createClearCardLightingPreset(DEFAULT_CLEAR_CARD_LIGHTING_PRESET_ID, { darkMode: true }), approved.dark);
});

test('editing a lighting configuration never changes subsequent viewer configurations', () => {
  const edited = createClearCardLightingPreset();
  edited.environment.sky.keyIntensity = 0;
  edited.point.position.x = 0;
  edited.transmission.packAlpha = 0;

  assert.deepEqual(createClearCardLightingPreset(), approved.light);
  assert.deepEqual(createClearCardLightingPreset(undefined, { darkMode: true }), approved.dark);
});

test('lighting editor exports round-trip both approved configurations', () => {
  for (const config of [approved.light, approved.dark]) {
    assert.deepEqual(parseClearCardLightingConfigJson(JSON.stringify(config)), config);
    assert.deepEqual(parseClearCardLightingConfigJson(serializeClearCardLightingConfig(config)), config);
  }
});

test('partial raw and version-one lighting imports preserve their original defaults', () => {
  const defaults = approved.importDefaults;
  for (const [partial, expected] of [
    [{}, defaults],
    [{ renderer: { exposure: 1.5 } }, { ...defaults, renderer: { ...defaults.renderer, exposure: 1.5 } }],
    [{ ambient: { enabled: false }, point: { position: { x: -4 } }, transmission: { packAlpha: 0 } }, {
      ...defaults,
      ambient: { ...defaults.ambient, enabled: false },
      point: { ...defaults.point, position: { ...defaults.point.position, x: -4 } },
      transmission: { ...defaults.transmission, packAlpha: 0 },
    }],
  ]) {
    assert.deepEqual(parseClearCardLightingConfigJson(JSON.stringify(partial)), expected);
    assert.deepEqual(parseClearCardLightingConfigJson(JSON.stringify({ version: 1, config: partial })), expected);
  }
});

test('lighting imports reject unsupported values', () => {
  assert.throws(() => parseClearCardLightingConfigJson('{'), /valid JSON/);
  assert.throws(() => parseClearCardLightingConfigJson('{"version":2,"config":{}}'), /version/);
  assert.throws(() => parseClearCardLightingConfigJson('{"renderer":{"toneMapping":"invalid"}}'), /unsupported/);
  assert.throws(() => parseClearCardLightingConfigJson('{"transmission":{"packAlpha":2}}'), /between/);
});
