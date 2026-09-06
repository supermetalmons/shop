import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';

const dom = new JSDOM('<!doctype html><html><head><style>.mint-panel__preview { padding: 0px; }</style></head><body></body></html>', {
  url: 'https://mons.shop/',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLImageElement', 'HTMLMediaElement', 'MutationObserver', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

let geometry = { width: 900, height: 400, left: 150, viewportWidth: 1200 };
let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => visibility });
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get() {
    return this === dom.window.document.documentElement ? geometry.viewportWidth : geometry.width;
  },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => geometry.height });

const observers = new Set<PreviewResizeObserver>();
class PreviewResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe() { observers.add(this); }
  disconnect() { observers.delete(this); }
  resize() { this.callback([], this as unknown as ResizeObserver); }
}
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: PreviewResizeObserver });

type MediaState = {
  paused: boolean;
  readyState: number;
  error: MediaError | null;
  plays: number;
  pauses: number;
  loads: number;
};
let mediaStates = new WeakMap<HTMLMediaElement, MediaState>();
function mediaState(video: HTMLMediaElement): MediaState {
  let state = mediaStates.get(video);
  if (!state) {
    state = { paused: true, readyState: 0, error: null, plays: 0, pauses: 0, loads: 0 };
    mediaStates.set(video, state);
  }
  return state;
}
for (const key of ['paused', 'readyState', 'error'] as const) {
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, key, {
    configurable: true,
    get() { return mediaState(this)[key]; },
  });
}

const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { MintPreview } = await import('../src/components/MintPreview.tsx');
type Props = Parameters<typeof MintPreview>[0];

beforeEach(() => {
  geometry = { width: 900, height: 400, left: 150, viewportWidth: 1200 };
  visibility = 'visible';
  mediaStates = new WeakMap();
  mock.method(dom.window.HTMLElement.prototype, 'getBoundingClientRect', () =>
    new dom.window.DOMRect(geometry.left, 0, geometry.width, geometry.height),
  );
  mock.method(dom.window.HTMLMediaElement.prototype, 'play', function () {
    const state = mediaState(this);
    state.paused = false;
    state.plays += 1;
    return Promise.resolve();
  });
  mock.method(dom.window.HTMLMediaElement.prototype, 'pause', function () {
    const state = mediaState(this);
    state.paused = true;
    state.pauses += 1;
  });
  mock.method(dom.window.HTMLMediaElement.prototype, 'load', function () {
    const state = mediaState(this);
    state.readyState = 0;
    state.error = null;
    state.loads += 1;
  });
});

afterEach(() => {
  cleanup();
  mock.restoreAll();
  assert.equal(observers.size, 0);
});

function props(overrides: Partial<Props> = {}): Props {
  return {
    dropId: 'little_swag_boxes',
    quantity: 1,
    quantityLabel: '1 pack',
    boxMedia: {
      imageSrc: '/box.webp',
      videoPosterSrc: '/poster.webp',
      videoSources: [{ src: '/box.webm', type: 'video/webm' }],
    },
    ...overrides,
  };
}

function requiredElement<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  assert.ok(element, `Missing ${selector}`);
  return element;
}

function imageComplete(image: HTMLImageElement, width: number) {
  Object.defineProperty(image, 'complete', { configurable: true, value: true });
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width });
}

function pageShow(persisted: boolean) {
  act(() => dom.window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted })));
}

test('video readiness and failures preserve the poster, image, and placeholder fallback order', () => {
  const view = render(createElement(MintPreview, props()));
  const video = requiredElement<HTMLVideoElement>(view.container, 'video');
  const [poster, image] = Array.from(view.container.querySelectorAll('img'));
  const placeholder = requiredElement<HTMLElement>(view.container, '.mint-panel__box--fallback');
  assert.ok(poster && image);
  assert.equal(video.classList.contains('mint-panel__box--video-loading'), true);
  assert.equal(poster.hidden, false);
  assert.equal(image.hidden, true);

  imageComplete(poster, 100);
  fireEvent.load(poster);
  assert.equal(placeholder.hidden, true);

  mediaState(video).readyState = 2;
  fireEvent.loadedData(video);
  assert.equal(video.hidden, false);
  assert.equal(video.classList.contains('mint-panel__box--video-loading'), false);
  assert.equal(poster.hidden, true);
  assert.equal(image.hidden, true);
  assert.equal(placeholder.hidden, true);

  mediaState(video).error = { code: 4 } as MediaError;
  fireEvent.error(video);
  assert.equal(video.hidden, true);
  assert.equal(poster.hidden, false);
  assert.equal(image.hidden, true);

  imageComplete(poster, 0);
  fireEvent.error(poster);
  assert.equal(poster.hidden, true);
  assert.equal(image.hidden, false);
  assert.equal(placeholder.hidden, false);

  imageComplete(image, 0);
  fireEvent.error(image);
  assert.equal(image.hidden, true);
  assert.equal(placeholder.hidden, false);

  fireEvent.loadStart(video);
  mediaState(video).error = null;
  mediaState(video).readyState = 2;
  fireEvent.canPlay(video);
  assert.equal(video.hidden, false);
  assert.equal(video.classList.contains('mint-panel__box--video-loading'), false);
  assert.equal(placeholder.hidden, true);
});

test('image previews retain their quantity, accessible label, and empty fallback', () => {
  const initial = props({ boxMedia: { imageSrc: '/box.webp' }, quantity: 3, quantityLabel: '3 boxes' });
  const view = render(createElement(MintPreview, initial));
  const boxes = view.getByLabelText('Mint preview: 3 boxes');
  assert.equal(boxes.children.length, 3);
  const image = requiredElement<HTMLImageElement>(boxes, 'img');
  const placeholder = image.nextElementSibling as HTMLElement;
  imageComplete(image, 100);
  fireEvent.load(image);
  assert.equal(placeholder.hidden, true);
  imageComplete(image, 0);
  fireEvent.error(image);
  assert.equal(image.hidden, true);
  assert.equal(placeholder.hidden, false);

  view.rerender(createElement(MintPreview, { ...initial, boxMedia: undefined }));
  assert.equal(boxes.querySelectorAll('img, video').length, 0);
  assert.equal(boxes.querySelectorAll('.mint-panel__box--fallback').length, 3);
});

test('unchanged source URLs keep playback stable while replacements reload and removed previews stop', () => {
  const view = render(createElement(MintPreview, props()));
  const video = requiredElement<HTMLVideoElement>(view.container, 'video');
  const state = mediaState(video);
  const initialPlays = state.plays;
  const initialLoads = state.loads;
  view.rerender(createElement(MintPreview, props()));
  assert.equal(requiredElement(view.container, 'video'), video);
  assert.equal(state.plays, initialPlays);
  assert.equal(state.loads, initialLoads);

  const replacement = props({ boxMedia: { videoSources: [{ src: '/replacement.webm', type: 'video/webm' }] } });
  view.rerender(createElement(MintPreview, replacement));
  assert.equal(requiredElement(view.container, 'video'), video);
  assert.equal(video.querySelector('source')?.getAttribute('src'), '/replacement.webm');
  assert.equal(state.loads, initialLoads + 1);
  assert.equal(state.paused, false);

  view.rerender(createElement(MintPreview, { ...replacement, quantity: 2, quantityLabel: '2 boxes' }));
  const secondVideo = view.container.querySelectorAll('video')[1];
  assert.ok(secondVideo);
  assert.equal(mediaState(secondVideo).paused, false);
  view.rerender(createElement(MintPreview, replacement));
  assert.equal(mediaState(secondVideo).paused, true);
  const removedPlays = mediaState(secondVideo).plays;
  pageShow(true);
  assert.equal(mediaState(secondVideo).plays, removedPlays);

  view.rerender(createElement(MintPreview, props({ boxMedia: { imageSrc: '/box.webp' } })));
  assert.equal(state.paused, true);
  const stoppedPlays = state.plays;
  pageShow(true);
  assert.equal(state.plays, stoppedPlays);
});

test('StrictMode playback follows page visibility, focus, persisted restoration, and unmount cleanup', () => {
  const view = render(createElement(MintPreview, props()), { reactStrictMode: true });
  const video = requiredElement<HTMLVideoElement>(view.container, 'video');
  const state = mediaState(video);
  assert.equal(state.paused, false);
  assert.equal(video.muted, true);
  assert.equal(video.defaultMuted, true);
  assert.equal(video.volume, 0);

  video.currentTime = 8;
  fireEvent(window, new dom.window.Event('blur'));
  assert.equal(state.paused, true);
  assert.equal(video.currentTime, 0);
  fireEvent(window, new dom.window.Event('focus'));
  assert.equal(state.paused, false);

  visibility = 'hidden';
  fireEvent(dom.window.document, new dom.window.Event('visibilitychange'));
  assert.equal(state.paused, true);
  const hiddenPlays = state.plays;
  fireEvent(window, new dom.window.Event('focus'));
  pageShow(true);
  assert.equal(state.plays, hiddenPlays);
  visibility = 'visible';
  fireEvent(dom.window.document, new dom.window.Event('visibilitychange'));
  assert.equal(state.paused, false);

  state.readyState = 2;
  const beforePageShowLoads = state.loads;
  pageShow(false);
  assert.equal(state.loads, beforePageShowLoads);
  pageShow(true);
  assert.equal(state.loads, beforePageShowLoads + 1);
  assert.equal(state.paused, false);
  fireEvent(window, new dom.window.Event('pagehide'));
  assert.equal(state.paused, true);
  pageShow(false);
  assert.equal(state.paused, false);

  view.unmount();
  assert.equal(state.paused, true);
  assert.equal(observers.size, 0);
  const afterUnmount = { ...state };
  fireEvent(window, new dom.window.Event('focus'));
  fireEvent(dom.window.document, new dom.window.Event('visibilitychange'));
  pageShow(true);
  fireEvent(window, new dom.window.Event('resize'));
  assert.deepEqual(state, afterUnmount);
});

test('resize measurements keep the preview grid within its bounds and constrain media scale on mobile', () => {
  const initial = props({
    quantity: 3,
    quantityLabel: '3 boxes',
    boxMedia: { videoSources: [{ src: '/box.webm' }], aspectRatio: 1.4, mediaScale: 1.5, compactMediaScale: 1.2 },
  });
  const view = render(createElement(MintPreview, initial));
  const boxes = requiredElement<HTMLElement>(view.container, '.mint-panel__boxes');
  const value = (property: string) => Number.parseFloat(boxes.style.getPropertyValue(property));
  const columns = value('--box-cols');
  assert.ok(columns >= 1 && columns <= 3);
  assert.ok(value('--box-width') * columns + value('--box-gap-x') * (columns - 1) <= geometry.width);
  const rows = Math.ceil(3 / columns);
  assert.ok(value('--box-height') * rows + value('--box-gap-y') * (rows - 1) <= geometry.height);

  view.rerender(createElement(MintPreview, { ...initial, quantity: 1, quantityLabel: '1 box' }));
  const desktopWidth = value('--box-width');
  assert.equal(value('--box-media-scale'), 1.5);
  assert.equal(value('--box-compact-media-scale'), 1.2);

  geometry = { width: 280, height: 280, left: 20, viewportWidth: 320 };
  act(() => observers.forEach((observer) => observer.resize()));
  assert.ok(value('--box-width') > 0 && value('--box-width') < desktopWidth);
  assert.ok(value('--box-media-scale') > 1 && value('--box-media-scale') < 1.5);
  assert.ok(value('--box-compact-media-scale') > 1 && value('--box-compact-media-scale') <= 1.2);
  assert.ok(value('--box-width') * value('--box-media-scale') <= geometry.viewportWidth + 0.001);
  assert.ok(value('--box-width') * value('--box-compact-media-scale') <= geometry.viewportWidth + 0.001);

  geometry = { width: 900, height: 400, left: 150, viewportWidth: 1200 };
  fireEvent(window, new dom.window.Event('resize'));
  assert.equal(value('--box-width'), desktopWidth);
  assert.equal(value('--box-media-scale'), 1.5);
  assert.equal(value('--box-compact-media-scale'), 1.2);
});
