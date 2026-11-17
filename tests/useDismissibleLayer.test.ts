import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { cleanup, fireEvent, render, renderHook } = await import('@testing-library/react');
const { useDismissibleLayer } = await import('../src/hooks/useDismissibleLayer.ts');

afterEach(cleanup);
after(() => dom.window.close());

for (const policy of [
  { touchStart: false, escapeBehavior: 'consume-unhandled' },
  { touchStart: true, escapeBehavior: 'always' },
] as const) {
  test(`${policy.escapeBehavior} dismisses outside mouse input and preserves its touch policy`, () => {
    const rootRef = { current: null as HTMLDivElement | null };
    const view = render(createElement('div', { ref: rootRef }, createElement('button', null, 'Inside')));
    const changes: boolean[] = [];
    renderHook(() => useDismissibleLayer({ open: true, rootRef, setOpen: (open) => changes.push(open), ...policy }));

    fireEvent.mouseDown(view.getByRole('button', { name: 'Inside' }));
    fireEvent.touchStart(view.getByRole('button', { name: 'Inside' }));
    assert.deepEqual(changes, []);
    fireEvent.mouseDown(document.body);
    assert.deepEqual(changes, [false]);
    fireEvent.touchStart(document.body);
    assert.deepEqual(changes, policy.touchStart ? [false, false] : [false]);

    changes.length = 0;
    rootRef.current = null;
    fireEvent.mouseDown(document.body);
    fireEvent.touchStart(document.body);
    assert.deepEqual(changes, []);
  });

  test(`${policy.escapeBehavior} preserves Escape cancellation and propagation`, () => {
    const changes: boolean[] = [];
    renderHook(() => useDismissibleLayer({
      open: true, rootRef: { current: null }, setOpen: (open) => changes.push(open), ...policy,
    }));
    fireEvent.keyDown(document, { key: 'Enter' });
    assert.deepEqual(changes, []);

    const handledEscape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handledEscape.preventDefault();
    fireEvent(document, handledEscape);
    assert.deepEqual(changes, policy.escapeBehavior === 'always' ? [false] : []);

    changes.length = 0;
    let bubbled = false;
    const observeEscape = () => { bubbled = true; };
    window.addEventListener('keydown', observeEscape, { once: true });
    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(document, escape);
    assert.deepEqual(changes, [false]);
    assert.equal(escape.defaultPrevented, policy.escapeBehavior === 'consume-unhandled');
    assert.equal(bubbled, true);
  });
}

test('closed and unmounted layers remove listeners, and rerenders use the current callback', () => {
  const rootRef = { current: document.body };
  const calls: string[] = [];
  const first = () => calls.push('first');
  const second = () => calls.push('second');
  const initialProps = { open: false, rootRef, setOpen: first, touchStart: true, escapeBehavior: 'always' as const };
  const { rerender, unmount } = renderHook(useDismissibleLayer, { initialProps });
  const dismiss = () => {
    fireEvent.mouseDown(document.documentElement);
    fireEvent.touchStart(document.documentElement);
    fireEvent.keyDown(document, { key: 'Escape' });
  };
  dismiss();
  assert.deepEqual(calls, []);
  rerender({ ...initialProps, open: true });
  dismiss();
  assert.deepEqual(calls, ['first', 'first', 'first']);
  rerender({ ...initialProps, open: true, setOpen: second });
  calls.length = 0;
  dismiss();
  assert.deepEqual(calls, ['second', 'second', 'second']);
  rerender({ ...initialProps, open: false, setOpen: second });
  calls.length = 0;
  dismiss();
  assert.deepEqual(calls, []);
  rerender({ ...initialProps, open: true, setOpen: second });
  unmount();
  dismiss();
  assert.deepEqual(calls, []);
});

test('unrelated rerenders preserve consuming layers in their opening order', () => {
  const rootRef = { current: null };
  const calls: string[] = [];
  const setFirst = () => calls.push('first');
  const setSecond = () => calls.push('second');
  const { rerender } = renderHook(({ firstOpen, secondOpen }) => {
    useDismissibleLayer({
      open: firstOpen, rootRef, setOpen: setFirst, touchStart: false, escapeBehavior: 'consume-unhandled',
    });
    useDismissibleLayer({
      open: secondOpen, rootRef, setOpen: setSecond, touchStart: false, escapeBehavior: 'consume-unhandled',
    });
  }, { initialProps: { firstOpen: false, secondOpen: true } });
  rerender({ firstOpen: true, secondOpen: true });
  rerender({ firstOpen: true, secondOpen: true });
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.deepEqual(calls, ['second']);
  rerender({ firstOpen: true, secondOpen: false });
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.deepEqual(calls, ['second', 'first']);
});
