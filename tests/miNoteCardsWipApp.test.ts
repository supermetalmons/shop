import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useLayoutEffect, useRef } from 'react';
import type MiNotePackViewer from '../src/components/MiNotePackViewer.tsx';
import type { MiNotePackControls } from '../src/components/MiNotePackViewer.tsx';
import type { MiNoteRevealEvent } from '../src/lib/miNoteCardReveal.ts';
import { MI_NOTE_CARD_EFFECTS } from '../src/lib/miNoteCardEffects.ts';
import { MI_NOTE_PACK_STARS } from '../src/lib/miNotePackStars.ts';
import { DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS } from '../src/lib/miNoteStickerEffects.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

type ViewerProps = Parameters<typeof MiNotePackViewer>[0];
type ViewerInstance = { props: ViewerProps; calls: string[]; mounted: boolean };
const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const instances: ViewerInstance[] = [];
let escape: (instance: ViewerInstance) => boolean = () => false;

function FakeViewer(props: ViewerProps) {
  const record = useRef<ViewerInstance | null>(null);
  if (!record.current) record.current = { props, calls: [], mounted: false };
  const instance = record.current;
  instance.props = props;
  useLayoutEffect(() => {
    instances.push(instance);
    instance.mounted = true;
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
      if (props.controlsRef.current === controls) props.controlsRef.current = null;
    };
  }, []);
  return createElement('div', { 'data-testid': 'viewer' });
}

const bridgeKey = '__miNoteWipAppTest';
Object.defineProperty(globalThis, bridgeKey, {
  configurable: true,
  value: { FakeViewer },
});
const imports = registerHooks({
  load(url, context, nextLoad) {
    let source: string | undefined;
    if (url.endsWith('/components/MiNotePackViewer.tsx')) source = `export default globalThis.${bridgeKey}.FakeViewer;`;
    else if (url.endsWith('.css')) source = '';
    else if (url.endsWith('.webp')) source = `export default ${JSON.stringify(url)};`;
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
  },
});
const { default: MiNoteCardsWipApp } = await import('../src/MiNoteCardsWipApp.tsx');
imports.deregister();

beforeEach(() => {
  instances.length = 0;
  escape = () => false;
  window.localStorage.clear();
  window.history.replaceState(null, '', '/mi_note_cards/wip');
});
afterEach(() => {
  cleanup();
  assert.ok(instances.every(instance => !instance.mounted));
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

function makeReady(cardsReady = true) {
  act(() => {
    viewer().props.onReadyChange(true);
    viewer().props.onCardsReadyChange(cardsReady);
  });
}

function peelSeal(view: ReturnType<typeof render>, cardsReady = true) {
  makeReady(cardsReady);
  for (let remaining = 4; remaining > 0; remaining -= 1) {
    fireEvent.click(view.getByRole('button', { name: new RegExp(`${remaining} taps? remaining`) }));
  }
  emit({ type: 'seal-finished' });
}

function openPack(view: ReturnType<typeof render>) {
  peelSeal(view);
  fireEvent.click(view.getByRole('button', { name: 'Open Mi Note Cards folder' }));
}

function renderedMiNoteCards() {
  const cards = viewer().props.cards.map(({ imageSrc, foilSrc, textureSrc, effect }) => {
    const id = imageSrc.match(/\/mi_note_cards\/fronts\/(\d+)\.webp$/)?.[1];
    assert.ok(id);
    assert.ok(Number(id) >= 1 && Number(id) <= 1430);
    assert.equal(imageSrc, `https://cdn.lil.org/nft/mi_note_cards/fronts/${id}.webp`);
    assert.equal(foilSrc, `https://cdn.lil.org/nft/mi_note_cards/foils/${id}.webp`);
    assert.equal(textureSrc, `https://cdn.lil.org/nft/mi_note_cards/masks/${id}.webp`);
    assert.equal(effect.effectKey, 'v-regular');
    return { id, imageSrc, foilSrc, textureSrc, effect };
  });
  assert.notEqual(cards[0].id, cards[1].id);
  return cards;
}

test('all stars use the chosen finish without controls or saved finish overrides', t => {
  const finishKeys = ['mi-note-sticker-effects:v1', 'mi-note-sticker-effects:prism-v1'];
  const saved = JSON.stringify({ version: 2, effect: {
    ...DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS, width: 0.02, outerness: 0.7, variation: 0.8,
  } });
  for (const key of finishKeys) window.localStorage.setItem(key, saved);
  const getItem = t.mock.method(dom.window.Storage.prototype, 'getItem');
  const view = render(createElement(MiNoteCardsWipApp));
  assert.equal(view.queryByRole('button', { name: 'Sticker finish' }), null);
  assert.equal(view.queryByRole('button', { name: 'Close-up' }), null);
  assert.equal(view.queryByRole('button', { name: 'Import sticker finish JSON' }), null);
  assert.equal(view.queryByRole('button', { name: 'Copy sticker finish JSON' }), null);
  assert.equal(view.queryByRole('slider', { name: 'Outerness' }), null);
  assert.equal(view.queryByRole('slider'), null);
  assert.equal(view.queryByRole('button', { name: 'Copy JSON' }), null);
  assert.deepEqual(viewer().props.effectSettings, DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
  const picker = view.getByRole('combobox', { name: 'Star sticker' });
  for (const id of ['supermetal', 'zombie', 'blush']) {
    fireEvent.change(picker, { target: { value: id } });
    assert.deepEqual(viewer().props.effectSettings, DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
    openPack(view);
    assert.equal(viewer().props.state.stage, 'interactive');
    assert.deepEqual(viewer().props.effectSettings, DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
    fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
    assert.equal(viewer().props.state.stage, 'sealed');
    assert.deepEqual(viewer().props.effectSettings, DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
  }
  view.unmount();
  render(createElement(MiNoteCardsWipApp));
  assert.deepEqual(viewer().props.effectSettings, DEFAULT_MI_NOTE_STICKER_EFFECT_SETTINGS);
  assert.ok(getItem.mock.calls.every(call => !finishKeys.includes(call.arguments[0])));
  for (const key of finishKeys) assert.equal(window.localStorage.getItem(key), saved);
});

test('star selection uses the final presets without tuning controls or saved overrides', t => {
  const storageKey = 'mi-note-star-folds:v1';
  const saved = JSON.stringify({
    version: 1,
    foldPositions: { blush: 0.7, zombie: 0.2, supermetal: 0.3 },
    rotationOffsetsDegrees: { blush: -9, zombie: -8, supermetal: -7 },
    verticalPosition: 0.7,
    sizeScales: { blush: 1.4, zombie: 0.85, supermetal: 0.5 },
  });
  window.localStorage.setItem(storageKey, saved);
  const getItem = t.mock.method(dom.window.Storage.prototype, 'getItem');
  const setItem = t.mock.method(dom.window.Storage.prototype, 'setItem');
  const view = render(createElement(MiNoteCardsWipApp));
  const picker = view.getByRole('combobox', { name: 'Star sticker' }) as HTMLSelectElement;
  assert.deepEqual(Array.from(picker.options, option => [option.value, option.text]), [
    ['blush', 'Blush Star'], ['zombie', 'Zombie Star'], ['supermetal', 'Supermetal Star'],
  ]);
  assert.equal(view.queryByRole('slider'), null);
  assert.equal(view.queryByRole('button', { name: 'Copy JSON' }), null);
  assert.equal(view.queryByRole('textbox', { name: 'Star tuning JSON' }), null);
  for (const [id, foldPosition, rotationOffsetDegrees, sizeScale] of [
    ['blush', 0.574, 2.8, 1.13], ['zombie', 0.513, 2.4, 1.22], ['supermetal', 0.58, 5.1, 1.18],
  ] as const) {
    fireEvent.change(picker, { target: { value: id } });
    fireEvent.click(view.getByRole('button', { name: 'Marigold' }));
    assert.equal(viewer().props.star.id, id);
    assert.equal(viewer().props.foldPosition, foldPosition);
    assert.equal(viewer().props.rotationOffsetDegrees, rotationOffsetDegrees);
    assert.equal(viewer().props.sizeScale, sizeScale);
    assert.equal(viewer().props.verticalPosition, 0.485);
  }
  view.unmount();
  render(createElement(MiNoteCardsWipApp));
  assert.equal(viewer().props.foldPosition, 0.574);
  assert.equal(viewer().props.rotationOffsetDegrees, 2.8);
  assert.equal(viewer().props.sizeScale, 1.13);
  assert.equal(viewer().props.verticalPosition, 0.485);
  assert.ok(getItem.mock.calls.every(call => call.arguments[0] !== storageKey));
  assert.equal(setItem.mock.callCount(), 0);
  assert.equal(window.localStorage.getItem(storageKey), saved);
});

test('star cycling wraps across the shortlist and reset preserves the selected preset', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  const picker = view.getByRole('combobox', { name: 'Star sticker' }) as HTMLSelectElement;
  for (const id of [...MI_NOTE_PACK_STARS.slice(1).map(star => star.id), 'blush']) {
    fireEvent.click(view.getByRole('button', { name: 'Next star' }));
    assert.equal(picker.value, id);
    assert.equal(viewer().props.star.id, id);
  }
  fireEvent.click(view.getByRole('button', { name: 'Previous star' }));
  assert.equal(picker.value, 'supermetal');
  const previous = viewer();
  openPack(view);
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.notEqual(viewer(), previous);
  assert.equal(picker.value, 'supermetal');
  assert.equal(viewer().props.star, previous.props.star);
  assert.equal(viewer().props.foldPosition, 0.58);
  assert.equal(viewer().props.rotationOffsetDegrees, 5.1);
  assert.equal(viewer().props.verticalPosition, 0.485);
  assert.equal(viewer().props.sizeScale, 1.18);
  assert.equal(viewer().props.state.stage, 'sealed');
  assert.equal(viewer().props.state.taps, 0);
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

test('accessible folder actions select either GPU card and wait for its return animation', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  assert.equal((view.getByRole('button', { name: /4 taps remaining/ }) as HTMLButtonElement).disabled, true);
  assert.equal(view.queryByRole('button', { name: 'View left card' }), null);
  openPack(view);
  const close = view.getByRole('button', { name: 'Close Mi Note Cards folder' });
  assert.equal(close.getAttribute('aria-expanded'), 'true');
  for (const side of ['left', 'right']) {
    const select = view.getByRole('button', { name: `View ${side} card` });
    const description = select.getAttribute('aria-description')!;
    assert.match(description, /^Mi Note Card #\d+$/);
    fireEvent.click(select);
    assert.equal(view.queryByRole('button', { name: 'Close Mi Note Cards folder' }), null);
    assert.equal((view.getByRole('button', { name: 'Return card to pocket', description }) as HTMLButtonElement).disabled, true);
    emit({ type: 'card-lifted' });
    assert.equal((view.getByRole('button', { name: 'Return card to pocket', description }) as HTMLButtonElement).disabled, false);
    fireEvent.click(view.getByRole('button', { name: 'Return card to pocket', description }));
    assert.equal(viewer().props.state.cardStage, 'returning');
    assert.equal((view.getByRole('button', { name: 'Return card to pocket', description }) as HTMLButtonElement).disabled, true);
    emit({ type: 'card-returned' });
    assert.equal(viewer().props.state.cardStage, 'pocket');
  }
  assert.deepEqual(viewer().calls.filter(call => call.startsWith('select:') || call === 'return'), ['select:0', 'return', 'select:1', 'return']);
  act(() => viewer().props.onBackgroundTap());
  assert.equal(view.queryByRole('button', { name: 'Close Mi Note Cards preview' }), null);
  assert.equal(view.queryByRole('combobox', { name: 'Effect' }), null);
  assert.ok(view.getByRole('button', { name: 'View left card' }));
  act(() => viewer().props.onBackgroundTap());
  assert.ok(view.getByRole('combobox', { name: 'Effect' }));
  fireEvent.click(view.getByRole('button', { name: 'Close Mi Note Cards folder' }));
  assert.equal(view.queryByRole('button', { name: 'View left card' }), null);
  assert.ok(view.getByRole('button', { name: 'Open Mi Note Cards folder' }));
});

test('all three card effects update live without replacing cards or resetting the opened pack', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  const picker = view.getByRole('combobox', { name: 'Effect' }) as HTMLSelectElement;
  assert.deepEqual(Array.from(picker.options, option => [option.value, option.text]), [
    ['v-regular', 'V Regular'], ['trainer-full-art', 'Trainer Full Art'], ['lighting-only', 'Lighting only'],
  ]);
  const initial = viewer();
  const cards = initial.props.cards;
  openPack(view);
  for (const { effect } of MI_NOTE_CARD_EFFECTS) {
    const state = viewer().props.state;
    fireEvent.change(picker, { target: { value: effect.effectKey } });
    assert.equal(viewer(), initial);
    assert.equal(viewer().props.cards, cards);
    assert.equal(viewer().props.state, state);
    assert.equal(viewer().props.cardEffect, effect);
    assert.equal(viewer().props.state.folderPose, 1);
  }
  fireEvent.click(view.getByRole('button', { name: 'View left card' }));
  emit({ type: 'card-lifted' });
  const inspecting = viewer().props.state;
  fireEvent.change(picker, { target: { value: 'trainer-full-art' } });
  assert.equal(viewer(), initial);
  assert.equal(viewer().props.cards, cards);
  assert.equal(viewer().props.state, inspecting);
  assert.equal(viewer().props.cardEffect.effectKey, 'trainer-full-art');
  assert.ok(cards.every(card => Boolean(card.foilSrc && card.textureSrc)));
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.equal(viewer().props.cardEffect.effectKey, 'trainer-full-art');
  assert.equal(picker.value, 'trainer-full-art');
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

test('Mi Note cards keep their assets and appearance through picker changes and retry, while reset resamples', t => {
  let random = 0.1;
  t.mock.method(Math, 'random', () => random);
  const view = render(createElement(MiNoteCardsWipApp));
  const initialCards = renderedMiNoteCards();
  assert.deepEqual(initialCards.map(({ id }) => id), ['144', '143']);
  random = 0.8;
  fireEvent.click(view.getByRole('button', { name: 'Marigold' }));
  assert.deepEqual(renderedMiNoteCards(), initialCards);
  fireEvent.change(view.getByRole('combobox', { name: 'Star sticker' }), { target: { value: 'zombie' } });
  assert.deepEqual(renderedMiNoteCards(), initialCards);
  peelSeal(view, false);
  assert.equal(viewer().props.state.stage, 'unsealed');
  assert.equal(viewer().props.state.folderPose, 0);
  assert.equal((view.getByRole('button', { name: 'Open Mi Note Cards folder' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.getByText('Loading cards…').getAttribute('role'), 'status');
  assert.equal(view.queryByRole('button', { name: 'View left card' }), null);
  act(() => viewer().props.onCardsReadyChange(true));
  assert.equal(viewer().props.state.stage, 'interactive');
  assert.equal(viewer().props.state.folderPose, 0);
  assert.equal(view.queryByText('Loading cards…'), null);
  assert.equal(view.queryByRole('button', { name: 'View left card' }), null);
  fireEvent.click(view.getByRole('button', { name: 'Open Mi Note Cards folder' }));
  assert.equal(viewer().props.state.folderPose, 1);
  fireEvent.change(view.getByRole('combobox', { name: 'Effect' }), { target: { value: 'lighting-only' } });
  const failed = viewer();
  act(() => failed.props.onError(new Error('Lost renderer')));
  assert.equal(viewer().props.interactionEnabled, false);
  assert.match(view.getByRole('alert').textContent!, /Unable to load this pack/);
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  assert.notEqual(viewer(), failed);
  assert.equal(failed.mounted, false);
  assert.equal(viewer().props.color, failed.props.color);
  assert.equal(viewer().props.star.id, failed.props.star.id);
  assert.equal(viewer().props.cardEffect.effectKey, 'lighting-only');
  assert.deepEqual(renderedMiNoteCards(), initialCards);
  assert.equal(viewer().props.state.stage, 'sealed');
  assert.equal(viewer().props.state.taps, 0);
  assert.equal(view.queryByRole('alert'), null);
  act(() => {
    failed.props.onEvent({ type: 'seal-finished' });
    failed.props.onReadyChange(true);
    failed.props.onCardsReadyChange(true);
    failed.props.onError(new Error('Obsolete failure'));
  });
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(viewer().props.interactionEnabled, false);
  makeReady();
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.equal(viewer().props.color, failed.props.color);
  assert.equal(viewer().props.star.id, failed.props.star.id);
  assert.equal(viewer().props.cardEffect.effectKey, 'lighting-only');
  const resetCards = renderedMiNoteCards();
  assert.notDeepEqual(resetCards, initialCards);
  assert.deepEqual(resetCards.map(({ id }) => id), ['1145', '1144']);
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
  for (const target of [view.getByRole('combobox', { name: 'Effect' }), view.getByRole('combobox', { name: 'Star sticker' }), view.getByRole('button', { name: /2 taps remaining/ }), view.getByRole('button', { name: 'Next star' }), view.getByRole('button', { name: 'Marigold' })]) {
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

test('effect-loading errors recover in the open pack without clearing renderer failures', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  openPack(view);
  const instance = viewer();
  act(() => {
    instance.props.onCardsReadyChange(false);
    instance.props.onCardsError(new Error('Missing foil'));
  });
  assert.ok(view.getByRole('alert'));
  assert.equal(instance.props.interactionEnabled, false);
  fireEvent.change(view.getByRole('combobox', { name: 'Effect' }), { target: { value: 'lighting-only' } });
  act(() => {
    instance.props.onCardsError(null);
    instance.props.onCardsReadyChange(true);
  });
  assert.equal(viewer(), instance);
  assert.equal(instance.props.state.folderPose, 1);
  assert.equal(instance.props.interactionEnabled, true);
  assert.equal(view.queryByRole('alert'), null);
  act(() => {
    instance.props.onError(new Error('Lost renderer'));
    instance.props.onCardsError(null);
  });
  assert.ok(view.getByRole('alert'));
  assert.equal(instance.props.interactionEnabled, false);
});
