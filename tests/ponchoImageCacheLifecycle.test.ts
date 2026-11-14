import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { DRIF_EFFECTS, type DrifCardConfig } from '../src/drifCards.ts';
import {
  clearPonchoDrifellaImageCache,
  createPonchoDrifellaImageCache,
  preloadPonchoDrifellaCardAssets,
} from '../src/lib/ponchoDrifellaReveal.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
after(() => dom.window.close());

class ControlledImage {
  src = '';
  decoding = '';
  fetchPriority = '';
  complete = false;
  naturalWidth = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decodeCalls = 0;
  readonly decodingStarted = Promise.withResolvers<void>();
  readonly decoded = Promise.withResolvers<void>();

  decode() { this.decodeCalls++; this.decodingStarted.resolve(); return this.decoded.promise; }
  load() { this.complete = true; this.naturalWidth = 100; this.onload?.(); }
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const images: ControlledImage[] = [];
  t.mock.method(globalThis, 'Image', function () {
    const image = new ControlledImage();
    images.push(image);
    return image as unknown as HTMLImageElement;
  });
  const card: DrifCardConfig = { imageSrc: 'https://example.test/card.webp', effect: DRIF_EFFECTS['swshp-SWSH179']! };
  const cache = createPonchoDrifellaImageCache();
  t.after(() => {
    clearPonchoDrifellaImageCache(cache);
    images.forEach(image => { image.onerror?.(); image.decoded.resolve(); });
  });
  const preload = (mode: 'warm' | 'resident' = 'warm') => {
    preloadPonchoDrifellaCardAssets(card, cache, { mode });
    const image = images.at(-1);
    const pending = cache.pending.get(card.imageSrc);
    assert.ok(image && pending);
    return { image, pending };
  };
  return { card, cache, images, preload };
}

for (const outcome of ['error', 'load'] as const) {
  test(`a stale image ${outcome} cannot discard ownership of a replacement preload`, async t => {
    const { cache, card, preload } = fixture(t);
    const first = preload();
    const settle = outcome === 'error' ? first.image.onerror : first.image.onload;
    assert.ok(settle);
    const settled = first.pending.catch(() => undefined);
    clearPonchoDrifellaImageCache(cache);
    const replacement = preload();
    settle();
    await settled;
    assert.equal(cache.pending.get(card.imageSrc), replacement.pending);
    assert.equal(cache.fetched.has(card.imageSrc), false);
    assert.equal(cache.resident.size, 0);
    clearPonchoDrifellaImageCache(cache);
    assert.equal(replacement.image.src, '');
    assert.equal(cache.pending.size, 0);
  });
}

test('a stale image decode completion cannot hide a replacement from final cleanup', async t => {
  const { cache, card, preload } = fixture(t);
  const first = preload('resident');
  first.image.load();
  assert.equal(first.image.decodeCalls, 1);
  clearPonchoDrifellaImageCache(cache);
  const replacement = preload();
  first.image.decoded.resolve();
  await first.pending;
  assert.equal(cache.pending.get(card.imageSrc), replacement.pending);
  assert.equal(cache.fetched.has(card.imageSrc), false);
  assert.equal(cache.resident.size, 0);
  clearPonchoDrifellaImageCache(cache);
  assert.equal(replacement.image.src, '');
});

for (const replace of [false, true]) {
  test(`clearing a warm-to-resident decode releases its image${replace ? ' without disturbing a replacement' : ''}`, async t => {
    const { cache, card, preload } = fixture(t);
    const first = preload();
    preloadPonchoDrifellaCardAssets(card, cache, { mode: 'resident' });
    first.image.load();
    await first.image.decodingStarted.promise;
    clearPonchoDrifellaImageCache(cache);
    assert.equal(first.image.src, '');
    const replacement = replace ? preload() : undefined;
    first.image.decoded.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(cache.resident.size, 0);
    assert.equal(cache.fetched.size, 0);
    assert.equal(cache.pending.get(card.imageSrc), replacement?.pending);
    if (replacement) assert.equal(replacement.image.src, card.imageSrc);
    clearPonchoDrifellaImageCache(cache);
    if (replacement) assert.equal(replacement.image.src, '');
  });
}

test('warm-to-resident promotion still succeeds and remains releasable', async t => {
  const { cache, card, images, preload } = fixture(t);
  const first = preload();
  preloadPonchoDrifellaCardAssets(card, cache, { mode: 'resident' });
  first.image.load();
  await first.image.decodingStarted.promise;
  first.image.decoded.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(images.length, 1);
  assert.equal(cache.resident.get(card.imageSrc), first.image);
  clearPonchoDrifellaImageCache(cache);
  assert.equal(first.image.src, '');
});

test('current image failure still permits retry and successful resident images remain releasable', async t => {
  const { cache, card, images, preload } = fixture(t);
  const first = preload();
  const rejected = assert.rejects(first.pending, /Failed to preload image/);
  first.image.onerror?.();
  await rejected;
  assert.equal(cache.pending.size, 0);
  assert.equal(cache.fetched.size, 0);
  const retry = preload('resident');
  retry.image.load();
  retry.image.decoded.resolve();
  await retry.pending;
  assert.equal(cache.pending.size, 0);
  assert.equal(cache.fetched.has(card.imageSrc), true);
  assert.equal(cache.resident.get(card.imageSrc), retry.image);
  preloadPonchoDrifellaCardAssets(card, cache, { mode: 'warm' });
  assert.equal(images.length, 2);
  clearPonchoDrifellaImageCache(cache);
  assert.equal(retry.image.src, '');
  assert.equal(cache.resident.size, 0);
  assert.equal(cache.fetched.size, 0);
});
