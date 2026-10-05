import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useReducer } from 'react';
import * as THREE from 'three';
import type { MiNotePackControls } from '../src/components/MiNotePackViewer.tsx';
import { createMiNoteRevealState, reduceMiNoteReveal, type MiNoteRevealEvent, type MiNoteRevealState } from '../src/lib/miNoteCardReveal.ts';
import { MI_NOTE_LEAF_WIDTH } from '../src/lib/miNotePackModel.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, render } = await import('@testing-library/react');
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let time = 1000;
let viewportWidth = 900;
const requestFrame = (callback: FrameRequestCallback) => {
  frames.set(++nextFrameId, callback);
  return nextFrameId;
};
const cancelFrame = (id: number) => { frames.delete(id); };
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'requestAnimationFrame', { configurable: true, value: requestFrame });
  Object.defineProperty(target, 'cancelAnimationFrame', { configurable: true, value: cancelFrame });
}
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => viewportWidth });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 });
const observers = new Set<object>();
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: class {
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  },
});

class FakeWebGLRenderer {
  domElement = document.createElement('canvas');
  scene: THREE.Scene | null = null;
  camera: THREE.PerspectiveCamera | null = null;
  disposed = false;
  setClearColor() {}
  setPixelRatio() {}
  setSize() {}
  compile() { assert.equal(this.disposed, false); }
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    assert.equal(this.disposed, false);
    this.scene = scene;
    this.camera = camera;
  }
  dispose() { this.disposed = true; }
  forceContextLoss() {}
  constructor() { renderers.push(this); }
}
const renderers: FakeWebGLRenderer[] = [];

type TestModel = {
  group: THREE.Group;
  flipRoot: THREE.Group;
  left: THREE.Group;
  right: THREE.Group;
  ready: Promise<void>;
  resolveReady: () => void;
  phase: number;
  sealStarts: number;
  sealUpdates: { elapsed: number; reduced: boolean; motion: number }[];
  disposed: boolean;
  setFolderPhase: (phase: number) => void;
  setSealFoldPosition: () => void;
  setSealRotationOffsetDegrees: () => void;
  startSealPeel: () => void;
  updateSeal: (elapsed: number, reduced: boolean, motion: number) => boolean;
  dispose: () => void;
};

function createTestModel(): TestModel {
  const group = new THREE.Group();
  const flipRoot = new THREE.Group();
  const left = new THREE.Group();
  const right = new THREE.Group();
  group.add(flipRoot);
  flipRoot.add(left, right);
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const model = {
    group, flipRoot, left, right, ready, resolveReady,
    phase: 0,
    sealStarts: 0,
    sealUpdates: [] as TestModel['sealUpdates'],
    disposed: false,
    setFolderPhase(phase: number) { model.phase = phase; },
    setSealFoldPosition() {},
    setSealRotationOffsetDegrees() {},
    startSealPeel() { model.sealStarts += 1; },
    updateSeal(elapsed: number, reduced: boolean, motion: number) {
      model.sealUpdates.push({ elapsed, reduced, motion });
      return reduced || elapsed >= 0.2;
    },
    dispose() { model.disposed = true; group.removeFromParent(); },
  };
  models.push(model);
  return model;
}
const models: TestModel[] = [];
const bridgeKey = '__miNotePackViewerTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { FakeWebGLRenderer, createTestModel } });
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/components/MiNotePackViewer.tsx')) {
      if (specifier === 'three') return { url: 'test:mi-note-viewer-three', shortCircuit: true };
      if (specifier.endsWith('/miNotePackModel')) return { url: 'test:mi-note-viewer-model', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:mi-note-viewer-three') {
      return {
        format: 'module', shortCircuit: true,
        source: `export * from ${JSON.stringify(import.meta.resolve('three'))}; export const WebGLRenderer = globalThis.${bridgeKey}.FakeWebGLRenderer;`,
      };
    }
    if (url === 'test:mi-note-viewer-model') {
      return {
        format: 'module', shortCircuit: true,
        source: `export * from ${JSON.stringify(new URL('../src/lib/miNotePackModel.ts', import.meta.url).href)}; export const createMiNotePackModel = globalThis.${bridgeKey}.createTestModel;`,
      };
    }
    return nextLoad(url, context);
  },
});
const { default: MiNotePackViewer } = await import('../src/components/MiNotePackViewer.tsx');
imports.deregister();

beforeEach(() => {
  models.length = 0;
  renderers.length = 0;
  time = 1000;
  viewportWidth = 900;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
});
afterEach(() => {
  cleanup();
  assert.equal(frames.size, 0);
  assert.equal(observers.size, 0);
  assert.ok(models.every(model => model.disposed));
  assert.ok(renderers.every(renderer => renderer.disposed));
});
after(() => { Reflect.deleteProperty(globalThis, bridgeKey); dom.window.close(); });

function advanceFrame(elapsed = 50) {
  assert.ok(frames.size, 'The viewer must schedule work until its transition completes');
  act(() => {
    time += elapsed;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(time));
  });
}

function settle() {
  for (let count = 0; frames.size && count < 160; count += 1) advanceFrame();
  assert.equal(frames.size, 0, 'The viewer should become idle after its animations finish');
}

function harness(initialState = createMiNoteRevealState(), interactionEnabled = true) {
  const controls = { current: null as MiNotePackControls | null };
  const events: MiNoteRevealEvent[] = [];
  const readyChanges: boolean[] = [];
  const errors: Error[] = [];
  const cardElements = [document.createElement('div'), document.createElement('div')] as const;
  const star = { id: 'test', name: 'Test star', src: '/star.png', foldPosition: 0.573, rotationOffsetDegrees: 0 };
  let state = initialState;
  function Harness() {
    const [current, dispatch] = useReducer(reduceMiNoteReveal, initialState);
    state = current;
    return createElement(MiNotePackViewer, {
      color: '#3559b7', star, foldPosition: 0.573, rotationOffsetDegrees: 0,
      cardElements, state: current, interactionEnabled, controlsRef: controls,
      onEvent(event) { events.push(event); dispatch(event); },
      onReadyChange(ready) { readyChanges.push(ready); dispatch({ type: 'ready', ready }); },
      onError(error) { errors.push(error); },
      onBackgroundTap() {},
    });
  }
  const view = render(createElement(Harness, { key: 0 }));
  return {
    view, controls, events, readyChanges, errors,
    get state() { return state; },
    count(type: MiNoteRevealEvent['type']) { return events.filter(event => event.type === type).length; },
    reset() { view.rerender(createElement(Harness, { key: 1 })); },
  };
}

async function makeReady(model = models.at(-1)!) {
  await act(async () => { model.resolveReady(); await model.ready; });
  settle();
}

function homeFor(model: ReturnType<typeof createTestModel>, index: 0 | 1) {
  const parent = index === 0 ? model.left : model.right;
  const anchor = parent.children[0];
  assert.ok(anchor);
  return {
    parent, anchor,
    position: anchor.position.clone(),
    quaternion: anchor.quaternion.clone(),
    scale: anchor.scale.clone(),
  };
}

function assertHome(home: ReturnType<typeof homeFor>) {
  assert.equal(home.anchor.parent, home.parent);
  assert.ok(home.anchor.position.equals(home.position));
  assert.ok(home.anchor.quaternion.equals(home.quaternion));
  assert.ok(home.anchor.scale.equals(home.scale));
  assert.equal(home.anchor.children.length, 2);
}

test('reduced motion unseals once and returns a selected card to its original pocket once', async () => {
  const run = harness();
  const model = models[0];
  const home = homeFor(model, 0);
  await makeReady();
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  settle();
  assert.equal(run.state.stage, 'interactive');
  assert.equal(model.phase, 0);
  assert.equal(model.sealStarts, 1);
  assert.ok(model.sealUpdates.length > 0);
  assert.ok(model.sealUpdates.every(update => update.reduced));
  assert.equal(run.count('seal-finished'), 1);

  act(() => run.controls.current!.activate());
  settle();
  assert.equal(model.phase, 1);
  act(() => run.controls.current!.navigate(1));
  settle();
  assert.equal(model.phase, 2);
  act(() => run.controls.current!.selectCard(0));
  assert.equal(run.state.cardStage, 'lifting');
  assertHome(home);
  advanceFrame();
  assert.equal(model.phase, 1);
  assert.equal(home.anchor.parent, renderers[0].scene);
  settle();
  assert.equal(run.state.cardStage, 'inspecting');
  assert.equal(run.count('card-lifted'), 1);
  const inspection = home.anchor.position.clone();
  act(() => run.controls.current!.returnCard());
  advanceFrame();
  assert.ok(home.anchor.position.equals(inspection), 'The card pauses while its tilt settles');
  settle();
  assert.equal(run.state.cardStage, 'pocket');
  assert.equal(run.state.selectedCard, null);
  assert.equal(run.count('card-returned'), 1);
  assertHome(home);

  act(() => run.controls.current!.activate());
  settle();
  act(() => run.controls.current!.activate());
  settle();
  assert.equal(model.sealStarts, 1);
  assert.equal(run.count('seal-finished'), 1);
  assert.equal(run.count('card-lifted'), 1);
  assert.equal(run.count('card-returned'), 1);
  assert.deepEqual(run.errors, []);
});

test('peeled stickers keep fluttering on the closed pack until the next activation opens it', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  const model = models[0];
  await makeReady();
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  for (let count = 0; run.state.stage !== 'interactive' && count < 40; count += 1) advanceFrame();
  assert.equal(run.state.stage, 'interactive');
  assert.equal(model.sealStarts, 1);
  const updatesAtPeel = model.sealUpdates.length;
  for (let count = 0; count < 100; count += 1) advanceFrame();
  assert.equal(run.state.folderPose, 0);
  assert.equal(model.phase, 0);
  assert.equal(model.sealUpdates.length, updatesAtPeel + 100);
  assert.ok(model.sealUpdates.at(-1)!.elapsed > 5);
  assert.ok(model.sealUpdates.some(update => Math.abs(update.motion) > 0.01));
  assert.equal(run.count('seal-finished'), 1);
  assert.equal(frames.size, 1);

  act(() => run.controls.current!.activate());
  for (let count = 0; count < 60; count += 1) advanceFrame();
  assert.equal(model.phase, 1);
  act(() => run.controls.current!.navigate(1));
  for (let count = 0; count < 60; count += 1) advanceFrame();
  assert.equal(model.phase, 2);
  const updatesBeforeFlip = model.sealUpdates.length;
  act(() => run.controls.current!.navigate(1));
  for (let count = 0; count < 60; count += 1) advanceFrame();
  assert.equal(model.phase, 0);
  assert.ok(model.sealUpdates.slice(updatesBeforeFlip).some(update => Math.abs(update.motion) > 0.01));
  assert.equal(run.count('seal-finished'), 1);
  assert.equal(model.sealStarts, 1);
});

test('late readiness keeps the peeled pack closed on its back until the next activation', async () => {
  const run = harness({ ...createMiNoteRevealState(), folderPose: 2 });
  const model = models[0];
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  settle();
  assert.equal(run.state.stage, 'unsealed');
  assert.equal(model.phase, 2);
  await makeReady();
  assert.equal(run.state.stage, 'interactive');
  assert.equal(run.state.folderPose, 2);
  assert.equal(model.phase, 2);
  act(() => run.controls.current!.activate());
  settle();
  assert.equal(model.phase, 1);
  assert.equal(model.sealStarts, 1);
  assert.equal(run.count('seal-finished'), 1);
});

test('sticker flutter pauses while hidden and settles when reduced motion is enabled', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  const model = models[0];
  await makeReady();
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  for (let count = 0; count < 60; count += 1) advanceFrame();
  const beforeHidden = model.sealUpdates.at(-1)!;
  const updatesBeforeHidden = model.sealUpdates.length;
  const staleFrames = [...frames.values()];
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    time += 10_000;
    staleFrames.forEach(callback => callback(time));
  });
  assert.equal(frames.size, 0);
  assert.equal(model.sealUpdates.length, updatesBeforeHidden);
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  advanceFrame();
  assert.ok(model.sealUpdates.at(-1)!.elapsed - beforeHidden.elapsed < 0.05);

  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', true));
  settle();
  assert.equal(model.sealUpdates.at(-1)!.reduced, true);
  assert.equal(run.count('seal-finished'), 1);
  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', false));
  advanceFrame();
  assert.equal(model.sealUpdates.at(-1)!.reduced, false);
  assert.equal(frames.size, 1);
  assert.equal(run.count('seal-finished'), 1);
});

test('sticker motion remains finite when animation frames share a timestamp', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  advanceFrame();
  advanceFrame(0);
  assert.ok(models[0].sealUpdates.every(update => Number.isFinite(update.motion)));
});

test('narrow viewports leave room for the attached sticker beyond the open pack edge', async () => {
  viewportWidth = 319;
  const run = harness();
  await makeReady();
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  settle();
  act(() => run.controls.current!.activate());
  settle();
  assert.equal(models[0].phase, 1);
  const camera = renderers[0].camera!;
  const halfViewWidth = camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
  assert.ok(halfViewWidth > MI_NOTE_LEAF_WIDTH + 0.32);
});

test('normal motion finishes unfolding before extraction and cleanup cancels a later transition', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const initial: MiNoteRevealState = { ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 2 };
  const run = harness(initial);
  const model = models[0];
  const home = homeFor(model, 1);
  await makeReady();
  act(() => run.controls.current!.selectCard(1));
  advanceFrame();
  assert.ok(model.phase > 1.015);
  assert.equal(run.state.cardStage, 'lifting');
  assertHome(home);
  for (let count = 0; home.anchor.parent === home.parent && count < 80; count += 1) advanceFrame();
  assert.equal(model.phase, 1);
  assert.equal(home.anchor.parent, renderers[0].scene);
  settle();
  assert.equal(run.count('card-lifted'), 1);
  assert.equal(run.state.cardStage, 'inspecting');
  act(() => run.controls.current!.returnCard());
  settle();
  assert.equal(run.count('card-returned'), 1);
  assertHome(home);

  act(() => run.controls.current!.selectCard(1));
  advanceFrame();
  const staleFrames = [...frames.values()];
  assert.ok(staleFrames.length);
  run.view.unmount();
  const callbacksBefore = [run.events.length, run.readyChanges.length, run.errors.length];
  act(() => staleFrames.forEach(callback => callback(time + 1000)));
  assert.deepEqual([run.events.length, run.readyChanges.length, run.errors.length], callbacksBefore);
  assert.equal(run.controls.current, null);
  assert.equal(home.anchor.parent, null);
  assert.equal(model.disposed, true);
  assert.equal(run.count('card-lifted'), 1);
  assert.equal(run.count('card-returned'), 1);
});

test('reset ignores readiness and animation callbacks belonging to the previous viewer', async () => {
  const run = harness();
  const previousModel = models[0];
  const staleFrames = [...frames.values()];
  run.reset();
  const currentModel = models[1];
  assert.notEqual(currentModel, previousModel);
  assert.equal(previousModel.disposed, true);
  const callbacksBefore = [run.events.length, run.readyChanges.length, run.errors.length];
  await act(async () => {
    previousModel.resolveReady();
    await previousModel.ready;
    staleFrames.forEach(callback => callback(time + 1000));
  });
  assert.deepEqual([run.events.length, run.readyChanges.length, run.errors.length], callbacksBefore);
  assert.equal(run.state.ready, false);
  assert.equal(run.state.taps, 0);
  await makeReady(currentModel);
  assert.equal(run.state.ready, true);
  assert.equal(run.readyChanges.filter(Boolean).length, 1);
  assert.deepEqual(run.errors, []);
});

test('mixed folder controls before a frame keep the rendered pose consistent with the latest state', async () => {
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4 });
  await makeReady();

  act(() => run.controls.current!.navigate(1));
  assert.equal(run.state.folderPose, 1);
  act(() => run.controls.current!.activate());
  assert.equal(run.state.folderPose, 0);
  settle();
  assert.equal(models[0].phase, 0);

  act(() => run.controls.current!.activate());
  assert.equal(run.state.folderPose, 1);
  act(() => run.controls.current!.navigate(1));
  assert.equal(run.state.folderPose, 2);
  settle();
  assert.equal(models[0].phase, 2);
});

test('Escape exits after rendering fails without starting an impossible card return', async () => {
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  act(() => run.controls.current!.selectCard(0));
  settle();
  assert.equal(run.state.cardStage, 'inspecting');

  act(() => renderers[0].domElement.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true })));
  assert.equal(run.errors.length, 1);
  act(() => { assert.equal(run.controls.current!.escape(), false); });
  settle();
  assert.equal(run.count('return-card'), 0);
  assert.equal(run.state.cardStage, 'inspecting');
});

test('Escape exits when an asset failure disables interaction while opening is queued', () => {
  const run = harness({ ...createMiNoteRevealState(), stage: 'unsealed', taps: 4 }, false);
  settle();
  assert.equal(run.state.stage, 'unsealed');
  act(() => { assert.equal(run.controls.current!.escape(), false); });
  assert.deepEqual(run.events, []);
});
