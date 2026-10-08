import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS,
  miNoteCardCssEffectStyle,
  normalizeMiNoteCardCssEffectSettings,
  parseMiNoteCardCssEffectSettingsJson,
  serializeMiNoteCardCssEffectSettings,
} from '../src/lib/miNoteCardCssEffects.ts';

const defaults = DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS;

test('CSS settings retain the effective MI effect values and exact original HSL colors', () => {
  assert.deepEqual(defaults.shine, { strength: 1, brightness: 0.8, contrast: 2.95, saturation: 0.65, blendMode: 'color-dodge' });
  assert.deepEqual(defaults.secondary, { strength: 0.99, brightness: 1, contrast: 2.5, saturation: 1.75, blendMode: 'soft-light' });
  assert.deepEqual(defaults.glare, {
    strength: 0.5, brightness: 0.9, contrast: 1.75, saturation: 1, size: 1,
    offsetX: 0, offsetY: 0, blendMode: 'hard-light',
    stops: [
      { color: { h: 0, s: 0, l: 100 }, alpha: 1, position: 0 },
      { color: { h: 210, s: 3, l: 54 }, alpha: 0.33, position: 45 },
      { color: { h: 0, s: 0, l: 20 }, alpha: 0.9, position: 130 },
    ],
  });
  assert.deepEqual(defaults.pattern, {
    grainEnabled: true, grainSize: 500, rainbowSpacing: 5, stripeAngle: 133,
    rainbowColors: [
      { h: 2, s: 100, l: 73 }, { h: 53, s: 100, l: 69 }, { h: 93, s: 100, l: 69 },
      { h: 176, s: 100, l: 76 }, { h: 228, s: 100, l: 74 }, { h: 283, s: 100, l: 73 },
    ],
    blendModes: ['screen', 'hue', 'hard-light'],
  });
});

test('normalization returns independent defaults for missing or malformed settings', () => {
  for (const value of [undefined, null, [], 'css', 1, {}]) {
    const result = normalizeMiNoteCardCssEffectSettings(value);
    assert.deepEqual(result, defaults);
    result.glare.stops[0].color.h = 99;
    result.pattern.rainbowColors[0].l = 99;
    result.pattern.blendModes[0] = 'normal';
    assert.equal(defaults.glare.stops[0].color.h, 0);
    assert.equal(defaults.pattern.rainbowColors[0].l, 73);
    assert.equal(defaults.pattern.blendModes[0], 'screen');
  }
});

test('nonfinite and nonnumeric values fall back without dropping valid sibling settings', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '0.5', true, {}]) {
    const result = normalizeMiNoteCardCssEffectSettings({
      glare: { strength: value, brightness: value, contrast: value, saturation: value, size: value, offsetX: value, offsetY: value },
      shine: { strength: value, brightness: value, contrast: value, saturation: value },
      secondary: { strength: value, brightness: value, contrast: value, saturation: value },
      pattern: { grainSize: value, rainbowSpacing: value, stripeAngle: value },
    });
    assert.deepEqual(result, defaults);
  }
  assert.deepEqual(normalizeMiNoteCardCssEffectSettings({ shine: { brightness: NaN, contrast: 3.4 } }).shine, {
    ...defaults.shine, contrast: 3.4,
  });
});

test('normalization clamps every supported numeric range and orders gradient stops', () => {
  const input = {
    glare: {
      strength: 5, brightness: -1, contrast: 9, saturation: 8,
      size: 0, offsetX: -150, offsetY: 250,
      stops: [
        { color: { h: -10, s: -1, l: 120 }, alpha: -1, position: 150 },
        { color: { h: 410, s: 200, l: -1 }, alpha: 2, position: -50 },
        { position: 300 },
      ],
    },
    shine: { strength: -1, brightness: 8, contrast: -1, saturation: -1 },
    secondary: { strength: 2, brightness: -1, contrast: 8, saturation: 6 },
    pattern: { grainSize: 0, rainbowSpacing: 50, stripeAngle: 500 },
  };
  const original = structuredClone(input);
  const result = normalizeMiNoteCardCssEffectSettings(input);
  assert.deepEqual(input, original);
  assert.deepEqual(result.glare, {
    strength: 1, brightness: 0, contrast: 5, saturation: 3,
    size: 0.25, offsetX: -100, offsetY: 100, blendMode: 'hard-light',
    stops: [
      { color: { h: 0, s: 0, l: 100 }, alpha: 0, position: 150 },
      { color: { h: 360, s: 100, l: 0 }, alpha: 1, position: 150 },
      { ...defaults.glare.stops[2], position: 200 },
    ],
  });
  assert.deepEqual(result.shine, { strength: 0, brightness: 3, contrast: 0, saturation: 0, blendMode: 'color-dodge' });
  assert.deepEqual(result.secondary, { strength: 1, brightness: 0, contrast: 5, saturation: 3, blendMode: 'soft-light' });
  assert.equal(result.pattern.grainSize, 100);
  assert.equal(result.pattern.rainbowSpacing, 15);
  assert.equal(result.pattern.stripeAngle, 360);

  const opposite = normalizeMiNoteCardCssEffectSettings({
    glare: { size: 5, offsetX: 200, offsetY: -200 },
    pattern: { grainSize: 5000, rainbowSpacing: -1, stripeAngle: -1 },
  });
  assert.equal(opposite.glare.size, 3);
  assert.equal(opposite.glare.offsetX, 100);
  assert.equal(opposite.glare.offsetY, -100);
  assert.equal(opposite.pattern.grainSize, 1000);
  assert.equal(opposite.pattern.rainbowSpacing, 1);
  assert.equal(opposite.pattern.stripeAngle, 0);
});

test('only supported blend modes and actual booleans enter CSS settings', () => {
  const normalized = normalizeMiNoteCardCssEffectSettings({
    glare: { blendMode: 'color' }, shine: { blendMode: 'var(--unknown)' }, secondary: { blendMode: 'multiply' },
    pattern: { grainEnabled: 'false', blendModes: ['overlay', 'invalid', 'luminosity', 'screen'] },
  });
  assert.equal(normalized.glare.blendMode, 'color');
  assert.equal(normalized.shine.blendMode, defaults.shine.blendMode);
  assert.equal(normalized.secondary.blendMode, 'multiply');
  assert.equal(normalized.pattern.grainEnabled, true);
  assert.deepEqual(normalized.pattern.blendModes, ['overlay', 'hue', 'luminosity']);
  assert.equal(normalizeMiNoteCardCssEffectSettings({ pattern: { grainEnabled: false } }).pattern.grainEnabled, false);
});

test('style mapping keeps precise colors and scopes all controls to MI custom properties', () => {
  const style = miNoteCardCssEffectStyle(defaults) as Record<string, string | number>;
  assert.ok(Object.keys(style).every(key => key.startsWith('--mi-note-css-')));
  assert.equal(style['--mi-note-css-rainbow-1'], 'hsl(2, 100%, 73%)');
  assert.equal(style['--mi-note-css-glare-color-2'], 'hsla(210, 3%, 54%, 0.33)');
  assert.equal(style['--mi-note-css-glare-stop-3'], '130%');
  assert.equal(style['--mi-note-css-shine-brightness'], 0.8);
  assert.equal(style['--mi-note-css-secondary-strength'], 0.99);
  assert.equal(style['--mi-note-css-grain-size'], '500px');
  assert.equal(style['--mi-note-css-grain'], undefined);
  const edited = normalizeMiNoteCardCssEffectSettings({
    glare: { offsetX: -10, offsetY: 15, size: 2 }, pattern: { grainEnabled: false },
  });
  const next = miNoteCardCssEffectStyle(edited) as Record<string, string | number>;
  assert.equal(next['--mi-note-css-glare-offset-x'], '-10%');
  assert.equal(next['--mi-note-css-glare-offset-y'], '15%');
  assert.equal(next['--mi-note-css-glare-size'], 2);
  assert.equal(next['--mi-note-css-grain'], 'none');
});

test('JSON export is versioned, normalized, and contains only effect settings', () => {
  const settings = { ...defaults, cardId: 17, holdPose: true, panelOpen: false };
  const json = serializeMiNoteCardCssEffectSettings(settings);
  assert.ok(json.includes('\n  "version": 1'));
  assert.deepEqual(JSON.parse(json), { version: 1, effect: 'MI_NOTE_CARDS_DEFAULT', renderer: 'css', settings: defaults });
  assert.deepEqual(parseMiNoteCardCssEffectSettingsJson(json), defaults);
  const edited = normalizeMiNoteCardCssEffectSettings({ glare: { strength: 0.723, stops: [{ color: { h: 24.123, s: 98.765, l: 43.210 } }] } });
  assert.deepEqual(parseMiNoteCardCssEffectSettingsJson(serializeMiNoteCardCssEffectSettings(edited)), edited);
});

test('JSON parser rejects malformed drafts and incompatible envelopes', () => {
  for (const source of ['', '{', 'null', '[]', '{}', JSON.stringify(defaults)]) {
    assert.equal(parseMiNoteCardCssEffectSettingsJson(source), null);
  }
  const envelope = { version: 1, effect: 'MI_NOTE_CARDS_DEFAULT', renderer: 'css', settings: defaults };
  for (const invalid of [{ version: 2 }, { effect: 'v-regular' }, { renderer: 'webgl' }, { settings: null }, { settings: [] }]) {
    assert.equal(parseMiNoteCardCssEffectSettingsJson(JSON.stringify({ ...envelope, ...invalid })), null);
  }
  assert.deepEqual(parseMiNoteCardCssEffectSettingsJson(JSON.stringify({ ...envelope, settings: { shine: { brightness: 100 } } })), {
    ...defaults, shine: { ...defaults.shine, brightness: 3 },
  });
});
