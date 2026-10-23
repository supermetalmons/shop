import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { createDogeFoilPackModel, type DogeFoilPackPose } from '../src/dogeDay2026/foilPackModel.ts';

const restingPose: DogeFoilPackPose = { hit: 0, hitX: 0, hitY: 0, variant: 0, tear: 0, discard: 0 };

function setupCanvas(t: TestContext) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const printedText: string[] = [];
  const context = {
    fillText(text: string) { printedText.push(text); },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    stroke() {},
    fill() {},
    save() {},
    restore() {},
    translate() {},
    ellipse() {},
    strokeRect() {},
    fillRect() {},
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  return printedText;
}

function meshes(group: THREE.Group) {
  const result: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) result.push(child);
  });
  return result;
}

test('foil pack print reflects its selected card count', (t) => {
  const printedText = setupCanvas(t);
  const single = createDogeFoilPackModel();
  t.after(() => single.dispose());
  assert.ok(printedText.includes('1 CARD PACK'));
  for (const cardCount of [2, 3] as const) {
    printedText.length = 0;
    const multiple = createDogeFoilPackModel(cardCount);
    t.after(() => multiple.dispose());
    assert.deepEqual(printedText.filter((text) => text.endsWith('CARD PACK')), [`${cardCount} CARD PACK`]);
  }
});

test('foil pack stays within the mobile geometry budget with real front, back and rim depth', (t) => {
  setupCanvas(t);
  const model = createDogeFoilPackModel();
  t.after(() => model.dispose());
  const parts = meshes(model.group);
  assert.ok(parts.length <= 4);
  assert.ok(parts.reduce((total, part) => total + part.geometry.attributes.position.count, 0) < 5_000);
  assert.equal(new Set(parts.map((part) => part.material)).size, 1);
  const bounds = new THREE.Box3().setFromObject(model.group, true);
  const size = bounds.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 2.45) < 0.001);
  assert.ok(Math.abs(size.y - 3.75) < 0.001);
  assert.ok(size.z > 0.3 && size.z < 0.6);
  for (const part of parts) {
    assert.ok(part.geometry.index);
    for (const attribute of Object.values(part.geometry.attributes)) {
      assert.ok(Array.from(attribute.array).every(Number.isFinite));
    }
  }
});

test('hits, tearing and discard reset without replacing geometry or changing the scene placement', (t) => {
  setupCanvas(t);
  const model = createDogeFoilPackModel();
  t.after(() => model.dispose());
  model.group.position.set(0.1, 0.2, -0.3);
  model.group.rotation.set(0.02, 0.3, -0.05);
  model.update(restingPose);
  model.group.updateMatrixWorld(true);
  const parts = meshes(model.group);
  const initial = parts.map((part) => ({
    matrix: part.matrixWorld.clone(),
    geometry: part.geometry,
    positions: part.geometry.attributes.position.array,
  }));
  for (let variant = 0; variant < 6; variant += 1) {
    for (const hit of [0.2, 0.7, 1, 0.4, 0]) {
      model.update({ ...restingPose, hit, hitX: -0.8, hitY: 0.7, variant });
    }
  }
  for (const tear of [0.1, 0.5, 1]) model.update({ ...restingPose, tear });
  model.update({ ...restingPose, tear: 1, discard: 1 });
  assert.equal(model.group.children[0].visible, false);
  model.update(restingPose);
  model.group.updateMatrixWorld(true);
  assert.equal(model.group.children[0].visible, true);
  parts.forEach((part, index) => {
    assert.equal(part.geometry, initial[index].geometry);
    assert.equal(part.geometry.attributes.position.array, initial[index].positions);
    part.matrixWorld.elements.forEach((value, element) => {
      assert.ok(Math.abs(value - initial[index].matrix.elements[element]) < 1e-10);
    });
  });
});

test('foil model disposes all owned GPU resources exactly once', (t) => {
  setupCanvas(t);
  const model = createDogeFoilPackModel();
  const parts = meshes(model.group);
  const resources = [...parts.map((part) => part.geometry), parts[0].material, parts[0].material.uniforms.uPrint.value as THREE.Texture];
  const counts = new Map(resources.map((resource) => [resource, 0]));
  for (const resource of resources) resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource)! + 1));
  model.dispose();
  model.dispose();
  model.update(restingPose);
  assert.equal(model.group.children.length, 0);
  for (const count of counts.values()) assert.equal(count, 1);
});
