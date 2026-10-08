import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, beforeEach } from 'node:test';
import { createElement, useLayoutEffect, useRef, useState } from 'react';
import type WipInteractiveCard from '../src/components/WipInteractiveCard.tsx';
import type { DrifCardConfig } from '../src/drifCards.ts';
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

function assertCard(id: number, effect = 'v-regular') {
  const { props } = card();
  const base = 'https://cdn.lil.org/nft/mi_note_cards';
  assert.equal(props.card.imageSrc, `${base}/fronts/${id}.webp`);
  assert.equal(props.card.foilSrc, effect === 'lighting-only' ? undefined : `${base}/foils/${id}.webp`);
  assert.equal(props.card.textureSrc, effect === 'lighting-only' ? undefined : `${base}/masks/${id}.webp`);
  assert.equal(props.card.effect.effectKey, effect);
  assert.equal(props.imageAlt, `Mi Note Card #${id}`);
  assert.equal(props.ariaLabel, `Inspect Mi Note Card #${id}`);
  assert.deepEqual(assets().cards, [props.card]);
}

test('devnet starts with a random card across the full ID range and keeps it on rerender', t => {
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
    assert.equal(view.queryByRole('combobox', { name: 'Card' }), null);
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

test('all effects preserve the selected ID and load only the assets that effect uses', t => {
  t.mock.method(Math, 'random', () => 0);
  const view = render(createElement(MiNoteCardsDemoWipApp));
  const input = view.getByRole('spinbutton', { name: 'Card ID' }) as HTMLInputElement;
  const picker = view.getByRole('combobox', { name: 'Effect' }) as HTMLSelectElement;
  assert.deepEqual(Array.from(picker.options, option => [option.value, option.text]), [
    ['v-regular', 'V Regular'], ['trainer-full-art', 'Trainer Full Art'], ['lighting-only', 'Lighting only'],
  ]);
  fireEvent.change(input, { target: { value: '1430' } });
  for (const effect of ['trainer-full-art', 'lighting-only', 'v-regular']) {
    const previous = card();
    fireEvent.change(picker, { target: { value: effect } });
    assert.equal(previous.mounted, false);
    assert.equal(input.value, '1430');
    assertCard(1430, effect);
  }
});

test('loading waits for the card image and Retry retains the chosen ID and effect', t => {
  t.mock.method(Math, 'random', () => 0);
  const view = render(createElement(MiNoteCardsDemoWipApp));
  fireEvent.change(view.getByRole('spinbutton', { name: 'Card ID' }), { target: { value: '1430' } });
  fireEvent.change(view.getByRole('combobox', { name: 'Effect' }), { target: { value: 'trainer-full-art' } });
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
  assertCard(1430, 'trainer-full-art');
  act(() => assets().setState({ ready: true, error: null }));
  assert.equal(card().props.interactive, false);
  act(() => card().props.onImageReadyChange?.(true));
  assert.equal(view.queryByRole('status'), null);
  assert.equal(card().props.interactive, true);
});
