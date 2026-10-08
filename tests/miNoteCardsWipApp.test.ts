import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useLayoutEffect, useRef } from 'react';
import type MiNotePackViewer from '../src/components/MiNotePackViewer.tsx';
import type { MiNotePackControls } from '../src/components/MiNotePackViewer.tsx';
import { MI_NOTE_PACK_VARIANTS, type MiNoteRevealEvent } from '../src/lib/miNoteCardReveal.ts';
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
  let random = 0.1;
  t.mock.method(Math, 'random', () => random);
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
  for (const value of [0.9, 0.5, 0.1]) {
    random = value;
    fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
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

test('random stars use the final presets without tuning controls or saved overrides', t => {
  let random = 0.1;
  t.mock.method(Math, 'random', () => random);
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
  assert.equal(view.queryByRole('combobox', { name: 'Star sticker' }), null);
  assert.equal(view.queryByRole('slider'), null);
  assert.equal(view.queryByRole('button', { name: 'Copy JSON' }), null);
  assert.equal(view.queryByRole('textbox', { name: 'Star tuning JSON' }), null);
  for (const [value, id, foldPosition, rotationOffsetDegrees, sizeScale] of [
    [0.1, 'blush', 0.574, 2.8, 1.13], [0.5, 'zombie', 0.513, 2.4, 1.22], [0.9, 'supermetal', 0.58, 5.1, 1.18],
  ] as const) {
    random = value;
    fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
    assert.equal(viewer().props.star.id, id);
    assert.equal(viewer().props.foldPosition, foldPosition);
    assert.equal(viewer().props.rotationOffsetDegrees, rotationOffsetDegrees);
    assert.equal(viewer().props.sizeScale, sizeScale);
    assert.equal(viewer().props.verticalPosition, 0.485);
  }
  view.unmount();
  random = 0.1;
  render(createElement(MiNoteCardsWipApp));
  assert.equal(viewer().props.foldPosition, 0.574);
  assert.equal(viewer().props.rotationOffsetDegrees, 2.8);
  assert.equal(viewer().props.sizeScale, 1.13);
  assert.equal(viewer().props.verticalPosition, 0.485);
  assert.ok(getItem.mock.calls.every(call => call.arguments[0] !== storageKey));
  assert.equal(setItem.mock.callCount(), 0);
  assert.equal(window.localStorage.getItem(storageKey), saved);
});

test('pack color and sticker are random on load and reset without appearance pickers', t => {
  let random = 0.1;
  t.mock.method(Math, 'random', () => random);
  const view = render(createElement(MiNoteCardsWipApp));
  assert.equal(view.queryByRole('combobox', { name: 'Star sticker' }), null);
  assert.equal(view.queryByRole('button', { name: 'Previous star' }), null);
  assert.equal(view.queryByRole('button', { name: 'Next star' }), null);
  assert.equal(view.queryByRole('group', { name: 'Pack color' }), null);
  for (const variant of MI_NOTE_PACK_VARIANTS) assert.equal(view.queryByRole('button', { name: variant.name }), null);
  assert.equal(viewer().props.color, MI_NOTE_PACK_VARIANTS[0].color);
  assert.equal(viewer().props.star, MI_NOTE_PACK_STARS[0]);
  for (const index of [1, 2, 0]) {
    const previous = viewer();
    openPack(view);
    random = (index + 0.5) / MI_NOTE_PACK_STARS.length;
    fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
    assert.notEqual(viewer(), previous);
    assert.equal(viewer().props.color, MI_NOTE_PACK_VARIANTS[index].color);
    assert.equal(viewer().props.star, MI_NOTE_PACK_STARS[index]);
    assert.equal(viewer().props.state.stage, 'sealed');
    assert.equal(viewer().props.state.taps, 0);
  }
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
    assert.equal((view.getByRole('button', { name: 'Return card to pocket', description }) as HTMLButtonElement).disabled, false);
    emit({ type: 'card-lifted' });
    assert.equal((view.getByRole('button', { name: 'Return card to pocket', description }) as HTMLButtonElement).disabled, false);
    fireEvent.click(view.getByRole('button', { name: 'Return card to pocket', description }));
    assert.equal(viewer().props.state.cardStage, 'returning');
    assert.equal((view.getByRole('button', { name: 'View card closeup', description }) as HTMLButtonElement).disabled, false);
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

test('accessible card action repeatedly reverses either moving card and ignores stale opposite completions', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  openPack(view);
  for (const [index, side] of ['left', 'right'].entries()) {
    const select = view.getByRole('button', { name: `View ${side} card` });
    const description = select.getAttribute('aria-description')!;
    fireEvent.click(select);
    for (let reversal = 0; reversal < 3; reversal += 1) {
      fireEvent.click(view.getByRole('button', { name: 'Return card to pocket', description }));
      assert.equal(viewer().props.state.cardStage, 'returning');
      emit({ type: 'card-lifted' });
      assert.equal(viewer().props.state.cardStage, 'returning');
      fireEvent.click(view.getByRole('button', { name: 'View card closeup', description }));
      assert.equal(viewer().props.state.cardStage, 'lifting');
      assert.equal(viewer().props.state.selectedCard, index);
      emit({ type: 'card-returned' });
      assert.equal(viewer().props.state.cardStage, 'lifting');
      assert.equal(view.queryByRole('button', { name: 'Close Mi Note Cards folder' }), null);
      assert.equal(view.queryByRole('button', { name: `View ${side === 'left' ? 'right' : 'left'} card` }), null);
    }
    fireEvent.click(view.getByRole('button', { name: 'Return card to pocket', description }));
    emit({ type: 'card-returned' });
    assert.ok(view.getByRole('button', { name: 'Close Mi Note Cards folder' }));
  }
  assert.deepEqual(viewer().calls.filter(call => call.startsWith('select:') || call === 'return'), [
    'select:0', 'return', 'select:0', 'return', 'select:0', 'return', 'select:0', 'return',
    'select:1', 'return', 'select:1', 'return', 'select:1', 'return', 'select:1', 'return',
  ]);
});

test('Space activates card actions on press and cannot repeat after a transition completes', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  openPack(view);
  fireEvent.click(view.getByRole('button', { name: 'View left card' }));
  emit({ type: 'card-lifted' });
  fireEvent.click(view.getByRole('button', { name: 'Return card to pocket' }));
  const action = view.getByRole('button', { name: 'View card closeup' });
  action.focus();
  assert.equal(fireEvent.keyDown(action, { key: ' ', code: 'Space' }), false);
  assert.equal(viewer().props.state.cardStage, 'lifting');
  emit({ type: 'card-returned' });
  assert.equal(viewer().props.state.cardStage, 'lifting');
  assert.equal(fireEvent.keyDown(action, { key: ' ', code: 'Space', repeat: true }), false);
  emit({ type: 'card-lifted' });
  fireEvent.keyUp(action, { key: ' ', code: 'Space' });
  assert.equal(viewer().props.state.cardStage, 'inspecting');
  assert.deepEqual(viewer().calls.filter(call => call.startsWith('select:')), ['select:0', 'select:0']);

  assert.equal(fireEvent.keyDown(action, { key: ' ', code: 'Space' }), false);
  assert.equal(viewer().props.state.cardStage, 'returning');
  emit({ type: 'card-returned' });
  assert.equal(view.getByRole('button', { name: 'Close Mi Note Cards folder' }), action);
  assert.equal(fireEvent.keyDown(action, { key: ' ', code: 'Space', repeat: true }), false);
  fireEvent.keyUp(action, { key: ' ', code: 'Space' });
  assert.equal(viewer().props.state.folderPose, 1);
  assert.equal(viewer().props.state.cardStage, 'pocket');
});

test('Enter keeps its initial native activation but suppresses repeats across card and folder actions', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  openPack(view);
  fireEvent.click(view.getByRole('button', { name: 'View left card' }));
  emit({ type: 'card-lifted' });
  fireEvent.click(view.getByRole('button', { name: 'Return card to pocket' }));
  const action = view.getByRole('button', { name: 'View card closeup' });
  action.focus();
  assert.equal(fireEvent.keyDown(action, { key: 'Enter', code: 'Enter' }), true);
  fireEvent.click(action);
  assert.equal(viewer().props.state.cardStage, 'lifting');
  const calls = [...viewer().calls];
  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.equal(fireEvent.keyDown(action, { key: 'Enter', code: 'Enter', repeat: true }), false);
  }
  emit({ type: 'card-lifted' });
  fireEvent.keyUp(action, { key: 'Enter', code: 'Enter' });
  assert.equal(viewer().props.state.cardStage, 'inspecting');
  assert.deepEqual(viewer().calls, calls);

  assert.equal(fireEvent.keyDown(action, { key: 'Enter', code: 'Enter' }), true);
  fireEvent.click(action);
  emit({ type: 'card-returned' });
  assert.equal(view.getByRole('button', { name: 'Close Mi Note Cards folder' }), action);
  assert.equal(fireEvent.keyDown(action, { key: 'Enter', code: 'NumpadEnter', repeat: true }), false);
  fireEvent.keyUp(action, { key: 'Enter', code: 'Enter' });
  assert.equal(viewer().props.state.folderPose, 1);
  assert.equal(viewer().props.state.cardStage, 'pocket');
});

test('selected card action requires a working viewer but can reverse while replacement card assets load', () => {
  const view = render(createElement(MiNoteCardsWipApp));
  openPack(view);
  fireEvent.click(view.getByRole('button', { name: 'View left card' }));
  act(() => viewer().props.onReadyChange(false));
  const returnAction = view.getByRole('button', { name: 'Return card to pocket' }) as HTMLButtonElement;
  assert.equal(returnAction.disabled, true);
  fireEvent.click(returnAction);
  assert.equal(viewer().props.state.cardStage, 'lifting');
  act(() => {
    viewer().props.onReadyChange(true);
    viewer().props.onCardsReadyChange(false);
  });
  assert.equal(returnAction.disabled, false);
  fireEvent.click(returnAction);
  assert.equal(viewer().props.state.cardStage, 'returning');
  fireEvent.click(view.getByRole('button', { name: 'View card closeup' }));
  assert.equal(viewer().props.state.cardStage, 'lifting');
  act(() => viewer().props.onCardsError(new Error('Card load failed')));
  assert.equal(returnAction.disabled, true);
  fireEvent.click(returnAction);
  assert.equal(viewer().props.state.cardStage, 'lifting');
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

test('card ID inputs update either card without resetting the open folder or inspected card', t => {
  t.mock.method(Math, 'random', () => 0.1);
  const view = render(createElement(MiNoteCardsWipApp));
  const left = view.getByRole('spinbutton', { name: 'Left card ID' }) as HTMLInputElement;
  const right = view.getByRole('spinbutton', { name: 'Right card ID' }) as HTMLInputElement;
  for (const input of [left, right]) {
    assert.equal(input.type, 'number');
    assert.equal(input.min, '1');
    assert.equal(input.max, '1430');
    assert.equal(input.step, '1');
  }
  assert.deepEqual([left.value, right.value], ['144', '143']);
  assert.deepEqual(renderedMiNoteCards().map(({ id }) => id), ['144', '143']);
  openPack(view);
  const initial = viewer();
  const opened = initial.props.state;
  fireEvent.change(left, { target: { value: '1430' } });
  assert.equal(viewer(), initial);
  assert.equal(viewer().props.state, opened);
  assert.deepEqual(renderedMiNoteCards().map(({ id }) => id), ['1430', '143']);
  assert.equal(view.getByRole('button', { name: 'View left card' }).getAttribute('aria-description'), 'Mi Note Card #1430');
  fireEvent.change(right, { target: { value: '1' } });
  assert.equal(viewer(), initial);
  assert.equal(viewer().props.state, opened);
  assert.deepEqual(renderedMiNoteCards().map(({ id }) => id), ['1430', '1']);
  fireEvent.click(view.getByRole('button', { name: 'View left card' }));
  emit({ type: 'card-lifted' });
  const inspecting = viewer().props.state;
  fireEvent.change(left, { target: { value: '2' } });
  assert.equal(viewer(), initial);
  assert.equal(viewer().props.state, inspecting);
  assert.deepEqual(renderedMiNoteCards().map(({ id }) => id), ['2', '1']);
  assert.ok(view.getByRole('button', { name: 'Return card to pocket', description: 'Mi Note Card #2' }));
  fireEvent.change(right, { target: { value: '2' } });
  assert.equal(viewer(), initial);
  assert.equal(viewer().props.state, inspecting);
  assert.equal(viewer().props.cards[0].imageSrc, 'https://cdn.lil.org/nft/mi_note_cards/fronts/2.webp');
  assert.deepEqual(viewer().props.cards[0], viewer().props.cards[1]);
  assert.deepEqual([left.value, right.value], ['2', '2']);
});

test('invalid card ID drafts preserve both displayed cards and the open folder state', t => {
  t.mock.method(Math, 'random', () => 0);
  const view = render(createElement(MiNoteCardsWipApp));
  const inputs = [
    view.getByRole('spinbutton', { name: 'Left card ID' }),
    view.getByRole('spinbutton', { name: 'Right card ID' }),
  ] as HTMLInputElement[];
  fireEvent.change(inputs[0], { target: { value: '12' } });
  fireEvent.change(inputs[1], { target: { value: '34' } });
  openPack(view);
  const initial = viewer();
  const opened = initial.props.state;
  const cards = renderedMiNoteCards();
  for (const input of inputs) {
    for (const draft of ['', '0', '-1', '1431', '7.5']) {
      fireEvent.change(input, { target: { value: draft } });
      assert.equal(input.value, draft);
      assert.equal(viewer(), initial);
      assert.equal(viewer().props.state, opened);
      assert.deepEqual(renderedMiNoteCards(), cards);
    }
  }
  fireEvent.change(inputs[0], { target: { value: '1430' } });
  fireEvent.change(inputs[1], { target: { value: '1' } });
  assert.deepEqual(renderedMiNoteCards().map(({ id }) => id), ['1430', '1']);
  assert.equal(viewer(), initial);
  assert.equal(viewer().props.state, opened);
});

test('effect changes and Retry keep edited IDs and drafts while Reset replaces both inputs', t => {
  let random = 0.1;
  t.mock.method(Math, 'random', () => random);
  const view = render(createElement(MiNoteCardsWipApp));
  const left = view.getByRole('spinbutton', { name: 'Left card ID' }) as HTMLInputElement;
  const right = view.getByRole('spinbutton', { name: 'Right card ID' }) as HTMLInputElement;
  fireEvent.change(left, { target: { value: '12' } });
  fireEvent.change(right, { target: { value: '34' } });
  fireEvent.change(left, { target: { value: '' } });
  fireEvent.change(right, { target: { value: '1431' } });
  const cards = renderedMiNoteCards();
  random = 0.8;
  const assertSelection = () => {
    assert.deepEqual(renderedMiNoteCards(), cards);
    assert.deepEqual([left.value, right.value], ['', '1431']);
  };
  fireEvent.change(view.getByRole('combobox', { name: 'Effect' }), { target: { value: 'lighting-only' } });
  assertSelection();
  act(() => viewer().props.onError(new Error('Lost renderer')));
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  assertSelection();
  assert.equal(viewer().props.cardEffect.effectKey, 'lighting-only');
  fireEvent.click(view.getByRole('button', { name: 'Reset opening' }));
  assert.deepEqual(renderedMiNoteCards().map(({ id }) => id), ['1145', '1144']);
  assert.deepEqual([left.value, right.value], ['1145', '1144']);
  assert.equal(viewer().props.cardEffect.effectKey, 'lighting-only');
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

test('Mi Note cards keep their assets and random appearance through effect changes and retry, while reset resamples', t => {
  let random = 0.1;
  t.mock.method(Math, 'random', () => random);
  const view = render(createElement(MiNoteCardsWipApp));
  const initialCards = renderedMiNoteCards();
  assert.deepEqual(initialCards.map(({ id }) => id), ['144', '143']);
  const initialColor = viewer().props.color;
  const initialStar = viewer().props.star;
  random = 0.8;
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
  assert.equal(viewer().props.color, initialColor);
  assert.equal(viewer().props.star, initialStar);
  assert.deepEqual(renderedMiNoteCards(), initialCards);
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
  assert.equal(viewer().props.color, MI_NOTE_PACK_VARIANTS[2].color);
  assert.equal(viewer().props.star, MI_NOTE_PACK_STARS[2]);
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
  for (const target of [view.getByRole('combobox', { name: 'Effect' }), view.getByRole('button', { name: /2 taps remaining/ }), view.getByRole('button', { name: 'Reset opening' })]) {
    fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(target, { key: 'ArrowRight', code: 'ArrowRight' });
  }
  const beforeTyping = viewer();
  const beforeTypingState = beforeTyping.props.state;
  for (const target of [view.getByRole('spinbutton', { name: 'Left card ID' }), view.getByRole('spinbutton', { name: 'Right card ID' })]) {
    target.focus();
    for (const key of ['Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'r']) {
      fireEvent.keyDown(target, { key, code: key === 'r' ? 'KeyR' : key });
    }
  }
  assert.equal(viewer(), beforeTyping);
  assert.equal(viewer().props.state, beforeTypingState);
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
