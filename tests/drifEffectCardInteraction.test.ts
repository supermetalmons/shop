import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
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

test('cards start unlit and settle normally after leaving', () => {
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
