import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useLayoutEffect, useRef } from 'react';
import type MiNotePackViewer from '../src/components/MiNotePackViewer.tsx';
import type { MiNotePackControls } from '../src/components/MiNotePackViewer.tsx';
import type MiNotePackRevealOverlay from '../src/components/MiNotePackRevealOverlay.tsx';
import type { MiNoteRevealEvent } from '../src/lib/miNoteCardReveal.ts';
import type { RevealRequestStatus } from '../src/shop/reveal.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
type ViewerProps = Parameters<typeof MiNotePackViewer>[0];
type OverlayProps = Parameters<typeof MiNotePackRevealOverlay>[0];
type ViewerInstance = { props: ViewerProps; mounted: boolean };
const instances: ViewerInstance[] = [];

function FakeViewer(props: ViewerProps) {
  const ref = useRef<ViewerInstance | null>(null);
  if (!ref.current) ref.current = { props, mounted: false };
  const instance = ref.current;
  instance.props = props;
  useLayoutEffect(() => {
    instance.mounted = true;
    instances.push(instance);
    const controls: MiNotePackControls = {
      activate() {
        if (instance.props.interactionEnabled && instance.props.activationEnabled !== false) {
          instance.props.onEvent({ type: 'activate' });
        }
      },
      navigate(direction) { instance.props.onEvent({ type: 'folder-pose', pose: direction === 1 ? 2 : 0 }); },
      selectCard(index) { instance.props.onEvent({ type: 'select-card', index }); },
      returnCard() { instance.props.onEvent({ type: 'return-card' }); },
      escape() {
        const state = instance.props.state;
        if (state.selectedCard !== null) { controls.returnCard(); return true; }
        if (state.folderPose === 1) { instance.props.onEvent({ type: 'folder-pose', pose: 0 }); return true; }
        return false;
      },
    };
    props.controlsRef.current = controls;
    return () => {
      instance.mounted = false;
      if (props.controlsRef.current === controls) props.controlsRef.current = null;
    };
  }, []);
  return createElement('div', { tabIndex: 0, 'data-testid': 'mi-note-viewer' });
}

const bridgeKey = '__miNotePackRevealOverlayTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { FakeViewer } });
const imports = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/components/MiNotePackViewer.tsx')) {
      return { format: 'module', source: `export default globalThis.${bridgeKey}.FakeViewer;`, shortCircuit: true };
    }
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { default: Overlay } = await import('../src/components/MiNotePackRevealOverlay.tsx');
beforeEach(() => { instances.length = 0; });
afterEach(() => { cleanup(); assert.ok(instances.every(instance => !instance.mounted)); });
after(() => { imports.deregister(); Reflect.deleteProperty(globalThis, bridgeKey); dom.window.close(); });

function viewer() {
  const instance = instances.at(-1);
  assert.ok(instance?.mounted);
  return instance;
}

async function mount(overrides: Partial<OverlayProps> = {}) {
  const dismissed: boolean[] = [];
  const completed: boolean[] = [];
  const props: OverlayProps = {
    active: true, closing: false, phase: 'ready', packMediaId: 9, boxName: 'Pack 9',
    onDismiss: () => dismissed.push(true),
    onRevealCompleteChange: value => completed.push(value),
    ...overrides,
  };
  const view = render(createElement(Overlay, props));
  await waitFor(() => assert.ok(instances.at(-1)?.mounted));
  return { view, props, dismissed, completed, rerender: (next: Partial<OverlayProps>) => view.rerender(createElement(Overlay, { ...props, ...next })) };
}

function ready(cardsReady = false) {
  act(() => { viewer().props.onReadyChange(true); viewer().props.onCardsReadyChange(cardsReady); });
}

function activate() { act(() => viewer().props.controlsRef.current?.activate()); }
function emit(event: MiNoteRevealEvent) { act(() => viewer().props.onEvent(event)); }
function assertCleanOverlay(view: ReturnType<typeof render>) {
  assert.equal(view.queryByRole('status'), null);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(view.queryByRole('button', { name: 'Close' }), null);
  assert.equal(view.container.querySelector('.mi-note-wip__status'), null);
}

test('an unresolved pack keeps its placeholder until the correct 3D variant is available', async () => {
  const props: OverlayProps = { active: true, closing: false, viewerOnly: true, phase: 'revealed', boxName: 'Pack' };
  const view = render(createElement(Overlay, props));
  assert.equal(instances.length, 0);
  assert.equal(view.container.querySelector('img')?.getAttribute('src'), 'https://cdn.lil.org/nft/mi_note_cards/packs/clean/placeholder.webp');
  assertCleanOverlay(view);
  view.rerender(createElement(Overlay, { ...props, packMediaId: 9 }));
  await waitFor(() => assert.ok(instances.at(-1)?.mounted));
  assert.equal(viewer().props.color, '#20866C');
  assert.equal(viewer().props.star.id, 'supermetal');
});

test('live taps stay sealed until the assigned pair and both rendered card assets are ready', async () => {
  const pending = Promise.withResolvers<RevealRequestStatus>();
  let requests = 0;
  const h = await mount({ onRequestReveal: () => { requests += 1; return pending.promise; } });
  assertCleanOverlay(h.view);
  ready();
  assert.equal(viewer().props.cards, undefined);
  assert.equal(viewer().props.color, '#20866C');
  assert.equal(viewer().props.star.id, 'supermetal');
  for (let tap = 0; tap < 8; tap += 1) activate();
  await act(async () => {});
  assert.equal(requests, 1);
  assert.equal(viewer().props.state.stage, 'sealed');
  assert.equal(viewer().props.state.taps, 8);
  assertCleanOverlay(h.view);
  emit({ type: 'folder-pose', pose: 1 });
  assert.equal(viewer().props.state.folderPose, 0);
  h.rerender({ revealedIds: [1401, 1430] });
  assert.deepEqual(viewer().props.cards?.map(card => card.imageSrc), [
    'https://cdn.lil.org/nft/mi_note_cards/fronts/1401.webp',
    'https://cdn.lil.org/nft/mi_note_cards/fronts/1430.webp',
  ]);
  activate();
  assert.equal(viewer().props.state.stage, 'sealed');
  assert.equal(viewer().props.state.taps, 9);
  await act(async () => { pending.resolve('resolved'); await pending.promise; });
  act(() => viewer().props.onCardsReadyChange(true));
  assert.equal(viewer().props.state.stage, 'sealed');
  activate();
  assert.equal(viewer().props.state.stage, 'seal-peeling');
  assert.equal(viewer().props.state.folderPose, 0);
  emit({ type: 'folder-pose', pose: 1 });
  assert.equal(viewer().props.state.folderPose, 0);
  emit({ type: 'seal-finished' });
  assert.equal(viewer().props.state.stage, 'interactive');
  assert.equal(viewer().props.state.folderPose, 0);
  activate();
  fireEvent.click(h.view.getByRole('button', { name: 'View left card' }));
  emit({ type: 'card-lifted' });
  assert.equal(viewer().props.state.cardStage, 'inspecting');
  fireEvent.keyDown(h.view.getByTestId('mi-note-viewer'), { key: 'Escape' });
  assert.equal(viewer().props.state.cardStage, 'returning');
  emit({ type: 'card-returned' });
  fireEvent.keyDown(h.view.getByTestId('mi-note-viewer'), { key: 'Escape' });
  assert.equal(viewer().props.state.folderPose, 0);
  assert.deepEqual(h.dismissed, []);
  assertCleanOverlay(h.view);
  fireEvent.keyDown(h.view.getByTestId('mi-note-viewer'), { key: 'Escape' });
  assert.deepEqual(h.dismissed, [true]);
  assert.equal(requests, 1);
});

test('prepared cards still need three fresh activations and held keys do not count as taps', async () => {
  const h = await mount({ revealedIds: [1, 2] });
  ready(true);
  const renderer = h.view.getByTestId('mi-note-viewer');
  fireEvent.keyDown(renderer, { key: 'Enter', repeat: true });
  assert.equal(viewer().props.state.taps, 0);
  for (const key of ['Enter', ' ']) {
    fireEvent.keyDown(renderer, { key });
    assert.equal(viewer().props.state.stage, 'sealed');
  }
  fireEvent.keyDown(renderer, { key: 'Enter' });
  assert.equal(viewer().props.state.stage, 'seal-peeling');
});

test('closed-pack previews rotate but never request cards, peel the sticker, or open', async () => {
  const h = await mount({ viewerOnly: true, revealedIds: [1, 2], onRequestReveal: () => assert.fail('Preview must not reveal') });
  ready(true);
  assert.equal(viewer().props.cards, undefined);
  assert.equal(viewer().props.activationEnabled, false);
  for (let tap = 0; tap < 10; tap += 1) { activate(); emit({ type: 'activate' }); }
  emit({ type: 'folder-pose', pose: 1 });
  assert.equal(viewer().props.state.taps, 0);
  assert.equal(viewer().props.state.stage, 'sealed');
  assert.equal(viewer().props.state.folderPose, 0);
  fireEvent.click(h.view.getByRole('button', { name: 'Rotate pack right' }));
  assert.equal(viewer().props.state.folderPose, 2);
  fireEvent.keyDown(h.view.getByTestId('mi-note-viewer'), { key: 'Escape' });
  assert.deepEqual(h.dismissed, [true]);
});

test('request failures can retry without duplicate requests or losing the minimum tap gate', async () => {
  let requests = 0;
  const pending = Promise.withResolvers<RevealRequestStatus>();
  const h = await mount({ onRequestReveal: () => ++requests === 1 ? Promise.reject(new Error('Retry')) : pending.promise });
  ready();
  activate();
  await waitFor(() => assert.equal(h.completed.at(-1), true));
  assertCleanOverlay(h.view);
  for (let tap = 0; tap < 5; tap += 1) activate();
  await act(async () => {});
  assert.equal(requests, 2);
  assert.equal(viewer().props.state.stage, 'sealed');
  h.view.unmount();
  const completed = [...h.completed];
  await act(async () => { pending.resolve('resolved'); await pending.promise; });
  assert.deepEqual(h.completed, completed);
});

test('card loading retries keep assigned IDs and discard stale readiness from the previous viewer', async () => {
  const h = await mount({ revealedIds: [9, 1430], onRequestReveal: () => assert.fail('Assigned cards must not be requested again') });
  ready();
  activate(); activate(); activate();
  act(() => viewer().props.onCardsError(new Error('Texture failed')));
  const old = viewer();
  assertCleanOverlay(h.view);
  const retry = h.view.getByRole('button', { name: 'Retry loading pack' });
  assert.equal(retry.textContent, '');
  fireEvent.click(retry);
  assert.deepEqual(h.dismissed, []);
  await waitFor(() => assert.notEqual(viewer(), old));
  act(() => old.props.onCardsReadyChange(true));
  assert.equal(viewer().props.state.ready, false);
  assert.equal(viewer().props.state.taps, 0);
  ready(true);
  activate(); activate();
  assert.equal(viewer().props.state.stage, 'sealed');
  activate();
  assert.equal(viewer().props.state.stage, 'seal-peeling');
});

test('the background dismisses an unresolved or failed pack without a close button', async () => {
  const dismissed: boolean[] = [];
  const props: OverlayProps = {
    active: true, closing: false, phase: 'ready', boxName: 'Pack', onDismiss: () => dismissed.push(true),
  };
  const view = render(createElement(Overlay, props));
  fireEvent.click(view.container.querySelector('.reveal-overlay__frame')!);
  assert.deepEqual(dismissed, [true]);
  view.rerender(createElement(Overlay, { ...props, packMediaId: 9 }));
  await waitFor(() => assert.ok(instances.at(-1)?.mounted));
  act(() => viewer().props.onError(new Error('Renderer failed')));
  assertCleanOverlay(view);
  fireEvent.click(view.container.querySelector('.reveal-overlay__frame')!);
  assert.deepEqual(dismissed, [true, true]);
});

test('preparing and suspended overlays cannot advance, and incomplete pairs never unlock the seal', async () => {
  const h = await mount({ phase: 'preparing' });
  ready();
  emit({ type: 'activate' });
  assert.equal(viewer().props.state.taps, 0);
  h.rerender({ phase: 'ready', suspended: true });
  emit({ type: 'activate' });
  assert.equal(viewer().props.state.taps, 0);
  h.rerender({ phase: 'ready', revealedIds: [1] });
  ready(true);
  activate(); activate(); activate();
  assert.equal(viewer().props.cards, undefined);
  assert.equal(viewer().props.state.ready, false);
  assert.equal(viewer().props.state.stage, 'sealed');
});
