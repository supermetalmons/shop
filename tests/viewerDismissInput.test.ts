import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement, useLayoutEffect, useRef } from 'react';
import { useViewerDismissInput } from '../src/hooks/useViewerDismissInput.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { cleanup, fireEvent, render } = await import('@testing-library/react');

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'visibilityState');
});
after(() => dom.window.close());

type Props = {
  enabled?: boolean;
  closing?: boolean;
  resetKey?: string;
  ignoreSelector?: string;
  onDismiss?: () => void;
  onRelease?: () => void;
  onNativeRelease?: (event: PointerEvent) => void;
  onControl?: () => void;
  onParentClick?: () => void;
};

function Viewer({ enabled = true, closing = false, onRelease, onNativeRelease, onControl, onParentClick, ...props }: Props) {
  const input = useViewerDismissInput({ ...props, enabled: enabled && !closing });
  const item = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = item.current!;
    if (!onNativeRelease) return;
    canvas.addEventListener('pointerup', onNativeRelease);
    return () => canvas.removeEventListener('pointerup', onNativeRelease);
  }, [onNativeRelease]);
  return createElement('div', { onClick: onParentClick },
    createElement('div', { ...input, 'data-testid': 'viewer' },
      createElement('div', { 'data-testid': 'backdrop' }),
      createElement('canvas', { ref: item, 'data-testid': 'item', onPointerUp: onRelease }),
      createElement('button', { onClick: onControl }, createElement('span', { 'data-testid': 'button-child' }, 'Retry')),
      createElement('a', { href: '#receipt', onClick: onControl }, createElement('span', { 'data-testid': 'link-child' }, 'Receipt')),
      createElement('div', { 'data-viewer-dismiss-ignore': '', onClick: onControl }, createElement('span', { 'data-testid': 'ignored-child' })),
      createElement('div', { className: 'delegate', onClick: onControl }, createElement('span', { 'data-testid': 'delegated-child' })),
    ),
  );
}

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
    pointerType: { value: options.pointerType ?? 'touch' },
    isPrimary: { value: options.isPrimary ?? true },
    timeStamp: { value: options.timeStamp ?? 1000 },
  });
  fireEvent(target, event);
  return event;
}

function mount(overrides: Props = {}) {
  let props = overrides;
  const view = render(createElement(Viewer, props));
  return {
    ...view,
    item: view.getByTestId('item'),
    backdrop: view.getByTestId('backdrop'),
    rerender(next: Props) {
      props = { ...props, ...next };
      view.rerender(createElement(Viewer, props));
    },
  };
}

test('complete taps dismiss once at the duration and movement boundaries while child release handlers finish', () => {
  const calls: string[] = [];
  const h = mount({
    onDismiss: () => calls.push('dismiss'),
    onRelease: () => calls.push('release'),
    onParentClick: () => calls.push('parent-click'),
  });
  pointer(h.item, 'pointerdown');
  assert.deepEqual(calls, []);
  const release = pointer(h.item, 'pointerup', { timeStamp: 1350, clientX: 54 });
  assert.equal(release.defaultPrevented, true);
  fireEvent.click(h.item, { detail: 1 });
  fireEvent.click(h.getByTestId('viewer'), { detail: 1 });
  assert.deepEqual(calls, ['dismiss', 'release']);
});

test('capture dismissal precedes native child cleanup that releases capture and stops bubbling', () => {
  const calls: string[] = [];
  const h = mount({
    onDismiss: () => calls.push('dismiss'),
    onRelease: () => calls.push('react-release'),
    onNativeRelease(event) {
      calls.push('native-release');
      pointer(event.target as Element, 'lostpointercapture');
      event.stopPropagation();
    },
  });
  pointer(h.item, 'pointerdown');
  pointer(h.item, 'pointerup', { timeStamp: 1200 });
  fireEvent.click(h.item, { detail: 1 });
  assert.deepEqual(calls, ['dismiss', 'native-release']);
});

test('nested controls and delegated viewers keep their actions without dismissing the parent', () => {
  let dismissals = 0;
  let actions = 0;
  const h = mount({
    ignoreSelector: '.delegate',
    onDismiss: () => { dismissals += 1; },
    onControl: () => { actions += 1; },
  });
  for (const id of ['button-child', 'link-child', 'ignored-child', 'delegated-child']) {
    const target = h.getByTestId(id);
    pointer(target, 'pointerdown');
    pointer(target, 'pointerup', { timeStamp: 1200 });
    fireEvent.click(target, { detail: 1 });
    fireEvent.click(target, { detail: 0 });
    assert.equal(dismissals, 0, id);
  }
  assert.equal(actions, 8);
  pointer(h.backdrop, 'pointerdown');
  pointer(h.backdrop, 'pointerup', { timeStamp: 1200 });
  assert.equal(dismissals, 1);
});

test('crossing between a control and the item or backdrop never completes a dismissal tap', () => {
  let dismissals = 0;
  const h = mount({ onDismiss: () => { dismissals += 1; } });
  const control = h.getByTestId('button-child');
  for (const [start, end] of [[control, h.backdrop], [h.item, control]]) {
    pointer(start, 'pointerdown');
    pointer(end, 'pointerup', { timeStamp: 1200 });
    fireEvent.click(h.getByTestId('viewer'), { detail: 1 });
    pointer(h.backdrop, 'pointerup', { timeStamp: 1250 });
    assert.equal(dismissals, 0);
  }
  pointer(h.item, 'pointerdown');
  pointer(h.item, 'pointerup', { timeStamp: 1200 });
  assert.equal(dismissals, 1);
});

test('holds, return drags, cancellation, and lost capture remain protected after retargeted releases', () => {
  let dismissals = 0;
  const h = mount({ onDismiss: () => { dismissals += 1; } });
  for (const gesture of ['hold', 'small-rotation', 'diagonal-movement', 'drag-return', 'pointercancel', 'lostpointercapture', 'leave', 'blur', 'visibility']) {
    pointer(h.item, 'pointerdown');
    if (gesture === 'small-rotation' || gesture === 'drag-return') {
      pointer(h.item, 'pointermove', { clientX: 54.5 });
      if (gesture === 'drag-return') pointer(h.item, 'pointermove');
    } else if (gesture === 'pointercancel' || gesture === 'lostpointercapture') {
      pointer(h.item, gesture);
    } else if (gesture === 'leave') {
      pointer(h.getByTestId('viewer'), 'pointerout');
    } else if (gesture === 'blur') {
      fireEvent(window, new dom.window.Event('blur'));
    } else if (gesture === 'visibility') {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      fireEvent(document, new dom.window.Event('visibilitychange'));
      Reflect.deleteProperty(document, 'visibilityState');
    }
    pointer(h.backdrop, 'pointerup', {
      timeStamp: gesture === 'hold' ? 1351 : 1200,
      clientX: gesture === 'small-rotation' ? 54.5 : gesture === 'diagonal-movement' ? 53 : 50,
      clientY: gesture === 'diagonal-movement' ? 54 : 50,
    });
    fireEvent.click(h.getByTestId('viewer'), { detail: 1 });
    assert.equal(dismissals, 0, gesture);
  }
  pointer(h.backdrop, 'pointerdown');
  pointer(h.backdrop, 'pointerup', { timeStamp: 1200 });
  assert.equal(dismissals, 1);
});

test('secondary pointers and clicks without a completed pointer sequence do not dismiss', () => {
  let dismissals = 0;
  const h = mount({ onDismiss: () => { dismissals += 1; } });
  for (const options of [{ button: 2 }, { isPrimary: false }]) {
    pointer(h.item, 'pointerdown', options);
    pointer(h.item, 'pointerup', { ...options, timeStamp: 1200 });
    fireEvent.click(h.item, { detail: 1 });
  }
  pointer(h.item, 'pointerup');
  fireEvent.click(h.item, { detail: 1 });
  assert.equal(dismissals, 0);
});

for (const transition of ['closing', 'disabled', 'resetKey'] as const) {
  test(`${transition} cancels the pending gesture before the viewer is reused`, () => {
    let dismissals = 0;
    const h = mount({ resetKey: 'first', onDismiss: () => { dismissals += 1; } });
    pointer(h.item, 'pointerdown');
    h.rerender(transition === 'resetKey' ? { resetKey: 'second' } : transition === 'closing' ? { closing: true } : { enabled: false });
    if (transition !== 'resetKey') {
      fireEvent.click(h.item, { detail: 0 });
      h.rerender({ enabled: true, closing: false });
    }
    pointer(h.item, 'pointerup', { timeStamp: 1200 });
    fireEvent.click(h.item, { detail: 1 });
    assert.equal(dismissals, 0);
    pointer(h.item, 'pointerdown');
    pointer(h.item, 'pointerup', { timeStamp: 1200 });
    assert.equal(dismissals, 1);
  });
}

test('unmount removes cancellation listeners and a new viewer cannot finish the old tap', t => {
  const addWindow = t.mock.method(window, 'addEventListener');
  const removeWindow = t.mock.method(window, 'removeEventListener');
  const addDocument = t.mock.method(document, 'addEventListener');
  const removeDocument = t.mock.method(document, 'removeEventListener');
  let dismissals = 0;
  const h = mount({ onDismiss: () => { dismissals += 1; } });
  pointer(h.item, 'pointerdown');
  h.unmount();
  for (const [added, removed, name] of [
    [addWindow, removeWindow, 'blur'],
    [addDocument, removeDocument, 'visibilitychange'],
  ] as const) {
    const registration = added.mock.calls.find(call => call.arguments[0] === name);
    assert.ok(registration);
    assert.ok(removed.mock.calls.some(call => call.arguments[0] === name && call.arguments[1] === registration.arguments[1]));
  }
  const next = mount({ onDismiss: () => { dismissals += 1; } });
  pointer(next.item, 'pointerup', { timeStamp: 1200 });
  fireEvent.click(next.item, { detail: 1 });
  assert.equal(dismissals, 0);
});

test('pointer and keyboard activations use the latest callback and respect hidden documents', () => {
  const calls: string[] = [];
  const h = mount({ onDismiss: () => calls.push('old') });
  pointer(h.item, 'pointerdown');
  h.rerender({ onDismiss: () => calls.push('new') });
  pointer(h.item, 'pointerup', { timeStamp: 1200 });
  fireEvent.click(h.item, { detail: 0 });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent.click(h.item, { detail: 0 });
  assert.deepEqual(calls, ['new', 'new']);
});
