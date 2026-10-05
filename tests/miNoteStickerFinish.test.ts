import assert from 'node:assert/strict';
import test from 'node:test';
import { createMiNoteStickerFinish } from '../src/lib/miNoteStickerFinish.ts';

function artwork(width: number, height: number) {
  const source = new Uint8ClampedArray(width * height * 4);
  const set = (x: number, y: number, rgba: number[]) => source.set(rgba, (y * width + x) * 4);
  const pixel = (pixels: Uint8ClampedArray, x: number, y: number) => Array.from(pixels.subarray((y * width + x) * 4, (y * width + x + 1) * 4));
  return { source, set, pixel };
}

test('the rim expands equally in every direction with a rounded antialiased cut', () => {
  const { source, set, pixel } = artwork(41, 41);
  set(20, 20, [210, 70, 30, 255]);
  const { pixels, finish } = createMiNoteStickerFinish(source, 41, 41, 8);
  for (const [dx, dy] of [[8, 0], [-8, 0], [0, 8], [0, -8], [5, 5], [-5, -5]]) {
    assert.equal(pixel(pixels, 20 + dx, 20 + dy)[3], 255);
  }
  for (const [dx, dy] of [[9, 0], [-9, 0], [0, 9], [0, -9], [8, 8]]) {
    assert.equal(pixel(pixels, 20 + dx, 20 + dy)[3], 0);
    assert.deepEqual(pixel(finish, 20 + dx, 20 + dy), [0, 0, 0, 255]);
  }
  const diagonal = pixel(pixels, 26, 26)[3];
  assert.ok(diagonal > 0 && diagonal < 255);
  assert.equal(pixel(pixels, 14, 14)[3], diagonal);
  assert.equal(pixel(finish, 26, 26)[1], diagonal);
});

test('opaque artwork keeps its color while partial alpha composites over the metal backing', () => {
  const { source, set, pixel } = artwork(25, 25);
  set(12, 12, [241, 37, 119, 255]);
  set(13, 12, [240, 80, 20, 128]);
  const original = source.slice();
  const { pixels, finish } = createMiNoteStickerFinish(source, 25, 25, 5);
  assert.deepEqual(source, original);
  assert.deepEqual(pixel(pixels, 12, 12), [241, 37, 119, 255]);
  assert.equal(pixel(finish, 12, 12)[0], 76);
  assert.equal(pixel(finish, 12, 12)[1], 0);
  const blended = pixel(pixels, 13, 12);
  assert.equal(blended[3], 255);
  assert.ok(blended[0] > 42 && blended[0] < 240);
  assert.ok(blended[1] > 48 && blended[1] < 80);
  assert.ok(blended[2] > 20 && blended[2] < 56);
  assert.equal(pixel(finish, 13, 12)[1], 127);
});

test('the thick rim has a raised crown, a dark inner seam, and a pale outer lip', () => {
  const { source, set, pixel } = artwork(81, 81);
  set(40, 40, [200, 100, 50, 255]);
  const { pixels, finish } = createMiNoteStickerFinish(source, 81, 81);
  const face = pixel(finish, 40, 40)[0];
  const middle = pixel(finish, 52, 40)[0];
  const outer = pixel(finish, 64, 40)[0];
  assert.ok(middle > face + 100);
  assert.ok(outer < face);
  assert.ok(pixel(pixels, 41, 40)[0] < pixel(pixels, 52, 40)[0]);
  assert.ok(pixel(pixels, 64, 40)[0] > pixel(pixels, 52, 40)[0] + 40);
  assert.equal(pixel(finish, 52, 40)[1], 255);
  assert.equal(pixel(pixels, 65, 40)[3], 0);
});

test('canvas boundaries never wrap the silhouette onto another row or edge', () => {
  const { source, set, pixel } = artwork(23, 17);
  set(0, 0, [220, 50, 100, 255]);
  set(22, 16, [50, 180, 100, 255]);
  const { pixels, finish } = createMiNoteStickerFinish(source, 23, 17, 3);
  for (const [x, y] of [[22, 0], [0, 16], [22, 1], [0, 15]]) {
    assert.equal(pixel(pixels, x, y)[3], 0);
    assert.deepEqual(pixel(finish, x, y), [0, 0, 0, 255]);
  }
  assert.deepEqual(pixel(pixels, 0, 0), [220, 50, 100, 255]);
  assert.deepEqual(pixel(pixels, 22, 16), [50, 180, 100, 255]);
  assert.equal(pixel(pixels, 3, 0)[3], 255);
  assert.equal(pixel(pixels, 19, 16)[3], 255);
});

test('a padded silhouette leaves the canvas perimeter transparent and finish masks agree with alpha', () => {
  const { source, set, pixel } = artwork(96, 96);
  for (let y = 32; y < 64; y += 1) for (let x = 32; x < 64; x += 1) set(x, y, [45, 123, 205, 255]);
  const { pixels, finish } = createMiNoteStickerFinish(source, 96, 96);
  for (let coordinate = 0; coordinate < 96; coordinate += 1) {
    for (const [x, y] of [[coordinate, 0], [coordinate, 95], [0, coordinate], [95, coordinate]]) assert.equal(pixel(pixels, x, y)[3], 0);
  }
  for (let index = 0; index < pixels.length; index += 4) {
    assert.equal(finish[index + 2], 0);
    assert.equal(finish[index + 3], 255);
    assert.ok(finish[index + 1] <= pixels[index + 3]);
    if (pixels[index + 3] === 0) assert.deepEqual(Array.from(finish.subarray(index, index + 3)), [0, 0, 0]);
    if (source[index + 3] === 255) assert.equal(finish[index + 1], 0);
  }
});

test('empty artwork remains empty and a zero-width rim preserves the original alpha', () => {
  const { source, set } = artwork(9, 7);
  const empty = createMiNoteStickerFinish(source, 9, 7);
  assert.deepEqual(empty.pixels, source);
  assert.ok(empty.finish.every((value, index) => value === (index % 4 === 3 ? 255 : 0)));
  set(4, 3, [30, 80, 160, 125]);
  const { pixels, finish } = createMiNoteStickerFinish(source, 9, 7, 0);
  assert.deepEqual(pixels, source);
  for (let index = 1; index < finish.length; index += 4) assert.equal(finish[index], 0);
});
