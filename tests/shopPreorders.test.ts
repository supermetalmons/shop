import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import bs58 from 'bs58';
import { getPreorderConfig, type PreorderOrder } from '../shared/preorders.ts';
import { MI_NOTE_SESSION_HEADER } from '../shared/miNoteAuth.ts';
import { anonymousSessionTestHooks } from '../src/lib/anonymousSession.ts';
import { listPreorderRecoveries, upsertPreorderRecovery } from '../src/lib/preorderRecovery.ts';
import { resolveAppRoute } from '../src/routes.ts';
import type { InventoryItem } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { installBrowserLocks } from './helpers/browserLocks.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useShopPreorders } = await import('../src/shop/purchase/useShopPreorders.ts');
type Options = Parameters<typeof useShopPreorders>[0];
const clients: InstanceType<typeof QueryClient>[] = [];
const address = (value: number) => bs58.encode(new Uint8Array(32).fill(value));
const buyer = address(31);
const otherBuyer = address(32);
const ethereumAddress = '0x0000000000000000000000000000000000000001';
const mainnet = getPreorderConfig('mi_note_cards')!;
const devnet = getPreorderConfig('mi_note_cards_devnet')!;

beforeEach(t => {
  if ('after' in t) installBrowserLocks(t);
  anonymousSessionTestHooks.resetValidation();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  window.localStorage.clear();
  window.sessionStorage.clear();
  Reflect.deleteProperty(window, 'ethereum');
});
after(() => dom.window.close());

function order(id: number, preorderId = mainnet.preorderId, status: PreorderOrder['status'] = 'submitted'): PreorderOrder {
  return {
    orderId: `order-${id}`, preorderId, buyer, ethereumAddress, cardIds: [id],
    assets: [{ id, address: address(id) }], status, confirmedSlot: 100 + id,
    signature: bs58.encode(new Uint8Array(64).fill(id)), expiresAtMs: Date.now() + 120_000,
  };
}

function server(t: TestContext, orders: PreorderOrder[] = []) {
  const statusChecks: string[] = [];
  const availabilityChecks: string[] = [];
  const challengeChecks: string[] = [];
  let challengedPreorder = mainnet.preorderId;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'https://mons.shop');
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.pathname === '/api/auth/anonymous/session') return Response.json({
      subject: 'anon:123e4567-e89b-42d3-a456-426614174000',
      refreshedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
    });
    if (url.pathname === '/api/preorders/status') {
      if (body.includeRecoveries) return Response.json({ order: null, recoveries: [], nextRecoveryCursor: null });
      if (body.orderId) statusChecks.push(body.preorderId);
      return Response.json({ order: orders.find(order => order.preorderId === body.preorderId && order.orderId === body.orderId) ?? null });
    }
    if (url.pathname === '/api/preorders/availability') {
      const preorderId = url.searchParams.get('preorderId') ?? body.preorderId;
      assert.equal(new Headers(init?.headers).get(MI_NOTE_SESSION_HEADER), `session:${preorderId}`);
      availabilityChecks.push(preorderId);
      return Response.json({ preorderId, ethereumAddress, ownershipStatus: 'success', requiresAdminSignIn: false,
        items: [{ id: 1, status: 'available' }] });
    }
    if (url.pathname.endsWith('/auth/challenge')) {
      challengedPreorder = body.preorderId;
      challengeChecks.push(body.preorderId);
      return Response.json({ challengeId: 'challenge', message: 'Verify ownership', expiresAtMs: Date.now() + 60_000 });
    }
    if (url.pathname.endsWith('/auth/verify')) return Response.json({
      token: `session:${challengedPreorder}`, address: ethereumAddress,
      preorderId: challengedPreorder, expiresAtMs: Date.now() + 3_600_000,
    });
    assert.fail(`Unexpected request: ${url.pathname}`);
  });
  return { statusChecks, availabilityChecks, challengeChecks };
}

function harness(overrides: Partial<Options> = {}, client = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
})) {
  clients.push(client);
  const toasts: string[] = [];
  const successes: string[] = [];
  let refreshes = 0;
  const options: Options = {
    preorderId: resolveAppRoute({ pathname: '/' }).preorderId, connectedWallet: buyer, authenticatedWallet: undefined,
    isSignedInWallet: false, isViewerMode: false, commerceUiSuspended: false, statusUiSuspended: false,
    signTransaction: undefined, ensureSignedIn: async () => false,
    refreshInventoryAfterMint: async () => { refreshes++; },
    showToast: message => { toasts.push(message); }, showSuccessHud: message => { successes.push(message); },
    ...overrides,
  };
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const view = renderHook((props: Options) => useShopPreorders(props), { wrapper, initialProps: options });
  return { ...view, options, client, toasts, successes, get refreshes() { return refreshes; } };
}

test('both upcoming routes disable preorder wallet verification and checkout', async t => {
  const calls = server(t);
  const providerListeners = new Set<unknown>();
  Object.defineProperty(window, 'ethereum', { configurable: true, value: {
    request: async () => { throw new Error('Upcoming drops must not request the Ethereum wallet'); },
    on: (_event: string, listener: unknown) => providerListeners.add(listener),
    removeListener: (_event: string, listener: unknown) => providerListeners.delete(listener),
  } });
  window.localStorage.setItem('mons.shop.mi-note.ethereum-wallet', JSON.stringify({ type: 'legacy' }));
  const view = harness();
  for (const pathname of ['/mi_note_cards', '/mi_note_cards_devnet', '/mi_note_cards', '/']) {
    const route = resolveAppRoute({ pathname });
    assert.equal(route.preorderId, null);
    view.rerender({ ...view.options, preorderId: route.preorderId });
    assert.equal(view.result.current.miNoteCardsPage, false);
    assert.equal(view.result.current.ethereumVerification.session, null);
    assert.equal(view.result.current.preorderCheckout.availability, null);
    assert.equal(view.result.current.preorderCheckout.config.checkoutEnabled, false);
    await act(async () => {
      await view.result.current.ethereumVerification.verify();
      await view.result.current.preorderCheckout.purchase([1]);
      window.dispatchEvent(new dom.window.Event('focus'));
    });
    assert.equal(view.result.current.ethereumVerification.session, null);
    assert.equal(view.result.current.preorderCheckout.pending, null);
  }
  assert.deepEqual(calls.challengeChecks, []);
  assert.deepEqual(calls.availabilityChecks, []);
  view.unmount();
  assert.equal(providerListeners.size, 0);
});

test('both collections recover off-page for an authenticated disconnected owner without replaying success', async t => {
  const pending = [order(1), order(2, devnet.preorderId)];
  for (const value of pending) await upsertPreorderRecovery(value);
  const calls = server(t, pending.map(value => ({ ...value, status: 'succeeded' })));
  const view = harness({ connectedWallet: undefined, authenticatedWallet: buyer, commerceUiSuspended: true });
  await waitFor(() => assert.equal(listPreorderRecoveries(buyer).filter(record => record.order.status === 'succeeded').length, 2));
  assert.deepEqual(new Set(calls.statusChecks), new Set([mainnet.preorderId, devnet.preorderId]));
  assert.equal(view.refreshes, 2);
  assert.deepEqual(view.successes, []);
  assert.equal(view.result.current.preorderCheckout.buyer, undefined);
  assert.equal(view.result.current.preorderCheckout.pending, null);
  view.rerender({ ...view.options, connectedWallet: otherBuyer });
  const checks = calls.statusChecks.length;
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(calls.statusChecks.length, checks);
});

test('failed and expired recovery removes only the owner assets from both inventory cache variants once', async t => {
  server(t);
  const failures = [order(3, mainnet.preorderId, 'failed'), order(4, devnet.preorderId, 'expired')];
  for (const value of failures) await upsertPreorderRecovery(value);
  const items: InventoryItem[] = [3, 4, 5].map(id => ({ id: address(id), dropId: mainnet.preorderId, kind: 'preorder', name: `Card ${id}` }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  for (const owner of [buyer, otherBuyer]) for (const includeDevnet of [false, true]) {
    client.setQueryData(['inventory', owner, includeDevnet], items);
  }
  const cancel = t.mock.method(client, 'cancelQueries');
  const view = harness({ commerceUiSuspended: true, statusUiSuspended: true }, client);
  await waitFor(() => {
    for (const includeDevnet of [false, true]) {
      assert.deepEqual(client.getQueryData(['inventory', buyer, includeDevnet]), [items[2]]);
      assert.deepEqual(client.getQueryData(['inventory', otherBuyer, includeDevnet]), items);
    }
  });
  assert.equal(cancel.mock.callCount(), 2);
  await act(async () => { await upsertPreorderRecovery(order(5, mainnet.preorderId, 'succeeded')); });
  view.rerender({ ...view.options, preorderId: resolveAppRoute({ pathname: '/mi_note_cards_devnet' }).preorderId });
  assert.equal(cancel.mock.callCount(), 2);
  assert.deepEqual(view.toasts, []);
  assert.ok(listPreorderRecoveries(buyer).every(record => !record.failureNotified));
});

test('failure notices wait for an eligible visible wallet, acknowledge once, and stop on unmount', async t => {
  server(t);
  await upsertPreorderRecovery(order(6, mainnet.preorderId, 'failed'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const view = harness({ isSignedInWallet: true, authenticatedWallet: buyer });
  const gates: Partial<Options>[] = [
    { statusUiSuspended: true }, { isViewerMode: true }, { isSignedInWallet: false }, { connectedWallet: undefined },
  ];
  assert.deepEqual(view.toasts, []);
  for (const gate of gates) {
    view.rerender({ ...view.options, ...gate });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'));
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
    });
    assert.deepEqual(view.toasts, []);
    assert.equal(listPreorderRecoveries(buyer)[0].failureNotified, false);
  }
  view.rerender({ ...view.options, commerceUiSuspended: true });
  await waitFor(() => assert.equal(listPreorderRecoveries(buyer)[0].failureNotified, true));
  assert.deepEqual(view.toasts, ['A preorder transaction did not finalize. Select cards to try again.']);
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('focus'));
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
  });
  assert.equal(view.toasts.length, 1);
  view.unmount();
  await upsertPreorderRecovery(order(7, devnet.preorderId, 'expired'));
  window.dispatchEvent(new dom.window.Event('focus'));
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(view.toasts.length, 1);
  assert.equal(listPreorderRecoveries(buyer).find(record => record.order.orderId === 'order-7')?.failureNotified, false);
});
