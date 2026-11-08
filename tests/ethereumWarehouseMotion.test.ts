import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import { createCrateSprites, CRATE_SPRITE_BOUNDS } from '../src/ethereum/warehouse/crateSprites.ts';
import { createWarehouseCrateLayout, sampleWarehouseCrate, warehouseFracture, warehouseRenderDensity,
  WAREHOUSE_CRITICAL_CONTACT_MS, WAREHOUSE_CRATE_RELEASE_MS,
  WAREHOUSE_CRATE_TRAVEL_MS, WAREHOUSE_OPEN_DURATION_MS } from '../src/ethereum/warehouse/warehouseMotion.ts';
import { WAREHOUSE_BOUNDS } from '../src/ethereum/warehouse/warehouseModel.ts';

const bounds = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(),
  new THREE.Vector3(CRATE_SPRITE_BOUNDS.width, CRATE_SPRITE_BOUNDS.height, CRATE_SPRITE_BOUNDS.depth));

test('eleven crates start inside the shell and land on the floor or an authored support', () => {
  const poses = createWarehouseCrateLayout(bounds);
  const object = new THREE.Object3D();
  const interior = new THREE.Box3(new THREE.Vector3(-WAREHOUSE_BOUNDS.width / 2 + 0.12,
    -WAREHOUSE_BOUNDS.height / 2 + 0.12, -WAREHOUSE_BOUNDS.depth / 2 + 0.12),
  new THREE.Vector3(WAREHOUSE_BOUNDS.width / 2 - 0.12, WAREHOUSE_BOUNDS.height / 2 - 1.1, WAREHOUSE_BOUNDS.depth / 2 - 0.12));
  assert.equal(poses.length, 11);
  assert.equal(poses.filter(pose => pose.support === null).length, 8);
  const finalBounds: THREE.Box3[] = [];
  poses.forEach((pose, index) => {
    sampleWarehouseCrate(pose, index, 0, false, object);
    assert.ok(interior.containsBox(bounds.clone().applyMatrix4(object.matrix)), `Crate ${index} must start inside the shell.`);
    sampleWarehouseCrate(pose, index, WAREHOUSE_OPEN_DURATION_MS, false, object);
    const landed = bounds.clone().applyMatrix4(object.matrix);
    if (pose.support === null) assert.ok(Math.abs(landed.min.y + WAREHOUSE_BOUNDS.height / 2) < 1e-6);
    else {
      assert.ok(Math.abs(landed.min.y - finalBounds[pose.support].max.y) < 1e-6);
      assert.equal(pose.yaw, poses[pose.support].yaw);
      assert.equal(pose.target.x, poses[pose.support].target.x);
      assert.equal(pose.target.z, poses[pose.support].target.z);
    }
    finalBounds.push(landed);
  });
});

test('authored ground crates do not intersect despite their varied yaw', () => {
  const poses = createWarehouseCrateLayout(bounds).slice(0, 8);
  const size = bounds.getSize(new THREE.Vector3());
  const axes = (yaw: number) => [new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw)), new THREE.Vector2(Math.sin(yaw), Math.cos(yaw))];
  for (let left = 0; left < poses.length; left++) for (let right = left + 1; right < poses.length; right++) {
    const a = poses[left];
    const b = poses[right];
    const aAxes = axes(a.yaw);
    const bAxes = axes(b.yaw);
    const distance = new THREE.Vector2(a.target.x - b.target.x, a.target.z - b.target.z);
    const separated = [...aAxes, ...bAxes].some(axis => {
      const aRadius = (Math.abs(axis.dot(aAxes[0])) * size.x + Math.abs(axis.dot(aAxes[1])) * size.z) * a.scale / 2;
      const bRadius = (Math.abs(axis.dot(bAxes[0])) * size.x + Math.abs(axis.dot(bAxes[1])) * size.z) * b.scale / 2;
      return Math.abs(distance.dot(axis)) >= aRadius + bRadius;
    });
    assert.ok(separated, `Ground crates ${left} and ${right} must not intersect.`);
  }
});

test('all sprite layout footprints remain separated throughout the burst', t => {
  const instances = createCrateSprites(11, { image: { width: 512, height: 384 } as HTMLCanvasElement, width: 1448, height: 1086 });
  t.after(() => instances.dispose());
  const bounds = instances.bounds;
  const localCenter = bounds.getCenter(new THREE.Vector3());
  const poses = createWarehouseCrateLayout(bounds);
  const objects = poses.map(() => new THREE.Object3D());
  const boxes = poses.map(() => new OBB());
  for (let elapsed = 0; elapsed <= WAREHOUSE_OPEN_DURATION_MS; elapsed += 5) {
    poses.forEach((pose, index) => {
      sampleWarehouseCrate(pose, index, elapsed, false, objects[index]);
      boxes[index].fromBox3(bounds).applyMatrix4(objects[index].matrix);
      boxes[index].center.copy(localCenter).applyMatrix4(objects[index].matrix);
      boxes[index].halfSize.multiplyScalar(1 - 1e-6);
    });
    for (let left = 0; left < poses.length; left++) for (let right = left + 1; right < poses.length; right++) {
      assert.equal(boxes[left].intersectsOBB(boxes[right], 1e-10), false,
        `Crates ${left} and ${right} penetrate each other at ${elapsed}ms.`);
    }
  }
});

test('supported crates land after their bases have finished bouncing', () => {
  const poses = createWarehouseCrateLayout(bounds);
  const object = new THREE.Object3D();
  const settled = WAREHOUSE_CRATE_RELEASE_MS + WAREHOUSE_CRATE_TRAVEL_MS * 0.9;
  poses.forEach((pose, index) => {
    sampleWarehouseCrate(pose, index, settled, false, object);
    if (pose.support === null) assert.ok(object.position.distanceTo(pose.target) < 1e-6);
    else assert.ok(object.position.y > pose.target.y + 0.4, `Upper crate ${index} must still be descending.`);
    sampleWarehouseCrate(pose, index, WAREHOUSE_OPEN_DURATION_MS, false, object);
    assert.deepEqual(object.position.toArray(), pose.target.toArray());
  });
});

test('contact precedes fracture and crates stay inside until the shell clears', () => {
  assert.equal(warehouseFracture(WAREHOUSE_CRITICAL_CONTACT_MS), 0);
  assert.ok(warehouseFracture(WAREHOUSE_CRATE_RELEASE_MS) > 0.75);
  const poses = createWarehouseCrateLayout(bounds);
  const object = new THREE.Object3D();
  poses.forEach((pose, index) => {
    sampleWarehouseCrate(pose, index, WAREHOUSE_CRATE_RELEASE_MS, false, object);
    assert.deepEqual(object.position.toArray(), pose.start.toArray());
    for (let elapsed = 0; elapsed <= WAREHOUSE_OPEN_DURATION_MS; elapsed += 25) {
      sampleWarehouseCrate(pose, index, elapsed, false, object);
      assert.ok(object.matrix.elements.every(Number.isFinite));
      assert.ok(object.position.y >= -WAREHOUSE_BOUNDS.height / 2 - bounds.min.y * pose.scale - 1e-6);
      const transformed = bounds.clone().applyMatrix4(object.matrix);
      assert.ok(transformed.min.y >= -WAREHOUSE_BOUNDS.height / 2 - 1e-6, `Crate ${index} penetrates the floor at ${elapsed}ms.`);
      if (elapsed >= pose.releaseAtMs + WAREHOUSE_CRATE_TRAVEL_MS * 0.8) {
        assert.ok(transformed.min.y >= pose.target.y + bounds.min.y * pose.scale - 1e-6,
          `Crate ${index} penetrates its landing support at ${elapsed}ms.`);
        if (pose.support !== null) {
          const supportObject = new THREE.Object3D();
          sampleWarehouseCrate(poses[pose.support], pose.support, elapsed, false, supportObject);
          assert.ok(transformed.min.y >= bounds.clone().applyMatrix4(supportObject.matrix).max.y - 1e-6,
            `Crate ${index} lands before its support settles at ${elapsed}ms.`);
        }
      }
    }
    sampleWarehouseCrate(pose, index, WAREHOUSE_OPEN_DURATION_MS, false, object);
    const landed = object.matrix.clone();
    sampleWarehouseCrate(pose, index, WAREHOUSE_OPEN_DURATION_MS * 2, false, object);
    assert.deepEqual(object.matrix.elements, landed.elements);
    sampleWarehouseCrate(pose, index, 0, true, object);
    assert.deepEqual(object.matrix.elements, landed.elements);
  });
});

test('warehouse density keeps high-DPI and large viewports within the pixel budget', () => {
  for (const [width, height] of [[320, 568], [844, 390], [1440, 900], [5120, 2880]]) {
    for (const ratio of [1, 1.5, 2, 3, 4]) {
      const density = warehouseRenderDensity(width, height, ratio);
      assert.ok(density > 0 && density <= 2 && density <= ratio);
      assert.ok(width * height * density ** 2 <= 3_000_000.001);
    }
  }
});
