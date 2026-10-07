import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MI_NOTE_LEAF_WIDTH } from '../src/lib/miNotePackModel.ts';
import {
  getMiNotePackRenderSetupByPackId,
  restoreMiNotePackRenderCamera,
} from '../src/lib/miNotePackRenderSetup.ts';
import {
  MI_NOTE_PACK_SHOWCASE_CYCLE_SECONDS,
  MI_NOTE_PACK_SHOWCASE_ORDER,
  sampleMiNotePackShowcase,
} from '../src/lib/miNotePackShowcaseMotion.ts';

const CYCLE = MI_NOTE_PACK_SHOWCASE_CYCLE_SECONDS;
const TAU = Math.PI * 2;
const transformKeys = ['rotationX', 'rotationY', 'rotationZ', 'offsetY', 'scale'] as const;

function near(actual: number, expected: number, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

function angleDifference(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

test('showcase starts in the saved pose and clamps invalid elapsed time', () => {
  const initial = {
    packId: 1, nextPackId: 5,
    rotationX: 0, rotationY: 0, rotationZ: 0, offsetY: 0, scale: 1,
  };
  for (const time of [0, -1, -Number.MAX_VALUE, NaN, Infinity, -Infinity]) {
    assert.deepEqual(sampleMiNotePackShowcase(time), initial);
  }
});

test('the loop visits all nine packs with a brief hold and negative-yaw turns that settle gently', () => {
  assert.deepEqual(MI_NOTE_PACK_SHOWCASE_ORDER, [1, 5, 9, 4, 8, 3, 7, 2, 6]);
  assert.equal(CYCLE, 2.65);
  for (let cycle = 0; cycle < MI_NOTE_PACK_SHOWCASE_ORDER.length * 2; cycle++) {
    const index = cycle % MI_NOTE_PACK_SHOWCASE_ORDER.length;
    const hold = sampleMiNotePackShowcase(cycle * CYCLE + 0.225);
    assert.equal(hold.packId, MI_NOTE_PACK_SHOWCASE_ORDER[index]);
    assert.equal(hold.nextPackId, MI_NOTE_PACK_SHOWCASE_ORDER[(index + 1) % MI_NOTE_PACK_SHOWCASE_ORDER.length]);
    assert.equal(hold.rotationY, 0);
    near(sampleMiNotePackShowcase(cycle * CYCLE + 0.45).rotationY, 0);
    assert.ok(sampleMiNotePackShowcase(cycle * CYCLE + 1.55).rotationY < -Math.PI);
    const end = sampleMiNotePackShowcase((cycle + 1) * CYCLE - 1e-5);
    near(end.rotationY, -TAU);
    assert.equal(end.packId, hold.nextPackId);
  }
  const angularSpeed = (turnProgress: number) => {
    const time = 0.45 + 2.2 * turnProgress;
    const before = sampleMiNotePackShowcase(time - 1e-4).rotationY;
    const after = sampleMiNotePackShowcase(time + 1e-4).rotationY;
    return Math.abs(angleDifference(after, before)) / 2e-4;
  };
  assert.ok(angularSpeed(0.4) > angularSpeed(0.8) * 4);
  let previousYaw = 0;
  for (let step = 1; step <= CYCLE * 18 * 200; step++) {
    const yaw = sampleMiNotePackShowcase(step / 200).rotationY;
    assert.ok(angleDifference(yaw, previousYaw) <= 1e-9, `Yaw reverses at ${step / 200}s`);
    previousYaw = yaw;
  }
});

test('each pack changes once at the return edge with the saved yaw included', () => {
  for (const baseYaw of [-0.5, -0.12, 0, 0.4]) {
    for (const cycle of [0, 1]) {
      let previous = sampleMiNotePackShowcase(cycle * CYCLE, baseYaw);
      let changes = 0;
      for (let step = 1; step <= CYCLE * 2000; step++) {
        const pose = sampleMiNotePackShowcase(cycle * CYCLE + step / 2000, baseYaw);
        if (pose.packId !== previous.packId) {
          changes++;
          assert.equal(pose.packId, previous.nextPackId);
          near(baseYaw + pose.rotationY, -Math.PI * 1.5, 0.004);
          near(baseYaw + previous.rotationY, -Math.PI * 1.5, 0.004);
        }
        previous = pose;
      }
      assert.equal(changes, 1);
    }
  }
});

test('hold and turn motion remains gentle, bounded, and deterministic', () => {
  const hold = sampleMiNotePackShowcase(0.225);
  assert.ok(hold.offsetY > 0);
  assert.ok(hold.rotationX > 0);
  assert.equal(hold.scale, 1);
  for (let time = 0; time < CYCLE * 18; time += 0.02) {
    const pose = sampleMiNotePackShowcase(time);
    assert.deepEqual(sampleMiNotePackShowcase(time), pose);
    assert.ok(Math.abs(pose.rotationX) <= 0.065);
    assert.ok(pose.rotationY >= -TAU && pose.rotationY <= 0);
    assert.ok(Math.abs(pose.rotationZ) <= 0.033);
    assert.ok(pose.offsetY >= 0 && pose.offsetY <= 0.028);
    assert.ok(pose.scale >= 0.7995 && pose.scale <= 1);
  }
});

test('every pack remains inside the saved camera framing throughout successive turns', () => {
  const setup = getMiNotePackRenderSetupByPackId(1)!;
  const camera = new THREE.PerspectiveCamera();
  restoreMiNotePackRenderCamera(camera, setup);
  const baseRotation = setup.model.rotationDegrees.map(THREE.MathUtils.degToRad);
  const model = new THREE.Object3D();
  const projected = new THREE.Vector3();
  const corners = [-MI_NOTE_LEAF_WIDTH / 2, MI_NOTE_LEAF_WIDTH / 2].flatMap(x =>
    [-0.91, 0.91].flatMap(y => [0, 0.03].map(z => new THREE.Vector3(x, y, z))),
  );
  for (let step = 0; step <= CYCLE * 18 * 200; step++) {
    const time = step / 200;
    const pose = sampleMiNotePackShowcase(time, baseRotation[1]);
    model.rotation.set(
      baseRotation[0] + pose.rotationX,
      baseRotation[1] + pose.rotationY,
      baseRotation[2] + pose.rotationZ,
      setup.model.rotationOrder,
    );
    model.position.fromArray(setup.model.position);
    model.position.y += pose.offsetY;
    model.scale.fromArray(setup.model.scale).multiplyScalar(pose.scale);
    model.updateMatrixWorld(true);
    for (const corner of corners) {
      projected.copy(corner).applyMatrix4(model.matrixWorld).project(camera);
      assert.ok(Math.abs(projected.x) < 0.99 && Math.abs(projected.y) < 0.99,
        `Pack ${pose.packId} leaves framing at ${time}s: ${projected.x}, ${projected.y}`);
    }
  }
});

test('pose and velocity stay continuous at the hold, turn, and cycle boundaries', () => {
  const epsilon = 1e-4;
  for (let cycle = 0; cycle < 18; cycle++) {
    for (const boundary of [cycle * CYCLE + 0.45, (cycle + 1) * CYCLE]) {
      const before = sampleMiNotePackShowcase(boundary - epsilon);
      const middle = sampleMiNotePackShowcase(boundary);
      const after = sampleMiNotePackShowcase(boundary + epsilon);
      assert.equal(before.packId, middle.packId);
      assert.equal(after.packId, middle.packId);
      for (const key of transformKeys) {
        const difference = key === 'rotationY' ? angleDifference : (a: number, b: number) => a - b;
        near(difference(before[key], middle[key]), 0, 1e-7);
        near(difference(after[key], middle[key]), 0, 1e-7);
        near(difference(middle[key], before[key]) / epsilon, difference(after[key], middle[key]) / epsilon, 1e-5);
      }
    }
  }
});

test('large finite times and nonfinite base yaw keep every transform finite', () => {
  for (const time of [5, 1e6 + 5, 1e12 + 5, 1e20, Number.MAX_VALUE]) {
    for (const baseYaw of [-0.12, NaN, Infinity, Number.MAX_VALUE]) {
      const pose = sampleMiNotePackShowcase(time, baseYaw);
      assert.ok(MI_NOTE_PACK_SHOWCASE_ORDER.includes(pose.packId));
      assert.ok(MI_NOTE_PACK_SHOWCASE_ORDER.includes(pose.nextPackId));
      for (const key of transformKeys) assert.ok(Number.isFinite(pose[key]));
    }
  }
});
