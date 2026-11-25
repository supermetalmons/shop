import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach, mock } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let environment = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { useTarotCardTransition } = await import('../src/hooks/useTarotCardTransition.ts');

beforeEach(() => { environment.dom.window.close(); environment = setupFrontendDom(); });
afterEach(() => { cleanup(); mock.restoreAll(); });
after(() => environment.dom.window.close());

function Card({ eligible = false, paused = false, withReceipt = false }: {
  eligible?: boolean; paused?: boolean; withReceipt?: boolean;
}) {
  const { cardRef, receiptRef, receiptState, compact, transitioning } = useTarotCardTransition(eligible, paused);
  return createElement('main', null,
    createElement('img', { ref: cardRef, src: 'https://example.test/card.webp', alt: 'Tarot card',
      'data-layout': compact ? 'compact' : 'artwork' }),
    withReceipt && eligible && createElement('img', { ref: receiptRef, src: 'https://example.test/receipt.webp',
      alt: 'Receipt', hidden: !compact, 'data-state': receiptState }),
    compact && createElement('button', { disabled: transitioning }, 'Claim'));
}

function controls({ cached = false } = {}) {
  const loaded = new WeakSet<HTMLImageElement>();
  const failed = new WeakSet<HTMLImageElement>();
  const decodes: PromiseWithResolvers<void>[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  const animations: Array<{ node: HTMLImageElement; keyframes: Keyframe[]; finished: PromiseWithResolvers<void>;
    cancel: ReturnType<typeof mock.fn<() => void>> }> = [];
  let frameId = 0;
  let measured = false;
  Object.defineProperties(HTMLImageElement.prototype, {
    complete: { configurable: true, get(this: HTMLImageElement) { return cached || loaded.has(this) || failed.has(this); } },
    naturalWidth: { configurable: true, get(this: HTMLImageElement) { return cached || loaded.has(this) ? 881 : 0; } },
    decode: { configurable: true, value() {
      const decode = Promise.withResolvers<void>();
      decodes.push(decode);
      return decode.promise;
    } },
    getBoundingClientRect: { configurable: true, value(this: HTMLImageElement) {
      if (!measured) return new environment.dom.window.DOMRect(0, 0, 0, 0);
      return this.dataset.layout === 'compact' ? new environment.dom.window.DOMRect(30, 80, 180, 300)
        : new environment.dom.window.DOMRect(140, 40, 360, 600);
    } },
    animate: { configurable: true, value(this: HTMLImageElement, keyframes: Keyframe[]) {
      const finished = Promise.withResolvers<void>();
      const cancel = mock.fn(() => finished.reject(new DOMException('Cancelled', 'AbortError')));
      animations.push({ node: this, keyframes, finished, cancel });
      return { finished: finished.promise, cancel };
    } },
  });
  mock.method(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  mock.method(globalThis, 'cancelAnimationFrame', (id: number) => { frames.delete(id); });
  const paint = async () => {
    measured = true;
    for (let iteration = 0; frames.size && iteration < 8; iteration++) {
      await act(async () => {
        const current = [...frames.values()];
        frames.clear();
        current.forEach(callback => callback(performance.now()));
      });
    }
    assert.equal(frames.size, 0, 'Frame scheduling must settle');
  };
  return { animations, decodes, frames, paint,
    async load(image: HTMLImageElement) { await act(async () => { loaded.add(image); fireEvent.load(image); }); },
    async fail(image: HTMLImageElement) { await act(async () => { failed.add(image); fireEvent.error(image); }); },
    async decode() { await act(async () => decodes.forEach(decode => decode.resolve())); },
    async failDecode() { await act(async () => decodes.forEach(decode => decode.reject(new Error('Decode failed')))); },
  };
}

test('early eligibility waits for artwork load, decode and paint before moving the same image', async () => {
  const controlled = controls();
  const view = render(createElement(Card, { eligible: true }));
  const image = view.getByRole('img') as HTMLImageElement;
  assert.equal(image.getBoundingClientRect().width, 0);
  assert.equal(image.dataset.layout, 'artwork');
  assert.equal(view.queryByRole('button'), null);
  assert.equal(controlled.animations.length, 0);
  await controlled.load(image);
  assert.equal(controlled.decodes.length, 1);
  assert.equal(image.dataset.layout, 'artwork');
  await controlled.decode();
  assert.equal(image.dataset.layout, 'artwork');
  await controlled.paint();
  assert.equal(view.getByRole('img'), image);
  assert.equal(image.dataset.layout, 'compact');
  assert.equal(controlled.animations.length, 1);
  assert.equal(controlled.animations[0].node, image);
  assert.equal(controlled.animations[0].keyframes[0].transform, 'translate3d(110px, -40px, 0) scale(2)');
  assert.equal(controlled.animations[0].keyframes[0].boxShadow, '0 0 0 0.5px var(--nfc-card-ring-color)');
  assert.equal(controlled.animations[0].keyframes.at(-1)?.transform, 'translate3d(0px, 0px, 0) scale(1)');
  assert.equal(controlled.animations[0].keyframes.at(-1)?.boxShadow, '0 0 0 1px var(--nfc-card-ring-color)');
  assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, true);
  await act(async () => controlled.animations[0].finished.resolve());
  assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, false);
  view.rerender(createElement(Card, { eligible: true }));
  assert.equal(controlled.animations.length, 1);
});

test('cached artwork with initially unmeasured geometry still animates after decode and paint', async () => {
  const controlled = controls({ cached: true });
  const view = render(createElement(Card, { eligible: true }));
  const image = view.getByRole('img');
  assert.equal(image.dataset.layout, 'artwork');
  await controlled.decode();
  await controlled.paint();
  assert.equal(controlled.animations.length, 1);
  assert.equal(controlled.animations[0].node, image);
});

test('the receipt loads and decodes while the large artwork remains visible', async () => {
  const controlled = controls();
  const view = render(createElement(Card, { eligible: true, withReceipt: true }));
  const card = view.getByRole('img', { name: 'Tarot card' }) as HTMLImageElement;
  const receipt = view.container.querySelector<HTMLImageElement>('img[alt="Receipt"]')!;
  assert.equal(receipt.hidden, true);

  await controlled.load(card);
  await controlled.decode();
  await controlled.paint();
  await controlled.load(receipt);
  assert.equal(card.dataset.layout, 'artwork');
  assert.equal(receipt.hidden, true);
  assert.equal(controlled.animations.length, 0);

  await controlled.decode();
  assert.equal(controlled.animations.length, 1);
  assert.equal(view.getByRole('img', { name: 'Receipt' }), receipt);
  assert.equal(receipt.dataset.state, 'ready');
});

test('drawable artwork and receipt still enter together when decode rejects', async () => {
  const controlled = controls();
  const view = render(createElement(Card, { eligible: true, withReceipt: true }));
  const card = view.getByRole('img', { name: 'Tarot card' }) as HTMLImageElement;
  const receipt = view.container.querySelector<HTMLImageElement>('img[alt="Receipt"]')!;

  await controlled.load(card);
  await controlled.load(receipt);
  await controlled.failDecode();
  await controlled.paint();

  assert.equal(controlled.animations.length, 1);
  assert.equal(controlled.animations[0].node, card);
  assert.equal(view.getByRole('img', { name: 'Receipt' }), receipt);
  assert.equal(receipt.dataset.state, 'ready');
});

test('a receipt network error settles its state and lets the card enter immediately', async () => {
  const controlled = controls();
  const view = render(createElement(Card, { eligible: true, withReceipt: true }));
  const card = view.getByRole('img', { name: 'Tarot card' }) as HTMLImageElement;
  const receipt = view.container.querySelector<HTMLImageElement>('img[alt="Receipt"]')!;

  await controlled.load(card);
  await controlled.decode();
  await controlled.paint();
  assert.equal(controlled.animations.length, 0);

  await controlled.fail(receipt);
  assert.equal(controlled.animations.length, 1);
  assert.equal(view.getByRole('img', { name: 'Receipt' }), receipt);
  assert.equal(receipt.dataset.state, 'failed');
});

test('a stalled receipt does not hold the card back and can appear after Claim is ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controlled = controls();
  const view = render(createElement(Card, { eligible: true, withReceipt: true }));
  const card = view.getByRole('img', { name: 'Tarot card' }) as HTMLImageElement;
  const receipt = view.container.querySelector<HTMLImageElement>('img[alt="Receipt"]')!;
  await controlled.load(card);
  await controlled.decode();
  await controlled.paint();
  await act(async () => t.mock.timers.tick(250));
  assert.equal(controlled.animations.length, 1);
  assert.equal(view.getByRole('img', { name: 'Receipt' }), receipt);
  assert.equal(receipt.dataset.state, 'loading');

  await act(async () => controlled.animations[0].finished.resolve());
  assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, false);
  await controlled.load(receipt);
  await controlled.decode();
  assert.equal(receipt.dataset.state, 'ready');
  assert.equal(controlled.animations.length, 1);
});

test('a slow card that paints before the deadline still animates when the receipt is pending', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const controlled = controls();
  const view = render(createElement(Card, { eligible: true, withReceipt: true }));
  const card = view.getByRole('img', { name: 'Tarot card' }) as HTMLImageElement;

  await act(async () => t.mock.timers.tick(1_380));
  await controlled.load(card);
  await controlled.decode();
  await controlled.paint();
  assert.equal(card.dataset.layout, 'artwork');
  assert.equal(controlled.animations.length, 0);

  await act(async () => t.mock.timers.tick(120));
  assert.equal(controlled.animations.length, 1);
  assert.equal(controlled.animations[0].node, card);
  assert.equal(view.getByRole('img', { name: 'Receipt' }).dataset.state, 'loading');
});

for (const stalledAt of ['loading', 'decoding']) {
  test(`stalled artwork ${stalledAt} cannot block Claim or start a late animation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controlled = controls();
    const view = render(createElement(Card, { eligible: true }));
    const image = view.getByRole('img') as HTMLImageElement;
    if (stalledAt === 'decoding') await controlled.load(image);
    assert.equal(view.queryByRole('button'), null);
    await act(async () => t.mock.timers.tick(2_000));
    assert.equal(view.getByRole('img'), image);
    assert.equal(image.dataset.layout, 'compact');
    assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, false);
    if (stalledAt === 'loading') await controlled.load(image);
    await controlled.decode();
    await controlled.paint();
    assert.equal(controlled.animations.length, 0);
    assert.equal(image.dataset.layout, 'compact');
  });
}

test('reduced motion exposes the eligible layout without starting an animation', () => {
  const controlled = controls();
  environment.setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  const view = render(createElement(Card, { eligible: true }));
  assert.equal(view.getByRole('img').dataset.layout, 'compact');
  assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, false);
  assert.equal(controlled.animations.length, 0);
  assert.equal(controlled.frames.size, 0);
});

test('native card animation works without custom-property registration', async () => {
  const controlled = controls({ cached: true });
  Object.defineProperty(window, 'CSS', { configurable: true, value: {} });
  const view = render(createElement(Card, { eligible: true }));
  await controlled.decode();
  await controlled.paint();
  assert.equal(view.getByRole('img').dataset.layout, 'compact');
  assert.equal(controlled.animations.length, 1);
  await act(async () => controlled.animations[0].finished.resolve());
  assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, false);
  assert.equal(controlled.frames.size, 0);
});

test('a popup defers transition until it closes while keeping the artwork mounted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controlled = controls();
  const view = render(createElement(Card, { eligible: true, paused: true }));
  const image = view.getByRole('img') as HTMLImageElement;
  await controlled.load(image);
  await act(async () => t.mock.timers.tick(2_000));
  await controlled.paint();
  assert.equal(image.dataset.layout, 'artwork');
  assert.equal(controlled.decodes.length, 0);
  assert.equal(controlled.animations.length, 0);
  view.rerender(createElement(Card, { eligible: true, paused: false }));
  await controlled.decode();
  await controlled.paint();
  assert.equal(view.getByRole('img'), image);
  assert.equal(controlled.animations.length, 1);
});

test('resize settles the eligible layout and cancels the obsolete animation', async () => {
  const controlled = controls({ cached: true });
  const view = render(createElement(Card, { eligible: true }));
  await controlled.decode();
  await controlled.paint();
  const animation = controlled.animations[0];
  await act(async () => window.dispatchEvent(new environment.dom.window.Event('resize')));
  assert.equal(animation.cancel.mock.callCount(), 1);
  assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, false);
  await act(async () => window.dispatchEvent(new environment.dom.window.Event('resize')));
  assert.equal(controlled.animations.length, 1);
});

for (const property of ['width', 'height', 'scale'] as const) {
  test(`visual viewport resize settles an animation only when ${property} changes`, async () => {
    const viewport = Object.assign(new window.EventTarget(), { width: 390, height: 780, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const controlled = controls({ cached: true });
    const view = render(createElement(Card, { eligible: true }));
    await controlled.decode();
    await controlled.paint();
    const animation = controlled.animations[0];
    const resize = () => act(async () => viewport.dispatchEvent(new window.Event('resize')));

    await resize();
    assert.equal(animation.cancel.mock.callCount(), 0);
    assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, true);

    viewport[property] += property === 'scale' ? 0.25 : 10;
    await resize();
    assert.equal(animation.cancel.mock.callCount(), 1);
    assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, false);
  });
}

test('a dialog opened during movement settles the card into its final frame without replaying', async () => {
  const controlled = controls({ cached: true });
  const view = render(createElement(Card, { eligible: true }));
  const image = view.getByRole('img');
  await controlled.decode();
  await controlled.paint();
  const animation = controlled.animations[0];
  await act(async () => view.rerender(createElement(Card, { eligible: true, paused: true })));
  assert.equal(animation.cancel.mock.callCount(), 1);
  assert.equal(view.getByRole('img'), image);
  assert.equal(image.dataset.layout, 'compact');
  await act(async () => view.rerender(createElement(Card, { eligible: true, paused: false })));
  assert.equal(controlled.animations.length, 1);
  assert.equal(image.dataset.layout, 'compact');
  assert.equal((view.getByRole('button') as HTMLButtonElement).disabled, false);
});

test('revoking eligibility cancels animation and restores the same public artwork', async () => {
  const controlled = controls({ cached: true });
  const view = render(createElement(Card, { eligible: true }));
  const image = view.getByRole('img');
  await controlled.decode();
  await controlled.paint();
  const animation = controlled.animations[0];
  await act(async () => view.rerender(createElement(Card, { eligible: false })));
  assert.equal(animation.cancel.mock.callCount(), 1);
  assert.equal(view.getByRole('img'), image);
  assert.equal(image.dataset.layout, 'artwork');
  assert.equal(view.queryByRole('button'), null);
  await act(async () => animation.finished.resolve());
  assert.equal(image.dataset.layout, 'artwork');
});

for (const stage of ['decoding', 'scheduled', 'animating']) {
  test(`navigation cleans up ${stage} work without starting a stale transition`, async () => {
    const controlled = controls({ cached: true });
    const view = render(createElement(Card, { eligible: true }));
    if (stage !== 'decoding') await controlled.decode();
    if (stage === 'animating') await controlled.paint();
    const count = controlled.animations.length;
    await act(async () => view.unmount());
    await controlled.decode();
    await controlled.paint();
    assert.equal(controlled.animations.length, count);
    if (stage === 'animating') assert.equal(controlled.animations[0].cancel.mock.callCount(), 1);
    assert.equal(view.container.childElementCount, 0);
  });
}
