import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getPreorderConfig, type PreorderOrder, type PreorderRecoveryResponse } from '../shared/preorders.ts';
import { usePreorderReconciliation, type PreorderRecoveryApi } from '../src/hooks/usePreorderReconciliation.ts';
import { acknowledgePreorderFailure, listPreorderRecoveries, resolvePreorderInventoryAssets, upsertPreorderRecovery } from '../src/lib/preorderRecovery.ts';
import { runPreorderStatus } from '../src/lib/preorderStatusQueue.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { installBrowserLocks } from './helpers/browserLocks.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { usePreorderRecovery } = await import('../src/hooks/usePreorderRecovery.ts');
const config = getPreorderConfig('mi_note_cards_devnet')!;
const buyer = Keypair.generate().publicKey.toBase58();
const ethereumAddress = '0x0000000000000000000000000000000000000001';
const signature = bs58.encode(new Uint8Array(64).fill(1));

beforeEach(t => {
  if ('after' in t) installBrowserLocks(t);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); });
after(() => dom.window.close());

function fixture(id: number, status: PreorderOrder['status'] = 'submitted'): PreorderOrder {
  return { orderId: `order-${id}`, preorderId: config.preorderId, buyer, ethereumAddress,
    cardIds: [id], assets: [{ id, address: Keypair.generate().publicKey.toBase58() }], status,
    confirmedSlot: status === 'prepared' ? null : 100 + id, signature: status === 'prepared' ? null : signature,
    expiresAtMs: Date.now() + 120_000 };
}

function runtime() {
  const orders = new Map<string, PreorderOrder>();
  const settled: PreorderOrder[] = [];
  const api: PreorderRecoveryApi = {
    cancel: async input => ({ order: { ...orders.get(input.orderId)!, status: 'cancelled' } }),
    status: async (_id, orderId) => ({ order: orderId ? orders.get(orderId) ?? null : null }),
    recoveries: async () => ({ order: null, recoveries: [], nextRecoveryCursor: null }),
  };
  const options = { config, buyer, signedIn: true, authenticatedBuyer: buyer,
    onSettled: (value: PreorderOrder) => { settled.push(value); } };
  return { api, options, orders, settled };
}

test('reload restores confirmed artwork and quietly finalizes without replaying success', async () => {
  const { api, options, orders, settled } = runtime();
  const confirmed = fixture(1);
  await upsertPreorderRecovery(confirmed);
  orders.set(confirmed.orderId, { ...confirmed, status: 'succeeded' });
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.equal(settled.length, 1));
  assert.equal(result.current.pending, null);
  const asset = confirmed.assets[0].address;
  await act(async () => { await resolvePreorderInventoryAssets(buyer, [asset]); });
  assert.deepEqual(listPreorderRecoveries(buyer)[0].resolvedAssetIds, [asset]);
  await act(async () => { await upsertPreorderRecovery(confirmed); });
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'succeeded');
  assert.deepEqual(listPreorderRecoveries(buyer)[0].resolvedAssetIds, [asset]);
});

test('paginated discovery restores multiple orders without local storage and repeats on focus', async () => {
  const { api, options, orders } = runtime();
  const first = fixture(1);
  const second = fixture(2);
  orders.set(first.orderId, first);
  orders.set(second.orderId, second);
  const cursors: (string | undefined)[] = [];
  api.recoveries = async (_id, cursor) => {
    cursors.push(cursor);
    return { order: null, recoveries: cursor ? [second] : [first], nextRecoveryCursor: cursor ? null : 'page-2' };
  };
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.equal(listPreorderRecoveries(buyer).length, 2));
  assert.equal(cursors.filter(cursor => cursor === 'page-2').length, 1);
  const initialRequests = cursors.length;
  assert.equal(result.current.pending, null);
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(cursors.length, initialRequests + 2));
});

for (const initialResult of ['complete', 'failed'] as const) {
  test(`hidden visibility changes reset ${initialResult} discovery before the next visible polling tick`, async t => {
    const { api } = runtime();
    let requests = 0;
    api.recoveries = async () => {
      requests++;
      if (initialResult === 'failed' && requests === 1) throw new Error('Unavailable');
      return { order: null, recoveries: [], nextRecoveryCursor: null };
    };
    let tick: (() => void) | undefined;
    const setInterval = globalThis.setInterval;
    t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
      assert.equal(delay, 1_000);
      tick = callback;
      return setInterval(callback, delay);
    });
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    t.after(() => {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
      else Reflect.deleteProperty(document, 'visibilityState');
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const view = renderHook(() => usePreorderReconciliation({
      buyer, signedIn: true, preorderId: config.preorderId, enabled: true, api, onTerminal: () => {},
    }));
    await act(async () => {});
    assert.equal(requests, 1);
    const poll = tick;
    assert.ok(poll);
    await act(async () => { poll(); });
    assert.equal(requests, 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { document.dispatchEvent(new dom.window.Event('visibilitychange')); });
    assert.equal(requests, 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { poll(); });
    assert.equal(requests, 2);
    await act(async () => { window.dispatchEvent(new dom.window.Event('online')); });
    assert.equal(requests, 2);
    view.unmount();
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'));
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
      poll();
    });
    assert.equal(requests, 2);
  });
}

test('discovery arriving after a buyer switch cannot populate the new wallet recovery', async () => {
  const { api, options } = runtime();
  const first = fixture(1);
  let finish!: (page: PreorderRecoveryResponse) => void;
  let calls = 0;
  api.recoveries = async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : { order: null, recoveries: [], nextRecoveryCursor: null };
  const { rerender } = renderHook(owner => usePreorderRecovery({ ...options, buyer: owner, authenticatedBuyer: owner }, api), { initialProps: buyer });
  await waitFor(() => assert.ok(calls >= 1));
  rerender(Keypair.generate().publicKey.toBase58());
  await act(async () => { finish({ order: null, recoveries: [first], nextRecoveryCursor: null }); });
  assert.equal(listPreorderRecoveries().length, 0);
});

test('temporary missing and failed RPC checks keep confirmed cards and inventory recovery intact', async () => {
  const { api, options } = runtime();
  const confirmed = fixture(1);
  await upsertPreorderRecovery(confirmed);
  api.status = async (_id, id) => { if (id) throw new Error('RPC temporarily unavailable'); return { order: null }; };
  const { result } = renderHook(() => usePreorderRecovery(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'submitted');
  assert.equal(result.current.error, null);
});

test('a storage quota failure preserves newer terminal recovery state over the older saved confirmation', async () => {
  const order = fixture(1);
  await upsertPreorderRecovery(order);
  const original = dom.window.Storage.prototype.setItem;
  dom.window.Storage.prototype.setItem = () => { throw new Error('Quota exceeded'); };
  try {
    await upsertPreorderRecovery({ ...order, status: 'failed' });
    assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'failed');
  } finally { dom.window.Storage.prototype.setItem = original; }
  await acknowledgePreorderFailure(buyer, config.preorderId, order.orderId);
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'failed');
  assert.equal(listPreorderRecoveries(buyer)[0].failureNotified, true);
});

test('recovery across both collections keeps distinct records and ignores a wallet change', async () => {
  const { api, options } = runtime();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  const devnetOrder = fixture(1);
  const mainnetOrder = { ...fixture(1), preorderId: mainnet.preorderId };
  await upsertPreorderRecovery(devnetOrder);
  await upsertPreorderRecovery(mainnetOrder);
  const checked: string[] = [];
  api.status = async (preorderId, id) => {
    if (!id) return { order: null };
    checked.push(preorderId);
    return { order: { ...(preorderId === mainnet.preorderId ? mainnetOrder : devnetOrder), status: 'succeeded' } };
  };
  const { rerender } = renderHook(owner => {
    usePreorderRecovery({ ...options, buyer: owner, authenticatedBuyer: owner }, api);
    usePreorderRecovery({ ...options, buyer: owner, authenticatedBuyer: owner, config: mainnet }, api);
  }, { initialProps: buyer });
  await waitFor(() => assert.equal(checked.length, 2));
  assert.deepEqual(new Set(checked), new Set([config.preorderId, mainnet.preorderId]));
  assert.equal(listPreorderRecoveries(buyer).length, 2);
  rerender(Keypair.generate().publicKey.toBase58());
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(checked.length, 2);
});

for (const status of ['succeeded', 'failed'] as const) {
  test(`an authenticated disconnected owner quietly recovers ${status} preorders without enabling checkout`, async () => {
    const { api, options, settled, orders } = runtime();
    const confirmed = fixture(1);
    await upsertPreorderRecovery(confirmed);
    orders.set(confirmed.orderId, { ...confirmed, status });
    const { result } = renderHook(() => usePreorderRecovery({ ...options, buyer: undefined, signedIn: false }, api));
    await waitFor(() => assert.equal(listPreorderRecoveries(buyer)[0].order.status, status));
    assert.equal(settled.length, 1);
    assert.equal(listPreorderRecoveries(buyer)[0].failureNotified, false);
    assert.equal(result.current.order, null);
    assert.equal(result.current.pending, null);
  });
}

test('disconnected recovery stops on a mismatched wallet connection and ignores late responses', async () => {
  const { api, options, settled } = runtime();
  const confirmed = fixture(1);
  await upsertPreorderRecovery(confirmed);
  const response = Promise.withResolvers<{ order: PreorderOrder }>();
  let checks = 0;
  api.status = async () => { checks++; return response.promise; };
  const otherBuyer = Keypair.generate().publicKey.toBase58();
  const { rerender } = renderHook((connectedBuyer: string | undefined) => usePreorderRecovery({
    ...options, buyer: connectedBuyer, signedIn: false,
  }, api), { initialProps: undefined as string | undefined });
  await waitFor(() => assert.equal(checks, 1));
  rerender(otherBuyer);
  await act(async () => {
    response.resolve({ order: { ...confirmed, status: 'succeeded' } });
    window.dispatchEvent(new dom.window.Event('focus'));
  });
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'submitted');
  assert.equal(settled.length, 0);
  assert.equal(checks, 1);
});

test('slow recovery requests do not starve later orders', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { api, options } = runtime();
  const orders = [fixture(1), fixture(2), fixture(3)];
  for (const order of orders) await upsertPreorderRecovery(order);
  const started: string[] = [];
  const finish: (() => void)[] = [];
  api.status = async (_id, orderId) => {
    if (!orderId) return { order: null };
    started.push(orderId);
    return new Promise(resolve => { finish.push(() => resolve({ order: orders.find(order => order.orderId === orderId)! })); });
  };
  const view = renderHook(() => usePreorderRecovery(options, api));
  await act(async () => {});
  await waitFor(() => assert.equal(started.length, 2));
  await act(async () => { t.mock.timers.tick(5_000); });
  assert.equal(started.length, 2);
  await act(async () => { finish.splice(0).forEach(resolve => resolve()); });
  await act(async () => { t.mock.timers.tick(1_000); });
  assert.equal(started[2], 'order-3');
  view.unmount();
  await act(async () => { finish.splice(0).forEach(resolve => resolve()); });
});

test('status work stays bounded at two reads and foreground recovery precedes queued background reads', async () => {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  let running = 0;
  let peak = 0;
  const request = (id: string, priority: 'foreground' | 'background') => runPreorderStatus(async () => {
    started.push(id);
    peak = Math.max(peak, ++running);
    await new Promise<void>(resolve => finish.set(id, resolve));
    running -= 1;
  }, priority);
  const first = request('first', 'background');
  const second = request('second', 'background');
  const background = request('background', 'background');
  const foreground = request('foreground', 'foreground');
  assert.deepEqual(started, ['first', 'second']);
  finish.get('first')!();
  await first;
  assert.equal(started[2], 'foreground');
  finish.get('second')!();
  await second;
  assert.equal(started[3], 'background');
  finish.get('foreground')!();
  finish.get('background')!();
  await Promise.all([foreground, background]);
  assert.equal(peak, 2);
});
