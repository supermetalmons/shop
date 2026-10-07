import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useReducer } from 'react';
import * as THREE from 'three';
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import type { MiNotePackControls } from '../src/components/MiNotePackViewer.tsx';
import { createMiNoteRevealState, reduceMiNoteReveal, type MiNoteRevealEvent, type MiNoteRevealState } from '../src/lib/miNoteCardReveal.ts';
import { MI_NOTE_CARD_HEIGHT, MI_NOTE_CARD_WIDTH, MI_NOTE_LEAF_WIDTH } from '../src/lib/miNotePackModel.ts';
import { MI_NOTE_PACK_STARS, type MiNotePackStar } from '../src/lib/miNotePackStars.ts';
import { MI_NOTE_STAR_VERTICAL_DEFAULT } from '../src/lib/miNoteStarFolds.ts';
import { DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, type MiNoteStickerEffectSettings } from '../src/lib/miNoteStickerEffects.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, render } = await import('@testing-library/react');
const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;
let time = 1000;
let viewportWidth = 900;
let viewportHeight = 700;
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
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => viewportHeight });
class FakeResizeObserver {
  constructor(readonly callback: () => void) {}
  observe() { observers.add(this); }
  disconnect() { observers.delete(this); }
}
const observers = new Set<FakeResizeObserver>();
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: FakeResizeObserver,
});

class FakeWebGLRenderer {
  domElement = document.createElement('canvas');
  scene: THREE.Scene | null = null;
  camera: THREE.PerspectiveCamera | null = null;
  disposed = false;
  pixelRatio = 1;
  sizeChanges: { width: number; height: number; pixelRatio: number }[] = [];
  setClearColor() {}
  setDrawingBufferSize(width: number, height: number, pixelRatio: number) {
    this.pixelRatio = pixelRatio;
    this.sizeChanges.push({ width, height, pixelRatio });
  }
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
  sealEffectSettings: MiNoteStickerEffectSettings[];
  sealVerticalPosition: number;
  sealSizeScale: number;
  disposed: boolean;
  setFolderPhase: (phase: number) => void;
  setSealFoldPosition: () => void;
  setSealRotationOffsetDegrees: () => void;
  setSealVerticalPosition: (value: number) => void;
  setSealSizeScale: (value: number) => void;
  setSealEffectSettings: (settings: MiNoteStickerEffectSettings) => void;
  getSealFocus: (target: THREE.Vector3) => THREE.Vector3;
  startSealPeel: () => void;
  updateSeal: (elapsed: number, reduced: boolean, motion: number) => boolean;
  dispose: () => void;
};

function createTestModel({ star, verticalPosition = MI_NOTE_STAR_VERTICAL_DEFAULT, sizeScale = star.sizeScale }: { star: MiNotePackStar; verticalPosition?: number; sizeScale?: number }): TestModel {
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
    sealEffectSettings: [] as MiNoteStickerEffectSettings[],
    sealVerticalPosition: verticalPosition,
    sealSizeScale: sizeScale,
    disposed: false,
    setFolderPhase(phase: number) { model.phase = phase; },
    setSealFoldPosition() {},
    setSealRotationOffsetDegrees() {},
    setSealVerticalPosition(value: number) { model.sealVerticalPosition = value; },
    setSealSizeScale(value: number) { model.sealSizeScale = value; },
    setSealEffectSettings(settings: MiNoteStickerEffectSettings) { model.sealEffectSettings.push({ ...settings }); },
    getSealFocus(target: THREE.Vector3) { return target.set(0.6, 0.05 + (0.5 - model.sealVerticalPosition) * 1.82, 0.03); },
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
  viewportHeight = 700;
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
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

function resizeViewport(width: number, height: number) {
  act(() => {
    viewportWidth = width;
    viewportHeight = height;
    observers.forEach(observer => observer.callback());
  });
  settle();
}

function harness(
  initialState = createMiNoteRevealState(),
  interactionEnabled = true,
  initialLayout: { star?: MiNotePackStar; verticalPosition?: number; sizeScale?: number } = { verticalPosition: 0.5, sizeScale: 1 },
) {
  const controls = { current: null as MiNotePackControls | null };
  const events: MiNoteRevealEvent[] = [];
  const readyChanges: boolean[] = [];
  const errors: Error[] = [];
  const cardElements = [document.createElement('div'), document.createElement('div')] as const;
  const star = initialLayout.star ?? { id: 'test', name: 'Test star', src: '/star.png', foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 };
  let state = initialState;
  let generation = 0;
  let effectSettings = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS };
  let inspectSticker = false;
  let verticalPosition = initialLayout.verticalPosition;
  let sizeScale = initialLayout.sizeScale;
  function Harness({ effectSettings, inspectSticker }: { effectSettings: MiNoteStickerEffectSettings; inspectSticker: boolean }) {
    const [current, dispatch] = useReducer(reduceMiNoteReveal, initialState);
    state = current;
    return createElement(MiNotePackViewer, {
      color: '#3559b7', star, foldPosition: 0.573, rotationOffsetDegrees: 0, verticalPosition, sizeScale, effectSettings, inspectSticker,
      cardElements, state: current, interactionEnabled, controlsRef: controls,
      onEvent(event) { events.push(event); dispatch(event); },
      onReadyChange(ready) { readyChanges.push(ready); dispatch({ type: 'ready', ready }); },
      onError(error) { errors.push(error); },
      onBackgroundTap() {},
    });
  }
  const view = render(createElement(Harness, { key: generation, effectSettings, inspectSticker }));
  return {
    view, controls, events, readyChanges, errors,
    get state() { return state; },
    count(type: MiNoteRevealEvent['type']) { return events.filter(event => event.type === type).length; },
    setEffectSettings(settings: MiNoteStickerEffectSettings) {
      effectSettings = settings;
      view.rerender(createElement(Harness, { key: generation, effectSettings, inspectSticker }));
    },
    setInspectSticker(value: boolean) {
      inspectSticker = value;
      view.rerender(createElement(Harness, { key: generation, effectSettings, inspectSticker }));
    },
    setVerticalPosition(value: number) {
      verticalPosition = value;
      view.rerender(createElement(Harness, { key: generation, effectSettings, inspectSticker }));
    },
    setSizeScale(value: number) {
      sizeScale = value;
      view.rerender(createElement(Harness, { key: generation, effectSettings, inspectSticker }));
    },
    reset() { view.rerender(createElement(Harness, { key: ++generation, effectSettings, inspectSticker })); },
  };
}

async function makeReady(model = models.at(-1)!) {
  await act(async () => { model.resolveReady(); await model.ready; });
  settle();
}

function pointerControls(run: ReturnType<typeof harness>) {
  const host = run.view.getByRole('group', { name: 'Interactive Mi Note Cards folder' });
  const captured = new Set<number>();
  Object.assign(host, {
    setPointerCapture(id: number) { captured.add(id); },
    hasPointerCapture(id: number) { return captured.has(id); },
    releasePointerCapture(id: number) { captured.delete(id); },
  });
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(1.29, 1.82), new THREE.MeshBasicMaterial());
  surface.position.z = 0.03;
  models.at(-1)!.group.add(surface);
  const dispatch = (type: string, x = viewportWidth / 2, y = viewportHeight / 2, pointerType = 'mouse') => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: pointerType },
      isPrimary: { value: true },
    });
    act(() => host.dispatchEvent(event));
  };
  return {
    dispatch,
    tap(pointerType = 'mouse', x = viewportWidth / 2, y = viewportHeight / 2) {
      dispatch('pointerdown', x, y, pointerType);
      dispatch('pointerup', x, y, pointerType);
    },
  };
}

function tapSparkles() {
  const points = renderers.at(-1)!.scene!.getObjectByName('mi-note-tap-sparkles');
  assert.ok(points instanceof THREE.Points);
  return points;
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

function cardLayout(home: ReturnType<typeof homeFor>) {
  const cssObject = home.anchor.children.find(child => child instanceof CSS3DObject);
  const aperture = home.anchor.children.find(child => child instanceof THREE.Mesh);
  assert.ok(cssObject instanceof CSS3DObject);
  assert.ok(aperture instanceof THREE.Mesh);
  return {
    cssObject,
    aperture,
    width: cssObject.element.style.width,
    height: cssObject.element.style.height,
  };
}

function assertCardAlignment(card: ReturnType<typeof cardLayout>, camera: THREE.PerspectiveCamera) {
  assert.equal(card.cssObject.element.style.width, card.width);
  assert.equal(card.cssObject.element.style.height, card.height);
  assert.ok(Number.parseFloat(card.width) > 0);
  for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
      const domCorner = new THREE.Vector3(x * Number.parseFloat(card.width), y * Number.parseFloat(card.height), 0)
        .applyMatrix4(card.cssObject.matrixWorld).project(camera);
      const apertureCorner = new THREE.Vector3(x * MI_NOTE_CARD_WIDTH, y * MI_NOTE_CARD_HEIGHT, 0)
        .applyMatrix4(card.aperture.matrixWorld).project(camera);
      assert.ok(domCorner.distanceTo(apertureCorner) < 1e-8, 'DOM card and WebGL aperture must project to the same corners');
    }
  }
}

function assertRendererViewport(run: ReturnType<typeof harness>, renderer: FakeWebGLRenderer) {
  assert.deepEqual(renderer.sizeChanges.at(-1), {
    width: viewportWidth,
    height: viewportHeight,
    pixelRatio: Math.min(window.devicePixelRatio, 2),
  });
  assert.equal(renderer.camera!.aspect, viewportWidth / viewportHeight);
  const projection = renderer.camera!.projectionMatrix.elements;
  assert.ok(Math.abs(projection[0] - projection[5] / renderer.camera!.aspect) < 1e-8);
  const layers = run.view.container.querySelectorAll<HTMLElement>('.mi-note-wip__css-scene');
  assert.equal(layers.length, 2);
  layers.forEach(layer => {
    assert.equal(layer.style.width, `${viewportWidth}px`);
    assert.equal(layer.style.height, `${viewportHeight}px`);
  });
}

test('viewport changes preserve card layout and projection in the folder and after inspection', async () => {
  const run = harness();
  await makeReady();
  const model = models[0];
  const renderer = renderers[0];
  const homes = [homeFor(model, 0), homeFor(model, 1)];
  const cards = homes.map(cardLayout);
  const sizes = [[574, 831], [319, 700], [1440, 420], [900, 700]] as const;
  const assertLayout = () => {
    assertRendererViewport(run, renderer);
    cards.forEach(card => assertCardAlignment(card, renderer.camera!));
    assert.deepEqual(models, [model]);
    assert.deepEqual(renderers, [renderer]);
  };

  for (const [width, height] of sizes) {
    resizeViewport(width, height);
    assertLayout();
    homes.forEach(assertHome);
  }
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  settle();
  act(() => run.controls.current!.activate());
  settle();
  assert.equal(model.phase, 1);
  for (const [width, height] of sizes) {
    resizeViewport(width, height);
    assertLayout();
    homes.forEach(assertHome);
  }

  for (const index of [0, 1] as const) {
    act(() => run.controls.current!.selectCard(index));
    settle();
    assert.equal(run.state.cardStage, 'inspecting');
    assert.notEqual(cards[index].cssObject.parent, homes[index].anchor);
    for (const [width, height] of sizes) {
      resizeViewport(width, height);
      assertLayout();
    }
    act(() => run.controls.current!.returnCard());
    settle();
    assert.equal(run.state.cardStage, 'pocket');
    homes.forEach(assertHome);
    assertLayout();
  }
  assert.deepEqual(run.errors, []);
});

test('unchanged resize notifications preserve an idle viewer without redundant renderer updates', async () => {
  const run = harness();
  await makeReady();
  const renderer = renderers[0];
  const state = run.state;
  const originalSizes = [...renderer.sizeChanges];

  act(() => observers.forEach(observer => observer.callback()));
  assert.equal(frames.size, 0);
  assert.deepEqual(renderer.sizeChanges, originalSizes);

  resizeViewport(574, 831);
  assert.equal(renderer.sizeChanges.length, originalSizes.length + 1);
  assertRendererViewport(run, renderer);

  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  resizeViewport(574, 831);
  assert.equal(renderer.pixelRatio, 2);
  assert.equal(renderer.sizeChanges.length, originalSizes.length + 2);
  assertRendererViewport(run, renderer);
  const resizedSizes = [...renderer.sizeChanges];
  act(() => observers.forEach(observer => observer.callback()));
  assert.equal(frames.size, 0);
  assert.deepEqual(renderer.sizeChanges, resizedSizes);
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
  act(() => observers.forEach(observer => observer.callback()));
  assert.equal(frames.size, 0);
  assert.deepEqual(renderer.sizeChanges, resizedSizes);
  assert.equal(run.state, state);
  assert.equal(models.length, 1);
  assert.equal(renderers.length, 1);
});

test('sealed pack sparkles appear only for accepted pointer taps and return to idle after fading', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const pointer = pointerControls(run);
  const sparkles = tapSparkles();
  assert.equal(sparkles.visible, false);
  assert.equal(sparkles.geometry.drawRange.count, 0);

  act(() => run.controls.current!.activate());
  settle();
  assert.equal(run.state.taps, 1);
  assert.equal(sparkles.visible, false);
  pointer.tap('mouse', 0, 0);
  pointer.dispatch('pointerdown');
  pointer.dispatch('pointermove', viewportWidth / 2, viewportHeight / 2 + 30);
  pointer.dispatch('pointerup', viewportWidth / 2, viewportHeight / 2 + 30);
  pointer.dispatch('pointerdown');
  pointer.dispatch('pointercancel');
  settle();
  assert.equal(run.state.taps, 1);
  assert.equal(sparkles.geometry.drawRange.count, 0);

  pointer.tap();
  advanceFrame();
  assert.equal(run.state.taps, 2);
  assert.equal(sparkles.visible, true);
  assert.ok(sparkles.geometry.drawRange.count > 0);
  settle();
  assert.equal(sparkles.visible, false);
  assert.equal(sparkles.geometry.drawRange.count, 0);

  pointer.tap('touch');
  advanceFrame();
  assert.equal(run.state.taps, 3);
  assert.equal(sparkles.visible, true);
  assert.equal(tapSparkles(), sparkles);
  settle();
  assert.equal(sparkles.visible, false);
});

test('the final sealed tap sparkles stop when peeling finishes and later folder taps stay clear', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness({ ...createMiNoteRevealState(), taps: 3 });
  await makeReady();
  const pointer = pointerControls(run);
  const sparkles = tapSparkles();
  pointer.tap();
  advanceFrame();
  assert.equal(run.state.stage, 'seal-peeling');
  assert.equal(sparkles.visible, true);

  for (let count = 0; run.state.stage !== 'interactive' && count < 40; count += 1) advanceFrame();
  assert.equal(run.state.stage, 'interactive');
  assert.equal(sparkles.visible, false);
  assert.equal(sparkles.geometry.drawRange.count, 0);

  pointer.tap();
  advanceFrame();
  assert.equal(run.state.folderPose, 1);
  assert.equal(sparkles.visible, false);
  assert.equal(sparkles.geometry.drawRange.count, 0);
});

test('sparkles honor reduced motion, clear while hidden, and dispose their resources on unmount', async () => {
  const run = harness();
  await makeReady();
  const pointer = pointerControls(run);
  const sparkles = tapSparkles();
  pointer.tap();
  settle();
  assert.equal(run.state.taps, 1);
  assert.equal(sparkles.visible, false);

  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', false));
  pointer.tap();
  advanceFrame();
  assert.equal(sparkles.visible, true);
  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', true));
  settle();
  assert.equal(sparkles.visible, false);
  assert.equal(sparkles.geometry.drawRange.count, 0);

  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', false));
  pointer.tap('touch');
  advanceFrame();
  assert.equal(sparkles.visible, true);
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  assert.equal(frames.size, 0);
  assert.equal(sparkles.visible, false);
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  settle();
  assert.equal(sparkles.geometry.drawRange.count, 0);

  let geometryDisposals = 0;
  let materialDisposals = 0;
  sparkles.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });
  const materials = Array.isArray(sparkles.material) ? sparkles.material : [sparkles.material];
  materials.forEach(material => material.addEventListener('dispose', () => { materialDisposals += 1; }));
  run.view.unmount();
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, materials.length);
  assert.equal(frames.size, 0);
});

test('live finish tuning renders a sealed pack once and returns to sleep without rebuilding it', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const model = models[0];
  const renderer = renderers[0];
  const state = run.state;
  const readyChanges = [...run.readyChanges];
  const updatesBefore = model.sealEffectSettings.length;
  const settings: MiNoteStickerEffectSettings = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, width: 0.045, outerness: 0.6, strength: 0.85 };

  run.setEffectSettings(settings);

  assert.equal(models.length, 1);
  assert.equal(renderers.length, 1);
  assert.equal(models[0], model);
  assert.equal(renderers[0], renderer);
  assert.equal(model.disposed, false);
  assert.equal(renderer.disposed, false);
  assert.equal(run.state, state);
  assert.deepEqual(run.readyChanges, readyChanges);
  assert.equal(model.sealEffectSettings.length, updatesBefore + 1);
  assert.deepEqual(model.sealEffectSettings.at(-1), settings);
  assert.equal(frames.size, 1);
  advanceFrame();
  assert.equal(frames.size, 0);
  assert.equal(model.sealStarts, 0);
  assert.equal(model.sealUpdates.length, 0);
});

test('omitted layout props retain the raised position and Blush size through rendering', async () => {
  const run = harness(undefined, true, { star: MI_NOTE_PACK_STARS[0] });
  const model = models[0];
  assert.equal(model.sealVerticalPosition, 0.485);
  assert.equal(model.sealSizeScale, 1.13);
  await makeReady();
  assert.equal(model.sealVerticalPosition, 0.485);
  assert.equal(model.sealSizeScale, 1.13);
  run.setInspectSticker(true);
  settle();
  assert.equal(model.sealVerticalPosition, 0.485);
  assert.equal(model.sealSizeScale, 1.13);
  assert.equal(models.length, 1);
});

test('live star layout changes wake an idle viewer once and preserve its resources and state', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const model = models[0];
  const renderer = renderers[0];
  const state = run.state;
  const readyChanges = [...run.readyChanges];
  assert.equal(model.sealVerticalPosition, 0.5);
  assert.equal(model.sealSizeScale, 1);

  run.setVerticalPosition(0.3);
  assert.equal(frames.size, 1);
  advanceFrame();
  assert.equal(frames.size, 0);
  assert.equal(model.sealVerticalPosition, 0.3);
  assert.equal(model.sealSizeScale, 1);

  run.setSizeScale(1.4);
  assert.equal(frames.size, 1);
  advanceFrame();
  assert.equal(frames.size, 0);
  assert.equal(model.sealVerticalPosition, 0.3);
  assert.equal(model.sealSizeScale, 1.4);
  assert.deepEqual(models, [model]);
  assert.deepEqual(renderers, [renderer]);
  assert.equal(run.state, state);
  assert.deepEqual(run.readyChanges, readyChanges);
  assert.equal(model.sealStarts, 0);
  assert.equal(model.sealUpdates.length, 0);

  run.reset();
  assert.equal(models[1].sealVerticalPosition, 0.3);
  assert.equal(models[1].sealSizeScale, 1.4);
  await makeReady();
});

test('live finish tuning preserves the peeled state and ongoing flutter in the same viewer', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const model = models[0];
  const renderer = renderers[0];
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  for (let count = 0; run.state.stage !== 'interactive' && count < 40; count += 1) advanceFrame();
  assert.equal(run.state.stage, 'interactive');
  const state = run.state;
  const before = model.sealUpdates.at(-1)!;
  const readyChanges = [...run.readyChanges];
  const settings: MiNoteStickerEffectSettings = { ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, width: 0.025, outerness: 0.35, hue: 0.4, shine: 0.5 };

  run.setEffectSettings(settings);
  advanceFrame();

  assert.equal(models.length, 1);
  assert.equal(renderers.length, 1);
  assert.equal(models[0], model);
  assert.equal(renderers[0], renderer);
  assert.equal(run.state, state);
  assert.deepEqual(run.readyChanges, readyChanges);
  assert.deepEqual(model.sealEffectSettings.at(-1), settings);
  assert.equal(model.sealStarts, 1);
  assert.equal(run.count('seal-finished'), 1);
  assert.ok(model.sealUpdates.at(-1)!.elapsed > before.elapsed);
  assert.equal(model.sealUpdates.at(-1)!.reduced, false);
  assert.equal(frames.size, 1);
});

test('sticker close-up smoothly focuses the existing camera and restores the normal framing', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const model = models[0];
  const renderer = renderers[0];
  const camera = renderer.camera!;
  const originalPosition = camera.position.clone();
  const state = run.state;
  const closeZ = 0.03 + 0.9 / (2 * Math.tan(THREE.MathUtils.degToRad(17)));

  run.setInspectSticker(true);
  advanceFrame();

  assert.ok(camera.position.x > 0 && camera.position.x < 0.6);
  assert.ok(camera.position.z < originalPosition.z && camera.position.z > closeZ);
  settle();
  assert.equal(camera.position.x, 0.6);
  assert.equal(camera.position.y, 0.05);
  assert.ok(Math.abs(camera.position.z - closeZ) < 1e-8);
  assert.equal(models.length, 1);
  assert.equal(renderers.length, 1);
  assert.equal(models[0], model);
  assert.equal(renderers[0], renderer);
  assert.equal(run.state, state);
  assert.equal(model.sealStarts, 0);

  run.setInspectSticker(false);
  settle();

  assert.ok(camera.position.equals(originalPosition));
  assert.equal(run.state, state);
  assert.equal(models.length, 1);
  assert.equal(renderers.length, 1);
});

test('narrow sticker close-up yields to card inspection and resumes after the card returns', async () => {
  viewportWidth = 319;
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const camera = renderers[0].camera!;
  const closeZ = 0.03 + (0.72 / (319 / 700)) / (2 * Math.tan(THREE.MathUtils.degToRad(17)));
  run.setInspectSticker(true);
  settle();
  assert.equal(camera.position.x, 0.6);
  assert.equal(camera.position.y, 0.05);
  assert.ok(Math.abs(camera.position.z - closeZ) < 1e-8);

  act(() => run.controls.current!.selectCard(0));
  settle();
  assert.equal(run.state.cardStage, 'inspecting');
  assert.equal(camera.position.x, 0);
  assert.equal(camera.position.y, 0);
  assert.ok(camera.position.z > closeZ);
  assert.equal(models.length, 1);
  assert.equal(renderers.length, 1);

  act(() => run.controls.current!.returnCard());
  settle();
  assert.equal(run.state.selectedCard, null);
  assert.equal(camera.position.x, 0.6);
  assert.equal(camera.position.y, 0.05);
  assert.ok(Math.abs(camera.position.z - closeZ) < 1e-8);
  assert.equal(models.length, 1);
  assert.equal(renderers.length, 1);
});

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
