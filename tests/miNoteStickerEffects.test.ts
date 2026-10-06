import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import {
  DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS,
  MI_NOTE_STICKER_EFFECT_CONTROLS,
  MI_NOTE_STICKER_EFFECTS_STORAGE_KEY,
  normalizeMiNoteStickerEffectSettings,
  parseMiNoteStickerEffect,
  serializeMiNoteStickerEffect,
} from '../src/lib/miNoteStickerEffects.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useMiNoteStickerEffects } = await import('../src/hooks/useMiNoteStickerEffects.ts');
const storage = window.localStorage;
const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
const chosenSettings = {
  mode: 'prism' as const,
  width: 0.055,
  outerness: 0.7,
  softness: 0.55,
  strength: 0.57,
  scale: 0.95,
  hue: 0,
  variation: 0.47,
  motion: 1.05,
  shine: 0,
};

beforeEach(() => storage.clear());
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'localStorage', storageDescriptor);
});
after(() => dom.window.close());

test('normalization defaults invalid inputs and clamps every finite control without mutating input', () => {
  for (const value of [undefined, null, [], 'prism', 1, {}, { mode: 'unknown' }]) {
    assert.deepEqual(normalizeMiNoteStickerEffectSettings(value), DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
  }
  for (const { key, min, max } of MI_NOTE_STICKER_EFFECT_CONTROLS) {
    assert.equal(normalizeMiNoteStickerEffectSettings({ [key]: min - 1 })[key], min);
    assert.equal(normalizeMiNoteStickerEffectSettings({ [key]: max + 1 })[key], max);
    for (const value of [null, '', '0.5', true, NaN, Infinity, -Infinity]) {
      assert.equal(normalizeMiNoteStickerEffectSettings({ [key]: value })[key], DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS[key]);
    }
  }
  const input = { mode: 'pearl', width: 0.03125, strength: 2, extra: 'ignored' };
  const snapshot = { ...input };
  const normalized = normalizeMiNoteStickerEffectSettings(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(normalized, { ...chosenSettings, width: 0.03125, strength: 1 });
  for (const mode of ['ribbon', 'pearl', 'current', null, undefined]) {
    assert.equal(normalizeMiNoteStickerEffectSettings({ mode }).mode, 'prism');
  }
  assert.notEqual(normalizeMiNoteStickerEffectSettings(null), DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
});

test('the selected prism default and exported JSON retain the exact approved tuning', () => {
  assert.deepEqual(DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, chosenSettings);
  assert.equal(serializeMiNoteStickerEffect(DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS),
    JSON.stringify({ version: 2, effect: chosenSettings }, null, 2));
  assert.deepEqual(new Set(MI_NOTE_STICKER_EFFECT_CONTROLS.map(({ key }) => key)),
    new Set(Object.keys(DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS).filter(key => key !== 'mode')));
  assert.equal(MI_NOTE_STICKER_EFFECT_CONTROLS.length, 9);
  for (const { key, min, max, step } of MI_NOTE_STICKER_EFFECT_CONTROLS) {
    assert.ok(step > 0 && step <= max - min);
    assert.ok(chosenSettings[key] >= min && chosenSettings[key] <= max);
  }
});

test('version 2 exports round-trip prism tuning and normalize values before serialization', () => {
  for (const settings of [chosenSettings, { ...chosenSettings, width: 0.025, hue: 0.4, shine: 0.8 }]) {
    const serialized = serializeMiNoteStickerEffect(settings);
    assert.deepEqual(JSON.parse(serialized), { version: 2, effect: settings });
    assert.deepEqual(parseMiNoteStickerEffect(serialized), settings);
  }
  const settings = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, width: 99, hue: -1, strength: Infinity };
  assert.deepEqual(parseMiNoteStickerEffect(serializeMiNoteStickerEffect(settings)), {
    ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, width: 0.055, hue: 0,
  });
});

test('imports require a valid versioned effect document and give useful shape and mode errors', () => {
  for (const raw of ['', '{', 'not JSON']) assert.throws(() => parseMiNoteStickerEffect(raw), /valid sticker effect JSON/);
  for (const value of [null, [], 'prism', 1]) {
    assert.throws(() => parseMiNoteStickerEffect(JSON.stringify(value)), /object with version and effect fields/);
  }
  for (const version of [undefined, 0, 3, '1', '2', null]) {
    assert.throws(() => parseMiNoteStickerEffect(JSON.stringify({ version, effect: { mode: 'prism' } })), /version 1 or 2/);
  }
  for (const effect of [undefined, null, [], 'prism']) {
    assert.throws(() => parseMiNoteStickerEffect(JSON.stringify({ version: 1, effect })), /effect object/);
  }
  for (const version of [1, 2]) {
    for (const mode of [undefined, null, 'Prism', 'other', 'ribbon', 'pearl', 'current', 1]) {
      assert.throws(() => parseMiNoteStickerEffect(JSON.stringify({ version, effect: { mode } })), /must use the prism mode/);
    }
  }
});

test('imports reject invalid supplied controls, clamp numbers, and default omitted controls', () => {
  for (const { key, label, min, max } of MI_NOTE_STICKER_EFFECT_CONTROLS) {
    for (const version of [1, 2]) {
      for (const value of ['0.5', true, null, [], {}]) {
        assert.throws(() => parseMiNoteStickerEffect(JSON.stringify({ version, effect: { mode: 'prism', [key]: value } })),
          { message: `${label} must be a finite number.` });
      }
      assert.throws(() => parseMiNoteStickerEffect(`{"version":${version},"effect":{"mode":"prism","${key}":1e309}}`),
        { message: `${label} must be a finite number.` });
    }
    assert.equal(parseMiNoteStickerEffect(JSON.stringify({ version: 2, effect: { mode: 'prism', [key]: min - 1 } }))[key], min);
    assert.equal(parseMiNoteStickerEffect(JSON.stringify({ version: 2, effect: { mode: 'prism', [key]: max + 1 } }))[key], max);
  }
  for (const version of [1, 2]) {
    assert.deepEqual(parseMiNoteStickerEffect(JSON.stringify({ version, effect: { mode: 'prism', unknown: true } })), chosenSettings);
  }
});

test('version 1 imports halve supplied width before clamping and preserve all other tuning', () => {
  const legacy = { mode: 'prism', width: 0.085, softness: 0.65, strength: 0.57, scale: 2.1, hue: 0.34, variation: 0.63, motion: 0.7, shine: 0.4 };
  const migrated = parseMiNoteStickerEffect(JSON.stringify({ version: 1, effect: legacy }));
  assert.deepEqual(migrated, { ...legacy, width: 0.0425, outerness: 0.7 });
  assert.deepEqual(parseMiNoteStickerEffect(serializeMiNoteStickerEffect(migrated)), migrated);
  for (const [width, expected] of [[-1, 0.01], [0.02, 0.01], [0.085, 0.0425], [0.18, 0.055]]) {
    const effect = parseMiNoteStickerEffect(JSON.stringify({ version: 1, effect: { mode: 'prism', width } }));
    assert.equal(effect.mode, 'prism');
    assert.equal(effect.width, expected);
    assert.equal(effect.outerness, 0.7);
  }
  assert.equal(parseMiNoteStickerEffect('{"version":1,"effect":{"mode":"prism","outerness":0.4}}').outerness, 0.4);
  assert.equal(parseMiNoteStickerEffect('{"version":2,"effect":{"mode":"prism","width":0.04}}').width, 0.04);
});

test('mounting restores saved settings without writing storage in Strict Mode', t => {
  const settings = { ...chosenSettings, width: 0.03, outerness: 0.5 };
  const saved = serializeMiNoteStickerEffect(settings);
  storage.setItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY, saved);
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  const view = renderHook(useMiNoteStickerEffects, { reactStrictMode: true });
  assert.deepEqual(view.result.current.settings, settings);
  assert.equal(view.result.current.storageError, false);
  assert.equal(setItem.mock.callCount(), 0);
  assert.equal(storage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY), saved);
  view.rerender();
  assert.equal(setItem.mock.callCount(), 0);
});

test('the prism storage revision starts from the chosen default without touching experimental settings', t => {
  const oldKey = 'mi-note-sticker-effects:v1';
  const saved = JSON.stringify({ version: 2, effect: { ...chosenSettings, width: 0.02, outerness: 0.95, hue: 0.6 } });
  storage.setItem(oldKey, saved);
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  assert.equal(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY, 'mi-note-sticker-effects:prism-v1');
  const view = renderHook(useMiNoteStickerEffects, { reactStrictMode: true });
  assert.deepEqual(view.result.current.settings, chosenSettings);
  assert.equal(view.result.current.storageError, false);
  assert.equal(setItem.mock.callCount(), 0);
  assert.equal(storage.getItem(oldKey), saved);
  assert.equal(storage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY), null);

  act(() => view.result.current.setSettings(current => ({ ...current, width: 0.04, outerness: 0.6 })));

  const edited = { ...chosenSettings, width: 0.04, outerness: 0.6 };
  assert.deepEqual(JSON.parse(storage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY)!), { version: 2, effect: edited });
  assert.equal(storage.getItem(oldKey), saved);
  assert.equal(setItem.mock.callCount(), 1);
  view.unmount();
  const reloaded = renderHook(useMiNoteStickerEffects);
  assert.deepEqual(reloaded.result.current.settings, edited);
  assert.equal(storage.getItem(oldKey), saved);
  assert.equal(setItem.mock.callCount(), 1);
});

test('legacy local settings migrate in memory and save version 2 only after an edit', t => {
  const legacy = { mode: 'prism', width: 0.085, softness: 0.82, strength: 0.63, hue: 0.14 };
  const saved = JSON.stringify({ version: 1, effect: legacy });
  storage.setItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY, saved);
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  const view = renderHook(useMiNoteStickerEffects, { reactStrictMode: true });
  const expected = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, ...legacy, mode: 'prism', width: 0.0425, outerness: 0.7 };
  assert.deepEqual(view.result.current.settings, expected);
  assert.equal(view.result.current.storageError, false);
  assert.equal(setItem.mock.callCount(), 0);
  assert.equal(storage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY), saved);

  act(() => view.result.current.setSettings(current => ({ ...current, hue: 0.4 })));

  assert.equal(setItem.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(storage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY)!), {
    version: 2, effect: { ...expected, hue: 0.4 },
  });
  view.unmount();
  const reloaded = renderHook(useMiNoteStickerEffects);
  assert.deepEqual(reloaded.result.current.settings, { ...expected, hue: 0.4 });
  assert.equal(setItem.mock.callCount(), 1);
});

test('missing or corrupted storage keeps defaults usable without overwriting saved content', t => {
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  const empty = renderHook(useMiNoteStickerEffects);
  assert.deepEqual(empty.result.current.settings, DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
  assert.equal(empty.result.current.storageError, false);
  assert.equal(setItem.mock.callCount(), 0);
  empty.unmount();
  for (const saved of ['{', '{"version":3,"effect":{"mode":"prism"}}', '{"version":1,"effect":{"mode":"prism","strength":"invalid"}}',
    ...['ribbon', 'pearl', 'current'].map(mode => JSON.stringify({ version: 2, effect: { ...chosenSettings, mode } })),
  ]) {
    storage.setItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY, saved);
    const writesBefore = setItem.mock.callCount();
    const view = renderHook(useMiNoteStickerEffects, { reactStrictMode: true });
    assert.deepEqual(view.result.current.settings, DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
    assert.equal(view.result.current.storageError, true);
    assert.equal(setItem.mock.callCount(), writesBefore);
    assert.equal(storage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY), saved);
    const edited = { ...chosenSettings, width: 0.025, outerness: 0.8 };
    act(() => view.result.current.setSettings(edited));
    assert.equal(view.result.current.storageError, false);
    assert.deepEqual(parseMiNoteStickerEffect(storage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY)!), edited);
    view.unmount();
  }
});

test('batched functional edits keep every change, skip equivalent settings, and survive remount', t => {
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  const view = renderHook(useMiNoteStickerEffects, { reactStrictMode: true });
  act(() => {
    view.result.current.setSettings(current => ({ ...current, width: 0.05 }));
    view.result.current.setSettings(current => ({ ...current, hue: 0.2 }));
    view.result.current.setSettings(current => ({ ...current, strength: 2 }));
    view.result.current.setSettings(current => ({ ...current, strength: 1 }));
  });
  const expected = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, width: 0.05, hue: 0.2, strength: 1 };
  assert.deepEqual(view.result.current.settings, expected);
  assert.equal(setItem.mock.callCount(), 3);
  const currentSettings = view.result.current.settings;
  act(() => view.result.current.setSettings({ ...expected }));
  assert.equal(view.result.current.settings, currentSettings);
  assert.equal(setItem.mock.callCount(), 3);
  view.unmount();
  const reloaded = renderHook(useMiNoteStickerEffects);
  assert.deepEqual(reloaded.result.current.settings, expected);
  assert.equal(reloaded.result.current.storageError, false);
});

test('denied storage leaves settings editable and reports that persistence is unavailable', () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage access denied'); },
  });
  const view = renderHook(useMiNoteStickerEffects);
  assert.equal(view.result.current.storageError, true);
  assert.deepEqual(view.result.current.settings, DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
  act(() => view.result.current.setSettings(current => ({ ...current, motion: 0 })));
  assert.deepEqual(view.result.current.settings, { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, motion: 0 });
  assert.equal(view.result.current.storageError, true);
});

test('failed writes preserve edits and retrying identical settings recovers persistence', t => {
  const view = renderHook(useMiNoteStickerEffects);
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new Error('Storage quota exceeded'); });
  const edited = { ...chosenSettings, width: 0.03, outerness: 0.5 };
  act(() => view.result.current.setSettings(edited));
  assert.deepEqual(view.result.current.settings, edited);
  assert.equal(view.result.current.storageError, true);
  assert.equal(storage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY), null);
  setItem.mock.restore();
  act(() => view.result.current.setSettings(current => current));
  assert.equal(view.result.current.storageError, false);
  assert.deepEqual(parseMiNoteStickerEffect(storage.getItem(MI_NOTE_STICKER_EFFECTS_STORAGE_KEY)!), edited);
});
