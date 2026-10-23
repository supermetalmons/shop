import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import { DRIF_GLITTER_URL, DRIF_GRAIN_URL, type DrifCardConfig } from '../src/drifCards.ts';
import { normalizeFigureDisplayImage } from '../src/lib/dropContent.ts';
import { createMiNoteCard } from '../src/lib/miNoteCards.ts';
import { getInteractiveCardPackCardByFigureId } from '../src/lib/interactiveCardPackReveal.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { mockCardAssetImages } from './helpers/cardAssets.ts';
import { drifCardVisualAssetsCache, preloadDrifCardVisualAssets } from '../src/lib/drifCardVisualAssets.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const imports = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { default: DrifEffectCard } = await import('../src/components/DrifEffectCard.tsx');
const { PonchoCardViewerOverlay } = await import('../src/components/PonchoRevealOverlay.tsx');
imports.deregister();

const card = createMiNoteCard(1);
const frames = new Map<number, FrameRequestCallback>();
const timers = new Map<number, () => void>();
let time = 0;
let nextId = 0;

beforeEach((t: TestContext) => {
  time = 0;
  nextId = 0;
  frames.clear();
  timers.clear();
  t.mock.method(performance, 'now', () => time);
  const request = (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  };
  const cancel = (id: number) => { frames.delete(id); };
  t.mock.method(window, 'requestAnimationFrame', request);
  t.mock.method(window, 'cancelAnimationFrame', cancel);
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: request });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: cancel });
  t.mock.method(window, 'setTimeout', (callback: () => void) => {
    timers.set(++nextId, callback);
    return nextId;
  });
  t.mock.method(window, 'clearTimeout', (id: number) => { timers.delete(id); });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  cleanup();
  drifCardVisualAssetsCache.clear();
  assert.equal(frames.size, 0, 'unmount cancels animation frames');
  assert.equal(timers.size, 0, 'unmount clears interaction timers');
});
after(() => dom.window.close());

function runFrames(count = 1) {
  act(() => {
    for (let index = 0; index < count; index += 1) {
      time += 1000 / 60;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback(time));
    }
  });
}

function runTimers() {
  act(() => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach(callback => callback());
  });
}

function pointer(button: HTMLElement, type: string, pointerType = 'mouse', x = 90, y = 10) {
  const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(button, event);
}

function elements(container: HTMLElement) {
  const button = container.querySelector('button')!;
  const element = container.querySelector('.drif-effect-card') as HTMLElement;
  const image = container.querySelector('img')!;
  button.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) });
  return { button, element, image };
}

function pose(element: HTMLElement) {
  return ['--pointer-x', '--pointer-y', '--card-interaction-opacity', '--rotate-x', '--rotate-y', '--background-x', '--background-y']
    .map(property => element.style.getPropertyValue(property));
}

test('cards start unlit and settle normally after leaving', () => {
  const view = render(createElement(DrifEffectCard, { card, ariaLabel: 'Preview' }));
  const { button, element, image } = elements(view.container);
  runTimers();
  runFrames(10);
  fireEvent.load(image);
  assert.equal(element.style.getPropertyValue('--card-interaction-opacity'), '0');
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0');
  pointer(button, 'pointermove');
  runFrames(8);
  pointer(button, 'pointerup', 'touch');
  assert.ok(frames.size > 0);
  pointer(button, 'pointerout');
  assert.equal(timers.size, 1);
  runTimers();
  runFrames(1000);
  assert.deepEqual(pose(element), ['50%', '50%', '0', '0deg', '0deg', '50%', '50%']);
  assert.equal(frames.size, 0);
});

test('disabling interaction cancels pending animation and resets the pose without reloading the image', () => {
  const props = { card, ariaLabel: 'Preview' };
  const view = render(createElement(DrifEffectCard, props));
  const { button, element, image } = elements(view.container);
  fireEvent.load(image);
  pointer(button, 'pointermove');
  runFrames(8);
  assert.notEqual(element.style.getPropertyValue('--rotate-x'), '0deg');
  pointer(button, 'pointermove', 'mouse', 15, 90);
  assert.ok(frames.size > 0);
  view.rerender(createElement(DrifEffectCard, { ...props, interactive: false }));
  assert.deepEqual(pose(element), ['50%', '50%', '0', '0deg', '0deg', '50%', '50%']);
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(view.container.querySelector('img'), image);
  assert.equal(element.classList.contains('interacting'), false);
  view.rerender(createElement(DrifEffectCard, props));
  pointer(button, 'pointermove');
  runFrames(8);
  assert.notEqual(element.style.getPropertyValue('--rotate-x'), '0deg');
});

for (const wrapper of [
  { className: 'wip-reveal__card-item' },
  { className: 'reveal-overlay__media-item' },
  { className: 'doge-day-2026-wip-reveal__card-item', 'data-card-interaction-surface': true },
]) {
  test(`${wrapper.className} preserves hover wake through its interaction wrapper`, t => {
    setMediaQueryMatches('(any-hover: hover) and (any-pointer: fine)', true);
    const renderCard = (interactive: boolean) => createElement('div', wrapper,
      createElement('span', { 'data-hover-decoration': true }),
      createElement(DrifEffectCard, { card, ariaLabel: 'Preview', interactive, enableInteractiveUnlockWake: true }),
    );
    const view = render(renderCard(false));
    const { element, image } = elements(view.container);
    const hoveredDecoration = view.container.querySelector('[data-hover-decoration]')!;
    const query = document.querySelectorAll.bind(document);
    t.mock.method(document, 'querySelectorAll', (selector: string) => selector === ':hover'
      ? [hoveredDecoration] as unknown as NodeListOf<Element>
      : query(selector));
    fireEvent.load(image);
    runFrames(1);
    assert.equal(element.classList.contains('interacting'), false);
    view.rerender(renderCard(true));
    runFrames(3);
    assert.equal(element.classList.contains('interacting'), true);
    view.unmount();
    setMediaQueryMatches('(any-hover: hover) and (any-pointer: fine)', false);
  });
}

for (const dropId of ['mi_note_cards', 'poncho_drifella', 'card_nft_2']) {
  test(`${dropId} viewer keeps its idle effect through interaction, suspension, and visibility resets`, () => {
    const viewerCard = getInteractiveCardPackCardByFigureId(dropId, 1)!;
    const props = { card: viewerCard, active: true, closing: false };
    const view = render(createElement(PonchoCardViewerOverlay, props));
    const { button, element, image } = elements(view.container);
    fireEvent.load(image);
    runTimers();
    runFrames(1000);

    const assertIdle = () => {
      assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0.99');
      assert.deepEqual(pose(element), ['50%', '50%', '0', '0deg', '0deg', '50%', '50%']);
      assert.equal(element.classList.contains('interacting'), false);
      assert.equal(frames.size, 0);
      assert.equal(timers.size, 0);
    };

    assertIdle();
    for (const end of ['pointerout', 'pointercancel', 'blur']) {
      pointer(button, 'pointermove', end === 'pointercancel' ? 'touch' : 'mouse');
      runFrames(8);
      assert.notEqual(element.style.getPropertyValue('--rotate-x'), '0deg');
      if (end === 'blur') fireEvent.blur(button);
      else pointer(button, end);
      runTimers();
      runFrames(1000);
      assertIdle();
    }

    pointer(button, 'pointermove');
    runFrames(8);
    view.rerender(createElement(PonchoCardViewerOverlay, { ...props, suspended: true }));
    assertIdle();
    assert.equal(view.container.querySelector('img'), image);
    view.rerender(createElement(PonchoCardViewerOverlay, props));
    assertIdle();

    pointer(button, 'pointermove');
    runFrames(8);
    fireEvent(document, new dom.window.Event('visibilitychange'));
    runTimers();
    runFrames(1000);
    assertIdle();
  });
}

test('viewer keeps its static preview and interaction locked until every effect layer decodes', async (t) => {
  const preloadedImages = mockCardAssetImages(t);
  const props = { card, active: true, closing: false, loadingImageSrc: 'https://example.com/static.webp' };
  const view = render(createElement(PonchoCardViewerOverlay, props));
  const { button, element, image } = elements(view.container);
  assert.deepEqual(preloadedImages.map((asset) => asset.src), [
    card.imageSrc, card.textureSrc, DRIF_GRAIN_URL,
  ]);
  const assertPreview = () => {
    assert.equal(image.src, props.loadingImageSrc);
    assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0');
    pointer(button, 'pointermove');
    runFrames(8);
    assert.deepEqual(pose(element), ['50%', '50%', '0', '0deg', '0deg', '50%', '50%']);
  };
  fireEvent.load(image);
  assertPreview();
  await act(async () => {
    preloadedImages[0]!.load();
    preloadedImages[0]!.resolveDecode();
  });
  assertPreview();
  await act(async () => { preloadedImages.slice(1).forEach((asset) => asset.load()); });
  assertPreview();
  for (const asset of preloadedImages.slice(1, -1)) {
    await act(async () => { asset.resolveDecode(); });
    assertPreview();
  }
  await act(async () => { preloadedImages.at(-1)!.resolveDecode(); });
  assert.equal(image.src, card.imageSrc);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0.99');
  pointer(button, 'pointermove');
  runFrames(8);
  assert.notEqual(element.style.getPropertyValue('--rotate-x'), '0deg');
  view.unmount();
  assert.ok(preloadedImages.every((asset) => asset.src !== '' && !asset.onload && !asset.onerror));
});

test('inventory preview matching the front waits for all holo effects before becoming interactive', async (t) => {
  const preloadedImages = mockCardAssetImages(t);
  const holoCard = getInteractiveCardPackCardByFigureId('card_nft_2', 3)!;
  const loadingImageSrc = normalizeFigureDisplayImage('card_nft_2', undefined, 3);
  assert.equal(loadingImageSrc, holoCard.imageSrc);
  const view = render(createElement(PonchoCardViewerOverlay, {
    card: holoCard, active: true, closing: false, loadingImageSrc,
  }));
  const { button, element, image } = elements(view.container);
  assert.deepEqual(preloadedImages.map((asset) => asset.src), [
    holoCard.imageSrc, holoCard.textureSrc, holoCard.foilSrc, DRIF_GLITTER_URL,
  ]);
  const assertPreview = () => {
    assert.equal(image.src, loadingImageSrc);
    assert.equal(element.classList.contains('loading'), false);
    assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0');
    assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
    pointer(button, 'pointermove');
    runFrames(8);
    assert.deepEqual(pose(element), ['50%', '50%', '0', '0deg', '0deg', '50%', '50%']);
  };
  fireEvent.load(image);
  await act(async () => {
    preloadedImages.forEach((asset) => asset.load());
    preloadedImages[0]!.resolveDecode();
  });
  assertPreview();
  for (const asset of preloadedImages.slice(1, -1)) {
    await act(async () => { asset.resolveDecode(); });
    assertPreview();
  }
  await act(async () => { preloadedImages.at(-1)!.resolveDecode(); });
  assert.equal(image.src, holoCard.imageSrc);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0.99');
  assert.equal(element.style.getPropertyValue('--card-opacity'), '');
  pointer(button, 'pointermove');
  runFrames(8);
  assert.notEqual(element.style.getPropertyValue('--rotate-x'), '0deg');
});

test('switching cards ignores late decodes and waits for changed effect assets with the same front', async (t) => {
  const preloadedImages = mockCardAssetImages(t);
  const props = { card, active: true, closing: false, loadingImageSrc: 'https://example.com/static.webp' };
  const view = render(createElement(PonchoCardViewerOverlay, props));
  const { button, element, image } = elements(view.container);
  const firstBatch = [...preloadedImages];
  firstBatch.forEach((asset) => asset.load());
  const nextCard = createMiNoteCard(2);
  const nextPreview = 'https://example.com/static-2.webp';
  view.rerender(createElement(PonchoCardViewerOverlay, { ...props, card: nextCard, loadingImageSrc: nextPreview }));
  const secondBatch = preloadedImages.slice(firstBatch.length);
  assert.ok(firstBatch.every((asset) => asset.src !== ''));
  await act(async () => { firstBatch.forEach((asset) => asset.resolveDecode()); });
  assert.equal(image.src, nextPreview);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0');
  await act(async () => {
    secondBatch.forEach((asset) => { asset.load(); asset.resolveDecode(); });
  });
  assert.equal(image.src, nextCard.imageSrc);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0.99');
  pointer(button, 'pointermove');
  runFrames(8);
  assert.notEqual(element.style.getPropertyValue('--rotate-x'), '0deg');

  const changedCard = { ...nextCard, textureSrc: 'https://example.com/changed-mask.webp' } as DrifCardConfig;
  view.rerender(createElement(PonchoCardViewerOverlay, { ...props, card: changedCard, loadingImageSrc: nextPreview }));
  const thirdBatch = preloadedImages.slice(firstBatch.length + secondBatch.length);
  assert.equal(image.src, nextPreview);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0');
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
  assert.ok(secondBatch.every((asset) => asset.src !== ''));
  const mask = thirdBatch.find((asset) => asset.src === changedCard.textureSrc)!;
  assert.ok(mask);
  await act(async () => {
    thirdBatch.forEach((asset) => {
      asset.load();
      if (asset !== mask) asset.resolveDecode();
    });
  });
  assert.equal(image.src, nextPreview);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0');
  await act(async () => { mask.resolveDecode(); });
  assert.equal(image.src, nextCard.imageSrc);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0.99');
  assert.equal(element.style.getPropertyValue('--card-opacity'), '');
});

for (const failure of ['load', 'decode']) {
  test(`an effect ${failure} failure keeps the static preview visible and releases pending assets`, async (t) => {
    const preloadedImages = mockCardAssetImages(t);
    const props = { card, active: true, closing: false, loadingImageSrc: 'https://example.com/static.webp' };
    const view = render(createElement(PonchoCardViewerOverlay, props));
    const { button, element, image } = elements(view.container);
    await act(async () => {
      preloadedImages.slice(0, -1).forEach((asset) => { asset.load(); asset.resolveDecode(); });
      if (failure === 'load') preloadedImages.at(-1)!.onerror?.();
      else {
        preloadedImages.at(-1)!.load();
        preloadedImages.at(-1)!.rejectDecode(new Error('decode failed'));
      }
    });
    assert.equal(image.src, props.loadingImageSrc);
    assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0');
    pointer(button, 'pointermove');
    runFrames(8);
    assert.deepEqual(pose(element), ['50%', '50%', '0', '0deg', '0deg', '50%', '50%']);
    assert.ok(preloadedImages.every((asset) => asset.src === '' && !asset.onload && !asset.onerror));
  });
}

test('downloaded assets still wait for decode and pending work is reused after unmount', async (t) => {
  const preloadedImages = mockCardAssetImages(t, true);
  const props = { card, active: true, closing: false, loadingImageSrc: 'https://example.com/static.webp' };
  const view = render(createElement(PonchoCardViewerOverlay, props));
  const { element, image } = elements(view.container);
  assert.ok(preloadedImages.every((asset) => asset.decodeCalls === 1));
  assert.equal(image.src, props.loadingImageSrc);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0');
  await act(async () => { preloadedImages.forEach((asset) => asset.resolveDecode()); });
  assert.equal(image.src, card.imageSrc);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0.99');
  view.rerender(createElement(PonchoCardViewerOverlay, { ...props, card: createMiNoteCard(2) }));
  view.unmount();
  assert.ok(preloadedImages.every((asset) => asset.src !== ''));
  const assetCount = preloadedImages.length;
  const reopened = render(createElement(PonchoCardViewerOverlay, { ...props, card: createMiNoteCard(2) }));
  assert.equal(preloadedImages.length, assetCount);
  assert.equal(elements(reopened.container).image.src, props.loadingImageSrc);
  await act(async () => { preloadedImages.forEach((asset) => asset.resolveDecode()); });
  assert.equal(elements(reopened.container).image.src, createMiNoteCard(2).imageSrc);
});

test('preparing a card before mounting is reused and decoded reopen starts ready', async (t) => {
  const preloadedImages = mockCardAssetImages(t);
  preloadDrifCardVisualAssets(card);
  const assetCount = preloadedImages.length;
  assert.ok(assetCount > 0);
  const readiness: boolean[] = [];
  const props = {
    card, ariaLabel: 'Preview', showEffectAtRest: true, loadingImageSrc: 'https://example.com/static.webp',
    onImageReadyChange: (ready: boolean) => { readiness.push(ready); },
  };
  const first = render(createElement(DrifEffectCard, props));
  assert.equal(preloadedImages.length, assetCount);
  assert.equal(elements(first.container).image.src, props.loadingImageSrc);
  await act(async () => {
    preloadedImages.forEach((asset) => { asset.load(); asset.resolveDecode(); });
  });
  assert.deepEqual(readiness, [false, true]);
  first.unmount();
  readiness.length = 0;
  const reopened = render(createElement(DrifEffectCard, props));
  const { element, image, button } = elements(reopened.container);
  assert.deepEqual(readiness, [true]);
  assert.equal(preloadedImages.length, assetCount);
  assert.ok(preloadedImages.every((asset) => asset.decodeCalls === 1));
  assert.equal(image.src, card.imageSrc);
  assert.equal(element.style.getPropertyValue('--card-idle-opacity'), '0.99');
  pointer(button, 'pointermove');
  runFrames(8);
  assert.notEqual(element.style.getPropertyValue('--rotate-x'), '0deg');
});

for (const [change, changedCard] of [
  ['effect', { ...card, effect: { ...card.effect, id: 'changed-effect' } }],
  ['mask', { ...card, textureSrc: 'https://example.com/changed-mask.webp' }],
  ['foil', { ...card, foilSrc: 'https://example.com/changed-foil.webp' }],
] as const) {
  test(`cached front remains visible and interactive after ${change} changes without a static preview`, () => {
    let imageReady = false;
    const props = {
      card,
      ariaLabel: 'Preview',
      onImageReadyChange: (ready: boolean) => { imageReady = ready; },
    };
    const view = render(createElement(DrifEffectCard, props));
    const { button, element, image } = elements(view.container);
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 1000 },
    });
    fireEvent.load(image);
    assert.equal(imageReady, true);
    view.rerender(createElement(DrifEffectCard, { ...props, card: changedCard as DrifCardConfig }));
    assert.equal(view.container.querySelector('img'), image);
    assert.equal(image.src, card.imageSrc);
    assert.equal(element.classList.contains('loading'), false);
    assert.equal(imageReady, true);
    assert.equal(button.tabIndex, 0);
    pointer(button, 'pointermove');
    runFrames(8);
    assert.notEqual(element.style.getPropertyValue('--rotate-x'), '0deg');
  });
}
