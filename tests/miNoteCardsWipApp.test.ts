import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type MiNotePackViewer from '../src/components/MiNotePackViewer.tsx';
import type WipInteractiveCard from '../src/components/WipInteractiveCard.tsx';
import type { MiNotePackControls } from '../src/components/MiNotePackViewer.tsx';
import type { MiNoteRevealEvent } from '../src/lib/miNoteCardReveal.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

type ViewerProps = Parameters<typeof MiNotePackViewer>[0];
type CardProps = Parameters<typeof WipInteractiveCard>[0];
type ViewerInstance = { props: ViewerProps; calls: string[]; mounted: boolean };
const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const instances: ViewerInstance[] = [];
const assetListeners = new Set<() => void>();
let assetState = { ready: true, error: null as Error | null, retry() {} };
let escape: (instance: ViewerInstance) => boolean = () => false;

function FakeViewer(props: ViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const record = useRef<ViewerInstance | null>(null);
  if (!record.current) record.current = { props, calls: [], mounted: false };
  const instance = record.current;
  instance.props = props;
  useLayoutEffect(() => {
    instances.push(instance);
    instance.mounted = true;
    host.current!.append(...props.cardElements);
    const controls: MiNotePackControls = {
      activate() {
        instance.calls.push('activate');
        if (instance.props.interactionEnabled) instance.props.onEvent({ type: 'activate' });
      },
      selectCard(index) {
        instance.calls.push(`select:${index}`);
        instance.props.onEvent({ type: 'select-card', index });
      },
      returnCard() {
        instance.calls.push('return');
        instance.props.onEvent({ type: 'return-card' });
      },
      navigate(direction) { instance.calls.push(`navigate:${direction}`); },
      escape() { instance.calls.push('escape'); return escape(instance); },
    };
    props.controlsRef.current = controls;
    return () => {
      instance.mounted = false;
      props.cardElements.forEach(element => element.remove());
      if (props.controlsRef.current === controls) props.controlsRef.current = null;
    };
  }, []);
  return createElement('div', { ref: host, 'data-testid': 'viewer' });
}

function FakeCard(props: CardProps) {
  useEffect(() => props.onImageReadyChange?.(true), [props.onImageReadyChange]);
  return createElement('div', {
    'data-testid': 'card',
    'data-image': props.imageAlt,
    'data-interactive': String(props.interactive),
    'data-interaction-mode': props.interactionMode,
  });
}

function useFakeAssets() {
  return useSyncExternalStore(
    listener => { assetListeners.add(listener); return () => { assetListeners.delete(listener); }; },
    () => assetState,
  );
}

const bridgeKey = '__miNoteWipAppTest';
Object.defineProperty(globalThis, bridgeKey, {
  configurable: true,
  value: { FakeViewer, FakeCard, useFakeAssets },
});
const imports = registerHooks({
  load(url, context, nextLoad) {
    let source: string | undefined;
    if (url.endsWith('/components/MiNotePackViewer.tsx')) source = `export default globalThis.${bridgeKey}.FakeViewer;`;
    else if (url.endsWith('/components/WipInteractiveCard.tsx')) source = `export default globalThis.${bridgeKey}.FakeCard;`;
    else if (url.endsWith('/hooks/useMiNoteCardAssets.ts')) source = `export const useMiNoteCardAssets = globalThis.${bridgeKey}.useFakeAssets;`;
    else if (url.endsWith('.css')) source = '';
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
  },
});
const { default: MiNoteCardsWipApp } = await import('../src/MiNoteCardsWipApp.tsx');
imports.deregister();

beforeEach(() => {
  instances.length = 0;
  escape = () => false;
  assetState = { ready: true, error: null, retry() {} };
  window.localStorage.clear();
  window.history.replaceState(null, '', '/mi_note_cards/wip');
});
afterEach(() => {
  cleanup();
  assert.ok(instances.every(instance => !instance.mounted));
  assert.equal(assetListeners.size, 0);
});
after(() => { Reflect.deleteProperty(globalThis, bridgeKey); dom.window.close(); });

function viewer() {
  const instance = instances.at(-1);
  assert.ok(instance?.mounted);
  return instance;
}

function emit(event: MiNoteRevealEvent) {
  act(() => viewer().props.onEvent(event));
}

function makeReady() {
  act(() => viewer().props.onReadyChange(true));
}

function setAssets(ready: boolean) {
  act(() => {
    assetState = { ...assetState, ready };
    assetListeners.forEach(listener => listener());
  });
}

function peelSeal(view: ReturnType<typeof render>) {
  makeReady();
  for (let remaining = 4; remaining > 0; remaining -= 1) {
    fireEvent.click(view.getByRole('button', { name: new RegExp(`${remaining} taps? remaining`) }));
  }
  emit({ type: 'seal-finished' });
}

function openPack(view: ReturnType<typeof render>) {
  peelSeal(view);
  fireEvent.click(view.getByRole('button', { name: 'Open Mi Note Cards folder' }));
}

function card(index: 0 | 1) {
  const element = viewer().props.cardElements[index];
  const content = element.querySelector<HTMLElement>('[data-testid="card"]');
  assert.ok(content);
  return { element, content };
}

test('star selection removes Yellow, restores editable tuning, and locks Blush to its reference', t => {
  const storageKey = 'mi-note-star-folds:v1';
  const saved = JSON.stringify({
    version: 1,
    foldPositions: { yellow: 0.8, blush: 0.7, twinkle: 0.6, zombie: 0.5 },
    rotationOffsetsDegrees: { yellow: -10, blush: -9, twinkle: -8, zombie: -7 },
  });
  window.localStorage.setItem(storageKey, saved);
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  const view = render(createElement(MiNoteCardsWipApp));
  const picker = view.getByRole('combobox', { name: 'Star sticker' }) as HTMLSelectElement;
  assert.deepEqual(Array.from(picker.options, option => [option.value, option.text]), [
    ['blush', 'Blush Star'], ['twinkle', 'Twinkle Star'], ['zombie', 'Zombie Star'],
  ]);
  assert.equal(picker.value, 'blush');
  const position = view.getByRole('slider', { name: 'Horizontal position' }) as HTMLInputElement;
  const rotation = view.getByRole('slider', { name: 'Rotation' }) as HTMLInputElement;
  assert.equal(position.disabled, true);
  assert.equal(rotation.disabled, true);
  assert.equal(position.value, '57.8');
  assert.equal(rotation.value, '2.8');
  fireEvent.change(position, { target: { value: '80' } });
  fireEvent.change(rotation, { target: { value: '-10' } });
  assert.equal(viewer().props.foldPosition, 0.578);
  assert.equal(viewer().props.rotationOffsetDegrees, 2.8);
  assert.ok(view.getByRole('button', { name: 'Copy JSON' }));
  assert.equal(setItem.mock.callCount(), 0);
  assert.equal(window.localStorage.getItem(storageKey), saved);
  for (const [id, foldPosition, rotationOffsetDegrees] of [['twinkle', 0.6, -8], ['zombie', 0.5, -7]] as const) {
    fireEvent.change(picker, { target: { value: id } });
    assert.equal(viewer().props.star.id, id);
    assert.equal(viewer().props.foldPosition, foldPosition);
    assert.equal(viewer().props.rotationOffsetDegrees, rotationOffsetDegrees);
    assert.equal((view.getByRole('slider', { name: 'Horizontal position' }) as HTMLInputElement).disabled, false);
    assert.equal((view.getByRole('slider', { name: 'Rotation' }) as HTMLInputElement).disabled, false);
  }
});

test('star cycling wraps across three choices and reset preserves the selected tuning', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  const picker = view.getByRole('combobox', { name: 'Star sticker' }) as HTMLSelectElement;
  for (const id of ['twinkle', 'zombie', 'blush']) {
    fireEvent.click(view.getByRole('button', { name: 'Next star' }));
    assert.equal(picker.value, id);
    assert.equal(viewer().props.star.id, id);
  }
  fireEvent.click(view.getByRole('button', { name: 'Previous star' }));
  assert.equal(picker.value, 'zombie');
  fireEvent.change(view.getByRole('slider', { name: 'Horizontal position' }), { target: { value: '63.4' } });
  fireEvent.change(view.getByRole('slider', { name: 'Rotation' }), { target: { value: '-3.1' } });
  const previous = viewer();
  openPack(view);
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.notEqual(viewer(), previous);
  assert.equal(picker.value, 'zombie');
  assert.equal(viewer().props.star, previous.props.star);
  assert.equal(viewer().props.foldPosition, 0.634);
  assert.equal(viewer().props.rotationOffsetDegrees, -3.1);
  assert.equal(viewer().props.state.stage, 'sealed');
  assert.equal(viewer().props.state.taps, 0);
});

test('tuning updates a sealed pack in place and stays independent across stars and reloads', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  const picker = view.getByRole('combobox', { name: 'Star sticker' });
  fireEvent.change(picker, { target: { value: 'twinkle' } });
  makeReady();
  const previous = viewer();
  fireEvent.change(view.getByRole('slider', { name: 'Horizontal position' }), { target: { value: '64.2' } });
  fireEvent.change(view.getByRole('slider', { name: 'Rotation' }), { target: { value: '-4.1' } });
  assert.equal(viewer(), previous);
  assert.equal(viewer().props.interactionEnabled, true);
  assert.equal(viewer().props.foldPosition, 0.642);
  assert.equal(viewer().props.rotationOffsetDegrees, -4.1);
  fireEvent.change(picker, { target: { value: 'zombie' } });
  assert.equal(viewer().props.foldPosition, 0.487);
  assert.equal(viewer().props.rotationOffsetDegrees, 2.4);
  fireEvent.change(view.getByRole('slider', { name: 'Horizontal position' }), { target: { value: '44.3' } });
  fireEvent.change(picker, { target: { value: 'blush' } });
  assert.equal(viewer().props.foldPosition, 0.578);
  assert.equal(viewer().props.rotationOffsetDegrees, 2.8);
  view.unmount();
  const reloaded = render(createElement(MiNoteCardsWipApp));
  const restoredPicker = reloaded.getByRole('combobox', { name: 'Star sticker' });
  fireEvent.change(restoredPicker, { target: { value: 'twinkle' } });
  assert.equal(viewer().props.foldPosition, 0.642);
  assert.equal(viewer().props.rotationOffsetDegrees, -4.1);
  fireEvent.change(restoredPicker, { target: { value: 'zombie' } });
  assert.equal(viewer().props.foldPosition, 0.443);
  assert.equal(viewer().props.rotationOffsetDegrees, 2.4);
});

test('adjusting a peeled star reseals the same pack once before live tuning continues', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  fireEvent.change(view.getByRole('combobox', { name: 'Star sticker' }), { target: { value: 'twinkle' } });
  openPack(view);
  const previous = viewer();
  const images = previous.props.cardElements.map(element => element.querySelector<HTMLElement>('[data-image]')!.dataset.image);
  const mounts = instances.length;
  fireEvent.change(view.getByRole('slider', { name: 'Horizontal position' }), { target: { value: '65' } });
  assert.equal(instances.length, mounts + 1);
  assert.equal(previous.mounted, false);
  assert.equal(viewer().props.state.stage, 'sealed');
  assert.equal(viewer().props.state.folderPose, 0);
  assert.equal(viewer().props.state.taps, 0);
  assert.equal(viewer().props.color, previous.props.color);
  assert.deepEqual(viewer().props.cardElements.map(element => element.querySelector<HTMLElement>('[data-image]')!.dataset.image), images);
  const resealed = viewer();
  fireEvent.change(view.getByRole('slider', { name: 'Rotation' }), { target: { value: '6.4' } });
  assert.equal(viewer(), resealed);
  assert.equal(viewer().props.foldPosition, 0.65);
  assert.equal(viewer().props.rotationOffsetDegrees, 6.4);
});

test('peeling leaves the ready pack closed until the next click opens it', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  peelSeal(view);
  assert.equal(viewer().props.state.stage, 'interactive');
  assert.equal(viewer().props.state.folderPose, 0);
  const open = view.getByRole('button', { name: 'Open Mi Note Cards folder' }) as HTMLButtonElement;
  assert.equal(open.disabled, false);
  assert.equal(open.getAttribute('aria-expanded'), 'false');
  assert.equal(view.queryByRole('button', { name: 'View left card' }), null);
  fireEvent.click(open);
  assert.equal(viewer().props.state.folderPose, 1);
  assert.equal(viewer().calls.filter(call => call === 'activate').length, 5);
  assert.equal(view.getByRole('button', { name: 'Close Mi Note Cards folder' }).getAttribute('aria-expanded'), 'true');
  assert.ok(view.getByRole('button', { name: 'View left card' }));
});

test('accessible folder actions expose one inspected portal and settle it before returning', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  assert.equal((view.getByRole('button', { name: /4 taps remaining/ }) as HTMLButtonElement).disabled, true);
  assert.equal(view.queryByRole('button', { name: 'View left card' }), null);
  openPack(view);
  const close = view.getByRole('button', { name: 'Close Mi Note Cards folder' });
  assert.equal(close.getAttribute('aria-expanded'), 'true');
  assert.ok(view.getByRole('button', { name: 'View right card' }));
  for (const index of [0, 1] as const) {
    assert.equal(card(index).element.hasAttribute('inert'), true);
    assert.equal(card(index).content.dataset.interactive, 'false');
  }

  fireEvent.click(view.getByRole('button', { name: 'View left card' }));
  assert.equal(view.queryByRole('button', { name: 'Close Mi Note Cards folder' }), null);
  assert.equal((view.getByRole('button', { name: 'Return card to pocket' }) as HTMLButtonElement).disabled, true);
  assert.equal(card(0).element.hasAttribute('inert'), true);
  emit({ type: 'card-lifted' });
  assert.equal(card(0).element.hasAttribute('inert'), false);
  assert.equal(card(0).element.hasAttribute('aria-hidden'), false);
  assert.equal(card(0).content.dataset.interactive, 'true');
  assert.equal(card(0).content.dataset.interactionMode, 'normal');
  assert.equal(card(1).element.hasAttribute('inert'), true);
  assert.equal(card(1).content.dataset.interactive, 'false');

  act(() => viewer().props.onBackgroundTap());
  assert.equal(view.queryByRole('button', { name: 'Close Mi Note Cards preview' }), null);
  fireEvent.click(view.getByRole('button', { name: 'Return card to pocket' }));
  assert.equal(card(0).element.hasAttribute('inert'), true);
  assert.equal(card(0).content.dataset.interactive, 'true');
  assert.equal(card(0).content.dataset.interactionMode, 'settling');
  assert.equal((view.getByRole('button', { name: 'Return card to pocket' }) as HTMLButtonElement).disabled, true);
  emit({ type: 'card-returned' });
  assert.equal(card(0).content.dataset.interactive, 'false');
  assert.ok(view.getByRole('button', { name: 'View left card' }));
  fireEvent.click(view.getByRole('button', { name: 'Close Mi Note Cards folder' }));
  assert.equal(view.queryByRole('button', { name: 'View left card' }), null);
  assert.ok(view.getByRole('button', { name: 'Open Mi Note Cards folder' }));
});

test('modal Escape delegates to the active viewer before navigating away', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  openPack(view);
  fireEvent.click(view.getByRole('button', { name: 'View right card' }));
  escape = () => true;
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(window.location.pathname, '/mi_note_cards/wip');
  assert.equal(viewer().props.state.cardStage, 'lifting');
  emit({ type: 'card-lifted' });
  escape = instance => { instance.props.onEvent({ type: 'return-card' }); return true; };
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(viewer().props.state.cardStage, 'returning');
  assert.equal(window.location.pathname, '/mi_note_cards/wip');
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(window.location.pathname, '/mi_note_cards/wip');
  emit({ type: 'card-returned' });
  escape = instance => { instance.props.onEvent({ type: 'folder-pose', pose: 0 }); return true; };
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(viewer().props.state.folderPose, 0);
  assert.equal(window.location.pathname, '/mi_note_cards/wip');
  escape = () => false;
  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(window.location.pathname, '/');
  assert.equal(viewer().calls.filter(call => call === 'escape').length, 5);
});

test('card loading gates actions and retry preserves appearance while resetting the opening', t => {
  let random = 0.1;
  t.mock.method(Math, 'random', () => random);
  setAssets(false);
  const view = render(createElement(MiNoteCardsWipApp));
  fireEvent.click(view.getByRole('button', { name: 'Marigold' }));
  peelSeal(view);
  assert.equal(viewer().props.state.stage, 'unsealed');
  assert.equal(viewer().props.state.folderPose, 0);
  assert.equal((view.getByRole('button', { name: 'Open Mi Note Cards folder' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.getByText('Loading cards…').getAttribute('role'), 'status');
  assert.equal(view.queryByRole('button', { name: 'View left card' }), null);
  setAssets(true);
  assert.equal(viewer().props.state.stage, 'interactive');
  assert.equal(viewer().props.state.folderPose, 0);
  assert.equal(view.queryByText('Loading cards…'), null);
  assert.equal(view.queryByRole('button', { name: 'View left card' }), null);
  fireEvent.click(view.getByRole('button', { name: 'Open Mi Note Cards folder' }));
  assert.equal(viewer().props.state.folderPose, 1);
  const failed = viewer();
  const images = failed.props.cardElements.map(element => element.querySelector<HTMLElement>('[data-image]')!.dataset.image);
  act(() => failed.props.onError(new Error('Lost renderer')));
  assert.equal(viewer().props.interactionEnabled, false);
  assert.match(view.getByRole('alert').textContent!, /Unable to load this pack/);
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  assert.notEqual(viewer(), failed);
  assert.equal(failed.mounted, false);
  assert.equal(viewer().props.color, failed.props.color);
  assert.equal(viewer().props.star.id, failed.props.star.id);
  assert.deepEqual(viewer().props.cardElements.map(element => element.querySelector<HTMLElement>('[data-image]')!.dataset.image), images);
  assert.equal(viewer().props.state.stage, 'sealed');
  assert.equal(viewer().props.state.taps, 0);
  assert.equal(view.queryByRole('alert'), null);
  act(() => {
    failed.props.onEvent({ type: 'seal-finished' });
    failed.props.onReadyChange(true);
    failed.props.onError(new Error('Obsolete failure'));
  });
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(viewer().props.interactionEnabled, false);
  makeReady();
  random = 0.8;
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.equal(viewer().props.color, failed.props.color);
  assert.notDeepEqual(viewer().props.cardElements.map(element => element.querySelector<HTMLElement>('[data-image]')!.dataset.image), images);
  assert.equal(viewer().props.state.taps, 0);
});

test('keyboard shortcuts use current controls and leave focused form controls alone', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  makeReady();
  const dialog = view.getByRole('dialog', { name: 'Mi Note Cards pack preview' });
  fireEvent.keyDown(dialog, { key: ' ', code: 'Space' });
  fireEvent.keyDown(dialog, { key: 'Enter', code: 'Enter' });
  fireEvent.keyDown(dialog, { key: 'ArrowLeft', code: 'ArrowLeft' });
  fireEvent.keyDown(dialog, { key: 'ArrowRight', code: 'ArrowRight' });
  assert.deepEqual(viewer().calls, ['activate', 'activate', 'navigate:-1', 'navigate:1']);
  for (const target of [view.getByRole('combobox', { name: 'Star sticker' }), view.getByRole('button', { name: /2 taps remaining/ }), ...view.getAllByRole('slider'), view.getByRole('button', { name: 'Copy JSON' })]) {
    fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(target, { key: 'ArrowRight', code: 'ArrowRight' });
  }
  fireEvent.keyDown(dialog, { key: ' ', code: 'Space', repeat: true });
  fireEvent.keyDown(dialog, { key: 'Enter', code: 'Enter', ctrlKey: true });
  assert.equal(viewer().calls.length, 4);
  const previous = viewer();
  fireEvent.keyDown(dialog, { key: 'r', code: 'KeyR' });
  assert.notEqual(viewer(), previous);
  makeReady();
  fireEvent.keyDown(dialog, { key: 'Enter', code: 'Enter' });
  assert.deepEqual(viewer().calls, ['activate']);
  assert.equal(previous.calls.length, 4);
  assert.equal(viewer().props.state.taps, 1);
  const active = viewer();
  const mounts = instances.length;
  view.unmount();
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
  fireEvent.keyDown(window, { key: 'r', code: 'KeyR' });
  assert.equal(window.location.pathname, '/mi_note_cards/wip');
  assert.deepEqual(active.calls, ['activate']);
  assert.equal(instances.length, mounts);
});
