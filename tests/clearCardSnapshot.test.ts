import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findOpaquePixelBounds,
  padPixelBounds,
  resolveSnapshotOutputSize,
} from '../src/lib/clearCardSnapshot.ts';

function rgbaPixels(width: number, height: number, opaquePixels: Array<[number, number]>) {
  const pixels = new Uint8Array(width * height * 4);
  opaquePixels.forEach(([x, y]) => {
    const sourceY = height - 1 - y;
    pixels[(sourceY * width + x) * 4 + 3] = 255;
  });
  return pixels;
}

test('findOpaquePixelBounds returns null for a fully transparent image', () => {
  assert.equal(findOpaquePixelBounds(new Uint8Array(4 * 5 * 4), 4, 5), null);
});

test('findOpaquePixelBounds converts bottom-up WebGL rows to top-left bounds', () => {
  const pixels = rgbaPixels(6, 7, [
    [1, 2],
    [4, 5],
  ]);

  assert.deepEqual(findOpaquePixelBounds(pixels, 6, 7), {
    x: 1,
    y: 2,
    width: 4,
    height: 4,
  });
});

test('padPixelBounds adds two percent per side and clamps to the image', () => {
  assert.deepEqual(
    padPixelBounds({ x: 20, y: 30, width: 100, height: 200 }, 300, 400, 0.02),
    { x: 18, y: 26, width: 104, height: 208 },
  );
  assert.deepEqual(
    padPixelBounds({ x: 0, y: 1, width: 100, height: 100 }, 100, 100, 0.02),
    { x: 0, y: 0, width: 100, height: 100 },
  );
});

test('resolveSnapshotOutputSize fixes the longest edge at 2048 pixels', () => {
  assert.deepEqual(resolveSnapshotOutputSize({ x: 0, y: 0, width: 400, height: 200 }, 2048), {
    width: 2048,
    height: 1024,
  });
  assert.deepEqual(resolveSnapshotOutputSize({ x: 0, y: 0, width: 150, height: 300 }, 2048), {
    width: 1024,
    height: 2048,
  });
});
