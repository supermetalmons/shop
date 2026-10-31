import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import bs58 from 'bs58';
import { getPreorderConfig, type PreorderOrder, type PreorderRecoveryResponse } from '../shared/preorders.ts';
import type { PreorderRecoveryApi } from '../src/hooks/usePreorderReconciliation.ts';
import { listPreorderRecoveries, upsertPreorderRecovery } from '../src/lib/preorderRecovery.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { installBrowserLocks } from './helpers/browserLocks.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { usePreorderRecovery } = await import('../src/hooks/usePreorderRecovery.ts');
const config = getPreorderConfig('mi_note_cards_devnet')!;
const address = (value: number) => bs58.encode(new Uint8Array(32).fill(value));
const buyer = address(31);
const otherBuyer = address(32);
const ethereumAddress = '0x0000000000000000000000000000000000000001';
const emptyPage = (): PreorderRecoveryResponse => ({ order: null, recoveries: [], nextRecoveryCursor: null });

beforeEach(t => {
  if ('after' in t) installBrowserLocks(t);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); });
after(() => dom.window.close());

function order(status: PreorderOrder['status'] = 'prepared', id = 1): PreorderOrder {
  return {
    orderId: `order-${id}`, preorderId: config.preorderId, buyer, ethereumAddress, cardIds: [id],
    assets: [{ id, address: address(id) }], status, expiresAtMs: Date.now() + 120_000,
    signature: status === 'prepared' ? null : bs58.encode(new Uint8Array(64).fill(id)),
  };
}

function pendingKey(value = config, owner = buyer) {
  return `mons:preorder:v1:${value.cluster}:${value.collection}:${owner}`;
}

function persist(value: PreorderOrder, submittedAttempt = true) {
  const collection = getPreorderConfig(value.preorderId)!;
  const saved = { requestId: 'saved', cardIds: value.cardIds, orderId: value.orderId,
    ethereumAddress: value.ethereumAddress, ...(submittedAttempt ? { submittedAttempt: true } : {}) };
  window.localStorage.setItem(pendingKey(collection, value.buyer), JSON.stringify(saved));
  return saved;
}

function receiveRecovery(value: PreorderOrder) {
  const collection = getPreorderConfig(value.preorderId)!;
  const key = `mons:preorder-recovery:v4:${collection.cluster}:${collection.collection}:${value.buyer}:${encodeURIComponent(value.orderId)}`;
  window.localStorage.setItem(key, JSON.stringify({ order: value, resolvedAssetIds: [], failureNotified: false, inventoryResolutionVersion: 4 }));
  window.dispatchEvent(new dom.window.StorageEvent('storage', { key }));
}

function runtime() {
  const cancelled: string[] = [];
  const settled: PreorderOrder[] = [];
  const api: PreorderRecoveryApi = {
    cancel: async input => { cancelled.push(input.orderId); return { order: { ...order('cancelled'), orderId: input.orderId } }; },
    status: async () => ({ order: null }),
    recoveries: async () => emptyPage(),
  };
  const options = { config, buyer, signedIn: true, authenticatedBuyer: buyer,
    onSettled: (value: PreorderOrder) => { settled.push(value); } };
  return { api, options, cancelled, settled };
}

for (const preorderId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  test(`${preorderId} discards unsigned preparations after a successful lookup without cancelling server reservations`, async () => {
    const { api, options, cancelled } = runtime();
    const collection = getPreorderConfig(preorderId)!;
    const prepared = { ...order(), preorderId };
    persist(prepared, false);
    let checks = 0;
    api.status = async () => { checks++; return { order: prepared }; };
    const { result } = renderHook(() => usePreorderRecovery({ ...options, config: collection }, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    assert.equal(result.current.order, null);
    assert.equal(result.current.pending, null);
    assert.equal(window.localStorage.getItem(pendingKey(collection)), null);
    await act(async () => {
      await result.current.cancel();
      window.dispatchEvent(new dom.window.Event('focus'));
    });
    assert.equal(checks, 1);
    assert.deepEqual(cancelled, []);
  });

  test(`${preorderId} recovers persisted submitted orders independently of the gallery`, async () => {
    const { api, options, settled } = runtime();
    const collection = getPreorderConfig(preorderId)!;
    const submitted = { ...order('submitted'), preorderId };
    persist(submitted);
    api.status = async () => ({ order: submitted });
    const { result } = renderHook(() => usePreorderRecovery({ ...options, config: collection }, api));
    await waitFor(() => assert.equal(result.current.order?.status, 'submitted'));
    api.status = async () => ({ order: { ...submitted, status: 'succeeded' } });
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    await waitFor(() => assert.equal(result.current.order?.status, 'succeeded'));
    assert.equal(result.current.pending, null);
    assert.equal(window.localStorage.getItem(pendingKey(collection)), null);
    assert.equal(settled.length, 1);
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    assert.equal(settled.length, 1);
  });

  test(`${preorderId} discovers an unconfirmed server submission without local recovery data`, async () => {
    const { api, options, cancelled } = runtime();
    const submitted = { ...order('submitted'), preorderId };
    let discoveryCalls = 0;
    api.recoveries = async id => {
      assert.equal(id, preorderId);
      discoveryCalls++;
      return { ...emptyPage(), order: submitted };
    };
    const statusIds: (string | undefined)[] = [];
    api.status = async (id, orderId) => {
      assert.equal(id, preorderId);
      statusIds.push(orderId);
      return { order: { ...submitted, status: 'succeeded' } };
    };
    const { result } = renderHook(() => usePreorderRecovery({ ...options, config: getPreorderConfig(preorderId)! }, api));
    await waitFor(() => assert.equal(result.current.order?.status, 'submitted'));
    assert.ok(discoveryCalls > 0);
    assert.equal(result.current.pending?.orderId, submitted.orderId);
    assert.equal(result.current.order?.confirmedSlot, undefined);
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    await waitFor(() => assert.equal(result.current.order?.status, 'succeeded'));
    assert.deepEqual(statusIds, [submitted.orderId]);
    assert.equal(result.current.pending, null);
    assert.deepEqual(cancelled, []);
  });

  for (const knownOrder of [false, true]) {
    test(`${preorderId} clears an orphan ${knownOrder ? 'order' : 'request'} after success and stops foreground polling`, async t => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const { api, options, cancelled } = runtime();
      const collection = getPreorderConfig(preorderId)!;
      const key = pendingKey(collection);
      window.localStorage.setItem(key, JSON.stringify({ requestId: 'orphan', cardIds: [1], ethereumAddress,
        ...(knownOrder ? { orderId: 'missing-order' } : {}) }));
      let checks = 0;
      api.status = async () => { checks++; return { order: null }; };
      api.recoveries = async () => { checks++; return emptyPage(); };
      const { result } = renderHook(() => usePreorderRecovery({ ...options, config: collection }, api));
      await act(async () => {});
      assert.equal(result.current.recoveryReady, true);
      assert.equal(result.current.pending, null);
      assert.equal(window.localStorage.getItem(key), null);
      const completedChecks = checks;
      await act(async () => { t.mock.timers.tick(5_000); });
      assert.equal(checks, completedChecks);
      assert.deepEqual(cancelled, []);
    });
  }
}

for (const knownOrder of [false, true]) {
  test(`an unsigned ${knownOrder ? 'order' : 'request'} survives a failed lookup`, async () => {
    const { api, options } = runtime();
    const saved = { requestId: 'request', cardIds: [1], ethereumAddress,
      ...(knownOrder ? { orderId: 'order-1' } : {}) };
    window.localStorage.setItem(pendingKey(), JSON.stringify(saved));
    api.status = async () => { throw new Error('Offline'); };
    api.recoveries = async () => { throw new Error('Offline'); };
    const { result } = renderHook(() => usePreorderRecovery(options, api));
    await waitFor(() => assert.match(result.current.error!, /keep checking/));
    assert.deepEqual(result.current.pending, saved);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), saved);
    assert.equal(result.current.recoveryReady, false);
    api.status = async () => ({ order: null });
    api.recoveries = async () => emptyPage();
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    assert.equal(result.current.pending, null);
    assert.equal(window.localStorage.getItem(pendingKey()), null);
    assert.equal(result.current.error, null);
  });
}

for (const responseStatus of [null, 'prepared'] as const) {
  for (const replacedOrder of [false, true]) {
    test(`${responseStatus ?? 'empty'} recovery preserves another tab's ${replacedOrder ? 'newer order' : 'same-order submission attempt'}`, async () => {
      const { api, options } = runtime();
      const saved = persist(order(), false);
      const response = Promise.withResolvers<{ order: PreorderOrder | null }>();
      let checks = 0;
      api.status = async () => { checks++; return checks === 1 ? response.promise : { order: null }; };
      const { result } = renderHook(() => usePreorderRecovery(options, api));
      await waitFor(() => assert.equal(checks, 1));
      const newer = { ...saved, submittedAttempt: true,
        ...(replacedOrder ? { requestId: 'new-request', orderId: 'order-2', cardIds: [2] } : {}) };
      window.localStorage.setItem(pendingKey(), JSON.stringify(newer));
      await act(async () => { response.resolve({ order: responseStatus ? order(responseStatus) : null }); });
      await waitFor(() => assert.deepEqual(result.current.pending, newer));
      assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), newer);
    });
  }

  for (const savedState of ['uncertain', 'known', 'reloaded'] as const) {
    test(`recovery preserves ${savedState} submission state after ${responseStatus ?? 'empty'} status`, async () => {
      const { api, options, cancelled } = runtime();
      const submitted = order('submitted');
      if (savedState === 'uncertain') persist(submitted);
      api.recoveries = async () => ({ ...emptyPage(), order: savedState === 'uncertain' ? null : submitted });
      api.status = async () => ({ order: savedState === 'uncertain' ? responseStatus ? order(responseStatus) : null : submitted });
      const render = () => renderHook(() => usePreorderRecovery(options, api));
      let view = render();
      await waitFor(() => assert.equal(view.result.current.recoveryReady, true));
      api.status = async () => ({ order: responseStatus ? order(responseStatus) : null });
      if (savedState === 'reloaded') {
        view.unmount();
        view = render();
        await waitFor(() => assert.equal(view.result.current.recoveryReady, true));
      }
      await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
      assert.equal(view.result.current.pending?.orderId, submitted.orderId);
      assert.equal(view.result.current.pending?.submittedAttempt, true);
      assert.ok(window.localStorage.getItem(pendingKey()));
      api.status = async () => ({ order: { ...submitted, status: 'succeeded' } });
      await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
      await waitFor(() => assert.equal(view.result.current.order?.status, 'succeeded'));
      assert.equal(view.result.current.pending, null);
      assert.deepEqual(cancelled, []);
    });
  }
}

for (const ethereumIdentity of [undefined, null]) {
  test(`identity-less requests with ${ethereumIdentity === null ? 'null' : 'missing'} Ethereum identity are ignored`, async () => {
    const { api, options } = runtime();
    window.localStorage.setItem(pendingKey(), JSON.stringify({ requestId: 'retired-request', cardIds: [1],
      ...(ethereumIdentity === null ? { ethereumAddress: null } : {}) }));
    api.recoveries = async () => { throw new Error('Offline'); };
    const { result } = renderHook(() => usePreorderRecovery(options, api));
    await waitFor(() => assert.match(result.current.error!, /keep checking/));
    assert.equal(result.current.pending, null);
  });
}

for (const fields of [{ orderId: 'known-order', submittedAttempt: true }, { submittedAttempt: true }]) {
  test(`abandonment cannot discard ${'orderId' in fields ? 'a known order' : 'a possible submission'}`, async () => {
    const { api, options, cancelled } = runtime();
    const saved = { requestId: 'request', cardIds: [1], ...fields };
    window.localStorage.setItem(pendingKey(), JSON.stringify(saved));
    const { result } = renderHook(() => usePreorderRecovery(options, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    await act(async () => { await result.current.cancel(); });
    assert.deepEqual(result.current.pending, saved);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), saved);
    assert.deepEqual(cancelled, []);
  });
}

for (const terminalStatus of ['succeeded', 'failed', 'expired', 'cancelled'] as const) {
  test(`another tab's ${terminalStatus} order is resolved by its saved ID`, async () => {
    const { api, options } = runtime();
    persist(order('submitted'));
    const { result } = renderHook(() => usePreorderRecovery(options, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    const saved = persist(order('submitted', 2));
    const ids: (string | undefined)[] = [];
    api.status = async (_id, id) => { ids.push(id); return { order: order(terminalStatus, 2) }; };
    await act(async () => { window.dispatchEvent(new dom.window.StorageEvent('storage', { key: pendingKey() })); });
    await waitFor(() => assert.equal(result.current.order?.status, terminalStatus));
    assert.deepEqual(ids, [saved.orderId]);
    assert.equal(result.current.pending, null);
    assert.equal(window.localStorage.getItem(pendingKey()), null);
    if (terminalStatus === 'failed' || terminalStatus === 'expired') assert.match(result.current.error!, new RegExp(terminalStatus));
  });
}

for (const kind of ['empty', 'active'] as const) {
  test(`delayed ${kind} discovery adopts another tab's newer submission before its storage event`, async () => {
    const { api, options } = runtime();
    const response = Promise.withResolvers<PreorderRecoveryResponse>();
    let calls = 0;
    api.recoveries = async () => { calls++; return response.promise; };
    const { result } = renderHook(() => usePreorderRecovery(options, api));
    await waitFor(() => assert.equal(calls, 2));
    const newer = persist(order('submitted', 3));
    await act(async () => { response.resolve({ ...emptyPage(), order: kind === 'active' ? order('submitted', 2) : null }); });
    await waitFor(() => assert.deepEqual(result.current.pending, newer));
    assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), newer);
    assert.equal(result.current.order, null);
  });
}

for (const knownOrderId of [false, true]) {
  test(`delayed terminal status cannot clear a newer same-card submission ${knownOrderId ? 'with' : 'without'} an order ID`, async () => {
    const { api, options } = runtime();
    const previous = order('submitted');
    persist(previous);
    const response = Promise.withResolvers<{ order: PreorderOrder }>();
    let started = false;
    api.status = async (_id, id) => {
      if (id === previous.orderId) { started = true; return response.promise; }
      return { order: null };
    };
    const { result } = renderHook(() => usePreorderRecovery(options, api));
    await waitFor(() => assert.equal(started, true));
    const newer = { requestId: 'new-request', cardIds: previous.cardIds, ethereumAddress, submittedAttempt: true,
      ...(knownOrderId ? { orderId: 'order-2' } : {}) };
    window.localStorage.setItem(pendingKey(), JSON.stringify(newer));
    await act(async () => { response.resolve({ order: { ...previous, status: 'succeeded' } }); });
    await waitFor(() => assert.deepEqual(result.current.pending, newer));
    assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), newer);
    assert.equal(result.current.order, null);
  });
}

test('sign-in recovery preserves a same-order submission newer than its in-memory marker', async () => {
  const { api, options } = runtime();
  const submitted = order('submitted');
  const previous = persist(submitted, false);
  const view = renderHook(signedIn => usePreorderRecovery({ ...options, signedIn, authenticatedBuyer: signedIn ? buyer : undefined }, api), { initialProps: false });
  assert.equal(view.result.current.pending?.submittedAttempt, undefined);
  const newer = { ...previous, submittedAttempt: true };
  window.localStorage.setItem(pendingKey(), JSON.stringify(newer));
  api.status = async () => ({ order: submitted });
  await act(async () => { view.rerender(true); });
  await waitFor(() => assert.equal(view.result.current.order?.status, 'submitted'));
  assert.deepEqual(view.result.current.pending, newer);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), newer);
});

test('invalid status leaves the current stored order recoverable', async () => {
  const { api, options } = runtime();
  const view = renderHook(signedIn => usePreorderRecovery({ ...options, signedIn, authenticatedBuyer: signedIn ? buyer : undefined }, api), { initialProps: false });
  const saved = persist(order('submitted', 2));
  api.status = async (_id, id) => {
    assert.equal(id, saved.orderId);
    throw new Error('Preorder API returned an invalid response.');
  };
  await act(async () => { view.rerender(true); });
  await waitFor(() => assert.match(view.result.current.error!, /keep checking/));
  assert.equal(view.result.current.order, null);
  assert.deepEqual(view.result.current.pending, saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), saved);
});

test('restored sign-in follows another tab’s new order instead of an older completed one', async () => {
  const { api, options, settled } = runtime();
  persist(order('submitted'));
  const view = renderHook(signedIn => usePreorderRecovery({ ...options, signedIn, authenticatedBuyer: signedIn ? buyer : undefined }, api), { initialProps: false });
  const next = order('submitted', 2);
  const newer = persist(next);
  const ids: (string | undefined)[] = [];
  api.status = async (_id, id) => { ids.push(id); return { order: id === next.orderId ? next : order('succeeded') }; };
  await act(async () => { view.rerender(true); });
  await waitFor(() => assert.equal(view.result.current.order?.orderId, next.orderId));
  assert.deepEqual(ids, [next.orderId]);
  assert.deepEqual(view.result.current.pending, newer);
  assert.deepEqual(settled, []);
});

for (const responseStatus of ['submitted', 'succeeded', 'failed', 'expired'] as const) {
  test(`durable ${responseStatus} recovery takes precedence over a stale prepared response`, async () => {
    const { api, options } = runtime();
    const submitted = order('submitted');
    persist(submitted);
    const response = Promise.withResolvers<{ order: PreorderOrder }>();
    api.status = async () => response.promise;
    const { result } = renderHook(() => usePreorderRecovery(options, api));
    await act(async () => { await upsertPreorderRecovery({ ...submitted, status: responseStatus, confirmedSlot: 100 }); });
    await waitFor(() => assert.equal(result.current.pending, null));
    await act(async () => { response.resolve({ order: order() }); });
    assert.equal(result.current.order?.status, responseStatus);
    assert.equal(result.current.pending, null);
    assert.equal(listPreorderRecoveries(buyer)[0].order.status, responseStatus);
  });
}

test('recovery adoption requires matching wallet, collection, Ethereum identity, cards, assets and signature', async () => {
  const { api, options } = runtime();
  const submitted = order('submitted');
  persist(submitted);
  api.status = async () => ({ order: submitted });
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.equal(result.current.order?.status, 'submitted'));
  const confirmed = { ...submitted, confirmedSlot: 100 };
  const mismatches = [
    { ...confirmed, orderId: 'another-order' },
    { ...confirmed, buyer: otherBuyer },
    { ...confirmed, preorderId: 'mi_note_cards' },
    { ...confirmed, ethereumAddress: '0x0000000000000000000000000000000000000002' },
    { ...confirmed, cardIds: [2], assets: [{ id: 2, address: submitted.assets[0].address }] },
    { ...confirmed, assets: [{ id: 1, address: address(2) }] },
    { ...confirmed, signature: bs58.encode(new Uint8Array(64).fill(2)) },
  ];
  for (const mismatch of mismatches) {
    await act(async () => { receiveRecovery(mismatch); });
    assert.equal(result.current.pending?.orderId, submitted.orderId);
    assert.equal(result.current.order?.confirmedSlot, undefined);
  }
  await act(async () => { receiveRecovery(confirmed); });
  assert.equal(result.current.pending, null);
  assert.equal(result.current.order?.confirmedSlot, 100);
});

test('reload adopts matching confirmation without waiting for status or replaying purchase success', async () => {
  const { api, options } = runtime();
  const confirmed = { ...order('submitted'), confirmedSlot: 100 };
  persist(confirmed);
  await upsertPreorderRecovery(confirmed);
  const response = Promise.withResolvers<{ order: null }>();
  api.status = async () => response.promise;
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.equal(result.current.pending, null);
  assert.equal(result.current.order?.orderId, confirmed.orderId);
  assert.equal(result.current.busy, false);
  await act(async () => { response.resolve({ order: null }); });
});

test('confirmed foreground recovery waits for its durable write before removing the pending marker', async () => {
  const { api, options } = runtime();
  const confirmed = { ...order('submitted'), confirmedSlot: 100 };
  const saved = persist(confirmed);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const lockKey = `mons:preorder-recovery-mutation:mons:preorder-recovery:v4:${config.cluster}:${config.collection}:${buyer}:order-1`;
  const holder = navigator.locks.request(lockKey, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let checked = false;
  api.status = async () => { checked = true; return { order: confirmed }; };
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.equal(checked, true));
  assert.deepEqual(result.current.pending, saved);
  assert.equal(result.current.recoveryReady, false);
  assert.equal(listPreorderRecoveries(buyer).length, 0);
  await act(async () => { release.resolve(); await holder; });
  await waitFor(() => assert.equal(result.current.pending, null));
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'submitted');
});

test('a queued durable write cannot complete the next wallet’s recovery', async () => {
  const { api, options, settled } = runtime();
  const confirmed = { ...order('submitted'), confirmedSlot: 100 };
  persist(confirmed);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const lockKey = `mons:preorder-recovery-mutation:mons:preorder-recovery:v4:${config.cluster}:${config.collection}:${buyer}:order-1`;
  const holder = navigator.locks.request(lockKey, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let checked = false;
  api.status = async () => { checked = true; return { order: confirmed }; };
  const view = renderHook(owner => usePreorderRecovery({ ...options, buyer: owner, authenticatedBuyer: owner }, api), { initialProps: buyer });
  await waitFor(() => assert.equal(checked, true));
  view.rerender(otherBuyer);
  await act(async () => { release.resolve(); await holder; });
  assert.equal(view.result.current.order, null);
  assert.equal(view.result.current.pending, null);
  assert.equal(view.result.current.busy, false);
  assert.deepEqual(settled, []);
  assert.equal(listPreorderRecoveries(otherBuyer).length, 0);
});

test('a prepared order after an uncertain submission remains cancellable through the status protocol', async () => {
  const { api, options, cancelled } = runtime();
  persist(order());
  api.status = async () => ({ order: order() });
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.equal(result.current.order?.status, 'prepared'));
  await act(async () => { await result.current.cancel(); });
  assert.deepEqual(cancelled, ['order-1']);
  assert.equal(result.current.order?.status, 'cancelled');
  assert.equal(result.current.pending, null);
});

test('a failed abandonment lookup preserves an unresolved preparation', async () => {
  const { api, options } = runtime();
  const saved = { requestId: 'request', cardIds: [1], ethereumAddress };
  window.localStorage.setItem(pendingKey(), JSON.stringify(saved));
  api.recoveries = async () => { throw new Error('Offline'); };
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.match(result.current.error!, /keep checking/));
  await act(async () => { await result.current.cancel(); });
  assert.deepEqual(result.current.pending, saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), saved);
  assert.equal(result.current.busy, false);
});

test('delayed cancellation preserves another tab’s newer submission and resumes recovery', async () => {
  const { api, options } = runtime();
  persist(order());
  api.status = async (_id, id) => ({ order: id === 'order-2' ? order('submitted', 2) : order() });
  const response = Promise.withResolvers<{ order: PreorderOrder }>();
  api.cancel = async () => response.promise;
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.equal(result.current.order?.status, 'prepared'));
  let cancellation!: Promise<void>;
  act(() => { cancellation = result.current.cancel(); });
  assert.equal(result.current.busy, true);
  const newer = persist(order('submitted', 2));
  await act(async () => { response.resolve({ order: order('cancelled') }); await cancellation; });
  await waitFor(() => assert.equal(result.current.order?.orderId, 'order-2'));
  assert.deepEqual(result.current.pending, newer);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), newer);
  assert.equal(result.current.busy, false);
});

test('returning A → B → A cannot let an older cancellation clear the newer operation', async () => {
  const { api, options } = runtime();
  persist(order());
  api.status = async () => ({ order: order() });
  const cancellations: ReturnType<typeof Promise.withResolvers<{ order: PreorderOrder }>>[] = [];
  api.cancel = async () => {
    const response = Promise.withResolvers<{ order: PreorderOrder }>();
    cancellations.push(response);
    return response.promise;
  };
  const view = renderHook(owner => usePreorderRecovery({ ...options, buyer: owner, authenticatedBuyer: owner }, api), { initialProps: buyer });
  await waitFor(() => assert.equal(view.result.current.order?.status, 'prepared'));
  let first!: Promise<void>;
  act(() => { first = view.result.current.cancel(); });
  view.rerender(otherBuyer);
  view.rerender(buyer);
  await waitFor(() => assert.equal(view.result.current.order?.status, 'prepared'));
  let second!: Promise<void>;
  act(() => { second = view.result.current.cancel(); });
  assert.equal(cancellations.length, 2);
  assert.equal(view.result.current.busy, true);
  await act(async () => { cancellations[0].resolve({ order: order('cancelled') }); await first; });
  assert.equal(view.result.current.busy, true);
  assert.equal(view.result.current.order?.status, 'prepared');
  assert.ok(window.localStorage.getItem(pendingKey()));
  await act(async () => { cancellations[1].resolve({ order: order('cancelled') }); await second; });
  assert.equal(view.result.current.busy, false);
  assert.equal(view.result.current.order?.status, 'cancelled');
  assert.equal(view.result.current.pending, null);
});

for (const change of ['buyer', 'collection', 'sign-out'] as const) {
  test(`a delayed foreground response cannot cross a ${change} change`, async () => {
    const { api, options, settled } = runtime();
    const submitted = order('submitted');
    const saved = persist(submitted);
    const response = Promise.withResolvers<{ order: PreorderOrder }>();
    let checks = 0;
    api.status = async () => { checks++; return response.promise; };
    const view = renderHook(next => usePreorderRecovery(next, api), { initialProps: options });
    await waitFor(() => assert.equal(checks, 1));
    const next = change === 'buyer' ? { ...options, buyer: otherBuyer, authenticatedBuyer: otherBuyer }
      : change === 'collection' ? { ...options, config: getPreorderConfig('mi_note_cards')! }
      : { ...options, signedIn: false, authenticatedBuyer: undefined };
    view.rerender(next);
    await act(async () => { response.resolve({ order: { ...submitted, status: 'succeeded' } }); });
    assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), saved);
    assert.equal(view.result.current.order, null);
    assert.deepEqual(settled, []);
  });
}

test('an authenticated disconnected owner resolves an unconfirmed submission from its local marker', async () => {
  const { api, options, settled } = runtime();
  const submitted = order('submitted');
  persist(submitted);
  api.status = async () => ({ order: submitted });
  const view = renderHook(() => usePreorderRecovery({ ...options, buyer: undefined, signedIn: false }, api));
  await waitFor(() => assert.equal(view.result.current.order?.status, 'submitted'));
  api.status = async () => ({ order: { ...submitted, status: 'succeeded' } });
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(view.result.current.order?.status, 'succeeded'));
  assert.equal(view.result.current.pending, null);
  assert.equal(window.localStorage.getItem(pendingKey()), null);
  assert.equal(settled.length, 1);
});

test('an unknown possible submission cannot be replaced by a different active order or cause recursive polling', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { api, options } = runtime();
  const saved = { requestId: 'unknown-submission', cardIds: [2], ethereumAddress, submittedAttempt: true };
  window.localStorage.setItem(pendingKey(), JSON.stringify(saved));
  let calls = 0;
  api.recoveries = async () => { calls++; return { ...emptyPage(), order: order('submitted') }; };
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await act(async () => {});
  assert.equal(calls, 2);
  assert.equal(result.current.recoveryReady, true);
  assert.equal(result.current.order, null);
  assert.deepEqual(result.current.pending, saved);
  assert.match(result.current.error!, /being checked/);
  await act(async () => { t.mock.timers.tick(3_000); });
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), saved);
  const matching = order('submitted', 2);
  api.recoveries = async () => ({ ...emptyPage(), order: matching });
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(result.current.order?.orderId, matching.orderId);
  assert.equal(result.current.pending?.requestId, saved.requestId);
  assert.equal(result.current.pending?.submittedAttempt, true);
  assert.equal(result.current.error, null);
});

test('a hidden older failure cannot replace a newer pending submission', async () => {
  const { api, options } = runtime();
  const older = { ...order('submitted'), confirmedSlot: 100 };
  await upsertPreorderRecovery(older);
  const newer = order('submitted', 2);
  const saved = persist(newer);
  const response = Promise.withResolvers<{ order: PreorderOrder }>();
  api.status = async (_id, id) => id === older.orderId ? response.promise : { order: newer };
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.equal(result.current.order?.orderId, newer.orderId));
  await act(async () => { response.resolve({ order: { ...older, status: 'failed', confirmedSlot: undefined } }); });
  assert.equal(result.current.order?.orderId, newer.orderId);
  assert.deepEqual(result.current.pending, saved);
  const recovered = listPreorderRecoveries(buyer).find(record => record.order.orderId === older.orderId)!;
  assert.equal(recovered.order.status, 'failed');
  assert.equal(recovered.failureNotified, false);
});

test('disabled collections retain local recovery data without starting requests', async () => {
  const { api, options } = runtime();
  const saved = persist(order('submitted'));
  const forbidden = async (): Promise<never> => assert.fail('Disabled collections must not make recovery requests');
  api.status = forbidden;
  api.recoveries = forbidden;
  api.cancel = forbidden;
  const { result } = renderHook(() => usePreorderRecovery({ ...options, config: { ...config, enabled: false } }, api));
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); await result.current.cancel(); });
  assert.equal(result.current.order, null);
  assert.equal(result.current.pending, null);
  assert.equal(result.current.recoveryReady, true);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(pendingKey())!), saved);
});
