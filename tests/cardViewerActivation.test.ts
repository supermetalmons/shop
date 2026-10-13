import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import { getInteractiveCardPackCardByFigureId } from '../src/lib/interactiveCardPackReveal.ts';
import { createMiNoteCard } from '../src/lib/miNoteCards.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
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

type CardProps = Parameters<typeof DrifEffectCard>[0];
type ViewerProps = Parameters<typeof PonchoCardViewerOverlay>[0];
const drops = ['mi_note_cards', 'poncho_drifella', 'card_nft_2'];
const pointerTypes = ['mouse', 'touch', 'pen'];
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
  assert.equal(frames.size, 0, 'unmount cancels animation frames');
  assert.equal(timers.size, 0, 'unmount clears interaction timers');
});
after(() => dom.window.close());

function pointer(target: Element, type: string, options: Partial<PointerEvent> = {}) {
  const event = new dom.window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: options.button ?? 0,
    clientX: options.clientX ?? 50,
    clientY: options.clientY ?? 50,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    pointerType: { value: options.pointerType ?? 'mouse' },
    isPrimary: { value: options.isPrimary ?? true },
    timeStamp: { value: options.timeStamp ?? time },
  });
  fireEvent(target, event);
  return event;
}

function tap(target: Element, options: Partial<PointerEvent> = {}) {
  pointer(target, 'pointerdown', options);
  pointer(target, 'pointerup', options);
}

function elements(container: HTMLElement) {
  const button = container.querySelector('button')!;
  const image = container.querySelector('img')!;
  const cardElement = container.querySelector('.drif-effect-card') as HTMLElement;
  button.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) });
  return { button, image, cardElement };
}

function mountViewer(dropId = 'mi_note_cards', overrides: Partial<ViewerProps> = {}) {
  let dismissals = 0;
  const props: ViewerProps = {
    card: getInteractiveCardPackCardByFigureId(dropId, 1)!,
    active: true,
    closing: false,
    onDismiss: () => { dismissals += 1; },
    ...overrides,
  };
  const view = render(createElement(PonchoCardViewerOverlay, props));
  return {
    view,
    props,
    ...elements(view.container),
    dialog: view.getByRole('dialog'),
    dismissals: () => dismissals,
  };
}

function mountCard(overrides: Partial<CardProps> = {}) {
  let activations = 0;
  const props: CardProps = {
    card: createMiNoteCard(1),
    ariaLabel: 'Card',
    onActivate: () => { activations += 1; },
    ...overrides,
  };
  const view = render(createElement(DrifEffectCard, props));
  return { view, props, ...elements(view.container), activations: () => activations };
}

function runTimersAndFrames(count = 8) {
  act(() => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach(callback => callback());
    for (let index = 0; index < count; index += 1) {
      time += 1000 / 60;
      const frameCallbacks = [...frames.values()];
      frames.clear();
      frameCallbacks.forEach(callback => callback(time));
    }
  });
}

for (const dropId of drops) {
  for (const pointerType of pointerTypes) {
    test(`${dropId} dismisses once on a complete ${pointerType} tap, never on press`, () => {
      const viewer = mountViewer(dropId);
      fireEvent.load(viewer.image);
      assert.equal(viewer.button.getAttribute('aria-label'), 'Close card viewer');
      assert.equal(viewer.image.alt, 'Revealed card');
      pointer(viewer.button, 'pointerdown', { pointerType });
      assert.equal(viewer.dismissals(), 0);
      pointer(viewer.button, 'pointerup', { pointerType });
      assert.equal(viewer.dismissals(), 1);
      fireEvent.click(viewer.button, { detail: 1 });
      fireEvent.click(viewer.button, { detail: 2 });
      assert.equal(viewer.dismissals(), 1);
    });

    test(`${dropId} preserves a ${pointerType} corner hold and accepts the next complete tap`, () => {
      const viewer = mountViewer(dropId);
      fireEvent.load(viewer.image);
      const corner = { pointerType, clientX: 90, clientY: 10 };
      pointer(viewer.button, 'pointerdown', { ...corner, timeStamp: 1000 });
      assert.equal(viewer.dismissals(), 0);
      pointer(viewer.button, 'pointerup', { ...corner, timeStamp: 3000 });
      fireEvent.click(viewer.button, { detail: 1 });
      fireEvent.click(viewer.dialog, { detail: 1 });
      assert.equal(viewer.dismissals(), 0);

      pointer(viewer.button, 'pointerdown', { ...corner, timeStamp: 4000 });
      pointer(viewer.button, 'pointerup', { ...corner, timeStamp: 4350 });
      fireEvent.click(viewer.button, { detail: 1 });
      assert.equal(viewer.dismissals(), 1);
      fireEvent.click(viewer.button, { detail: 0 });
      assert.equal(viewer.dismissals(), 2);
    });
  }

  test(`${dropId} preview is accessible and dismissible before the clean image loads`, (t) => {
    const preloadedImages: HTMLImageElement[] = [];
    t.mock.method(globalThis, 'Image', function () {
      const image = document.createElement('img');
      preloadedImages.push(image);
      return image;
    });
    const viewer = mountViewer(dropId, { loadingImageSrc: 'https://example.com/preview.webp' });
    assert.equal(viewer.image.src, viewer.props.loadingImageSrc);
    assert.equal(viewer.button.getAttribute('aria-disabled'), null);
    assert.equal(viewer.button.tabIndex, 0);
    tap(viewer.button, { pointerType: 'touch' });
    assert.equal(viewer.dismissals(), 1);
    fireEvent.click(viewer.button, { detail: 1 });
    assert.equal(viewer.dismissals(), 1);
    fireEvent.click(viewer.button, { detail: 0 });
    assert.equal(viewer.dismissals(), 2);

    pointer(viewer.button, 'pointerdown', { pointerType: 'touch' });
    fireEvent.load(preloadedImages[0]);
    assert.equal(viewer.image.src, viewer.props.card!.imageSrc);
    assert.equal(viewer.view.container.querySelector('button'), viewer.button);
    pointer(viewer.button, 'pointerup', { pointerType: 'touch' });
    assert.equal(viewer.dismissals(), 3);
    fireEvent.click(viewer.button, { detail: 1 });
    assert.equal(viewer.dismissals(), 3);
  });
}

for (const pointerType of pointerTypes) {
  test(`${pointerType} taps allow five pixels but reject longer and out-and-back drags`, () => {
    const viewer = mountViewer();
    fireEvent.load(viewer.image);
    pointer(viewer.button, 'pointerdown', { pointerType });
    pointer(viewer.button, 'pointerup', { pointerType, clientX: 53, clientY: 54 });
    assert.equal(viewer.dismissals(), 1);

    pointer(viewer.button, 'pointerdown', { pointerType });
    pointer(viewer.button, 'pointerup', { pointerType, clientX: 54, clientY: 54 });
    fireEvent.click(viewer.button, { detail: 1 });
    assert.equal(viewer.dismissals(), 1);

    pointer(viewer.button, 'pointerdown', { pointerType });
    pointer(viewer.button, 'pointermove', { pointerType, clientX: 56 });
    pointer(viewer.button, 'pointermove', { pointerType });
    pointer(viewer.button, 'pointerup', { pointerType });
    fireEvent.click(viewer.button, { detail: 1 });
    assert.equal(viewer.dismissals(), 1);
  });
}

test('dragging still tilts the card without dismissing it', () => {
  const viewer = mountViewer();
  fireEvent.load(viewer.image);
  runTimersAndFrames();
  pointer(viewer.button, 'pointerdown');
  pointer(viewer.button, 'pointermove', { clientX: 90, clientY: 10 });
  runTimersAndFrames();
  assert.notEqual(viewer.cardElement.style.getPropertyValue('--rotate-x'), '0deg');
  assert.notEqual(viewer.cardElement.style.getPropertyValue('--rotate-y'), '0deg');
  pointer(viewer.button, 'pointerup', { clientX: 90, clientY: 10 });
  fireEvent.click(viewer.button, { detail: 1 });
  assert.equal(viewer.dismissals(), 0);
});

test('a stationary touch hold at a corner keeps the card tilt interaction without dismissing on release', () => {
  const viewer = mountViewer();
  fireEvent.load(viewer.image);
  runTimersAndFrames();
  const corner = { pointerType: 'touch', clientX: 90, clientY: 10 };
  pointer(viewer.button, 'pointerover', { ...corner, timeStamp: 1000 });
  pointer(viewer.button, 'pointerdown', { ...corner, timeStamp: 1000 });
  runTimersAndFrames();
  assert.notEqual(viewer.cardElement.style.getPropertyValue('--rotate-x'), '0deg');
  assert.notEqual(viewer.cardElement.style.getPropertyValue('--rotate-y'), '0deg');
  pointer(viewer.button, 'pointerup', { ...corner, timeStamp: 3000 });
  fireEvent.click(viewer.button, { detail: 1 });
  assert.equal(viewer.dismissals(), 0);
});

test('a card drag released on the backdrop cannot dismiss through a common-ancestor click', () => {
  const viewer = mountViewer();
  pointer(viewer.button, 'pointerdown');
  pointer(viewer.button, 'pointermove', { clientX: 150 });
  pointer(viewer.button, 'pointerout', { clientX: 150 });
  pointer(viewer.dialog, 'pointerup', { clientX: 150 });
  fireEvent.click(viewer.dialog, { detail: 1 });
  assert.equal(viewer.dismissals(), 0);

  tap(viewer.dialog, { clientX: 150 });
  fireEvent.click(viewer.dialog, { detail: 1 });
  assert.equal(viewer.dismissals(), 1);
  fireEvent.click(viewer.button, { detail: 0 });
  assert.equal(viewer.dismissals(), 2);
});

for (const mouseStartsOnCard of [false, true]) {
  test(`overlapping touch input preserves a mouse gesture starting on the ${mouseStartsOnCard ? 'card' : 'backdrop'}`, () => {
    const viewer = mountViewer();
    const mouseTarget = mouseStartsOnCard ? viewer.button : viewer.dialog;
    const touchTarget = mouseStartsOnCard ? viewer.dialog : viewer.button;
    pointer(mouseTarget, 'pointerdown', { pointerId: 1, pointerType: 'mouse' });
    pointer(touchTarget, 'pointerdown', { pointerId: 2, pointerType: 'touch' });
    if (mouseStartsOnCard) {
      pointer(viewer.button, 'pointermove', { clientX: 150 });
      pointer(viewer.button, 'pointerout', { clientX: 150 });
    }
    pointer(viewer.dialog, 'pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 150 });
    fireEvent.click(viewer.dialog, { detail: 1 });
    assert.equal(viewer.dismissals(), mouseStartsOnCard ? 0 : 1);

    pointer(touchTarget, 'pointerup', { pointerId: 2, pointerType: 'touch' });
    fireEvent.click(touchTarget, { detail: 1 });
    assert.equal(viewer.dismissals(), mouseStartsOnCard ? 1 : 2);
  });
}

test('secondary and unrelated pointers cannot begin or complete activation', () => {
  const card = mountCard();
  tap(card.button, { button: 2 });
  tap(card.button, { isPrimary: false });
  pointer(card.button, 'pointerup');
  assert.equal(card.activations(), 0);
  pointer(card.button, 'pointerdown');
  pointer(card.button, 'pointerdown', { pointerId: 2, isPrimary: false });
  pointer(card.button, 'pointerup', { pointerId: 2, isPrimary: false });
  pointer(card.button, 'pointerup', { pointerId: 3 });
  assert.equal(card.activations(), 0);
  pointer(card.button, 'pointerup');
  assert.equal(card.activations(), 1);
});

test('a second finger leaving does not cancel the first finger tap', () => {
  const viewer = mountViewer();
  fireEvent.load(viewer.image);
  const primary = { pointerId: 1, pointerType: 'touch' };
  const secondary = { pointerId: 2, pointerType: 'touch', isPrimary: false };
  pointer(viewer.button, 'pointerdown', primary);
  pointer(viewer.button, 'pointerdown', secondary);
  pointer(viewer.button, 'pointerup', secondary);
  pointer(viewer.button, 'pointerout', secondary);
  assert.equal(viewer.dismissals(), 0);
  pointer(viewer.button, 'pointerup', primary);
  fireEvent.click(viewer.button, { detail: 1 });
  assert.equal(viewer.dismissals(), 1);
});

for (const end of ['pointerout', 'pointercancel', 'lostpointercapture', 'blur', 'window-blur']) {
  test(`${end} cancels a pending tap without disabling the next tap`, () => {
    const card = mountCard();
    pointer(card.button, 'pointerdown');
    if (end === 'blur') fireEvent.blur(card.button);
    else if (end === 'window-blur') fireEvent(window, new dom.window.Event('blur'));
    else pointer(card.button, end);
    pointer(card.button, 'pointerup');
    fireEvent.click(card.button, { detail: 1 });
    assert.equal(card.activations(), 0);
    tap(card.button);
    assert.equal(card.activations(), 1);
  });
}

for (const change of ['card', 'callback', 'interactive', 'settling'] as const) {
  test(`${change} changes cancel a pending gesture even after activation is restored`, () => {
    const card = mountCard();
    pointer(card.button, 'pointerdown');
    const changed: CardProps = {
      ...card.props,
      ...(change === 'card' ? { card: createMiNoteCard(2) } : {}),
      ...(change === 'callback' ? { onActivate: undefined } : {}),
      ...(change === 'interactive' ? { interactive: false } : {}),
      ...(change === 'settling' ? { interactionMode: 'settling' } : {}),
    };
    card.view.rerender(createElement(DrifEffectCard, changed));
    pointer(card.button, 'pointerup');
    fireEvent.click(card.button, { detail: 1 });
    assert.equal(card.activations(), 0);
    card.view.rerender(createElement(DrifEffectCard, card.props));
    pointer(card.button, 'pointerup');
    assert.equal(card.activations(), 0);
    tap(card.button);
    assert.equal(card.activations(), 1);
  });
}

test('a pending tap uses the latest callback without losing the gesture on rerender', () => {
  const card = mountCard();
  let updatedActivations = 0;
  pointer(card.button, 'pointerdown');
  card.view.rerender(createElement(DrifEffectCard, {
    ...card.props,
    onActivate: () => { updatedActivations += 1; },
  }));
  pointer(card.button, 'pointerup');
  assert.equal(card.activations(), 0);
  assert.equal(updatedActivations, 1);
  fireEvent.click(card.button, { detail: 0 });
  assert.equal(updatedActivations, 2);
});

for (const state of ['closing', 'suspended'] as const) {
  test(`${state} viewers reject pending taps and keyboard or backdrop activation`, () => {
    const viewer = mountViewer();
    fireEvent.load(viewer.image);
    pointer(viewer.button, 'pointerdown');
    viewer.view.rerender(createElement(PonchoCardViewerOverlay, { ...viewer.props, [state]: true }));
    pointer(viewer.button, 'pointerup');
    fireEvent.click(viewer.button, { detail: 0 });
    fireEvent.click(viewer.dialog, { detail: 0 });
    assert.equal(viewer.dismissals(), 0);
    viewer.view.rerender(createElement(PonchoCardViewerOverlay, viewer.props));
    pointer(viewer.button, 'pointerup');
    assert.equal(viewer.dismissals(), 0);
    tap(viewer.button);
    assert.equal(viewer.dismissals(), 1);
  });
}

test('unmount discards a pending tap and the next card needs its own press', () => {
  const card = mountCard();
  pointer(card.button, 'pointerdown');
  card.view.unmount();
  pointer(card.button, 'pointerup');
  assert.equal(card.activations(), 0);
  const next = mountCard();
  pointer(next.button, 'pointerup');
  assert.equal(next.activations(), 0);
  tap(next.button);
  assert.equal(next.activations(), 1);
});

test('legacy card clicks keep their existing behavior when onActivate is absent', () => {
  let clicks = 0;
  const card = mountCard({ onActivate: undefined, onClick: () => { clicks += 1; } });
  assert.equal(card.button.getAttribute('aria-disabled'), 'true');
  fireEvent.click(card.button, { detail: 0 });
  assert.equal(clicks, 0);
  fireEvent.load(card.image);
  pointer(card.button, 'pointerdown');
  pointer(card.button, 'pointermove', { clientX: 90 });
  pointer(card.button, 'pointerup', { clientX: 90 });
  assert.equal(clicks, 0);
  fireEvent.click(card.button, { detail: 1 });
  assert.equal(clicks, 1);
  fireEvent.click(card.button, { detail: 0 });
  assert.equal(clicks, 2);
  assert.equal(card.activations(), 0);
});
