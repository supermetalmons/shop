import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useLayoutEffect, useRef, useState } from 'react';
import type WipInteractiveCard from '../src/components/WipInteractiveCard.tsx';
import type { DrifCardConfig } from '../src/drifCards.ts';
import { MI_NOTE_CARDS_DEFAULT } from '../src/lib/miNoteCardEffects.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

type CardProps = Parameters<typeof WipInteractiveCard>[0];
type CardInstance = { props: CardProps; mounted: boolean };
type AssetState = { ready: boolean; error: Error | null };
type AssetInstance = {
  cards: readonly DrifCardConfig[];
  mounted: boolean;
  retryCount: number;
  setState: (state: AssetState) => void;
};

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const cardInstances: CardInstance[] = [];
const assetInstances: AssetInstance[] = [];

function FakeInteractiveCard(props: CardProps) {
  const record = useRef<CardInstance | null>(null);
  if (!record.current) record.current = { props, mounted: false };
  const instance = record.current;
  instance.props = props;
  useLayoutEffect(() => {
    cardInstances.push(instance);
    instance.mounted = true;
    return () => { instance.mounted = false; };
  }, []);
  return createElement('div', { 'aria-label': props.ariaLabel });
}

function useFakeAssets(cards: readonly DrifCardConfig[]) {
  const [state, setState] = useState<AssetState>({ ready: false, error: null });
  const record = useRef<AssetInstance | null>(null);
  if (!record.current) record.current = { cards, mounted: false, retryCount: 0, setState };
  const instance = record.current;
  instance.cards = cards;
  useLayoutEffect(() => {
    assetInstances.push(instance);
    instance.mounted = true;
    return () => { instance.mounted = false; };
  }, []);
  return {
    ...state,
    retry() {
      instance.retryCount += 1;
      setState({ ready: false, error: null });
    },
  };
}

const bridgeKey = '__miNoteCardsDemoWipAppTest';
Object.defineProperty(globalThis, bridgeKey, {
  configurable: true,
  value: { FakeInteractiveCard, useFakeAssets },
});
const imports = registerHooks({
  load(url, context, nextLoad) {
    let source: string | undefined;
    if (url.endsWith('/components/WipInteractiveCard.tsx')) source = `export default globalThis.${bridgeKey}.FakeInteractiveCard;`;
    else if (url.endsWith('/hooks/useMiNoteCardAssets.ts')) source = `export const useMiNoteCardAssets = globalThis.${bridgeKey}.useFakeAssets;`;
    else if (url.endsWith('.css')) source = '';
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
  },
});
const { default: MiNoteCardsDemoWipApp } = await import('../src/MiNoteCardsDemoWipApp.tsx');
imports.deregister();

beforeEach(() => {
  window.localStorage.clear();
  cardInstances.length = 0;
  assetInstances.length = 0;
  window.history.replaceState(null, '', '/mi_note_cards_devnet/wip');
});
afterEach(() => {
  cleanup();
  assert.ok(cardInstances.every(instance => !instance.mounted));
  assert.ok(assetInstances.every(instance => !instance.mounted));
});
after(() => { Reflect.deleteProperty(globalThis, bridgeKey); dom.window.close(); });

test('saved tuning drafts cannot add controls or override the fixed card effect', t => {
  const key = 'mons.shop:mi_note_cards_devnet:wip:css-effect:v1';
  const saved = JSON.stringify({ version: 1, effect: 'MI_NOTE_CARDS_DEFAULT', renderer: 'css', settings: {
    glare: { strength: 0, blendMode: 'hard-light' },
    shine: { strength: 0.96, brightness: 2.96, contrast: 5, saturation: 2.73 },
  } });
  window.localStorage.setItem(key, saved);
  const read = t.mock.method(dom.window.Storage.prototype, 'getItem');
  const view = render(createElement(MiNoteCardsDemoWipApp));
  assert.equal(read.mock.callCount(), 0);
  assert.equal(view.queryByRole('complementary', { name: 'MI card effect tuning' }), null);
  assert.equal(view.queryByRole('slider'), null);
  assert.equal(view.queryByRole('checkbox'), null);
  assert.equal(view.queryByRole('combobox'), null);
  assert.equal(view.queryByRole('button', { name: 'Copy JSON' }), null);
  assert.equal(view.queryByRole('button', { name: 'Reset' }), null);
  const content = view.container.querySelector('.mi-note-demo__content') as HTMLElement;
  assert.equal(content.style.length, 0);
  assert.equal(card().props.card.effect, MI_NOTE_CARDS_DEFAULT);
  assert.equal(card().props.interactionMode, 'normal');
  assert.equal('holdPoseOnLeave' in card().props, false);
  assert.equal(window.localStorage.getItem(key), saved);
  assert.ok(view.getByRole('spinbutton', { name: 'Card ID' }));
  assert.ok(view.getByRole('button', { name: 'Close Mi Note Cards demo' }));
});

function card() {
  const instance = cardInstances.at(-1);
  assert.ok(instance?.mounted);
  return instance;
}

function assets() {
  const instance = assetInstances.at(-1);
  assert.ok(instance?.mounted);
  return instance;
}

function pointer(target: HTMLElement, type: string, pointerType = 'touch') {
  const event = new dom.window.MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(target, event);
}

function assertCard(id: number) {
  const { props } = card();
  const base = 'https://cdn.lil.org/nft/mi_note_cards';
  assert.equal(props.card.imageSrc, `${base}/fronts/${id}.webp`);
  assert.equal(props.card.foilSrc, `${base}/foils/${id}.webp`);
  assert.equal(props.card.textureSrc, `${base}/masks/${id}.webp`);
  assert.equal(props.card.effect, MI_NOTE_CARDS_DEFAULT);
  assert.equal(props.imageAlt, `Mi Note Card #${id}`);
  assert.equal(props.ariaLabel, `Inspect Mi Note Card #${id}`);
  assert.deepEqual(assets().cards, [props.card]);
}

test('devnet starts with a random card and a fixed default effect without a picker', t => {
  let random = 0;
  t.mock.method(Math, 'random', () => random);
  for (const [sample, id] of [[0, 1], [0.5, 716], [1 - Number.EPSILON, 1430]]) {
    random = sample;
    const view = render(createElement(MiNoteCardsDemoWipApp));
    const input = view.getByRole('spinbutton', { name: 'Card ID' }) as HTMLInputElement;
    assert.equal(input.type, 'number');
    assert.equal(input.min, '1');
    assert.equal(input.max, '1430');
    assert.equal(input.step, '1');
    assert.equal(input.value, String(id));
    assert.equal(view.queryByRole('combobox'), null);
    assertCard(id);
    random = 0.25;
    view.rerender(createElement(MiNoteCardsDemoWipApp));
    assert.equal(input.value, String(id));
    assertCard(id);
    view.unmount();
  }
});

test('valid ID edits update immediately and invalid drafts preserve the last displayed card', t => {
  t.mock.method(Math, 'random', () => 0);
  const view = render(createElement(MiNoteCardsDemoWipApp));
  const input = view.getByRole('spinbutton', { name: 'Card ID' }) as HTMLInputElement;
  for (const id of [1430, 712, 1]) {
    fireEvent.change(input, { target: { value: String(id) } });
    assertCard(id);
    const current = card();
    const currentAssets = assets();
    for (const draft of ['', '0', '-1', '1431', '7.5']) {
      fireEvent.change(input, { target: { value: draft } });
      assert.equal(input.value, draft);
      assert.equal(card(), current);
      assert.equal(assets(), currentAssets);
      assertCard(id);
    }
  }
  fireEvent.change(input, { target: { value: '1430' } });
  assertCard(1430);
});

test('loading waits for the card image and Retry retains the chosen ID and default effect', t => {
  t.mock.method(Math, 'random', () => 0);
  const view = render(createElement(MiNoteCardsDemoWipApp));
  fireEvent.change(view.getByRole('spinbutton', { name: 'Card ID' }), { target: { value: '1430' } });
  assert.equal(view.getByRole('status').textContent, 'Loading…');
  assert.equal(card().props.interactive, false);
  act(() => assets().setState({ ready: true, error: null }));
  assert.ok(view.getByRole('status'));
  assert.equal(card().props.interactive, false);
  act(() => card().props.onImageReadyChange?.(true));
  assert.equal(view.queryByRole('status'), null);
  assert.equal(card().props.interactive, true);
  act(() => assets().setState({ ready: false, error: new Error('Missing CDN asset') }));
  assert.match(view.getByRole('alert').textContent!, /Unable to load this card/);
  assert.equal(card().props.interactive, false);
  const failed = card();
  const failedAssets = assets();
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  assert.equal(failed.mounted, false);
  assert.equal(assets(), failedAssets);
  assert.equal(failedAssets.retryCount, 1);
  assert.equal(view.queryByRole('alert'), null);
  assert.ok(view.getByRole('status'));
  assertCard(1430);
  act(() => assets().setState({ ready: true, error: null }));
  assert.equal(card().props.interactive, false);
  act(() => card().props.onImageReadyChange?.(true));
  assert.equal(view.queryByRole('status'), null);
  assert.equal(card().props.interactive, true);
});

for (const [endEvent, action] of [['pointerup', 'release'], ['pointercancel', 'cancellation']]) {
  test(`touch ${action} settles the demo card until the next press without reloading it`, t => {
    t.mock.method(Math, 'random', () => 0);
    const view = render(createElement(MiNoteCardsDemoWipApp));
    act(() => assets().setState({ ready: true, error: null }));
    act(() => card().props.onImageReadyChange?.(true));
    const initialCard = card();
    const initialAssets = assets();
    const target = view.getByLabelText('Inspect Mi Note Card #1');

    pointer(target, 'pointerdown');
    assert.equal(card().props.interactionMode, 'normal');
    pointer(target, endEvent);
    assert.equal(card().props.interactionMode, 'settling');
    assert.equal(card().props.interactive, true);
    pointer(target, 'pointermove');
    pointer(target, 'pointerover');
    assert.equal(card().props.interactionMode, 'settling');

    pointer(target, 'pointerdown');
    assert.equal(card().props.interactionMode, 'normal');
    assert.equal(card().props.interactive, true);
    assert.equal(card(), initialCard);
    assert.equal(assets(), initialAssets);
    assert.equal(initialAssets.retryCount, 0);
    assert.equal(view.queryByRole('status'), null);
  });
}

test('mouse hover reactivates a settled demo card and mouse release keeps it interactive', t => {
  t.mock.method(Math, 'random', () => 0);
  const view = render(createElement(MiNoteCardsDemoWipApp));
  act(() => assets().setState({ ready: true, error: null }));
  act(() => card().props.onImageReadyChange?.(true));
  const target = view.getByLabelText('Inspect Mi Note Card #1');

  pointer(target, 'pointerup');
  assert.equal(card().props.interactionMode, 'settling');
  pointer(target, 'pointerover', 'mouse');
  assert.equal(card().props.interactionMode, 'normal');
  pointer(target, 'pointerup', 'mouse');
  assert.equal(card().props.interactionMode, 'normal');
  assert.equal(card().props.interactive, true);
});
