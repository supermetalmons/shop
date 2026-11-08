import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { createCrateModel, CRATE_BOUNDS, CRATE_CAMERA, CRATE_IMAGE_ASPECT } from '../src/ethereum/crate/crateModel.ts';

function installImage(t: TestContext, decode: () => Promise<void> = () => Promise.resolve()) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  class TestImage {
    decoding = '';
    naturalWidth = 1448;
    naturalHeight = 1086;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decode = decode;
    set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: TestImage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Image', original);
    else Reflect.deleteProperty(globalThis, 'Image');
  });
}

test('crate has a real hand-hole, hollow interior and independently opening lid within the geometry budget', async t => {
  installImage(t);
  const model = await createCrateModel();
  model.root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(-3, 0.51, -0.08), new THREE.Vector3(1, 0, 0));
  const handleHit = ray.intersectObjects(model.hitMeshes)[0];
  assert.ok(handleHit);
  assert.ok(handleHit.point.x > 1, 'the handle passes through the side wall into the hollow crate');
  ray.set(new THREE.Vector3(-3, 0, 0), new THREE.Vector3(1, 0, 0));
  assert.ok(ray.intersectObjects(model.hitMeshes)[0].point.x < -1.5);
  ray.set(new THREE.Vector3(0, 4, 0.07), new THREE.Vector3(0, -1, 0));
  assert.ok(ray.intersectObjects(model.hitMeshes)[0].point.y > 0.9);
  model.setOpening(1);
  model.root.updateMatrixWorld(true);
  assert.ok(ray.intersectObjects(model.hitMeshes)[0].point.y < -0.8, 'lifting the lid exposes the bottom of the crate');
  assert.ok(model.lid.rotation.x < -Math.PI / 2, 'the lid tips away and settles behind the crate');
  let triangles = 0;
  model.root.traverse(object => {
    if (object instanceof THREE.Mesh) triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
  });
  assert.ok(triangles < 15_000);
  assert.ok(model.hitMeshes.length < 12);
  model.dispose();
});

test('photographic coordinates reproduce the reference camera projection on the body and movable lid', async t => {
  installImage(t);
  const model = await createCrateModel();
  const camera = new THREE.PerspectiveCamera(CRATE_CAMERA.fov, CRATE_IMAGE_ASPECT, 0.1, 60);
  camera.position.set(...CRATE_CAMERA.position);
  camera.lookAt(...CRATE_CAMERA.target);
  camera.updateMatrixWorld(true);
  model.root.updateMatrixWorld(true);
  const position = new THREE.Vector3();
  let checked = 0;
  for (const mesh of model.hitMeshes) {
    if (!(mesh.material instanceof THREE.MeshBasicMaterial)) continue;
    const vertices = mesh.geometry.getAttribute('position');
    const coordinates = mesh.geometry.getAttribute('photoUv');
    for (let index = 0; index < vertices.count; index += 1) {
      position.fromBufferAttribute(vertices, index).applyMatrix4(mesh.matrixWorld).project(camera);
      const depth = coordinates.getZ(index);
      assert.ok(Math.abs(coordinates.getX(index) / depth - (position.x + 1) / 2) < 0.000001);
      assert.ok(Math.abs(coordinates.getY(index) / depth - (position.y + 1) / 2) < 0.000001);
      checked += 1;
    }
  }
  assert.ok(checked > 100);
  model.dispose();
});

test('localized hits remain bounded, reset cleanly and fade without recompiling materials', async t => {
  installImage(t);
  const model = await createCrateModel();
  const texture = (model.hitMeshes[0].material as THREE.MeshBasicMaterial).map!;
  let released = 0;
  texture.addEventListener('dispose', () => { released += 1; });
  const front = model.root.getObjectByName('111k-front-panel')!;
  const left = model.root.getObjectByName('111k-left-panel')!;
  model.setDamage(1, new THREE.Vector3(0.3, 0.1, CRATE_BOUNDS.depth / 2));
  model.setRecoil(0.3, 0.1, 1);
  assert.ok(front.position.z < CRATE_BOUNDS.depth / 2);
  assert.equal(left.position.x, -CRATE_BOUNDS.width / 2);
  model.setRecoil(0, 0, 0);
  assert.equal(front.position.z, CRATE_BOUNDS.depth / 2);
  model.setDamage(10_000);
  const splits: THREE.Object3D[] = [];
  model.root.traverse(object => { if (object.name.startsWith('wood-split-')) splits.push(object); });
  assert.equal(splits.length, 4);
  const materials = new Set(model.hitMeshes.map(mesh => mesh.material as THREE.Material));
  const versions = [...materials].map(material => material.version);
  model.setOpacity(0.3);
  assert.deepEqual([...materials].map(material => material.version), versions);
  assert.ok([...materials].every(material => material.transparent && material.opacity === 0.3));
  model.setDamage(0);
  assert.ok(splits.every(split => split.parent === null));
  model.dispose();
  model.dispose();
  assert.equal(released, 1);
  assert.equal(model.root.children.length, 0);
});

test('aborting during image decode rejects the model without accepting late readiness', async t => {
  let finishDecode!: () => void;
  installImage(t, () => new Promise(resolve => { finishDecode = resolve; }));
  const controller = new AbortController();
  const model = createCrateModel({ signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(model, { name: 'AbortError' });
  finishDecode();
  await Promise.resolve();
  await assert.rejects(createCrateModel({ signal: controller.signal }), { name: 'AbortError' });
});
