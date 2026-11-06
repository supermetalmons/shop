import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { createWarehouseModel, WAREHOUSE_BOUNDS, WAREHOUSE_CAMERA, WAREHOUSE_IMAGE_ASPECT } from '../src/ethereum/warehouse/warehouseModel.ts';
import { createCrateSprites, CRATE_SPRITE_BOUNDS } from '../src/ethereum/warehouse/crateSprites.ts';

function installImage(t: TestContext, decode: () => Promise<void> = () => Promise.resolve()) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const requests: string[] = [];
  class TestImage {
    decoding = '';
    naturalWidth = 1254;
    naturalHeight = 1104;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decode = decode;
    set src(value: string) { if (value) { requests.push(value); queueMicrotask(() => this.onload?.()); } }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: TestImage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'Image', original);
    else Reflect.deleteProperty(globalThis, 'Image');
  });
  return requests;
}

test('warehouse is a bounded hollow shell with a floor and calibrated projected exterior', async t => {
  const requests = installImage(t);
  const model = await createWarehouseModel();
  assert.deepEqual(requests, ['/111k/warehouse-reference.webp']);
  assert.ok(model.hitMeshes.length <= 24);
  const camera = new THREE.PerspectiveCamera(WAREHOUSE_CAMERA.fov, WAREHOUSE_IMAGE_ASPECT, 0.1, 100);
  camera.position.fromArray(WAREHOUSE_CAMERA.position);
  camera.lookAt(...WAREHOUSE_CAMERA.target);
  camera.updateMatrixWorld(true);
  model.root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model.root);
  assert.ok(Math.abs(bounds.min.y + WAREHOUSE_BOUNDS.height / 2) < 1e-6);
  assert.ok(Math.abs(bounds.max.x - WAREHOUSE_BOUNDS.width / 2) < 1e-6);
  assert.ok(Math.abs(bounds.max.z - WAREHOUSE_BOUNDS.depth / 2) < 1e-6);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0));
  const floor = ray.intersectObjects(model.hitMeshes)[0];
  assert.ok(floor);
  assert.ok(floor.point.y < -3.8, 'The interior remains empty down to the floor.');
  let triangles = 0;
  const point = new THREE.Vector3();
  for (const mesh of model.hitMeshes) {
    const positions = mesh.geometry.getAttribute('position');
    const coordinates = mesh.geometry.getAttribute('photoUv');
    triangles += mesh.geometry.index!.count / 3;
    for (let index = 0; index < positions.count; index++) {
      point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld).project(camera);
      assert.ok(Math.abs(coordinates.getX(index) / coordinates.getZ(index) - (point.x + 1) / 2) < 1e-6);
      assert.ok(Math.abs(coordinates.getY(index) / coordinates.getZ(index) - (point.y + 1) / 2) < 1e-6);
    }
  }
  assert.ok(triangles <= 300);
  model.dispose();
});

test('fracture is deterministic, finite, reversible and fully disposes its shared resources', async t => {
  installImage(t);
  const model = await createWarehouseModel();
  const materials = new Set(model.hitMeshes.map(mesh => mesh.material as THREE.MeshLambertMaterial));
  assert.equal(materials.size, 1);
  const material = [...materials][0];
  let texturesDisposed = 0;
  let materialsDisposed = 0;
  let geometriesDisposed = 0;
  material.map!.addEventListener('dispose', () => texturesDisposed++);
  material.addEventListener('dispose', () => materialsDisposed++);
  model.hitMeshes.forEach(mesh => mesh.geometry.addEventListener('dispose', () => geometriesDisposed++));
  const count = model.hitMeshes.length;
  const snapshot = () => { model.root.updateMatrixWorld(true); return model.hitMeshes.map(mesh => mesh.matrixWorld.elements.slice()); };
  const closed = snapshot();
  model.setDamage(1000, new THREE.Vector3(0.5, 0.3, 4));
  model.setFracture(0.55);
  const broken = snapshot();
  assert.notDeepEqual(broken, closed);
  assert.ok(broken.flat().every(Number.isFinite));
  model.setFracture(0);
  assert.deepEqual(snapshot(), closed);
  model.setFracture(0.55);
  assert.deepEqual(snapshot(), broken);
  model.setFracture(1);
  assert.equal(model.root.visible, false);
  model.setFracture(0);
  model.setOpacity(0);
  assert.equal(model.root.visible, false);
  model.setOpacity(0.5);
  assert.equal(material.opacity, 0.5);
  model.setRecoil(Number.NaN, Infinity, Number.NaN);
  model.setFracture(Number.NaN);
  assert.ok(snapshot().flat().every(Number.isFinite));
  model.dispose();
  model.dispose();
  assert.equal(texturesDisposed, 1);
  assert.equal(materialsDisposed, 1);
  assert.equal(geometriesDisposed, count);
  assert.equal(model.root.children.length, 0);
});

function cratePreview() {
  return { image: { width: 512, height: 350 } as HTMLCanvasElement, width: 1218, height: 833 };
}

test('eleven crate sprites use one shared decoded image and twenty-two triangles without loading a model', t => {
  const requests = installImage(t);
  const preview = cratePreview();
  const crates = createCrateSprites(11, preview);
  assert.deepEqual(requests, []);
  assert.equal(crates.root.children.length, 1);
  const batch = crates.root.children[0] as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  assert.ok(batch.isInstancedMesh);
  assert.equal(batch.count, 11);
  assert.equal(batch.geometry.index!.count / 3 * batch.count, 22);
  assert.equal(batch.material.map!.image, preview.image);
  assert.equal(batch.material.map!.colorSpace, THREE.SRGBColorSpace);
  assert.equal(batch.material.depthTest, true);
  assert.equal(batch.material.depthWrite, true);
  assert.ok(batch.material.alphaTest > 0);
  assert.deepEqual(crates.bounds.getSize(new THREE.Vector3()).toArray(),
    [CRATE_SPRITE_BOUNDS.width, CRATE_SPRITE_BOUNDS.height, CRATE_SPRITE_BOUNDS.depth]);
  assert.equal(batch.material.onBeforeCompile, THREE.Material.prototype.onBeforeCompile);
  const matrix = new THREE.Matrix4().makeRotationY(0.23).setPosition(1, 2, 3);
  crates.setMatrixAt(6, matrix);
  crates.commit();
  const actual = new THREE.Matrix4();
  batch.getMatrixAt(6, actual);
  assert.ok(actual.elements.every((value, index) => Math.abs(value - matrix.elements[index]) < 1e-6));
  const disposed = { texture: 0, material: 0, geometry: 0, batch: 0 };
  batch.material.map!.addEventListener('dispose', () => disposed.texture++);
  batch.material.addEventListener('dispose', () => disposed.material++);
  batch.geometry.addEventListener('dispose', () => disposed.geometry++);
  batch.addEventListener('dispose', () => disposed.batch++);
  crates.setOpacity(0.3);
  assert.equal(batch.material.opacity, 0.3);
  assert.equal(batch.material.depthWrite, false);
  crates.setOpacity(0);
  assert.equal(crates.root.visible, false);
  crates.setOpacity(1);
  assert.equal(batch.material.depthWrite, true);
  assert.equal(crates.root.visible, true);
  crates.dispose();
  crates.dispose();
  assert.deepEqual(disposed, { texture: 1, material: 1, geometry: 1, batch: 1 });
  assert.equal(crates.root.children.length, 0);
  assert.deepEqual([preview.image.width, preview.image.height], [512, 350], 'The fallback still owns the decoded canvas.');
});

test('invalid sprite allocations, previews and transforms fail before drawing', t => {
  const requests = installImage(t);
  const preview = cratePreview();
  for (const count of [0, -1, 12, 10.5, Number.NaN, Infinity]) assert.throws(() => createCrateSprites(count, preview), RangeError);
  for (const invalid of [{ ...preview, width: 0 }, { ...preview, height: Number.NaN },
    { ...preview, image: { width: 0, height: 0 } as HTMLCanvasElement }]) {
    assert.throws(() => createCrateSprites(11, invalid), /decoded/);
  }
  const crates = createCrateSprites(1, preview);
  assert.throws(() => crates.setMatrixAt(1, new THREE.Matrix4()), RangeError);
  assert.throws(() => crates.setMatrixAt(0, new THREE.Matrix4().makeTranslation(Number.NaN, 0, 0)), RangeError);
  crates.dispose();
  assert.deepEqual(requests, []);
});

test('aborting the warehouse during decode ignores late completion', async t => {
  let finish!: () => void;
  installImage(t, () => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = createWarehouseModel({ signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finish();
  await Promise.resolve();
  await assert.rejects(createWarehouseModel({ signal: controller.signal }), { name: 'AbortError' });
});
