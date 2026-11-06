import assert from 'node:assert/strict';
import test from 'node:test';
import type { EthereumInventoryItem } from '../shared/ethereum/protocol.ts';
import { loadCratePreviewAssets } from '../src/ethereum/crate/crateAssets.ts';

function item(index: number, src = `https://images.example/${index}.webp`): EthereumInventoryItem {
  return { id: `artwork-${index}`, tokenId: String(index + 1), name: `Artwork ${index}`, kind: 'artwork',
    owner: `0x${'11'.repeat(20)}`, chainId: 11155111, contractAddress: `0x${'33'.repeat(20)}`,
    displayId: index, image: src, category: 'video', animation_url: `https://images.example/${index}.mp4` };
}

class FakeImage {
  src = '';
  crossOrigin = '';
  decoding = '';
  fetchPriority = '';
  complete = false;
  naturalWidth = 2000;
  naturalHeight = 1000;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoded = Promise.withResolvers<void>();
  decodeCalls = 0;
  decode() { this.decodeCalls++; return this.decoded.promise; }
  load() { this.complete = true; this.onload?.(); }
  finish() { this.load(); this.decoded.resolve(); }
}

class FakeCanvas {
  width = 0;
  height = 0;
  draws = 0;
  context = { imageSmoothingEnabled: false, imageSmoothingQuality: 'low', drawImage: () => { this.draws++; } };
  getContext() { return this.context; }
}

function factories() {
  const images: FakeImage[] = [];
  const canvases: FakeCanvas[] = [];
  return {
    images, canvases,
    createImage() { const image = new FakeImage(); images.push(image); return image as unknown as HTMLImageElement; },
    createCanvas() { const canvas = new FakeCanvas(); canvases.push(canvas); return canvas as unknown as HTMLCanvasElement; },
  };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const count of [20, 31]) test(`${count} previews load with four concurrent requests and wait for the last decode`, async () => {
  const batch = factories();
  const source = Array.from({ length: count }, (_, index) => item(index));
  const pending = loadCratePreviewAssets(source, batch);
  let finished = false;
  void pending.then(() => { finished = true; });
  assert.equal(batch.images.length, 4);
  assert.ok(batch.images.every(image => image.crossOrigin === 'anonymous' && image.decoding === 'async'));
  for (let index = 0; index < count - 1; index++) {
    assert.ok(batch.images.filter(image => image.src).length <= 4);
    batch.images[index].finish();
    await tick();
    assert.equal(finished, false);
    assert.equal(batch.images[index].src, '');
  }
  batch.images.at(-1)!.load();
  await tick();
  assert.equal(finished, false);
  batch.images.at(-1)!.decoded.resolve();
  const assets = await pending;
  assert.equal(assets.items.length, count);
  assert.deepEqual(assets.items.map(preview => preview.id), source.map(result => result.id));
  assert.ok(assets.items.every(preview => preview.width === 2000 && preview.height === 1000));
  assert.ok(batch.canvases.every(canvas => canvas.width === 512 && canvas.height === 256 && canvas.draws === 1));
  assert.ok(batch.images.every(image => image.src === '' && !image.onload && !image.onerror && image.decodeCalls === 1));
  assets.release();
  assets.release();
  assert.ok(batch.canvases.every(canvas => !canvas.width && !canvas.height));
});

test('duplicate sources share one prepared preview while preserving result order and identity', async () => {
  const batch = factories();
  const source = [item(1), item(2), item(3, item(1).image)];
  const pending = loadCratePreviewAssets(source, batch);
  assert.deepEqual(batch.images.map(image => image.src), [source[0].image, source[1].image]);
  assert.ok(batch.images.every(image => image.src.endsWith('.webp')));
  batch.images.forEach(image => image.finish());
  const assets = await pending;
  assert.equal(assets.items[0].image, assets.items[2].image);
  assert.equal(assets.items[2].name, 'Artwork 3');
  assets.release();
});

test('small and tall images retain their aspect without upscaling', async () => {
  const batch = factories();
  const pending = loadCratePreviewAssets([item(1), item(2)], batch);
  batch.images[0].naturalWidth = 80;
  batch.images[0].naturalHeight = 120;
  batch.images[1].naturalWidth = 932;
  batch.images[1].naturalHeight = 1006;
  batch.images.forEach(image => image.finish());
  const assets = await pending;
  assert.deepEqual(batch.canvases.map(canvas => [canvas.width, canvas.height]), [[80, 120], [474, 512]]);
  assert.equal(assets.items[1].width / assets.items[1].height, 932 / 1006);
  assets.release();
});

test('a load failure clears prepared and pending resources and does not start queued requests', async () => {
  const batch = factories();
  const pending = loadCratePreviewAssets(Array.from({ length: 10 }, (_, index) => item(index)), batch);
  const rejected = assert.rejects(pending, /Unable to load artwork preview/);
  batch.images[0].finish();
  await tick();
  assert.equal(batch.canvases.length, 1);
  batch.images[1].onerror?.();
  await rejected;
  assert.equal(batch.images.length, 5);
  assert.ok(batch.images.every(image => image.src === '' && !image.onload && !image.onerror));
  assert.ok(batch.canvases.every(canvas => !canvas.width && !canvas.height));
  batch.images.forEach(image => image.decoded.resolve());
  await tick();
  assert.equal(batch.images.length, 5);
});

test('decode failure, invalid dimensions, and timeout each prevent readiness', async () => {
  for (const reason of ['decode', 'dimensions', 'timeout']) {
    const batch = factories();
    const pending = loadCratePreviewAssets([item(1)], { ...batch, timeoutMs: reason === 'timeout' ? 5 : 30000 });
    const rejected = assert.rejects(pending, /artwork preview/);
    batch.images[0].load();
    if (reason === 'decode') batch.images[0].decoded.reject(new Error('decode'));
    if (reason === 'dimensions') { batch.images[0].naturalHeight = 0; batch.images[0].decoded.resolve(); }
    await rejected;
    assert.equal(batch.images[0].src, '');
    batch.images[0].decoded.resolve();
  }
});

test('abort during decode prevents late completion and releases decoded canvases', async () => {
  const batch = factories();
  const controller = new AbortController();
  const pending = loadCratePreviewAssets([item(1), item(2)], { ...batch, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  batch.images[0].finish();
  batch.images[1].load();
  await tick();
  controller.abort();
  await rejected;
  batch.images[1].decoded.resolve();
  await tick();
  assert.equal(batch.canvases.length, 1);
  assert.ok(batch.canvases.every(canvas => !canvas.width && !canvas.height));
  assert.ok(batch.images.every(image => image.src === ''));
});

test('already aborted input starts no requests and abort after readiness releases residents', async () => {
  const batch = factories();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(loadCratePreviewAssets([item(1)], { ...batch, signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(batch.images.length, 0);
  const controller = new AbortController();
  const pending = loadCratePreviewAssets([item(1)], { ...batch, signal: controller.signal });
  batch.images[0].finish();
  await pending;
  controller.abort();
  assert.equal(batch.canvases[0].width, 0);
});

test('a retry loads the same previews and missing images never become ready', async () => {
  const first = factories();
  const failed = loadCratePreviewAssets([item(1)], first);
  const rejected = assert.rejects(failed);
  first.images[0].onerror?.();
  await rejected;
  const retry = factories();
  const pending = loadCratePreviewAssets([item(1)], retry);
  assert.equal(retry.images[0].src, item(1).image);
  retry.images[0].finish();
  (await pending).release();
  await assert.rejects(loadCratePreviewAssets([{ ...item(1), image: '' }], factories()), /missing/);
});
