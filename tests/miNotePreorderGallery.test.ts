import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach } from 'node:test';
import { createElement } from 'react';
import { getPreorderConfig, PREORDER_CARD_COUNT } from '../shared/preorders.ts';
import type { PreorderCheckout } from '../src/hooks/usePreorderCheckout.ts';
import type { createPreorderApi } from '../src/lib/preorderApi.ts';
import { ProfileApiError } from '../src/api/transport.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const cssImports = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
} });
const { default: MiNoteCardsGallery } = await import('../src/components/MiNoteCardsGallery.tsx');
const { useShopFeedback } = await import('../src/shop/ui/useShopFeedback.ts');
const { usePreorderCheckout } = await import('../src/hooks/usePreorderCheckout.ts');
cssImports.deregister();
const random = Math.random;
afterEach(() => { cleanup(); window.localStorage.clear(); Math.random = random; window.history.replaceState(null, '', '/mi_note_cards_devnet'); });
after(() => dom.window.close());

function checkout(): PreorderCheckout {
  return {
    config: getPreorderConfig('mi_note_cards_devnet')!, buyer: undefined,
    availability: { preorderId: 'mi_note_cards_devnet', items: Array.from({ length: PREORDER_CARD_COUNT }, (_, index) => ({ id: index + 1, status: 'available' })) },
    availabilityError: null, refreshAvailability: async () => {}, order: null, pending: null, phase: 'idle',
    error: null, purchase: async () => {}, cancel: async () => {}, busy: false, pendingOrder: false, recoveryReady: true,
  };
}

test('devnet gallery rotates the oldest selection and keeps the panel and purchase in selection order', async () => {
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
  const card = (id: number) => view.getByRole('button', { name: new RegExp(`Select preorder #${id}:`) });
  const expectSelection = (ids: number[]) => {
    for (let id = 1; id <= 6; id += 1) assert.equal(card(id).getAttribute('aria-pressed'), String(ids.includes(id)));
    const preview = view.getByLabelText(`${ids.length} cards selected`);
    assert.deepEqual(Array.from(preview.children, (node) => (node as HTMLElement).style.backgroundImage),
      ids.map((id) => `url("${card(id).querySelector('img')!.src}")`));
  };
  assert.equal(one.tagName, 'BUTTON');
  fireEvent.click(one);
  assert.equal(one.getAttribute('aria-pressed'), 'true');
  assert.ok(view.getByRole('button', { name: 'Preorder for 0.25 SOL' }));
  fireEvent.click(view.getByRole('button', { name: /Select preorder #2:/ }));
  fireEvent.click(view.getByRole('button', { name: /Select preorder #3:/ }));
  assert.equal((card(4) as HTMLButtonElement).disabled, false);
  fireEvent.click(card(4));
  expectSelection([2, 3, 4]);
  fireEvent.click(card(5));
  expectSelection([3, 4, 5]);
  fireEvent.click(card(4));
  expectSelection([3, 5]);
  assert.ok(view.getByRole('button', { name: 'Preorder for 0.5 SOL' }));
  fireEvent.click(card(4));
  expectSelection([3, 5, 4]);
  fireEvent.click(card(6));
  expectSelection([5, 4, 6]);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Preorder for 0.75 SOL' })); });
  assert.deepEqual(purchased, [5, 4, 6]);
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  assert.equal(view.queryAllByRole('button', { pressed: true }).length, 0);
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
  assert.equal((view.getByRole('button', { name: /Preordered preorder #2:/ }) as HTMLButtonElement).disabled, false);
  assert.equal(view.getByRole('img', { name: 'watercolor milady' }).getAttribute('src'), 'https://cdn.lil.org/nft/mi_note_cards/preorder/v1/2.webp');
  assert.equal(view.getByRole('img', { name: 'Angel Lady' }).classList.contains('mi-note-cards__image--preordered'), false);
  assert.equal(view.getByRole('img', { name: 'watercolor milady' }).classList.contains('mi-note-cards__image--preordered'), true);
  assert.equal(view.queryByRole('button', { name: /Preorder .*SOL/ }), null);
  const succeeded = { ...next, availability: { ...next.availability, items: next.availability.items.map((item) => ({ ...item, status: item.id === 1 ? 'preordered' as const : item.status })) } };
  view.rerender(createElement(MiNoteCardsGallery, { preorder: succeeded }));
  assert.equal((view.getByRole('button', { name: 'Preordered preorder #1: Angel Lady' }) as HTMLButtonElement).disabled, false);
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
  fireEvent.click(view.getByRole('button', { name: /Select preorder #2:/ }));
  assert.equal(view.queryAllByRole('button', { pressed: true }).length, 0);
  assert.ok(view.getByLabelText('1 cards selected'));
  assert.equal(view.queryByRole('status'), null);
  assert.equal(view.getByText('Confirming…').getAttribute('aria-live'), 'polite');
});

test('unavailable cards and busy checkout never evict an existing selection', async () => {
  Math.random = () => 0;
  const preorder = checkout();
  preorder.availability!.items[3].status = 'reserved';
  preorder.availability!.items[4].status = 'preordered';
  let purchased: number[] = [];
  preorder.purchase = async (ids) => { purchased = ids; };
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  for (const id of [1, 2, 3]) fireEvent.click(view.getByRole('button', { name: new RegExp(`Select preorder #${id}:`) }));
  for (const name of [/Reserved preorder #4:/]) {
    const button = view.getByRole('button', { name }) as HTMLButtonElement;
    assert.equal(button.disabled, true);
    fireEvent.click(button);
  }
  view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, busy: true, phase: 'signing' } }));
  const six = view.getByRole('button', { name: /Select preorder #6:/ }) as HTMLButtonElement;
  assert.equal(six.disabled, true);
  fireEvent.click(six);
  const preordered = view.getByRole('button', { name: /Preordered preorder #5:/ }) as HTMLButtonElement;
  assert.equal(preordered.disabled, true);
  fireEvent.click(preordered);
  view.rerender(createElement(MiNoteCardsGallery, { preorder }));
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Preorder for 0.75 SOL' })); });
  assert.deepEqual(purchased, [1, 2, 3]);
});

test('checkout progress is communicated only through the action button', () => {
  Math.random = () => 0;
  const preorder = checkout();
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  fireEvent.click(view.getByRole('button', { name: /Select preorder #1:/ }));
  const states: [Partial<PreorderCheckout>, string][] = [
    [{}, 'Preorder'],
    [{ phase: 'authenticating', busy: true }, 'Signing in…'],
    [{ phase: 'preparing', busy: true }, 'Preparing…'],
    [{ phase: 'signing', busy: true }, 'Check wallet…'],
    [{ phase: 'submitting', busy: true }, 'Confirming…'],
    [{ phase: 'cancelling', busy: true }, 'Cancelling…'],
    [{ recoveryReady: false }, 'Checking…'],
    [{
      pending: { requestId: 'request-1', orderId: 'order-1', cardIds: [1] },
      pendingOrder: true,
      order: { orderId: 'order-1', preorderId: preorder.config.preorderId, buyer: 'buyer', cardIds: [1], assets: [],
        status: 'prepared', expiresAtMs: Date.now() + 118_000, signature: null },
    }, 'Continue preorder'],
  ];
  for (const [state, label] of states) {
    view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, ...state } }));
    const action = view.getByRole('button', { name: `${label} for 0.25 SOL` });
    const panel = action.closest('.mi-note-preorder-panel')!;
    assert.equal(panel.textContent, `Cancel${label} • 0.25 SOL`);
    assert.equal(panel.querySelector('p'), null);
    assert.equal(view.getByText(label, { exact: true }).getAttribute('aria-live'), 'polite');
  }
});

test('pending sign-in can be cancelled and changing gallery view cancels the original preorder', () => {
  Math.random = () => 0;
  const preorder = checkout();
  let cancelled = 0;
  const onCancelPendingSignIn = () => { cancelled += 1; };
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  fireEvent.click(view.getByRole('button', { name: /Select preorder #1:/ }));
  const pending = { ...preorder, busy: true, phase: 'authenticating' as const };
  view.rerender(createElement(MiNoteCardsGallery, { preorder: pending, onCancelPendingSignIn }));
  assert.equal(cancelled, 0);
  const cancel = view.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
  assert.equal(cancel.disabled, false);
  fireEvent.click(cancel);
  assert.equal(cancelled, 1);
  fireEvent.click(view.getByRole('tab', { name: 'Your' }));
  assert.equal(cancelled, 2);
  assert.equal(view.queryByRole('button', { name: /Signing in/ }), null);
});

test('checkout errors toast once per occurrence without an error-only panel', () => {
  Math.random = () => 0;
  const preorder = checkout();
  const error = 'Couldn’t prepare your preorder. Try again.';
  const messages: string[] = [];
  const showToast = (message: string) => { messages.push(message); };
  const view = render(createElement(MiNoteCardsGallery, { preorder: { ...preorder, error }, showToast }), { reactStrictMode: true });
  assert.deepEqual(messages, [error]);
  assert.equal(document.querySelector('.mi-note-preorder-panel'), null);
  view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, error }, showToast: (message) => showToast(message) }));
  assert.deepEqual(messages, [error]);
  view.rerender(createElement(MiNoteCardsGallery, { preorder, showToast }));
  fireEvent.click(view.getByRole('button', { name: /Select preorder #1:/ }));
  view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, error }, showToast }));
  assert.deepEqual(messages, [error, error]);
  assert.equal(view.queryByText(error), null);
  assert.equal(document.querySelector('.mi-note-preorder-panel')?.textContent, 'CancelPreorder • 0.25 SOL');
  view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, error: 'Your preorder expired.' }, showToast }));
  assert.deepEqual(messages, [error, error, 'Your preorder expired.']);
  view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, config: getPreorderConfig('mi_note_cards')!, error }, showToast }));
  assert.equal(messages.length, 3);
  assert.equal(document.querySelector('.mi-note-preorder-panel'), null);
});

test('tab changes clear selection while preserving the existing Ethereum wallet filter', () => {
  Math.random = () => 0;
  const view = render(createElement(MiNoteCardsGallery, { preorder: checkout() }));
  fireEvent.click(view.getByRole('button', { name: 'Select preorder #1: Angel Lady' }));
  fireEvent.click(view.getByRole('tab', { name: 'Your' }));
  assert.equal(view.queryByRole('button', { name: /Preorder .*SOL/ }), null);
  assert.ok(view.getByRole('button', { name: 'Connect Ethereum Wallet' }));
});

test('first wallet connection preserves selection while switching or disconnecting clears it', () => {
  Math.random = () => 0;
  const preorder = checkout();
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  const card = () => view.getByRole('button', { name: /Select preorder #1:/ });
  fireEvent.click(card());
  view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, buyer: 'wallet-a' } }));
  assert.equal(card().getAttribute('aria-pressed'), 'true');
  assert.ok(view.getByRole('button', { name: 'Preorder for 0.25 SOL' }));
  view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, buyer: 'wallet-b' } }));
  assert.equal(card().getAttribute('aria-pressed'), 'false');
  fireEvent.click(card());
  view.rerender(createElement(MiNoteCardsGallery, { preorder }));
  assert.equal(card().getAttribute('aria-pressed'), 'false');
});

test('restoring a pending preorder clears unrelated picks and resumes only the saved cards', async () => {
  Math.random = () => 0;
  const preorder = checkout();
  let purchased: number[] = [];
  preorder.purchase = async (ids) => { purchased = ids; };
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  const card = view.getByRole('button', { name: /Select preorder #1:/ });
  fireEvent.click(card);
  const connected = { ...preorder, buyer: 'wallet-a' };
  view.rerender(createElement(MiNoteCardsGallery, { preorder: connected }));
  assert.equal(card.getAttribute('aria-pressed'), 'true');
  view.rerender(createElement(MiNoteCardsGallery, { preorder: {
    ...connected,
    pending: { requestId: 'saved-request', orderId: 'saved-order', cardIds: [2] },
    pendingOrder: true,
    order: { orderId: 'saved-order', preorderId: preorder.config.preorderId, buyer: 'wallet-a', cardIds: [2],
      assets: [], status: 'prepared', expiresAtMs: Date.now() + 60_000, signature: null },
  } }));
  assert.equal(card.getAttribute('aria-pressed'), 'false');
  assert.match(document.querySelector<HTMLElement>('.selection-panel__thumb')!.style.backgroundImage, /thumbs\/1.webp/);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Continue preorder for 0.25 SOL' })); });
  assert.deepEqual(purchased, [2]);
  view.rerender(createElement(MiNoteCardsGallery, { preorder: connected }));
  assert.equal(view.queryByRole('button', { name: /Preorder for/ }), null);
  assert.equal(card.getAttribute('aria-pressed'), 'false');
});

for (const [status, code, message] of [
  [412, 'failed-precondition', 'Preorder simulation failed. Check your devnet SOL balance and retry.'],
  [429, 'resource-exhausted', 'Too many preorder attempts. Please wait a minute.'],
] as const) {
  test(`preparation failure ${status} keeps matching selections available for retry`, async () => {
    Math.random = () => 0;
    const initial = checkout();
    let rejectPrepare!: (error: Error) => void;
    const preparedIds: number[][] = [];
    const forbidden = async () => { throw new Error('Preparation failure must not sign, submit, or cancel'); };
    const api: ReturnType<typeof createPreorderApi> = {
      availability: async () => initial.availability!,
      prepare: ({ cardIds }) => {
        preparedIds.push(cardIds);
        return new Promise((_, reject) => { rejectPrepare = reject; });
      },
      submit: forbidden, cancel: forbidden, status: async () => ({ order: null }),
    };
    let current!: PreorderCheckout;
    function Harness() {
      current = usePreorderCheckout({
        config: initial.config, active: true, buyer: initial.config.collection, signedIn: true,
        ensureSignedIn: async () => true, signTransaction: forbidden, onSucceeded: () => {},
      }, api);
      return createElement(MiNoteCardsGallery, { preorder: current });
    }
    const view = render(createElement(Harness));
    const card = view.getByRole('button', { name: /Select preorder #1:/ }) as HTMLButtonElement;
    await waitFor(() => assert.equal(card.disabled, false));
    fireEvent.click(card);
    await waitFor(() => assert.equal((view.getByRole('button', { name: 'Preorder for 0.25 SOL' }) as HTMLButtonElement).disabled, false));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.click(view.getByRole('button', { name: 'Preorder for 0.25 SOL' }));
      await waitFor(() => assert.equal(current.phase, 'preparing'));
      await act(async () => { rejectPrepare(new ProfileApiError({ code, status, message })); });
      await waitFor(() => assert.equal(current.error, message));
      assert.equal(current.pending, null);
      assert.equal(current.order, null);
      assert.equal(card.getAttribute('aria-pressed'), 'true');
      assert.ok(view.getByRole('button', { name: 'Preorder for 0.25 SOL' }));
    }
    assert.deepEqual(preparedIds, [[1], [1]]);
  });
}

test('checkout errors wait for feedback to resume and appear only once', () => {
  const preorder = checkout();
  const message = 'Couldn’t cancel yet. We’ll keep checking your preorder.';
  function Harness({ suspended, error }: { suspended: boolean; error: string | null }) {
    const feedback = useShopFeedback(suspended);
    return createElement('div', null,
      createElement('output', { 'data-testid': 'toast' }, feedback.toast),
      createElement(MiNoteCardsGallery, { preorder: { ...preorder, error }, showToast: suspended ? undefined : feedback.showToast }));
  }
  const view = render(createElement(Harness, { suspended: true, error: null }));
  view.rerender(createElement(Harness, { suspended: true, error: message }));
  assert.equal(view.getByTestId('toast').textContent, '');
  view.rerender(createElement(Harness, { suspended: false, error: message }));
  assert.equal(view.getByTestId('toast').textContent, message);
  view.rerender(createElement(Harness, { suspended: true, error: message }));
  view.rerender(createElement(Harness, { suspended: false, error: message }));
  assert.equal(view.getByTestId('toast').textContent, '');
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

for (const preorderId of ['mi_note_cards_devnet', 'mi_note_cards']) {
  test(`${preorderId} selects one completed preorder and opens its artwork without purchasing`, () => {
    Math.random = () => 0;
    const preorder = checkout();
    preorder.config = getPreorderConfig(preorderId)!;
    preorder.availability = { ...preorder.availability!, preorderId, items: preorder.availability!.items.map((item) => ({
      ...item, status: item.id <= 2 ? 'preordered' : item.id === 4 ? 'reserved' : 'available',
    })) };
    preorder.purchase = async () => { throw new Error('Viewing must not purchase'); };
    let opened = false;
    const calls: unknown[][] = [];
    const view = render(createElement(MiNoteCardsGallery, {
      preorder, onViewPreordered: (...args) => { calls.push(args); return opened; },
    }));
    const one = view.getByRole('button', { name: /Preordered preorder #1:/ });
    const two = view.getByRole('button', { name: /Preordered preorder #2:/ });
    fireEvent.click(one);
    assert.equal(one.getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('.selection-panel')?.textContent, 'CancelViewSoon');
    assert.equal((view.getByRole('button', { name: 'Soon' }) as HTMLButtonElement).disabled, true);
    assert.ok(view.getByRole('button', { name: 'Soon' }).querySelector('svg'));
    assert.equal(view.queryByRole('button', { name: /Preorder for/ }), null);
    assert.match(document.querySelector<HTMLElement>('.selection-panel__thumb')!.style.getPropertyValue('--color-scheme-background-image') || document.querySelector<HTMLElement>('.selection-panel__thumb')!.getAttribute('style')!, /preorder\/v1\/1.webp/);
    fireEvent.click(two);
    assert.equal(one.getAttribute('aria-pressed'), 'false');
    assert.equal(two.getAttribute('aria-pressed'), 'true');
    fireEvent.click(two);
    assert.equal(document.querySelector('.selection-panel'), null);
    if (preorder.config.enabled) {
      for (const id of [3, 5, 6, 7]) fireEvent.click(view.getByRole('button', { name: new RegExp(`Select preorder #${id}:`) }));
      assert.ok(view.getByRole('button', { name: 'Preorder for 0.75 SOL' }));
      fireEvent.click(one);
      assert.equal(view.queryByRole('button', { name: /Preorder for/ }), null);
      fireEvent.click(view.getByRole('button', { name: /Select preorder #3:/ }));
      assert.equal(view.queryByRole('button', { name: 'View' }), null);
      assert.ok(view.getByRole('button', { name: 'Preorder for 0.25 SOL' }));
    } else {
      assert.equal(view.queryByRole('button', { name: /Select preorder/ }), null);
    }
    fireEvent.click(one);
    const image = one.querySelector('img')!;
    const rect = new dom.window.DOMRect(20, 40, 310, 465);
    Object.defineProperties(image, { naturalWidth: { value: 1082 }, naturalHeight: { value: 1600 } });
    image.getBoundingClientRect = () => rect;
    fireEvent.click(view.getByRole('button', { name: 'View' }));
    assert.equal(one.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(calls[0], [{
      id: `${preorderId}:1`, dropId: preorderId, kind: 'preorder', preorderId: 1,
      name: 'Preorder #1', image: 'https://cdn.lil.org/nft/mi_note_cards/preorder/v1/1.webp',
    }, rect, 1082 / 1600]);
    opened = true;
    fireEvent.click(view.getByRole('button', { name: 'View' }));
    assert.equal(document.querySelector('.selection-panel'), null);
    assert.equal(one.getAttribute('aria-pressed'), 'false');
    fireEvent.click(one);
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    assert.equal(one.getAttribute('aria-pressed'), 'false');
  });
}

test('completed preorder selection clears when availability or gallery scope changes', () => {
  Math.random = () => 0;
  const preorder = checkout();
  preorder.availability!.items[0].status = 'preordered';
  const view = render(createElement(MiNoteCardsGallery, { preorder }));
  const select = () => fireEvent.click(view.getByRole('button', { name: /Preordered preorder #1:/ }));
  select();
  view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, availability: {
    ...preorder.availability!, items: preorder.availability!.items.map(item => ({ ...item, status: 'available' })),
  } } }));
  assert.equal(view.queryByRole('button', { name: 'View' }), null);
  view.rerender(createElement(MiNoteCardsGallery, { preorder }));
  select();
  view.rerender(createElement(MiNoteCardsGallery, { preorder: { ...preorder, config: getPreorderConfig('mi_note_cards')! } }));
  assert.equal(view.queryByRole('button', { name: 'View' }), null);
  assert.equal(view.queryByRole('button', { name: /Preordered preorder/ }), null);
  view.rerender(createElement(MiNoteCardsGallery, { preorder }));
  select();
  fireEvent.click(view.getByRole('tab', { name: 'Your' }));
  assert.equal(view.queryByRole('button', { name: 'View' }), null);
});
