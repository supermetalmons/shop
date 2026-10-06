import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MI_NOTE_PACK_STARS } from '../src/lib/miNotePackStars.ts';
import {
  normalizeMiNoteStarFoldPosition,
  normalizeMiNoteStarRotationOffset,
  normalizeMiNoteStarSizeScale,
  normalizeMiNoteStarVerticalPosition,
} from '../src/lib/miNoteStarFolds.ts';

test('the picker contains the three shortlisted stars with Blush and Zombie first', () => {
  assert.deepEqual(MI_NOTE_PACK_STARS.map(star => star.id), [
    'blush', 'zombie', 'supermetal',
  ]);
  for (const star of MI_NOTE_PACK_STARS) assert.ok(existsSync(fileURLToPath(star.src)), star.name);
  assert.deepEqual(MI_NOTE_PACK_STARS.map(star => [star.foldPosition, star.rotationOffsetDegrees, star.sizeScale]), [
    [0.574, 2.8, 1.13], [0.513, 2.4, 1.22], [0.58, 5.1, 1.18],
  ]);
});

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
