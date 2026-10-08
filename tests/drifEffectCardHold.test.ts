import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
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
const { default: WipInteractiveCard } = await import('../src/components/WipInteractiveCard.tsx');
imports.deregister();

const card = createMiNoteCard(1);
const frames = new Map<number, FrameRequestCallback>();
const timers = new Map<number, () => void>();
let time = 0;
let nextId = 0;
let visibility = 'visible';

beforeEach(t => {
  time = 0;
  nextId = 0;
  visibility = 'visible';
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
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  cleanup();
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
  return ['--pointer-x', '--pointer-y', '--card-opacity', '--rotate-x', '--rotate-y', '--background-x', '--background-y']
    .map(property => element.style.getPropertyValue(property));
}

test('hold preview initializes centered and lit after readiness, with no running animation', () => {
  const ready: boolean[] = [];
  const onImageReadyChange = (value: boolean) => ready.push(value);
  const props = { card, ariaLabel: 'Preview', holdPoseOnLeave: true, onImageReadyChange };
  const view = render(createElement(DrifEffectCard, props));
  const { element, image } = elements(view.container);
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
  fireEvent.load(image);
  assert.deepEqual(pose(element), ['50%', '50%', '0.99', '0deg', '0deg', '50%', '50%']);
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
  assert.deepEqual(ready, [false, true]);
  view.rerender(createElement(DrifEffectCard, { ...props, imageAlt: 'Updated panel setting' }));
  assert.equal(view.container.querySelector('img'), image);
  assert.deepEqual(ready, [false, true]);
  assert.equal(frames.size, 0);
});

test('mouse leave freezes visible values and discards pending pointer updates and idle animation', () => {
  const view = render(createElement(DrifEffectCard, { card, ariaLabel: 'Preview', holdPoseOnLeave: true }));
  const { button, element, image } = elements(view.container);
  fireEvent.load(image);
  pointer(button, 'pointermove');
  runFrames(8);
  const visible = pose(element);
  assert.notEqual(visible[3], '0deg');
  pointer(button, 'pointermove', 'mouse', 15, 90);
  pointer(button, 'pointerout');
  assert.deepEqual(pose(element), visible);
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(element.classList.contains('interacting'), false);
  runFrames(30);
  assert.deepEqual(pose(element), visible);
});

test('touch and pen release freeze the visible pose while mouse release continues tracking', () => {
  for (const pointerType of ['touch', 'pen', 'mouse']) {
    const view = render(createElement(WipInteractiveCard, { card, holdPoseOnLeave: true }));
    const { button, element, image } = elements(view.container);
    fireEvent.load(image);
    pointer(button, 'pointermove', pointerType);
    runFrames(8);
    const visible = pose(element);
    pointer(button, 'pointerup', pointerType);
    assert.equal(frames.size === 0, pointerType !== 'mouse');
    if (pointerType !== 'mouse') {
      runFrames(30);
      assert.deepEqual(pose(element), visible);
    }
    view.unmount();
  }
});

test('card blur and external panel focus freeze the preview', () => {
  const view = render(createElement('div', null,
    createElement(DrifEffectCard, { card, ariaLabel: 'Preview', holdPoseOnLeave: true }),
    createElement('input', { 'aria-label': 'Panel input' }),
  ));
  const { button, element, image } = elements(view.container);
  fireEvent.load(image);
  pointer(button, 'pointermove');
  runFrames(8);
  const firstPose = pose(element);
  fireEvent.blur(button);
  assert.deepEqual(pose(element), firstPose);
  assert.equal(frames.size, 0);
  pointer(button, 'pointermove', 'mouse', 20, 75);
  runFrames(8);
  const secondPose = pose(element);
  act(() => view.getByRole('textbox', { name: 'Panel input' }).focus());
  assert.deepEqual(pose(element), secondPose);
  assert.equal(frames.size, 0);
});

test('disabling hold settles a held pose without reloading its image or interrupting an active pointer', () => {
  const ready: boolean[] = [];
  const props = { card, ariaLabel: 'Preview', onImageReadyChange: (value: boolean) => ready.push(value) };
  const view = render(createElement(DrifEffectCard, { ...props, holdPoseOnLeave: true }));
  const { button, element, image } = elements(view.container);
  fireEvent.load(image);
  pointer(button, 'pointermove');
  runFrames(8);
  view.rerender(createElement(DrifEffectCard, { ...props, holdPoseOnLeave: false }));
  assert.equal(element.classList.contains('interacting'), true);
  assert.equal(timers.size, 0);
  view.rerender(createElement(DrifEffectCard, { ...props, holdPoseOnLeave: true }));
  pointer(button, 'pointerout');
  assert.equal(frames.size, 0);
  view.rerender(createElement(DrifEffectCard, { ...props, holdPoseOnLeave: false }));
  assert.ok(frames.size > 0);
  runFrames(500);
  assert.deepEqual(pose(element), ['50%', '50%', '0', '0deg', '0deg', '50%', '50%']);
  assert.equal(frames.size, 0);
  assert.equal(view.container.querySelector('img'), image);
  assert.deepEqual(ready, [false, true]);
});

test('pointer cancellation settles and cannot be converted to a hold by its subsequent leave or blur', () => {
  const view = render(createElement(DrifEffectCard, { card, ariaLabel: 'Preview', holdPoseOnLeave: true }));
  const { button, element, image } = elements(view.container);
  fireEvent.load(image);
  pointer(button, 'pointermove', 'touch');
  runFrames(8);
  pointer(button, 'pointercancel', 'touch');
  pointer(button, 'pointerout', 'touch');
  fireEvent.blur(button);
  runTimers();
  runFrames(1000);
  assert.deepEqual(pose(element), ['50%', '50%', '0', '0deg', '0deg', '50%', '50%']);
  assert.equal(frames.size, 0);
});

test('loading, interaction disable, settling, and visibility changes take precedence over a held pose', () => {
  const props = { card, ariaLabel: 'Preview', holdPoseOnLeave: true };
  const view = render(createElement(DrifEffectCard, props));
  const { element, image } = elements(view.container);
  fireEvent.load(image);
  view.rerender(createElement(DrifEffectCard, { ...props, interactive: false }));
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
  view.rerender(createElement(DrifEffectCard, props));
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
  const next = { ...props, card: createMiNoteCard(2) };
  view.rerender(createElement(DrifEffectCard, next));
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
  fireEvent.load(image);
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0.99');
  visibility = 'hidden';
  fireEvent(document, new dom.window.Event('visibilitychange'));
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
  assert.equal(frames.size, 0);
  assert.equal(timers.size, 0);
  visibility = 'visible';
  fireEvent(document, new dom.window.Event('visibilitychange'));
  view.rerender(createElement(DrifEffectCard, next));
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
  const { button } = elements(view.container);
  pointer(button, 'pointermove');
  runFrames(8);
  pointer(button, 'pointerout');
  view.rerender(createElement(DrifEffectCard, { ...next, interactionMode: 'settling' }));
  runFrames(500);
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
  assert.equal(frames.size, 0);
});

test('cards without hold retain unlit initial appearance and settle normally after leaving', () => {
  const view = render(createElement(DrifEffectCard, { card, ariaLabel: 'Preview' }));
  const { button, element, image } = elements(view.container);
  runTimers();
  runFrames(10);
  fireEvent.load(image);
  assert.equal(element.style.getPropertyValue('--card-opacity'), '0');
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
