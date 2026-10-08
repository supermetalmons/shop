import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach } from 'node:test';
import { createElement, useState } from 'react';
import {
  DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS,
  normalizeMiNoteCardCssEffectSettings,
  serializeMiNoteCardCssEffectSettings,
  type MiNoteCardCssEffectSettings,
} from '../src/lib/miNoteCardCssEffects.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const imports = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});
const { default: MiNoteCardCssEffectPanel } = await import('../src/components/MiNoteCardCssEffectPanel.tsx');
imports.deregister();

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});
after(() => dom.window.close());

function setup(initialSettings = DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS) {
  let settings = normalizeMiNoteCardCssEffectSettings(initialSettings);
  let edits = 0;
  let resets = 0;
  function Harness() {
    const [current, setCurrent] = useState(settings);
    const [open, setOpen] = useState(true);
    const [holdPose, setHoldPose] = useState(true);
    return createElement(MiNoteCardCssEffectPanel, {
      settings: current,
      onChange(next: MiNoteCardCssEffectSettings) { settings = next; edits += 1; setCurrent(next); },
      onReset() { resets += 1; settings = normalizeMiNoteCardCssEffectSettings(DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS); setCurrent(settings); },
      holdPose,
      onHoldPoseChange: setHoldPose,
      open,
      onOpenChange: setOpen,
    });
  }
  return { ...render(createElement(Harness)), settings: () => settings, edits: () => edits, resets: () => resets };
}

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

test('exposes only the retained glare and hold controls', () => {
  const view = setup();
  const controlNames = [
    'Glare strength', 'Glare brightness', 'Glare contrast', 'Glare size',
  ];
  assert.deepEqual(view.getAllByRole('slider', { hidden: true }).map(control => control.getAttribute('aria-label')), controlNames);
  assert.deepEqual(view.getAllByRole('spinbutton', { hidden: true }).map(control => control.getAttribute('aria-label')), controlNames.map(name => `${name} value`));
  assert.equal(view.getAllByRole('checkbox', { hidden: true }).length, 1);
  assert.equal(view.getAllByRole('combobox', { hidden: true }).length, 1);
  assert.equal(view.container.querySelectorAll('details').length, 0);
  assert.equal(view.container.querySelector('input[type="color"]'), null);
  assert.equal(view.queryByText('Foil / shine'), null);
  assert.equal(view.queryByText('Secondary shine'), null);
  assert.equal(view.queryByText('Pattern advanced'), null);
  assert.equal(view.queryByText('Glare advanced'), null);
  assert.ok(view.getByRole('combobox', { name: 'Glare blend' }));
  assert.equal(view.edits(), 0);
  assert.deepEqual(view.settings(), DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS);
  fireEvent.change(view.getByRole('slider', { name: 'Glare strength' }), { target: { value: '0.72' } });
  assert.equal(view.settings().glare.strength, 0.72);
  assert.deepEqual(view.settings().glare.stops, DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS.glare.stops);
  assert.deepEqual(view.settings().pattern.rainbowColors, DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS.pattern.rainbowColors);
  fireEvent.click(view.getByRole('checkbox', { name: 'Hold last pose' }));
  assert.equal((view.getByRole('checkbox', { name: 'Hold last pose' }) as HTMLInputElement).checked, false);
  fireEvent.click(view.getByRole('button', { name: 'CSS effect Hide' }));
  assert.equal(view.queryByRole('slider'), null);
  assert.equal(view.getByRole('button', { name: 'CSS effect Tune' }).getAttribute('aria-expanded'), 'false');
  fireEvent.click(view.getByRole('button', { name: 'CSS effect Tune' }));
  assert.equal((view.getByRole('slider', { name: 'Glare strength' }) as HTMLInputElement).value, '0.72');
});

test('numeric drafts retain the last valid setting and commit within bounds', () => {
  const view = setup();
  const input = view.getByRole('spinbutton', { name: 'Glare strength value' }) as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '' } });
  assert.equal(input.value, '');
  assert.equal(view.settings().glare.strength, 0.5);
  fireEvent.blur(input);
  assert.equal(input.value, '0.5');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '4' } });
  assert.equal(view.settings().glare.strength, 1);
  fireEvent.blur(input);
  assert.equal(input.value, '1');
  fireEvent.click(view.getByRole('button', { name: 'Reset' }));
  assert.equal(input.value, '0.5');
  assert.equal(view.resets(), 1);
});

test('editing retained controls preserves hidden draft settings in the complete JSON export', async () => {
  const saved = normalizeMiNoteCardCssEffectSettings(DEFAULT_MI_NOTE_CARD_CSS_EFFECT_SETTINGS);
  saved.glare.saturation = 2.15;
  saved.glare.offsetX = 24;
  saved.glare.offsetY = -32;
  saved.glare.stops[1] = { color: { h: 184.5, s: 22.75, l: 64.2 }, alpha: 0.42, position: 67 };
  saved.shine = { strength: 0.96, brightness: 2.96, contrast: 5, saturation: 2.73, blendMode: 'overlay' };
  saved.secondary = { strength: 0.25, brightness: 1.2, contrast: 3, saturation: 0.9, blendMode: 'screen' };
  saved.pattern.grainEnabled = false;
  saved.pattern.grainSize = 750;
  saved.pattern.rainbowSpacing = 7.5;
  saved.pattern.stripeAngle = 160;
  saved.pattern.rainbowColors[2] = { h: 92.1, s: 75.2, l: 43.3 };
  saved.pattern.blendModes = ['overlay', 'screen', 'multiply'];
  const view = setup(saved);
  fireEvent.change(view.getByRole('slider', { name: 'Glare strength' }), { target: { value: '0.72' } });
  fireEvent.change(view.getByRole('combobox', { name: 'Glare blend' }), { target: { value: 'soft-light' } });
  const expected: MiNoteCardCssEffectSettings = {
    ...saved,
    glare: { ...saved.glare, strength: 0.72, blendMode: 'soft-light' },
  };
  assert.deepEqual(view.settings(), expected);
  let written = '';
  clipboard(async text => { written = text; });
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Copy JSON' })));
  assert.deepEqual(JSON.parse(written), {
    version: 1,
    effect: 'MI_NOTE_CARDS_DEFAULT',
    renderer: 'css',
    settings: expected,
  });
});

test('clipboard reports success only after writing the complete export', async () => {
  let written = '';
  let resolve!: () => void;
  clipboard(text => { written = text; return new Promise<void>(done => { resolve = done; }); });
  const view = setup();
  fireEvent.click(view.getByRole('button', { name: 'Copy JSON' }));
  assert.equal(written, serializeMiNoteCardCssEffectSettings(view.settings()));
  assert.equal(view.queryByText('Settings copied.'), null);
  assert.equal((view.getByRole('button', { name: 'Copying…' }) as HTMLButtonElement).disabled, true);
  await act(async () => resolve());
  assert.ok(view.getByText('Settings copied.'));
  assert.ok(view.getByRole('button', { name: 'Copied' }));
  fireEvent.change(view.getByRole('slider', { name: 'Glare strength' }), { target: { value: '0.6' } });
  assert.equal(view.queryByText('Settings copied.'), null);
});

test('clipboard rejection exposes the same export for manual selection', async () => {
  let written = '';
  clipboard(async text => { written = text; throw new Error('Denied'); });
  const view = setup();
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Copy JSON' })));
  const fallback = view.getByRole('textbox', { name: 'Effect settings JSON' }) as HTMLTextAreaElement;
  assert.equal(fallback.value, written);
  assert.equal(fallback.readOnly, true);
  fireEvent.focus(fallback);
  assert.equal(fallback.selectionStart, 0);
  assert.equal(fallback.selectionEnd, fallback.value.length);
  assert.equal(view.queryByText('Settings copied.'), null);
});

test('missing clipboard API also exposes JSON and ignores a stale copy after reset', async () => {
  const view = setup();
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'Copy JSON' })));
  assert.ok(view.getByRole('textbox', { name: 'Effect settings JSON' }));
  fireEvent.click(view.getByRole('button', { name: 'Reset' }));
  assert.equal(view.queryByRole('textbox', { name: 'Effect settings JSON' }), null);
  let resolve!: () => void;
  clipboard(() => new Promise<void>(done => { resolve = done; }));
  fireEvent.click(view.getByRole('button', { name: 'Copy JSON' }));
  fireEvent.click(view.getByRole('button', { name: 'Reset' }));
  await act(async () => resolve());
  assert.equal(view.queryByText('Settings copied.'), null);
  assert.ok(view.getByRole('button', { name: 'Copy JSON' }));
});
