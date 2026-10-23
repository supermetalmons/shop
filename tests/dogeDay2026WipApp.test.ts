import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import type { DogeDay2026RevealOverlay } from '../src/dogeDay2026/DogeDay2026RevealOverlay.tsx';
import { setupFrontendDom } from './helpers/frontendDom.ts';

type OverlayProps = Parameters<typeof DogeDay2026RevealOverlay>[0];
const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
let latestProps: OverlayProps;
let openCount = 0;
let clearCount = 0;
let nextTimer = 0;
const timers = new Map<number, { callback: () => void; delay: number }>();
const frames = new Map<number, FrameRequestCallback>();

function FakeOverlay(props: OverlayProps) {
  latestProps = props;
  return createElement('div', {},
    createElement('div', { className: 'doge-day-2026-reveal-overlay__backdrop' }),
    createElement('button', { ref: props.boxButtonRef, 'aria-label': 'Open sample pack', onClick: () => { openCount += 1; } }),
  );
}

const bridge = '__dogeDay2026WipAppTest';
Object.defineProperty(globalThis, bridge, {
  configurable: true,
  value: {
    FakeOverlay,
    createCache: () => ({ fetched: new Set(), pending: new Map(), resident: new Map() }),
    clearCache: () => { clearCount += 1; },
    soundPlayer: { isInitialized: true, preloadSound: async () => undefined, playSound: async () => undefined },
  },
});
const imports = registerHooks({
  load(url, context, nextLoad) {
    let source: string | undefined;
    if (url.endsWith('/dogeDay2026/DogeDay2026RevealOverlay.tsx')) source = `export const DogeDay2026RevealOverlay = globalThis.${bridge}.FakeOverlay;`;
    else if (url.endsWith('/dogeDay2026/revealPlayer.ts')) source = `
      export const createDogeDay2026ImageCache = globalThis.${bridge}.createCache;
      export const clearDogeDay2026ImageCache = globalThis.${bridge}.clearCache;
      export const preloadDogeDay2026CardAssets = () => {};
      export const preloadDogeDay2026PackAssets = () => {};
    `;
    else if (url.endsWith('/lib/SoundPlayer.ts')) source = `export const soundPlayer = globalThis.${bridge}.soundPlayer;`;
    else if (url.endsWith('.css')) source = '';
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
  },
});
const { default: DogeDay2026WipApp } = await import('../src/dogeDay2026/DogeDay2026WipApp.tsx');
imports.deregister();

beforeEach((t: TestContext) => {
  openCount = 0;
  clearCount = 0;
  timers.clear();
  frames.clear();
  window.history.replaceState(null, '', '/doge_day_2026/wip');
  t.mock.method(window, 'setTimeout', (callback: () => void, delay: number) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(window, 'clearTimeout', (id: number) => { timers.delete(id); });
  t.mock.method(window, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextTimer;
    frames.set(id, callback);
    return id;
  });
  t.mock.method(window, 'cancelAnimationFrame', (id: number) => { frames.delete(id); });
});
afterEach(() => {
  cleanup();
  assert.equal(timers.size, 0);
  assert.equal(frames.size, 0);
});
after(() => {
  dom.window.close();
  delete (globalThis as Record<string, unknown>)[bridge];
});

function finishReadinessDelay() {
  const readyTimers = [...timers.entries()].filter(([, timer]) => timer.delay >= 1000 && timer.delay <= 1300);
  assert.equal(readyTimers.length, 1);
  act(() => {
    for (const [id, timer] of readyTimers) {
      timers.delete(id);
      timer.callback();
    }
  });
}

test('Doge WIP keeps the local readiness, reset, and keyboard opening controls', () => {
  const view = render(createElement(DogeDay2026WipApp));
  assert.ok(view.getByRole('dialog', { name: 'Doge Day 2026 pack preview' }));
  assert.equal(latestProps.cards.length, 1);
  assert.equal(latestProps.boxLabel, 'pack');
  assert.equal(latestProps.cardReady, false);
  const cache = latestProps.imageCache;
  finishReadinessDelay();
  assert.equal(latestProps.cardReady, true);
  fireEvent.keyDown(window, { key: ' ', code: 'Space' });
  assert.equal(openCount, 1);
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.equal(latestProps.resetKey, 1);
  assert.equal(latestProps.cardReady, false);
  assert.equal(latestProps.imageCache, cache);
  finishReadinessDelay();
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
  assert.equal(latestProps.resetKey, 2);
  assert.equal(latestProps.cardReady, false);
  view.unmount();
  assert.equal(clearCount, 1);
});

test('Doge backdrop focus, viewport changes, Escape, and Close preserve WIP behavior', () => {
  const view = render(createElement(DogeDay2026WipApp));
  const backdrop = view.container.querySelector('.doge-day-2026-reveal-overlay__backdrop')!;
  const pointer = new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 });
  Object.defineProperties(pointer, { isPrimary: { value: true }, pointerType: { value: 'mouse' } });
  fireEvent(backdrop, pointer);
  assert.ok(view.container.querySelector('.doge-day-2026-wip-controls--hidden'));
  fireEvent(backdrop, pointer);
  assert.equal(view.container.querySelector('.doge-day-2026-wip-controls--hidden'), null);
  const initialStyle = latestProps.overlayStyle;
  const oldWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: oldWidth + 100 });
  fireEvent(window, new dom.window.Event('resize'));
  act(() => {
    for (const [id, callback] of frames) {
      frames.delete(id);
      callback(0);
    }
  });
  assert.notDeepEqual(latestProps.overlayStyle, initialStyle);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: oldWidth });
  fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
  assert.equal(window.location.pathname, '/');
  window.history.replaceState(null, '', '/doge_day_2026/wip');
  fireEvent.click(view.getByRole('button', { name: 'Close wip overlay' }));
  assert.equal(window.location.pathname, '/');
});
