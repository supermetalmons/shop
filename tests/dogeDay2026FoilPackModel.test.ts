import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { createDogeFoilPackModel, type DogeFoilPackPose } from '../src/dogeDay2026/foilPackModel.ts';
import { createDogeFoilFlow, sampleDogeFoilFlow } from '../src/dogeDay2026/foilPackFlow.ts';
import { createDogeCardStackFlow, sampleDogeCardStackFlow } from '../src/dogeDay2026/cardStackFlow.ts';
import { createMiNoteCardGeometry } from '../src/lib/miNoteCardGeometry.ts';

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
  assert.deepEqual(parts.map(part => part.name).sort(), ['foil-front', 'foil-rear', 'foil-top-seal']);
  assert.ok(parts.reduce((total, part) => total + part.geometry.attributes.position.count, 0) <= 3_552);
  assert.ok(parts.reduce((total, part) => total + part.geometry.index!.count / 3, 0) <= 5_968);
  assert.equal(new Set(parts.map((part) => part.material)).size, 1);
  assert.equal(parts[0].material.transparent, false);
  assert.equal(parts[0].material.depthTest, true);
  assert.equal(parts[0].material.depthWrite, true);
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

test('the detailed top seal matches both sleeve seams and has closed, consistently wound triangles', t => {
  setupCanvas(t);
  const model = createDogeFoilPackModel();
  t.after(() => model.dispose());
  const parts = meshes(model.group);
  const seal = parts.find(part => part.name === 'foil-top-seal')!;
  const points = (part: typeof seal) => Array.from({ length: part.geometry.attributes.position.count }, (_, index) =>
    new THREE.Vector3().fromBufferAttribute(part.geometry.attributes.position, index));
  const key = (point: THREE.Vector3) => point.toArray().join(',');
  const sealPoints = points(seal);
  for (const [name, sign] of [['foil-front', 1], ['foil-rear', -1]] as const) {
    const edge = new Map<number, THREE.Vector3>();
    for (const point of points(parts.find(part => part.name === name)!)) {
      if (Math.sign(point.z) === sign && (!edge.has(point.x) || point.y > edge.get(point.x)!.y)) edge.set(point.x, point);
    }
    const top = Math.max(...Array.from(edge.values(), point => point.y));
    const seam = new Set(sealPoints.filter(point => point.y <= top && Math.sign(point.z) === sign).map(key));
    assert.deepEqual([...seam].sort(), Array.from(edge.values(), key).sort(), `${name} has a gap at the sealed mouth`);
  }
  const sealEdges = new Map<string, { count: number; direction: number }>();
  for (const part of parts) {
    const vertices = points(part);
    const indices = part.geometry.index!;
    let faces = 0;
    for (let index = 0; index < indices.count; index += 3) {
      const ids = [indices.getX(index), indices.getX(index + 1), indices.getX(index + 2)];
      assert.ok(ids.every(id => Number.isInteger(id) && id >= 0 && id < vertices.length));
      const triangle = ids.map(id => vertices[id]);
      const normal = new THREE.Vector3().subVectors(triangle[1], triangle[0])
        .cross(new THREE.Vector3().subVectors(triangle[2], triangle[0]));
      if (part === seal) assert.ok(normal.lengthSq() > 1e-18, `Seal triangle ${index / 3} is degenerate`);
      if (triangle.every(point => point.z > 0) || triangle.every(point => point.z < 0)) {
        assert.ok(normal.z * Math.sign(triangle[0].z) > 0, `${part.name} triangle ${index / 3} has reversed winding`);
        faces += 1;
      }
      if (part !== seal) continue;
      for (let side = 0; side < 3; side += 1) {
        const a = key(triangle[side]);
        const b = key(triangle[(side + 1) % 3]);
        const edgeKey = a < b ? `${a}|${b}` : `${b}|${a}`;
        const edge = sealEdges.get(edgeKey) ?? { count: 0, direction: 0 };
        edge.count += 1;
        edge.direction += a < b ? 1 : -1;
        sealEdges.set(edgeKey, edge);
      }
    }
    assert.ok(faces > 0);
  }
  for (const [edge, counts] of sealEdges) assert.deepEqual(counts, { count: 2, direction: 0 }, `Unstitched seal edge ${edge}`);
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
  const discarded: THREE.Object3D[] = [];
  model.group.traverseVisible(part => { if (part instanceof THREE.Mesh) discarded.push(part); });
  assert.equal(discarded.length, 0);
  model.update(restingPose);
  model.group.updateMatrixWorld(true);
  const restored: THREE.Object3D[] = [];
  model.group.traverseVisible(part => { if (part instanceof THREE.Mesh) restored.push(part); });
  assert.equal(restored.length, parts.length);
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

test('downward extraction does not upload unchanged foil vertices or normals each frame', t => {
  setupCanvas(t);
  const model = createDogeFoilPackModel(3);
  t.after(() => model.dispose());
  model.update({ ...restingPose, tear: 1 });
  const attributes = meshes(model.group).flatMap(part => [
    part.geometry.attributes.position as THREE.BufferAttribute,
    part.geometry.attributes.normal as THREE.BufferAttribute,
  ]);
  const versions = attributes.map(attribute => attribute.version);
  for (let frame = 1; frame <= 96; frame += 1) {
    model.update({ ...restingPose, tear: 1, discard: frame / 96 });
    assert.deepEqual(attributes.map(attribute => attribute.version), versions);
  }
});

test('tall viewport exit distances do not alter foil vertices or normals', t => {
  setupCanvas(t);
  const models = [7.25, 11, 20].map(distance => {
    const model = createDogeFoilPackModel(3);
    model.setExitDistance(distance);
    t.after(() => model.dispose());
    return model;
  });
  for (const pose of [
    { ...restingPose, tear: 0.5 },
    { ...restingPose, tear: 1, discard: 0.2 },
    { ...restingPose, tear: 1, discard: 0.8 },
  ]) {
    models.forEach(model => model.update(pose));
    const reference = meshes(models[0].group);
    for (const model of models.slice(1)) {
      meshes(model.group).forEach((part, index) => {
        assert.deepEqual(part.geometry.attributes.position.array, reference[index].geometry.attributes.position.array);
        assert.deepEqual(part.geometry.attributes.normal.array, reference[index].geometry.attributes.normal.array);
      });
    }
  }
});

test('resizing taller or shorter during discard preserves the pose and continues without reversing', t => {
  setupCanvas(t);
  for (const [initialDistance, nextDistance, discard] of [
    [7.25, 11, 0.32],
    [11, 7.25, 0.32],
    [11, 7.25, 0.8],
    [7.25, 11, 1],
  ]) {
    const model = createDogeFoilPackModel(3);
    t.after(() => model.dispose());
    model.setExitDistance(initialDistance);
    const pose = { ...restingPose, tear: 1, discard };
    model.update(pose);
    model.group.updateMatrixWorld(true);
    const parts = meshes(model.group);
    const matrices = parts.map(part => part.matrixWorld.clone());
    const attributes = parts.flatMap(part => [
      part.geometry.attributes.position as THREE.BufferAttribute,
      part.geometry.attributes.normal as THREE.BufferAttribute,
    ]);
    const versions = attributes.map(attribute => attribute.version);
    const sleeve = parts.find(part => part.name === 'foil-front')!.parent!;
    const seal = parts.find(part => part.name === 'foil-top-seal')!;
    let distance = -sleeve.position.y;
    const expectedExit = discard < 1 ? Math.max(nextDistance, distance) : distance;
    model.setExitDistance(nextDistance);
    for (let frame = 0; frame < 5; frame += 1) {
      model.update(pose);
      model.group.updateMatrixWorld(true);
      parts.forEach((part, index) => assert.ok(part.matrixWorld.equals(matrices[index])));
    }
    for (let frame = 1; frame <= 60; frame += 1) {
      model.update({ ...pose, discard: discard + (1 - discard) * frame / 60 });
      assert.ok(-sleeve.position.y >= distance);
      distance = -sleeve.position.y;
      assert.equal(seal.position.x, distance);
      assert.equal(seal.position.y, distance);
      assert.deepEqual(attributes.map(attribute => attribute.version), versions);
    }
    assert.equal(distance, expectedExit);
    model.update({ ...pose, discard: 0 });
    model.update({ ...pose, discard: 0.25 });
    assert.equal(-sleeve.position.y, nextDistance * 0.25);
  }
});

test('rewinding a resized opening samples the new exit trajectory deterministically', t => {
  setupCanvas(t);
  const resized = createDogeFoilPackModel(3);
  const fresh = createDogeFoilPackModel(3);
  t.after(() => { resized.dispose(); fresh.dispose(); });
  resized.update({ ...restingPose, tear: 1, discard: 0.4 });
  resized.setExitDistance(11);
  resized.update({ ...restingPose, tear: 1, discard: 0.6 });
  fresh.setExitDistance(11);
  const pose = { ...restingPose, tear: 1, discard: 0.2 };
  resized.update(pose);
  fresh.update(pose);
  resized.group.updateMatrixWorld(true);
  fresh.group.updateMatrixWorld(true);
  const reference = meshes(fresh.group);
  meshes(resized.group).forEach((part, index) => assert.ok(part.matrixWorld.equals(reference[index].matrixWorld)));
});

test('inspection capture preserves the selected pose after resizing in either direction', t => {
  setupCanvas(t);
  for (const [initialDistance, nextDistance] of [[7.25, 11], [11, 7.25]]) {
    for (const elapsed of [900, 1050]) {
      const model = createDogeFoilPackModel(3);
      const reference = createDogeFoilPackModel(3);
      t.after(() => { model.dispose(); reference.dispose(); });
      const flow = { ...createDogeFoilFlow(), stage: 'opening' as const, hitCount: 3, ready: true };
      const pose = sampleDogeFoilFlow(flow, elapsed);
      model.setExitDistance(initialDistance);
      model.update(pose, false);
      model.setExitDistance(nextDistance);
      model.update(pose, false);
      reference.setExitDistance(nextDistance);
      reference.update(pose, false);
      model.group.updateMatrixWorld(true);
      reference.group.updateMatrixWorld(true);
      const parts = meshes(model.group);
      const expected = meshes(reference.group);
      parts.forEach((part, index) => assert.ok(part.matrixWorld.equals(expected[index].matrixWorld)));
      const beforeCapture = parts.map(part => part.matrixWorld.clone());
      for (let frame = 0; frame <= 78; frame += 1) {
        model.update(sampleDogeFoilFlow(flow, frame * 1000 / 60), false);
      }
      model.update(pose, false);
      model.group.updateMatrixWorld(true);
      parts.forEach((part, index) => assert.ok(part.matrixWorld.equals(beforeCapture[index])));
    }
  }
});

function convexHull(points: THREE.Vector3[]) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (vertices: THREE.Vector3[]) => {
    const result: THREE.Vector3[] = [];
    for (const point of vertices) {
      while (result.length >= 2 && turn(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

function cardVolumes(count: 1 | 2 | 3) {
  const geometry = createMiNoteCardGeometry();
  geometry.computeBoundingBox();
  const width = geometry.boundingBox!.max.x - geometry.boundingBox!.min.x;
  geometry.scale(2 / width, 2 / width, 1);
  const placement = sampleDogeCardStackFlow(createDogeCardStackFlow({ count }), 0, {
    viewportWidth: 900, viewportHeight: 900, cardWidthPx: 325, cardCenterY: 450,
  });
  const result = placement.map(pose => {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(pose.x, pose.y, pose.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, pose.rotationZ)),
      new THREE.Vector3().setScalar(pose.scale),
    );
    const points = Array.from({ length: geometry.attributes.position.count }, (_, index) =>
      new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, index).applyMatrix4(matrix));
    const outline = convexHull(points);
    const bounds = new THREE.Box3().setFromPoints(points);
    bounds.min.z -= 0.018 * pose.scale;
    const margin = 0.001;
    const planes = [
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -bounds.min.z + margin),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), bounds.max.z + margin),
      ...outline.map((point, index) => {
        const next = outline[(index + 1) % outline.length];
        const normal = new THREE.Vector3(point.y - next.y, next.x - point.x, 0).normalize();
        return new THREE.Plane(normal, -normal.dot(point) + margin);
      }),
    ];
    const corners = [-1, 1].flatMap(x => [-1, 1].map(y =>
      outline.reduce((best, point) => x * point.x + y * point.y > x * best.x + y * best.y ? point : best)));
    return { bounds: bounds.expandByScalar(margin), planes, corners };
  });
  geometry.dispose();
  return result;
}

function intersectsVolume(triangle: THREE.Vector3[], planes: THREE.Plane[]) {
  let polygon = triangle;
  for (const plane of planes) {
    const clipped: THREE.Vector3[] = [];
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index];
      const b = polygon[(index + 1) % polygon.length];
      const distanceA = plane.distanceToPoint(a);
      const distanceB = plane.distanceToPoint(b);
      if (distanceA >= 0) clipped.push(a);
      if ((distanceA >= 0) !== (distanceB >= 0)) {
        clipped.push(a.clone().lerp(b, distanceA / (distanceA - distanceB)));
      }
    }
    if (clipped.length === 0) return false;
    polygon = clipped;
  }
  return true;
}

function openingFrames() {
  return [...new Set([
    ...Array.from({ length: 157 }, (_, frame) => frame * 1000 / 120),
    0.001, 499.999, 500, 500.001, 1299.999, 1300,
  ])].sort((a, b) => a - b);
}

for (const count of [1, 2, 3] as const) {
  test(`${count}-card foil triangles stay outside every card through all 120 Hz extraction frames`, t => {
    setupCanvas(t);
    const model = createDogeFoilPackModel(count);
    t.after(() => model.dispose());
    const root = new THREE.Group();
    root.scale.set(2.35 / 2.45, 4.08 / 3.75, 1);
    root.add(model.group);
    const cards = cardVolumes(count);
    const parts = meshes(model.group);
    const flow = { ...createDogeFoilFlow(), stage: 'opening' as const, hitCount: 3, ready: true };
    const triangleBounds = new THREE.Box3();
    let comparisons = 0;
    for (const elapsed of openingFrames()) {
      model.update(sampleDogeFoilFlow(flow, elapsed));
      root.updateMatrixWorld(true);
      const visible = new Set<THREE.Object3D>();
      root.traverseVisible(object => visible.add(object));
      for (const part of parts) {
        if (!visible.has(part)) continue;
        const vertices = Array.from({ length: part.geometry.attributes.position.count }, (_, index) =>
          part.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(part.matrixWorld));
        const indices = part.geometry.index!;
        for (let index = 0; index < indices.count; index += 3) {
          const triangle = [vertices[indices.getX(index)], vertices[indices.getX(index + 1)], vertices[indices.getX(index + 2)]];
          triangleBounds.setFromPoints(triangle);
          for (let cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
            const card = cards[cardIndex];
            comparisons += 1;
            if (!triangleBounds.intersectsBox(card.bounds)) continue;
            assert.equal(intersectsVolume(triangle, card.planes), false,
              `${part.name} triangle ${index / 3} enters card ${cardIndex + 1} at ${elapsed.toFixed(3)} ms`);
          }
        }
      }
    }
    assert.ok(comparisons > 100_000);
  });

  test(`${count}-card corners remain behind the opaque sleeve until its torn mouth passes them`, t => {
    setupCanvas(t);
    const model = createDogeFoilPackModel(count);
    t.after(() => model.dispose());
    const root = new THREE.Group();
    root.scale.set(2.35 / 2.45, 4.08 / 3.75, 1);
    root.add(model.group);
    const front = meshes(model.group).find(part => part.name === 'foil-front');
    assert.ok(front);
    const positions = front.geometry.attributes.position;
    const localTop = Math.max(...Array.from({ length: positions.count }, (_, index) => positions.getY(index)));
    const mouth = Array.from({ length: positions.count }, (_, index) => index)
      .filter(index => positions.getY(index) > localTop - 0.08);
    const cards = cardVolumes(count);
    const bottom = Math.min(...cards.map(card => card.bounds.min.y));
    const flow = { ...createDogeFoilFlow(), stage: 'opening' as const, hitCount: 3, ready: true };
    const raycaster = new THREE.Raycaster();
    const intersections: THREE.Intersection[] = [];
    const initialBasis: number[] = [];
    let previousY = Infinity;
    let occludedCorners = 0;
    let cleared = false;
    for (const elapsed of openingFrames()) {
      model.update(sampleDogeFoilFlow(flow, elapsed));
      root.updateMatrixWorld(true);
      const vertices = Array.from({ length: positions.count }, (_, index) =>
        front.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(front.matrixWorld));
      const bounds = new THREE.Box3().setFromPoints(vertices);
      const mouthBottom = Math.min(...mouth.map(index => vertices[index].y));
      assert.ok(front.matrixWorld.elements[13] <= previousY + 1e-9, `Sleeve reverses at ${elapsed} ms`);
      previousY = front.matrixWorld.elements[13];
      if (bounds.max.y < bottom) cleared = true;
      if (!cleared) {
        const basis = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 14].map(index => front.matrixWorld.elements[index]);
        if (initialBasis.length === 0) initialBasis.push(...basis);
        assert.deepEqual(basis, initialBasis, `Sleeve rotates, shrinks, or moves sideways before clearing at ${elapsed} ms`);
        assert.equal(front.material.transparent, false);
        assert.equal(front.material.opacity, 1);
        assert.equal(front.material.depthTest, true);
        assert.equal(front.material.depthWrite, true);
      }
      for (const card of cards) {
        for (const corner of card.corners) {
          if (corner.y > mouthBottom - 0.1 || corner.y < bounds.min.y + 0.1) continue;
          raycaster.set(new THREE.Vector3(corner.x, corner.y, 5), new THREE.Vector3(0, 0, -1));
          intersections.length = 0;
          raycaster.intersectObject(front, false, intersections);
          assert.ok(intersections.length > 0 && intersections[0].point.z > corner.z + 0.001,
            `Card corner (${corner.x.toFixed(3)}, ${corner.y.toFixed(3)}) pierces the sleeve at ${elapsed.toFixed(3)} ms`);
          occludedCorners += 1;
        }
      }
    }
    assert.ok(occludedCorners > 100);
    assert.equal(cleared, true);
  });
}
