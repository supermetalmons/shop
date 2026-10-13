import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearCardPreviewPixelBounds,
  resolveClearCardPreviewTransform,
  type ClearCardPreviewImage,
  type ClearCardPreviewModel,
} from '../src/lib/clearCardPreviewLayout.ts';

test('image and WebGL alpha bounds resolve to the same top-left coordinate system', () => {
  const pixels = new Uint8Array(4 * 6 * 4);
  for (let y = 1; y <= 2; y += 1) {
    for (let x = 1; x <= 2; x += 1) pixels[(y * 4 + x) * 4 + 3] = 255;
  }
  assert.deepEqual(clearCardPreviewPixelBounds(pixels, 4, 6), {
    left: 1 / 4, top: 1 / 6, width: 1 / 2, height: 1 / 3,
  });
  assert.deepEqual(clearCardPreviewPixelBounds(pixels, 4, 6, true), {
    left: 1 / 4, top: 1 / 2, width: 1 / 2, height: 1 / 3,
  });
  assert.equal(clearCardPreviewPixelBounds(new Uint8Array(24), 2, 3), null);
});

for (const viewport of [{ width: 400, height: 560 }, { width: 281.5, height: 394.1 }]) {
  for (const aspectRatio of [0.72, 1362 / 1400, 1.6]) {
    test(`rendered bounds match contained preview edges for ${viewport.width}px viewport and ${aspectRatio} aspect`, () => {
      const image: ClearCardPreviewImage = {
        aspectRatio,
        bounds: { left: 0.018, top: 0.027, width: 0.95, height: 0.956 },
      };
      const model: ClearCardPreviewModel = {
        bounds: { left: 0.161, top: 0.199, width: 0.633, height: 0.605 },
        canvas: { left: -viewport.width / 4, top: -viewport.height / 4, width: viewport.width * 1.5, height: viewport.height * 1.5 },
        viewport,
      };
      const transform = resolveClearCardPreviewTransform(image, model);
      assert.ok(transform);
      const imageWidth = Math.min(viewport.width, viewport.height * aspectRatio);
      const imageHeight = imageWidth / aspectRatio;
      const expected = [
        (viewport.width - imageWidth) / 2 + image.bounds.left * imageWidth,
        (viewport.height - imageHeight) / 2 + image.bounds.top * imageHeight,
        image.bounds.width * imageWidth,
        image.bounds.height * imageHeight,
      ];
      const actual = [
        model.canvas.left + transform.x + model.bounds.left * model.canvas.width * transform.scaleX,
        model.canvas.top + transform.y + model.bounds.top * model.canvas.height * transform.scaleY,
        model.bounds.width * model.canvas.width * transform.scaleX,
        model.bounds.height * model.canvas.height * transform.scaleY,
      ];
      actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9));
    });
  }
}

test('invalid or empty preview measurements leave the existing model framing available', () => {
  const image = { aspectRatio: 1, bounds: { left: 0, top: 0, width: 1, height: 1 } };
  const model = { bounds: image.bounds, canvas: image.bounds, viewport: { width: 100, height: 100 } };
  assert.equal(resolveClearCardPreviewTransform({ ...image, aspectRatio: 0 }, model), null);
  assert.equal(resolveClearCardPreviewTransform(image, { ...model, bounds: { ...image.bounds, width: 0 } }), null);
  assert.equal(resolveClearCardPreviewTransform(image, { ...model, canvas: { ...image.bounds, left: NaN } }), null);
});
