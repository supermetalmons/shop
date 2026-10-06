import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMiNoteStickerFinish,
  MI_NOTE_STICKER_EDGE_DISTANCE,
  MI_NOTE_STICKER_OUTLINE_SUPPORT,
} from '../src/lib/miNoteStickerFinish.ts';

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
    const empty = pixel(finish, 20 + dx, 20 + dy);
    assert.deepEqual(empty.slice(0, 2), [0, 0]);
    assert.ok(empty[2] < 128);
    assert.equal(empty[3], 0);
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
  assert.equal(pixel(finish, 12, 12)[3], 255);
  const blended = pixel(pixels, 13, 12);
  assert.equal(blended[3], 255);
  assert.ok(blended[0] > 208 && blended[0] < 240);
  assert.ok(blended[1] > 80 && blended[1] < 220);
  assert.ok(blended[2] > 20 && blended[2] < 231);
  assert.equal(pixel(finish, 13, 12)[1], 127);
  assert.equal(pixel(finish, 13, 12)[3], 128);
});

test('the default rim is a narrow pale silver edge with a shallow bevel', () => {
  const { source, set, pixel } = artwork(41, 41);
  set(20, 20, [200, 100, 50, 255]);
  const { pixels, finish } = createMiNoteStickerFinish(source, 41, 41);
  const face = pixel(finish, 20, 20)[0];
  const middle = pixel(finish, 23, 20)[0];
  const outer = pixel(finish, 25, 20)[0];
  assert.ok(middle > face && middle <= face + 16);
  assert.ok(outer < face);
  for (let distance = 1; distance <= 5; distance += 1) {
    const rim = pixel(pixels, 20 + distance, 20);
    assert.equal(rim[3], 255);
    assert.ok(rim[0] >= 208 && rim[0] <= 236);
    assert.ok(rim[1] >= 220 && rim[1] <= 242);
    assert.ok(rim[2] >= 231 && rim[2] <= 248);
    assert.equal(pixel(finish, 20 + distance, 20)[1], 255);
    if (distance > 1) assert.ok(rim[0] >= pixel(pixels, 19 + distance, 20)[0]);
  }
  assert.equal(pixel(pixels, 26, 20)[3], 0);
  assert.equal(pixel(pixels, 14, 20)[3], 0);
  assert.equal(pixel(pixels, 20, 26)[3], 0);
  assert.equal(pixel(pixels, 20, 14)[3], 0);
});

test('canvas boundaries never wrap the silhouette onto another row or edge', () => {
  const { source, set, pixel } = artwork(23, 17);
  set(0, 0, [220, 50, 100, 255]);
  set(22, 16, [50, 180, 100, 255]);
  const { pixels, finish } = createMiNoteStickerFinish(source, 23, 17, 3);
  for (const [x, y] of [[22, 0], [0, 16], [22, 1], [0, 15]]) {
    assert.equal(pixel(pixels, x, y)[3], 0);
    const empty = pixel(finish, x, y);
    assert.deepEqual(empty.slice(0, 2), [0, 0]);
    assert.ok(empty[2] < 128);
    assert.equal(empty[3], 0);
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
    if (source[index + 3] < 128) assert.ok(finish[index + 2] < 128);
    else assert.ok(finish[index + 2] >= 128);
    assert.equal(finish[index + 3], source[index + 3]);
    assert.ok(finish[index + 1] <= pixels[index + 3]);
    if (pixels[index + 3] === 0) assert.deepEqual(Array.from(finish.subarray(index, index + 2)), [0, 0]);
    if (source[index + 3] === 255) assert.equal(finish[index + 1], 0);
  }
});

test('empty artwork remains empty and a zero-width rim preserves the original alpha', () => {
  const { source, set } = artwork(9, 7);
  const empty = createMiNoteStickerFinish(source, 9, 7);
  assert.deepEqual(empty.pixels, source);
  assert.ok(empty.finish.every(value => value === 0));
  set(4, 3, [30, 80, 160, 125]);
  const { pixels, finish } = createMiNoteStickerFinish(source, 9, 7, 0);
  assert.deepEqual(pixels, source);
  for (let index = 0; index < finish.length; index += 4) {
    assert.equal(finish[index + 1], 0);
    assert.equal(finish[index + 2], 0);
    assert.equal(finish[index + 3], source[index + 3]);
  }
});

test('signed edge distance crosses the silhouette and is available beyond the rendered backing', () => {
  const { source, set, pixel } = artwork(25, 25);
  for (let y = 4; y <= 20; y += 1) for (let x = 4; x <= 20; x += 1) set(x, y, [20, 100, 230, 255]);
  const { finish } = createMiNoteStickerFinish(source, 25, 25);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 12].map(x => pixel(finish, x, 12)[2]), [118, 121, 124, 126, 129, 131, 134, 137, 139, 150]);
  for (let distance = 0; distance <= 8; distance += 1) {
    assert.equal(pixel(finish, 4 + distance, 12)[2], pixel(finish, 20 - distance, 12)[2]);
    assert.equal(pixel(finish, 12, 4 + distance)[2], pixel(finish, 4 + distance, 12)[2]);
  }
  const withoutRim = createMiNoteStickerFinish(source, 25, 25, 0);
  assert.equal(pixel(withoutRim.pixels, 3, 12)[3], 0);
  assert.equal(pixel(withoutRim.finish, 3, 12)[2], 126);
  for (let offset = 2; offset < finish.length; offset += 4) assert.equal(withoutRim.finish[offset], finish[offset]);
});

test('fully opaque canvases measure from their exterior and cap the distance at 48 pixels', () => {
  assert.equal(MI_NOTE_STICKER_EDGE_DISTANCE, 48);
  const { source, pixel } = artwork(225, 225);
  source.fill(255);
  const { pixels, finish } = createMiNoteStickerFinish(source, 225, 225, 0);
  assert.deepEqual(pixels, source);
  assert.equal(pixel(finish, 0, 112)[2], 129);
  assert.equal(pixel(finish, 1, 112)[2], 131);
  assert.equal(pixel(finish, 47, 112)[2], 254);
  assert.equal(pixel(finish, 48, 112)[2], 255);
  assert.equal(pixel(finish, 112, 112)[2], 255);
  assert.equal(pixel(finish, 224, 112)[2], 129);
});

test('outside distance reaches the negative cap beyond supported backing without false interior', () => {
  const { source, set, pixel } = artwork(225, 225);
  set(112, 112, [240, 80, 20, 255]);
  const { pixels, finish } = createMiNoteStickerFinish(source, 225, 225, MI_NOTE_STICKER_OUTLINE_SUPPORT);
  assert.equal(pixel(finish, 112, 112)[2], 129);
  assert.equal(pixel(finish, 111, 112)[2], 126);
  assert.equal(pixel(finish, 64, 112)[2], 1);
  assert.equal(pixel(finish, 63, 112)[2], 0);
  assert.equal(pixel(finish, 0, 112)[2], 0);
  assert.equal(MI_NOTE_STICKER_OUTLINE_SUPPORT, 30);
  assert.equal(pixel(pixels, 82, 112)[3], 255);
  assert.equal(pixel(pixels, 81, 112)[3], 0);
  assert.equal(pixel(finish, 82, 112)[1], 255);
  assert.equal(pixel(finish, 82, 112)[3], 0);
  assert.equal(pixel(pixels, 72, 112)[3], 0);
  assert.ok(pixel(finish, 72, 112)[2] > 0);
  for (let offset = 0; offset < finish.length; offset += 4) {
    if (source[offset + 3] === 0) assert.ok(finish[offset + 2] < 128);
  }
});

test('translucent pixels retain their backing without becoming outside-distance seeds', () => {
  const { source, set, pixel } = artwork(41, 17);
  set(20, 8, [240, 80, 20, 255]);
  set(4, 8, [10, 200, 90, 127]);
  const original = source.slice();
  const { pixels, finish } = createMiNoteStickerFinish(source, 41, 17);
  assert.deepEqual(source, original);
  assert.equal(pixel(pixels, 4, 8)[3], 255);
  assert.equal(pixel(finish, 4, 8)[1], 128);
  assert.equal(pixel(finish, 4, 8)[2], 86);
  assert.equal(pixel(finish, 4, 8)[3], 127);
});

test('edge distances respect rectangular canvas boundaries without wrapping', () => {
  const horizontal = artwork(40, 80), vertical = artwork(80, 40);
  horizontal.source.fill(255);
  vertical.source.fill(255);
  const first = createMiNoteStickerFinish(horizontal.source, 40, 80, 0).finish;
  const second = createMiNoteStickerFinish(vertical.source, 80, 40, 0).finish;
  assert.equal(horizontal.pixel(first, 20, 40)[2], 179);
  for (let y = 0; y < 80; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      assert.equal(horizontal.pixel(first, x, y)[2], vertical.pixel(second, y, x)[2]);
    }
  }
  for (const [width, height] of [[1, 1], [1, 31], [31, 1]]) {
    const { source } = artwork(width, height);
    source.fill(255);
    const { finish } = createMiNoteStickerFinish(source, width, height, 0);
    for (let offset = 2; offset < finish.length; offset += 4) assert.equal(finish[offset], 129);
  }
});

test('the distance threshold keeps partially opaque artwork interior and ignores RGB', () => {
  const width = 25, height = 25;
  const opaque = artwork(width, height), partial = artwork(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      opaque.set(x, y, [255, 0, 0, 255]);
      partial.set(x, y, [0, 100, 255, 128 + (x + y) % 128]);
    }
  }
  const original = partial.source.slice();
  const first = createMiNoteStickerFinish(opaque.source, width, height, 0).finish;
  const result = createMiNoteStickerFinish(partial.source, width, height, 0);
  assert.deepEqual(partial.source, original);
  assert.deepEqual(result.pixels, original);
  for (let offset = 2; offset < first.length; offset += 4) {
    assert.equal(result.finish[offset], first[offset]);
    assert.equal(result.finish[offset + 1], original[offset + 1]);
  }
  partial.set(12, 12, [255, 255, 255, 127]);
  const cut = createMiNoteStickerFinish(partial.source, width, height, 0).finish;
  assert.equal(partial.pixel(cut, 12, 12)[2], 126);
  assert.equal(partial.pixel(cut, 12, 12)[3], 127);
  assert.equal(partial.pixel(cut, 13, 12)[2], 129);
  assert.equal(partial.pixel(cut, 14, 12)[2], 131);
});

test('invalid artwork dimensions and rim radii are rejected', () => {
  assert.throws(() => createMiNoteStickerFinish(new Uint8ClampedArray(4), 0, 1), RangeError);
  assert.throws(() => createMiNoteStickerFinish(new Uint8ClampedArray(4), 1.5, 1), RangeError);
  assert.throws(() => createMiNoteStickerFinish(new Uint8ClampedArray(4), 2, 1), RangeError);
  assert.throws(() => createMiNoteStickerFinish(new Uint8ClampedArray(4), 1, 1, -1), RangeError);
  assert.throws(() => createMiNoteStickerFinish(new Uint8ClampedArray(4), 1, 1, Infinity), RangeError);
});
