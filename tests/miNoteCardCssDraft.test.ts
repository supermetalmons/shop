import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import {
  DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS,
  normalizeMiNoteCardCssEffectSettings,
  parseMiNoteCardCssEffectSettingsJson,
} from '../src/lib/miNoteCardCssEffects.ts';
import { MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY, useMiNoteCardCssDraft } from '../src/hooks/useMiNoteCardCssDraft.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');

afterEach(() => { cleanup(); window.localStorage.clear(); });
after(() => { dom.window.close(); });

test('a tuning draft survives remounts and Reset clears the saved settings', () => {
  const initial = renderHook(() => useMiNoteCardCssDraft());
  assert.deepEqual(initial.result.current.settings, DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS);
  assert.equal(window.localStorage.getItem(MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY), null);
  const tuned = normalizeMiNoteCardCssEffectSettings({
    ...initial.result.current.settings,
    glare: { ...initial.result.current.settings.glare, strength: 0.24, contrast: 2.1 },
  });
  act(() => initial.result.current.setSettings(tuned));
  assert.deepEqual(parseMiNoteCardCssEffectSettingsJson(window.localStorage.getItem(MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY)!), tuned);
  initial.unmount();

  const restored = renderHook(() => useMiNoteCardCssDraft());
  assert.deepEqual(restored.result.current.settings, tuned);
  act(() => restored.result.current.reset());
  assert.deepEqual(restored.result.current.settings, DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS);
  assert.equal(window.localStorage.getItem(MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY), null);
  restored.unmount();
  const reset = renderHook(() => useMiNoteCardCssDraft());
  assert.deepEqual(reset.result.current.settings, DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS);
});

test('invalid or incompatible stored drafts fall back to the original effect', () => {
  for (const source of ['{broken', JSON.stringify({ version: 2, effect: 'MI_NOTE_CARDS_DEFAULT', renderer: 'css', settings: {} }), JSON.stringify({ version: 1, effect: 'MI_NOTE_CARDS_DEFAULT', renderer: 'webgl', settings: {} })]) {
    window.localStorage.setItem(MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY, source);
    const view = renderHook(() => useMiNoteCardCssDraft());
    assert.deepEqual(view.result.current.settings, DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS);
    assert.equal(window.localStorage.getItem(MI_NOTE_CARD_CSS_DRAFT_STORAGE_KEY), null);
    view.unmount();
  }
});

test('unavailable storage does not prevent tuning or resetting', () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage unavailable'); },
  });
  try {
    const view = renderHook(() => useMiNoteCardCssDraft());
    const tuned = normalizeMiNoteCardCssEffectSettings({ ...view.result.current.settings, shine: { ...view.result.current.settings.shine, strength: 0.2 } });
    act(() => view.result.current.setSettings(tuned));
    assert.deepEqual(view.result.current.settings, tuned);
    act(() => view.result.current.reset());
    assert.deepEqual(view.result.current.settings, DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS);
    view.unmount();
  } finally {
    Object.defineProperty(window, 'localStorage', descriptor);
  }
});
