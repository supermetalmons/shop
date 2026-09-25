import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getPreorderConfig, PREORDER_CARD_COUNT, type PreorderOrder } from '../shared/preorders.ts';
import type { createPreorderApi } from '../src/lib/preorderApi.ts';
import { ProfileApiError } from '../src/api/transport.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { usePreorderCheckout } = await import('../src/hooks/usePreorderCheckout.ts');
const config = getPreorderConfig('mi_note_cards_devnet')!;
const payer = Keypair.generate();
const buyer = payer.publicKey.toBase58();
const transaction = new VersionedTransaction(new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: Keypair.generate().publicKey.toBase58(),
  instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
}).compileToV0Message());
const transactionBase64 = Buffer.from(transaction.serialize()).toString('base64');
type PreorderApi = ReturnType<typeof createPreorderApi>;

afterEach(() => { cleanup(); window.localStorage.clear(); });
after(() => dom.window.close());

function order(status: PreorderOrder['status'] = 'prepared'): PreorderOrder {
  return {
    orderId: 'order-1', preorderId: config.preorderId, buyer, cardIds: [1],
    assets: [{ id: 1, address: Keypair.generate().publicKey.toBase58() }],
    status, expiresAtMs: Date.now() + 120_000, signature: null,
  };
}

function runtime() {
  const calls = { prepare: [] as Parameters<PreorderApi['prepare']>[0][], submit: [] as Parameters<PreorderApi['submit']>[0][], cancel: [] as string[], succeeded: [] as PreorderOrder[], signed: 0 };
  const api: PreorderApi = {
    availability: async () => ({ preorderId: config.preorderId, items: Array.from({ length: PREORDER_CARD_COUNT }, (_, i) => ({ id: i + 1, status: 'available' as const })) }),
    prepare: async (input) => { calls.prepare.push(input); return { order: order(), transactionBase64 }; },
    submit: async (input) => { calls.submit.push(input); return { order: order('submitted') }; },
    cancel: async (input) => { calls.cancel.push(input.orderId); return { order: order('cancelled') }; },
    status: async () => ({ order: null }),
  };
  const options = {
    config, active: true, buyer, signedIn: true,
    ensureSignedIn: async () => true,
    signTransaction: async (tx: VersionedTransaction) => { calls.signed += 1; tx.sign([payer]); return tx; },
    onSucceeded: (value: PreorderOrder) => { calls.succeeded.push(value); },
  };
  return { api, options, calls };
}

test('selection alone does not reserve; purchase signs once and submits exclusively through API', async () => {
  const { api, options, calls } = runtime();
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.equal(calls.prepare.length, 0);
  await act(async () => { await result.current.purchase([1]); });
  assert.deepEqual(calls.prepare[0].cardIds, [1]);
  assert.equal(calls.signed, 1);
  assert.equal(calls.submit.length, 1);
  assert.equal(result.current.order?.status, 'submitted');
  assert.equal(result.current.pending?.submittedAttempt, true);
  assert.ok(!window.localStorage.getItem(window.localStorage.key(0)!)?.includes(transactionBase64));
  const final = order('succeeded');
  api.status = async () => ({ order: final });
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(result.current.order?.status, 'succeeded'));
  assert.equal(calls.succeeded.length, 1);
  assert.equal(result.current.pending, null);
  assert.equal(window.localStorage.length, 0);
});

test('wallet rejection cancels the preparation and never submits', async () => {
  const { api, options, calls } = runtime();
  options.signTransaction = async () => { throw new Error('User rejected request.'); };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await act(async () => { await result.current.purchase([1]); });
  assert.deepEqual(calls.cancel, ['order-1']);
  assert.equal(calls.submit.length, 0);
  assert.equal(result.current.order?.status, 'cancelled');
  assert.equal(result.current.pending, null);
});

test('unknown preparation response retries with original request ID and selection', async () => {
  const { api, options, calls } = runtime();
  const prepare = api.prepare;
  let fail = true;
  api.prepare = async (input) => {
    if (fail) { calls.prepare.push(input); fail = false; throw new Error('Timeout'); }
    return prepare(input);
  };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await act(async () => { await result.current.purchase([1]); });
  assert.ok(result.current.pending?.requestId);
  await act(async () => { await result.current.purchase([2]); });
  assert.equal(calls.prepare[0].requestId, calls.prepare[1].requestId);
  assert.deepEqual(calls.prepare[1].cardIds, [1]);
  assert.equal(calls.submit.length, 1);
});

test('unknown submission stays blocked and recovers on reload without signing again', async () => {
  const { api, options, calls } = runtime();
  api.submit = async (input) => { calls.submit.push(input); throw new Error('Timeout'); };
  const view = renderHook(() => usePreorderCheckout(options, api));
  await act(async () => { await view.result.current.purchase([1]); });
  await act(async () => { await view.result.current.purchase([1]); });
  assert.equal(calls.signed, 1);
  assert.match(view.result.current.error!, /may have been submitted/);
  view.unmount();
  api.status = async () => ({ order: order('succeeded') });
  const recovered = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(recovered.result.current.order?.status, 'succeeded'));
  assert.equal(calls.signed, 1);
  assert.equal(calls.succeeded.length, 1);
});

test('switching buyer during wallet prompt prevents submission of the old transaction', async () => {
  const { api, options, calls } = runtime();
  let finishSigning!: (value: VersionedTransaction) => void;
  options.signTransaction = async () => new Promise((resolve) => { finishSigning = resolve; });
  const { result, rerender } = renderHook((buyerValue) => usePreorderCheckout({ ...options, buyer: buyerValue }, api), { initialProps: buyer });
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'signing'));
  rerender(Keypair.generate().publicKey.toBase58());
  await act(async () => { finishSigning(transaction); await purchase; });
  assert.equal(calls.submit.length, 0);
});

test('mainnet and unsupported signing wallets cannot prepare purchases', async () => {
  const { api, options, calls } = runtime();
  const mainnet = renderHook(() => usePreorderCheckout({ ...options, config: getPreorderConfig('mi_note_cards')! }, api));
  await act(async () => { await mainnet.result.current.purchase([1]); });
  mainnet.unmount();
  const unsupported = renderHook(() => usePreorderCheckout({ ...options, signTransaction: undefined }, api));
  await act(async () => { await unsupported.result.current.purchase([1]); });
  assert.equal(calls.prepare.length, 0);
  assert.match(unsupported.result.current.error!, /transaction signing/);
});

test('a reservation conflict releases local pending state instead of trapping checkout', async () => {
  const { api, options } = runtime();
  api.prepare = async () => { throw new ProfileApiError({ code: 'failed-precondition', message: 'Card reserved', status: 409 }); };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(result.current.pending, null);
  assert.equal(window.localStorage.length, 0);
  assert.equal(result.current.error, 'Card reserved');
});

test('expiry while the wallet is open cancels preparation without sending signed bytes', async () => {
  const { api, options, calls } = runtime();
  const originalNow = Date.now;
  const prepared = order();
  api.prepare = async () => ({ order: prepared, transactionBase64 });
  options.signTransaction = async (tx) => { Date.now = () => prepared.expiresAtMs + 1; return tx; };
  try {
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await act(async () => { await result.current.purchase([1]); });
    assert.equal(calls.submit.length, 0);
    assert.deepEqual(calls.cancel, ['order-1']);
    assert.match(result.current.error!, /expired before signing/);
  } finally {
    Date.now = originalNow;
  }
});

test('availability pauses when hidden and refreshes on visibility restoration', async () => {
  const { api, options } = runtime();
  let calls = 0;
  const availability = api.availability;
  api.availability = async (id) => { calls += 1; return availability(id); };
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  try {
    renderHook(() => usePreorderCheckout(options, api));
    assert.equal(calls, 0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { document.dispatchEvent(new dom.window.Event('visibilitychange')); });
    assert.equal(calls, 1);
  } finally {
    delete (document as unknown as { visibilityState?: string }).visibilityState;
  }
});

test('a prepared order found after reload keeps its original IDs and can be cancelled without signing', async () => {
  const { api, options, calls } = runtime();
  const prepared = order();
  api.status = async () => ({ order: prepared });
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.order?.orderId, prepared.orderId));
  assert.deepEqual(result.current.pending?.cardIds, [1]);
  assert.equal(result.current.pending?.requestId, null);
  await act(async () => { await result.current.cancel(); });
  assert.equal(calls.signed, 0);
  assert.equal(calls.prepare.length, 0);
  assert.equal(result.current.pending, null);
});

for (const terminalStatus of ['succeeded', 'failed', 'expired', 'cancelled'] as const) {
  test(`another tab's ${terminalStatus} order is reconciled by its known ID before allowing another purchase`, async () => {
    const { api, options, calls } = runtime();
    const previous = order(terminalStatus === 'cancelled' ? 'prepared' : 'submitted');
    api.status = async () => ({ order: previous });
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(result.current.pending?.orderId, previous.orderId));
    const key = window.localStorage.key(0)!;
    api.status = async (_preorderId, orderId) => {
      assert.equal(orderId, previous.orderId);
      return { order: { ...previous, status: terminalStatus } };
    };
    await act(async () => {
      window.localStorage.removeItem(key);
      window.dispatchEvent(new dom.window.StorageEvent('storage', { key, newValue: null }));
    });
    await waitFor(() => assert.equal(result.current.order?.status, terminalStatus));
    assert.equal(result.current.pending, null);
    assert.equal(window.localStorage.length, 0);
    assert.equal(calls.succeeded.length, terminalStatus === 'succeeded' ? 1 : 0);
    const next = { ...order(), orderId: 'order-2', cardIds: [2], assets: [{ id: 2, address: Keypair.generate().publicKey.toBase58() }] };
    api.prepare = async (input) => { calls.prepare.push(input); return { order: next, transactionBase64 }; };
    api.submit = async (input) => { calls.submit.push(input); return { order: { ...next, status: 'submitted' } }; };
    await act(async () => { await result.current.purchase([2]); });
    assert.deepEqual(calls.prepare[0].cardIds, [2]);
    assert.equal(result.current.order?.orderId, next.orderId);
    assert.equal(result.current.order?.status, 'submitted');
  });
}

test('a delayed status for a cancelled order cannot replace a subsequent submitted checkout', async () => {
  const { api, options } = runtime();
  const previous = order();
  api.status = async () => ({ order: previous });
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.order?.orderId, previous.orderId));
  let finishStatus!: (response: { order: PreorderOrder }) => void;
  api.status = async () => new Promise((resolve) => { finishStatus = resolve; });
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await act(async () => { await result.current.cancel(); });
  const next = { ...order(), orderId: 'order-2', cardIds: [2], assets: [{ id: 2, address: Keypair.generate().publicKey.toBase58() }] };
  api.prepare = async () => ({ order: next, transactionBase64 });
  api.submit = async () => ({ order: { ...next, status: 'submitted' } });
  await act(async () => { await result.current.purchase([2]); });
  const saved = window.localStorage.getItem(window.localStorage.key(0)!);
  await act(async () => { finishStatus({ order: previous }); });
  assert.equal(result.current.order?.orderId, next.orderId);
  assert.equal(result.current.order?.status, 'submitted');
  assert.deepEqual(result.current.pending?.cardIds, [2]);
  assert.equal(result.current.pending?.orderId, next.orderId);
  assert.equal(window.localStorage.getItem(window.localStorage.key(0)!), saved);
  api.status = async (_preorderId, orderId) => {
    assert.equal(orderId, next.orderId);
    return { order: { ...next, status: 'succeeded' } };
  };
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(result.current.order?.status, 'succeeded'));
  assert.equal(result.current.pending, null);
});

test('a conflict discovers another device’s active checkout and exposes cancellation without reloading', async () => {
  const { api, options, calls } = runtime();
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  const existing = order();
  api.prepare = async () => {
    throw new ProfileApiError({ code: 'failed-precondition', message: 'Finish or cancel your current preorder first.', status: 409 });
  };
  api.status = async () => ({ order: existing });
  await act(async () => { await result.current.purchase([2]); });
  await waitFor(() => assert.equal(result.current.order?.orderId, existing.orderId));
  assert.deepEqual(result.current.pending?.cardIds, [1]);
  assert.equal(result.current.pending?.requestId, null);
  assert.equal(result.current.recoveryReady, true);
  await act(async () => { await result.current.cancel(); });
  assert.deepEqual(calls.cancel, [existing.orderId]);
  assert.equal(calls.signed, 0);
  assert.equal(result.current.pending, null);
});

test('conflict recovery continues after a temporary status failure', async () => {
  const { api, options } = runtime();
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  api.prepare = async () => { throw new ProfileApiError({ code: 'failed-precondition', message: 'Existing preorder', status: 409 }); };
  api.status = async () => { throw new Error('Temporary connection failure'); };
  await act(async () => { await result.current.purchase([2]); });
  await waitFor(() => assert.match(result.current.error!, /keep checking/));
  assert.equal(result.current.recoveryReady, false);
  api.status = async () => ({ order: order('submitted') });
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(result.current.order?.status, 'submitted'));
  assert.equal(result.current.recoveryReady, true);
  assert.equal(result.current.pending?.orderId, 'order-1');
  assert.equal(result.current.error, null);
});

test('successful empty recovery clears a temporary error and stops polling until another checkout', async () => {
  const { api, options } = runtime();
  let statusCalls = 0;
  api.status = async () => {
    statusCalls += 1;
    if (statusCalls === 1) throw new Error('Temporary connection failure');
    return { order: null };
  };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.match(result.current.error!, /keep checking/));
  assert.equal(result.current.recoveryReady, false);
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.equal(result.current.error, null);
  assert.equal(result.current.order, null);
  assert.equal(statusCalls, 2);
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(statusCalls, 2);
});

for (const status of ['failed', 'expired'] as const) {
  test(`successful recovery preserves the ${status} order message`, async () => {
    const { api, options } = runtime();
    api.status = async () => { throw new Error('Temporary connection failure'); };
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.match(result.current.error!, /keep checking/));
    api.status = async () => ({ order: order(status) });
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    await waitFor(() => assert.equal(result.current.order?.status, status));
    assert.equal(result.current.recoveryReady, true);
    assert.equal(result.current.error, status === 'failed'
      ? 'The preorder transaction failed. Select cards to try again.'
      : 'Your preorder expired. Select cards to try again.');
  });
}

for (const action of ['prepare', 'submit', 'cancel', 'rejection cleanup'] as const) {
  test(`a delayed ${action} response preserves another tab’s newer checkout and resumes recovery`, async () => {
    const { api, options, calls } = runtime();
    const previous = order();
    const next = { ...order('submitted'), orderId: 'order-2', cardIds: [2], assets: [{ id: 2, address: Keypair.generate().publicKey.toBase58() }] };
    let finish!: (value: { order: PreorderOrder; transactionBase64: string }) => void;
    const response = new Promise<{ order: PreorderOrder; transactionBase64: string }>((resolve) => { finish = resolve; });
    let waiting = false;
    if (action === 'prepare') api.prepare = async () => { waiting = true; return response; };
    if (action === 'submit') api.submit = async () => { waiting = true; return response; };
    if (action === 'cancel' || action === 'rejection cleanup') {
      api.cancel = async () => { waiting = true; return response; };
    }
    if (action === 'cancel') api.status = async () => ({ order: previous });
    if (action === 'rejection cleanup') options.signTransaction = async () => { throw new Error('User rejected request.'); };
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    let operation!: Promise<void>;
    act(() => { operation = action === 'cancel' ? result.current.cancel() : result.current.purchase([1]); });
    await waitFor(() => assert.equal(waiting, true));
    const key = window.localStorage.key(0)!;
    const saved = JSON.stringify({ requestId: 'request-2', orderId: next.orderId, cardIds: next.cardIds, submittedAttempt: true });
    api.status = async (_id, orderId) => { assert.equal(orderId, next.orderId); return { order: next }; };
    await act(async () => {
      window.localStorage.setItem(key, saved);
      window.dispatchEvent(new dom.window.StorageEvent('storage', { key, newValue: saved }));
    });
    await act(async () => {
      finish({ order: { ...previous, status: action === 'prepare' ? 'prepared' : action === 'submit' ? 'succeeded' : 'cancelled' }, transactionBase64 });
      await operation;
    });
    assert.equal(result.current.pending?.orderId, next.orderId);
    assert.equal(window.localStorage.getItem(key), saved);
    assert.equal(result.current.phase, 'idle');
    assert.equal(result.current.error, null);
    assert.equal(calls.succeeded.length, 0);
    if (action === 'prepare') assert.equal(calls.signed, 0);
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    await waitFor(() => assert.equal(result.current.order?.orderId, next.orderId));
    assert.equal(result.current.order?.status, 'submitted');
  });
}

test('returning to an earlier wallet does not revive its old signing operation or clear a newer busy phase', async () => {
  const { api, options, calls } = runtime();
  let finishOldSigning!: (value: VersionedTransaction) => void;
  options.signTransaction = async () => new Promise((resolve) => { finishOldSigning = resolve; });
  const view = renderHook((buyerValue) => usePreorderCheckout({ ...options, buyer: buyerValue }, api), { initialProps: buyer });
  let oldPurchase!: Promise<void>;
  act(() => { oldPurchase = view.result.current.purchase([1]); });
  await waitFor(() => assert.equal(view.result.current.phase, 'signing'));
  const key = window.localStorage.key(0)!;
  const oldSaved = window.localStorage.getItem(key);
  view.rerender(Keypair.generate().publicKey.toBase58());
  assert.equal(window.localStorage.getItem(key), oldSaved);
  api.status = async () => ({ order: order() });
  view.rerender(buyer);
  await waitFor(() => assert.equal(view.result.current.order?.status, 'prepared'));
  await act(async () => { await view.result.current.cancel(); });
  const next = { ...order(), orderId: 'order-2', cardIds: [2], assets: [{ id: 2, address: Keypair.generate().publicKey.toBase58() }] };
  api.prepare = async () => ({ order: next, transactionBase64 });
  api.submit = async (input) => { calls.submit.push(input); return { order: { ...next, status: 'submitted' } }; };
  let finishNewSigning!: (value: VersionedTransaction) => void;
  options.signTransaction = async () => new Promise((resolve) => { finishNewSigning = resolve; });
  view.rerender(buyer);
  let newPurchase!: Promise<void>;
  act(() => { newPurchase = view.result.current.purchase([2]); });
  await waitFor(() => assert.equal(view.result.current.phase, 'signing'));
  const newSaved = window.localStorage.getItem(key);
  await act(async () => { finishOldSigning(transaction); await oldPurchase; });
  assert.equal(calls.submit.length, 0);
  assert.equal(view.result.current.phase, 'signing');
  assert.equal(view.result.current.order?.orderId, next.orderId);
  assert.equal(window.localStorage.getItem(key), newSaved);
  await act(async () => { finishNewSigning(transaction); await newPurchase; });
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.submit[0].orderId, next.orderId);
  assert.equal(view.result.current.phase, 'idle');
});

test('another tab restoring sign-in preserves the active request and wallet signing operation', async () => {
  const { api, options, calls } = runtime();
  const prepared = order();
  let serverOrder: PreorderOrder | null = null;
  let finishSigning!: (value: VersionedTransaction) => void;
  options.signTransaction = async () => {
    calls.signed += 1;
    return new Promise((resolve) => { finishSigning = resolve; });
  };
  api.prepare = async (input) => {
    calls.prepare.push(input);
    serverOrder = prepared;
    return { order: prepared, transactionBase64 };
  };
  api.status = async () => ({ order: serverOrder });
  const firstTab = renderHook(() => usePreorderCheckout(options, api));
  const restoredTab = renderHook((signedIn) => usePreorderCheckout({ ...options, signedIn }, api), { initialProps: false });
  await waitFor(() => assert.equal(firstTab.result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = firstTab.result.current.purchase([1]); });
  await waitFor(() => assert.equal(firstTab.result.current.phase, 'signing'));
  const key = window.localStorage.key(0)!;
  const previousValue = window.localStorage.getItem(key);
  await act(async () => { restoredTab.rerender(true); });
  await waitFor(() => assert.equal(restoredTab.result.current.order?.orderId, prepared.orderId));
  const recoveredValue = window.localStorage.getItem(key);
  if (recoveredValue !== previousValue) {
    await act(async () => {
      window.dispatchEvent(new dom.window.StorageEvent('storage', { key, oldValue: previousValue, newValue: recoveredValue }));
    });
  }
  await act(async () => { finishSigning(transaction); await purchase; });
  assert.equal(recoveredValue, previousValue);
  assert.equal(restoredTab.result.current.pending?.requestId, calls.prepare[0].requestId);
  assert.equal(calls.signed, 1);
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.submit[0].orderId, prepared.orderId);
  assert.equal(firstTab.result.current.order?.status, 'submitted');
  assert.equal(firstTab.result.current.error, null);
});

test('sign-in recovery preserves a same-order submission attempt newer than its in-memory pending state', async () => {
  const { api, options } = runtime();
  const submitted = order('submitted');
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const previous = { requestId: 'request-1', cardIds: submitted.cardIds, orderId: submitted.orderId };
  window.localStorage.setItem(key, JSON.stringify(previous));
  const view = renderHook((signedIn) => usePreorderCheckout({ ...options, signedIn }, api), { initialProps: false });
  assert.equal(view.result.current.pending?.submittedAttempt, undefined);
  const latest = { ...previous, submittedAttempt: true };
  const saved = JSON.stringify(latest);
  window.localStorage.setItem(key, saved);
  api.status = async () => ({ order: submitted });
  await act(async () => { view.rerender(true); });
  await waitFor(() => assert.equal(view.result.current.order?.status, 'submitted'));
  assert.deepEqual(view.result.current.pending, latest);
  assert.equal(window.localStorage.getItem(key), saved);
});

test('recovery preserves the current stored order when its status response is invalid', async () => {
  const { api, options } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const view = renderHook((signedIn) => usePreorderCheckout({ ...options, signedIn }, api), { initialProps: false });
  const prepared = order();
  const saved = {
    requestId: 'another-request', cardIds: prepared.cardIds, orderId: 'another-order', submittedAttempt: true,
  };
  window.localStorage.setItem(key, JSON.stringify(saved));
  api.status = async (_id, orderId) => {
    assert.equal(orderId, saved.orderId);
    throw new Error('Preorder API returned an invalid response.');
  };
  await act(async () => { view.rerender(true); });
  await waitFor(() => assert.match(view.result.current.error!, /keep checking/));
  assert.equal(view.result.current.order, null);
  assert.deepEqual(view.result.current.pending, saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
});

test('sign-in restoration follows the new checkout instead of clearing it for an older completed order', async () => {
  const { api, options, calls } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const previous = order('succeeded');
  const next = { ...order(), orderId: 'order-2', cardIds: [2], assets: [{ id: 2, address: Keypair.generate().publicKey.toBase58() }] };
  const restoredStatusIds: (string | undefined)[] = [];
  const restoredApi: PreorderApi = {
    ...api,
    status: async (_id, orderId) => {
      restoredStatusIds.push(orderId);
      return { order: orderId === previous.orderId ? previous : next };
    },
  };
  window.localStorage.setItem(key, JSON.stringify({ requestId: 'request-1', cardIds: previous.cardIds, orderId: previous.orderId, submittedAttempt: true }));
  const restoredTab = renderHook((signedIn) => usePreorderCheckout({ ...options, signedIn }, restoredApi), { initialProps: false });
  window.localStorage.removeItem(key);
  let finishSigning!: (value: VersionedTransaction) => void;
  options.signTransaction = async () => {
    calls.signed += 1;
    return new Promise((resolve) => { finishSigning = resolve; });
  };
  api.prepare = async (input) => { calls.prepare.push(input); return { order: next, transactionBase64 }; };
  api.submit = async (input) => { calls.submit.push(input); return { order: { ...next, status: 'submitted' } }; };
  const firstTab = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(firstTab.result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = firstTab.result.current.purchase(next.cardIds); });
  await waitFor(() => assert.equal(firstTab.result.current.phase, 'signing'));
  const saved = window.localStorage.getItem(key);
  await act(async () => { restoredTab.rerender(true); });
  await waitFor(() => assert.equal(restoredTab.result.current.recoveryReady, true));
  const restored = window.localStorage.getItem(key);
  if (restored !== saved) {
    await act(async () => {
      window.dispatchEvent(new dom.window.StorageEvent('storage', { key, oldValue: saved, newValue: restored }));
    });
  }
  await act(async () => { finishSigning(transaction); await purchase; });
  assert.deepEqual(restoredStatusIds, [next.orderId]);
  assert.equal(restored, saved);
  assert.equal(restoredTab.result.current.order?.orderId, next.orderId);
  assert.equal(calls.succeeded.length, 0);
  assert.equal(calls.signed, 1);
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.submit[0].orderId, next.orderId);
  assert.equal(firstTab.result.current.order?.status, 'submitted');
});

for (const knownOrderId of [true, false]) {
  test(`a delayed terminal status preserves a newer same-card request ${knownOrderId ? 'with' : 'without'} a saved order ID before its storage event arrives`, async () => {
    const { api, options, calls } = runtime();
    const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
    const previous = order('succeeded');
    const next = { ...order(), orderId: 'order-2' };
    window.localStorage.setItem(key, JSON.stringify({ requestId: 'request-1', cardIds: previous.cardIds, orderId: previous.orderId, submittedAttempt: true }));
    let finishStatus!: (value: { order: PreorderOrder }) => void;
    let waiting = false;
    api.status = async (_id, orderId) => {
      if (orderId === previous.orderId) {
        waiting = true;
        return new Promise((resolve) => { finishStatus = resolve; });
      }
      assert.equal(orderId, knownOrderId ? next.orderId : undefined);
      return { order: next };
    };
    const view = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(waiting, true));
    const saved = { requestId: 'request-2', cardIds: next.cardIds, ...(knownOrderId ? { orderId: next.orderId } : {}) };
    window.localStorage.setItem(key, JSON.stringify(saved));
    await act(async () => { finishStatus({ order: previous }); });
    const recovered = JSON.parse(window.localStorage.getItem(key)!);
    assert.equal(recovered.requestId, saved.requestId);
    assert.deepEqual(recovered.cardIds, saved.cardIds);
    assert.equal(recovered.submittedAttempt, undefined);
    assert.ok(recovered.orderId === undefined || recovered.orderId === next.orderId);
    assert.equal(calls.succeeded.length, 0);
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    await waitFor(() => assert.equal(view.result.current.order?.orderId, next.orderId));
    assert.equal(view.result.current.pending?.requestId, saved.requestId);
    assert.equal(view.result.current.pending?.submittedAttempt, undefined);
    assert.equal(view.result.current.pending?.orderId, next.orderId);
    assert.equal(JSON.parse(window.localStorage.getItem(key)!).requestId, saved.requestId);
  });
}

test('an idempotent preparation completing the same request clears pending storage without a saved order ID', async () => {
  const { api, options, calls } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const completed = order('succeeded');
  window.localStorage.setItem(key, JSON.stringify({ requestId: 'request-1', cardIds: completed.cardIds }));
  api.prepare = async (input) => {
    calls.prepare.push(input);
    return { order: completed, transactionBase64: null };
  };
  const view = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(view.result.current.recoveryReady, true));
  await act(async () => { await view.result.current.purchase([2]); });
  assert.equal(calls.prepare[0].requestId, 'request-1');
  assert.deepEqual(calls.prepare[0].cardIds, completed.cardIds);
  assert.equal(view.result.current.order?.status, 'succeeded');
  assert.equal(view.result.current.pending, null);
  assert.equal(window.localStorage.getItem(key), null);
  assert.equal(calls.succeeded.length, 1);
  assert.equal(calls.signed, 0);
  assert.equal(calls.submit.length, 0);
});

test('a delayed preparation conflict preserves another tab’s newer checkout before its storage event arrives', async () => {
  const { api, options, calls } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const next = { ...order(), orderId: 'order-2', cardIds: [2], assets: [{ id: 2, address: Keypair.generate().publicKey.toBase58() }] };
  let failPreparation!: (error: Error) => void;
  api.prepare = async () => new Promise((_resolve, reject) => { failPreparation = reject; });
  const view = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(view.result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = view.result.current.purchase([1]); });
  await waitFor(() => assert.equal(view.result.current.phase, 'preparing'));
  const saved = { requestId: 'request-2', cardIds: next.cardIds, orderId: next.orderId };
  window.localStorage.setItem(key, JSON.stringify(saved));
  api.status = async (_id, orderId) => {
    assert.equal(orderId, next.orderId);
    return { order: next };
  };
  await act(async () => {
    failPreparation(new ProfileApiError({ code: 'failed-precondition', message: 'Finish or cancel your current preorder first.', status: 409 }));
    await purchase;
  });
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(view.result.current.order?.orderId, next.orderId));
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
  assert.deepEqual(view.result.current.pending, saved);
  assert.equal(view.result.current.phase, 'idle');
  assert.equal(view.result.current.error, null);
  assert.equal(calls.cancel.length, 0);
  assert.equal(calls.signed, 0);
  assert.equal(calls.submit.length, 0);
});

test('an unknown request conflicting with an active order recovers without recursively polling or losing its retry identity', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { api, options, calls } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const saved = { requestId: 'request-2', cardIds: [2] };
  window.localStorage.setItem(key, JSON.stringify(saved));
  const existing = order();
  let statusCalls = 0;
  api.status = async () => {
    statusCalls += 1;
    if (statusCalls > 5) return new Promise(() => {});
    return { order: existing };
  };
  const view = renderHook(() => usePreorderCheckout(options, api));
  await act(async () => {});
  assert.equal(statusCalls, 1);
  assert.equal(view.result.current.recoveryReady, true);
  assert.equal(view.result.current.order, null);
  assert.deepEqual(view.result.current.pending, saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
  assert.match(view.result.current.error!, /continue/i);
  await act(async () => { t.mock.timers.tick(3_000); });
  assert.equal(statusCalls, 2);
  assert.equal(view.result.current.recoveryReady, true);
  assert.deepEqual(view.result.current.pending, saved);
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(statusCalls, 3);
  assert.equal(view.result.current.recoveryReady, true);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);

  api.prepare = async (input) => {
    calls.prepare.push(input);
    throw new ProfileApiError({ code: 'failed-precondition', message: 'Finish or cancel your current preorder first.', status: 409 });
  };
  await act(async () => { await view.result.current.purchase([3]); });
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.prepare[0].requestId, saved.requestId);
  assert.deepEqual(calls.prepare[0].cardIds, saved.cardIds);
  assert.equal(view.result.current.order?.orderId, existing.orderId);
  assert.equal(view.result.current.order?.status, 'prepared');
  assert.deepEqual(view.result.current.pending?.cardIds, existing.cardIds);
  assert.equal(view.result.current.pending?.requestId, null);
  assert.equal(view.result.current.recoveryReady, true);
  await act(async () => { await view.result.current.cancel(); });
  assert.deepEqual(calls.cancel, [existing.orderId]);
  assert.equal(view.result.current.pending, null);
  assert.equal(window.localStorage.getItem(key), null);
  assert.equal(calls.signed, 0);
  assert.equal(calls.submit.length, 0);
});

for (const resolution of ['empty', 'matching'] as const) {
  test(`successful ${resolution} recovery clears a resolved conflict without losing its request identity`, async () => {
    const { api, options, calls } = runtime();
    const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
    const saved = { requestId: 'request-2', cardIds: [2] };
    window.localStorage.setItem(key, JSON.stringify(saved));
    const existing = order();
    api.status = async () => ({ order: existing });
    const view = renderHook(() => usePreorderCheckout(options, api));
    const conflict = 'Another preorder is active. Continue to resolve it.';
    await waitFor(() => assert.equal(view.result.current.error, conflict));
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    assert.equal(view.result.current.error, conflict);
    assert.equal(view.result.current.order, null);
    assert.deepEqual(view.result.current.pending, saved);

    const recovered = resolution === 'empty' ? null : {
      ...order(), orderId: 'order-2', cardIds: saved.cardIds,
      assets: [{ id: 2, address: Keypair.generate().publicKey.toBase58() }],
    };
    api.status = async () => ({ order: recovered });
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    assert.equal(view.result.current.error, null);
    assert.equal(view.result.current.recoveryReady, true);
    assert.deepEqual(view.result.current.order, recovered);
    const expectedPending = { ...saved, ...(recovered ? { orderId: recovered.orderId } : {}) };
    assert.deepEqual(view.result.current.pending, expectedPending);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), expectedPending);
    assert.equal(calls.prepare.length, 0);
    assert.equal(calls.signed, 0);
    assert.equal(calls.submit.length, 0);
    assert.equal(calls.cancel.length, 0);
  });
}

test('anonymous mainnet loads public availability without recovering or purchasing', async () => {
  const { api, options, calls } = runtime();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  const requested: string[] = [];
  api.availability = async (preorderId) => {
    requested.push(preorderId);
    return { preorderId, items: [{ id: 1, status: 'preordered' }] };
  };
  api.status = async () => { throw new Error('Mainnet must not recover checkout'); };
  const { result } = renderHook(() => usePreorderCheckout({ ...options, config: mainnet, buyer: undefined, signedIn: false }, api));
  await waitFor(() => assert.equal(result.current.availability?.preorderId, mainnet.preorderId));
  assert.deepEqual(requested, [mainnet.preorderId]);
  await act(async () => { await result.current.purchase([1]); await result.current.cancel(); });
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.cancel.length, 0);
  assert.equal(result.current.pending, null);
  assert.equal(result.current.error, null);
});

test('collection changes hide old availability and errors and discard late responses', async () => {
  const { api, options } = runtime();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  type Availability = Awaited<ReturnType<typeof api.availability>>;
  const requests: { preorderId: string; resolve: (value: Availability) => void; reject: (error: Error) => void }[] = [];
  api.availability = (preorderId) => new Promise((resolve, reject) => { requests.push({ preorderId, resolve, reject }); });
  const observed: { preorderId: string; data: Availability | null; error: string | null }[] = [];
  const { result, rerender } = renderHook((nextConfig) => {
    const value = usePreorderCheckout({ ...options, config: nextConfig, buyer: undefined, signedIn: false }, api);
    observed.push({ preorderId: nextConfig.preorderId, data: value.availability, error: value.availabilityError });
    return value;
  }, { initialProps: config });
  const reply = (index: number): Availability => ({ preorderId: requests[index].preorderId, items: [{ id: 1, status: 'preordered' }] });
  await act(async () => { requests[0].resolve(reply(0)); });
  assert.equal(result.current.availability?.preorderId, config.preorderId);
  rerender(mainnet);
  assert.equal(result.current.availability, null);
  await act(async () => { requests[1].reject(new Error('Offline')); });
  assert.ok(result.current.availabilityError);
  rerender(config);
  assert.equal(result.current.availability, null);
  assert.equal(result.current.availabilityError, null);
  rerender(mainnet);
  await act(async () => { requests[2].resolve(reply(2)); });
  assert.equal(result.current.availability, null);
  await act(async () => { requests[3].resolve(reply(3)); });
  assert.equal(result.current.availability?.preorderId, mainnet.preorderId);
  assert.ok(observed.every((value) => !value.data || value.data.preorderId === value.preorderId));
  assert.equal(observed.find((value) => value.preorderId === mainnet.preorderId)?.error, null);
});

test('switching collections during signing clears checkout presentation and ignores the old result', async () => {
  const { api, options, calls } = runtime();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  api.availability = async (preorderId) => ({ preorderId, items: [{ id: 1, status: 'available' }] });
  let finishSigning!: (value: VersionedTransaction) => void;
  options.signTransaction = () => new Promise((resolve) => { finishSigning = resolve; });
  const { result, rerender } = renderHook((nextConfig) => usePreorderCheckout({ ...options, config: nextConfig }, api), { initialProps: config });
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'signing'));
  rerender(mainnet);
  assert.equal(result.current.order, null);
  assert.equal(result.current.pending, null);
  assert.equal(result.current.error, null);
  assert.equal(result.current.busy, false);
  assert.equal(result.current.phase, 'idle');
  await act(async () => { finishSigning(transaction); await purchase; });
  assert.equal(calls.submit.length, 0);
  assert.equal(result.current.error, null);
});
