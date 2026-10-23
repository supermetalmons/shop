import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector2 } from 'three';
import { setMiNoteCardTiltTarget, stepMiNoteMotion } from '../src/lib/miNoteCardTilt.ts';

test('shared motion preserves original MiNote spring values and settling decisions', () => {
  const fixtures: {
    input: [value: number, velocity: number, target: number, frequency: number, dt: number];
    expected: [value: number, velocity: number, active: boolean];
  }[] = [
    { input: [0, 0, 0.24, 3, 1 / 60], expected: [0.00029018502582006667, 0.03424425928202571, true] },
    { input: [0.15, -0.4, -0.3, 10, 1 / 60], expected: [0.13875969406830158, -0.9170218686314986, true] },
    { input: [-0.3, 1.2, 0.24, 16, 1 / 120], expected: [-0.2868543380638545, 1.918379915342141, true] },
    { input: [0.24, -2.5, 0, 40, 0.05], expected: [0.08052449352578456, -2.2600992300514324, true] },
    { input: [0.15, -0.4, -0.3, 10, 0], expected: [0.14999999999999997, -0.4, true] },
    { input: [-0.3, 1.2, 0.24, 16, 0.25], expected: [0.19604246666703795, 0.5670521799952102, true] },
    { input: [0.24, 0, 0.24, 16, 1 / 60], expected: [0.24, 0, false] },
    { input: [0.24001, 0.0001, 0.24, 16, 1 / 60], expected: [0.24, 0, false] },
    { input: [0.24001, 0.1, 0.24, 16, 1 / 60], expected: [0.24128624898956036, 0.05613539853763732, true] },
  ];
  for (const { input: [value, velocity, target, frequency, dt], expected } of fixtures) {
    const motion = { value, velocity };
    const active = stepMiNoteMotion(motion, target, frequency, dt, false);
    assert.deepEqual([motion.value, motion.velocity, active], expected);
  }
});

test('reduced motion immediately settles the existing MiNote spring frequencies', () => {
  for (const frequency of [3, 10, 16, 40]) {
    for (const target of [-0.3, 0, 0.24]) {
      const motion = { value: 0.15, velocity: -0.4 };
      assert.equal(stepMiNoteMotion(motion, target, frequency, 1 / 60, true), false);
      assert.deepEqual(motion, { value: target, velocity: 0 });
    }
  }
});

test('shared tilt keeps MiNote pitch, yaw, and inclusive hover bounds', () => {
  const target = new Vector2();
  const fixtures = [
    { x: 0, y: 0, expected: [-0, -0] },
    { x: 0.5, y: -0.5, expected: [0.12, -0.15] },
    { x: -1, y: 1, expected: [-0.24, 0.3] },
    { x: 1, y: -1, expected: [0.24, -0.3] },
  ];
  for (const { x, y, expected } of fixtures) {
    for (const dragging of [false, true]) {
      setMiNoteCardTiltTarget(target, x, y, dragging);
      assert.deepEqual(target.toArray(), expected);
    }
  }
});

test('hover outside either edge resets tilt while dragging clamps each axis', () => {
  const target = new Vector2();
  for (const [x, y] of [[1.001, 0.5], [-1.001, 0.5], [0.5, 1.001], [0.5, -1.001]]) {
    target.set(0.12, -0.15);
    setMiNoteCardTiltTarget(target, x, y, false);
    assert.deepEqual(target.toArray(), [0, 0]);
  }
  setMiNoteCardTiltTarget(target, 2, -4, true);
  assert.deepEqual(target.toArray(), [0.24, -0.3]);
  setMiNoteCardTiltTarget(target, -2, 0.5, true);
  assert.deepEqual(target.toArray(), [-0.12, 0.3]);
});
