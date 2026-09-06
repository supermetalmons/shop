import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, mock } from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement, type PropsWithChildren } from 'react';
import {
  completeStripeCheckoutMarker,
  loadStripeCheckoutMarkers,
  rememberStripeCheckoutStarted,
} from '../src/lib/stripeCheckoutMarkers.ts';
import type { DeliveryOrderSummary, ReconcileProfileStateResponse } from '../src/types.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mons.shop/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useStripeCheckoutRecovery } = await import('../src/hooks/useStripeCheckoutRecovery.ts');

type Options = Parameters<typeof useStripeCheckoutRecovery>[0];
const clients: InstanceType<typeof QueryClient>[] = [];
const SUBJECT = 'anon:00000000-0000-4000-8000-000000000001';
const WALLET = 'wallet-a';
const DROP = 'test-drop';

beforeEach(() => {
  dom.window.localStorage.clear();
  dom.window.history.replaceState(null, '', '/');
  mock.method(globalThis, 'fetch', async (input) => {
    throw new Error(`Unexpected request: ${String(input)}`);
  });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  mock.restoreAll();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function options(overrides: Partial<Options> = {}): Options {
  return {
    auth: {
      authSubject: SUBJECT,
      sessionWallet: WALLET,
      authenticated: true,
      loading: false,
      sessionResolution: 'settled',
      shipments: [],
      shipmentsReady: true,
      reconcileProfile: async () => null,
    },
    connectedWallet: WALLET,
    dropId: DROP,
    mintStats: { minted: 10, total: 100, remaining: 90, mintSelectionAvailability: { M: 8 } },
    shouldFetchMintStats: true,
    refetchStats: async () => undefined,
    onCompleted: () => undefined,
    ...overrides,
  };
}

function checkout(sessionId: string, completed = true) {
  rememberStripeCheckoutStarted({ sessionId, authSubject: SUBJECT, dropId: DROP });
  if (completed) completeStripeCheckoutMarker({ sessionId, authSubject: SUBJECT });
}

function shipment(sessionId: string): DeliveryOrderSummary {
  return { dropId: DROP, deliveryId: 1, status: 'processing', items: [], stripeCheckoutSessionId: sessionId };
}

function mount(initialProps: Options, strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(
    QueryClientProvider,
    { client },
    children,
  );
  return { ...renderHook(useStripeCheckoutRecovery, { initialProps, wrapper, reactStrictMode: strict }), client };
}

test('StrictMode consumes checkout parameters once and waits for the matching auth subject', async (t) => {
  checkout('cs_return', false);
  dom.window.history.replaceState({ retained: true }, '', '/drop?keep=1&stripe_checkout=success&session_id=cs_return#inventory');
  const replace = t.mock.method(dom.window.history, 'replaceState');
  const completed = t.mock.fn();
  const initial = options({ onCompleted: completed });
  initial.auth = { ...initial.auth, authSubject: null, sessionWallet: null, authenticated: false, loading: true, sessionResolution: 'resolving' };
  const { result, rerender } = mount(initial, true);

  assert.equal(replace.mock.callCount(), 1);
  assert.equal(dom.window.location.href, 'https://mons.shop/drop?keep=1#inventory');
  assert.deepEqual(dom.window.history.state, { retained: true });
  assert.equal(loadStripeCheckoutMarkers()[0].status, 'started');
  assert.ok(completed.mock.callCount() > 0);

  rerender({ ...initial, auth: { ...initial.auth, authSubject: 'another-subject' } });
  assert.equal(loadStripeCheckoutMarkers()[0].status, 'started');
  rerender({ ...initial, auth: { ...initial.auth, authSubject: SUBJECT } });
  await waitFor(() => assert.equal(loadStripeCheckoutMarkers()[0].status, 'completed'));
  assert.equal(result.current.profileRecoveryPending, true);
  assert.equal(replace.mock.callCount(), 1);
});

test('optimistic supply survives resolved-marker cleanup until authoritative stats catch up', async (t) => {
  rememberStripeCheckoutStarted({
    sessionId: 'cs_return', authSubject: SUBJECT, dropId: DROP,
    quantity: 2, remainingBeforeCheckout: 90, variantKey: 'M', variantRemainingBeforeCheckout: 8,
  });
  dom.window.history.replaceState(null, '', '/?stripe_checkout=success&session_id=cs_return');
  const refetchStats = t.mock.fn(async () => undefined);
  const initial = options({ refetchStats });
  initial.auth = { ...initial.auth, shipments: [shipment('cs_return')] };
  const { result, rerender } = mount(initial);

  await waitFor(() => assert.equal(loadStripeCheckoutMarkers().length, 0));
  assert.deepEqual(result.current.recoveredProfile, { owner: WALLET, key: `${SUBJECT}:cs_return` });
  assert.equal(result.current.optimisticMintProgress?.quantity, 2);
  assert.equal(result.current.optimisticMintProgress?.remainingBeforeCheckout, 90);
  assert.equal(result.current.optimisticMintProgress?.variantRemainingBeforeCheckout, 8);
  assert.equal(refetchStats.mock.callCount(), 1);

  rerender({ ...initial, mintStats: { minted: 12, total: 100, remaining: 88, mintSelectionAvailability: { M: 7 } } });
  assert.ok(result.current.optimisticMintProgress);
  rerender({ ...initial, mintStats: { minted: 12, total: 100, remaining: 88, mintSelectionAvailability: { M: 6 } } });
  assert.equal(result.current.optimisticMintProgress, null);
});

test('partial authoritative shipments publish separate inventory targets and preserve unresolved markers', () => {
  checkout('cs_first');
  checkout('cs_second');
  const pending = deferred<ReconcileProfileStateResponse | null>();
  const initial = options();
  initial.auth = { ...initial.auth, shipments: [shipment('cs_first')], reconcileProfile: () => pending.promise };
  const { result, rerender } = mount(initial);

  assert.deepEqual(loadStripeCheckoutMarkers().map((marker) => marker.sessionId), ['cs_second']);
  assert.deepEqual(result.current.recoveredProfile, { owner: WALLET, key: `${SUBJECT}:cs_first` });
  assert.equal(result.current.profileRecoveryPending, true);
  const firstTarget = result.current.recoveredProfile;
  rerender({ ...initial, auth: { ...initial.auth, shipments: [shipment('cs_first')] } });
  assert.equal(result.current.recoveredProfile, firstTarget);

  rerender({ ...initial, auth: { ...initial.auth, shipments: [shipment('cs_first'), shipment('cs_second')] } });
  assert.equal(loadStripeCheckoutMarkers().length, 0);
  assert.deepEqual(result.current.recoveredProfile, { owner: WALLET, key: `${SUBJECT}:cs_second` });
  assert.equal(result.current.profileRecoveryPending, false);
});

test('wallet changes cancel stale reconciliation and prevent retrying the previous owner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  checkout('cs_old');
  const pending = deferred<ReconcileProfileStateResponse | null>();
  const reconcile = t.mock.fn(() => pending.promise);
  const initial = options();
  initial.auth = { ...initial.auth, reconcileProfile: reconcile };
  const { result, rerender } = mount(initial);
  assert.equal(reconcile.mock.callCount(), 1);

  rerender({
    ...initial,
    connectedWallet: 'wallet-b',
    auth: { ...initial.auth, authSubject: 'subject-b', sessionWallet: 'wallet-b', shipments: [shipment('cs_old')] },
  });
  await act(async () => { pending.resolve({ mergedStripeDeliveryOrders: 1 }); });
  await act(async () => { t.mock.timers.tick(20_000); });
  assert.equal(result.current.dataOwner, 'wallet-b');
  assert.equal(result.current.recoveredProfile, null);
  assert.equal(reconcile.mock.callCount(), 1);
  assert.equal(loadStripeCheckoutMarkers().length, 1);
});

test('unmount cancels scheduled reconciliation retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  checkout('cs_pending');
  const reconcile = t.mock.fn(async () => ({ mergedStripeDeliveryOrders: 0 }));
  const initial = options();
  initial.auth = { ...initial.auth, reconcileProfile: reconcile };
  const { unmount } = mount(initial);
  await act(async () => undefined);
  assert.equal(reconcile.mock.callCount(), 1);
  unmount();
  await act(async () => { t.mock.timers.tick(20_000); });
  assert.equal(reconcile.mock.callCount(), 1);
});

test('anonymous fallback waits for auth resolution and hides when a wallet connects', async (t) => {
  checkout('cs_anonymous');
  const historyResponse = deferred<Response>();
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/auth/anonymous/session') {
      return Response.json({ subject: SUBJECT, refreshedAt: Date.now(), expiresAt: Date.now() + 86_400_000 });
    }
    assert.equal(path, '/api/profile/anonymous-stripe-delivery-history');
    return historyResponse.promise;
  });
  const initial = options({ connectedWallet: undefined });
  initial.auth = { ...initial.auth, sessionWallet: null, authenticated: false, loading: true, sessionResolution: 'resolving', shipmentsReady: false };
  const { result, rerender } = mount(initial);
  assert.equal(requests.length, 0);
  assert.equal(result.current.anonymousHistory.visible, false);
  assert.equal(result.current.profileRecoveryPending, true);

  const settled = { ...initial, auth: { ...initial.auth, loading: false, sessionResolution: 'settled' as const } };
  rerender(settled);
  await waitFor(() => assert.ok(requests.includes('/api/profile/anonymous-stripe-delivery-history')));
  assert.equal(result.current.anonymousHistory.visible, true);
  assert.equal(result.current.anonymousHistory.initialLoading, true);
  assert.equal(result.current.anonymousHistory.waitingForFulfillment, true);
  await act(async () => { historyResponse.resolve(Response.json({ orders: [shipment('cs_anonymous')] })); });
  await waitFor(() => assert.equal(result.current.anonymousHistory.orders.length, 1));
  assert.equal(result.current.anonymousHistory.initialLoading, false);
  assert.equal(result.current.anonymousHistory.waitingForFulfillment, false);

  rerender({ ...settled, connectedWallet: WALLET });
  assert.equal(result.current.dataOwner, WALLET);
  assert.equal(result.current.anonymousHistory.visible, false);
});
