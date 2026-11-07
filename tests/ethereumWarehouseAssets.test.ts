import assert from 'node:assert/strict';
import test from 'node:test';
import type { EthereumInventoryItem } from '../shared/ethereum/protocol.ts';
import { loadWarehouseCrateImage, warehouseCratePreviews } from '../src/ethereum/warehouse/warehouseAssets.ts';

function factories() {
  class PreviewImage {
    naturalWidth = 1218;
    naturalHeight = 833;
    complete = false;
    decoding = '';
    fetchPriority = '';
    src = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoded = Promise.withResolvers<void>();
    decode = () => this.decoded.promise;
    finish() { this.onload?.(); this.decoded.resolve(); }
  }
  const images: PreviewImage[] = [];
  const canvases: HTMLCanvasElement[] = [];
  const drawings: { width: number; height: number }[] = [];
  return {
    images, canvases, drawings,
    createImage() {
      const image = new PreviewImage();
      images.push(image);
      return image as unknown as HTMLImageElement;
    },
    createCanvas() {
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {
        drawings.push({ width: canvas.width, height: canvas.height });
      } }) } as unknown as HTMLCanvasElement;
      canvases.push(canvas);
      return canvas;
    },
  };
}

function crate(index: number): EthereumInventoryItem {
  return { id: `crate-${index}`, tokenId: String(index), name: `Crate ${index}`, kind: 'crate',
    owner: `0x${'11'.repeat(20)}`, chainId: 11155111, contractAddress: `0x${'33'.repeat(20)}`, displayId: index,
    image: '/111k/crate-reference.webp' };
}

test('one local image is prepared before result identities exist and shared by every confirmed crate', async () => {
  const batch = factories();
  const pending = loadWarehouseCrateImage(batch);
  assert.equal(batch.images.length, 1);
  assert.equal(batch.images[0].src, '/111k/crate-reference.webp');
  batch.images[0].finish();
  const image = await pending;
  assert.deepEqual(batch.drawings, [{ width: 512, height: 350 }]);
  assert.equal(image.width / image.height, 1218 / 833);
  assert.equal(warehouseCratePreviews([], image), null);
  const confirmed = Array.from({ length: 11 }, (_, index) => crate(index + 1));
  const assets = warehouseCratePreviews(confirmed, image)!;
  assert.deepEqual(assets.items.map(item => [item.id, item.name]), confirmed.map(item => [item.id, item.name]));
  assert.equal(new Set(assets.items.map(item => item.image)).size, 1);
  assert.equal(assets.items[0].image, image.image);
  assert.equal(batch.images.length, 1);
  assets.release();
  assert.equal(image.image.width, 512);
  image.release();
  image.release();
  assert.equal(image.image.width, 0);
  assert.equal(image.image.height, 0);
});

test('already-cancelled loading makes no request and cancellation during decode ignores late success', async () => {
  const batch = factories();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(loadWarehouseCrateImage({ ...batch, signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(batch.images.length, 0);
  const controller = new AbortController();
  const pending = loadWarehouseCrateImage({ ...batch, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  batch.images[0].onload?.();
  controller.abort();
  await rejected;
  batch.images[0].decoded.resolve();
  await Promise.resolve();
  assert.equal(batch.canvases.length, 0);
  assert.equal(batch.images[0].src, '');
  assert.equal(batch.images[0].onload, null);
});

test('closing after preparation releases the shared canvas without retaining image handlers', async () => {
  const batch = factories();
  const controller = new AbortController();
  const pending = loadWarehouseCrateImage({ ...batch, signal: controller.signal });
  batch.images[0].finish();
  const image = await pending;
  controller.abort();
  image.release();
  assert.equal(image.image.width, 0);
  assert.equal(image.image.height, 0);
  assert.equal(batch.images[0].src, '');
  assert.equal(batch.images[0].onload, null);
  assert.equal(batch.images[0].onerror, null);
});

test('load, decode, empty-image and timeout failures reject readiness and can be retried', async () => {
  for (const reason of ['load', 'decode', 'empty', 'timeout']) {
    const batch = factories();
    const pending = loadWarehouseCrateImage({ ...batch, timeoutMs: reason === 'timeout' ? 5 : 30_000 });
    const rejected = assert.rejects(pending, /crate preview/);
    if (reason === 'load') batch.images[0].onerror?.();
    if (reason === 'decode') { batch.images[0].onload?.(); batch.images[0].decoded.reject(new Error('decode')); }
    if (reason === 'empty') { batch.images[0].naturalWidth = 0; batch.images[0].finish(); }
    await rejected;
    assert.equal(batch.images[0].src, '');
    assert.ok(batch.canvases.every(canvas => !canvas.width && !canvas.height));
    const retry = loadWarehouseCrateImage(batch);
    batch.images[1].finish();
    (await retry).release();
  }
});
