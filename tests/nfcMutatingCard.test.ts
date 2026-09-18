import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';
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
  mock.timers.reset();
  mock.restoreAll();
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

function controlledIntervals() {
  mock.timers.enable({ apis: ['setInterval'] });
  const start = mock.method(window, 'setInterval', (handler: TimerHandler, delay?: number) => {
    assert.equal(typeof handler, 'function');
    return globalThis.setInterval(handler as () => void, delay) as unknown as number;
  });
  const stop = mock.method(window, 'clearInterval', (id?: number) => {
    globalThis.clearInterval(id);
  });
  return {
    start,
    stop,
    tick(ms: number) { act(() => mock.timers.tick(ms)); },
  };
}

function renderCard(strict = false) {
  const view = render(createElement(NfcMutatingCard, { alt: 'Mutating Card', width: 805, height: 1280 }), {
    reactStrictMode: strict,
  });
  const images = Array.from(view.container.querySelectorAll('img'));
  return { ...view, images };
}

function assertFrame(images: HTMLImageElement[], frame: number) {
  assert.deepEqual(images.map((image) => image.style.opacity), [0, 1, 2].map((index) => index === 0 || index === frame ? '1' : '0'));
}

test('card loads all mounted frames and waits for every decode before starting the exact 777 ms ping-pong loop', async () => {
  const loading = controlledImages();
  const clock = controlledIntervals();
  const view = renderCard();
  const { images } = view;
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
  clock.tick(7770);
  assertFrame(images, 0);
  assert.equal(clock.start.mock.callCount(), 0);

  await act(async () => {
    loading.load(images[0]);
    loading.load(images[1]);
  });
  await act(async () => {
    loading.resolve(images[0]);
    loading.resolve(images[1]);
  });
  clock.tick(7770);
  assert.equal(clock.start.mock.callCount(), 0);
  await act(async () => loading.load(images[2]));
  clock.tick(7770);
  assert.equal(clock.start.mock.callCount(), 0);
  await act(async () => loading.resolve(images[2]));
  assert.equal(clock.start.mock.callCount(), 1);
  assertFrame(images, 0);

  let previousFrame = 0;
  for (const frame of [1, 2, 1, 0, 1, 2, 1, 0]) {
    clock.tick(776);
    assertFrame(images, previousFrame);
    clock.tick(1);
    assertFrame(images, frame);
    previousFrame = frame;
  }
  assert.deepEqual(Array.from(view.container.querySelectorAll('img')), originalImages);
  assert.deepEqual(images.map((image) => image.src), [0, 1, 2].map((index) => `https://wip.lil.org/mutating_card_${index}.webp`));
});

test('a frame load failure leaves the first frame visible without starting animation', async () => {
  const loading = controlledImages();
  const clock = controlledIntervals();
  const { images } = renderCard();
  await act(async () => {
    loading.load(images[0]);
    fireEvent.error(images[1]);
  });
  await act(async () => {
    loading.resolve(images[0]);
    loading.load(images[2]);
  });
  clock.tick(7770);
  assertFrame(images, 0);
  assert.equal(clock.start.mock.callCount(), 0);
});

test('a frame decode failure leaves the first frame visible without starting animation', async () => {
  const loading = controlledImages();
  const clock = controlledIntervals();
  const { images } = renderCard();
  await act(async () => images.forEach(loading.load));
  await act(async () => {
    loading.resolve(images[0]);
    loading.resolve(images[1]);
    loading.reject(images[2]);
  });
  clock.tick(7770);
  assertFrame(images, 0);
  assert.equal(clock.start.mock.callCount(), 0);
});

test('cached images still wait for decode and StrictMode starts only one interval', async () => {
  const loading = controlledImages({ cached: true });
  const clock = controlledIntervals();
  const view = renderCard(true);
  await act(async () => undefined);
  assert.equal(loading.decodeCalls.length, 3);
  assert.equal(clock.start.mock.callCount(), 0);
  await act(async () => view.images.forEach(loading.resolve));
  assert.equal(clock.start.mock.callCount(), 1);
  clock.tick(777);
  assertFrame(view.images, 1);
  const intervalId = clock.start.mock.calls[0].result;
  view.unmount();
  assert.ok(clock.stop.mock.calls.some((call) => call.arguments[0] === intervalId));
  clock.tick(7770);
  assertFrame(view.images, 1);
});

test('browsers without decode begin only once all frame load events arrive', async () => {
  const loading = controlledImages({ decode: false });
  const clock = controlledIntervals();
  const { images } = renderCard();
  await act(async () => images.slice(0, 2).forEach(loading.load));
  assert.equal(clock.start.mock.callCount(), 0);
  await act(async () => loading.load(images[2]));
  assert.equal(clock.start.mock.callCount(), 1);
  clock.tick(777);
  assertFrame(images, 1);
});

test('unmount removes pending load listeners and prevents later loading from starting animation', async () => {
  const loading = controlledImages();
  const clock = controlledIntervals();
  const view = renderCard(true);
  view.unmount();
  await act(async () => view.images.forEach(loading.load));
  assert.equal(loading.decodeCalls.length, 0);
  assert.equal(clock.start.mock.callCount(), 0);
});

test('decode completion from an unmounted card cannot start a stale interval after remount', async () => {
  const loading = controlledImages();
  const clock = controlledIntervals();
  const first = renderCard();
  await act(async () => first.images.forEach(loading.load));
  first.unmount();
  const second = renderCard();
  await act(async () => first.images.forEach(loading.resolve));
  assert.equal(clock.start.mock.callCount(), 0);
  await act(async () => second.images.forEach(loading.load));
  await act(async () => second.images.forEach(loading.resolve));
  assert.equal(clock.start.mock.callCount(), 1);
  clock.tick(777);
  assertFrame(second.images, 1);
});
