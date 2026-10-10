import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import registry from '../src/lib/miNotePackRenderSetups.json' with { type: 'json' };
import { getMiNotePackPreviewOriginRect, getMiNotePackPreviewRect, getMiNotePackPreviewTransform } from '../src/lib/miNotePackPreviewLayout.ts';

function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);
}

const viewports = [[390, 844], [320, 480], [80, 1200], [900, 700], [1500, 500], [1800, 2400], [1, 1]] as const;
const points = [new THREE.Vector3(-0.6, 0.9, 0), new THREE.Vector3(0.5, -0.7, 0), new THREE.Vector3(0, 0, 0)];

for (const setup of Object.values(registry.setups)) {
  test(`pack ${setup.packId} preview matches the unchanged viewer projection on the reference plane`, () => {
    const original = JSON.stringify(setup);
    const source = new THREE.PerspectiveCamera(setup.camera.fov, setup.camera.aspect, setup.camera.near, setup.camera.far);
    source.position.fromArray(setup.camera.position);
    source.quaternion.fromArray(setup.camera.quaternion);
    source.zoom = setup.camera.zoom;
    source.updateProjectionMatrix();
    source.updateMatrixWorld(true);
    for (const [width, height] of viewports) {
      const viewer = new THREE.PerspectiveCamera(34, width / height, 0.1, 40);
      const closedHeight = Math.max(1.82 / 0.52, 1.29 / (viewer.aspect * 0.68));
      viewer.position.z = closedHeight / (2 * Math.tan(THREE.MathUtils.degToRad(viewer.fov / 2)));
      viewer.updateMatrixWorld(true);
      const preview = getMiNotePackPreviewRect(setup, width, height);
      close(preview.width / preview.height, registry.shared.output.width / registry.shared.output.height);
      for (const point of points) {
        const rendered = point.clone().project(source);
        const live = point.clone().project(viewer);
        close(preview.left + (rendered.x + 1) * preview.width / 2, (live.x + 1) * width / 2);
        close(preview.top + (1 - rendered.y) * preview.height / 2, (1 - live.y) * height / 2);
      }
    }
    assert.equal(JSON.stringify(setup), original);
  });
}

test('source FOV, zoom, camera offsets, and output dimensions affect the projection', () => {
  const setup = { camera: { position: [0.3, -0.2, 4] as const, fov: 49, zoom: 1.3 } };
  const output = { width: 1200, height: 800 };
  const source = new THREE.PerspectiveCamera(setup.camera.fov, output.width / output.height, 0.1, 40);
  source.position.fromArray(setup.camera.position);
  source.zoom = setup.camera.zoom;
  source.updateProjectionMatrix();
  source.updateMatrixWorld(true);
  const viewer = new THREE.PerspectiveCamera(34, 800 / 600, 0.1, 40);
  viewer.position.z = (1.82 / 0.52) / (2 * Math.tan(THREE.MathUtils.degToRad(17)));
  viewer.updateMatrixWorld(true);
  const preview = getMiNotePackPreviewRect(setup, 800, 600, output);
  for (const point of points) {
    const rendered = point.clone().project(source);
    const live = point.clone().project(viewer);
    close(preview.left + (rendered.x + 1) * preview.width / 2, (live.x + 1) * 800 / 2);
    close(preview.top + (1 - rendered.y) * preview.height / 2, (1 - live.y) * 600 / 2);
  }
});

test('synthesized origin uniformly maps the off-center preview onto the contained inventory image', () => {
  const target = Object.freeze({ left: 37, top: 61, width: 390, height: 844 });
  const preview = Object.freeze(getMiNotePackPreviewRect(registry.setups['cobalt-blue--blush'], target.width, target.height));
  for (const origin of [
    Object.freeze({ left: 47, top: 153, width: 240, height: 100 }),
    Object.freeze({ left: 88, top: 402, width: 80, height: 260 }),
  ]) {
    const before = JSON.stringify({ origin, target, preview });
    const frame = getMiNotePackPreviewOriginRect(origin, target, preview);
    const scaleX = frame.width / target.width;
    const scaleY = frame.height / target.height;
    close(scaleX, scaleY);
    const containedHeight = Math.min(origin.height, origin.width / (registry.shared.output.width / registry.shared.output.height));
    const containedWidth = containedHeight * registry.shared.output.width / registry.shared.output.height;
    close(frame.left + preview.left * scaleX, origin.left + (origin.width - containedWidth) / 2);
    close(frame.top + preview.top * scaleY, origin.top + (origin.height - containedHeight) / 2);
    close(preview.width * scaleX, containedWidth);
    close(preview.height * scaleY, containedHeight);
    assert.equal(JSON.stringify({ origin, target, preview }), before);
  }
});

for (const reducedMotion of [false, true]) {
  test(`preview homography matches the actual closed front cover with reduced motion ${reducedMotion}`, () => {
    const original = JSON.stringify(registry);
    for (const setup of Object.values(registry.setups)) {
      const source = new THREE.PerspectiveCamera(setup.camera.fov, setup.camera.aspect, setup.camera.near, setup.camera.far);
      source.position.fromArray(setup.camera.position);
      source.quaternion.fromArray(setup.camera.quaternion);
      source.zoom = setup.camera.zoom;
      source.updateProjectionMatrix();
      source.updateMatrixWorld(true);
      const sourcePose = new THREE.Euler(...setup.model.rotationDegrees.map(THREE.MathUtils.degToRad) as [number, number, number], 'XYZ');
      const targetPose = reducedMotion ? new THREE.Euler() : new THREE.Euler(0.055, -0.12, -0.016, 'XYZ');
      for (const [width, height] of viewports) {
        const viewer = new THREE.PerspectiveCamera(34, width / height, 0.1, 40);
        const closedHeight = Math.max(1.82 / 0.52, 1.29 / (viewer.aspect * 0.68));
        viewer.position.z = closedHeight / (2 * Math.tan(THREE.MathUtils.degToRad(viewer.fov / 2)));
        viewer.updateMatrixWorld(true);
        const preview = getMiNotePackPreviewRect(setup, width, height);
        const transform = getMiNotePackPreviewTransform(setup, width, height, reducedMotion);
        const matrix = transform.slice('matrix3d('.length, -1).split(',').map(Number);
        assert.equal(matrix.length, 16);
        assert.ok(matrix.every(Number.isFinite));
        for (const [x, y] of [[-1.29 / 2, -1.82 / 2], [1.29 / 2, -1.82 / 2],
          [1.29 / 2, 1.82 / 2], [-1.29 / 2, 1.82 / 2], [0.13, -0.27]]) {
          const coverPoint = new THREE.Vector3(x, y, 0.0158 + 0.0018 / 2);
          const sourcePoint = coverPoint.clone().multiply(new THREE.Vector3().fromArray(setup.model.scale))
            .applyEuler(sourcePose).add(new THREE.Vector3().fromArray(setup.model.position)).project(source);
          const live = coverPoint.clone().applyEuler(targetPose).project(viewer);
          const localX = (sourcePoint.x + 1) * preview.width / 2;
          const localY = (1 - sourcePoint.y) * preview.height / 2;
          const denominator = matrix[3] * localX + matrix[7] * localY + matrix[15];
          assert.ok(denominator > 0);
          const mappedX = (matrix[0] * localX + matrix[4] * localY + matrix[12]) / denominator;
          const mappedY = (matrix[1] * localX + matrix[5] * localY + matrix[13]) / denominator;
          close(preview.left + mappedX, (live.x + 1) * width / 2);
          close(preview.top + mappedY, (1 - live.y) * height / 2);
        }
      }
    }
    assert.equal(JSON.stringify(registry), original);
  });
}
