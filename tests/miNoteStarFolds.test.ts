import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeMiNoteStarFoldPosition,
  normalizeMiNoteStarRotationOffset,
} from '../src/lib/miNoteStarFolds.ts';

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
