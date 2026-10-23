import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import type { createDogeFoilScene } from '../src/dogeDay2026/foilPackScene.ts';
import { getDogeDay2026StarterCard } from '../src/dogeDay2026/starterCards.ts';
import { DOGE_DAY_2026_WIP_SOUNDS } from '../src/dogeDay2026/starterConfig.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

type SceneOptions = Parameters<typeof createDogeFoilScene>[1];
type FakeScene = {
  options: SceneOptions;
  activations: number;
  readiness: boolean[];
  inspectionTimes: (number | null)[];
  inspectionDensities: (number | null)[];
  disposed: boolean;
};
const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
let scenes: FakeScene[] = [];
let sceneConstructionError: Error | null = null;
let development = false;
const playedSounds: string[] = [];
let nextTimer = 0;
const timers = new Map<number, { callback: () => void; delay: number }>();
const frames = new Map<number, FrameRequestCallback>();

const bridge = '__dogeDay2026WipAppTest';
Object.defineProperty(globalThis, bridge, {
  configurable: true,
  value: {
    isDevelopment: () => development,
    createScene(host: HTMLDivElement, options: SceneOptions) {
      if (sceneConstructionError) {
        const error = sceneConstructionError;
        sceneConstructionError = null;
        throw error;
      }
      const canvas = document.createElement('canvas');
      host.append(canvas);
      const scene = { options, activations: 0, readiness: [], inspectionTimes: [], inspectionDensities: [], disposed: false } as FakeScene;
      scenes.push(scene);
      return {
        activate: () => { scene.activations += 1; },
        setCardReady: (ready: boolean) => { scene.readiness.push(ready); },
        setInspectionTime: (time: number | null) => { scene.inspectionTimes.push(time); },
        setInspectionDensity: (density: number | null) => { scene.inspectionDensities.push(density); },
        captureOpeningFrames: () => [`data:image/png;base64,${options.cards.length}-cards`],
        dispose: () => { scene.disposed = true; canvas.remove(); },
      };
    },
    soundPlayer: {
      isInitialized: true,
      preloadSound: async () => undefined,
      playSound: async (url: string) => { playedSounds.push(url); },
    },
  },
});
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './foilPackScene') return { url: new URL('./foilPackScene.ts', context.parentURL).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/dogeDay2026/DogeDay2026WipApp.tsx')) {
      const loaded = nextLoad(url, context);
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source as Uint8Array).toString();
      return { ...loaded, source: source.replace('import.meta.env?.DEV', `globalThis.${bridge}.isDevelopment()`) };
    }
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
  development = false;
  playedSounds.length = 0;
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

test('Doge WIP defaults to two distinct Poncho cards and keeps local readiness, reset, and keyboard controls', () => {
  const view = render(createElement(DogeDay2026WipApp));
  assert.ok(view.getByRole('dialog', { name: 'Doge Day 2026 pack preview' }));
  assert.equal(scenes.length, 1);
  const first = scenes[0];
  assert.equal(first.options.cards.length, 2);
  assert.equal(new Set(first.options.cards.map((card) => card.imageSrc)).size, 2);
  assert.equal(view.getByRole('button', { name: '2 card pack' }).getAttribute('aria-pressed'), 'true');
  for (const packSize of [1, 3]) {
    assert.equal(view.getByRole('button', { name: `${packSize} card pack` }).getAttribute('aria-pressed'), 'false');
  }
  for (const card of first.options.cards) {
    assert.match(card.imageSrc, /poncho_drifella\/fronts\/(?:[1-9]\d?|1\d\d|20[0-7])\.webp$/);
  }
  assert.equal(first.options.cardReady, false);
  finishReadinessDelay();
  assert.equal(scenes.length, 1);
  assert.deepEqual(first.readiness, [false, true]);
  fireEvent.click(view.getByRole('button', { name: '2 card pack' }));
  assert.equal(scenes.length, 1);
  assert.equal(timers.size, 0);
  fireEvent.keyDown(window, { key: ' ', code: 'Space' });
  assert.equal(first.activations, 1);
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.equal(scenes.length, 2);
  assert.equal(first.disposed, true);
  assert.equal(scenes[1].options.cards.length, 2);
  assert.notEqual(scenes[1].options.cards[0].imageSrc, first.options.cards[0].imageSrc);
  assert.equal(scenes[1].options.cardReady, false);
  assert.equal(view.container.querySelectorAll('canvas').length, 1);
  finishReadinessDelay();
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
  assert.equal(scenes.length, 3);
  assert.equal(scenes[1].disposed, true);
  assert.equal(scenes[2].options.cards.length, 2);
  assert.equal(scenes[2].options.cardReady, false);
});

for (const packSize of [1, 2, 3] as const) {
  test(`Doge ${packSize}-card picker resets into distinct cards and retains its count on Reset`, (t) => {
    t.mock.method(Math, 'random', () => 0);
    const view = render(createElement(DogeDay2026WipApp));
    assert.ok(view.getByRole('group', { name: 'Cards per pack' }));
    const selected = view.getByRole('button', { name: `${packSize} card pack` });
    if (packSize !== 1) fireEvent.click(view.getByRole('button', { name: '1 card pack' }));
    const initial = scenes.at(-1)!;
    const initialSceneCount = scenes.length;
    finishReadinessDelay();
    fireEvent.click(selected);
    const current = scenes.at(-1)!;
    const sceneCount = initialSceneCount + 1;
    assert.equal(scenes.length, sceneCount);
    assert.equal(initial.disposed, true);
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    assert.equal(current.options.cards.length, packSize);
    assert.equal(new Set(current.options.cards.map((card) => card.imageSrc)).size, packSize);
    assert.notEqual(current.options.cards[0], initial.options.cards[0]);
    assert.equal(current.options.cardReady, false);
    finishReadinessDelay();
    fireEvent.click(selected);
    assert.equal(scenes.length, sceneCount);
    assert.equal(timers.size, 0);
    fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
    const next = scenes.at(-1)!;
    assert.equal(scenes.length, sceneCount + 1);
    assert.equal(current.disposed, true);
    assert.equal(next.options.cards.length, packSize);
    assert.equal(new Set(next.options.cards.map((card) => card.imageSrc)).size, packSize);
    assert.notEqual(next.options.cards[0], current.options.cards[0]);
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    assert.equal(next.options.cardReady, false);
    assert.equal(view.container.querySelectorAll('canvas').length, 1);
  });
}

for (const packSize of [1, 2] as const) {
  for (const stage of ['sealed', 'opening', 'revealed'] as const) {
    test(`Doge switching from 3 to ${packSize} cards during ${stage} replaces the scene and ignores old callbacks`, () => {
      const view = render(createElement(DogeDay2026WipApp));
      fireEvent.click(view.getByRole('button', { name: '3 card pack' }));
      const first = scenes[1];
      act(() => {
        first.options.onReady();
        first.options.onStageChange(stage, stage === 'sealed' ? 0 : 3);
      });
      fireEvent.click(view.getByRole('button', { name: `${packSize} card pack` }));
      const next = scenes[2];
      assert.equal(first.disposed, true);
      assert.equal(next.options.cards.length, packSize);
      assert.equal(next.options.cardReady, false);
      assert.notEqual(next.options.cards[0], first.options.cards[0]);
      act(() => {
        first.options.onReady();
        first.options.onStageChange('revealed', 3);
        first.options.onError(new Error('Late failure'));
        first.options.onBackgroundTap();
      });
      assert.equal(view.getByRole('status').textContent, 'Loading pack…');
      assert.equal(view.container.querySelector('.doge-day-2026-wip-controls--hidden'), null);
      assert.equal(view.container.querySelectorAll('canvas').length, 1);
      finishReadinessDelay();
      assert.deepEqual(next.readiness, [true]);
    });
  }
}

test('Doge card cycling uses the card pack swipe and spread sounds', async () => {
  const view = render(createElement(DogeDay2026WipApp));
  fireEvent.click(view.getByRole('button', { name: '3 card pack' }));
  await act(async () => {
    scenes[1].options.onCardSwipe?.();
    scenes[1].options.onCardSpread?.();
  });
  assert.deepEqual(playedSounds, [DOGE_DAY_2026_WIP_SOUNDS.cardSwipe, DOGE_DAY_2026_WIP_SOUNDS.cardSpread]);
});

for (const packSize of [2, 3] as const) {
  test(`Doge ${packSize}-card controls preserve focus and lock activation during opening and card transitions`, () => {
    const view = render(createElement(DogeDay2026WipApp));
    fireEvent.click(view.getByRole('button', { name: `${packSize} card pack` }));
    const scene = scenes.at(-1)!;
    const action = view.getByRole<HTMLButtonElement>('button', { name: 'Hit the pack' });
    action.focus();
    act(() => scene.options.onStageChange('opening', 3));
    assert.equal(action.disabled, false);
    assert.equal(action.getAttribute('aria-disabled'), 'true');
    assert.equal(document.activeElement, action);
    fireEvent.click(action, { detail: 0 });
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    assert.equal(scene.activations, 0);
    act(() => scene.options.onStageChange('revealed', 3));
    for (let activeCardIndex = 0; activeCardIndex < packSize - 1; activeCardIndex += 1) {
      assert.match(view.getByRole('status').textContent ?? '', new RegExp(`Card ${activeCardIndex + 1} of ${packSize}`));
      assert.equal(action.getAttribute('aria-label'), 'Next card');
      assert.equal(action.getAttribute('aria-disabled'), null);
      assert.equal(document.activeElement, action);
      fireEvent.click(action, { detail: 0 });
      assert.equal(scene.activations, activeCardIndex + 1);
      act(() => scene.options.onCardStateChange?.({ mode: 'cycling', activeCardIndex, transitioning: true }));
      assert.equal(action.disabled, false);
      assert.equal(action.getAttribute('aria-disabled'), 'true');
      assert.equal(document.activeElement, action);
      assert.equal(view.getByRole('status').textContent, 'Showing the next card…');
      fireEvent.click(action, { detail: 0 });
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
      assert.equal(scene.activations, activeCardIndex + 1);
      act(() => scene.options.onCardStateChange?.({ mode: 'stack', activeCardIndex: activeCardIndex + 1, transitioning: false }));
      assert.equal(document.activeElement, action);
    }
    assert.match(view.getByRole('status').textContent ?? '', new RegExp(`Card ${packSize} of ${packSize}`));
    assert.equal(action.getAttribute('aria-label'), 'Show all cards');
    assert.equal(action.getAttribute('aria-disabled'), null);
    fireEvent.click(action, { detail: 0 });
    assert.equal(scene.activations, packSize);
    act(() => scene.options.onCardStateChange?.({ mode: 'spreading', activeCardIndex: packSize - 1, transitioning: true }));
    assert.equal(action.disabled, false);
    assert.equal(action.getAttribute('aria-disabled'), 'true');
    assert.equal(document.activeElement, action);
    assert.equal(view.getByRole('status').textContent, 'Showing all cards…');
    fireEvent.click(action, { detail: 0 });
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    assert.equal(scene.activations, packSize);
    act(() => scene.options.onCardStateChange?.({ mode: 'row', activeCardIndex: packSize - 1, transitioning: false }));
    assert.equal(view.getByRole('status').textContent, `All ${packSize} cards are ready and interactive. Drag any card to tilt.`);
    assert.equal(action.getAttribute('aria-label'), 'Reset card tilt');
    assert.equal(action.getAttribute('aria-disabled'), null);
    assert.equal(document.activeElement, action);
    fireEvent.click(action, { detail: 0 });
    assert.equal(scene.activations, packSize + 1);
  });
}

test('Doge background taps, Escape, and Close preserve WIP controls', () => {
  const view = render(createElement(DogeDay2026WipApp));
  act(() => scenes[0].options.onBackgroundTap());
  const hiddenControls = view.container.querySelector('.doge-day-2026-wip-controls--hidden');
  assert.ok(hiddenControls);
  assert.equal(hiddenControls.getAttribute('aria-hidden'), 'true');
  assert.ok(hiddenControls.hasAttribute('inert'));
  assert.ok(hiddenControls.contains(view.container.querySelector('.doge-day-2026-wip-pack-picker')));
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
  fireEvent.click(view.getByRole('button', { name: '1 card pack' }));
  const scene = scenes.at(-1)!;
  assert.equal(view.getByRole('status').textContent, 'Loading pack…');
  assert.equal(view.getByRole('status').parentElement?.className, 'doge-day-2026-reveal-overlay__sr-only');
  act(() => scene.options.onReady());
  assert.equal(view.getByRole('status').textContent, 'Tap the pack');
  fireEvent.click(view.getByRole('button', { name: 'Hit the pack' }));
  assert.equal(scene.activations, 1);
  act(() => scene.options.onStageChange('waiting', 3));
  assert.equal(view.getByRole('status').textContent, 'Getting your card ready…');
  act(() => scene.options.onStageChange('opening', 3));
  assert.equal(view.getByRole<HTMLButtonElement>('button', { name: 'Hit the pack' }).disabled, false);
  assert.equal(view.getByRole('button', { name: 'Hit the pack' }).getAttribute('aria-disabled'), 'true');
  act(() => scene.options.onStageChange('revealed', 3));
  assert.match(view.getByRole('status').textContent ?? '', /Your card is ready and interactive/);
  assert.equal(view.getByRole('status').parentElement?.className, 'doge-day-2026-reveal-overlay__sr-only');
  fireEvent.click(view.getByRole('button', { name: 'Reset card tilt' }));
  assert.equal(scene.activations, 2);
  assert.equal(scenes.length, 2);
  act(() => scene.options.onError(new Error('Context lost')));
  assert.equal(view.getByRole('status').textContent, 'Unable to load this pack.');
  assert.equal(view.getByRole('status').parentElement?.className, 'doge-day-2026-reveal-overlay__sr-only');
  assert.equal(view.queryByRole('button', { name: 'Retry' }), null);
  assert.equal(view.getByRole<HTMLButtonElement>('button', { name: 'Reset card tilt' }).disabled, true);
  fireEvent.click(view.getByRole('button', { name: 'Reset card tilt' }), { detail: 0 });
  fireEvent.keyDown(window, { key: ' ', code: 'Space' });
  assert.equal(scene.activations, 2);
});

test('Doge scene failures restore Close and Reset and keep them accessible after Reset fails', () => {
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
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.notEqual(scenes[1].options.cards[0], first.options.cards[0]);
  act(() => scenes[1].options.onError(new Error('Texture failed again')));
  assert.equal(view.getByRole('status').textContent, 'Unable to load this pack.');
  assert.equal(controls.classList.contains('doge-day-2026-wip-controls--hidden'), false);
  assert.equal(controls.hasAttribute('aria-hidden'), false);
  assert.equal(controls.hasAttribute('inert'), false);
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.equal(scenes.length, 3);
  assert.notEqual(scenes[2].options.cards[0], scenes[1].options.cards[0]);
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

test('Doge resets a failed scene and ignores callbacks from disposed scenes', () => {
  const view = render(createElement(DogeDay2026WipApp));
  finishReadinessDelay();
  const first = scenes[0];
  act(() => first.options.onError(new Error('Texture failed')));
  assert.equal(view.getByRole('status').textContent, 'Unable to load this pack.');
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.equal(scenes.length, 2);
  assert.equal(first.disposed, true);
  assert.notEqual(scenes[1].options.cards[0], first.options.cards[0]);
  assert.equal(scenes[1].options.cardReady, false);
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

test('Doge recreates a three-card scene when a later card changes', () => {
  const cards = [1, 2, 3].map((id) => getDogeDay2026StarterCard(id)!);
  const view = render(createElement(DogeDay2026RevealOverlay, {
    cards, cardReady: true, boxLabel: 'pack', resetKey: 0,
  }));
  view.rerender(createElement(DogeDay2026RevealOverlay, {
    cards: [cards[0], cards[1], getDogeDay2026StarterCard(4)!], cardReady: true, boxLabel: 'pack', resetKey: 0,
  }));
  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].disposed, true);
  assert.equal(scenes[1].options.cards[2], getDogeDay2026StarterCard(4));
});

test('Doge inspection time updates reuse the scene and lock reveal interactions', () => {
  const cards = [getDogeDay2026StarterCard(1)!];
  const props = { cards, cardReady: true, boxLabel: 'pack', resetKey: 0 };
  const view = render(createElement(DogeDay2026RevealOverlay, { ...props, inspectionTimeMs: 500 }));
  assert.equal(scenes[0].options.inspectionTimeMs, 500);
  assert.deepEqual(scenes[0].inspectionTimes, [500]);
  view.rerender(createElement(DogeDay2026RevealOverlay, { ...props, inspectionTimeMs: 1000 }));
  assert.equal(scenes.length, 1);
  assert.deepEqual(scenes[0].inspectionTimes, [500, 1000]);
  fireEvent.click(view.getByRole('button', { name: 'Hit the pack' }));
  assert.equal(scenes[0].activations, 0);
  view.rerender(createElement(DogeDay2026RevealOverlay, props));
  assert.deepEqual(scenes[0].inspectionTimes, [500, 1000, null]);
  fireEvent.click(view.getByRole('button', { name: 'Hit the pack' }));
  assert.equal(scenes[0].activations, 1);
});

test('Doge inspection capture readiness waits for GPU warmup and resets on scene replacement or failure', () => {
  const readiness: boolean[] = [];
  const props = {
    cards: [getDogeDay2026StarterCard(1)!], cardReady: true, boxLabel: 'pack', resetKey: 0,
    inspectionTimeMs: 500, inspectionDensity: 3, onInspectionReady: (ready: boolean) => readiness.push(ready),
  };
  const view = render(createElement(DogeDay2026RevealOverlay, props));
  assert.equal(scenes[0].options.inspectionDensity, 3);
  assert.deepEqual(scenes[0].inspectionDensities, [3]);
  assert.deepEqual(readiness, [false]);
  act(() => scenes[0].options.onReady());
  assert.deepEqual(readiness, [false]);
  act(() => scenes[0].options.onGpuReady?.());
  assert.deepEqual(readiness, [false, true]);
  view.rerender(createElement(DogeDay2026RevealOverlay, { ...props, inspectionDensity: 2 }));
  assert.deepEqual(scenes[0].inspectionDensities, [3, 2]);
  view.rerender(createElement(DogeDay2026RevealOverlay, { ...props, resetKey: 1 }));
  assert.deepEqual(readiness, [false, true, false]);
  act(() => scenes[0].options.onGpuReady?.());
  assert.deepEqual(readiness, [false, true, false]);
  act(() => scenes[1].options.onGpuReady?.());
  act(() => scenes[1].options.onError(new Error('Lost context')));
  assert.deepEqual(readiness, [false, true, false, true, false]);
});

test('Doge ignores the inspection query outside a development build', () => {
  window.history.replaceState(null, '', '/doge_day_2026/wip?inspectOpening=1');
  const view = render(createElement(DogeDay2026WipApp));
  assert.equal(view.queryByRole('group', { name: 'Opening frame inspection' }), null);
  assert.equal(scenes[0].options.inspectionTimeMs, undefined);
  assert.equal(scenes[0].options.cardReady, false);
});

test('Doge frame viewer isolates focus, blocks preview shortcuts, and restores its trigger after Escape or Close', () => {
  development = true;
  window.history.replaceState(null, '', '/doge_day_2026/wip?inspectOpening=1');
  const view = render(createElement(DogeDay2026WipApp));
  assert.equal(view.getByRole<HTMLButtonElement>('button', { name: 'Loading frames…' }).disabled, true);
  act(() => scenes[0].options.onGpuReady?.());
  const trigger = view.getByRole<HTMLButtonElement>('button', { name: 'Frames' });
  const picker = view.getByRole('button', { name: '3 card pack' });
  const density = view.getByRole('combobox', { name: 'Inspection pixel density' });
  const reveal = view.getByRole('button', { name: 'Hit the pack' });
  trigger.focus();
  fireEvent.click(trigger);
  assert.ok(view.getByRole('dialog', { name: 'Opening frames at 60 Hz' }));
  const close = view.getByRole('button', { name: 'Close frames' });
  assert.equal(document.activeElement, close);
  for (const control of [picker, density, reveal]) assert.ok(control.closest('[inert][aria-hidden="true"]'));
  fireEvent.keyDown(close, { key: 'Tab' });
  assert.equal(document.activeElement, close);
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, close);
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
  fireEvent.keyDown(window, { key: ' ', code: 'Space' });
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].activations, 0);
  fireEvent.keyDown(close, { key: 'Escape' });
  assert.equal(view.queryByRole('dialog', { name: 'Opening frames at 60 Hz' }), null);
  assert.equal(window.location.pathname, '/doge_day_2026/wip');
  assert.equal(document.activeElement, trigger);
  assert.equal(picker.closest('[inert]'), null);
  fireEvent.click(trigger);
  fireEvent.click(view.getByRole('button', { name: 'Close frames' }));
  assert.equal(document.activeElement, trigger);
  fireEvent.click(trigger);
  act(() => scenes[0].options.onError(new Error('Lost context')));
  fireEvent.click(view.getByRole('button', { name: 'Close frames' }));
  assert.equal(document.activeElement, view.getByRole('dialog', { name: 'Doge Day 2026 pack preview' }));
});

test('Doge clears captured sheets when their card count, density, or round changes', () => {
  development = true;
  window.history.replaceState(null, '', '/doge_day_2026/wip?inspectOpening=1');
  const view = render(createElement(DogeDay2026WipApp));
  const capture = () => {
    act(() => scenes.at(-1)!.options.onGpuReady?.());
    fireEvent.click(view.getByRole('button', { name: 'Frames' }));
    assert.ok(view.getByRole('dialog', { name: 'Opening frames at 60 Hz' }));
  };
  const picker = view.getByRole('button', { name: '3 card pack' });
  const density = view.getByRole('combobox', { name: 'Inspection pixel density' });
  const reset = view.getByRole('button', { name: 'Reset opening' });
  capture();
  fireEvent.click(picker);
  assert.equal(view.queryByRole('img'), null);
  assert.equal(scenes.at(-1)!.options.cards.length, 3);
  capture();
  fireEvent.change(density, { target: { value: '3' } });
  assert.equal(view.queryByRole('img'), null);
  assert.equal(scenes.at(-1)!.inspectionDensities.at(-1), 3);
  capture();
  fireEvent.click(reset);
  assert.equal(view.queryByRole('img'), null);
  assert.equal(scenes.length, 3);
});
