import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import { MI_NOTE_PACK_STARS } from '../src/lib/miNotePackStars.ts';
import {
  MI_NOTE_STAR_FOLD_DEFAULT,
  MI_NOTE_STAR_FOLD_MAX,
  MI_NOTE_STAR_FOLD_MIN,
  MI_NOTE_STAR_FOLDS_STORAGE_KEY,
  MI_NOTE_STAR_ROTATION_DEFAULT,
  MI_NOTE_STAR_ROTATION_MAX,
  MI_NOTE_STAR_ROTATION_MIN,
  normalizeMiNoteStarFoldPosition,
  normalizeMiNoteStarRotationOffset,
  parseMiNoteStarFolds,
  parseMiNoteStarRotationOffsets,
  serializeMiNoteStarFolds,
} from '../src/lib/miNoteStarFolds.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useMiNoteStarFolds } = await import('../src/hooks/useMiNoteStarFolds.ts');
const storage = window.localStorage;
const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;

beforeEach(() => storage.clear());
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'localStorage', storageDescriptor);
});
after(() => dom.window.close());

test('fold positions use thousandth increments, clamp valid numbers, and replace non-finite values', () => {
  assert.equal(normalizeMiNoteStarFoldPosition(0.57349), 0.573);
  assert.equal(normalizeMiNoteStarFoldPosition(0.57351), 0.574);
  assert.equal(normalizeMiNoteStarFoldPosition(-1), MI_NOTE_STAR_FOLD_MIN);
  assert.equal(normalizeMiNoteStarFoldPosition(10), MI_NOTE_STAR_FOLD_MAX);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(normalizeMiNoteStarFoldPosition(value), MI_NOTE_STAR_FOLD_DEFAULT);
  }
});

test('rotation offsets use tenth-degree increments, clamp both directions, and center invalid values', () => {
  assert.equal(normalizeMiNoteStarRotationOffset(4.34), 4.3);
  assert.equal(normalizeMiNoteStarRotationOffset(-4.36), -4.4);
  assert.equal(normalizeMiNoteStarRotationOffset(-0.01), 0);
  assert.equal(normalizeMiNoteStarRotationOffset(-100), MI_NOTE_STAR_ROTATION_MIN);
  assert.equal(normalizeMiNoteStarRotationOffset(100), MI_NOTE_STAR_ROTATION_MAX);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(normalizeMiNoteStarRotationOffset(value), MI_NOTE_STAR_ROTATION_DEFAULT);
  }
});

test('absent, malformed, and unsupported saved payloads restore every default', () => {
  for (const raw of [null, '', '{', 'null', '[]', '{}',
    '{"version":2,"foldPositions":{"yellow":0.8}}',
    '{"version":1,"foldPositions":[]}',
    '{"version":1,"foldPositions":null}',
  ]) {
    const positions = parseMiNoteStarFolds(raw);
    const rotations = parseMiNoteStarRotationOffsets(raw);
    assert.equal(Object.keys(positions).length, 17);
    assert.equal(Object.keys(rotations).length, 17);
    for (const { id } of MI_NOTE_PACK_STARS) {
      assert.equal(positions[id], MI_NOTE_STAR_FOLD_DEFAULT);
      assert.equal(rotations[id], MI_NOTE_STAR_ROTATION_DEFAULT);
    }
  }
});

test('saved values validate independently and ignore unknown stars', () => {
  const positions = parseMiNoteStarFolds(JSON.stringify({
    version: 1,
    foldPositions: {
      yellow: 0.73145,
      blush: '0.8',
      boy: 0,
      cheery: 1,
      magenta: null,
      malfy: [],
      phoenix: 0.1,
      rainbow: 0.9,
      unknown: 0.6,
    },
  }));
  assert.equal(positions.yellow, 0.731);
  assert.equal(positions.phoenix, 0.1);
  assert.equal(positions.rainbow, 0.9);
  for (const id of ['blush', 'boy', 'cheery', 'magenta', 'malfy', 'sentient']) {
    assert.equal(positions[id], MI_NOTE_STAR_FOLD_DEFAULT);
  }
  assert.equal(Object.hasOwn(positions, 'unknown'), false);
});

test('saved rotation offsets validate independently and ignore unknown stars', () => {
  const rotations = parseMiNoteStarRotationOffsets(JSON.stringify({
    version: 1,
    rotationOffsetsDegrees: {
      yellow: 7.64,
      blush: '-5',
      boy: -15.01,
      cheery: 15.01,
      magenta: null,
      malfy: [],
      phoenix: -15,
      rainbow: 15,
      unknown: 2,
    },
  }));
  assert.equal(rotations.yellow, 7.6);
  assert.equal(rotations.phoenix, -15);
  assert.equal(rotations.rainbow, 15);
  for (const id of ['blush', 'boy', 'cheery', 'magenta', 'malfy', 'sentient']) {
    assert.equal(rotations[id], MI_NOTE_STAR_ROTATION_DEFAULT);
  }
  assert.equal(Object.hasOwn(rotations, 'unknown'), false);
  for (const rotationOffsetsDegrees of [[], null, 1, 'invalid']) {
    const raw = JSON.stringify({ version: 1, rotationOffsetsDegrees });
    assert.deepEqual(parseMiNoteStarRotationOffsets(raw), parseMiNoteStarRotationOffsets(null));
  }
});

test('export includes all effective values in catalog order, including the numeric star ID last', () => {
  const serialized = serializeMiNoteStarFolds(
    { yellow: 0.6124, '83': 0.77, unknown: 0.8 },
    { yellow: -3.72, '83': 5.16, unknown: 2 },
  );
  const payload = JSON.parse(serialized);
  assert.equal(payload.version, 1);
  assert.equal(Object.keys(payload.foldPositions).length, 17);
  assert.equal(payload.foldPositions.yellow, 0.612);
  assert.equal(payload.foldPositions.blush, MI_NOTE_STAR_FOLD_DEFAULT);
  assert.equal(payload.foldPositions['83'], 0.77);
  assert.equal(Object.hasOwn(payload.foldPositions, 'unknown'), false);
  assert.equal(Object.keys(payload.rotationOffsetsDegrees).length, 17);
  assert.equal(payload.rotationOffsetsDegrees.yellow, -3.7);
  assert.equal(payload.rotationOffsetsDegrees.blush, MI_NOTE_STAR_ROTATION_DEFAULT);
  assert.equal(payload.rotationOffsetsDegrees['83'], 5.2);
  assert.equal(Object.hasOwn(payload.rotationOffsetsDegrees, 'unknown'), false);
  assert.deepEqual(
    [...serialized.matchAll(/^    "([^"]+)":/gm)].map(match => match[1]),
    [...MI_NOTE_PACK_STARS, ...MI_NOTE_PACK_STARS].map(({ id }) => id),
  );
  assert.deepEqual(parseMiNoteStarFolds(serialized), payload.foldPositions);
  assert.deepEqual(parseMiNoteStarRotationOffsets(serialized), payload.rotationOffsetsDegrees);
  const withoutRotations = JSON.parse(serializeMiNoteStarFolds({ yellow: 0.7 }));
  assert.deepEqual(withoutRotations.rotationOffsetsDegrees, parseMiNoteStarRotationOffsets(null));
});

test('mounting reads settings without rewriting saved content, including malformed content', t => {
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  for (const raw of ['{', '{"version":1,"foldPositions":{"yellow":0.63}}']) {
    storage.setItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY, raw);
    const beforeMount = setItem.mock.callCount();
    const view = renderHook(useMiNoteStarFolds, { reactStrictMode: true });
    assert.equal(view.result.current.storageError, false);
    assert.equal(setItem.mock.callCount(), beforeMount);
    assert.equal(storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY), raw);
    view.unmount();
  }
});

test('legacy saved folds retain their values when rotation settings are first added', () => {
  storage.setItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY, JSON.stringify({
    version: 1,
    foldPositions: { yellow: 0.731, blush: 0.42 },
  }));
  const view = renderHook(useMiNoteStarFolds);
  assert.equal(view.result.current.foldPositions.yellow, 0.731);
  assert.equal(view.result.current.foldPositions.blush, 0.42);
  assert.deepEqual(view.result.current.rotationOffsetsDegrees, parseMiNoteStarRotationOffsets(null));
  act(() => view.result.current.setRotationOffset('yellow', -5.2));
  const saved = storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY);
  assert.equal(parseMiNoteStarFolds(saved).yellow, 0.731);
  assert.equal(parseMiNoteStarFolds(saved).blush, 0.42);
  assert.equal(parseMiNoteStarRotationOffsets(saved).yellow, -5.2);
});

test('consecutive edits keep independent settings, avoid unchanged writes, and survive remount', t => {
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  const view = renderHook(useMiNoteStarFolds, { reactStrictMode: true });
  act(() => {
    view.result.current.setFoldPosition('yellow', 0.675);
    view.result.current.setRotationOffset('yellow', -3.7);
    view.result.current.setFoldPosition('blush', 0.424);
    view.result.current.setRotationOffset('blush', 5.5);
    view.result.current.setFoldPosition('yellow', 0.68);
    view.result.current.setRotationOffset('yellow', -4.1);
    view.result.current.setFoldPosition('yellow', 0.6801);
    view.result.current.setRotationOffset('yellow', -4.12);
    view.result.current.setFoldPosition('unknown', 0.7);
    view.result.current.setRotationOffset('unknown', 10);
  });
  assert.equal(view.result.current.foldPositions.yellow, 0.68);
  assert.equal(view.result.current.foldPositions.blush, 0.424);
  assert.equal(view.result.current.foldPositions.boy, MI_NOTE_STAR_FOLD_DEFAULT);
  assert.equal(Object.hasOwn(view.result.current.foldPositions, 'unknown'), false);
  assert.equal(view.result.current.rotationOffsetsDegrees.yellow, -4.1);
  assert.equal(view.result.current.rotationOffsetsDegrees.blush, 5.5);
  assert.equal(view.result.current.rotationOffsetsDegrees.boy, MI_NOTE_STAR_ROTATION_DEFAULT);
  assert.equal(Object.hasOwn(view.result.current.rotationOffsetsDegrees, 'unknown'), false);
  assert.equal(setItem.mock.callCount(), 6);
  const expected = view.result.current.foldPositions;
  const expectedRotations = view.result.current.rotationOffsetsDegrees;
  view.unmount();
  const reloaded = renderHook(useMiNoteStarFolds);
  assert.deepEqual(reloaded.result.current.foldPositions, expected);
  assert.deepEqual(reloaded.result.current.rotationOffsetsDegrees, expectedRotations);
  assert.equal(setItem.mock.callCount(), 6);
});

test('denied storage access keeps tuning usable and reports the read and write failures', () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage access denied'); },
  });
  const view = renderHook(useMiNoteStarFolds);
  assert.equal(view.result.current.storageError, true);
  assert.equal(view.result.current.foldPositions.yellow, MI_NOTE_STAR_FOLD_DEFAULT);
  assert.equal(view.result.current.rotationOffsetsDegrees.yellow, MI_NOTE_STAR_ROTATION_DEFAULT);
  act(() => {
    view.result.current.setFoldPosition('yellow', 0.65);
    view.result.current.setRotationOffset('yellow', -7.3);
  });
  assert.equal(view.result.current.foldPositions.yellow, 0.65);
  assert.equal(view.result.current.rotationOffsetsDegrees.yellow, -7.3);
  assert.equal(view.result.current.storageError, true);
});

test('a failed write preserves edits and the next successful write persists all settings', t => {
  const view = renderHook(useMiNoteStarFolds);
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem', () => {
    throw new Error('Storage quota exceeded');
  });
  act(() => {
    view.result.current.setFoldPosition('yellow', 0.65);
    view.result.current.setRotationOffset('yellow', -7.3);
  });
  assert.equal(view.result.current.foldPositions.yellow, 0.65);
  assert.equal(view.result.current.rotationOffsetsDegrees.yellow, -7.3);
  assert.equal(view.result.current.storageError, true);
  assert.equal(storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY), null);
  setItem.mock.restore();
  act(() => {
    view.result.current.setFoldPosition('blush', 0.45);
    view.result.current.setRotationOffset('blush', 4.8);
  });
  assert.equal(view.result.current.storageError, false);
  assert.equal(view.result.current.foldPositions.yellow, 0.65);
  assert.equal(view.result.current.foldPositions.blush, 0.45);
  assert.equal(view.result.current.rotationOffsetsDegrees.yellow, -7.3);
  assert.equal(view.result.current.rotationOffsetsDegrees.blush, 4.8);
  assert.deepEqual(parseMiNoteStarFolds(storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY)), view.result.current.foldPositions);
  assert.deepEqual(parseMiNoteStarRotationOffsets(storage.getItem(MI_NOTE_STAR_FOLDS_STORAGE_KEY)), view.result.current.rotationOffsetsDegrees);
});
