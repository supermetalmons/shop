import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { ethereumInventoryView } from '../src/ethereum/state.ts';

let environment = setupFrontendDom();
const { act, cleanup, render } = await import('@testing-library/react');
const { InventoryGrid } = await import('../src/components/InventoryGrid.tsx');
environment.dom.window.close();

const preference = '(prefers-reduced-motion: reduce)';
const item = ethereumInventoryView({
  id: 'ethereum:11155111:1', tokenId: '1', displayId: 1, kind: 'artwork', chainId: 11155111,
  contractAddress: `0x${'11'.repeat(20)}`, owner: `0x${'22'.repeat(20)}`,
  name: 'Artwork 1', image: 'https://wip.lil.org/111k/videos/1.webp',
  animation_url: 'https://wip.lil.org/111k/videos/1.mp4',
  category: 'video', revealStatus: 'revealed', aspectRatio: { width: 16, height: 9 },
});

beforeEach(() => { environment = setupFrontendDom(); });
afterEach(() => { cleanup(); environment.dom.window.close(); });

function inventory() {
  return render(createElement(InventoryGrid, { items: [item], selected: new Set<string>(), onToggle: () => {} }));
}

test('revealed inventory videos show their poster without autoplay when reduced motion is enabled', t => {
  environment.setMediaQueryMatches(preference, true);
  const play = t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'pause', () => {});
  const view = inventory();
  assert.equal(view.container.querySelector('video'), null);
  assert.equal(play.mock.callCount(), 0);
  assert.equal(view.container.querySelector('img')?.src, item.image);
});

test('changing the motion preference pauses inventory playback and restores it when allowed', t => {
  const play = t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  const pause = t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'pause', () => {});
  const view = inventory();
  const initial = view.container.querySelector('video');
  assert.ok(initial);
  assert.ok(play.mock.callCount() > 0);
  const played = play.mock.callCount();
  act(() => environment.setMediaQueryMatches(preference, true));
  assert.equal(view.container.querySelector('video'), null);
  assert.ok(pause.mock.calls.some(call => call.this === initial));
  assert.equal(play.mock.callCount(), played);
  assert.equal(view.container.querySelector('img')?.src, item.image);
  act(() => environment.setMediaQueryMatches(preference, false));
  assert.ok(view.container.querySelector('video'));
  assert.ok(play.mock.callCount() > played);
});

test('motion preference changes preserve offscreen video suspension', t => {
  const play = t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'play', async () => {});
  t.mock.method(environment.dom.window.HTMLMediaElement.prototype, 'pause', () => {});
  let visible!: (isIntersecting: boolean) => void;
  let disconnected = false;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'IntersectionObserver', original);
    else Reflect.deleteProperty(globalThis, 'IntersectionObserver');
  });
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      visible = isIntersecting => callback([{ isIntersecting }]);
    }
    observe() {}
    disconnect() { disconnected = true; }
  } });
  const view = inventory();
  act(() => environment.setMediaQueryMatches(preference, true));
  act(() => environment.setMediaQueryMatches(preference, false));
  assert.equal(view.container.querySelector('video'), null);
  assert.equal(play.mock.callCount(), 0);
  act(() => visible(true));
  assert.ok(view.container.querySelector('video'));
  act(() => visible(false));
  assert.equal(view.container.querySelector('video'), null);
  view.unmount();
  assert.equal(disconnected, true);
});
