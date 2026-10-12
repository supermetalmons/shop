import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ComponentProps } from 'react';
import type ClearCardThreeViewer from '../src/ClearCardThreeViewer.tsx';
import type { ClearCardThreeViewerHandle } from '../src/ClearCardThreeViewer.tsx';
import type ClearCardRevealOverlay from '../src/components/ClearCardRevealOverlay.tsx';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
type ViewerProps = ComponentProps<typeof ClearCardThreeViewer>;
type OverlayProps = ComponentProps<typeof ClearCardRevealOverlay>;
type ViewerInstance = { props: ViewerProps; mounted: boolean };
const instances: ViewerInstance[] = [];
let nextFrameId = 0;
let frames = new Map<number, FrameRequestCallback>();
window.requestAnimationFrame = callback => {
  const id = ++nextFrameId;
  frames.set(id, callback);
  return id;
};
window.cancelAnimationFrame = id => { frames.delete(id); };

const FakeViewer = forwardRef<ClearCardThreeViewerHandle, ViewerProps>((props, ref) => {
  const instanceRef = useRef<ViewerInstance | null>(null);
  if (!instanceRef.current) instanceRef.current = { props, mounted: false };
  const instance = instanceRef.current;
  instance.props = props;
  useImperativeHandle(ref, () => ({
    reset() {},
    hit() {},
    isClientPointOnObject() { return false; },
    retryCardModel() {},
    async captureSnapshot() { throw new Error('No snapshot'); },
  }), []);
  useLayoutEffect(() => {
    instance.mounted = true;
    instances.push(instance);
    return () => { instance.mounted = false; };
  }, []);
  return createElement('canvas', {
    className: 'clear-card-wip__canvas static-to-model__model',
    'aria-hidden': !props.ready,
    tabIndex: (props.keyboardActivationEnabled || props.keyboardRotationEnabled) && props.ready && props.interactionEnabled
      ? 0 : undefined,
  });
});

const bridgeKey = '__clearCardRevealOverlayTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { FakeViewer } });
const imports = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/ClearCardThreeViewer.tsx')) {
      return { format: 'module', source: `export default globalThis.${bridgeKey}.FakeViewer;`, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const { default: Overlay } = await import('../src/components/ClearCardRevealOverlay.tsx');

beforeEach(() => { instances.length = 0; frames.clear(); });
afterEach(() => {
  cleanup();
  assert.ok(instances.every(instance => !instance.mounted));
  assert.equal(frames.size, 0);
});
after(() => { imports.deregister(); Reflect.deleteProperty(globalThis, bridgeKey); dom.window.close(); });

function viewer() {
  const instance = instances.at(-1);
  assert.ok(instance?.mounted);
  return instance;
}

function advanceFrame() {
  act(() => {
    const pending = frames;
    frames = new Map();
    pending.forEach(callback => callback(0));
  });
}

async function mount(overrides: Partial<OverlayProps> = {}) {
  let props: OverlayProps = {
    active: true,
    closing: false,
    phase: 'ready',
    resetKey: 'pack-1',
    boxName: 'Clear Cards pack',
    loadingImageSrc: 'https://example.com/pack.webp',
    ...overrides,
  };
  const view = render(createElement(Overlay, props));
  await waitFor(() => assert.ok(instances.at(-1)?.mounted));
  const viewport = view.container.querySelector('.static-to-model')!;
  return {
    view,
    viewport,
    rerender(next: Partial<OverlayProps>) {
      props = { ...props, ...next };
      view.rerender(createElement(Overlay, props));
    },
  };
}

for (const viewerMode of [undefined, 'pack', 'card'] as const) {
  test(`${viewerMode || 'unpacking'} keeps the static image until a visible model frame has painted`, async () => {
    const h = await mount({ viewerMode, cardId: viewerMode === 'card' ? 1 : undefined });
    const firstInstance = viewer();
    const dialog = h.view.getByRole('dialog');
    const canvas = h.view.container.querySelector('canvas');
    assert.equal(h.viewport.classList.contains('static-to-model--visible'), false);
    act(() => viewer().props.onStatusChange('ready'));
    assert.equal(h.viewport.classList.contains('static-to-model--visible'), true);
    assert.equal(viewer().props.ready, true);
    assert.equal(viewer().props.interactionEnabled, false);
    assert.ok(document.activeElement === dialog);
    advanceFrame();
    advanceFrame();
    assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);

    act(() => viewer().props.onFrameRendered?.());
    advanceFrame();
    assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);
    assert.ok(document.activeElement === dialog);
    advanceFrame();
    assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
    assert.equal(viewer().props.interactionEnabled, true);
    assert.ok(document.activeElement === canvas, 'The canvas should receive focus after the handoff');
    assert.equal(viewer(), firstInstance);
  });
}

test('viewer failure cancels the handoff and retry ignores the previous viewer frame', async () => {
  const h = await mount();
  act(() => viewer().props.onStatusChange('ready'));
  const oldViewer = viewer();
  const oldFrame = oldViewer.props.onFrameRendered;
  act(() => oldFrame?.());
  advanceFrame();
  act(() => oldViewer.props.onStatusChange('error'));
  advanceFrame();
  assert.equal(h.viewport.classList.contains('static-to-model--visible'), false);
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);

  fireEvent.click(h.view.getByRole('button', { name: 'Retry 3D' }));
  await waitFor(() => assert.notEqual(viewer(), oldViewer));
  act(() => viewer().props.onStatusChange('ready'));
  act(() => oldFrame?.());
  advanceFrame();
  advanceFrame();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);
  act(() => viewer().props.onFrameRendered?.());
  advanceFrame();
  advanceFrame();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
});

test('an inactive overlay requires a new visible model frame after activation', async () => {
  const h = await mount({ active: false });
  act(() => viewer().props.onStatusChange('ready'));
  act(() => viewer().props.onFrameRendered?.());
  advanceFrame();
  advanceFrame();
  assert.equal(h.viewport.classList.contains('static-to-model--visible'), false);
  h.rerender({ active: true });
  assert.equal(h.viewport.classList.contains('static-to-model--visible'), true);
  advanceFrame();
  advanceFrame();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);
  act(() => viewer().props.onFrameRendered?.());
  advanceFrame();
  advanceFrame();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
});

test('restored readiness rejects an old frame callback even when the viewer identity is unchanged', async () => {
  const h = await mount();
  act(() => viewer().props.onStatusChange('ready'));
  const oldFrame = viewer().props.onFrameRendered;
  act(() => viewer().props.onStatusChange('error'));
  act(() => viewer().props.onStatusChange('ready'));
  act(() => oldFrame?.());
  advanceFrame();
  advanceFrame();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);
  act(() => viewer().props.onFrameRendered?.());
  advanceFrame();
  advanceFrame();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
});

test('the visible fallback protects clicks while the loaded model awaits presentation', async () => {
  const dismissed: boolean[] = [];
  const h = await mount({ viewerMode: 'pack', onDismiss: () => dismissed.push(true) });
  const fallback = h.view.container.querySelector('img')!;
  Object.defineProperties(fallback, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
  fallback.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
  const frame = h.view.container.querySelector('.reveal-overlay__frame')!;
  act(() => viewer().props.onStatusChange('ready'));
  fireEvent.click(frame, { clientX: 50, clientY: 50 });
  assert.deepEqual(dismissed, []);
  fireEvent.click(frame, { clientX: 150, clientY: 150 });
  assert.deepEqual(dismissed, [true]);
});

test('unmount cancels pending fallback release', async () => {
  const h = await mount();
  act(() => viewer().props.onStatusChange('ready'));
  act(() => viewer().props.onFrameRendered?.());
  advanceFrame();
  assert.equal(frames.size, 1);
  h.view.unmount();
  assert.equal(frames.size, 0);
});
