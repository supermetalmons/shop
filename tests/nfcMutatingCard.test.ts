import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { NfcMutatingCard } = await import('../src/components/NfcMutatingCard.tsx');
const originalImageProperties = Object.fromEntries(['complete', 'naturalWidth', 'decode'].map((name) => [
  name, Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, name),
]));

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of Object.entries(originalImageProperties)) {
    if (descriptor) Object.defineProperty(HTMLImageElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLImageElement.prototype, name);
  }
});
after(() => dom.window.close());

function controlledImages({ cached = false, decode = true } = {}) {
  const loaded = new WeakSet<HTMLImageElement>();
  const decodes = new Map<HTMLImageElement, { resolve: () => void; reject: () => void }>();
  const decodeCalls: HTMLImageElement[] = [];
  Object.defineProperties(HTMLImageElement.prototype, {
    complete: { configurable: true, get() { return cached || loaded.has(this); } },
    naturalWidth: { configurable: true, get() { return cached || loaded.has(this) ? 805 : 0; } },
    decode: {
      configurable: true,
      value: decode ? function (this: HTMLImageElement) {
        decodeCalls.push(this);
        return new Promise<void>((resolve, reject) => {
          decodes.set(this, { resolve, reject: () => reject(new Error('Decode failed')) });
        });
      } : undefined,
    },
  });
  return {
    decodeCalls,
    load(image: HTMLImageElement) {
      loaded.add(image);
      fireEvent.load(image);
    },
    resolve(image: HTMLImageElement) { decodes.get(image)!.resolve(); },
    reject(image: HTMLImageElement) { decodes.get(image)!.reject(); },
  };
}

function renderCard(strict = false) {
  const view = render(createElement(NfcMutatingCard, { alt: 'Mutating Card', width: 805, height: 1280 }), {
    reactStrictMode: strict,
  });
  const card = view.container.querySelector('.nfc-mutating-card');
  assert.ok(card instanceof HTMLElement);
  const images = Array.from(view.container.querySelectorAll('img'));
  return { ...view, card, images };
}

function assertFallbackFrame(images: HTMLImageElement[]) {
  assert.deepEqual(images.map((image) => image.style.opacity), ['1', '0', '0']);
}

function assertReady(card: HTMLElement, ready: boolean) {
  assert.equal(card.classList.contains('nfc-mutating-card--ready'), ready);
}

test('card loads all mounted frames and waits for every decode before enabling the crossfade', async () => {
  const loading = controlledImages();
  const view = renderCard();
  const { card, images } = view;
  const originalImages = [...images];
  assert.equal(images.length, 3);
  assert.equal(view.getAllByRole('img').length, 1);
  assert.equal(view.getByRole('img', { name: 'Mutating Card' }), images[0]);
  for (const [index, image] of images.entries()) {
    assert.equal(image.src, `https://wip.lil.org/mutating_card_${index}.webp`);
    assert.equal(image.width, 805);
    assert.equal(image.height, 1280);
    assert.equal(image.style.aspectRatio, '805 / 1280');
    assert.equal(image.getAttribute('loading'), 'eager');
    assert.equal(image.getAttribute('decoding'), 'async');
    assert.equal(image.draggable, false);
    if (index) {
      assert.equal(image.alt, '');
      assert.equal(image.getAttribute('aria-hidden'), 'true');
    }
  }
  assertFallbackFrame(images);
  assertReady(card, false);

  await act(async () => {
    loading.load(images[0]);
    loading.load(images[1]);
  });
  await act(async () => {
    loading.resolve(images[0]);
    loading.resolve(images[1]);
  });
  assertReady(card, false);
  await act(async () => loading.load(images[2]));
  assertReady(card, false);
  await act(async () => loading.resolve(images[2]));
  assertReady(card, true);
  assertFallbackFrame(images);
  assert.deepEqual(Array.from(view.container.querySelectorAll('img')), originalImages);
  assert.deepEqual(images.map((image) => image.src), [0, 1, 2].map((index) => `https://wip.lil.org/mutating_card_${index}.webp`));
});

test('a frame load failure leaves the first frame visible without starting animation', async () => {
  const loading = controlledImages();
  const { card, images } = renderCard();
  await act(async () => {
    loading.load(images[0]);
    fireEvent.error(images[1]);
  });
  await act(async () => {
    loading.resolve(images[0]);
    loading.load(images[2]);
  });
  assertFallbackFrame(images);
  assertReady(card, false);
});

test('a frame decode failure leaves the first frame visible without starting animation', async () => {
  const loading = controlledImages();
  const { card, images } = renderCard();
  await act(async () => images.forEach(loading.load));
  await act(async () => {
    loading.resolve(images[0]);
    loading.resolve(images[1]);
    loading.reject(images[2]);
  });
  assertFallbackFrame(images);
  assertReady(card, false);
});

test('cached images still wait for decode and StrictMode decodes each frame once', async () => {
  const loading = controlledImages({ cached: true });
  const view = renderCard(true);
  await act(async () => undefined);
  assert.equal(loading.decodeCalls.length, 3);
  assertReady(view.card, false);
  await act(async () => view.images.forEach(loading.resolve));
  assertReady(view.card, true);
  assertFallbackFrame(view.images);
});

test('browsers without decode begin only once all frame load events arrive', async () => {
  const loading = controlledImages({ decode: false });
  const { card, images } = renderCard();
  await act(async () => images.slice(0, 2).forEach(loading.load));
  assertReady(card, false);
  await act(async () => loading.load(images[2]));
  assertReady(card, true);
});

test('unmount removes pending load listeners and prevents later loading from starting animation', async () => {
  const loading = controlledImages();
  const view = renderCard(true);
  view.unmount();
  await act(async () => view.images.forEach(loading.load));
  assert.equal(loading.decodeCalls.length, 0);
  assertReady(view.card, false);
});

test('decode completion from an unmounted card cannot enable animation after remount', async () => {
  const loading = controlledImages();
  const first = renderCard();
  await act(async () => first.images.forEach(loading.load));
  first.unmount();
  const second = renderCard();
  await act(async () => first.images.forEach(loading.resolve));
  assertReady(first.card, false);
  assertReady(second.card, false);
  await act(async () => second.images.forEach(loading.load));
  await act(async () => second.images.forEach(loading.resolve));
  assertReady(first.card, false);
  assertReady(second.card, true);
});
