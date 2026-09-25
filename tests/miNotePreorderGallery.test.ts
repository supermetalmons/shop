import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach } from 'node:test';
import { createElement } from 'react';
import { getPreorderConfig, PREORDER_CARD_COUNT } from '../shared/preorders.ts';
import type { PreorderCheckout } from '../src/hooks/usePreorderCheckout.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const cssImports = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
} });
const { default: MiNoteCardsGallery } = await import('../src/components/MiNoteCardsGallery.tsx');
cssImports.deregister();
const random = Math.random;
afterEach(() => { cleanup(); Math.random = random; window.history.replaceState(null, '', '/mi_note_cards_devnet'); });
after(() => dom.window.close());

function checkout(): PreorderCheckout {
  return {
    config: getPreorderConfig('mi_note_cards_devnet')!, buyer: undefined,
    availability: { preorderId: 'mi_note_cards_devnet', items: Array.from({ length: PREORDER_CARD_COUNT }, (_, index) => ({ id: index + 1, status: 'available' })) },
    availabilityError: null, refreshAvailability: async () => {}, order: null, pending: null, phase: 'idle',
    error: null, purchase: async () => {}, cancel: async () => {}, busy: false, pendingOrder: false, recoveryReady: true, remainingSeconds: 0,
  };
}

test('devnet gallery keeps only artwork while selecting a maximum of three canonical IDs', async () => {
  Math.random = () => 0;
  const preorder = checkout();
  let purchased: number[] = [];
  preorder.purchase = async (ids) => { purchased = ids; };
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  assert.equal(view.getAllByRole('img').length, 300);
  assert.equal(view.container.querySelector('.mi-note-cards__grid')?.textContent, '');
  assert.equal(view.queryByRole('link'), null);
  assert.equal(view.queryByRole('button', { name: 'Notify me' }), null);
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).getAttribute('src'), 'https://cdn.lil.org/player/mi_note/thumbs/0.webp');
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).classList.contains('mi-note-cards__image--preordered'), false);
  const one = view.getByRole('button', { name: 'Select preorder #1: Angel Lady' });
  assert.equal(one.tagName, 'BUTTON');
  fireEvent.click(one);
  assert.equal(one.getAttribute('aria-pressed'), 'true');
  assert.ok(view.getByRole('button', { name: 'Preorder for 0.25 SOL' }));
  fireEvent.click(view.getByRole('button', { name: /Select preorder #2:/ }));
  fireEvent.click(view.getByRole('button', { name: /Select preorder #3:/ }));
  assert.equal((view.getByRole('button', { name: /Select preorder #4:/ }) as HTMLButtonElement).disabled, true);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Preorder for 0.75 SOL' })); });
  assert.deepEqual(purchased, [1, 2, 3]);
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  assert.equal(one.getAttribute('aria-pressed'), 'false');
  assert.equal(view.queryByRole('button', { name: /Preorder .*SOL/ }), null);
});

test('reservation clears selection and keeps original artwork until the preorder succeeds', () => {
  Math.random = () => 0;
  const preorder = checkout();
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  fireEvent.click(view.getByRole('button', { name: 'Select preorder #1: Angel Lady' }));
  const next = { ...preorder, availability: { ...preorder.availability!, items: preorder.availability!.items.map((item) => ({ ...item, status: item.id === 1 ? 'reserved' as const : item.id === 2 ? 'preordered' as const : item.status })) } };
  view.rerender(createElement(MiNoteCardsGallery, { preorder: next }));
  const reserved = view.getByRole('button', { name: 'Reserved preorder #1: Angel Lady' }) as HTMLButtonElement;
  assert.equal(reserved.disabled, true);
  assert.equal(reserved.getAttribute('aria-pressed'), 'false');
  assert.equal(view.container.querySelector('.mi-note-cards__grid')?.textContent, '');
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).getAttribute('src'), 'https://cdn.lil.org/player/mi_note/thumbs/0.webp');
  assert.equal((view.getByRole('button', { name: /Preordered preorder #2:/ }) as HTMLButtonElement).disabled, true);
  assert.equal(view.getByRole('img', { name: 'watercolor milady' }).getAttribute('src'), 'https://cdn.lil.org/nft/mi_note_cards/preorder/v1/2.webp');
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).classList.contains('mi-note-cards__image--preordered'), false);
  assert.equal(view.getByRole('img', { name: 'watercolor milady' }).classList.contains('mi-note-cards__image--preordered'), true);
  assert.equal(view.queryByRole('button', { name: /Preorder .*SOL/ }), null);
  const succeeded = { ...next, availability: { ...next.availability, items: next.availability.items.map((item) => ({ ...item, status: item.id === 1 ? 'preordered' as const : item.status })) } };
  view.rerender(createElement(MiNoteCardsGallery, { preorder: succeeded }));
  assert.equal((view.getByRole('button', { name: 'Preordered preorder #1: Angel Lady' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).getAttribute('src'), 'https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1.webp');
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).classList.contains('mi-note-cards__image--preordered'), true);
  assert.equal(view.queryByText('Reserved'), null);
});

test('cancellation or expiry restores available cards without changing their original artwork', () => {
  Math.random = () => 0;
  const available = checkout();
  const reserved = { ...available, availability: { ...available.availability!, items: available.availability!.items.map((item) => ({ ...item, status: item.id === 1 ? 'reserved' as const : item.status })) } };
  const view = render(createElement(MiNoteCardsGallery, { preorder: reserved }));
  assert.equal((view.getByRole('button', { name: 'Reserved preorder #1: Angel Lady' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).getAttribute('src'), 'https://cdn.lil.org/player/mi_note/thumbs/0.webp');
  view.rerender(createElement(MiNoteCardsGallery, { preorder: available }));
  assert.equal(view.queryByText('Reserved'), null);
  const card = view.getByRole('button', { name: 'Select preorder #1: Angel Lady' }) as HTMLButtonElement;
  assert.equal(card.disabled, false);
  assert.equal(card.getAttribute('aria-pressed'), 'false');
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).getAttribute('src'), 'https://cdn.lil.org/player/mi_note/thumbs/0.webp');
  fireEvent.click(card);
  assert.equal(card.getAttribute('aria-pressed'), 'true');
  assert.ok(view.getByRole('button', { name: 'Preorder for 0.25 SOL' }));
});

test('mainnet gallery has no selectable purchase controls or notify button', () => {
  Math.random = () => 0;
  const preorder = { ...checkout(), config: getPreorderConfig('mi_note_cards')! };
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  assert.equal(view.queryByRole('button', { name: /Select preorder/ }), null);
  assert.equal(view.queryByRole('button', { name: 'Notify me' }), null);
  assert.equal(view.getAllByRole('img').length, 300);
  assert.equal(view.container.querySelector('.mi-note-cards__grid')?.textContent, '');
  assert.equal(view.queryByRole('link'), null);
  assert.equal(view.container.querySelector('.mi-note-cards__image--preordered'), null);
});

test('pending submission disables selection and cancellation without requiring Ethereum ownership', () => {
  Math.random = () => 0;
  const preorder = checkout();
  preorder.pending = { requestId: 'request-1', orderId: 'order-1', cardIds: [1], submittedAttempt: true };
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  assert.equal(view.queryByRole('button', { name: 'Connect Ethereum Wallet' }), null);
  assert.equal((view.getByRole('button', { name: 'Select preorder #1: Angel Lady' }) as HTMLButtonElement).disabled, true);
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).getAttribute('src'), 'https://cdn.lil.org/player/mi_note/thumbs/0.webp');
  assert.equal((view.getByRole('button', { name: 'Confirming… for 0.25 SOL' }) as HTMLButtonElement).disabled, true);
  assert.equal((view.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled, true);
  assert.ok(view.getByRole('status'));
});

test('tab changes clear selection while preserving the existing Ethereum wallet filter', () => {
  Math.random = () => 0;
  const view = render(createElement(MiNoteCardsGallery, { preorder: checkout() }));
  fireEvent.click(view.getByRole('button', { name: 'Select preorder #1: Angel Lady' }));
  fireEvent.click(view.getByRole('tab', { name: 'Your' }));
  assert.equal(view.queryByRole('button', { name: /Preorder .*SOL/ }), null);
  assert.ok(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
});

test('switching between devnet purchasing and mainnet gallery clears prior selection', () => {
  Math.random = () => 0;
  const preorder = checkout();
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  fireEvent.click(view.getByRole('button', { name: 'Select preorder #1: Angel Lady' }));
  assert.ok(view.getByRole('button', { name: 'Preorder for 0.25 SOL' }));
  view.rerender(createElement(MiNoteCardsGallery));
  assert.equal(view.queryByRole('button', { name: /Preorder .*SOL/ }), null);
  view.rerender(createElement(MiNoteCardsGallery, { preorder }));
  assert.equal(view.getByRole('button', { name: 'Select preorder #1: Angel Lady' }).getAttribute('aria-pressed'), 'false');
  assert.equal(view.queryByRole('button', { name: /Preorder .*SOL/ }), null);
});
