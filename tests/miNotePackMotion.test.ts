import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import {
  createMiNotePackModel,
  MI_NOTE_CARD_HEIGHT,
  MI_NOTE_LEAF_WIDTH,
  MI_NOTE_POCKET_TOP,
  sampleMiNoteFolderPose,
} from '../src/lib/miNotePackModel.ts';
import { createMiNoteCardPath, poseMiNoteCardPath } from '../src/lib/miNotePackMotion.ts';

function near(actual: number, expected: number, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

function nearVector(actual: THREE.Vector3, expected: THREE.Vector3, tolerance = 1e-10) {
  assert.ok(actual.distanceTo(expected) <= tolerance, `${actual.toArray()} differs from ${expected.toArray()}`);
}

function nearQuaternion(actual: THREE.Quaternion, expected: THREE.Quaternion) {
  near(1 - Math.abs(actual.dot(expected)), 0);
}

function leafBounds(phase: number) {
  const pose = sampleMiNoteFolderPose(phase);
  const corners: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side < 0 ? pose.frontAngle : -pose.backAngle);
    const position = side < 0 ? pose.leftPosition : pose.rightPosition;
    for (const x of [0, side * MI_NOTE_LEAF_WIDTH]) {
      corners.push(new THREE.Vector3(x, 0, 0).applyQuaternion(rotation).add(position).add(new THREE.Vector3(pose.bookX, 0, 0)));
    }
  }
  return new THREE.Box3().setFromPoints(corners);
}

test('folder front, open, and back poses keep both closures centered and hinges connected', () => {
  const front = sampleMiNoteFolderPose(0);
  const open = sampleMiNoteFolderPose(1);
  const back = sampleMiNoteFolderPose(2);
  near(front.frontAngle, Math.PI);
  near(front.backAngle, 0);
  near(open.frontAngle, 0);
  near(open.backAngle, 0);
  near(back.frontAngle, 0);
  near(back.backAngle, Math.PI);
  near(front.leftPosition.z, 0.0158);
  near(back.rightPosition.z, 0.0158);
  nearVector(open.leftPosition, new THREE.Vector3());
  nearVector(open.rightPosition, new THREE.Vector3());
  for (const phase of [0, 2]) {
    const bounds = leafBounds(phase);
    near(bounds.getCenter(new THREE.Vector3()).x, 0);
    near(bounds.getSize(new THREE.Vector3()).x, MI_NOTE_LEAF_WIDTH);
  }
  near(leafBounds(1).getSize(new THREE.Vector3()).x, MI_NOTE_LEAF_WIDTH * 2);
  near(front.spread, 0);
  near(back.spread, 0);
  near(open.spread, 1);
});

test('folder poses stay symmetric through either hinge and clamp at each closed cover', () => {
  for (const phase of [0, 0.2, 0.5, 0.9, 1]) {
    const front = sampleMiNoteFolderPose(phase);
    const back = sampleMiNoteFolderPose(2 - phase);
    near(front.frontAngle, back.backAngle);
    near(front.bookX, -back.bookX);
    near(front.leftPosition.x, -back.rightPosition.x);
    near(front.leftPosition.z, back.rightPosition.z);
    near(front.spread, back.spread);
  }
  assert.deepEqual(sampleMiNoteFolderPose(-4), sampleMiNoteFolderPose(0));
  assert.deepEqual(sampleMiNoteFolderPose(7), sampleMiNoteFolderPose(2));
});

function setupArtwork(t: TestContext) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const context = {
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }),
    putImageData() {},
    drawImage() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
  };
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
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
      removeAttribute() {}
    },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousImage) Object.defineProperty(globalThis, 'Image', previousImage);
    else Reflect.deleteProperty(globalThis, 'Image');
  });
}

test('model retains the seal, pocket geometry, and picking metadata through both closures and outer flips', async (t) => {
  setupArtwork(t);
  const model = createMiNotePackModel({
    color: '#3559b7',
    star: { id: 'test', name: 'Test star', src: '/star.png', foldPosition: 0.573, rotationOffsetDegrees: 0, sizeScale: 1 },
    foldPosition: 0.573,
    rotationOffsetDegrees: 0,
  });
  t.after(() => model.dispose());
  await model.ready;
  assert.equal(model.flipRoot.parent, model.group);
  assert.equal(model.left.parent?.parent, model.flipRoot);
  const seal = model.right.children.at(-1)!;
  assert.ok(seal.children[0] instanceof THREE.Mesh);
  for (const phase of [0, 0.5, 1, 1.5, 2, 1, 0]) {
    model.setFolderPhase(phase);
    model.flipRoot.rotation.y = phase * Math.PI / 2;
    model.group.updateMatrixWorld(true);
    assert.equal(seal.parent, model.right);
    assert.equal(seal.visible, true);
    for (const [leaf, target] of [[model.left, 0], [model.right, 2]] as const) {
      leaf.traverse((object) => {
        assert.equal(object.userData.leaf, target);
        assert.ok(object.matrixWorld.elements.every(Number.isFinite));
        if (object instanceof THREE.Mesh) {
          for (const attribute of [object.geometry.attributes.position, object.geometry.attributes.normal]) {
            assert.ok(Array.from(attribute.array as Float32Array).every(Number.isFinite));
          }
        }
      });
    }
  }
});

function tiltedPath(side: number) {
  const parent = new THREE.Group();
  parent.position.set(0.13, -0.07, 0.11);
  parent.rotation.set(0.33, -0.41, 0.27);
  parent.updateMatrixWorld(true);
  const home = parent.localToWorld(new THREE.Vector3(side * MI_NOTE_LEAF_WIDTH / 2, -0.005, 0.0057));
  const pocket = parent.localToWorld(new THREE.Vector3(side * MI_NOTE_LEAF_WIDTH / 2, MI_NOTE_POCKET_TOP, 0.0057));
  const rotation = parent.getWorldQuaternion(new THREE.Quaternion());
  const destination = new THREE.Vector3(0, 0, 1.4);
  const path = createMiNoteCardPath(home, rotation, pocket, destination);
  return { path, home, pocket, rotation, destination };
}

test('either card lifts along its tilted pocket without turning or growing before clearing the lip', () => {
  for (const side of [-1, 1]) {
    const { path, home, pocket, rotation } = tiltedPath(side);
    const anchor = new THREE.Group();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
    for (const progress of [0, 0.1, 0.25, 0.4]) {
      poseMiNoteCardPath(anchor, path, progress);
      const delta = anchor.position.clone().sub(home);
      near(delta.clone().cross(up).length(), 0);
      nearQuaternion(anchor.quaternion, rotation);
      near(anchor.scale.x, 1);
    }
    const bottom = anchor.position.clone().addScaledVector(up, -MI_NOTE_CARD_HEIGHT / 2);
    near(bottom.sub(pocket).dot(up), 0.085);
    poseMiNoteCardPath(anchor, path, 0.592);
    nearQuaternion(anchor.quaternion, rotation);
    near(anchor.scale.x, 1);
    assert.ok(anchor.position.z > path.lift.z);
  }
});

test('extraction starts in its pocket, ends centered at inspection size, and owns its input values', () => {
  const { path, home, rotation, destination } = tiltedPath(-1);
  const originalHome = home.clone();
  const originalRotation = rotation.clone();
  const originalDestination = destination.clone();
  home.set(9, 9, 9);
  rotation.identity();
  destination.set(8, 8, 8);
  const anchor = new THREE.Group();
  poseMiNoteCardPath(anchor, path, -1);
  nearVector(anchor.position, originalHome);
  nearQuaternion(anchor.quaternion, originalRotation);
  near(anchor.scale.x, 1);
  poseMiNoteCardPath(anchor, path, 2);
  nearVector(anchor.position, originalDestination);
  nearQuaternion(anchor.quaternion, new THREE.Quaternion());
  near(anchor.scale.x, 1.28);
});

test('straight lift enters the forward curve with continuous position and velocity', () => {
  const { path } = tiltedPath(1);
  const anchor = new THREE.Group();
  const epsilon = 1e-6;
  poseMiNoteCardPath(anchor, path, 0.4 - epsilon);
  const before = anchor.position.clone();
  poseMiNoteCardPath(anchor, path, 0.4);
  const middle = anchor.position.clone();
  poseMiNoteCardPath(anchor, path, 0.4 + epsilon);
  const after = anchor.position.clone();
  nearVector(middle, path.lift);
  nearVector(middle.clone().sub(before).divideScalar(epsilon), after.sub(middle).divideScalar(epsilon), 0.00003);
});

test('the same path reverses exactly into either original pocket and restores its transform', () => {
  for (const side of [-1, 1]) {
    const { path, home, rotation } = tiltedPath(side);
    const anchor = new THREE.Group();
    const progressValues = [0, 0.13, 0.4, 0.6, 0.83, 1];
    const outward = progressValues.map((progress) => {
      poseMiNoteCardPath(anchor, path, progress);
      return { position: anchor.position.clone(), rotation: anchor.quaternion.clone(), scale: anchor.scale.clone() };
    });
    for (let index = progressValues.length - 1; index >= 0; index -= 1) {
      poseMiNoteCardPath(anchor, path, progressValues[index]);
      nearVector(anchor.position, outward[index].position);
      nearQuaternion(anchor.quaternion, outward[index].rotation);
      nearVector(anchor.scale, outward[index].scale);
    }
    nearVector(anchor.position, home);
    nearQuaternion(anchor.quaternion, rotation);
    nearVector(anchor.scale, new THREE.Vector3(1, 1, 1));
  }
});
