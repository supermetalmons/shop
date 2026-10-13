import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ComponentProps, type CSSProperties } from 'react';
import type ClearCardThreeViewer from '../src/ClearCardThreeViewer.tsx';
import type { ClearCardThreeViewerHandle } from '../src/ClearCardThreeViewer.tsx';
import type ClearCardRevealOverlay from '../src/components/ClearCardRevealOverlay.tsx';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom, setMediaQueryMatches } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
type ViewerProps = ComponentProps<typeof ClearCardThreeViewer>;
type OverlayProps = ComponentProps<typeof ClearCardRevealOverlay>;
type ViewerInstance = { props: ViewerProps; mounted: boolean };
const instances: ViewerInstance[] = [];
let objectHit = false;
let pointerReleases = 0;
let cardRetries = 0;
let nextFrameId = 0;
let frames = new Map<number, FrameRequestCallback>();
let measureModels = true;
let imageReadFails = false;
const modelPreviewFrame = {
  bounds: { left: 0.2, top: 0.2, width: 0.6, height: 0.6 },
  canvas: { left: -100, top: -140, width: 600, height: 840 },
  viewport: { width: 400, height: 560 },
};
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => ({
    drawImage() {},
    getImageData(_x: number, _y: number, width: number, height: number) {
      if (imageReadFails) throw new Error('Image pixels are unavailable');
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 3; index < data.length; index += 4) data[index] = 255;
      return { data };
    },
  }),
});
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
    isClientPointOnObject() { return objectHit; },
    retryCardModel() { cardRetries += 1; },
    async captureSnapshot() { throw new Error('No snapshot'); },
  }), []);
  useLayoutEffect(() => {
    instance.mounted = true;
    instances.push(instance);
    if (measureModels) props.onPreviewFrame?.(modelPreviewFrame);
    return () => { instance.mounted = false; };
  }, []);
  return createElement('canvas', {
    className: 'clear-card-wip__canvas static-to-model__model',
    'aria-hidden': !props.ready,
    tabIndex: (props.keyboardActivationEnabled || props.keyboardRotationEnabled) && props.ready && props.interactionEnabled
      ? 0 : undefined,
    onPointerUp: () => { pointerReleases += 1; },
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

beforeEach(() => {
  instances.length = 0;
  frames.clear();
  objectHit = false;
  pointerReleases = 0;
  cardRetries = 0;
  measureModels = true;
  imageReadFails = false;
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', false);
});
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

function presentModel() {
  act(() => viewer().props.onStatusChange('ready'));
  act(() => viewer().props.onFrameRendered?.());
  advanceFrame();
  advanceFrame();
}

const openingStyle = {
  '--reveal-start-x': '-300px',
  '--reveal-start-y': '100px',
  '--reveal-start-scale-x': '0.3',
  '--reveal-start-scale-y': '0.3',
} as CSSProperties;

function finishFrameEntry(element: Element) {
  const event = new dom.window.Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'transform' });
  fireEvent(element, event);
}

function loadPreview(container: HTMLElement) {
  const image = container.querySelector('img');
  if (!image) return;
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 100 },
    naturalHeight: { configurable: true, value: 140 },
  });
  fireEvent.load(image);
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
}

async function mount(overrides: Partial<OverlayProps> = {}, loadImage = true) {
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
  if (loadImage) loadPreview(view.container);
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
  test(`${viewerMode || 'unpacking'} preserves the source preview throughout frame entry`, async () => {
    const h = await mount({ viewerMode, cardId: viewerMode === 'card' ? 1 : undefined, overlayStyle: openingStyle });
    presentModel();
    assert.equal(viewer().props.ready, false);
    assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);
    finishFrameEntry(h.view.container.querySelector('img')!);
    assert.equal(viewer().props.ready, false);

    finishFrameEntry(h.view.container.querySelector('.reveal-overlay__frame')!);
    assert.equal(viewer().props.ready, true);
    assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);
    presentModel();
    assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
  });

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

test('reduced motion presents the model without waiting for an opening transition', async () => {
  setMediaQueryMatches('(prefers-reduced-motion: reduce)', true);
  const h = await mount({ viewerMode: 'card', cardId: 1, overlayStyle: openingStyle });
  presentModel();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
});

test('opening can finish when the browser does not emit a transition event', async () => {
  const h = await mount({ viewerMode: 'pack', overlayStyle: openingStyle });
  act(() => viewer().props.onStatusChange('ready'));
  assert.equal(viewer().props.ready, false);
  await waitFor(() => assert.equal(viewer().props.ready, true));
  presentModel();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
});

for (const viewerMode of ['pack', 'card'] as const) {
  test(`${viewerMode} returns to the same contained preview while dismissing`, async () => {
    const h = await mount({ viewerMode, cardId: viewerMode === 'card' ? 1 : undefined });
    const preview = h.view.container.querySelector('img');
    presentModel();
    h.rerender({ closing: true });
    assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);
    assert.equal(h.viewport.classList.contains('clear-card-reveal-overlay__viewport--returning'), true);
    assert.equal(h.view.container.querySelector('img'), preview);
    assert.equal(viewer().props.interactionEnabled, false);
    act(() => viewer().props.onFrameRendered?.());
    advanceFrame();
    advanceFrame();
    assert.equal(h.viewport.classList.contains('static-to-model--presented'), false);
  });

  test(`${viewerMode} retains the model during dismissal when both preview requests fail`, async () => {
    const h = await mount({ viewerMode, cardId: viewerMode === 'card' ? 1 : undefined }, false);
    fireEvent.error(h.view.container.querySelector('img')!);
    fireEvent.error(h.view.container.querySelector('img')!);
    presentModel();
    h.rerender({ closing: true });
    assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
    assert.equal(h.viewport.classList.contains('clear-card-reveal-overlay__viewport--returning'), false);
    assert.equal(viewer().props.ready, true);
    assert.equal(viewer().props.interactionEnabled, false);
  });
}

test('closing an unpacked card keeps the revealed card instead of returning to the pack preview', async () => {
  const h = await mount();
  presentModel();
  act(() => viewer().props.onStageChange?.('revealed'));
  h.rerender({ closing: true });
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
  assert.equal(h.viewport.classList.contains('clear-card-reveal-overlay__viewport--returning'), false);
});

test('preview handoff waits for both image and model measurements before revealing a calibrated canvas', async () => {
  measureModels = false;
  const h = await mount({ viewerMode: 'card', cardId: 1 }, false);
  const image = h.view.container.querySelector('img')!;
  assert.equal(image.crossOrigin, 'anonymous');
  presentModel();
  assert.equal(viewer().props.ready, false);
  loadPreview(h.view.container);
  presentModel();
  assert.equal(viewer().props.ready, false);
  act(() => viewer().props.onPreviewFrame?.(modelPreviewFrame));
  assert.equal(viewer().props.ready, true);
  const visual = h.view.container.querySelector<HTMLElement>('.clear-card-reveal-overlay__visual')!;
  assert.match(visual.style.getPropertyValue('--clear-card-preview-transform'), /^translate\(.+\) scale\(.+\)$/);
  presentModel();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
});

test('image read and model measurement failures still allow the viewer to open', async () => {
  imageReadFails = true;
  const failedImage = await mount({ viewerMode: 'card', cardId: 1 });
  presentModel();
  assert.equal(failedImage.viewport.classList.contains('static-to-model--presented'), true);
  failedImage.rerender({ closing: true });
  assert.equal(failedImage.viewport.classList.contains('clear-card-reveal-overlay__viewport--returning'), true);
  failedImage.view.unmount();

  imageReadFails = false;
  measureModels = false;
  const failedModel = await mount({ viewerMode: 'pack' });
  act(() => viewer().props.onPreviewFrame?.(null));
  presentModel();
  assert.equal(failedModel.viewport.classList.contains('static-to-model--presented'), true);
});

test('a CORS failure retries the original preview without blocking model presentation', async () => {
  const h = await mount({ viewerMode: 'card', cardId: 1 }, false);
  const image = h.view.container.querySelector('img')!;
  fireEvent.error(image);
  const retry = h.view.container.querySelector('img')!;
  assert.notEqual(retry, image);
  assert.equal(retry.src, image.src);
  assert.equal(retry.getAttribute('crossorigin'), null);
  presentModel();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
  loadPreview(h.view.container);
  presentModel();
  h.rerender({ closing: true });
  assert.equal(h.viewport.classList.contains('clear-card-reveal-overlay__viewport--returning'), true);
});

test('resizing and changing the preview image recalculate alignment without remounting the model', async () => {
  const h = await mount({ viewerMode: 'card', cardId: 1 });
  const firstViewer = viewer();
  presentModel();
  const visual = h.view.container.querySelector<HTMLElement>('.clear-card-reveal-overlay__visual')!;
  const before = visual.style.getPropertyValue('--clear-card-preview-transform');
  act(() => viewer().props.onPreviewFrame?.({ ...modelPreviewFrame, viewport: { width: 600, height: 500 } }));
  assert.notEqual(visual.style.getPropertyValue('--clear-card-preview-transform'), before);
  h.rerender({ loadingImageSrc: 'https://example.com/dark-card.webp' });
  assert.equal(viewer().props.ready, false);
  loadPreview(h.view.container);
  presentModel();
  assert.equal(h.viewport.classList.contains('static-to-model--presented'), true);
  assert.equal(viewer(), firstViewer);
});

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

test('unpacking keeps fallback and revealed model clicks protected', async () => {
  const dismissed: boolean[] = [];
  const h = await mount({ onDismiss: () => dismissed.push(true) });
  const fallback = h.view.container.querySelector('img')!;
  Object.defineProperties(fallback, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
  fallback.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
  const frame = h.view.container.querySelector('.reveal-overlay__frame')!;
  act(() => viewer().props.onStatusChange('ready'));
  act(() => viewer().props.onStageChange?.('revealed'));
  fireEvent.click(frame, { clientX: 50, clientY: 50 });
  assert.deepEqual(dismissed, []);
  fireEvent.click(frame, { clientX: 150, clientY: 150 });
  assert.deepEqual(dismissed, [true]);
  presentModel();
  objectHit = true;
  const canvas = h.view.container.querySelector('canvas')!;
  pointer(canvas, 'pointerdown');
  pointer(canvas, 'pointerup', { timeStamp: 1200 });
  fireEvent.click(canvas, { detail: 1 });
  assert.deepEqual(dismissed, [true]);
});

for (const viewerMode of ['pack', 'card'] as const) {
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    test(`${viewerMode} preview dismisses once on complete ${pointerType} taps before and after model presentation`, async () => {
      let dismissals = 0;
      const h = await mount({ viewerMode, cardId: viewerMode === 'card' ? 1 : undefined, onDismiss: () => { dismissals += 1; } });
      const frame = h.view.container.querySelector('.reveal-overlay__frame')!;
      const dialog = h.view.getByRole('dialog');
      pointer(frame, 'pointerdown', { pointerType });
      assert.equal(dismissals, 0);
      pointer(frame, 'pointerup', { pointerType, timeStamp: 1350, clientX: 54 });
      assert.equal(dismissals, 1);
      fireEvent.click(frame, { detail: 1 });
      fireEvent.click(dialog, { detail: 1 });
      assert.equal(dismissals, 1);

      pointer(frame, 'pointerdown', { pointerType });
      pointer(frame, 'pointerup', { pointerType, timeStamp: 3000 });
      fireEvent.click(frame, { detail: 1 });
      fireEvent.click(dialog, { detail: 1 });
      assert.equal(dismissals, 1);

      presentModel();
      objectHit = true;
      const canvas = h.view.container.querySelector('canvas')!;
      assert.equal(viewer().props.pointerActivationEnabled, false);
      pointer(canvas, 'pointerdown', { pointerType });
      assert.equal(dismissals, 1);
      pointer(canvas, 'pointerup', { pointerType, timeStamp: 1200 });
      assert.equal(dismissals, 2);
      assert.equal(pointerReleases, 1, 'The model must still receive release to finish its rotation gesture');
      fireEvent.click(canvas, { detail: 1 });
      fireEvent.click(dialog, { detail: 1 });
      assert.equal(dismissals, 2);

      for (const gesture of ['hold', 'drag-return', 'release-movement', 'diagonal-movement', 'pointercancel', 'lostpointercapture', 'blur']) {
        pointer(canvas, 'pointerdown', { pointerType });
        if (gesture === 'drag-return') {
          pointer(canvas, 'pointermove', { pointerType, clientX: 54.5 });
          pointer(canvas, 'pointermove', { pointerType });
        } else if (gesture === 'blur') {
          fireEvent(window, new dom.window.Event('blur'));
        } else if (gesture === 'pointercancel' || gesture === 'lostpointercapture') {
          pointer(canvas, gesture, { pointerType });
        }
        pointer(canvas, 'pointerup', {
          pointerType,
          timeStamp: gesture === 'hold' ? 1351 : 1200,
          clientX: gesture === 'release-movement' ? 54.5 : gesture === 'diagonal-movement' ? 53 : 50,
          clientY: gesture === 'diagonal-movement' ? 54 : 50,
        });
        fireEvent.click(canvas, { detail: 1 });
        fireEvent.click(dialog, { detail: 1 });
        assert.equal(dismissals, 2, gesture);
      }
      pointer(canvas, 'pointerdown', { pointerType });
      pointer(canvas, 'pointerup', { pointerType, timeStamp: 1200 });
      assert.equal(dismissals, 3, 'The next complete tap still dismisses');
    });
  }

  test(`${viewerMode} preview preserves hold protection when release is retargeted to the backdrop`, async () => {
    let dismissals = 0;
    const h = await mount({ viewerMode, onDismiss: () => { dismissals += 1; } });
    const frame = h.view.container.querySelector('.reveal-overlay__frame')!;
    const backdrop = h.view.container.querySelector('.reveal-overlay__backdrop')!;
    pointer(frame, 'pointerdown');
    presentModel();
    pointer(backdrop, 'pointerup', { timeStamp: 3000 });
    fireEvent.click(h.view.getByRole('dialog'), { detail: 1 });
    assert.equal(dismissals, 0);
    pointer(backdrop, 'pointerdown');
    pointer(backdrop, 'pointerup', { timeStamp: 1200 });
    fireEvent.click(backdrop, { detail: 1 });
    assert.equal(dismissals, 1);
  });
}

test('preview retry controls remain usable without dismissing the viewer', async () => {
  let dismissals = 0;
  const h = await mount({ viewerMode: 'card', cardId: 1, onDismiss: () => { dismissals += 1; } });
  act(() => viewer().props.onStatusChange('error'));
  const oldViewer = viewer();
  const retry = h.view.getByRole('button', { name: 'Retry 3D' });
  pointer(retry, 'pointerdown');
  pointer(retry, 'pointerup', { timeStamp: 1200 });
  fireEvent.click(retry, { detail: 1 });
  await waitFor(() => assert.notEqual(viewer(), oldViewer));
  assert.equal(dismissals, 0);

  act(() => viewer().props.onCardModelLoadStatusChange?.('error'));
  const retryCard = h.view.getByRole('button', { name: 'Retry card' });
  pointer(retryCard, 'pointerdown');
  pointer(h.view.getByRole('dialog'), 'pointerup', { timeStamp: 1200 });
  fireEvent.click(h.view.getByRole('dialog'), { detail: 1 });
  assert.equal(dismissals, 0);
  pointer(retryCard, 'pointerdown');
  pointer(retryCard, 'pointerup', { timeStamp: 1200 });
  fireEvent.click(retryCard, { detail: 1 });
  assert.equal(cardRetries, 1);
  assert.equal(dismissals, 0);
});

for (const flag of ['closing', 'suspended'] as const) {
  test(`${flag} cancels an in-flight preview tap`, async () => {
    let dismissals = 0;
    const h = await mount({ viewerMode: 'pack', onDismiss: () => { dismissals += 1; } });
    const frame = h.view.container.querySelector('.reveal-overlay__frame')!;
    pointer(frame, 'pointerdown');
    h.rerender({ [flag]: true });
    h.rerender({ [flag]: false });
    pointer(frame, 'pointerup', { timeStamp: 1200 });
    fireEvent.click(frame, { detail: 1 });
    assert.equal(dismissals, 0);
    pointer(frame, 'pointerdown');
    pointer(frame, 'pointerup', { timeStamp: 1200 });
    assert.equal(dismissals, 1);
  });
}

test('unmount cancels pending fallback release', async () => {
  const h = await mount();
  act(() => viewer().props.onStatusChange('ready'));
  act(() => viewer().props.onFrameRendered?.());
  advanceFrame();
  assert.equal(frames.size, 1);
  h.view.unmount();
  assert.equal(frames.size, 0);
});
