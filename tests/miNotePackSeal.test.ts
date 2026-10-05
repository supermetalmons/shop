import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { createMiNotePackSeal } from '../src/lib/miNotePackSeal.ts';

function setupArtwork(t: TestContext) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const requests: string[] = [];
  const context = { drawImage() {}, imageSmoothingQuality: 'low' };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) },
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      naturalWidth = 2048;
      naturalHeight = 2048;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        requests.push(value);
        queueMicrotask(() => this.onload?.());
      }
      removeAttribute() {}
    },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousImage) Object.defineProperty(globalThis, 'Image', previousImage);
    else Reflect.deleteProperty(globalThis, 'Image');
  });
  return requests;
}

async function createSeal(t: TestContext, foldPosition: number, rotationOffsetDegrees = 0) {
  const parent = new THREE.Group();
  const fallRoot = new THREE.Group();
  fallRoot.add(parent);
  const seal = createMiNotePackSeal({
    parent,
    fallRoot,
    width: 1.29,
    spine: 0.0158,
    star: { id: 'test', name: 'Test star', src: '/star.png' },
    foldPosition,
    rotationOffsetDegrees,
  });
  t.after(() => seal.dispose());
  await seal.ready;
  const pivot = parent.children[0];
  const mesh = pivot.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  assert.ok(mesh instanceof THREE.Mesh);
  return { seal, parent, pivot, mesh };
}

function frontVertices(geometry: THREE.BufferGeometry) {
  const positions = geometry.attributes.position;
  let count = 0;
  for (let index = 0; index < positions.count; index += 1) {
    if (positions.getZ(index) > 0) count += 1;
  }
  return count;
}

function assertBoundsMatchVertices(geometry: THREE.BufferGeometry) {
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  const actualBox = new THREE.Box3().setFromBufferAttribute(positions);
  assert.ok(geometry.boundingBox?.equals(actualBox));
  const sphere = geometry.boundingSphere;
  assert.ok(sphere);
  const point = new THREE.Vector3();
  for (let index = 0; index < positions.count; index += 1) {
    point.fromBufferAttribute(positions, index);
    assert.ok(sphere.center.distanceTo(point) <= sphere.radius + 1e-7);
  }
}

test('fold adjustment updates a stationary seal and hit bounds without replacing or reloading assets', async (t) => {
  const requests = setupArtwork(t);
  const { seal, parent, mesh } = await createSeal(t, 0.573);
  const geometry = mesh.geometry;
  const material = mesh.material;
  const texture = material.map;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const originalPositions = Array.from(positions.array);
  const originalNormals = Array.from(normals.array);
  const originalFront = frontVertices(geometry);
  const originalBounds = new THREE.Box3().setFromObject(parent);
  const originalSphere = geometry.boundingSphere!.clone();

  seal.setFoldPosition(0.7);

  assert.equal(parent.children[0].children[0], mesh);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material, material);
  assert.equal(mesh.material.map, texture);
  assert.equal(geometry.attributes.position, positions);
  assert.equal(geometry.attributes.normal, normals);
  assert.notDeepEqual(Array.from(positions.array), originalPositions);
  assert.notDeepEqual(Array.from(normals.array), originalNormals);
  assert.ok(frontVertices(geometry) > originalFront);
  assert.ok(!new THREE.Box3().setFromObject(parent).equals(originalBounds));
  assert.ok(!geometry.boundingSphere!.equals(originalSphere));
  assertBoundsMatchVertices(geometry);
  assert.deepEqual(requests, ['/star.png']);

  const version = (positions as THREE.BufferAttribute).version;
  seal.setFoldPosition(0.7);
  assert.equal((positions as THREE.BufferAttribute).version, version);
});

test('fold endpoints maintain valid geometry and moving right increases the front portion', async (t) => {
  setupArtwork(t);
  const { seal, mesh } = await createSeal(t, 0.1);
  let previousFront = frontVertices(mesh.geometry);
  for (const value of [0.3, 0.573, 0.7, 0.9]) {
    seal.setFoldPosition(value);
    const nextFront = frontVertices(mesh.geometry);
    assert.ok(nextFront > previousFront);
    previousFront = nextFront;
    for (const attribute of [mesh.geometry.attributes.position, mesh.geometry.attributes.normal]) {
      assert.ok(Array.from(attribute.array).every(Number.isFinite));
    }
    assertBoundsMatchVertices(mesh.geometry);
  }
});

test('rotation updates a stationary seal in place and returning to zero preserves its fold', async (t) => {
  const requests = setupArtwork(t);
  const { seal, parent, mesh } = await createSeal(t, 0.573);
  seal.setFoldPosition(0.7);
  const geometry = mesh.geometry;
  const material = mesh.material;
  const texture = material.map;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const originalPositions = Array.from(positions.array);
  const originalNormals = Array.from(normals.array);
  const originalBounds = new THREE.Box3().setFromObject(parent);
  const originalSphere = geometry.boundingSphere!.clone();

  seal.setRotationOffsetDegrees(7.5);

  assert.equal(parent.children[0].children[0], mesh);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material, material);
  assert.equal(mesh.material.map, texture);
  assert.equal(geometry.attributes.position, positions);
  assert.equal(geometry.attributes.normal, normals);
  assert.notDeepEqual(Array.from(positions.array), originalPositions);
  assert.notDeepEqual(Array.from(normals.array), originalNormals);
  assert.ok(!new THREE.Box3().setFromObject(parent).equals(originalBounds));
  assert.ok(!geometry.boundingSphere!.equals(originalSphere));
  assertBoundsMatchVertices(geometry);
  const clockwisePositions = Array.from(positions.array);

  const version = (positions as THREE.BufferAttribute).version;
  seal.setRotationOffsetDegrees(7.5);
  assert.equal((positions as THREE.BufferAttribute).version, version);

  seal.setRotationOffsetDegrees(-7.5);
  assert.notDeepEqual(Array.from(positions.array), originalPositions);
  assert.notDeepEqual(Array.from(positions.array), clockwisePositions);
  assertBoundsMatchVertices(geometry);

  seal.setRotationOffsetDegrees(0);
  assert.deepEqual(Array.from(positions.array), originalPositions);
  assert.deepEqual(Array.from(normals.array), originalNormals);
  assertBoundsMatchVertices(geometry);
  assert.deepEqual(requests, ['/star.png']);
});

test('rotation endpoints keep finite geometry and positive offsets rotate artwork clockwise', async (t) => {
  setupArtwork(t);
  const { seal, mesh } = await createSeal(t, 0.573);
  for (const foldPosition of [0.1, 0.573, 0.9]) {
    seal.setFoldPosition(foldPosition);
    for (const rotationOffsetDegrees of [-15, 0, 15]) {
      seal.setRotationOffsetDegrees(rotationOffsetDegrees);
      const geometry = mesh.geometry;
      for (const attribute of [geometry.attributes.position, geometry.attributes.normal]) {
        assert.ok(Array.from(attribute.array).every(Number.isFinite));
      }
      const angle = (5 - rotationOffsetDegrees) * Math.PI / 180;
      const uv = geometry.attributes.uv;
      const x = (uv.getX(0) - 0.5) * 0.56;
      const y = (uv.getY(0) - 0.5) * 0.56;
      assert.ok(Math.abs(geometry.attributes.position.getY(0) - (x * Math.sin(angle) + y * Math.cos(angle))) < 1e-7);
      assertBoundsMatchVertices(geometry);
    }
  }
});

test('peeling starts from the tuned rotation and live rotation retains the current peel pose', async (t) => {
  setupArtwork(t);
  const adjusted = await createSeal(t, 0.7);
  const reference = await createSeal(t, 0.7, 12.3);
  adjusted.seal.setRotationOffsetDegrees(12.3);
  const sealedPositions = Array.from(adjusted.mesh.geometry.attributes.position.array);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, reference.mesh.geometry.attributes.position.array);
  adjusted.seal.start();
  reference.seal.start();

  assert.equal(adjusted.seal.update(0, false), false);
  assert.deepEqual(Array.from(adjusted.mesh.geometry.attributes.position.array), sealedPositions);
  adjusted.seal.update(0.35, false);
  reference.seal.update(0.35, false);
  assert.notDeepEqual(Array.from(adjusted.mesh.geometry.attributes.position.array), sealedPositions);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, reference.mesh.geometry.attributes.position.array);

  const nextReference = await createSeal(t, 0.7, -8.2);
  nextReference.seal.start();
  nextReference.seal.update(0.35, false);
  adjusted.seal.setRotationOffsetDegrees(-8.2);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, nextReference.mesh.geometry.attributes.position.array);
  assertBoundsMatchVertices(adjusted.mesh.geometry);
  adjusted.seal.dispose();
  const version = (adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version;
  adjusted.seal.setRotationOffsetDegrees(0);
  assert.equal((adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version, version);
});

test('peeling starts at the tuned shape and retains the selected fold throughout animation', async (t) => {
  setupArtwork(t);
  const adjusted = await createSeal(t, 0.3);
  const reference = await createSeal(t, 0.7);
  adjusted.seal.setFoldPosition(0.7);
  const sealedPositions = Array.from(adjusted.mesh.geometry.attributes.position.array);
  adjusted.seal.start();
  reference.seal.start();

  assert.equal(adjusted.seal.update(0, false), false);
  assert.deepEqual(Array.from(adjusted.mesh.geometry.attributes.position.array), sealedPositions);
  adjusted.seal.update(0.35, false);
  reference.seal.update(0.35, false);
  assert.notDeepEqual(Array.from(adjusted.mesh.geometry.attributes.position.array), sealedPositions);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, reference.mesh.geometry.attributes.position.array);
  assertBoundsMatchVertices(adjusted.mesh.geometry);

  const nextReference = await createSeal(t, 0.6);
  nextReference.seal.start();
  nextReference.seal.update(0.35, false);
  adjusted.seal.setFoldPosition(0.6);
  assert.deepEqual(adjusted.mesh.geometry.attributes.position.array, nextReference.mesh.geometry.attributes.position.array);
  assert.equal(adjusted.seal.update(1.2, false), true);
  assert.equal(adjusted.pivot.visible, false);
  adjusted.seal.dispose();
  const version = (adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version;
  adjusted.seal.setFoldPosition(0.5);
  assert.equal((adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version, version);
});
