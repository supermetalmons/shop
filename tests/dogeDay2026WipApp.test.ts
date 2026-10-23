import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import type { createDogeFoilScene } from '../src/dogeDay2026/foilPackScene.ts';
import { getDogeDay2026StarterCard } from '../src/dogeDay2026/starterCards.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

type SceneOptions = Parameters<typeof createDogeFoilScene>[1];
type FakeScene = {
  options: SceneOptions;
  activations: number;
  readiness: boolean[];
  disposed: boolean;
};
const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
let scenes: FakeScene[] = [];
let sceneConstructionError: Error | null = null;
let nextTimer = 0;
const timers = new Map<number, { callback: () => void; delay: number }>();
const frames = new Map<number, FrameRequestCallback>();

const bridge = '__dogeDay2026WipAppTest';
Object.defineProperty(globalThis, bridge, {
  configurable: true,
  value: {
    createScene(host: HTMLDivElement, options: SceneOptions) {
      if (sceneConstructionError) {
        const error = sceneConstructionError;
        sceneConstructionError = null;
        throw error;
      }
      const canvas = document.createElement('canvas');
      host.append(canvas);
      const scene = { options, activations: 0, readiness: [], disposed: false } as FakeScene;
      scenes.push(scene);
      return {
        activate: () => { scene.activations += 1; },
        setCardReady: (ready: boolean) => { scene.readiness.push(ready); },
        dispose: () => { scene.disposed = true; canvas.remove(); },
      };
    },
    soundPlayer: { isInitialized: true, preloadSound: async () => undefined, playSound: async () => undefined },
  },
});
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './foilPackScene') return { url: new URL('./foilPackScene.ts', context.parentURL).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    let source: string | undefined;
    if (url.endsWith('/dogeDay2026/foilPackScene.ts')) source = `export const createDogeFoilScene = globalThis.${bridge}.createScene;`;
    else if (url.endsWith('/lib/SoundPlayer.ts')) source = `export const soundPlayer = globalThis.${bridge}.soundPlayer;`;
    else if (url.endsWith('.css')) source = '';
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
  },
});
const { default: DogeDay2026WipApp } = await import('../src/dogeDay2026/DogeDay2026WipApp.tsx');
const { DogeDay2026RevealOverlay } = await import('../src/dogeDay2026/DogeDay2026RevealOverlay.tsx');
imports.deregister();

beforeEach((t: TestContext) => {
  scenes = [];
  sceneConstructionError = null;
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
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(timers.size, 0);
  assert.equal(frames.size, 0);
  assert.ok(scenes.every((scene) => scene.disposed));
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

test('Doge WIP keeps random Poncho cards, local readiness, reset, and keyboard controls', () => {
  const view = render(createElement(DogeDay2026WipApp));
  assert.ok(view.getByRole('dialog', { name: 'Doge Day 2026 pack preview' }));
  assert.equal(scenes.length, 1);
  const first = scenes[0];
  assert.match(first.options.card.imageSrc, /poncho_drifella\/fronts\/(?:[1-9]\d?|1\d\d|20[0-7])\.webp$/);
  assert.equal(first.options.cardReady, false);
  finishReadinessDelay();
  assert.equal(scenes.length, 1);
  assert.deepEqual(first.readiness, [false, true]);
  fireEvent.keyDown(window, { key: ' ', code: 'Space' });
  assert.equal(first.activations, 1);
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.equal(scenes.length, 2);
  assert.equal(first.disposed, true);
  assert.notEqual(scenes[1].options.card.imageSrc, first.options.card.imageSrc);
  assert.equal(scenes[1].options.cardReady, false);
  assert.equal(view.container.querySelectorAll('canvas').length, 1);
  finishReadinessDelay();
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
  assert.equal(scenes.length, 3);
  assert.equal(scenes[1].disposed, true);
  assert.equal(scenes[2].options.cardReady, false);
});

test('Doge background taps, Escape, and Close preserve WIP controls', () => {
  const view = render(createElement(DogeDay2026WipApp));
  act(() => scenes[0].options.onBackgroundTap());
  const hiddenControls = view.container.querySelector('.doge-day-2026-wip-controls--hidden');
  assert.ok(hiddenControls);
  assert.equal(hiddenControls.getAttribute('aria-hidden'), 'true');
  assert.ok(hiddenControls.hasAttribute('inert'));
  act(() => scenes[0].options.onBackgroundTap());
  assert.equal(view.container.querySelector('.doge-day-2026-wip-controls--hidden'), null);
  fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
  assert.equal(window.location.pathname, '/');
  window.history.replaceState(null, '', '/doge_day_2026/wip');
  fireEvent.click(view.getByRole('button', { name: 'Close wip overlay' }));
  assert.equal(window.location.pathname, '/');
});

test('Doge scene statuses stay visually hidden and announce the interactive card', () => {
  const view = render(createElement(DogeDay2026WipApp));
  const scene = scenes[0];
  assert.equal(view.getByRole('status').textContent, 'Loading pack…');
  assert.equal(view.getByRole('status').parentElement?.className, 'doge-day-2026-reveal-overlay__sr-only');
  act(() => scene.options.onReady());
  assert.equal(view.getByRole('status').textContent, 'Tap the pack');
  fireEvent.click(view.getByRole('button', { name: 'Hit the pack' }));
  assert.equal(scene.activations, 1);
  act(() => scene.options.onStageChange('waiting', 3));
  assert.equal(view.getByRole('status').textContent, 'Getting your card ready…');
  act(() => scene.options.onStageChange('opening', 3));
  assert.equal(view.getByRole<HTMLButtonElement>('button', { name: 'Hit the pack' }).disabled, true);
  act(() => scene.options.onStageChange('revealed', 3));
  assert.match(view.getByRole('status').textContent ?? '', /Your card is ready and interactive/);
  assert.equal(view.getByRole('status').parentElement?.className, 'doge-day-2026-reveal-overlay__sr-only');
  fireEvent.click(view.getByRole('button', { name: 'Reset card tilt' }));
  assert.equal(scene.activations, 2);
  assert.equal(scenes.length, 1);
  act(() => scene.options.onError(new Error('Context lost')));
  assert.equal(view.getByRole('status').textContent, 'Unable to load this pack.');
  assert.equal(view.getByRole('status').parentElement?.className, 'doge-day-2026-reveal-overlay__error');
  assert.equal(view.getByRole<HTMLButtonElement>('button', { name: 'Reset card tilt' }).disabled, true);
});

test('Doge scene failures restore Close and Reset and keep them accessible after Retry fails', () => {
  const view = render(createElement(DogeDay2026WipApp));
  const first = scenes[0];
  const controls = view.container.querySelector('.doge-day-2026-wip-controls')!;
  act(() => first.options.onBackgroundTap());
  assert.ok(controls.hasAttribute('inert'));
  act(() => first.options.onError(new Error('Context lost')));
  assert.equal(controls.classList.contains('doge-day-2026-wip-controls--hidden'), false);
  assert.equal(controls.hasAttribute('aria-hidden'), false);
  assert.equal(controls.hasAttribute('inert'), false);
  assert.ok(view.getByRole('button', { name: 'Close wip overlay' }));
  assert.ok(view.getByRole('button', { name: 'Reset opening' }));
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  assert.equal(scenes[1].options.card, first.options.card);
  act(() => scenes[1].options.onError(new Error('Texture failed again')));
  assert.equal(view.getByRole('status').textContent, 'Unable to load this pack.');
  assert.equal(controls.classList.contains('doge-day-2026-wip-controls--hidden'), false);
  assert.equal(controls.hasAttribute('aria-hidden'), false);
  assert.equal(controls.hasAttribute('inert'), false);
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.equal(scenes.length, 3);
  assert.notEqual(scenes[2].options.card, first.options.card);
  fireEvent.click(view.getByRole('button', { name: 'Close wip overlay' }));
  assert.equal(window.location.pathname, '/');
});

test('Doge synchronous scene construction failures restore controls after a focused Reset', () => {
  const view = render(createElement(DogeDay2026WipApp));
  act(() => scenes[0].options.onBackgroundTap());
  assert.ok(view.container.querySelector('.doge-day-2026-wip-controls--hidden'));
  sceneConstructionError = new Error('WebGL unavailable');
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
  assert.equal(scenes[0].disposed, true);
  assert.equal(view.getByRole('status').textContent, 'Unable to load this pack.');
  const controls = view.container.querySelector('.doge-day-2026-wip-controls')!;
  assert.equal(controls.classList.contains('doge-day-2026-wip-controls--hidden'), false);
  assert.equal(controls.hasAttribute('aria-hidden'), false);
  assert.equal(controls.hasAttribute('inert'), false);
  assert.ok(view.getByRole('button', { name: 'Reset opening' }));
  fireEvent.click(view.getByRole('button', { name: 'Close wip overlay' }));
  assert.equal(window.location.pathname, '/');
});

test('Doge retries the same selected card and ignores callbacks from disposed scenes', () => {
  const view = render(createElement(DogeDay2026WipApp));
  finishReadinessDelay();
  const first = scenes[0];
  act(() => first.options.onError(new Error('Texture failed')));
  assert.equal(view.getByRole('status').textContent, 'Unable to load this pack.');
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  assert.equal(scenes.length, 2);
  assert.equal(first.disposed, true);
  assert.equal(scenes[1].options.card, first.options.card);
  assert.equal(scenes[1].options.cardReady, true);
  assert.equal(view.container.querySelectorAll('canvas').length, 1);
  act(() => scenes[1].options.onBackgroundTap());
  assert.ok(view.container.querySelector('.doge-day-2026-wip-controls--hidden'));
  act(() => first.options.onError(new Error('Late error')));
  assert.ok(view.container.querySelector('.doge-day-2026-wip-controls--hidden'));
  act(() => {
    first.options.onReady();
    first.options.onStageChange('revealed', 3);
    first.options.onBackgroundTap();
  });
  assert.equal(view.getByRole('status').textContent, 'Loading pack…');
  assert.ok(view.container.querySelector('.doge-day-2026-wip-controls--hidden'));
});

test('Doge callback updates do not recreate the renderer', () => {
  const cards = [getDogeDay2026StarterCard(1)!];
  let oldHits = 0;
  let newHits = 0;
  const view = render(createElement(DogeDay2026RevealOverlay, {
    cards, cardReady: false, boxLabel: 'pack', resetKey: 0, onPlayClick: () => { oldHits += 1; },
  }));
  view.rerender(createElement(DogeDay2026RevealOverlay, {
    cards: [...cards], cardReady: true, boxLabel: 'pack', resetKey: 0, onPlayClick: () => { newHits += 1; },
  }));
  assert.equal(scenes.length, 1);
  act(() => scenes[0].options.onHit());
  assert.equal(oldHits, 0);
  assert.equal(newHits, 1);
  assert.deepEqual(scenes[0].readiness, [false, true]);
});
