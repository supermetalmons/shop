import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import {
  CLEAR_CARDS_CARD_CLEAN_BASE_URL,
  CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL,
} from '../src/config/dropMediaDefaults.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { MediaWithFallback } = await import('../src/components/MediaWithFallback.tsx');
type Props = Parameters<typeof MediaWithFallback>[0];

afterEach(() => {
  cleanup();
  mock.restoreAll();
  setMediaQueryMatches('(prefers-color-scheme: dark)', false);
});
after(() => dom.window.close());

function props(overrides: Partial<Props> = {}): Props {
  return {
    imageSources: ['/image.webp'],
    imageProps: {
      alt: 'Preview',
      className: 'preview-image',
      loading: 'lazy',
      decoding: 'async',
      draggable: false,
      onDragStart: (event) => event.preventDefault(),
    },
    renderPlaceholder: (hidden) => createElement('span', { className: 'placeholder', hidden, 'aria-hidden': true }),
    ...overrides,
  };
}

function imageResult(image: HTMLImageElement, ready: boolean) {
  Object.defineProperty(image, 'complete', { configurable: true, value: true });
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: ready ? 100 : 0 });
  if (ready) fireEvent.load(image);
  else fireEvent.error(image);
}

function placeholder(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.placeholder');
  assert.ok(element);
  return element;
}

test('image fallbacks preserve sibling layout, attributes, drag prevention, and load recovery', () => {
  const view = render(createElement(MediaWithFallback, props()));
  const image = view.getByRole('img', { name: 'Preview' }) as HTMLImageElement;
  const fallback = placeholder(view.container);
  assert.deepEqual(Array.from(view.container.children), [image, fallback]);
  assert.equal(image.className, 'preview-image');
  assert.equal(image.getAttribute('loading'), 'lazy');
  assert.equal(image.getAttribute('decoding'), 'async');
  assert.equal(image.draggable, false);
  assert.equal(fireEvent.dragStart(image), false);
  assert.equal(image.hidden, false);
  assert.equal(fallback.hidden, true);

  imageResult(image, false);
  assert.equal(image.hidden, true);
  assert.equal(fallback.hidden, false);
  imageResult(image, true);
  assert.equal(image.hidden, false);
  assert.equal(fallback.hidden, true);
});

test('mint placeholders stay under pending images, while missing images show the placeholder', () => {
  const view = render(createElement(MediaWithFallback, props({ showPlaceholderWhileLoading: true })));
  const image = view.container.querySelector('img')!;
  assert.equal(placeholder(view.container).hidden, false);
  imageResult(image, true);
  assert.equal(placeholder(view.container).hidden, true);
  view.rerender(createElement(MediaWithFallback, props({ imageSources: [] })));
  assert.equal(view.container.children.length, 1);
  assert.equal(placeholder(view.container).hidden, false);
});

test('out-of-order fallback events cannot cover a ready primary and recover in source order', () => {
  const view = render(createElement(MediaWithFallback, props({
    imageSources: ['/poster.webp', '/image.webp'],
    showPlaceholderWhileLoading: true,
    renderPrimary: (media) => createElement('video', {
      hidden: media.hidden,
      'data-ready': media.ready,
      onLoadStart: media.onLoading,
      onLoadedData: media.onReady,
      onError: media.onError,
    }),
  })));
  const video = view.container.querySelector('video')!;
  const [poster, image] = Array.from(view.container.querySelectorAll('img'));
  const fallback = placeholder(view.container);
  assert.deepEqual(Array.from(view.container.children), [video, poster, image, fallback]);
  assert.equal(poster.hidden, false);
  assert.equal(image.hidden, true);
  assert.equal(fallback.hidden, false);

  imageResult(image, true);
  assert.equal(image.hidden, true);
  assert.equal(fallback.hidden, false);
  fireEvent.loadedData(video);
  imageResult(poster, true);
  imageResult(image, false);
  assert.equal(video.dataset.ready, 'true');
  assert.equal(poster.hidden, true);
  assert.equal(image.hidden, true);
  assert.equal(fallback.hidden, true);

  fireEvent.error(video);
  assert.equal(video.hidden, true);
  assert.equal(poster.hidden, false);
  assert.equal(fallback.hidden, true);
  imageResult(poster, false);
  assert.equal(poster.hidden, true);
  assert.equal(image.hidden, true);
  assert.equal(fallback.hidden, false);
  imageResult(image, true);
  assert.equal(image.hidden, false);
  assert.equal(fallback.hidden, true);

  fireEvent.loadStart(video);
  assert.equal(video.hidden, true);
  fireEvent.loadedData(video);
  assert.equal(video.hidden, false);
  assert.equal(image.hidden, true);
});

test('editing fallback sources preserves unchanged readiness and resets changed sources', () => {
  const initial = props({ showPlaceholderWhileLoading: true });
  const view = render(createElement(MediaWithFallback, initial));
  const image = view.container.querySelector('img')!;
  imageResult(image, true);
  view.rerender(createElement(MediaWithFallback, { ...initial, imageSources: ['/image.webp', '/second.webp'] }));
  assert.equal(view.container.querySelector('img'), image);
  assert.equal(placeholder(view.container).hidden, true);

  const secondImage = view.container.querySelectorAll('img')[1];
  imageResult(secondImage, true);
  view.rerender(createElement(MediaWithFallback, { ...initial, imageSources: ['/second.webp'] }));
  assert.equal(placeholder(view.container).hidden, true);

  imageResult(image, false);
  Object.defineProperty(image, 'complete', { configurable: true, value: false });
  view.rerender(createElement(MediaWithFallback, { ...initial, imageSources: ['/replacement.webp'] }));
  assert.equal(view.container.querySelector('img'), image);
  assert.equal(image.hidden, false);
  assert.equal(placeholder(view.container).hidden, false);
  imageResult(image, true);
  assert.equal(placeholder(view.container).hidden, true);
});

test('cached completed images skip failed sources without waiting for load events', () => {
  mock.getter(dom.window.HTMLImageElement.prototype, 'complete', () => true);
  mock.getter(dom.window.HTMLImageElement.prototype, 'naturalWidth', function () {
    return this.getAttribute('src') === '/failed.webp' ? 0 : 100;
  });
  const view = render(createElement(MediaWithFallback, props({
    imageSources: ['/failed.webp', '/cached.webp'],
    showPlaceholderWhileLoading: true,
  })));
  const [failed, cached] = Array.from(view.container.querySelectorAll('img'));
  assert.equal(failed.hidden, true);
  assert.equal(cached.hidden, false);
  assert.equal(placeholder(view.container).hidden, true);
});

test('theme changes retry the effective source after failure without replacing the image node', () => {
  const initial = props({
    imageSources: [`${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`],
    dropId: 'clear_cards_devnet_v2',
    showPlaceholderWhileLoading: true,
  });
  const view = render(createElement(MediaWithFallback, initial));
  const image = view.container.querySelector('img')!;
  imageResult(image, false);
  assert.equal(image.hidden, true);

  Object.defineProperty(image, 'complete', { configurable: true, value: false });
  act(() => setMediaQueryMatches('(prefers-color-scheme: dark)', true));
  assert.equal(view.container.querySelector('img'), image);
  assert.equal(image.src, `${CLEAR_CARDS_CARD_CLEAN_DARK_BASE_URL}/167.webp`);
  assert.equal(image.hidden, false);
  imageResult(image, true);
  assert.equal(placeholder(view.container).hidden, true);

  Object.defineProperty(image, 'complete', { configurable: true, value: false });
  act(() => setMediaQueryMatches('(prefers-color-scheme: dark)', false));
  assert.equal(image.src, `${CLEAR_CARDS_CARD_CLEAN_BASE_URL}/167.webp`);
  assert.equal(image.hidden, false);
  imageResult(image, true);
  assert.equal(placeholder(view.container).hidden, true);
});
