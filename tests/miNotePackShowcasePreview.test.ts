import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useEffect } from 'react';
import type { PrimaryMediaControls } from '../src/components/MediaWithFallback.tsx';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { MediaWithFallback } = await import('../src/components/MediaWithFallback.tsx');
const { useAppRoute } = await import('../src/hooks/useAppRoute.ts');
const { navigate } = await import('../src/navigation.ts');
const frames = new Map<number, FrameRequestCallback>();
const tasks = new Map<number, () => void>();
let nextId = 0;
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
  frames.set(++nextId, callback);
  return nextId;
} });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => { frames.delete(id); } });
Object.defineProperty(window, 'setTimeout', { configurable: true, value: (callback: () => void) => {
  tasks.set(++nextId, callback);
  return nextId;
} });
Object.defineProperty(window, 'clearTimeout', { configurable: true, value: (id: number) => { tasks.delete(id); } });

let resolveModule!: () => void;
const bridge = {
  moduleReady: new Promise<void>(resolve => { resolveModule = resolve; }),
  loads: 0,
  mounts: 0,
  media: null as PrimaryMediaControls | null,
  Showcase({ media }: { media: PrimaryMediaControls }) {
    bridge.media = media;
    useEffect(() => {
      bridge.mounts += 1;
    }, []);
    return createElement('canvas', { 'data-showcase': true });
  },
};
const bridgeKey = '__miNotePackShowcasePreviewTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: bridge });
const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/components/MiNotePackShowcasePreview.tsx') && specifier === './MiNotePackShowcase') {
      return { url: 'test:mi-note-showcase-preview', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'test:mi-note-showcase-preview') return {
      format: 'module', shortCircuit: true,
      source: `const bridge = globalThis.${bridgeKey}; bridge.loads += 1; await bridge.moduleReady; export default bridge.Showcase;`,
    };
    return nextLoad(url, context);
  },
});
const { MiNotePackShowcasePreview } = await import('../src/components/MiNotePackShowcasePreview.tsx');

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  bridge.mounts = 0;
  bridge.media = null;
});
afterEach(() => {
  cleanup();
  assert.equal(frames.size, 0);
  assert.equal(tasks.size, 0);
});
after(() => {
  imports.deregister();
  Reflect.deleteProperty(globalThis, bridgeKey);
  dom.window.close();
});

function Route() {
  const route = useAppRoute();
  if (route.path === '/') return createElement('button', { onClick: () => navigate('/mi_note_cards') }, 'Open Mi Note Cards');
  return createElement('section', null,
    createElement('h1', null, 'Mi Note Cards'),
    createElement(MediaWithFallback, {
      imageSources: ['/pack.webp'],
      imageProps: { alt: 'Mi Note pack' },
      showPlaceholderWhileLoading: true,
      renderPrimary: media => createElement(MiNotePackShowcasePreview, { media }),
      renderPlaceholder: hidden => createElement('div', { hidden, 'data-placeholder': true }),
    }),
  );
}

function openDrop() {
  const view = render(createElement(Route));
  fireEvent.click(view.getByRole('button', { name: 'Open Mi Note Cards' }));
  assert.equal(window.location.pathname, '/mi_note_cards');
  assert.ok(view.getByRole('heading', { name: 'Mi Note Cards' }));
  const image = view.getByAltText('Mi Note pack') as HTMLImageElement;
  assert.equal(image.src, 'https://mons.shop/pack.webp');
  assert.equal(image.hidden, false);
  assert.equal(view.container.querySelector<HTMLElement>('[data-placeholder]')?.hidden, false);
  assert.equal(bridge.mounts, 0);
  return { view, image };
}

function advanceFrame() {
  assert.equal(frames.size, 1);
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(16));
  });
}

async function advanceTask() {
  assert.equal(tasks.size, 1);
  await act(async () => {
    const callbacks = [...tasks.values()];
    tasks.clear();
    callbacks.forEach(callback => callback());
  });
}

test('cold and cached navigation show the destination before the showcase is ready', async () => {
  const { view, image } = openDrop();
  await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
  assert.equal(bridge.loads, 0);
  advanceFrame();
  assert.equal(bridge.mounts, 0);
  assert.equal(bridge.loads, 0);
  await advanceTask();
  assert.equal(bridge.loads, 1);
  assert.equal(bridge.mounts, 0);
  assert.equal(image.hidden, false);
  assert.equal(view.container.querySelector('canvas'), null);

  await act(async () => { resolveModule(); await bridge.moduleReady; });
  assert.equal(bridge.mounts, 1);
  assert.ok(view.container.querySelector('canvas'));
  assert.equal(image.hidden, false);
  act(() => bridge.media!.onReady());
  assert.equal(image.hidden, true);

  act(() => navigate('/'));
  fireEvent.click(view.getByRole('button', { name: 'Open Mi Note Cards' }));
  assert.equal(window.location.pathname, '/mi_note_cards');
  assert.ok(view.getByRole('heading', { name: 'Mi Note Cards' }));
  const cachedImage = view.getByAltText('Mi Note pack') as HTMLImageElement;
  await act(async () => {});
  assert.equal(bridge.mounts, 1);
  advanceFrame();
  assert.equal(bridge.mounts, 1);
  assert.equal(cachedImage.hidden, false);
  await advanceTask();
  assert.equal(bridge.mounts, 2);
  assert.ok(view.container.querySelector('canvas'));
  assert.equal(bridge.loads, 1);
});

test('leaving before the animation frame or its task cancels showcase initialization', async t => {
  for (const afterFrame of [false, true]) {
    await t.test(afterFrame ? 'after frame' : 'before frame', () => {
      const { view } = openDrop();
      if (afterFrame) advanceFrame();
      act(() => navigate('/'));
      assert.ok(view.getByRole('button', { name: 'Open Mi Note Cards' }));
      assert.equal(frames.size, 0);
      assert.equal(tasks.size, 0);
      assert.equal(bridge.mounts, 0);
      view.unmount();
    });
  }
});
