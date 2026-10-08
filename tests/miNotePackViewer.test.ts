import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useReducer } from 'react';
import * as THREE from 'three';
import { DRIF_EFFECTS, CARD_NFT_2_NEUTRAL_CARD_EFFECT, type DrifCardConfig } from '../src/drifCards.ts';
import type { MiNotePackControls } from '../src/components/MiNotePackViewer.tsx';
import { createMiNoteCardMaterial } from '../src/lib/miNoteCardMaterial.ts';
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
const surfaces: ReturnType<typeof createTestSurface>[] = [];
let deferSurfaceReady = false;
function createTestSurface(card: DrifCardConfig) {
  const actual = createMiNoteCardMaterial(card, { loadTexture: async () => new THREE.Texture() });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  if (!deferSurfaceReady) resolveReady();
  const surface = {
    card,
    material: actual.material,
    ready, resolveReady, rejectReady,
    effectReadiness: new Map<string, Promise<void>>(),
    effects: [] as DrifCardConfig['effect'][],
    updates: 0,
    disposed: false,
    disposeCalls: 0,
    setEffect(effect: DrifCardConfig['effect']) {
      surface.effects.push(effect);
      return (surface.effectReadiness.get(effect.effectKey) ?? ready).then(() => actual.setEffect(effect));
    },
    update(mesh: THREE.Object3D, camera: THREE.Camera) { surface.updates += 1; actual.update(mesh, camera); },
    dispose() { surface.disposed = true; surface.disposeCalls += 1; actual.dispose(); },
  };
  surfaces.push(surface);
  return surface;
}
const bridgeKey = '__miNotePackViewerTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { FakeWebGLRenderer, createTestModel, createTestSurface } });
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/components/MiNotePackViewer.tsx')) {
      if (specifier === 'three') return { url: 'test:mi-note-viewer-three', shortCircuit: true };
      if (specifier.endsWith('/miNoteCardMaterial')) return { url: 'test:mi-note-card-material', shortCircuit: true };
      if (specifier.endsWith('/miNotePackModel')) return { url: 'test:mi-note-viewer-model', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:mi-note-card-material') return { format: 'module', shortCircuit: true, source: `export const createMiNoteCardMaterial = globalThis.${bridgeKey}.createTestSurface;` };
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
  deferSurfaceReady = false;
  surfaces.length = 0;
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
  assert.ok(surfaces.every(surface => surface.disposed));
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

function advanceFrames(count = 80) {
  for (let index = 0; frames.size && index < count; index += 1) advanceFrame();
}

function settle() {
  advanceFrames(160);
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
  const cardReadyChanges: boolean[] = [];
  const cardErrors: (Error | null)[] = [];
  const errors: Error[] = [];
  let cards: readonly [DrifCardConfig, DrifCardConfig] = [
    { imageSrc: '/card-a.png', textureSrc: '/mask-a.png', foilSrc: '/foil-a.png', effect: DRIF_EFFECTS['swshp-SWSH179'] },
    { imageSrc: '/card-b.png', textureSrc: '/mask-b.png', foilSrc: '/foil-b.png', effect: DRIF_EFFECTS['swshp-SWSH179'] },
  ] as const;
  let cardEffect: DrifCardConfig['effect'] = DRIF_EFFECTS['swshp-SWSH179'];
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
      cards, cardEffect, onCardsReadyChange(ready) { cardReadyChanges.push(ready); }, state: current, interactionEnabled, controlsRef: controls,
      onEvent(event) { events.push(event); dispatch(event); },
      onReadyChange(ready) { readyChanges.push(ready); dispatch({ type: 'ready', ready }); },
      onError(error) { errors.push(error); },
      onCardsError(error) { cardErrors.push(error); },
      onBackgroundTap() {},
    });
  }
  const view = render(createElement(Harness, { key: generation, effectSettings, inspectSticker }));
  return {
    view, controls, events, readyChanges, cardReadyChanges, cardErrors, errors,
    get state() { return state; },
    get cards() { return cards; },
    count(type: MiNoteRevealEvent['type']) { return events.filter(event => event.type === type).length; },
    setCards(next: typeof cards) {
      cards = next;
      view.rerender(createElement(Harness, { key: generation, effectSettings, inspectSticker }));
    },
    setCardEffect(effect: DrifCardConfig['effect']) {
      cardEffect = effect;
      view.rerender(createElement(Harness, { key: generation, effectSettings, inspectSticker }));
    },
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
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) settle();
  else advanceFrames();
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
  const dispatch = (type: string, x = viewportWidth / 2, y = viewportHeight / 2, pointerType = 'mouse', overrides: Partial<PointerEvent> = {}) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: overrides.button ?? 0, clientX: x, clientY: y });
    Object.defineProperties(event, {
      pointerId: { value: overrides.pointerId ?? 1 },
      pointerType: { value: pointerType },
      isPrimary: { value: overrides.isPrimary ?? true },
    });
    act(() => host.dispatchEvent(event));
  };
  return {
    dispatch, host, captured,
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
  assert.equal(home.anchor.children.length, 1);
}

function packPose(model: TestModel) {
  return [model.group.rotation.x, model.group.rotation.y, model.group.rotation.z, model.group.position.y] as const;
}

function assertSquareOpen(model: TestModel) {
  assert.equal(model.phase, 1);
  assert.ok(packPose(model).every(value => value === 0));
  assert.ok(model.group.scale.equals(new THREE.Vector3(1, 1, 1)));
}

function assertGentleFloat(model: TestModel) {
  const [pitch, yaw, roll, height] = packPose(model);
  assert.ok(Math.abs(pitch) <= 0.055);
  assert.ok(Math.abs(yaw) <= 0.12);
  assert.ok(Math.abs(roll) <= 0.016);
  assert.ok(Math.abs(height) <= 0.037);
  assert.equal(model.group.position.x, 0);
  assert.equal(model.group.position.z, 0);
  assert.equal(frames.size, 1);
}

function assertCalmOpen(model: TestModel) {
  const [pitch, yaw, roll, height] = packPose(model);
  assert.equal(model.phase, 1);
  assert.ok(pitch >= -0.016 && pitch <= -0.008);
  assert.equal(yaw, 0);
  assert.equal(roll, 0);
  assert.ok(Math.abs(height) <= 0.0185);
  assert.equal(model.group.position.x, 0);
  assert.equal(model.group.position.z, 0);
  assert.ok(model.group.scale.equals(new THREE.Vector3(1, 1, 1)));
  assert.equal(frames.size, 1);
}

function advanceSmoothly(model: TestModel, count = 80) {
  for (let frame = 0; frame < count; frame += 1) {
    const before = packPose(model);
    advanceFrame(16.67);
    packPose(model).forEach((value, axis) => {
      assert.ok(Math.abs(value - before[axis]) < [0.014, 0.026, 0.004, 0.007][axis]);
    });
  }
}

function cardLayout(home: ReturnType<typeof homeFor>) {
  const mesh = home.anchor.children.find(child => child instanceof THREE.Mesh);
  assert.ok(mesh instanceof THREE.Mesh);
  return { mesh, geometry: mesh.geometry, material: mesh.material };
}

function assertCardAlignment(card: ReturnType<typeof cardLayout>, _camera: THREE.PerspectiveCamera) {
  assert.equal(card.mesh.geometry, card.geometry);
  assert.equal(card.mesh.material, card.material);
  const positions = card.geometry.attributes.position;
  const uvs = card.geometry.attributes.uv;
  for (let index = 0; index < positions.count; index += 1) {
    assert.ok(Math.abs(uvs.getX(index) - (positions.getX(index) / MI_NOTE_CARD_WIDTH + 0.5)) < 1e-6);
    assert.ok(Math.abs(uvs.getY(index) - (positions.getY(index) / MI_NOTE_CARD_HEIGHT + 0.5)) < 1e-6);
  }
  assert.equal(card.mesh.visible, true);
  assert.equal(card.material.depthTest, true);
  assert.equal(card.material.depthWrite, true);
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
  assert.equal(run.view.container.querySelectorAll('canvas').length, 1);
  assert.equal(run.view.container.querySelectorAll('.mi-note-wip__css-scene').length, 0);
}

function assertInspectionFits(anchor: THREE.Object3D, camera: THREE.PerspectiveCamera) {
  const lower = new THREE.Vector3(-MI_NOTE_CARD_WIDTH / 2, -MI_NOTE_CARD_HEIGHT / 2, 0)
    .applyMatrix4(anchor.matrixWorld).project(camera);
  const upper = new THREE.Vector3(MI_NOTE_CARD_WIDTH / 2, MI_NOTE_CARD_HEIGHT / 2, 0)
    .applyMatrix4(anchor.matrixWorld).project(camera);
  const width = (upper.x - lower.x) / 2;
  const height = (upper.y - lower.y) / 2;
  assert.ok(width <= 0.72 + 1e-8 && height <= 0.66 + 1e-8);
  assert.ok(Math.abs(width - 0.72) < 1e-8 || Math.abs(height - 0.66) < 1e-8);
  assert.ok(Math.abs(upper.x + lower.x) < 1e-8 && Math.abs(upper.y + lower.y) < 1e-8);
}

test('a sealed pack gently floats on both covers while outer flips still finish', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const model = models[0];
  assertGentleFloat(model);
  const front = packPose(model);
  advanceFrames(20);
  assertGentleFloat(model);
  assert.ok(packPose(model).every((value, index) => value !== front[index]));

  act(() => run.controls.current!.navigate(1));
  advanceFrames();
  assert.equal(run.state.folderPose, 2);
  assert.equal(model.phase, 2);
  assert.equal(model.flipRoot.rotation.y, 0);
  assertGentleFloat(model);
  const back = packPose(model);
  advanceFrames(20);
  assertGentleFloat(model);
  assert.ok(packPose(model).every((value, index) => value !== back[index]));
  assert.equal(run.state.taps, 0);
});

test('idle rotation drifts to both sides of neutral instead of leaning toward the initial render pose', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const model = models[0];
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let frame = 0; frame < 360; frame += 1) {
    advanceFrame();
    assertGentleFloat(model);
    packPose(model).slice(0, 3).forEach((value, index) => {
      minimum[index] = Math.min(minimum[index], value);
      maximum[index] = Math.max(maximum[index], value);
    });
  }
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(minimum[axis] < -0.01);
    assert.ok(maximum[axis] > 0.01);
  }
  assert.equal(run.state.taps, 0);
});

test('hover begins at the static render angle without quickly steering toward neutral', () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  harness();
  const model = models[0];
  advanceFrame(16.67);
  const start = packPose(model);
  for (const [axis, angle] of [0.055, -0.12, -0.016].entries()) {
    assert.ok(Math.abs(start[axis] - angle) < 0.00001);
  }
  advanceFrames(4);
  packPose(model).slice(0, 3).forEach((angle, axis) => {
    assert.ok(Math.abs(angle - start[axis]) < 0.0005);
  });
});

test('closing before opening finishes continues gently from the visible pose', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const model = models[0];
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  advanceFrames();
  act(() => run.controls.current!.activate());
  advanceFrames(10);
  assert.ok(model.phase > 0.99 && model.phase < 1);
  const before = packPose(model);
  act(() => run.controls.current!.activate());
  assert.deepEqual(packPose(model), before);
  advanceSmoothly(model, 12);
  assert.ok(model.phase < 0.2);
  advanceFrames();
  assert.equal(model.phase, 0);
  assertGentleFloat(model);
});

test('opening keeps a calmer float while stickers flutter and either cover restores the full motion', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const model = models[0];
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  advanceFrames();
  assert.equal(run.state.stage, 'interactive');
  act(() => run.controls.current!.activate());
  advanceFrame();
  assert.ok(model.phase > 0 && model.phase < 1);
  advanceSmoothly(model);
  assertCalmOpen(model);
  const updates = model.sealUpdates.length;
  const openMatrix = model.group.matrixWorld.clone();
  advanceFrames(40);
  assertCalmOpen(model);
  assert.ok(!model.group.matrixWorld.equals(openMatrix));
  assert.equal(model.sealUpdates.length, updates + 40);

  for (const direction of [1, -1] as const) {
    const before = packPose(model);
    act(() => run.controls.current!.navigate(direction));
    assert.deepEqual(packPose(model), before);
    advanceSmoothly(model);
    assert.equal(model.phase, direction === 1 ? 2 : 0);
    assertGentleFloat(model);
    act(() => run.controls.current!.activate());
    advanceSmoothly(model);
    assertCalmOpen(model);
  }
});

test('open idle bobs slowly with a small forward lean and no sideways tilt', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const model = models[0];
  let previousHeight = model.group.position.y;
  let minimumHeight = Infinity;
  let maximumHeight = -Infinity;
  let minimumPitch = Infinity;
  let maximumPitch = -Infinity;
  const rises: number[] = [];
  for (let frame = 0; frame < 900; frame += 1) {
    advanceFrame();
    assertCalmOpen(model);
    const { y: height } = model.group.position;
    const { x: pitch } = model.group.rotation;
    minimumHeight = Math.min(minimumHeight, height);
    maximumHeight = Math.max(maximumHeight, height);
    minimumPitch = Math.min(minimumPitch, pitch);
    maximumPitch = Math.max(maximumPitch, pitch);
    if (previousHeight < 0 && height >= 0) rises.push(time);
    previousHeight = height;
  }
  assert.ok(minimumHeight < -0.018 && maximumHeight > 0.018);
  assert.ok(minimumPitch < -0.0158 && maximumPitch > -0.0082);
  assert.ok(rises.length >= 3);
  rises.slice(1).forEach((rise, index) => assert.ok(rise - rises[index] >= 12_800 && rise - rises[index] <= 13_000));
});

test('rapid open and close reversals finish in the latest calmly floating open pose', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4 });
  await makeReady();
  const model = models[0];
  act(() => run.controls.current!.activate());
  advanceFrames(2);
  assert.ok(model.phase > 0 && model.phase < 1);
  act(() => run.controls.current!.navigate(-1));
  advanceFrame();
  act(() => run.controls.current!.activate());
  advanceSmoothly(model);
  assertCalmOpen(model);

  act(() => run.controls.current!.navigate(1));
  advanceFrames(2);
  assert.ok(model.phase > 1 && model.phase < 2);
  act(() => run.controls.current!.activate());
  advanceSmoothly(model);
  assertCalmOpen(model);
  assert.equal(run.state.folderPose, 1);
});

for (const folderPose of [0, 1] as const) {
  test(`pointer manipulation pauses ${folderPose === 1 ? 'open' : 'closed'} idle and resumes the same motion phase`, async () => {
    setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
    const run = harness(folderPose === 1 ? { ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose } : undefined);
    await makeReady();
    const before = packPose(models[0]);
    advanceFrame(16.67);
    advanceFrames(9);
    const expected = packPose(models[0]);

    run.reset();
    await makeReady();
    const model = models[1];
    assert.deepEqual(packPose(model), before);
    const pointer = pointerControls(run);
    pointer.dispatch('pointerdown');
    advanceFrame();
    assert.deepEqual(packPose(model), before);
    assert.equal(frames.size, 0);
    time += 10_000;
    pointer.dispatch('pointercancel');
    advanceFrames(10);
    packPose(model).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12));
    if (folderPose === 1) assertCalmOpen(model);
    else assertGentleFloat(model);
  });

  test(`hidden tabs pause ${folderPose === 1 ? 'open' : 'closed'} floating without advancing its phase and unmount cancels stale callbacks`, async () => {
    setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
    const run = harness(folderPose === 1 ? { ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose } : undefined);
    await makeReady();
    const before = packPose(models[0]);
    advanceFrame(16.67);
    advanceFrames(9);
    const expected = packPose(models[0]);

    run.reset();
    await makeReady();
    const model = models[1];
    const staleFrames = [...frames.values()];
    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new window.Event('visibilitychange'));
      time += 10_000;
      staleFrames.forEach(callback => callback(time));
    });
    assert.equal(frames.size, 0);
    assert.deepEqual(packPose(model), before);
    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    advanceFrames(10);
    packPose(model).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12));
    if (folderPose === 1) assertCalmOpen(model);
    else assertGentleFloat(model);
    const unmountedPose = packPose(model);
    const pending = [...frames.values()];
    run.view.unmount();
    act(() => pending.forEach(callback => callback(time + 1000)));
    assert.equal(frames.size, 0);
    assert.deepEqual(packPose(model), unmountedPose);
  });
}

test('live reduced motion neutralizes both poses and re-enabling motion resumes open idle', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4 });
  await makeReady();
  const model = models[0];
  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', true));
  settle();
  assert.ok(packPose(model).every(value => value === 0));
  act(() => run.controls.current!.activate());
  settle();
  assertSquareOpen(model);

  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', false));
  advanceFrames();
  assertCalmOpen(model);
  const openPose = packPose(model);
  advanceFrames(20);
  assert.notDeepEqual(packPose(model), openPose);
  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', true));
  settle();
  assertSquareOpen(model);
  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', false));
  advanceFrames();
  assertCalmOpen(model);
  act(() => run.controls.current!.navigate(1));
  advanceFrames();
  assertGentleFloat(model);
  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', true));
  settle();
  assert.equal(model.phase, 2);
  assert.ok(packPose(model).every(value => value === 0));
});

test('viewport changes preserve card layout and projection in the folder and after inspection', async () => {
  const run = harness();
  await makeReady();
  const model = models[0];
  const renderer = renderers[0];
  const homes = [homeFor(model, 0), homeFor(model, 1)];
  const cards = homes.map(cardLayout);
  const sizes = [[574, 831], [319, 700], [1440, 420], [900, 700]] as const;
  const openCameraPositions = new Map<number, THREE.Vector3>();
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
    openCameraPositions.set(width, renderer.camera!.position.clone());
  }

  for (const index of [0, 1] as const) {
    act(() => run.controls.current!.selectCard(index));
    settle();
    assert.equal(run.state.cardStage, 'inspecting');
    assert.equal(cards[index].mesh.parent, homes[index].anchor);
    for (const [width, height] of sizes) {
      resizeViewport(width, height);
      assertLayout();
      assert.ok(renderer.camera!.position.equals(openCameraPositions.get(width)!));
      assertInspectionFits(homes[index].anchor, renderer.camera!);
    }
    act(() => run.controls.current!.returnCard());
    settle();
    assert.equal(run.state.cardStage, 'pocket');
    homes.forEach(assertHome);
    assertLayout();
  }
  assert.deepEqual(run.errors, []);
});

test('resizing during card transitions preserves close-up framing and the original pocket', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const home = homeFor(models[0], 0);
  const camera = renderers[0].camera!;
  const assertInFrontOfPocket = () => {
    const pocketNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(home.parent.getWorldQuaternion(new THREE.Quaternion()));
    const pocketDepth = home.parent.localToWorld(home.position.clone()).dot(pocketNormal);
    assert.ok(home.anchor.getWorldPosition(new THREE.Vector3()).dot(pocketNormal) >= pocketDepth - 1e-8, 'Resizing must not push the card behind its moving pocket');
  };
  act(() => run.controls.current!.selectCard(0));
  for (let count = 0; home.anchor.parent === home.parent && count < 80; count += 1) advanceFrame();
  assert.equal(run.state.cardStage, 'lifting');
  assert.notEqual(home.anchor.parent, home.parent);
  advanceFrames(6);
  act(() => {
    viewportWidth = 319;
    viewportHeight = 700;
    observers.forEach(observer => observer.callback());
  });
  for (let count = 0; run.state.cardStage === 'lifting' && count < 80; count += 1) {
    advanceFrame(16.67);
    assertInFrontOfPocket();
  }
  advanceFrames();
  assert.equal(run.state.cardStage, 'inspecting');
  assertInspectionFits(home.anchor, camera);

  act(() => {
    viewportWidth = 1440;
    viewportHeight = 420;
    observers.forEach(observer => observer.callback());
  });
  for (let count = 0; frames.size && count < 80; count += 1) {
    advanceFrame();
    assertInspectionFits(home.anchor, camera);
  }
  assert.equal(frames.size, 1);
  act(() => run.controls.current!.returnCard());
  advanceFrames(2);
  act(() => {
    viewportWidth = 319;
    viewportHeight = 700;
    observers.forEach(observer => observer.callback());
  });
  for (let count = 0; run.state.cardStage === 'returning' && count < 80; count += 1) {
    advanceFrame(16.67);
    assertInFrontOfPocket();
  }
  assert.equal(run.state.cardStage, 'pocket');
  assertHome(home);
});

for (const reducedMotion of [false, true]) {
  for (const firstCard of [0, 1] as const) {
    test(`alternating cards from ${firstCard} keeps the moving card above its neighbor with ${reducedMotion ? 'reduced' : 'normal'} motion`, async () => {
      setMediaQueryMatches('(prefers-reduced-motion: reduce)', reducedMotion);
      const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
      await makeReady();
      const homes = [homeFor(models[0], 0), homeFor(models[0], 1)];
      const cards = homes.map(cardLayout);
      const camera = renderers[0].camera!;
      const assertLayers = (index: 0 | 1) => {
        cards.forEach((card, cardIndex) => {
          assert.equal(card.mesh.parent, homes[cardIndex].anchor);
          assert.equal(card.mesh.material.depthTest, true);
          assertCardAlignment(card, camera);
        });
        assertHome(homes[index === 0 ? 1 : 0]);
      };

      for (const index of [firstCard, firstCard === 0 ? 1 : 0, firstCard, firstCard === 0 ? 1 : 0] as const) {
        act(() => run.controls.current!.selectCard(index));
        for (let frame = 0; run.state.cardStage === 'lifting' && frame < 200; frame += 1) {
          advanceFrame(17);
          assertLayers(index);
        }
        assert.equal(run.state.cardStage, 'inspecting');
        if (reducedMotion) settle();
        else advanceFrames();
        assertLayers(index);
        act(() => run.controls.current!.returnCard());
        for (let frame = 0; run.state.cardStage === 'returning' && frame < 80; frame += 1) {
          advanceFrame(17);
          assertLayers(index);
        }
        assert.equal(run.state.cardStage, 'pocket');
        homes.forEach(assertHome);
      }
      assert.equal(run.count('card-lifted'), 4);
      assert.equal(run.count('card-returned'), 4);
    });
  }
}

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

test('sealed pack sparkles appear only for accepted pointer taps and fade while floating continues', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  const pointer = pointerControls(run);
  const sparkles = tapSparkles();
  assert.equal(sparkles.visible, false);
  assert.equal(sparkles.geometry.drawRange.count, 0);

  act(() => run.controls.current!.activate());
  advanceFrames();
  assert.equal(run.state.taps, 1);
  assert.equal(sparkles.visible, false);
  pointer.tap('mouse', 0, 0);
  pointer.dispatch('pointerdown');
  pointer.dispatch('pointermove', viewportWidth / 2, viewportHeight / 2 + 30);
  pointer.dispatch('pointerup', viewportWidth / 2, viewportHeight / 2 + 30);
  pointer.dispatch('pointerdown');
  pointer.dispatch('pointercancel');
  advanceFrames();
  assert.equal(run.state.taps, 1);
  assert.equal(sparkles.geometry.drawRange.count, 0);

  pointer.tap();
  advanceFrame();
  assert.equal(run.state.taps, 2);
  assert.equal(sparkles.visible, true);
  assert.ok(sparkles.geometry.drawRange.count > 0);
  advanceFrames();
  assert.equal(sparkles.visible, false);
  assert.equal(sparkles.geometry.drawRange.count, 0);

  pointer.tap('touch');
  advanceFrame();
  assert.equal(run.state.taps, 3);
  assert.equal(sparkles.visible, true);
  assert.equal(tapSparkles(), sparkles);
  advanceFrames();
  assert.equal(sparkles.visible, false);
  assert.equal(frames.size, 1);
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
  advanceFrames();
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

test('live finish tuning preserves sealed pack floating without rebuilding it', async () => {
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
  assert.equal(frames.size, 1);
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

test('live star layout changes preserve floating and the viewer resources and state', async () => {
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
  assert.equal(frames.size, 1);
  assert.equal(model.sealVerticalPosition, 0.3);
  assert.equal(model.sealSizeScale, 1);

  run.setSizeScale(1.4);
  assert.equal(frames.size, 1);
  advanceFrame();
  assert.equal(frames.size, 1);
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
  advanceFrames();
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
  advanceFrames();

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

test('normal motion lifts either card immediately while the folder keeps floating and the close-up stays fixed', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const initial: MiNoteRevealState = { ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 };
  const run = harness(initial);
  const model = models[0];
  const homes = [homeFor(model, 0), homeFor(model, 1)];
  await makeReady();
  const camera = renderers[0].camera!;
  const openCameraPosition = camera.position.clone();
  for (const index of [1, 0] as const) {
    const home = homes[index];
    const neighbor = homes[index === 0 ? 1 : 0];
    const before = packPose(model);
    const advanceWithIdle = (elapsed = 16.67) => {
      const previousPose = packPose(model);
      const previousNeighbor = neighbor.anchor.matrixWorld.clone();
      advanceFrame(elapsed);
      assertCalmOpen(model);
      assert.notDeepEqual(packPose(model), previousPose);
      assert.ok(!neighbor.anchor.matrixWorld.equals(previousNeighbor));
      assert.ok(camera.position.equals(openCameraPosition));
      assertHome(neighbor);
    };
    const assertAlignedWithPocket = () => {
      const position = home.parent.worldToLocal(home.anchor.getWorldPosition(new THREE.Vector3()));
      const quaternion = home.parent.getWorldQuaternion(new THREE.Quaternion());
      assert.ok(Math.abs(position.x - home.position.x) < 1e-10);
      assert.ok(Math.abs(position.z - home.position.z) < 1e-10);
      assert.ok(position.y >= home.position.y);
      assert.ok(1 - Math.abs(home.anchor.getWorldQuaternion(new THREE.Quaternion()).dot(quaternion)) < 1e-10);
    };
    assert.ok(new THREE.Vector4(...before).length() > 0.001);
    act(() => run.controls.current!.selectCard(index));
    assert.deepEqual(packPose(model), before);
    advanceWithIdle();
    assert.equal(run.state.cardStage, 'lifting');
    assert.equal(home.anchor.parent, renderers[0].scene);
    assertAlignedWithPocket();
    assert.ok(home.parent.worldToLocal(home.anchor.getWorldPosition(new THREE.Vector3())).y > home.position.y);
    for (let count = 1; count < 35; count += 1) {
      advanceWithIdle();
      assert.equal(run.state.cardStage, 'lifting');
      if (count < 14) assertAlignedWithPocket();
    }
    advanceWithIdle();
    assert.equal(run.state.cardStage, 'inspecting');
    assertInspectionFits(home.anchor, camera);
    const inspection = home.anchor.matrixWorld.clone();
    run.setVerticalPosition(index === 1 ? 0.3 : 0.4);
    for (let count = 0; count < 60; count += 1) {
      advanceWithIdle();
      assert.ok(home.anchor.matrixWorld.equals(inspection));
    }

    act(() => run.controls.current!.returnCard());
    for (let count = 1; count <= 33; count += 1) {
      advanceWithIdle();
      assert.equal(run.state.cardStage, 'returning');
      if (count >= 23) assertAlignedWithPocket();
    }
    advanceWithIdle(9);
    assert.equal(run.state.cardStage, 'returning');
    assertAlignedWithPocket();
    const beforeReattachment = home.anchor.getWorldPosition(new THREE.Vector3());
    const movingPocket = home.parent.localToWorld(home.position.clone());
    assert.ok(beforeReattachment.distanceTo(movingPocket) < 0.0002);
    advanceWithIdle(1);
    assert.equal(run.state.cardStage, 'pocket');
    homes.forEach(assertHome);
    assert.ok(home.anchor.getWorldPosition(new THREE.Vector3()).distanceTo(beforeReattachment) < 0.0002);
    advanceWithIdle();
  }
  assert.equal(run.count('card-lifted'), 2);
  assert.equal(run.count('card-returned'), 2);

  act(() => run.controls.current!.selectCard(1));
  advanceFrame();
  const staleFrames = [...frames.values()];
  assert.ok(staleFrames.length);
  run.view.unmount();
  const callbacksBefore = [run.events.length, run.readyChanges.length, run.errors.length];
  act(() => staleFrames.forEach(callback => callback(time + 1000)));
  assert.deepEqual([run.events.length, run.readyChanges.length, run.errors.length], callbacksBefore);
  assert.equal(run.controls.current, null);
  homes.forEach(home => assert.equal(home.anchor.parent, null));
  assert.equal(model.disposed, true);
  assert.equal(run.count('card-lifted'), 2);
  assert.equal(run.count('card-returned'), 2);
});

test('selecting a card from a closed folder still waits for the folder to open', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 2 });
  await makeReady();
  const model = models[0];
  const home = homeFor(model, 1);
  act(() => run.controls.current!.selectCard(1));
  advanceFrame(16.67);
  assert.equal(run.state.folderPose, 1);
  assert.equal(run.state.cardStage, 'lifting');
  assert.ok(model.phase > 1.015);
  assertHome(home);
  for (let count = 0; home.anchor.parent === home.parent && count < 80; count += 1) advanceFrame(16.67);
  assert.equal(model.phase, 1);
  assert.equal(home.anchor.parent, renderers[0].scene);
  advanceFrames();
  assert.equal(run.state.cardStage, 'inspecting');
  act(() => run.controls.current!.returnCard());
  for (let count = 0; run.state.cardStage === 'returning' && count < 80; count += 1) advanceFrame(16.67);
  assert.equal(run.state.cardStage, 'pocket');
  assertHome(home);
});

test('reduced motion can stop and restart folder idle during inspection without moving the close-up', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const model = models[0];
  const home = homeFor(model, 0);
  act(() => run.controls.current!.selectCard(0));
  advanceFrames();
  assert.equal(run.state.cardStage, 'inspecting');
  const inspection = home.anchor.matrixWorld.clone();
  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', true));
  settle();
  assertSquareOpen(model);
  assert.ok(home.anchor.matrixWorld.equals(inspection));
  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', false));
  advanceFrames();
  assertCalmOpen(model);
  const floating = packPose(model);
  advanceFrames(20);
  assert.notDeepEqual(packPose(model), floating);
  assert.ok(home.anchor.matrixWorld.equals(inspection));
  act(() => setMediaQueryMatches('(prefers-reduced-motion: reduce)', true));
  settle();
  assertSquareOpen(model);
  act(() => run.controls.current!.returnCard());
  for (let count = 0; run.state.cardStage === 'returning' && count < 20; count += 1) {
    advanceFrame(16.67);
    assertSquareOpen(model);
  }
  assert.equal(run.state.cardStage, 'pocket');
  assertHome(home);
  settle();
  assertSquareOpen(model);
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

test('all three effects update the same GPU surfaces in the pocket, close-up and return', async () => {
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const homes = [homeFor(models[0], 0), homeFor(models[0], 1)];
  const original = [...surfaces];
  const beforeUpdates = surfaces.map(surface => surface.updates);
  for (const effect of [DRIF_EFFECTS['swsh6-196'], CARD_NFT_2_NEUTRAL_CARD_EFFECT, DRIF_EFFECTS['swshp-SWSH179']]) {
    await act(async () => run.setCardEffect(effect));
    settle();
    assert.deepEqual(surfaces, original);
    assert.equal(renderers.length, 1);
    surfaces.forEach(surface => assert.equal(surface.effects.at(-1), effect));
    homes.forEach(assertHome);
  }
  surfaces.forEach((surface, index) => assert.ok(surface.updates > beforeUpdates[index]));
  act(() => run.controls.current!.selectCard(0));
  settle();
  run.setCardEffect(DRIF_EFFECTS['swsh6-196']);
  settle();
  assert.equal(run.state.cardStage, 'inspecting');
  assert.deepEqual(surfaces, original);
  act(() => run.controls.current!.returnCard());
  settle();
  homes.forEach(assertHome);
  surfaces.forEach(surface => assert.equal(surface.effects.at(-1), DRIF_EFFECTS['swsh6-196']));
});

test('GPU close-up drives the real material highlights toward the pointer for every effect', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const pointer = pointerControls(run);
  act(() => run.controls.current!.selectCard(0));
  advanceFrames();
  assert.equal(run.state.cardStage, 'inspecting');
  const uniforms = surfaces[0].material.uniforms;
  for (const effect of [DRIF_EFFECTS['swshp-SWSH179'], DRIF_EFFECTS['swsh6-196'], CARD_NFT_2_NEUTRAL_CARD_EFFECT]) {
    await act(async () => run.setCardEffect(effect));
    advanceFrames();
    for (const [x, y] of [[550, 350], [350, 350], [450, 250], [450, 450]]) {
      pointer.dispatch('pointermove', x, y);
      advanceFrames();
      const signX = Math.sign(x - viewportWidth / 2);
      const signY = Math.sign(y - viewportHeight / 2);
      if (signX) {
        assert.equal(Math.sign(uniforms.uPointer.value.x - 0.5), signX, `${effect.effectKey}: horizontal highlight`);
        assert.equal(Math.sign(uniforms.uBackground.value.x - 0.5), signX, `${effect.effectKey}: horizontal foil`);
      }
      if (signY) {
        assert.equal(Math.sign(uniforms.uPointer.value.y - 0.5), signY, `${effect.effectKey}: vertical highlight`);
        assert.equal(Math.sign(uniforms.uBackground.value.y - 0.5), signY, `${effect.effectKey}: vertical foil`);
      }
    }
  }
});

test('GPU close-up tilts with the pointer, ignores drags as taps, and settles after touch', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const pointer = pointerControls(run);
  const home = homeFor(models[0], 0);
  const card = cardLayout(home);
  act(() => run.controls.current!.selectCard(0));
  advanceFrames();
  pointer.dispatch('pointermove', 490, 300);
  advanceFrames();
  assert.notEqual(card.mesh.rotation.x, 0);
  assert.notEqual(card.mesh.rotation.y, 0);
  pointer.dispatch('pointerdown', 490, 300, 'touch');
  pointer.dispatch('pointermove', 530, 340, 'touch');
  advanceFrame();
  pointer.dispatch('pointerup', 530, 340, 'touch');
  advanceFrames();
  assert.equal(run.state.cardStage, 'inspecting');
  assert.equal(card.mesh.rotation.x, 0);
  assert.equal(card.mesh.rotation.y, 0);
  pointer.tap('touch');
  advanceFrames();
  assert.equal(run.state.cardStage, 'pocket');
  assertHome(home);
});

for (const [position, x] of [['outside', 870], ['inside', 530]] as const) {
  test(`releasing an inspection mouse drag ${position} the card preserves the matching hover tilt`, async () => {
    setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
    const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
    await makeReady();
    const pointer = pointerControls(run);
    const card = cardLayout(homeFor(models[0], 0));
    act(() => run.controls.current!.selectCard(0));
    advanceFrames();
    pointer.dispatch('pointerdown', 490, 300);
    pointer.dispatch('pointermove', x, 340);
    advanceFrames();
    assert.notEqual(card.mesh.rotation.x, 0);
    assert.notEqual(card.mesh.rotation.y, 0);
    const heldTilt = card.mesh.rotation.clone();
    pointer.dispatch('pointerup', x, 340);
    advanceFrames();
    assert.equal(pointer.captured.size, 0);
    assert.equal(run.state.cardStage, 'inspecting');
    assert.equal(run.count('return-card'), 0);
    if (position === 'outside') {
      assert.equal(card.mesh.rotation.x, 0);
      assert.equal(card.mesh.rotation.y, 0);
    } else assert.ok(card.mesh.rotation.equals(heldTilt));
  });
}

test('returning a card cancels a held pointer so release cannot select it again', async () => {
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const pointer = pointerControls(run);
  act(() => run.controls.current!.selectCard(0));
  settle();
  pointer.dispatch('pointerdown');
  act(() => run.controls.current!.escape());
  settle();
  assert.equal(run.state.cardStage, 'pocket');
  pointer.dispatch('pointerup');
  settle();
  assert.equal(run.state.cardStage, 'pocket');
  assert.equal(run.count('select-card'), 1);
});


test('card edits replace only changed materials and preserve the open folder and current effect', async () => {
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  await act(async () => run.setCardEffect(DRIF_EFFECTS['swsh6-196']));
  settle();
  const model = models[0];
  const homes = [homeFor(model, 0), homeFor(model, 1)];
  const meshes = homes.map(home => cardLayout(home).mesh);
  const previous = [...surfaces];
  const state = run.state;
  const controls = run.controls.current;
  deferSurfaceReady = true;
  run.setCards([{ ...run.cards[0], imageSrc: '/card-c.png', foilSrc: '/foil-c.png', textureSrc: '/mask-c.png' }, run.cards[1]]);
  const replacement = surfaces[2];
  assert.equal(models.length, 1);
  assert.equal(renderers.length, 1);
  assert.equal(run.controls.current, controls);
  assert.equal(run.state, state);
  assert.equal(model.phase, 1);
  homes.forEach(assertHome);
  assert.deepEqual(homes.map(home => cardLayout(home).mesh), meshes);
  assert.equal(previous[0].disposeCalls, 1);
  assert.equal(previous[1].disposeCalls, 0);
  assert.equal(meshes[0].material, replacement.material);
  assert.equal(meshes[1].material, previous[1].material);
  assert.equal(meshes[0].visible, false);
  assert.equal(meshes[1].visible, true);
  assert.equal(run.cardReadyChanges.at(-1), false);
  assert.equal(replacement.effects.at(-1), DRIF_EFFECTS['swsh6-196']);
  await act(async () => { replacement.resolveReady(); await replacement.ready; });
  settle();
  assert.equal(run.cardReadyChanges.at(-1), true);
  meshes.forEach(mesh => assert.equal(mesh.visible, true));
  const readiness = [...run.cardReadyChanges];
  run.setCards([{ ...run.cards[0] }, { ...run.cards[1] }]);
  assert.equal(surfaces.length, 3);
  assert.deepEqual(run.cardReadyChanges, readiness);
  run.view.unmount();
  assert.ok(surfaces.every(surface => surface.disposeCalls === 1));
});

test('editing an inspected card preserves its anchor and allows returning it to its pocket', async () => {
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const home = homeFor(models[0], 0);
  const mesh = cardLayout(home).mesh;
  act(() => run.controls.current!.selectCard(0));
  settle();
  const inspection = home.anchor.matrixWorld.clone();
  const scene = renderers[0].scene;
  await act(async () => run.setCards([run.cards[1], run.cards[1]]));
  settle();
  assert.equal(run.state.cardStage, 'inspecting');
  assert.equal(run.state.selectedCard, 0);
  assert.equal(home.anchor.parent, scene);
  assert.ok(home.anchor.matrixWorld.equals(inspection));
  assert.equal(cardLayout(home).mesh, mesh);
  assert.equal(mesh.material, surfaces[2].material);
  assert.equal(surfaces[2].card, run.cards[1]);
  assert.equal(models.length, 1);
  assert.equal(renderers.length, 1);
  act(() => run.controls.current!.returnCard());
  settle();
  assert.equal(run.state.cardStage, 'pocket');
  assert.equal(document.activeElement, run.view.getByRole('group', { name: 'Interactive Mi Note Cards folder' }));
  assert.equal(run.count('card-lifted'), 1);
  assert.equal(run.count('card-returned'), 1);
  assertHome(home);
});

test('finishing a card return preserves focus in an ID input being edited', async () => {
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  act(() => run.controls.current!.selectCard(0));
  settle();
  act(() => run.controls.current!.returnCard());
  advanceFrame();
  assert.equal(run.state.cardStage, 'returning');
  const input = document.createElement('input');
  input.type = 'number';
  input.setAttribute('aria-label', 'Left card ID');
  run.view.container.append(input);
  input.focus();
  input.value = '1430';
  await act(async () => run.setCards([{ ...run.cards[0], imageSrc: '/fronts/1430.webp' }, run.cards[1]]));
  settle();
  assert.equal(run.state.cardStage, 'pocket');
  assert.equal(document.activeElement, input);
  assert.equal(input.value, '1430');
});

for (const transition of ['lifting', 'returning'] as const) {
  test(`card edits during ${transition} preserve the active animation`, async () => {
    const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
    await makeReady();
    const home = homeFor(models[0], 0);
    act(() => run.controls.current!.selectCard(0));
    if (transition === 'returning') {
      settle();
      act(() => run.controls.current!.returnCard());
    }
    advanceFrame();
    assert.equal(run.state.cardStage, transition);
    const position = home.anchor.position.clone();
    deferSurfaceReady = true;
    run.setCards([{ ...run.cards[0], imageSrc: '/card-c.png' }, run.cards[1]]);
    assert.ok(home.anchor.position.equals(position));
    assert.equal(run.state.cardStage, transition);
    assert.equal(models.length, 1);
    settle();
    assert.equal(run.state.cardStage, transition === 'lifting' ? 'inspecting' : 'pocket');
    await act(async () => { surfaces[2].resolveReady(); await surfaces[2].ready; });
    settle();
    assert.equal(run.cardReadyChanges.at(-1), true);
    assert.equal(cardLayout(home).mesh.visible, true);
    if (transition === 'returning') assertHome(home);
    else assert.equal(home.anchor.parent, renderers[0].scene);
    assert.equal(run.count('card-lifted'), 1);
    assert.equal(run.count('card-returned'), transition === 'returning' ? 1 : 0);
  });
}

test('card edits keep an active seal peel and its completion on the same model', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
  const run = harness();
  await makeReady();
  act(() => { for (let count = 0; count < 4; count += 1) run.controls.current!.activate(); });
  advanceFrame();
  const model = models[0];
  assert.equal(run.state.stage, 'seal-peeling');
  assert.equal(model.sealStarts, 1);
  await act(async () => run.setCards([{ ...run.cards[0], textureSrc: '/mask-c.png' }, run.cards[1]]));
  assert.equal(models.length, 1);
  advanceFrames();
  assert.equal(run.state.stage, 'interactive');
  assert.equal(model.sealStarts, 1);
  assert.equal(run.count('seal-finished'), 1);
  assert.equal(surfaces[2].card.textureSrc, '/mask-c.png');
});

for (const outcome of ['ready', 'failure'] as const) {
  test(`rapid card edits ignore obsolete ${outcome} and wait for both current surfaces`, async () => {
    deferSurfaceReady = true;
    const run = harness();
    await makeReady();
    const previous = [...surfaces];
    run.setCards([{ ...run.cards[0], imageSrc: '/card-c.png' }, { ...run.cards[1], foilSrc: '/foil-d.png' }]);
    const current = surfaces.slice(2);
    assert.ok(previous.every(surface => surface.disposeCalls === 1));
    run.setCardEffect(DRIF_EFFECTS['swsh6-196']);
    const readiness = [...run.cardReadyChanges];
    const errors = [...run.cardErrors];
    await act(async () => {
      previous.forEach(surface => {
        if (outcome === 'ready') surface.resolveReady();
        else surface.rejectReady(new Error('Obsolete card error'));
      });
      await Promise.allSettled(previous.map(surface => surface.ready));
    });
    assert.deepEqual(run.cardReadyChanges, readiness);
    assert.deepEqual(run.cardErrors, errors);
    await act(async () => { current[0].resolveReady(); await current[0].ready; });
    assert.equal(run.cardReadyChanges.at(-1), false);
    const meshes = [homeFor(models[0], 0), homeFor(models[0], 1)].map(home => cardLayout(home).mesh);
    meshes.forEach(mesh => assert.equal(mesh.visible, false));
    await act(async () => { current[1].resolveReady(); await current[1].ready; });
    settle();
    assert.equal(run.cardReadyChanges.at(-1), true);
    meshes.forEach((mesh, index) => {
      assert.equal(mesh.material, current[index].material);
      assert.equal(mesh.visible, true);
      assert.equal(current[index].effects.at(-1), DRIF_EFFECTS['swsh6-196']);
    });
    assert.equal(renderers.length, 1);
    assert.deepEqual(run.errors, []);
  });
}

test('a new card ID clears a load failure and a newer effect wins over its pending load', async () => {
  const run = harness();
  await makeReady();
  deferSurfaceReady = true;
  run.setCards([{ ...run.cards[0], imageSrc: '/missing.png' }, run.cards[1]]);
  const error = new Error('Card unavailable');
  await act(async () => {
    surfaces[2].rejectReady(error);
    await surfaces[2].ready.catch(() => undefined);
  });
  assert.equal(run.cardErrors.at(-1), error);
  assert.equal(run.cardReadyChanges.at(-1), false);
  run.setCards([{ ...run.cards[0], imageSrc: '/card-c.png' }, run.cards[1]]);
  assert.equal(run.cardErrors.at(-1), null);
  const current = surfaces[3];
  current.effectReadiness.set('lighting-only', Promise.resolve());
  await act(async () => run.setCardEffect(CARD_NFT_2_NEUTRAL_CARD_EFFECT));
  settle();
  assert.equal(run.cardReadyChanges.at(-1), true);
  assert.equal(current.material.uniforms.uEffect.value, 2);
  const errors = [...run.cardErrors];
  const readiness = [...run.cardReadyChanges];
  await act(async () => {
    current.rejectReady(new Error('Obsolete effect failed'));
    await current.ready.catch(() => undefined);
  });
  assert.deepEqual(run.cardErrors, errors);
  assert.deepEqual(run.cardReadyChanges, readiness);
  assert.equal(renderers.length, 1);
});

test('unmount disposes replacement surfaces and ignores their late completion', async () => {
  const run = harness();
  await makeReady();
  deferSurfaceReady = true;
  run.setCards([{ ...run.cards[0], imageSrc: '/card-c.png' }, run.cards[1]]);
  run.setCards([{ ...run.cards[0], imageSrc: '/card-d.png' }, run.cards[1]]);
  run.view.unmount();
  assert.ok(surfaces.every(surface => surface.disposeCalls === 1));
  const readiness = [...run.cardReadyChanges];
  const errors = [...run.cardErrors];
  await act(async () => {
    surfaces.forEach(surface => surface.resolveReady());
    await Promise.all(surfaces.map(surface => surface.ready));
  });
  assert.deepEqual(run.cardReadyChanges, readiness);
  assert.deepEqual(run.cardErrors, errors);
  assert.equal(run.controls.current, null);
});

test('both GPU surfaces must finish loading before cards become visible or report ready', async () => {
  deferSurfaceReady = true;
  const run = harness();
  const meshes = [0, 1].map(index => cardLayout(homeFor(models[0], index as 0 | 1)).mesh);
  await makeReady();
  assert.deepEqual(run.cardReadyChanges, [false]);
  meshes.forEach(mesh => assert.equal(mesh.visible, false));
  await act(async () => { surfaces[0].resolveReady(); await surfaces[0].ready; });
  assert.deepEqual(run.cardReadyChanges, [false]);
  meshes.forEach(mesh => assert.equal(mesh.visible, false));
  run.setCardEffect(DRIF_EFFECTS['swsh6-196']);
  await act(async () => { surfaces[1].resolveReady(); await surfaces[1].ready; });
  settle();
  assert.deepEqual(run.cardReadyChanges, [false, false, true]);
  meshes.forEach(mesh => assert.equal(mesh.visible, true));
  surfaces.forEach(surface => assert.equal(surface.effects.at(-1), DRIF_EFFECTS['swsh6-196']));
  assert.deepEqual(run.errors, []);
});

for (const outcome of ['ready', 'failure'] as const) {
  test(`reset ignores late GPU texture ${outcome} from the disposed viewer`, async () => {
    deferSurfaceReady = true;
    const run = harness();
    const previousSurfaces = [...surfaces];
    const previousModel = models[0];
    run.reset();
    const callbacksBefore = [run.events.length, run.readyChanges.length, run.cardReadyChanges.length, run.errors.length];
    await act(async () => {
      previousModel.resolveReady();
      for (const surface of previousSurfaces) {
        if (outcome === 'ready') surface.resolveReady();
        else surface.rejectReady(new Error('Obsolete card failure'));
      }
      await Promise.allSettled([previousModel.ready, ...previousSurfaces.map(surface => surface.ready)]);
    });
    assert.deepEqual([run.events.length, run.readyChanges.length, run.cardReadyChanges.length, run.errors.length], callbacksBefore);
    assert.ok(previousSurfaces.every(surface => surface.disposed));
    assert.equal(run.cardReadyChanges.includes(true), false);
    await act(async () => {
      surfaces.slice(2).forEach(surface => surface.resolveReady());
      await Promise.all(surfaces.slice(2).map(surface => surface.ready));
    });
    await makeReady();
    assert.equal(run.cardReadyChanges.filter(Boolean).length, 1);
    assert.deepEqual(run.errors, []);
  });
}

test('a failed effect can recover to lighting without recreating the pack', async () => {
  deferSurfaceReady = true;
  const run = harness();
  const error = new Error('Card texture unavailable');
  await act(async () => {
    surfaces[0].rejectReady(error);
    await surfaces[0].ready.catch(() => undefined);
  });
  settle();
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.cardErrors, [null, error]);
  assert.deepEqual(run.cardReadyChanges, [false]);
  await act(async () => {
    surfaces[1].resolveReady();
    models[0].resolveReady();
    await Promise.all([surfaces[1].ready, models[0].ready]);
  });
  settle();
  assert.equal(run.readyChanges.includes(true), true);
  assert.equal(run.cardReadyChanges.includes(true), false);
  surfaces.forEach(surface => surface.effectReadiness.set('lighting-only', Promise.resolve()));
  await act(async () => run.setCardEffect(CARD_NFT_2_NEUTRAL_CARD_EFFECT));
  settle();
  assert.equal(renderers.length, 1);
  assert.equal(models.length, 1);
  assert.equal(run.cardErrors.at(-1), null);
  assert.equal(run.cardReadyChanges.at(-1), true);
  assert.equal(frames.size, 0);
  run.view.unmount();
  assert.ok(surfaces.every(surface => surface.disposed));
  assert.ok(renderers.every(renderer => renderer.disposed));
});

test('a stale effect failure does not override a newer ready effect', async () => {
  deferSurfaceReady = true;
  const run = harness();
  await makeReady();
  surfaces.forEach(surface => surface.effectReadiness.set('lighting-only', Promise.resolve()));
  await act(async () => run.setCardEffect(CARD_NFT_2_NEUTRAL_CARD_EFFECT));
  settle();
  const errors = [...run.cardErrors];
  const readiness = [...run.cardReadyChanges];
  await act(async () => {
    surfaces.forEach(surface => surface.rejectReady(new Error('Old effect failed')));
    await Promise.allSettled(surfaces.map(surface => surface.ready));
  });
  assert.deepEqual(run.cardErrors, errors);
  assert.deepEqual(run.cardReadyChanges, readiness);
  assert.equal(run.cardReadyChanges.at(-1), true);
});

test('context loss blocks late GPU texture readiness until a fresh viewer is mounted', async () => {
  deferSurfaceReady = true;
  const run = harness();
  act(() => renderers[0].domElement.dispatchEvent(new window.Event('webglcontextlost', { cancelable: true })));
  await act(async () => {
    surfaces.forEach(surface => surface.resolveReady());
    models[0].resolveReady();
    await Promise.all([models[0].ready, ...surfaces.map(surface => surface.ready)]);
  });
  settle();
  assert.equal(run.errors.length, 1);
  assert.equal(run.readyChanges.includes(true), false);
  assert.equal(run.cardReadyChanges.includes(true), false);
});

for (const cancellation of ['pointercancel', 'lostpointercapture', 'blur', 'hidden'] as const) {
  test(`an inspection press interrupted by ${cancellation} settles and accepts a fresh tap`, async () => {
    setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
    const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
    await makeReady();
    const pointer = pointerControls(run);
    const home = homeFor(models[0], 0);
    const card = cardLayout(home);
    act(() => run.controls.current!.selectCard(0));
    advanceFrames();
    pointer.dispatch('pointerdown', 490, 300, 'touch');
    advanceFrames();
    assert.equal(document.activeElement, pointer.host);
    assert.ok(pointer.captured.has(1));
    assert.notEqual(card.mesh.rotation.y, 0);
    if (cancellation === 'blur') {
      act(() => window.dispatchEvent(new window.Event('blur')));
    } else if (cancellation === 'hidden') {
      act(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new window.Event('visibilitychange'));
      });
      assert.equal(frames.size, 0);
      act(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new window.Event('visibilitychange'));
      });
    } else pointer.dispatch(cancellation, 490, 300, 'touch');
    pointer.dispatch('pointerup', 490, 300, 'touch');
    act(() => pointer.host.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })));
    advanceFrames();
    assert.equal(pointer.captured.size, 0);
    assert.equal(run.state.cardStage, 'inspecting');
    assert.equal(run.count('return-card'), 0);
    assert.equal(card.mesh.rotation.x, 0);
    assert.equal(card.mesh.rotation.y, 0);
    pointer.tap('touch');
    act(() => pointer.host.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })));
    advanceFrames();
    assert.equal(run.count('return-card'), 1);
    assert.equal(run.state.cardStage, 'pocket');
    assertHome(home);
  });
}

test('secondary and non-left inspection pointers cannot replace or finish the active press', async () => {
  const run = harness({ ...createMiNoteRevealState(), stage: 'interactive', ready: true, taps: 4, folderPose: 1 });
  await makeReady();
  const pointer = pointerControls(run);
  act(() => run.controls.current!.selectCard(1));
  settle();
  for (const overrides of [{ isPrimary: false }, { button: 2 }]) {
    pointer.dispatch('pointerdown', 450, 350, 'touch', overrides);
    pointer.dispatch('pointerup', 450, 350, 'touch', overrides);
    assert.equal(pointer.captured.size, 0);
  }
  pointer.dispatch('pointerdown', 450, 350, 'touch');
  for (const overrides of [{ pointerId: 2, isPrimary: false }, { pointerId: 3 }]) {
    pointer.dispatch('pointerdown', 450, 350, 'touch', overrides);
    pointer.dispatch('pointermove', 530, 350, 'touch', overrides);
    pointer.dispatch('pointerup', 530, 350, 'touch', overrides);
    pointer.dispatch('pointercancel', 530, 350, 'touch', overrides);
    assert.deepEqual([...pointer.captured], [1]);
  }
  assert.equal(run.count('return-card'), 0);
  assert.equal(run.state.cardStage, 'inspecting');
  pointer.dispatch('pointerup', 450, 350, 'touch');
  settle();
  assert.equal(pointer.captured.size, 0);
  assert.equal(run.count('return-card'), 1);
  assert.equal(run.state.cardStage, 'pocket');
});
