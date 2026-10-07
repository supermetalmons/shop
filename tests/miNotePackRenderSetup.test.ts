import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MI_NOTE_PACK_VARIANTS } from '../src/lib/miNoteCardReveal.ts';
import { MI_NOTE_PACK_STARS } from '../src/lib/miNotePackStars.ts';
import {
  MI_NOTE_PACK_RENDER_REGISTRY,
  applyMiNotePackRenderPose,
  getMiNotePackPresentation,
  getMiNotePackRenderSetup,
  getMiNotePackRenderSetupByPackId,
  restoreMiNotePackRenderCamera,
} from '../src/lib/miNotePackRenderSetup.ts';

test('all nine combinations share the standard consistent pose and camera', () => {
  const registry = MI_NOTE_PACK_RENDER_REGISTRY;
  assert.equal(registry.schemaVersion, 1);
  const baseline = [0.055, -0.12, -0.016].map(THREE.MathUtils.radToDeg);
  const camera = registry.setups['cobalt-blue--blush'].camera;
  const rotations = new Set<string>();
  for (const variant of MI_NOTE_PACK_VARIANTS) {
    for (const sticker of MI_NOTE_PACK_STARS) {
      const setup = getMiNotePackRenderSetup(variant.id, sticker.id);
      assert.ok(setup);
      assert.equal(setup.id, `${variant.id}--${sticker.id}`);
      assert.equal(setup.variantId, variant.id);
      assert.equal(setup.sticker.id, sticker.id);
      assert.equal(setup.sticker.source, sticker.src);
      assert.equal(setup.color, variant.color);
      assert.equal(setup.imageFilename, `${setup.packId}.png`);
      assert.equal(setup.model.rotationOrder, 'XYZ');
      assert.equal(setup.model.folderPhase, 0);
      assert.equal(setup.model.sealState, 'sealed');
      setup.model.rotationDegrees.forEach((angle, axis) => {
        assert.ok(Number.isFinite(angle));
        assert.ok(Math.abs(angle - baseline[axis]) < 1e-12);
      });
      assert.deepEqual(setup.model.position, [0, 0, 0]);
      assert.deepEqual(setup.model.scale, [1, 1, 1]);
      assert.deepEqual(setup.camera, camera);
      assert.equal('idleReference' in setup, false);
      rotations.add(JSON.stringify(setup.model.rotationDegrees));
      assert.equal(setup.camera.aspect, registry.shared.output.width / registry.shared.output.height);
      assert.ok(setup.camera.position.every(Number.isFinite));
      assert.ok(setup.camera.quaternion.every(Number.isFinite));
      assert.ok(setup.camera.near > 0 && setup.camera.far > setup.camera.near);
      assert.ok(setup.camera.fov > 0 && setup.camera.fov < 180);
    }
  }
  assert.equal(Object.keys(registry.setups).length, 9);
  assert.equal(rotations.size, 1);
  assert.equal(getMiNotePackRenderSetup('missing', 'blush'), undefined);
});

test('permanent pack IDs resolve the exact color, sticker, image, and complete 3D setup', () => {
  const mapping = [
    [1, 'cobalt-blue', 'blush'], [2, 'cobalt-blue', 'zombie'], [3, 'cobalt-blue', 'supermetal'],
    [4, 'marigold', 'blush'], [5, 'marigold', 'zombie'], [6, 'marigold', 'supermetal'],
    [7, 'emerald', 'blush'], [8, 'emerald', 'zombie'], [9, 'emerald', 'supermetal'],
  ] as const;
  const originalSetups = MI_NOTE_PACK_RENDER_REGISTRY.setups;
  try {
    for (const setups of [originalSetups, Object.fromEntries(Object.entries(originalSetups).reverse())]) {
      MI_NOTE_PACK_RENDER_REGISTRY.setups = setups;
      assert.deepEqual(Object.values(setups).map(setup => setup.packId).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      for (const [packId, variantId, stickerId] of mapping) {
        const setup = getMiNotePackRenderSetupByPackId(packId);
        assert.ok(setup);
        assert.equal(setup.packId, packId);
        assert.equal(setup.variantId, variantId);
        assert.equal(setup.sticker.id, stickerId);
        assert.equal(setup.imageFilename, `${packId}.png`);
        assert.equal(setup, getMiNotePackRenderSetup(variantId, stickerId));
        assert.equal(setup, setups[`${variantId}--${stickerId}`]);
      }
    }
  } finally {
    MI_NOTE_PACK_RENDER_REGISTRY.setups = originalSetups;
  }
  for (const value of [-1, 0, 10, 1.5, NaN, Infinity, -Infinity, '1', null, undefined]) {
    assert.equal(getMiNotePackRenderSetupByPackId(value as number), undefined);
  }
});

test('restoring a serialized pose reproduces root transform without mutating the preset', () => {
  const setup = structuredClone(MI_NOTE_PACK_RENDER_REGISTRY.setups['emerald--zombie']);
  setup.model.position = [0.2, -0.1, 0.3];
  setup.model.scale = [0.9, 1.1, 1.2];
  const serialized = JSON.stringify(setup);
  const group = new THREE.Group();
  const flipRoot = new THREE.Group();
  let folderPhase = -1;
  applyMiNotePackRenderPose({ group, flipRoot, setFolderPhase: (value) => { folderPhase = value; } }, JSON.parse(serialized));
  assert.deepEqual(group.position.toArray(), setup.model.position);
  assert.deepEqual(group.scale.toArray(), setup.model.scale);
  const expected = new THREE.Euler(...setup.model.rotationDegrees.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ');
  assert.ok(group.quaternion.angleTo(new THREE.Quaternion().setFromEuler(expected)) < 1e-7);
  assert.equal(folderPhase, 0);
  assert.equal(flipRoot.rotation.y, setup.model.flipRotationY);
  assert.equal(JSON.stringify(setup), serialized);
});

test('responsive camera projection matches centered PNG pixels at varied aspect ratios', () => {
  const output = MI_NOTE_PACK_RENDER_REGISTRY.shared.output;
  for (const setup of Object.values(MI_NOTE_PACK_RENDER_REGISTRY.setups)) {
    const sourceCamera = new THREE.PerspectiveCamera();
    restoreMiNotePackRenderCamera(sourceCamera, setup);
    const sourcePoints = [new THREE.Vector3(-0.4, 0.6, 0), new THREE.Vector3(0.5, -0.7, 0.03), new THREE.Vector3(0, 0, 0.02)];
    for (const [width, height] of [[900, 700], [390, 844], [1800, 2400], [320, 480], [1500, 500]]) {
      const presentation = getMiNotePackPresentation(setup, width, height);
      assert.ok(presentation.height * setup.framing.alphaBounds.height / output.height <= height * 0.52 + 1e-8);
      assert.ok(presentation.width * setup.framing.alphaBounds.width / output.width <= width * 0.68 + 1e-8);
      const liveCamera = new THREE.PerspectiveCamera();
      restoreMiNotePackRenderCamera(liveCamera, setup);
      liveCamera.aspect = width / height;
      liveCamera.zoom = presentation.zoom;
      liveCamera.updateProjectionMatrix();
      for (const point of sourcePoints) {
        const source = point.clone().project(sourceCamera);
        const live = point.clone().project(liveCamera);
        const desiredX = presentation.left + (source.x + 1) * presentation.width / 2;
        const desiredY = presentation.top + (1 - source.y) * presentation.height / 2;
        assert.ok(Math.abs((live.x + 1) * width / 2 - desiredX) < 1e-8);
        assert.ok(Math.abs((1 - live.y) * height / 2 - desiredY) < 1e-8);
      }
    }
  }
});

test('camera restore keeps translated camera orientation rather than aiming at the origin', () => {
  const setup = structuredClone(MI_NOTE_PACK_RENDER_REGISTRY.setups['marigold--blush']);
  setup.camera.position = [0.2, -0.07, 3.4];
  setup.camera.quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.01, 0.02, -0.03)).toArray();
  setup.camera.zoom = 1.2;
  const camera = new THREE.PerspectiveCamera();
  restoreMiNotePackRenderCamera(camera, JSON.parse(JSON.stringify(setup)));
  assert.deepEqual(camera.position.toArray(), setup.camera.position);
  assert.deepEqual(camera.quaternion.toArray(), setup.camera.quaternion);
  assert.equal(camera.zoom, 1.2);
  assert.equal(camera.aspect, setup.camera.aspect);
  const aimed = camera.clone();
  aimed.lookAt(0, 0, 0);
  assert.ok(camera.quaternion.angleTo(aimed.quaternion) > 0.01);
});
