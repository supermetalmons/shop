import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion, Vector3 } from 'three';
import {
  createSnapBackState,
  releaseSnapBack,
  resetSnapBackTracking,
  settleSnapBackInstantly,
  stepSnapBackSpring,
  trackSnapBackVelocity,
  SNAP_BACK_FLING_STALE_MS,
  SNAP_BACK_MAX_ANGULAR_SPEED,
} from '../src/lib/clearCardSnapBack.ts';

const STEP_SECONDS = 1 / 60;
const MAX_STEPS = 600;

function quaternionAngle(quaternion: Quaternion) {
  const sinHalfAngle = Math.sqrt(
    quaternion.x * quaternion.x + quaternion.y * quaternion.y + quaternion.z * quaternion.z,
  );
  return 2 * Math.atan2(sinHalfAngle, Math.abs(quaternion.w));
}

function runUntilSettled(quaternion: Quaternion, state: ReturnType<typeof createSnapBackState>) {
  let steps = 0;
  while (state.active && steps < MAX_STEPS) {
    stepSnapBackSpring(quaternion, state, STEP_SECONDS);
    steps += 1;
  }
  return steps;
}

test('stepSnapBackSpring converges to exact identity from a large rotation with velocity', () => {
  const state = createSnapBackState();
  const quaternion = new Quaternion().setFromAxisAngle(
    new Vector3(1, 2, -1).normalize(),
    Math.PI / 2,
  );
  state.velocity.set(3, -2, 1);
  state.active = true;

  const steps = runUntilSettled(quaternion, state);

  assert.equal(state.active, false);
  assert.ok(steps < MAX_STEPS, `expected to settle, still active after ${steps} steps`);
  assert.equal(quaternion.w, 1);
  assert.equal(quaternion.x, 0);
  assert.equal(quaternion.y, 0);
  assert.equal(quaternion.z, 0);
  assert.equal(state.velocity.length(), 0);
});

test('stepSnapBackSpring overshoots past identity before settling (bouncy)', () => {
  const state = createSnapBackState();
  const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
  state.active = true;

  let overshot = false;
  let steps = 0;
  while (state.active && steps < MAX_STEPS) {
    stepSnapBackSpring(quaternion, state, STEP_SECONDS);
    // Started at +60° about Y; a sign flip of the Y component means the spring
    // carried the card past identity.
    if (quaternion.y < -1e-4) overshot = true;
    steps += 1;
  }

  assert.equal(state.active, false);
  assert.ok(overshot, 'expected at least one overshoot past identity');
});

test('stepSnapBackSpring takes the short way home from a double-cover quaternion', () => {
  const state = createSnapBackState();
  const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 9);
  quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
  state.active = true;

  let maxAngle = 0;
  let steps = 0;
  while (state.active && steps < MAX_STEPS) {
    stepSnapBackSpring(quaternion, state, STEP_SECONDS);
    maxAngle = Math.max(maxAngle, quaternionAngle(quaternion));
    steps += 1;
  }

  assert.equal(state.active, false);
  assert.ok(
    maxAngle < Math.PI / 2,
    `expected the 20° rotation to unwind directly, saw ${((maxAngle * 180) / Math.PI).toFixed(1)}°`,
  );
});

test('releaseSnapBack keeps fresh velocity, clamps huge flings, discards stale ones', () => {
  const state = createSnapBackState();

  state.velocity.set(0, 4, 0);
  state.lastSampleTimeMs = 1_000;
  releaseSnapBack(state, 1_000 + SNAP_BACK_FLING_STALE_MS - 1);
  assert.equal(state.active, true);
  assert.equal(state.velocity.y, 4);

  state.velocity.set(0, 400, 0);
  state.lastSampleTimeMs = 2_000;
  releaseSnapBack(state, 2_000);
  assert.equal(state.velocity.length(), SNAP_BACK_MAX_ANGULAR_SPEED);

  state.velocity.set(0, 4, 0);
  state.lastSampleTimeMs = 3_000;
  releaseSnapBack(state, 3_000 + SNAP_BACK_FLING_STALE_MS + 1);
  assert.equal(state.velocity.length(), 0);
});

test('trackSnapBackVelocity ignores non-positive time deltas and follows samples', () => {
  const state = createSnapBackState();
  resetSnapBackTracking(state, 1_000);

  trackSnapBackVelocity(state, 10, 5, 0.01, 1_000);
  assert.equal(state.velocity.length(), 0);
  trackSnapBackVelocity(state, 10, 5, 0.01, 990);
  assert.equal(state.velocity.length(), 0);

  trackSnapBackVelocity(state, 10, 5, 0.01, 1_016);
  assert.ok(state.velocity.y > 0, 'horizontal drag contributes yaw velocity');
  assert.ok(state.velocity.x > 0, 'vertical drag contributes pitch velocity');
  const speedAfterOne = state.velocity.length();

  trackSnapBackVelocity(state, 10, 5, 0.01, 1_032);
  assert.ok(
    state.velocity.length() > speedAfterOne,
    'repeated samples move the EMA toward the instantaneous velocity',
  );
});

test('settleSnapBackInstantly returns to identity and deactivates', () => {
  const state = createSnapBackState();
  const quaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1);
  state.active = true;
  state.velocity.set(1, 2, 3);

  settleSnapBackInstantly(quaternion, state);

  assert.equal(state.active, false);
  assert.equal(quaternion.w, 1);
  assert.equal(state.velocity.length(), 0);
});
