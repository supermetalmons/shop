import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import {
  MI_NOTE_STAR_FOLDS_STORAGE_KEY,
  isMiNoteStarTunable,
  normalizeMiNoteStarFoldPosition,
  normalizeMiNoteStarRotationOffset,
  normalizeMiNoteStarSizeScale,
  normalizeMiNoteStarVerticalPosition,
  parseMiNoteStarFolds,
  parseMiNoteStarRotationOffsets,
  parseMiNoteStarSizeScales,
  serializeMiNoteStarFolds,
} from '../src/lib/miNoteStarFolds.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useMiNoteStarFolds } = await import('../src/hooks/useMiNoteStarFolds.ts');
const storage = window.localStorage;
const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
const defaultFolds = { blush: 0.574, twinkle: 0.49, zombie: 0.487 };
const defaultRotations = { blush: 2.8, twinkle: 3.2, zombie: 2.4 };
const defaultSizes = { blush: 1.13, twinkle: 1, zombie: 1 };

beforeEach(() => storage.clear());
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'localStorage', storageDescriptor);
});
after(() => dom.window.close());

test('fold positions use thousandth increments, clamp valid numbers, and replace non-finite values', () => {
  assert.equal(normalizeMiNoteStarFoldPosition(0.57349), 0.573);
  assert.equal(normalizeMiNoteStarFoldPosition(0.57351), 0.574);
  assert.equal(normalizeMiNoteStarFoldPosition(-1), 0.1);
  assert.equal(normalizeMiNoteStarFoldPosition(10), 0.9);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(normalizeMiNoteStarFoldPosition(value), 0.573);
  }
});

test('rotation offsets use tenth-degree increments, clamp both directions, and center invalid values', () => {
  assert.equal(normalizeMiNoteStarRotationOffset(4.34), 4.3);
  assert.equal(normalizeMiNoteStarRotationOffset(-4.36), -4.4);
  assert.equal(normalizeMiNoteStarRotationOffset(-0.01), 0);
  assert.equal(normalizeMiNoteStarRotationOffset(-100), -15);
  assert.equal(normalizeMiNoteStarRotationOffset(100), 15);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(normalizeMiNoteStarRotationOffset(value), 0);
  }
});

test('vertical positions and sizes clamp, round to their increments, and default invalid numbers', () => {
  assert.equal(normalizeMiNoteStarVerticalPosition(0.6236), 0.624);
  assert.equal(normalizeMiNoteStarVerticalPosition(-1), 0.2);
  assert.equal(normalizeMiNoteStarVerticalPosition(10), 0.8);
  assert.equal(normalizeMiNoteStarSizeScale(1.236), 1.24);
  assert.equal(normalizeMiNoteStarSizeScale(-1), 0.5);
  assert.equal(normalizeMiNoteStarSizeScale(10), 1.5);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(normalizeMiNoteStarVerticalPosition(value), 0.485);
    assert.equal(normalizeMiNoteStarSizeScale(value), 1);
  }
});

test('only Twinkle and Zombie can be tuned', () => {
  for (const id of ['twinkle', 'zombie']) assert.equal(isMiNoteStarTunable(id), true);
  for (const id of ['blush', 'yellow', 'unknown', 'Twinkle', '', '__proto__']) assert.equal(isMiNoteStarTunable(id), false);
});

test('absent, malformed, unsupported, and invalid saved payloads use each current preset', () => {
  for (const raw of [null, '', '{', 'null', '[]', '{}',
    '{"version":2,"foldPositions":{"twinkle":0.8},"rotationOffsetsDegrees":{"zombie":-10}}',
    '{"version":1,"foldPositions":[],"rotationOffsetsDegrees":[]}',
    '{"version":1,"foldPositions":null,"rotationOffsetsDegrees":null}',
    '{"version":1,"foldPositions":1,"rotationOffsetsDegrees":"invalid"}',
    '{"version":1,"foldPositions":{"twinkle":0.01,"zombie":1e309},"rotationOffsetsDegrees":{"twinkle":16,"zombie":-1e309}}',
  ]) {
    assert.deepEqual(parseMiNoteStarFolds(raw), defaultFolds);
    assert.deepEqual(parseMiNoteStarRotationOffsets(raw), defaultRotations);
    assert.deepEqual(parseMiNoteStarSizeScales(raw), defaultSizes);
  }
});

test('legacy settings recover tunable stars while ignoring fixed, removed, and unknown stars', () => {
  const raw = JSON.stringify({
    version: 1,
    foldPositions: { blush: 0.3, twinkle: 0.73145, zombie: 0.1, yellow: 0.8, unknown: 0.6 },
    rotationOffsetsDegrees: { blush: -10, twinkle: 7.64, zombie: -15, yellow: 12, unknown: 3 },
  });
  assert.deepEqual(parseMiNoteStarFolds(raw), { blush: 0.574, twinkle: 0.731, zombie: 0.1 });
  assert.deepEqual(parseMiNoteStarRotationOffsets(raw), { blush: 2.8, twinkle: 7.6, zombie: -15 });
  assert.deepEqual(parseMiNoteStarSizeScales(raw), defaultSizes);
  const partiallyInvalid = JSON.stringify({
    version: 1,
    foldPositions: { twinkle: '0.7', zombie: 0.9 },
    rotationOffsetsDegrees: { twinkle: 15, zombie: null },
  });
  assert.deepEqual(parseMiNoteStarFolds(partiallyInvalid), { ...defaultFolds, zombie: 0.9 });
  assert.deepEqual(parseMiNoteStarRotationOffsets(partiallyInvalid), { ...defaultRotations, twinkle: 15 });
});

test('saved sizes recover tunable stars while retaining the fixed Blush preset', () => {
  const raw = JSON.stringify({
    version: 1,
    sizeScales: { blush: 1.234, twinkle: 0.5, zombie: 1.5, yellow: 0.8, unknown: 1.2 },
  });
  assert.deepEqual(parseMiNoteStarSizeScales(raw), { blush: 1.13, twinkle: 0.5, zombie: 1.5 });
  for (const value of [null, '1.2', 0.49, 1.51, [], {}]) {
    const invalidSize = JSON.stringify({ version: 1, sizeScales: { twinkle: value, zombie: 1.25 } });
    assert.deepEqual(parseMiNoteStarSizeScales(invalidSize), { ...defaultSizes, zombie: 1.25 });
  }
  assert.deepEqual(parseMiNoteStarSizeScales('{"version":1,"sizeScales":{"twinkle":1e309}}'), defaultSizes);
  assert.deepEqual(parseMiNoteStarSizeScales('{"version":2,"sizeScales":{"twinkle":1.2}}'), defaultSizes);
});

test('serialization exports fixed vertical position and Blush presets with normalized tuning', () => {
  const serialized = serializeMiNoteStarFolds(
    { blush: 0.1, twinkle: 0.6124, zombie: -100, yellow: 0.8, unknown: 0.6 },
    { blush: -12, twinkle: -3.72, zombie: 100, yellow: 8, unknown: 2 },
    { blush: 1.234, twinkle: -10, zombie: 10, yellow: 0.8, unknown: 1.2 },
  );
  const payload = JSON.parse(serialized);
  assert.deepEqual(payload, {
    version: 1,
    foldPositions: { blush: 0.574, twinkle: 0.612, zombie: 0.1 },
    rotationOffsetsDegrees: { blush: 2.8, twinkle: -3.7, zombie: 15 },
    verticalPosition: 0.485,
    sizeScales: { blush: 1.13, twinkle: 0.5, zombie: 1.5 },
  });
  assert.deepEqual(parseMiNoteStarFolds(serialized), payload.foldPositions);
  assert.deepEqual(parseMiNoteStarRotationOffsets(serialized), payload.rotationOffsetsDegrees);
  assert.deepEqual(parseMiNoteStarSizeScales(serialized), payload.sizeScales);
  assert.deepEqual(JSON.parse(serializeMiNoteStarFolds({ twinkle: NaN }, { zombie: Infinity }, { twinkle: Infinity })), {
    version: 1, foldPositions: defaultFolds, rotationOffsetsDegrees: defaultRotations,
    verticalPosition: 0.485, sizeScales: defaultSizes,
  });
  assert.deepEqual(JSON.parse(serializeMiNoteStarFolds({})).rotationOffsetsDegrees, defaultRotations);
});

test('mounting reads legacy or malformed content without rewriting storage in Strict Mode', t => {
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  for (const raw of ['{', '{"version":1,"foldPositions":{"twinkle":0.63,"blush":0.3,"yellow":0.8},"verticalPosition":0.65,"sizeScales":{"blush":1.4}}']) {
    storage.setItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY, raw);
    const beforeMount = setItem.mock.callCount();
    const view = renderHook(useMiNoteStarFolds, { reactStrictMode: true });
    assert.equal(view.result.current.storageError, false);
    assert.deepEqual(view.result.current.foldPositions, parseMiNoteStarFolds(raw));
    assert.equal(view.result.current.verticalPosition, 0.485);
    assert.deepEqual(view.result.current.sizeScales, defaultSizes);
    assert.equal(setItem.mock.callCount(), beforeMount);
    assert.equal(storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY), raw);
    view.unmount();
  }
});

test('adding size to a legacy fold-only payload preserves recovered tuning', () => {
  storage.setItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY, JSON.stringify({
    version: 1, foldPositions: { blush: 0.42, twinkle: 0.731, zombie: 0.62, yellow: 0.8 },
  }));
  const view = renderHook(useMiNoteStarFolds);
  assert.deepEqual(view.result.current.foldPositions, { blush: 0.574, twinkle: 0.731, zombie: 0.62 });
  assert.deepEqual(view.result.current.rotationOffsetsDegrees, defaultRotations);
  act(() => {
    view.result.current.setRotationOffset('twinkle', -5.2);
    view.result.current.setSizeScale('twinkle', 1.2);
  });
  const saved = storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY);
  assert.deepEqual(parseMiNoteStarFolds(saved), view.result.current.foldPositions);
  assert.deepEqual(parseMiNoteStarRotationOffsets(saved), { ...defaultRotations, twinkle: -5.2 });
  assert.deepEqual(parseMiNoteStarSizeScales(saved), { ...defaultSizes, twinkle: 1.2 });
  assert.equal(Object.hasOwn(JSON.parse(saved!).foldPositions, 'yellow'), false);
});

test('batched size edits keep stars independent, ignore fixed stars, and survive remount', t => {
  storage.setItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY, JSON.stringify({
    version: 1, verticalPosition: 0.7, sizeScales: { blush: 1.4 },
  }));
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  const view = renderHook(useMiNoteStarFolds, { reactStrictMode: true });
  act(() => {
    view.result.current.setSizeScale('twinkle', 0.78);
    view.result.current.setSizeScale('zombie', 1.35);
    view.result.current.setSizeScale('twinkle', 0.781);
    for (const id of ['blush', 'yellow', 'unknown', '__proto__']) view.result.current.setSizeScale(id, 1.4);
  });
  const expectedSizes = { blush: 1.13, twinkle: 0.78, zombie: 1.35 };
  assert.equal(view.result.current.verticalPosition, 0.485);
  assert.deepEqual(view.result.current.sizeScales, expectedSizes);
  assert.deepEqual(view.result.current.foldPositions, defaultFolds);
  assert.deepEqual(view.result.current.rotationOffsetsDegrees, defaultRotations);
  assert.equal(setItem.mock.callCount(), 2);
  assert.equal(JSON.parse(storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY)!).verticalPosition, 0.485);
  view.unmount();
  const reloaded = renderHook(useMiNoteStarFolds);
  assert.equal(reloaded.result.current.verticalPosition, 0.485);
  assert.deepEqual(reloaded.result.current.sizeScales, expectedSizes);
  assert.equal(setItem.mock.callCount(), 2);
});

test('batched edits retain both tunable stars, ignore fixed and removed IDs, and survive remount', t => {
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  const view = renderHook(useMiNoteStarFolds, { reactStrictMode: true });
  act(() => {
    view.result.current.setFoldPosition('twinkle', 0.675);
    view.result.current.setRotationOffset('twinkle', -3.7);
    view.result.current.setFoldPosition('zombie', 0.424);
    view.result.current.setRotationOffset('zombie', 5.5);
    view.result.current.setFoldPosition('twinkle', 0.68);
    view.result.current.setRotationOffset('twinkle', -4.1);
    view.result.current.setFoldPosition('twinkle', 0.6801);
    view.result.current.setRotationOffset('twinkle', -4.12);
    for (const id of ['blush', 'yellow', 'unknown', '__proto__']) {
      view.result.current.setFoldPosition(id, 0.7);
      view.result.current.setRotationOffset(id, 10);
    }
  });
  const expectedFolds = { blush: 0.574, twinkle: 0.68, zombie: 0.424 };
  const expectedRotations = { blush: 2.8, twinkle: -4.1, zombie: 5.5 };
  assert.deepEqual(view.result.current.foldPositions, expectedFolds);
  assert.deepEqual(view.result.current.rotationOffsetsDegrees, expectedRotations);
  assert.equal(setItem.mock.callCount(), 6);
  view.unmount();
  const reloaded = renderHook(useMiNoteStarFolds);
  assert.deepEqual(reloaded.result.current.foldPositions, expectedFolds);
  assert.deepEqual(reloaded.result.current.rotationOffsetsDegrees, expectedRotations);
  assert.equal(setItem.mock.callCount(), 6);
});

test('denied storage leaves tuning usable while Blush remains fixed', () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage access denied'); },
  });
  const view = renderHook(useMiNoteStarFolds);
  assert.equal(view.result.current.storageError, true);
  assert.deepEqual(view.result.current.foldPositions, defaultFolds);
  assert.deepEqual(view.result.current.rotationOffsetsDegrees, defaultRotations);
  act(() => {
    view.result.current.setFoldPosition('twinkle', 0.65);
    view.result.current.setRotationOffset('twinkle', -7.3);
    view.result.current.setFoldPosition('blush', 0.8);
    view.result.current.setRotationOffset('blush', 12);
    view.result.current.setSizeScale('twinkle', 1.2);
  });
  assert.deepEqual(view.result.current.foldPositions, { ...defaultFolds, twinkle: 0.65 });
  assert.deepEqual(view.result.current.rotationOffsetsDegrees, { ...defaultRotations, twinkle: -7.3 });
  assert.equal(view.result.current.verticalPosition, 0.485);
  assert.deepEqual(view.result.current.sizeScales, { ...defaultSizes, twinkle: 1.2 });
  assert.equal(view.result.current.storageError, true);
});

test('failed writes preserve edits and the next successful write persists all tuning', t => {
  const view = renderHook(useMiNoteStarFolds);
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem', () => {
    throw new Error('Storage quota exceeded');
  });
  act(() => {
    view.result.current.setFoldPosition('twinkle', 0.65);
    view.result.current.setRotationOffset('twinkle', -7.3);
    view.result.current.setSizeScale('twinkle', 1.2);
  });
  assert.equal(view.result.current.storageError, true);
  assert.equal(storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY), null);
  setItem.mock.restore();
  act(() => {
    view.result.current.setFoldPosition('zombie', 0.45);
    view.result.current.setRotationOffset('zombie', 4.8);
  });
  assert.equal(view.result.current.storageError, false);
  assert.deepEqual(view.result.current.foldPositions, { blush: 0.574, twinkle: 0.65, zombie: 0.45 });
  assert.deepEqual(view.result.current.rotationOffsetsDegrees, { blush: 2.8, twinkle: -7.3, zombie: 4.8 });
  const saved = storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY);
  assert.deepEqual(parseMiNoteStarFolds(saved), view.result.current.foldPositions);
  assert.deepEqual(parseMiNoteStarRotationOffsets(saved), view.result.current.rotationOffsetsDegrees);
  assert.deepEqual(parseMiNoteStarSizeScales(saved), { ...defaultSizes, twinkle: 1.2 });
});
