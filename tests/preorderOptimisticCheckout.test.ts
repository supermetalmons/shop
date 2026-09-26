import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import bs58 from 'bs58';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getPreorderConfig, type PreorderOrder, type PreorderRecoveryResponse } from '../shared/preorders.ts';
import { acknowledgePreorderFailure, listPreorderRecoveries, resolvePreorderInventoryAssets, upsertPreorderRecovery } from '../src/lib/preorderRecovery.ts';
import type { PreorderCheckoutApi } from '../src/hooks/usePreorderReconciliation.ts';
import { runPreorderStatus } from '../src/lib/preorderStatusQueue.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { installBrowserLocks } from './helpers/browserLocks.ts';
import { ProfileApiError } from '../src/api/transport.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { usePreorderCheckout } = await import('../src/hooks/usePreorderCheckout.ts');
const config = getPreorderConfig('mi_note_cards_devnet')!;
const payer = Keypair.generate();
const buyer = payer.publicKey.toBase58();
const session = { address: '0x0000000000000000000000000000000000000001', token: 'ethereum', preorderId: config.preorderId, expiresAtMs: Date.now() + 3_600_000 };
const transaction = new VersionedTransaction(new TransactionMessage({
  payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
  instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
}).compileToV0Message());
const transactionBase64 = Buffer.from(transaction.serialize()).toString('base64');
const signature = bs58.encode(new Uint8Array(64).fill(1));

beforeEach(t => { if ('after' in t) installBrowserLocks(t); });
afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); });
after(() => dom.window.close());

function fixture(id: number, status: PreorderOrder['status'] = 'submitted'): PreorderOrder {
  return { orderId: `order-${id}`, preorderId: config.preorderId, buyer, ethereumAddress: session.address,
    cardIds: [id], assets: [{ id, address: Keypair.generate().publicKey.toBase58() }], status,
    confirmedSlot: status === 'prepared' ? null : 100 + id, signature: status === 'prepared' ? null : signature,
    expiresAtMs: Date.now() + 120_000 };
}

function runtime() {
  const orders = new Map<string, PreorderOrder>();
  const succeeded: PreorderOrder[] = [];
  const settled: PreorderOrder[] = [];
  const api: PreorderCheckoutApi = {
    availability: async () => ({ preorderId: config.preorderId, ethereumAddress: session.address, ownershipStatus: 'success', requiresAdminSignIn: false,
      items: [1, 2, 3, 4].map(id => ({ id, status: 'available' })) }),
    prepare: async input => {
      const order = fixture(input.cardIds[0], 'prepared');
      orders.set(order.orderId, order);
      return { order, transactionBase64 };
    },
    submit: async input => {
      const order = { ...orders.get(input.orderId)!, status: 'submitted' as const, confirmedSlot: 100, signature };
      orders.set(order.orderId, order);
      return { order };
    },
    cancel: async input => ({ order: { ...orders.get(input.orderId)!, status: 'cancelled' } }),
    status: async (_id, orderId) => ({ order: orderId ? orders.get(orderId) ?? null : null }),
  };
  const options = { config, active: true, buyer, signedIn: true, authenticatedBuyer: buyer, ethereumSession: session,
    ensureSignedIn: async () => true,
    signTransaction: async (tx: VersionedTransaction) => { tx.sign([payer]); return tx; },
    onSucceeded: (order: PreorderOrder) => { succeeded.push(order); },
    onSettled: (order: PreorderOrder) => { settled.push(order); },
  };
  return { api, options, orders, succeeded, settled };
}

function delayedRuntime() {
  const value = runtime();
  const submissions = new Map<string, ReturnType<typeof Promise.withResolvers<{ order: PreorderOrder }>>>();
  value.api.status = async () => ({ order: null });
  value.api.submit = async input => {
    const signed = VersionedTransaction.deserialize(Buffer.from(input.transactionBase64, 'base64'));
    value.orders.set(input.orderId, { ...value.orders.get(input.orderId)!, status: 'submitted', confirmedSlot: 100,
      signature: bs58.encode(signed.signatures[0]) });
    const response = Promise.withResolvers<{ order: PreorderOrder }>();
    submissions.set(input.orderId, response);
    return response.promise;
  };
  return { ...value, submissions };
}

function receiveRecovery(order: PreorderOrder) {
  const orderConfig = getPreorderConfig(order.preorderId)!;
  const key = `mons:preorder-recovery:v3:${orderConfig.cluster}:${orderConfig.collection}:${order.buyer}:${encodeURIComponent(order.orderId)}`;
  window.localStorage.setItem(key, JSON.stringify({ order, resolvedAssetIds: [], failureNotified: false }));
  window.dispatchEvent(new dom.window.StorageEvent('storage', { key }));
}

for (const httpStatus of [401, 409]) {
  for (const recoveredStatus of ['submitted', 'succeeded', 'failed', 'expired'] as const) {
    test(`stale prepared ${httpStatus} fallback respects persisted ${recoveredStatus}`, async () => {
      const { api, options, orders, succeeded } = runtime();
      let invalidations = 0;
      api.submit = async () => {
        throw new ProfileApiError({ message: 'Old submission denied', status: httpStatus, code: 'failed-precondition' });
      };
      api.status = async (_id, orderId) => {
        if (!orderId) return { order: null };
        const prepared = orders.get(orderId)!;
        const confirmed = { ...prepared, status: recoveredStatus, confirmedSlot: 500, signature };
        const key = `mons:preorder-recovery:v3:${config.cluster}:${config.collection}:${buyer}:${orderId}`;
        window.localStorage.setItem(key, JSON.stringify({ order: confirmed, resolvedAssetIds: [], failureNotified: false }));
        return { order: prepared };
      };
      const { result } = renderHook(() => usePreorderCheckout({ ...options,
        onEthereumSessionInvalid: () => { invalidations++; },
      }, api));
      await waitFor(() => assert.equal(result.current.recoveryReady, true));
      await act(async () => { await result.current.purchase([1]); });
      assert.equal(result.current.order?.status, recoveredStatus);
      assert.equal(result.current.order?.confirmedSlot, 500);
      assert.equal(result.current.pending, null);
      assert.notEqual(result.current.error, 'Old submission denied');
      assert.equal(invalidations, 0);
      assert.equal(succeeded.length, recoveredStatus === 'submitted' || recoveredStatus === 'succeeded' ? 1 : 0);
    });
  }

  test(`still-prepared ${httpStatus} fallback preserves the submission error`, async () => {
    const { api, options, succeeded } = runtime();
    let invalidations = 0;
    api.submit = async () => {
      throw new ProfileApiError({ message: 'Submission denied', status: httpStatus, code: 'failed-precondition' });
    };
    const { result } = renderHook(() => usePreorderCheckout({ ...options,
      onEthereumSessionInvalid: () => { invalidations++; },
    }, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    await act(async () => { await result.current.purchase([1]); });
    assert.equal(result.current.order?.status, 'prepared');
    assert.equal(result.current.pending?.orderId, 'order-1');
    assert.equal(result.current.error, 'Submission denied');
    assert.equal(invalidations, httpStatus === 401 ? 1 : 0);
    assert.equal(succeeded.length, 0);
  });
}

for (const lateResponse of ['success', 'error'] as const) {
  test(`cross-tab confirmation unlocks a new submission before the previous ${lateResponse} response arrives`, async () => {
    const { api, options, orders, succeeded, submissions } = delayedRuntime();
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    let firstPurchase!: Promise<void>;
    act(() => { firstPurchase = result.current.purchase([1]); });
    await waitFor(() => assert.equal(result.current.phase, 'submitting'));
    const first = orders.get('order-1')!;
    await act(async () => { receiveRecovery(first); });
    assert.equal(result.current.pending, null);
    assert.equal(result.current.busy, false);
    assert.equal(succeeded.length, 1);
    let secondPurchase!: Promise<void>;
    act(() => { secondPurchase = result.current.purchase([2]); });
    await waitFor(() => assert.equal(result.current.pending?.orderId, 'order-2'));
    await waitFor(() => assert.equal(result.current.phase, 'submitting'));
    await act(async () => { receiveRecovery({ ...first, status: 'succeeded' }); });
    assert.equal(result.current.pending?.orderId, 'order-2');
    assert.equal(result.current.phase, 'submitting');
    assert.equal(succeeded.length, 1);
    await act(async () => {
      if (lateResponse === 'success') submissions.get('order-1')!.resolve({ order: first });
      else submissions.get('order-1')!.reject(new Error('First response lost'));
      await firstPurchase;
    });
    assert.equal(result.current.order?.orderId, 'order-2');
    assert.equal(result.current.pending?.orderId, 'order-2');
    assert.equal(result.current.phase, 'submitting');
    assert.equal(result.current.error, null);
    await act(async () => { submissions.get('order-2')!.resolve({ order: orders.get('order-2')! }); await secondPurchase; });
    assert.deepEqual(succeeded.map(order => order.orderId), ['order-1', 'order-2']);
  });
}

test('recovery adoption requires the matching wallet, collection, Ethereum identity, assets and signed transaction', async () => {
  const { api, options, orders, succeeded, submissions } = delayedRuntime();
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'submitting'));
  const confirmed = orders.get('order-1')!;
  const mismatches = [
    { ...confirmed, orderId: 'another-order' },
    { ...confirmed, buyer: Keypair.generate().publicKey.toBase58() },
    { ...confirmed, preorderId: 'mi_note_cards' },
    { ...confirmed, ethereumAddress: '0x0000000000000000000000000000000000000002' },
    { ...confirmed, cardIds: [2], assets: [{ id: 2, address: confirmed.assets[0].address }] },
    { ...confirmed, assets: [{ id: 1, address: Keypair.generate().publicKey.toBase58() }] },
    { ...confirmed, signature },
  ];
  for (const mismatch of mismatches) {
    await act(async () => { receiveRecovery(mismatch); });
    assert.equal(result.current.phase, 'submitting');
    assert.equal(result.current.pending?.orderId, confirmed.orderId);
    assert.equal(succeeded.length, 0);
  }
  await act(async () => { receiveRecovery(confirmed); });
  assert.equal(result.current.pending, null);
  assert.equal(succeeded.length, 1);
  await act(async () => { submissions.get(confirmed.orderId)!.resolve({ order: confirmed }); await purchase; });
});

test('matching recovery completes an idle uncertain live submission exactly once', async () => {
  const { api, options, orders, succeeded, submissions } = delayedRuntime();
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'submitting'));
  await act(async () => { submissions.get('order-1')!.reject(new Error('Response lost')); await purchase; });
  assert.equal(result.current.phase, 'idle');
  assert.equal(result.current.pending?.submittedAttempt, true);
  assert.ok(result.current.error);
  await act(async () => { receiveRecovery(orders.get('order-1')!); });
  assert.equal(result.current.pending, null);
  assert.equal(result.current.error, null);
  assert.equal(succeeded.length, 1);
});

test('reload adopts a matching submitted recovery quietly without waiting for another status response', async () => {
  const { api, options, succeeded } = delayedRuntime();
  const confirmed = fixture(1);
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  window.localStorage.setItem(key, JSON.stringify({ requestId: 'saved', orderId: confirmed.orderId,
    cardIds: confirmed.cardIds, ethereumAddress: session.address, submittedAttempt: true }));
  await upsertPreorderRecovery(confirmed);
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.equal(result.current.pending, null);
  assert.equal(result.current.order?.orderId, confirmed.orderId);
  assert.equal(result.current.busy, false);
  assert.equal(succeeded.length, 0);
});

test('matching verified failure releases a delayed submission without a success or late error', async () => {
  const { api, options, orders, succeeded, submissions } = delayedRuntime();
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'submitting'));
  await act(async () => { receiveRecovery({ ...orders.get('order-1')!, status: 'failed' }); });
  assert.equal(result.current.pending, null);
  assert.equal(result.current.busy, false);
  assert.equal(result.current.order?.status, 'failed');
  assert.equal(succeeded.length, 0);
  await act(async () => { submissions.get('order-1')!.reject(new Error('Late submit error')); await purchase; });
  assert.equal(result.current.error, null);
});

test('recovery records cannot complete an unsigned reservation during signing', async () => {
  const { api, options, orders, succeeded } = runtime();
  api.status = async () => ({ order: null });
  const signing = Promise.withResolvers<VersionedTransaction>();
  options.signTransaction = async () => signing.promise;
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'signing'));
  const prepared = orders.get('order-1')!;
  await act(async () => { receiveRecovery({ ...prepared, status: 'submitted', confirmedSlot: 100, signature }); });
  assert.equal(result.current.phase, 'signing');
  assert.equal(result.current.pending?.orderId, prepared.orderId);
  assert.equal(succeeded.length, 0);
  await act(async () => { signing.reject(new Error('Signing cancelled')); await purchase; });
  assert.equal(succeeded.length, 0);
});

for (const status of ['submitted', 'succeeded', 'failed', 'expired'] as const) {
  test(`a stale prepared response cannot resume signing after verified ${status}`, async () => {
    const { api, options, orders } = runtime();
    const prepare = api.prepare;
    const response = Promise.withResolvers<Awaited<ReturnType<typeof api.prepare>>>();
    api.prepare = async (...args) => { await prepare(...args); return response.promise; };
    api.status = async () => ({ order: null });
    let signatures = 0;
    let submissions = 0;
    const sign = options.signTransaction;
    options.signTransaction = async value => { signatures += 1; return sign(value); };
    const submit = api.submit;
    api.submit = async (...args) => { submissions += 1; return submit(...args); };
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    let purchase!: Promise<void>;
    act(() => { purchase = result.current.purchase([1]); });
    await waitFor(() => assert.equal(result.current.phase, 'preparing'));
    const prepared = orders.get('order-1')!;
    const recovered = { ...prepared, status, confirmedSlot: 100, signature };
    await act(async () => { await upsertPreorderRecovery(recovered); });
    await act(async () => { response.resolve({ order: prepared, transactionBase64 }); await purchase; });
    assert.equal(signatures, 0);
    assert.equal(submissions, 0);
    assert.equal(result.current.order?.status, status);
    assert.equal(result.current.order?.confirmedSlot, 100);
    assert.equal(result.current.pending, null);
    assert.equal(result.current.busy, false);
  });
}

test('confirmation recorded while wallet signing is pending prevents another API submission', async () => {
  const { api, options, orders } = runtime();
  api.status = async () => ({ order: null });
  const signing = Promise.withResolvers<VersionedTransaction>();
  let signed: VersionedTransaction | undefined;
  options.signTransaction = async value => {
    value.sign([payer]);
    signed = value;
    return signing.promise;
  };
  let submissions = 0;
  const submit = api.submit;
  api.submit = async (...args) => { submissions += 1; return submit(...args); };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'signing'));
  assert.ok(signed);
  const recovered = { ...orders.get('order-1')!, status: 'submitted' as const, confirmedSlot: 100,
    signature: bs58.encode(signed.signatures[0]) };
  await act(async () => { await upsertPreorderRecovery(recovered); });
  await act(async () => { signing.resolve(signed!); await purchase; });
  assert.equal(submissions, 0);
  assert.equal(result.current.order?.status, 'submitted');
  assert.equal(result.current.order?.confirmedSlot, 100);
  assert.equal(result.current.pending, null);
  assert.equal(result.current.busy, false);
});

test('confirmed purchases show success and artwork immediately and allow the next purchase', async () => {
  const { api, options, succeeded } = runtime();
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(result.current.order?.status, 'submitted');
  assert.equal(result.current.order?.confirmedSlot, 100);
  assert.equal(result.current.pending, null);
  assert.equal(result.current.pendingOrder, false);
  assert.equal(result.current.busy, false);
  assert.equal(result.current.availability?.items.find(item => item.id === 1)?.status, 'preordered');
  assert.equal(succeeded.length, 1);
  await act(async () => { await result.current.purchase([2]); });
  assert.equal(succeeded.length, 2);
  assert.equal(result.current.order?.orderId, 'order-2');
  assert.deepEqual(listPreorderRecoveries(buyer).map(record => record.order.orderId), ['order-1', 'order-2']);
  assert.equal(window.localStorage.getItem(`mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`), null);
});

test('confirmation waits for its queued durable write before releasing checkout', async () => {
  const { api, options, succeeded } = runtime();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const key = `mons:preorder-recovery-mutation:mons:preorder-recovery:v3:${config.cluster}:${config.collection}:${buyer}:order-1`;
  const holder = navigator.locks.request(key, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let completed = false;
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]).then(() => { completed = true; }); });
  await waitFor(() => assert.equal(result.current.phase, 'submitting'));
  assert.equal(completed, false);
  assert.equal(result.current.pending?.submittedAttempt, true);
  assert.equal(succeeded.length, 0);
  assert.equal(listPreorderRecoveries(buyer).length, 0);
  await act(async () => { release.resolve(); await holder; await purchase; });
  assert.equal(result.current.pending, null);
  assert.equal(result.current.busy, false);
  assert.equal(succeeded.length, 1);
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'submitted');
});

test('a confirmation write queued across a wallet change cannot complete the new wallet checkout', async () => {
  const { api, options, succeeded } = runtime();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const key = `mons:preorder-recovery-mutation:mons:preorder-recovery:v3:${config.cluster}:${config.collection}:${buyer}:order-1`;
  const holder = navigator.locks.request(key, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const { result, rerender } = renderHook(owner => usePreorderCheckout({ ...options, buyer: owner, authenticatedBuyer: owner }, api), { initialProps: buyer });
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'submitting'));
  const otherBuyer = Keypair.generate().publicKey.toBase58();
  rerender(otherBuyer);
  await act(async () => { release.resolve(); await holder; await purchase; });
  assert.equal(result.current.buyer, otherBuyer);
  assert.equal(result.current.order, null);
  assert.equal(result.current.pending, null);
  assert.equal(result.current.busy, false);
  assert.equal(succeeded.length, 0);
  assert.equal(listPreorderRecoveries(otherBuyer).length, 0);
});

test('an unknown live submission announces recovered confirmation once without waiting for finalization', async () => {
  const { api, options, orders, succeeded } = runtime();
  const submit = api.submit;
  api.submit = async (...args) => { await submit(...args); throw new Error('Response lost'); };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(result.current.pending?.submittedAttempt, true);
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(result.current.pending, null));
  assert.equal(succeeded.length, 1);
  const confirmed = orders.get('order-1')!;
  await act(async () => { await upsertPreorderRecovery({ ...confirmed, status: 'succeeded' }); });
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(succeeded.length, 1);
});

test('reload restores confirmed artwork and quietly finalizes without replaying success', async () => {
  const { api, options, orders, succeeded, settled } = runtime();
  const confirmed = fixture(1);
  await upsertPreorderRecovery(confirmed);
  orders.set(confirmed.orderId, { ...confirmed, status: 'succeeded' });
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(settled.length, 1));
  assert.equal(result.current.pending, null);
  assert.equal(succeeded.length, 0);
  assert.equal(result.current.availability?.items[0].status, 'preordered');
  const asset = confirmed.assets[0].address;
  await act(async () => { await resolvePreorderInventoryAssets(buyer, [asset]); });
  assert.deepEqual(listPreorderRecoveries(buyer)[0].resolvedAssetIds, [asset]);
  await act(async () => { await upsertPreorderRecovery(confirmed); });
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'succeeded');
  assert.deepEqual(listPreorderRecoveries(buyer)[0].resolvedAssetIds, [asset]);
});

test('cross-tab rollback invalidates only affected artwork through delayed and failed availability refreshes', async () => {
  const { api, options, settled } = runtime();
  const confirmed = fixture(1);
  await upsertPreorderRecovery(confirmed);
  const availability = { preorderId: config.preorderId, ethereumAddress: session.address, ownershipStatus: 'success' as const,
    requiresAdminSignIn: false, items: [{ id: 1, status: 'preordered' as const }, { id: 2, status: 'available' as const }, { id: 3, status: 'preordered' as const }] };
  const stale = Promise.withResolvers<typeof availability>();
  const refreshed = Promise.withResolvers<typeof availability>();
  let availabilityCalls = 0;
  api.availability = async () => ++availabilityCalls === 1 ? availability : availabilityCalls === 2 ? stale.promise : refreshed.promise;
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let staleRefresh!: Promise<void>;
  act(() => { staleRefresh = result.current.refreshAvailability(); });
  const key = `mons:preorder-recovery:v3:${config.cluster}:${config.collection}:${buyer}:${encodeURIComponent(confirmed.orderId)}`;
  await act(async () => {
    const saved = JSON.parse(window.localStorage.getItem(key)!);
    saved.order.status = 'failed';
    window.localStorage.setItem(key, JSON.stringify(saved));
    window.dispatchEvent(new dom.window.StorageEvent('storage', { key }));
  });
  assert.equal(availabilityCalls, 3);
  assert.equal(settled.length, 0);
  assert.deepEqual(result.current.availability?.items.map(item => item.status), ['reserved', 'available', 'preordered']);
  await act(async () => { stale.resolve(availability); await staleRefresh; });
  assert.equal(result.current.availability?.items[0].status, 'reserved');
  await act(async () => { refreshed.reject(new Error('Availability unavailable')); });
  assert.equal(result.current.availabilityError, 'Couldn’t check card availability. Try again.');
  assert.deepEqual(result.current.availability?.items.map(item => item.status), ['reserved', 'available', 'preordered']);
  api.availability = async () => ({ ...availability, items: [{ id: 1, status: 'reserved' }, ...availability.items.slice(1)] });
  await act(async () => { await result.current.refreshAvailability(); });
  assert.equal(result.current.availability?.items[0].status, 'reserved');
  api.availability = async () => ({ ...availability, items: [{ id: 1, status: 'available' }, ...availability.items.slice(1)] });
  await act(async () => { await result.current.refreshAvailability(); });
  assert.equal(result.current.availability?.items[0].status, 'available');
});

test('rollback invalidation is scoped and does not repeat on unrelated recovery updates', async () => {
  const { api, options } = runtime();
  const availability = api.availability;
  let availabilityCalls = 0;
  api.availability = async (...args) => { availabilityCalls += 1; return availability(...args); };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  await act(async () => {
    await upsertPreorderRecovery({ ...fixture(1, 'failed'), ethereumAddress: '0x0000000000000000000000000000000000000002' });
    await upsertPreorderRecovery({ ...fixture(2, 'failed'), preorderId: 'mi_note_cards' });
    await upsertPreorderRecovery({ ...fixture(3, 'failed'), buyer: Keypair.generate().publicKey.toBase58() });
  });
  assert.equal(availabilityCalls, 1);
  const failed = fixture(4, 'expired');
  await act(async () => { await upsertPreorderRecovery(failed); });
  assert.equal(availabilityCalls, 2);
  await act(async () => {
    await acknowledgePreorderFailure(buyer, config.preorderId, failed.orderId);
    await upsertPreorderRecovery({ ...fixture(5, 'failed'), ethereumAddress: '0x0000000000000000000000000000000000000002' });
  });
  assert.equal(availabilityCalls, 2);
});

test('rollback does not expose stale available status underneath a confirmed overlay', async () => {
  const { api, options } = runtime();
  const confirmed = fixture(1);
  await upsertPreorderRecovery(confirmed);
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.equal(result.current.availability?.items[0].status, 'preordered');
  const refreshed = Promise.withResolvers<Awaited<ReturnType<typeof api.availability>>>();
  api.availability = async () => refreshed.promise;
  await act(async () => { await upsertPreorderRecovery({ ...confirmed, status: 'failed' }); });
  assert.equal(result.current.availability?.items[0].status, 'reserved');
  await act(async () => { refreshed.resolve({ ...result.current.availability!, items: [{ id: 1, status: 'available' }] }); });
  assert.equal(result.current.availability?.items[0].status, 'available');
});

test('rollback of an older order preserves a newer confirmed order for the same card', async () => {
  const { api, options } = runtime();
  const older = fixture(1);
  const newer = { ...fixture(1), orderId: 'newer-order' };
  await upsertPreorderRecovery(older);
  await upsertPreorderRecovery(newer);
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  await act(async () => { await upsertPreorderRecovery({ ...older, status: 'failed' }); });
  assert.equal(result.current.availability?.items[0].status, 'preordered');
});

test('paginated discovery restores multiple orders without local storage and repeats on focus', async () => {
  const { api, options, orders, succeeded } = runtime();
  const first = fixture(1);
  const second = fixture(2);
  orders.set(first.orderId, first);
  orders.set(second.orderId, second);
  const cursors: (string | undefined)[] = [];
  api.recoveries = async (_id, cursor) => {
    cursors.push(cursor);
    return { order: null, recoveries: cursor ? [second] : [first], nextRecoveryCursor: cursor ? null : 'page-2' };
  };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(listPreorderRecoveries(buyer).length, 2));
  assert.equal(cursors.filter(cursor => cursor === 'page-2').length, 1);
  const initialRequests = cursors.length;
  assert.equal(result.current.pending, null);
  assert.equal(succeeded.length, 0);
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(cursors.length, initialRequests + 2));
});

test('a hidden older failure cannot replace or unlock a newer signing operation', async () => {
  const { api, options, orders, succeeded } = runtime();
  const first = fixture(1);
  await upsertPreorderRecovery(first);
  let finishFirst!: (value: { order: PreorderOrder }) => void;
  api.status = async (_id, id) => id === first.orderId ? new Promise(resolve => { finishFirst = resolve; }) : { order: id ? orders.get(id) ?? null : null };
  let finishSigning!: (tx: VersionedTransaction) => void;
  options.signTransaction = async tx => new Promise(resolve => { tx.sign([payer]); finishSigning = () => resolve(tx); });
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([2]); });
  await waitFor(() => assert.equal(result.current.phase, 'signing'));
  await act(async () => { finishFirst({ order: { ...first, status: 'failed', confirmedSlot: undefined } }); });
  assert.equal(result.current.order?.orderId, 'order-2');
  assert.equal(result.current.phase, 'signing');
  assert.equal(result.current.pending?.orderId, 'order-2');
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'failed');
  assert.equal(listPreorderRecoveries(buyer)[0].failureNotified, false);
  await act(async () => { await acknowledgePreorderFailure(buyer, config.preorderId, first.orderId); });
  assert.equal(listPreorderRecoveries(buyer)[0].failureNotified, true);
  await act(async () => { finishSigning(transaction); await purchase; });
  assert.equal(succeeded.length, 1);
  assert.equal(succeeded[0].orderId, 'order-2');
});

test('discovery arriving after a buyer switch cannot populate the new wallet recovery', async () => {
  const { api, options } = runtime();
  const first = fixture(1);
  let finish!: (page: PreorderRecoveryResponse) => void;
  let calls = 0;
  api.recoveries = async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : { order: null, recoveries: [], nextRecoveryCursor: null };
  const { rerender } = renderHook(owner => usePreorderCheckout({ ...options, buyer: owner, authenticatedBuyer: owner }, api), { initialProps: buyer });
  await waitFor(() => assert.ok(calls >= 1));
  rerender(Keypair.generate().publicKey.toBase58());
  await act(async () => { finish({ order: null, recoveries: [first], nextRecoveryCursor: null }); });
  assert.equal(listPreorderRecoveries().length, 0);
});

test('temporary missing and failed RPC checks keep confirmed cards and inventory recovery intact', async () => {
  const { api, options, succeeded } = runtime();
  const confirmed = fixture(1);
  await upsertPreorderRecovery(confirmed);
  api.status = async (_id, id) => { if (id) throw new Error('RPC temporarily unavailable'); return { order: null }; };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.equal(listPreorderRecoveries(buyer)[0].order.status, 'submitted');
  assert.equal(result.current.availability?.items[0].status, 'preordered');
  assert.equal(result.current.error, null);
  assert.equal(succeeded.length, 0);
});

test('storage-free foreground recovery finds the active preparation ahead of an older confirmed order', async () => {
  const { api, options, orders } = runtime();
  const first = fixture(1);
  const second = fixture(2, 'prepared');
  orders.set(first.orderId, first);
  orders.set(second.orderId, second);
  api.status = async (_id, id) => ({ order: id ? orders.get(id) ?? null : first });
  api.recoveries = async () => ({ order: second, recoveries: [first], nextRecoveryCursor: null });
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.equal(result.current.order?.orderId, second.orderId);
  assert.equal(result.current.pending?.orderId, second.orderId);
  assert.equal(result.current.pendingOrder, true);
  assert.equal(listPreorderRecoveries(buyer)[0].order.orderId, first.orderId);
  await act(async () => { await result.current.cancel(); });
  assert.equal(result.current.order?.status, 'cancelled');
  assert.equal(result.current.pending, null);
});

test('background finalization leaves the already displayed completion unchanged for a new selection', async () => {
  const { api, options, settled } = runtime();
  let finish!: (value: { order: PreorderOrder }) => void;
  api.status = async (_id, id) => id ? new Promise(resolve => { finish = resolve; }) : { order: null };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  await act(async () => { await result.current.purchase([1]); });
  const displayed = result.current.order!;
  await act(async () => { finish({ order: { ...displayed, status: 'succeeded' } }); });
  assert.equal(settled.length, 1);
  assert.equal(result.current.order, displayed);
  assert.equal(result.current.pending, null);
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
    usePreorderCheckout({ ...options, buyer: owner, authenticatedBuyer: owner, active: false }, api);
    usePreorderCheckout({ ...options, buyer: owner, authenticatedBuyer: owner, config: mainnet, active: false, ethereumSession: null }, api);
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
    const { api, options, succeeded, settled, orders } = runtime();
    const confirmed = fixture(1);
    await upsertPreorderRecovery(confirmed);
    orders.set(confirmed.orderId, { ...confirmed, status });
    let prepares = 0;
    let signatures = 0;
    const prepare = api.prepare;
    api.prepare = async (...args) => { prepares++; return prepare(...args); };
    const { result } = renderHook(() => usePreorderCheckout({ ...options, buyer: undefined, signedIn: false,
      signTransaction: async tx => { signatures++; return tx; },
    }, api));
    await waitFor(() => assert.equal(listPreorderRecoveries(buyer)[0].order.status, status));
    assert.equal(settled.length, 1);
    assert.equal(succeeded.length, 0);
    assert.equal(listPreorderRecoveries(buyer)[0].failureNotified, false);
    assert.equal(result.current.order, null);
    assert.equal(result.current.pending, null);
    await act(async () => { await result.current.purchase([2]); });
    assert.equal(prepares, 0);
    assert.equal(signatures, 0);
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
  const { rerender } = renderHook((connectedBuyer: string | undefined) => usePreorderCheckout({
    ...options, buyer: connectedBuyer, signedIn: false, active: false,
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
  const view = renderHook(() => usePreorderCheckout(options, api));
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
