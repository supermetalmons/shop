import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import {
  BackgroundBlurPortal,
  BackgroundBlurProvider,
} from '../src/components/BackgroundBlurLayer.tsx';
import { Modal } from '../src/components/Modal.tsx';
import { useOverlayScrollLock } from '../src/hooks/useOverlayScrollLock.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
let scrollLeft = 0;
let scrollTop = 0;
const scrollCalls: Array<[number, number]> = [];
const scrollBehaviors: string[] = [];

Object.defineProperty(dom.window, 'scrollX', { configurable: true, get: () => scrollLeft });
Object.defineProperty(dom.window, 'scrollY', { configurable: true, get: () => scrollTop });
Object.defineProperty(dom.window, 'scrollTo', {
  configurable: true,
  value: (left: number, top: number) => {
    scrollLeft = left;
    scrollTop = top;
    scrollCalls.push([left, top]);
    scrollBehaviors.push(document.documentElement.style.scrollBehavior);
  },
});
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'Element', { configurable: true, value: dom.window.Element });
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
Object.defineProperty(globalThis, 'Node', { configurable: true, value: dom.window.Node });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

const { cleanup, render, renderHook } = await import('@testing-library/react');

afterEach(() => {
  cleanup();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.body.className = '';
  document.body.removeAttribute('style');
  document.body.innerHTML = '<div id="root"></div>';
  scrollLeft = 0;
  scrollTop = 0;
  scrollCalls.length = 0;
  scrollBehaviors.length = 0;
});

test('overlay scroll locking preserves coordinates and existing overflow styles', () => {
  scrollLeft = 9;
  scrollTop = 720;
  document.documentElement.style.overflow = 'clip';
  document.documentElement.style.scrollBehavior = 'smooth';
  document.body.style.overflow = 'auto';
  let escapeCount = 0;
  const { rerender } = renderHook(
    ({ active, onEscape }) => {
      useOverlayScrollLock({ active, onEscape });
    },
    {
      initialProps: {
        active: false,
        onEscape: () => {
          escapeCount += 1;
        },
      },
    },
  );

  rerender({
    active: true,
    onEscape: () => {
      escapeCount += 1;
    },
  });

  assert.equal(document.documentElement.style.overflow, 'hidden');
  assert.equal(document.body.style.overflow, 'hidden');
  assert.equal(document.documentElement.classList.contains('overlay-scroll-lock'), true);
  assert.equal(document.body.classList.contains('overlay-scroll-lock'), true);
  assert.deepEqual(scrollCalls.at(-1), [9, 720]);
  assert.equal(scrollBehaviors.at(-1), 'auto');
  assert.equal(document.documentElement.style.scrollBehavior, 'smooth');

  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  assert.equal(escapeCount, 1);

  scrollLeft = 0;
  scrollTop = 680;
  rerender({
    active: false,
    onEscape: () => {
      escapeCount += 1;
    },
  });

  assert.equal(scrollLeft, 9);
  assert.equal(scrollTop, 720);
  assert.equal(document.documentElement.style.overflow, 'clip');
  assert.equal(document.documentElement.style.scrollBehavior, 'smooth');
  assert.equal(document.body.style.overflow, 'auto');
  assert.equal(document.documentElement.classList.contains('overlay-scroll-lock'), false);
  assert.equal(document.body.classList.contains('overlay-scroll-lock'), false);
});

test('overlay Escape ownership updates without changing its dismissal policy', () => {
  let firstHandlerCalls = 0;
  let secondHandlerCalls = 0;
  const { rerender } = renderHook(
    ({ enabled, onEscape }) => {
      useOverlayScrollLock({ active: true, escapeEnabled: enabled, onEscape });
    },
    {
      initialProps: {
        enabled: false,
        onEscape: () => {
          firstHandlerCalls += 1;
        },
      },
    },
  );

  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  assert.equal(firstHandlerCalls, 0);

  rerender({
    enabled: true,
    onEscape: () => {
      secondHandlerCalls += 1;
    },
  });
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

  assert.equal(firstHandlerCalls, 0);
  assert.equal(secondHandlerCalls, 1);
});

function NestedLockFixture({ modalOpen, overlayOpen }: { modalOpen: boolean; overlayOpen: boolean }) {
  useOverlayScrollLock({ active: overlayOpen });
  return createElement(
    Modal,
    {
      open: modalOpen,
      title: 'Nested modal',
      onClose: () => {},
      children: createElement('button', { type: 'button' }, 'Action'),
    },
  );
}

test('a nested modal cannot release the viewer scroll lock', () => {
  document.body.style.overflow = 'auto';
  const view = render(createElement(NestedLockFixture, { modalOpen: false, overlayOpen: true }));
  assert.equal(document.body.style.overflow, 'hidden');

  view.rerender(createElement(NestedLockFixture, { modalOpen: true, overlayOpen: true }));
  assert.equal(document.body.style.overflow, 'hidden');

  view.rerender(createElement(NestedLockFixture, { modalOpen: false, overlayOpen: true }));
  assert.equal(document.body.style.overflow, 'hidden');

  view.rerender(createElement(NestedLockFixture, { modalOpen: false, overlayOpen: false }));
  assert.equal(document.body.style.overflow, 'auto');
});

function BlurFixture({ open }: { open: boolean }) {
  return createElement(
    BackgroundBlurProvider,
    null,
    createElement('main', null, 'Background'),
    createElement(
      BackgroundBlurPortal,
      {
        open,
        active: open,
        children: createElement('div', null, 'Foreground'),
      },
    ),
  );
}

test('background freezing restores the first captured position after it closes', () => {
  scrollLeft = 4;
  scrollTop = 960;
  const view = render(createElement(BlurFixture, { open: false }));

  view.rerender(createElement(BlurFixture, { open: true }));
  assert.deepEqual(scrollCalls.at(-1), [4, 960]);
  assert.equal(document.querySelector('.background-blur-layer')?.getAttribute('inert'), '');

  scrollLeft = 0;
  scrollTop = 910;
  view.rerender(createElement(BlurFixture, { open: false }));

  assert.equal(scrollLeft, 4);
  assert.equal(scrollTop, 960);
  assert.equal(document.querySelector('.background-blur-layer')?.hasAttribute('inert'), false);
});

function NestedBlurFixture({ firstOpen, secondOpen }: { firstOpen: boolean; secondOpen: boolean }) {
  return createElement(
    BackgroundBlurProvider,
    null,
    createElement('main', null, 'Background'),
    createElement(
      BackgroundBlurPortal,
      {
        open: firstOpen,
        active: firstOpen,
        children: createElement('div', null, 'First foreground'),
      },
    ),
    createElement(
      BackgroundBlurPortal,
      {
        open: secondOpen,
        active: secondOpen,
        children: createElement('div', null, 'Second foreground'),
      },
    ),
  );
}

test('nested blur requests retain the first background position until the final close', () => {
  scrollLeft = 3;
  scrollTop = 500;
  const view = render(createElement(NestedBlurFixture, { firstOpen: true, secondOpen: false }));

  scrollLeft = 0;
  scrollTop = 470;
  view.rerender(createElement(NestedBlurFixture, { firstOpen: true, secondOpen: true }));
  view.rerender(createElement(NestedBlurFixture, { firstOpen: false, secondOpen: true }));
  assert.equal(scrollTop, 470);

  view.rerender(createElement(NestedBlurFixture, { firstOpen: false, secondOpen: false }));
  assert.equal(scrollLeft, 3);
  assert.equal(scrollTop, 500);
});
