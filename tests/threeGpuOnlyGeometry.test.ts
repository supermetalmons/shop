import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { releaseObjectGeometryCpuBuffersAfterUpload } from '../src/lib/threeGpuOnlyGeometry.ts';

test('GPU-only geometry retains bounds and releases decoded arrays after upload', () => {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute(
    [-1, -2, 0, 1, -2, 0, 0, 2, 0],
    3,
  );
  const index = new THREE.Uint16BufferAttribute([0, 1, 2], 1);
  geometry.setAttribute('position', position);
  geometry.setIndex(index);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));

  releaseObjectGeometryCpuBuffersAfterUpload(root);

  assert.deepEqual(geometry.boundingBox?.min.toArray(), [-1, -2, 0]);
  assert.deepEqual(geometry.boundingBox?.max.toArray(), [1, 2, 0]);
  assert.ok(geometry.boundingSphere);
  assert.ok(position.array);
  assert.ok(index.array);

  position.onUploadCallback();
  index.onUploadCallback();

  assert.equal((position as unknown as { array: ArrayBufferView | null }).array, null);
  assert.equal((index as unknown as { array: ArrayBufferView | null }).array, null);
});
