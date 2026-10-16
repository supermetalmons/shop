import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { computeRecordingFrameStyle, computeRecordingMotionPose, RECORDING_MOTION_LOOPS, RECORDING_MOTIONS, type RecordingMotionLoop } from '../motion.ts';

const FRAME_COUNT = 276;
const variables = (style: string): Record<string, string> => Object.fromEntries(style.split(';').map(value => value.split(':')));

test('only the three approved motions are available', () => {
  assert.deepEqual(RECORDING_MOTIONS, ['original', 'vertical-swing', 'breathing-swing']);
  assert.deepEqual(RECORDING_MOTION_LOOPS.map(value => value.id), ['vertical-swing', 'breathing-swing']);
});

test('every approved frame style remains byte-identical to the previous approved renderer', () => {
  const fixtures = [
    [undefined, '610a4edb08e14e1609607831585b9b630ab4bdd4bd13936087bc729613d3f033'],
    ['vertical-swing', 'af506eabbf78804946bcf802512882dc18bf8268f9938dcf4868a1c1a4062536'],
    ['breathing-swing', 'cb41b32623906bba4124f8e7d3e13268f693bc7813797ad493f9f8dcc3ec6737'],
  ] as const;
  for (const [motionLoop, expected] of fixtures) {
    const value = Array.from({ length: FRAME_COUNT }, (_, frame) => computeRecordingFrameStyle(frame, FRAME_COUNT, { effectOpacity: .99, tilt: true, motionLoop })).join('\n');
    assert.equal(createHash('sha256').update(value).digest('hex'), expected);
  }
});

test('default orbit preserves the previous cardinal poses and three-decimal rotation rounding', () => {
  const poses = [
    { index: 0, x: '72%', y: '50%', bgX: '55.72%', bgY: '50%', rotateX: '-6.286deg', rotateY: '0deg', center: '0.44' },
    { index: 69, x: '50%', y: '66%', bgX: '50%', bgY: '55.44%', rotateX: '0deg', rotateY: '8deg', center: '0.32' },
    { index: 138, x: '28%', y: '50%', bgX: '44.28%', bgY: '50%', rotateX: '6.286deg', rotateY: '0deg', center: '0.44' },
    { index: 207, x: '50%', y: '34%', bgX: '50%', bgY: '44.56%', rotateX: '0deg', rotateY: '-8deg', center: '0.32' },
  ];
  for (const pose of poses) {
    const style = variables(computeRecordingFrameStyle(pose.index, FRAME_COUNT));
    assert.equal(style['--pointer-x'], pose.x);
    assert.equal(style['--pointer-y'], pose.y);
    assert.equal(style['--background-x'], pose.bgX);
    assert.equal(style['--background-y'], pose.bgY);
    assert.equal(style['--rotate-x'], pose.rotateX);
    assert.equal(style['--rotate-y'], pose.rotateY);
    assert.equal(style['--pointer-from-center'], pose.center);
    assert.equal(style['--card-opacity'], '1');
  }
});

function motionAtPhase(phase: number, motionLoop: RecordingMotionLoop) {
  return computeRecordingMotionPose(phase, 1, motionLoop);
}

test('every motion loop closes with matching position, velocity, and acceleration', () => {
  const h = 1e-4;
  for (const { id } of RECORDING_MOTION_LOOPS) {
    assert.deepEqual(motionAtPhase(0, id), motionAtPhase(1, id));
    assert.deepEqual(motionAtPhase(0, id), motionAtPhase(-1, id));
    for (const coordinate of ['normalizedX', 'normalizedY'] as const) {
      const value = (phase: number) => motionAtPhase(phase, id)[coordinate];
      const startVelocity = (-3 * value(0) + 4 * value(h) - value(2 * h)) / (2 * h);
      const endVelocity = (3 * value(1) - 4 * value(1 - h) + value(1 - 2 * h)) / (2 * h);
      const startAcceleration = (2 * value(0) - 5 * value(h) + 4 * value(2 * h) - value(3 * h)) / h ** 2;
      const endAcceleration = (2 * value(1) - 5 * value(1 - h) + 4 * value(1 - 2 * h) - value(1 - 3 * h)) / h ** 2;
      assert.ok(Math.abs(startVelocity - endVelocity) < 1e-6, `${id} velocity discontinuity on ${coordinate}`);
      assert.ok(Math.abs(startAcceleration - endAcceleration) < 1e-4, `${id} acceleration discontinuity on ${coordinate}`);
    }
    assert.equal(computeRecordingFrameStyle(FRAME_COUNT, FRAME_COUNT, { motionLoop: id }), computeRecordingFrameStyle(0, FRAME_COUNT, { motionLoop: id }));
    assert.notEqual(computeRecordingFrameStyle(FRAME_COUNT - 1, FRAME_COUNT, { motionLoop: id }), computeRecordingFrameStyle(0, FRAME_COUNT, { motionLoop: id }));
  }
});

test('dense motion samples stay inside the existing tilt ellipse with smooth, active, restrained movement', () => {
  const samples = 4096;
  const h = 1e-5;
  const seconds = FRAME_COUNT / 60;
  for (const { id } of RECORDING_MOTION_LOOPS) {
    let maximumRadius = 0;
    let minimumSpeed = Infinity;
    let maximumSpeed = 0;
    let maximumAcceleration = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      const phase = sample / samples;
      const previous = motionAtPhase(phase - h, id);
      const pose = motionAtPhase(phase, id);
      const next = motionAtPhase(phase + h, id);
      const speed = Math.hypot(next.normalizedX - previous.normalizedX, next.normalizedY - previous.normalizedY) / (2 * h * seconds);
      const acceleration = Math.hypot(
        next.normalizedX - 2 * pose.normalizedX + previous.normalizedX,
        next.normalizedY - 2 * pose.normalizedY + previous.normalizedY,
      ) / (h * seconds) ** 2;
      maximumRadius = Math.max(maximumRadius, Math.hypot(pose.normalizedX, pose.normalizedY));
      minimumSpeed = Math.min(minimumSpeed, speed);
      maximumSpeed = Math.max(maximumSpeed, speed);
      maximumAcceleration = Math.max(maximumAcceleration, acceleration);
      assert.ok(Math.abs(pose.rotateX) <= 22 / 3.5);
      assert.ok(Math.abs(pose.rotateY) <= 8);
    }
    assert.ok(maximumRadius <= 0.96, `${id} exceeds the previous motion envelope`);
    assert.ok(maximumRadius >= 0.75, `${id} is too restrained to show the foil`);
    assert.ok(minimumSpeed > 0.04, `${id} stops moving`);
    assert.ok(maximumSpeed < 1.9, `${id} moves too quickly`);
    assert.ok(maximumAcceleration < 4, `${id} accelerates too abruptly`);
  }
});

test('rendered loop frames preserve the envelope, light coupling, fixed placement, and seamless wrap', () => {
  for (const { id } of RECORDING_MOTION_LOOPS) {
    let maximumStep = 0;
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      const style = variables(computeRecordingFrameStyle(frame, FRAME_COUNT, { motionLoop: id, effectOpacity: 0.99 }));
      const still = variables(computeRecordingFrameStyle(frame, FRAME_COUNT, { motionLoop: id, effectOpacity: 0.99, tilt: false }));
      const next = variables(computeRecordingFrameStyle(frame + 1, FRAME_COUNT, { motionLoop: id }));
      const x = Number.parseFloat(style['--pointer-x']) - 50;
      const y = Number.parseFloat(style['--pointer-y']) - 50;
      maximumStep = Math.max(maximumStep, Math.hypot((Number.parseFloat(next['--pointer-x']) - 50 - x) / 22, (Number.parseFloat(next['--pointer-y']) - 50 - y) / 16));
      assert.ok(Math.hypot(x / 22, y / 16) <= 0.9601);
      assert.ok(Math.abs(Number.parseFloat(style['--rotate-x']) + x / 3.5) <= 0.000501);
      assert.ok(Math.abs(Number.parseFloat(style['--rotate-y']) - y / 2) <= 0.000501);
      assert.equal(style['--card-opacity'], '0.99');
      assert.equal(style['--rotate-delta'], '0deg');
      assert.equal(style['--card-scale'], '1');
      assert.equal(style['--translate-x'], '0px');
      assert.equal(style['--translate-y'], '0px');
      assert.deepEqual(still, { ...style, '--rotate-x': '0deg', '--rotate-y': '0deg' });
    }
    assert.ok(maximumStep < 0.032, `${id} jumps between rendered frames`);
  }
});

test('motion pose rejects invalid frame coordinates', () => {
  for (const [frame, total] of [[0, 0], [0, -1], [Infinity, FRAME_COUNT], [NaN, FRAME_COUNT], [0, Infinity]]) {
    assert.throws(() => computeRecordingMotionPose(frame, total, 'vertical-swing'), RangeError);
  }
});
