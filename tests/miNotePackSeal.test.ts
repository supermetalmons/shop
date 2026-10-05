import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { createMiNotePackSeal } from '../src/lib/miNotePackSeal.ts';

function setupArtwork(t: TestContext, pixels = new Uint8ClampedArray(512 * 512 * 4).fill(255)) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const requests: string[] = [];
  const context = { drawImage() {}, getImageData: () => ({ data: pixels }), imageSmoothingQuality: 'low' };
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

async function createSeal(t: TestContext, foldPosition: number, rotationOffsetDegrees = 0, thickness = 0.0018) {
  const parent = new THREE.Group();
  const seal = createMiNotePackSeal({
    parent,
    width: 1.29,
    spine: 0.0158,
    thickness,
    star: { id: 'test', name: 'Test star', src: '/star.png', foldPosition, rotationOffsetDegrees },
    foldPosition,
    rotationOffsetDegrees,
  });
  t.after(() => seal.dispose());
  await seal.ready;
  const pivot = parent.children[0];
  const mesh = pivot.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  assert.ok(mesh instanceof THREE.Mesh);
  return { seal, parent, pivot, mesh };
}

function frontMaterialArea(geometry: THREE.BufferGeometry) {
  const positions = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const indices = geometry.index!;
  let area = 0;
  for (let index = 0; index < indices.count; index += 3) {
    const a = indices.getX(index);
    const b = indices.getX(index + 1);
    const c = indices.getX(index + 2);
    if (positions.getZ(a) <= 0 || positions.getZ(b) <= 0 || positions.getZ(c) <= 0) continue;
    area += Math.abs(
      (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a))
      - (uv.getY(b) - uv.getY(a)) * (uv.getX(c) - uv.getX(a)),
    ) / 2;
  }
  return area;
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

function assertAdhesiveRemainsAttached(
  mesh: THREE.Mesh<THREE.PlaneGeometry>,
  pivot: THREE.Object3D,
  foldPosition: number,
  rotationOffsetDegrees: number,
) {
  const width = 0.56;
  const thickness = 0.0018;
  const spine = 0.0158;
  const clearance = 0.0015;
  const radius = (spine + thickness + 2 * clearance) / 2;
  const angle = (5 - rotationOffsetDegrees) * Math.PI / 180;
  const position = mesh.geometry.attributes.position;
  const uv = mesh.geometry.attributes.uv;
  let attachedVertices = 0;
  for (let index = 0; index < position.count; index += 1) {
    const x = (uv.getX(index) - 0.5) * width;
    const y = (uv.getY(index) - 0.5) * width;
    const rotatedX = x * Math.cos(angle) - y * Math.sin(angle);
    const rotatedY = x * Math.sin(angle) + y * Math.cos(angle);
    const distance = (foldPosition - 0.5) * width + Math.PI * radius / 2 - rotatedX;
    if (distance > -1e-6) continue;
    assert.ok(Math.abs(position.getX(index) - distance) < 1e-7);
    assert.ok(Math.abs(position.getY(index) - rotatedY) < 1e-7);
    assert.ok(Math.abs(position.getZ(index) + pivot.position.z + thickness / 2 + clearance) < 1e-7);
    attachedVertices += 1;
  }
  assert.ok(attachedVertices > 0);
}

test('fold adjustment updates a stationary seal and hit bounds without replacing or reloading assets', async (t) => {
  const requests = setupArtwork(t);
  const { seal, parent, mesh } = await createSeal(t, 0.573);
  const geometry = mesh.geometry;
  const material = mesh.material;
  const texture = material.map;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const originalPositions = Array.from(positions.array);
  const originalUv = Array.from(uv.array);
  const originalFront = frontMaterialArea(geometry);
  const originalBounds = new THREE.Box3().setFromObject(mesh);
  const originalSphere = geometry.boundingSphere!.clone();

  seal.setFoldPosition(0.7);

  assert.equal(parent.children[0].children[0], mesh);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material, material);
  assert.equal(mesh.material.map, texture);
  assert.equal(geometry.attributes.position, positions);
  assert.equal(geometry.attributes.normal, normals);
  assert.equal(geometry.attributes.uv, uv);
  assert.notDeepEqual(Array.from(positions.array), originalPositions);
  assert.notDeepEqual(Array.from(uv.array), originalUv);
  assert.ok(frontMaterialArea(geometry) > originalFront);
  assert.ok(!new THREE.Box3().setFromObject(mesh).equals(originalBounds));
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
  let previousFront = frontMaterialArea(mesh.geometry);
  for (const value of [0.3, 0.573, 0.7, 0.9]) {
    seal.setFoldPosition(value);
    const nextFront = frontMaterialArea(mesh.geometry);
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
  const uv = geometry.attributes.uv;
  const originalPositions = Array.from(positions.array);
  const originalNormals = Array.from(normals.array);
  const originalUv = Array.from(uv.array);
  const originalBounds = new THREE.Box3().setFromObject(mesh);
  const originalSphere = geometry.boundingSphere!.clone();

  seal.setRotationOffsetDegrees(7.5);

  assert.equal(parent.children[0].children[0], mesh);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material, material);
  assert.equal(mesh.material.map, texture);
  assert.equal(geometry.attributes.position, positions);
  assert.equal(geometry.attributes.normal, normals);
  assert.equal(geometry.attributes.uv, uv);
  assert.notDeepEqual(Array.from(positions.array), originalPositions);
  assert.notDeepEqual(Array.from(uv.array), originalUv);
  assert.ok(!new THREE.Box3().setFromObject(mesh).equals(originalBounds));
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
  assert.deepEqual(Array.from(uv.array), originalUv);
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

test('sealed sticker follows both cover surfaces and the pack edge without penetrating the pack', async (t) => {
  setupArtwork(t);
  const width = 1.29;
  const spine = 0.0158;
  const clearance = 0.0015;
  const tolerance = 1e-7;
  for (const thickness of [0.0018, 0.0036]) {
    const { seal, pivot, mesh } = await createSeal(t, 0.573, 0, thickness);
    const backCover = -thickness / 2;
    const frontCover = spine + thickness / 2;
    const radius = (spine + thickness + 2 * clearance) / 2;
    const centerZ = spine / 2;
    for (const foldPosition of [0.1, 0.573, 0.9]) {
      seal.setFoldPosition(foldPosition);
      for (const rotation of [-15, 0, 5, 15]) {
        seal.setRotationOffsetDegrees(rotation);
        const geometry = mesh.geometry;
        const positions = geometry.attributes.position;
        const uv = geometry.attributes.uv;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let maxX = -Infinity;
        let sideVertices = 0;
        for (let index = 0; index < positions.count; index += 1) {
          const x = positions.getX(index) + pivot.position.x;
          const z = positions.getZ(index) + pivot.position.z;
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
          maxX = Math.max(maxX, x);
          assert.ok(x <= width + radius + tolerance);
          assert.ok(z >= backCover - clearance - tolerance);
          assert.ok(z <= frontCover + clearance + tolerance);
          assert.ok(uv.getX(index) >= 0 && uv.getX(index) <= 1);
          assert.ok(uv.getY(index) >= 0 && uv.getY(index) <= 1);
          if (z > backCover + tolerance && z < frontCover - tolerance) {
            assert.ok(x > width);
            assert.ok(Math.abs((x - width) ** 2 + (z - centerZ) ** 2 - radius ** 2) < tolerance);
            sideVertices += 1;
          }
        }
        assert.ok(sideVertices > 0);
        assert.ok(Math.abs(minZ - backCover + clearance) < tolerance);
        assert.ok(Math.abs(maxZ - frontCover - clearance) < tolerance);
        assert.ok(Math.abs(maxX - width - radius) < radius * 0.001);
        const indices = geometry.index!;
        for (let index = 0; index < indices.count; index += 3) {
          const vertices = [indices.getX(index), indices.getX(index + 1), indices.getX(index + 2)];
          const beyondEdge = vertices.every((vertex) => positions.getX(vertex) + pivot.position.x >= width - tolerance);
          const behindCover = vertices.every((vertex) => positions.getZ(vertex) + pivot.position.z <= backCover + tolerance);
          const aboveCover = vertices.every((vertex) => positions.getZ(vertex) + pivot.position.z >= frontCover - tolerance);
          assert.ok(beyondEdge || behindCover || aboveCover, `Triangle ${index / 3} crosses the pack at fold ${foldPosition}, rotation ${rotation}`);
        }
        assertBoundsMatchVertices(geometry);
      }
    }
  }
});

test('peeling starts continuously and keeps valid geometry through the completed peel', async (t) => {
  setupArtwork(t);
  const { seal, mesh } = await createSeal(t, 0.573, -15);
  const geometry = mesh.geometry;
  const originalPositions = Array.from(geometry.attributes.position.array);
  seal.start();
  seal.update(0.001, false);
  for (let index = 0; index < originalPositions.length; index += 1) {
    assert.ok(Math.abs(geometry.attributes.position.array[index] - originalPositions[index]) < 1e-6);
  }
  for (const elapsed of [0.12, 0.35, 0.619, 0.62, 0.9, 1.149]) {
    assert.equal(seal.update(elapsed, false), false);
    for (const attribute of [geometry.attributes.position, geometry.attributes.normal, geometry.attributes.uv]) {
      assert.ok(Array.from(attribute.array).every(Number.isFinite));
    }
    assertBoundsMatchVertices(geometry);
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
  assert.equal(adjusted.pivot.visible, true);
  adjusted.seal.dispose();
  const version = (adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version;
  adjusted.seal.setFoldPosition(0.5);
  assert.equal((adjusted.mesh.geometry.attributes.position as THREE.BufferAttribute).version, version);
});

test('peeled sticker stays attached and visible while its free section keeps fluttering', async (t) => {
  setupArtwork(t);
  const { seal, parent, pivot, mesh } = await createSeal(t, 0.556, 7.7);
  const pivotPosition = pivot.position.clone();
  const pivotQuaternion = pivot.quaternion.clone();
  seal.start();
  for (const elapsed of [0, 0.3, 0.9, 1.2, 8, 64, 300]) {
    assert.equal(seal.update(elapsed, false), elapsed >= 1.2);
    assert.equal(pivot.parent, parent);
    assert.equal(pivot.visible, true);
    assert.equal(mesh.visible, true);
    assert.ok(pivot.position.equals(pivotPosition));
    assert.ok(pivot.quaternion.equals(pivotQuaternion));
    assertAdhesiveRemainsAttached(mesh, pivot, 0.556, 7.7);
    assertBoundsMatchVertices(mesh.geometry);
  }
  const firstFlutter = Array.from(mesh.geometry.attributes.position.array);
  assert.equal(seal.update(300.2, false), true);
  assert.notDeepEqual(Array.from(mesh.geometry.attributes.position.array), firstFlutter);
  assertAdhesiveRemainsAttached(mesh, pivot, 0.556, 7.7);
});

test('attached sticker follows parent translation and rotation after peeling', async (t) => {
  setupArtwork(t);
  const { seal, parent, pivot, mesh } = await createSeal(t, 0.532, 9.3);
  parent.position.set(0.4, -0.2, 0.7);
  parent.rotation.set(0.2, -0.7, 0.1);
  const localPosition = pivot.position.clone();
  const localQuaternion = pivot.quaternion.clone();
  seal.start();
  seal.update(1.2, false);
  parent.position.set(-1, 0.8, 0.2);
  parent.rotation.set(-0.3, 1.8, 0.4);
  seal.update(15, false);
  parent.updateWorldMatrix(true, true);

  assert.equal(pivot.parent, parent);
  assert.ok(pivot.position.equals(localPosition));
  assert.ok(pivot.quaternion.equals(localQuaternion));
  const expectedPosition = parent.localToWorld(localPosition.clone());
  assert.ok(pivot.getWorldPosition(new THREE.Vector3()).distanceTo(expectedPosition) < 1e-10);
  assert.ok(pivot.getWorldQuaternion(new THREE.Quaternion()).angleTo(parent.quaternion.clone().multiply(localQuaternion)) < 1e-7);
  assertAdhesiveRemainsAttached(mesh, pivot, 0.532, 9.3);
});

test('reduced motion leaves the peeled sticker attached without ongoing flutter', async (t) => {
  setupArtwork(t);
  const { seal, parent, pivot, mesh } = await createSeal(t, 0.49, 3.2);
  seal.start();
  assert.equal(seal.update(0, true), true);
  const settledPositions = Array.from(mesh.geometry.attributes.position.array);
  for (const elapsed of [1.2, 8, 300]) {
    assert.equal(seal.update(elapsed, true, 1), true);
    assert.deepEqual(Array.from(mesh.geometry.attributes.position.array), settledPositions);
    assert.equal(pivot.parent, parent);
    assert.equal(pivot.visible, true);
    assertAdhesiveRemainsAttached(mesh, pivot, 0.49, 3.2);
  }
  assertBoundsMatchVertices(mesh.geometry);
});

test('pack motion changes the free flap while the adhesive section remains fixed', async (t) => {
  setupArtwork(t);
  const resting = await createSeal(t, 0.487, 2.4);
  const moving = await createSeal(t, 0.487, 2.4);
  resting.seal.start();
  moving.seal.start();
  resting.seal.update(1.2, false);
  moving.seal.update(1.2, false);
  resting.seal.update(2, false, 0);
  moving.seal.update(2, false, 1);
  assert.notDeepEqual(moving.mesh.geometry.attributes.position.array, resting.mesh.geometry.attributes.position.array);
  assertAdhesiveRemainsAttached(resting.mesh, resting.pivot, 0.487, 2.4);
  assertAdhesiveRemainsAttached(moving.mesh, moving.pivot, 0.487, 2.4);
  assertBoundsMatchVertices(moving.mesh.geometry);
});

test('peeled sticker picking respects texture alpha and preserves objects behind transparent areas', async (t) => {
  const pixels = new Uint8ClampedArray(512 * 512 * 4);
  const alphaBands = [0, 101, 102, 255];
  for (let y = 0; y < 512; y += 1) {
    for (let x = 0; x < 512; x += 1) pixels[(y * 512 + x) * 4 + 3] = alphaBands[Math.floor(y / 128)];
  }
  setupArtwork(t, pixels);
  const { seal, parent, mesh } = await createSeal(t, 0.532, 9.3);
  seal.start();
  seal.update(2, true);
  parent.updateMatrixWorld(true);
  const indices = mesh.geometry.index!;
  const position = mesh.geometry.attributes.position;
  const uv = mesh.geometry.attributes.uv;
  for (const [band, alpha] of alphaBands.entries()) {
    const triangle = new THREE.Triangle();
    let selected = false;
    for (let index = 0; index < indices.count; index += 3) {
      const vertices = [indices.getX(index), indices.getX(index + 1), indices.getX(index + 2)];
      const u = vertices.reduce((sum, vertex) => sum + uv.getX(vertex), 0) / 3;
      const v = vertices.reduce((sum, vertex) => sum + uv.getY(vertex), 0) / 3;
      if (u < 0.08 || u > 0.12 || Math.abs(v - (1 - (band + 0.5) / 4)) > 0.02) continue;
      [triangle.a, triangle.b, triangle.c].forEach((point, corner) => point.fromBufferAttribute(position, vertices[corner]).applyMatrix4(mesh.matrixWorld));
      if (triangle.getArea() > 1e-8) { selected = true; break; }
    }
    assert.ok(selected);
    const point = triangle.getMidpoint(new THREE.Vector3());
    const normal = triangle.getNormal(new THREE.Vector3());
    const raycaster = new THREE.Raycaster(point.clone().addScaledVector(normal, 0.01), normal.clone().negate(), 0, 0.04);
    const rawHits: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(mesh, raycaster, rawHits);
    assert.ok(rawHits.length > 0);
    assert.equal(Math.floor((1 - rawHits[0].uv!.y) * 4), band);

    const backing = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.05), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    backing.position.copy(point).addScaledVector(normal, -0.01);
    backing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    backing.updateMatrixWorld(true);
    const opaque = alpha >= 102;
    assert.equal(raycaster.intersectObject(parent, true).length > 0, opaque);
    assert.equal(raycaster.intersectObjects([backing, parent], true)[0]?.object, opaque ? mesh : backing);
    backing.geometry.dispose();
    backing.material.dispose();
  }
});
