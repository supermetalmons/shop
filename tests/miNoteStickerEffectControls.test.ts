import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useState } from 'react';
import {
  DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS,
  MI_NOTE_STICKER_EFFECT_CONTROLS,
  serializeMiNoteStickerEffect,
  type MiNoteStickerEffectSettings,
} from '../src/lib/miNoteStickerEffects.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const imports = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});
const { default: MiNoteStickerEffectControls } = await import('../src/components/MiNoteStickerEffectControls.tsx');
imports.deregister();

let current: MiNoteStickerEffectSettings;
let changes: MiNoteStickerEffectSettings[];

function Harness({ storageError = false, withInspect = false }: { storageError?: boolean; withInspect?: boolean }) {
  const [settings, setSettings] = useState<MiNoteStickerEffectSettings>({ ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS });
  const [inspectSticker, setInspectSticker] = useState(false);
  current = settings;
  return createElement(MiNoteStickerEffectControls, {
    settings,
    storageError,
    inspectSticker,
    onInspectChange: withInspect ? setInspectSticker : undefined,
    onChange(next) { changes.push(next); setSettings(next); },
  });
}

function openPanel(storageError = false) {
  const view = render(createElement(Harness, { storageError }));
  fireEvent.click(view.getByRole('button', { name: 'Sticker finish' }));
  return view;
}

beforeEach(() => {
  changes = [];
  Reflect.deleteProperty(navigator, 'clipboard');
});
afterEach(cleanup);
after(() => dom.window.close());

test('finish controls show only Prismatic foil, preserve collapsed settings, and reset the selected defaults', () => {
  const view = render(createElement(Harness));
  const toggle = view.getByRole('button', { name: 'Sticker finish' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(view.queryByRole('slider'), null);
  fireEvent.click(toggle);
  assert.equal(view.queryByRole('combobox'), null);
  assert.ok(view.getByRole('heading', { name: 'Prismatic foil' }));
  assert.equal(view.getAllByRole('slider').length, 9);
  fireEvent.change(view.getByRole('slider', { name: 'Shine' }), { target: { value: '0.79' } });
  assert.equal(current.shine, 0.79);
  fireEvent.click(toggle);
  assert.equal(view.queryByRole('slider'), null);
  fireEvent.click(toggle);
  assert.equal((view.getByRole('slider', { name: 'Shine' }) as HTMLInputElement).value, '0.79');
  fireEvent.click(view.getByRole('button', { name: 'Reset defaults' }));
  assert.deepEqual(current, {
    mode: 'prism', width: 0.055, outerness: 0.7, softness: 0.55, strength: 0.57,
    scale: 0.95, hue: 0, variation: 0.47, motion: 1.05, shine: 0,
  });
});

test('all nine numeric controls stay enabled and update their own setting live', () => {
  const view = openPanel();
  for (const control of MI_NOTE_STICKER_EFFECT_CONTROLS) {
    const previous = { ...current };
    const slider = view.getByRole('slider', { name: control.label }) as HTMLInputElement;
    assert.equal(slider.min, String(control.min));
    assert.equal(slider.max, String(control.max));
    assert.equal(slider.step, String(control.step));
    assert.equal(slider.disabled, false);
    const next = previous[control.key] === control.max ? control.min : control.max;
    fireEvent.change(slider, { target: { value: String(next) } });
    assert.deepEqual(current, { ...previous, [control.key]: next });
    assert.ok(slider.getAttribute('aria-valuetext'));
  }
  assert.equal(changes.length, 9);
});

test('copy exports the active versioned settings and acknowledges success', async () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value: string) { writes.push(value); } } });
  const view = openPanel();
  fireEvent.change(view.getByRole('slider', { name: 'Strength' }), { target: { value: '0.63' } });
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Copy sticker finish JSON' })); });
  assert.deepEqual(writes, [serializeMiNoteStickerEffect(current)]);
  assert.match(view.getByRole('status', { name: 'Sticker finish status' }).textContent!, /copied/);
  assert.equal(view.queryByRole('textbox'), null);
});

test('Outerness and Blend explain the band, update live, and survive a version 2 JSON round trip', async () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value: string) { writes.push(value); } } });
  const view = openPanel();
  const outward = view.getByRole('slider', { name: 'Outerness' }) as HTMLInputElement;
  const blend = view.getByRole('slider', { name: 'Blend' }) as HTMLInputElement;
  const hint = document.getElementById(outward.getAttribute('aria-describedby')!)!;
  assert.match(hint.textContent!, /Outerness moves the band outside the artwork\. Blend softens the join\./);
  assert.equal(blend.getAttribute('aria-describedby'), hint.id);
  fireEvent.change(outward, { target: { value: '0.72' } });
  fireEvent.change(blend, { target: { value: '0.83' } });
  assert.equal(current.outerness, 0.72);
  assert.equal(current.softness, 0.83);
  assert.equal(outward.getAttribute('aria-valuetext'), '72%');
  assert.equal(blend.getAttribute('aria-valuetext'), '83%');
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Copy sticker finish JSON' })); });
  const exported = JSON.parse(writes[0]);
  assert.equal(exported.version, 2);
  assert.equal(exported.effect.outerness, 0.72);
  assert.equal(exported.effect.softness, 0.83);
  fireEvent.click(view.getByRole('button', { name: 'Reset defaults' }));
  assert.equal(current.outerness, DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS.outerness);
  fireEvent.click(view.getByRole('button', { name: 'Import sticker finish JSON' }));
  fireEvent.change(view.getByRole('textbox', { name: 'Sticker finish JSON' }), { target: { value: writes[0] } });
  fireEvent.click(view.getByRole('button', { name: 'Apply finish' }));
  assert.deepEqual(current, exported.effect);
  assert.equal((view.getByRole('slider', { name: 'Outerness' }) as HTMLInputElement).value, '0.72');
});

test('band width displays quarter-percent steps without rounding away precision', () => {
  const view = openPanel();
  const width = view.getByRole('slider', { name: 'Band width' }) as HTMLInputElement;
  fireEvent.change(width, { target: { value: '0.0425' } });
  assert.equal(width.getAttribute('aria-valuetext'), '4.25%');
  assert.equal(view.container.querySelector(`output[for="${width.id}"]`)?.textContent, '4.25%');
  fireEvent.change(width, { target: { value: '0.04' } });
  assert.equal(width.getAttribute('aria-valuetext'), '4%');
});

test('clipboard rejection provides selected read-only JSON and restores copy-button focus', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() { throw new Error('Denied'); } } });
  const view = openPanel();
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Copy sticker finish JSON' })); });
  const textarea = view.getByRole('textbox', { name: 'Sticker finish JSON' }) as HTMLTextAreaElement;
  assert.equal(textarea.readOnly, true);
  assert.equal(textarea.value, serializeMiNoteStickerEffect(current));
  assert.equal(document.activeElement, textarea);
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, textarea.value.length);
  fireEvent.click(view.getByRole('button', { name: 'Close finish JSON editor' }));
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Copy sticker finish JSON' }));
});

test('import rejects invalid JSON without changing the finish, then applies a saved finish', () => {
  const view = openPanel();
  fireEvent.click(view.getByRole('button', { name: 'Import sticker finish JSON' }));
  const textarea = view.getByRole('textbox', { name: 'Sticker finish JSON' }) as HTMLTextAreaElement;
  const apply = view.getByRole('button', { name: 'Apply finish' }) as HTMLButtonElement;
  assert.equal(document.activeElement, textarea);
  assert.equal(apply.disabled, true);
  fireEvent.change(textarea, { target: { value: '{ nope }' } });
  fireEvent.click(apply);
  assert.match(view.getByRole('alert').textContent!, /valid.*JSON/i);
  assert.equal(textarea.getAttribute('aria-invalid'), 'true');
  assert.equal(changes.length, 0);
  const imported = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, shine: 0.75 };
  fireEvent.change(textarea, { target: { value: serializeMiNoteStickerEffect(imported) } });
  assert.equal(view.queryByRole('alert'), null);
  fireEvent.click(apply);
  assert.deepEqual(current, imported);
  assert.equal(view.queryByRole('textbox'), null);
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Import sticker finish JSON' }));
});

test('Escape closes the editor, then the panel, before reaching page-level handlers', () => {
  const view = openPanel();
  let pageEscapes = 0;
  const pageKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') pageEscapes += 1; };
  document.addEventListener('keydown', pageKeyDown);
  try {
    fireEvent.click(view.getByRole('button', { name: 'Import sticker finish JSON' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    assert.equal(view.queryByRole('textbox'), null);
    assert.equal(view.getByRole('button', { name: 'Sticker finish' }).getAttribute('aria-expanded'), 'true');
    assert.equal(pageEscapes, 0);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    assert.equal(view.getByRole('button', { name: 'Sticker finish' }).getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, view.getByRole('button', { name: 'Sticker finish' }));
    assert.equal(pageEscapes, 0);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    assert.equal(pageEscapes, 1);
  } finally {
    document.removeEventListener('keydown', pageKeyDown);
  }
});

test('late clipboard failures cannot open an export after settings change or panel collapse', async () => {
  let rejectCopy: (error: Error) => void = () => undefined;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText() { return new Promise<void>((_, reject) => { rejectCopy = reject; }); } } });
  const view = openPanel();
  fireEvent.click(view.getByRole('button', { name: 'Copy sticker finish JSON' }));
  fireEvent.change(view.getByRole('slider', { name: 'Shine' }), { target: { value: '0.79' } });
  await act(async () => { rejectCopy(new Error('Denied')); });
  assert.equal(view.queryByRole('textbox'), null);
  fireEvent.click(view.getByRole('button', { name: 'Copy sticker finish JSON' }));
  fireEvent.click(view.getByRole('button', { name: 'Sticker finish' }));
  await act(async () => { rejectCopy(new Error('Denied')); });
  fireEvent.click(view.getByRole('button', { name: 'Sticker finish' }));
  assert.equal(view.queryByRole('textbox'), null);
  assert.ok(view.getByRole('slider', { name: 'Shine' }));
});

test('storage failure explains how to retain settings without preventing tuning', () => {
  const view = openPanel(true);
  assert.match(view.getByRole('status', { name: 'Sticker finish status' }).textContent!, /Not saved locally.*Copy JSON/);
  fireEvent.change(view.getByRole('slider', { name: 'Shine' }), { target: { value: '0.71' } });
  assert.equal(current.shine, 0.71);
});

test('optional close-up toggles inspection without changing or exporting effect settings', () => {
  const view = render(createElement(Harness, { withInspect: true }));
  fireEvent.click(view.getByRole('button', { name: 'Sticker finish' }));
  const button = view.getByRole('button', { name: 'Close-up' });
  const original = serializeMiNoteStickerEffect(current);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(changes.length, 0);
  assert.equal(serializeMiNoteStickerEffect(current), original);
  fireEvent.click(view.getByRole('button', { name: 'Import sticker finish JSON' }));
  assert.equal(view.queryByRole('button', { name: 'Close-up' }), null);
});

test('open controls reserve their measured height and release it when collapsed', () => {
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  let measure = () => undefined;
  let disconnected = false;
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => undefined) { measure = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  });
  try {
    const view = render(createElement('div', { className: 'mi-note-wip-page' }, createElement(Harness)));
    const root = view.container.querySelector<HTMLElement>('.mi-note-sticker-effects')!;
    const page = view.container.querySelector<HTMLElement>('.mi-note-wip-page')!;
    root.getBoundingClientRect = () => ({ height: 352.4 }) as DOMRect;
    fireEvent.click(view.getByRole('button', { name: 'Sticker finish' }));
    assert.equal(page.style.getPropertyValue('--mi-note-sticker-controls-height'), '353px');
    root.getBoundingClientRect = () => ({ height: 320 }) as DOMRect;
    measure();
    assert.equal(page.style.getPropertyValue('--mi-note-sticker-controls-height'), '320px');
    fireEvent.click(view.getByRole('button', { name: 'Sticker finish' }));
    assert.equal(disconnected, true);
    assert.equal(page.style.getPropertyValue('--mi-note-sticker-controls-height'), '');
  } finally {
    if (originalObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalObserver);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});
