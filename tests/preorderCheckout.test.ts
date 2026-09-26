import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getPreorderConfig, PREORDER_CARD_COUNT, type PreorderOrder } from '../shared/preorders.ts';
import type { MiNoteEthereumSession } from '../shared/miNoteAuth.ts';
import type { createPreorderApi } from '../src/lib/preorderApi.ts';
import { ProfileApiError } from '../src/api/transport.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { usePreorderCheckout } = await import('../src/hooks/usePreorderCheckout.ts');
const config = getPreorderConfig('mi_note_cards_devnet')!;
const ethereumSession: MiNoteEthereumSession = {
  address: '0x0000000000000000000000000000000000000001', token: 'ethereum-session',
  preorderId: config.preorderId, expiresAtMs: Date.now() + 3_600_000,
};
const mainnetSession = { ...ethereumSession, preorderId: 'mi_note_cards' };
const sessionFor = (preorderId: string) => preorderId === config.preorderId ? ethereumSession : mainnetSession;
const ownership = { ethereumAddress: ethereumSession.address, ownershipStatus: 'success' as const, requiresAdminSignIn: false };
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
    orderId: 'order-1', preorderId: config.preorderId, buyer, ethereumAddress: ethereumSession.address, cardIds: [1],
    assets: [{ id: 1, address: Keypair.generate().publicKey.toBase58() }],
    status, expiresAtMs: Date.now() + 120_000, signature: null,
  };
}

function runtime() {
  const calls = { prepare: [] as Parameters<PreorderApi['prepare']>[0][], submit: [] as Parameters<PreorderApi['submit']>[0][], cancel: [] as string[], succeeded: [] as PreorderOrder[], signed: 0 };
  const api: PreorderApi = {
    availability: async () => ({ ...ownership, preorderId: config.preorderId, items: Array.from({ length: PREORDER_CARD_COUNT }, (_, i) => ({ id: i + 1, status: 'available' as const })) }),
    prepare: async (input) => { calls.prepare.push(input); return { order: order(), transactionBase64 }; },
    submit: async (input) => { calls.submit.push(input); return { order: order('submitted') }; },
    cancel: async (input) => { calls.cancel.push(input.orderId); return { order: order('cancelled') }; },
    status: async () => ({ order: null }),
  };
  const options = {
    config, active: true, buyer, signedIn: true, authenticatedBuyer: buyer, ethereumSession,
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
  api.prepare = async (input, session) => {
    if (fail) { calls.prepare.push(input); fail = false; throw new Error('Timeout'); }
    return prepare(input, session);
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
  const { result, rerender } = renderHook((buyerValue) => usePreorderCheckout({ ...options, buyer: buyerValue, authenticatedBuyer: buyerValue }, api), { initialProps: buyer });
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'signing'));
  rerender(Keypair.generate().publicKey.toBase58());
  await act(async () => { finishSigning(transaction); await purchase; });
  assert.equal(calls.submit.length, 0);
});

for (const proof of [null, { ...ethereumSession, expiresAtMs: 1 }, mainnetSession]) {
  test(`purchase requires current Ethereum verification (${proof === null ? 'missing' : proof.expiresAtMs === 1 ? 'expired' : 'wrong collection'})`, async () => {
    const { api, options, calls } = runtime();
    const { result } = renderHook(() => usePreorderCheckout({ ...options, ethereumSession: proof }, api));
    await act(async () => { await result.current.purchase([1]); });
    assert.equal(calls.prepare.length, 0);
    assert.equal(calls.signed, 0);
    assert.equal(calls.submit.length, 0);
    assert.match(result.current.error!, /Verify your Ethereum wallet/);
  });
}

test('an active order for another Ethereum wallet blocks purchasing but remains cancellable', async () => {
  const { api, options, calls } = runtime();
  const prepared = { ...order(), ethereumAddress: '0x0000000000000000000000000000000000000002' };
  api.status = async () => ({ order: prepared });
  api.cancel = async (input) => {
    calls.cancel.push(input.orderId);
    return { order: { ...prepared, status: 'cancelled' } };
  };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.order?.orderId, prepared.orderId));
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.signed, 0);
  assert.match(result.current.error!, /Switch back to the Ethereum wallet/);
  await act(async () => { await result.current.cancel(); });
  assert.deepEqual(calls.cancel, [prepared.orderId]);
  assert.equal(result.current.pending, null);
});

test('an unresolved preparation from another Ethereum wallet cannot reuse its idempotency request', async () => {
  const { api, options, calls } = runtime();
  const saved = { requestId: 'old-ethereum-request', cardIds: [1], ethereumAddress: '0x0000000000000000000000000000000000000002' };
  window.localStorage.setItem(`mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`, JSON.stringify(saved));
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(calls.prepare.length, 0);
  assert.deepEqual(result.current.pending, saved);
  assert.match(result.current.error!, /Switch back to the Ethereum wallet/);
});

test('abandoning an unresolved preparation checks status and permits a fresh request for another Ethereum wallet', async () => {
  const { api, options, calls } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const saved = { requestId: 'old-ethereum-request', cardIds: [1], ethereumAddress: '0x0000000000000000000000000000000000000002' };
  window.localStorage.setItem(key, JSON.stringify(saved));
  let statusCalls = 0;
  api.status = async () => { statusCalls += 1; return { order: null }; };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.deepEqual(result.current.pending, saved);
  const beforeAbandon = statusCalls;
  await act(async () => { await result.current.cancel(); });
  assert.ok(statusCalls > beforeAbandon);
  assert.equal(result.current.pending, null);
  assert.equal(window.localStorage.getItem(key), null);
  assert.equal(calls.cancel.length, 0);
  await act(async () => { await result.current.purchase([1]); });
  assert.notEqual(calls.prepare[0].requestId, saved.requestId);
  assert.equal(calls.submit.length, 1);
});

test('abandonment preserves unresolved preparation when its status cannot be checked', async () => {
  const { api, options } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const saved = { requestId: 'unknown-request', cardIds: [1], ethereumAddress: ethereumSession.address };
  window.localStorage.setItem(key, JSON.stringify(saved));
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  api.status = async () => { throw new Error('Offline'); };
  await act(async () => { await result.current.cancel(); });
  assert.deepEqual(result.current.pending, saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
  assert.ok(result.current.error);
});

for (const fields of [{ orderId: 'known-order' }, { submittedAttempt: true }]) {
  test(`abandonment cannot discard ${'orderId' in fields ? 'a known order' : 'a possible submission'}`, async () => {
    const { api, options, calls } = runtime();
    const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
    const saved = { requestId: 'unknown-request', cardIds: [1], ethereumAddress: ethereumSession.address, ...fields };
    window.localStorage.setItem(key, JSON.stringify(saved));
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    await act(async () => { await result.current.cancel(); });
    assert.deepEqual(result.current.pending, saved);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
    assert.equal(calls.cancel.length, 0);
  });
}

for (const status of ['prepared', 'submitted'] as const) {
  test(`abandonment adopts a discovered ${status} order with different cards and Ethereum identity`, async () => {
    const { api, options, calls } = runtime();
    const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
    window.localStorage.setItem(key, JSON.stringify({ requestId: 'unknown-request', cardIds: [1], ethereumAddress: ethereumSession.address }));
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    const existing = { ...order(status), orderId: 'other-order', cardIds: [2], ethereumAddress: '0x0000000000000000000000000000000000000002' };
    api.status = async () => ({ order: existing });
    await act(async () => { await result.current.cancel(); });
    assert.deepEqual(result.current.order, existing);
    assert.equal(result.current.pending?.requestId, null);
    assert.equal(result.current.pending?.orderId, existing.orderId);
    assert.deepEqual(result.current.pending?.cardIds, [2]);
    assert.equal(result.current.pending?.ethereumAddress, existing.ethereumAddress);
    assert.equal(calls.cancel.length, 0);
    if (status === 'prepared') {
      api.cancel = async (input) => { calls.cancel.push(input.orderId); return { order: { ...existing, status: 'cancelled' } }; };
      await act(async () => { await result.current.cancel(); });
      assert.deepEqual(calls.cancel, [existing.orderId]);
      assert.equal(result.current.pending, null);
    } else {
      await act(async () => { await result.current.cancel(); });
      assert.equal(result.current.pending?.orderId, existing.orderId);
      assert.equal(calls.cancel.length, 0);
    }
  });
}

test('delayed abandonment cannot clear another tab’s newer request before its storage event', async () => {
  const { api, options } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  window.localStorage.setItem(key, JSON.stringify({ requestId: 'unknown-request', cardIds: [1], ethereumAddress: ethereumSession.address }));
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let finishStatus!: (value: { order: null }) => void;
  api.status = async () => new Promise(resolve => { finishStatus = resolve; });
  let abandonment!: Promise<void>;
  act(() => { abandonment = result.current.cancel(); });
  await waitFor(() => assert.equal(typeof finishStatus, 'function'));
  const newer = { requestId: 'newer-request', cardIds: [2], ethereumAddress: ethereumSession.address };
  window.localStorage.setItem(key, JSON.stringify(newer));
  api.status = async () => ({ order: null });
  await act(async () => { finishStatus({ order: null }); await abandonment; });
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), newer);
  assert.deepEqual(result.current.pending, newer);
});

test('abandonment invalidates an older recovery response before starting another checkout', async () => {
  const { api, options, calls } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  window.localStorage.setItem(key, JSON.stringify({ requestId: 'unknown-request', cardIds: [1], ethereumAddress: ethereumSession.address }));
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let finishRecovery!: (value: { order: PreorderOrder }) => void;
  api.status = async () => new Promise(resolve => { finishRecovery = resolve; });
  act(() => { window.dispatchEvent(new dom.window.Event('focus')); });
  await waitFor(() => assert.equal(typeof finishRecovery, 'function'));
  api.status = async () => ({ order: null });
  await act(async () => { await result.current.cancel(); });
  assert.equal(result.current.pending, null);
  await act(async () => { finishRecovery({ order: order() }); });
  assert.equal(result.current.order, null);
  assert.equal(result.current.pending, null);
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(calls.submit.length, 1);
});

for (const change of ['buyer', 'route'] as const) {
  test(`delayed abandonment cannot clear a preparation after changing ${change}`, async () => {
    const { api, options } = runtime();
    const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
    const saved = { requestId: 'unknown-request', cardIds: [1], ethereumAddress: ethereumSession.address };
    window.localStorage.setItem(key, JSON.stringify(saved));
    const { result, rerender } = renderHook(value => usePreorderCheckout(value, api), { initialProps: options });
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    let finishStatus!: (value: { order: null }) => void;
    api.status = async () => new Promise(resolve => { finishStatus = resolve; });
    let abandonment!: Promise<void>;
    act(() => { abandonment = result.current.cancel(); });
    await waitFor(() => assert.equal(typeof finishStatus, 'function'));
    api.status = async () => ({ order: null });
    const nextBuyer = Keypair.generate().publicKey.toBase58();
    rerender(change === 'buyer' ? { ...options, buyer: nextBuyer, authenticatedBuyer: nextBuyer }
      : { ...options, config: getPreorderConfig('mi_note_cards')!, ethereumSession: mainnetSession });
    await act(async () => { finishStatus({ order: null }); await abandonment; });
    assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
    assert.equal(result.current.pending, null);
    assert.equal(result.current.order, null);
    assert.equal(result.current.error, null);
  });
}

test('a late reservation after abandonment is recovered by the next preparation conflict', async () => {
  const { api, options, calls } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  window.localStorage.setItem(key, JSON.stringify({ requestId: 'unknown-request', cardIds: [1], ethereumAddress: ethereumSession.address }));
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  await act(async () => { await result.current.cancel(); });
  assert.equal(result.current.pending, null);
  const existing = order();
  api.prepare = async () => { throw new ProfileApiError({ status: 409, code: 'failed-precondition', message: 'Another preorder is active.' }); };
  api.status = async () => ({ order: existing });
  await act(async () => { await result.current.purchase([2]); });
  await waitFor(() => assert.equal(result.current.order?.orderId, existing.orderId));
  assert.deepEqual(result.current.pending?.cardIds, [1]);
  assert.equal(calls.signed + calls.submit.length + calls.cancel.length, 0);
});

for (const ethereumAddress of [undefined, null]) {
  test(`legacy request-only recovery clears ${ethereumAddress === null ? 'null' : 'missing'} Ethereum identity only after a successful empty status`, async () => {
    const { api, options } = runtime();
    const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
    const saved = { requestId: 'legacy-request', cardIds: [1], ...(ethereumAddress === null ? { ethereumAddress } : {}) };
    window.localStorage.setItem(key, JSON.stringify(saved));
    api.status = async () => { throw new Error('Offline'); };
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.match(result.current.error!, /keep checking/));
    assert.deepEqual(result.current.pending, saved);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
    assert.equal(result.current.recoveryReady, false);

    let finishStatus!: (value: { order: null }) => void;
    api.status = async () => new Promise((resolve) => { finishStatus = resolve; });
    act(() => { window.dispatchEvent(new dom.window.Event('focus')); });
    assert.deepEqual(result.current.pending, saved);
    await act(async () => { finishStatus({ order: null }); });
    assert.equal(result.current.pending, null);
    assert.equal(window.localStorage.getItem(key), null);
    assert.equal(result.current.recoveryReady, true);
    assert.equal(result.current.error, null);
  });
}

for (const [name, fields] of [
  ['Ethereum-bound request', { ethereumAddress: ethereumSession.address }],
  ['known order', { orderId: 'saved-order' }],
  ['possible submission', { submittedAttempt: true }],
] as const) {
  test(`empty recovery preserves the ${name}`, async () => {
    const { api, options } = runtime();
    const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
    const saved = { requestId: 'saved-request', cardIds: [1], ...fields };
    window.localStorage.setItem(key, JSON.stringify(saved));
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    assert.deepEqual(result.current.pending, saved);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
  });
}

for (const status of ['prepared', 'submitted'] as const) {
  test(`legacy request-only recovery retains a real ${status} order`, async () => {
    const { api, options } = runtime();
    const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
    const saved = { requestId: 'legacy-request', cardIds: [1] };
    const existing = { ...order(status), ethereumAddress: null };
    window.localStorage.setItem(key, JSON.stringify(saved));
    api.status = async () => ({ order: existing });
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    const expected = { ...saved, orderId: existing.orderId, ethereumAddress: null };
    assert.deepEqual(result.current.order, existing);
    assert.deepEqual(result.current.pending, expected);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), expected);
  });
}

for (const status of ['prepared', 'submitted'] as const) {
  test(`legacy recovery adopts a different ${status} order without reusing its old request ID`, async () => {
    const { api, options, calls } = runtime();
    const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
    window.localStorage.setItem(key, JSON.stringify({ requestId: 'legacy-request', cardIds: [1] }));
    const existing = { ...order(status), orderId: 'other-order', cardIds: [2], ethereumAddress: null };
    api.status = async () => ({ order: existing });
    const { result } = renderHook(() => usePreorderCheckout(options, api));
    await waitFor(() => assert.equal(result.current.order?.orderId, existing.orderId));
    assert.equal(result.current.pending?.requestId, null);
    assert.deepEqual(result.current.pending?.cardIds, [2]);
    assert.equal(result.current.error, null);
    assert.equal(JSON.parse(window.localStorage.getItem(key)!).orderId, existing.orderId);
    api.status = async () => ({ order: { ...existing, status: status === 'prepared' ? 'cancelled' : 'succeeded' } });
    await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
    assert.equal(result.current.pending, null);
    assert.equal(window.localStorage.getItem(key), null);
    assert.equal(calls.prepare.length + calls.submit.length + calls.signed, 0);
  });
}

test('legacy active-order recovery cannot overwrite a newer request from another tab', async () => {
  const { api, options } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  window.localStorage.setItem(key, JSON.stringify({ requestId: 'legacy-request', cardIds: [1] }));
  let finishStatus!: (value: { order: PreorderOrder }) => void;
  api.status = async () => new Promise(resolve => { finishStatus = resolve; });
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(typeof finishStatus, 'function'));
  const newer = { requestId: 'newer-request', cardIds: [3], ethereumAddress: ethereumSession.address };
  window.localStorage.setItem(key, JSON.stringify(newer));
  const finishOld = finishStatus;
  api.status = async () => ({ order: null });
  await act(async () => { finishOld({ order: { ...order(), orderId: 'other-order', cardIds: [2] } }); });
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  assert.deepEqual(result.current.pending, newer);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), newer);
  assert.equal(result.current.order, null);
});

test('a delayed empty legacy recovery adopts another tab’s newer request before its storage event', async () => {
  const { api, options } = runtime();
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  window.localStorage.setItem(key, JSON.stringify({ requestId: 'legacy-request', cardIds: [1] }));
  let finishStatus!: (value: { order: null }) => void;
  let statusCalls = 0;
  api.status = async () => {
    statusCalls += 1;
    if (statusCalls === 1) return new Promise((resolve) => { finishStatus = resolve; });
    return { order: null };
  };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(statusCalls, 1));
  const saved = { requestId: 'new-request', cardIds: [2], ethereumAddress: ethereumSession.address };
  window.localStorage.setItem(key, JSON.stringify(saved));
  await act(async () => { finishStatus({ order: null }); });
  await waitFor(() => assert.equal(statusCalls, 2));
  assert.equal(result.current.recoveryReady, true);
  assert.deepEqual(result.current.pending, saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
});

for (const status of [403, 409, 412]) {
  test(`a rejected preparation ${status} clears its pending request after switching Ethereum wallets`, async () => {
    const { api, options, calls } = runtime();
    let rejectPrepare!: (error: Error) => void;
    api.prepare = async (input) => {
      calls.prepare.push(input);
      return new Promise((_, reject) => { rejectPrepare = reject; });
    };
    const second = { ...ethereumSession, address: '0x0000000000000000000000000000000000000002', token: 'second-session' };
    const { result, rerender } = renderHook((session) => usePreorderCheckout({ ...options, ethereumSession: session }, api), { initialProps: ethereumSession });
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    let purchase!: Promise<void>;
    act(() => { purchase = result.current.purchase([1]); });
    await waitFor(() => assert.equal(result.current.phase, 'preparing'));
    rerender(second);
    await act(async () => {
      rejectPrepare(new ProfileApiError({ status, code: 'failed-precondition', message: 'Preparation rejected.' }));
      await purchase;
    });
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    assert.equal(result.current.pending, null);
    assert.equal(result.current.order, null);
    assert.equal(result.current.error, null);
    assert.equal(window.localStorage.length, 0);
    const next = { ...order(), orderId: 'order-2', ethereumAddress: second.address, cardIds: [2] };
    api.prepare = async (input, session) => {
      assert.equal(session, second);
      calls.prepare.push(input);
      return { order: next, transactionBase64 };
    };
    api.submit = async (input) => { calls.submit.push(input); return { order: { ...next, status: 'submitted' } }; };
    await act(async () => { await result.current.purchase([2]); });
    assert.notEqual(calls.prepare[0].requestId, calls.prepare[1].requestId);
    assert.deepEqual(calls.prepare[1].cardIds, [2]);
    assert.equal(calls.submit.length, 1);
    assert.equal(result.current.order?.ethereumAddress, second.address);
  });
}

test('a rejected preparation after an Ethereum switch preserves another tab’s newer pending request', async () => {
  const { api, options } = runtime();
  let rejectPrepare!: (error: Error) => void;
  api.prepare = async () => new Promise((_, reject) => { rejectPrepare = reject; });
  const second = { ...ethereumSession, address: '0x0000000000000000000000000000000000000002', token: 'second-session' };
  const { result, rerender } = renderHook((session) => usePreorderCheckout({ ...options, ethereumSession: session }, api), { initialProps: ethereumSession });
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'preparing'));
  rerender(second);
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const saved = { requestId: 'other-tab-request', cardIds: [2], ethereumAddress: second.address };
  window.localStorage.setItem(key, JSON.stringify(saved));
  await act(async () => {
    rejectPrepare(new ProfileApiError({ status: 403, code: 'permission-denied', message: 'Ownership changed.' }));
    await purchase;
  });
  assert.deepEqual(result.current.pending, saved);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
  assert.equal(result.current.error, null);
});

for (const status of ['succeeded', 'failed', 'expired', 'cancelled'] as const) {
  test(`a ${status} order for Ethereum A does not block a new purchase for Ethereum B`, async () => {
    const { api, options, calls } = runtime();
    api.status = async () => ({ order: order(status) });
    const { result, rerender } = renderHook((session) => usePreorderCheckout({ ...options, ethereumSession: session }, api), { initialProps: ethereumSession });
    await waitFor(() => assert.equal(result.current.order?.status, status));
    const second = { ...ethereumSession, address: '0x0000000000000000000000000000000000000002', token: 'second-session' };
    const next = { ...order(), orderId: 'order-2', ethereumAddress: second.address, cardIds: [2],
      assets: [{ id: 2, address: Keypair.generate().publicKey.toBase58() }] };
    api.prepare = async (input, session) => {
      assert.equal(session.address, second.address);
      calls.prepare.push(input);
      return { order: next, transactionBase64 };
    };
    api.submit = async (input) => { calls.submit.push(input); return { order: { ...next, status: 'submitted' } }; };
    rerender(second);
    await act(async () => { await result.current.purchase([2]); });
    assert.equal(calls.prepare.length, 1);
    assert.equal(calls.submit.length, 1);
    assert.equal(result.current.order?.ethereumAddress, second.address);
    assert.equal(result.current.order?.status, 'submitted');
  });
}

test('switching Ethereum wallets during the Solana signature prompt prevents submission', async () => {
  const { api, options, calls } = runtime();
  let finishSigning!: (value: VersionedTransaction) => void;
  options.signTransaction = async () => new Promise((resolve) => { finishSigning = resolve; });
  const { result, rerender } = renderHook((session) => usePreorderCheckout({ ...options, ethereumSession: session }, api), { initialProps: ethereumSession });
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'signing'));
  const next = { ...ethereumSession, token: 'other-session', address: '0x0000000000000000000000000000000000000002' };
  rerender(next);
  assert.equal(result.current.ethereumAddress, next.address);
  await act(async () => { finishSigning(transaction); await purchase; });
  assert.equal(calls.submit.length, 0);
});

test('leaving and returning during a wallet signature cannot resume the old checkout', async () => {
  const { api, options, calls } = runtime();
  let finishSigning!: (value: VersionedTransaction) => void;
  options.signTransaction = async () => new Promise((resolve) => { finishSigning = resolve; });
  const { result, rerender } = renderHook((active) => usePreorderCheckout({ ...options, active }, api), { initialProps: true });
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(result.current.phase, 'signing'));
  rerender(false);
  rerender(true);
  await act(async () => { finishSigning(transaction); await purchase; });
  assert.equal(calls.submit.length, 0);
  assert.equal(result.current.phase, 'idle');
  assert.equal(result.current.pending?.submittedAttempt, undefined);
});

for (const status of [401, 403]) {
  test(`definitive submission ${status} recovers a prepared order before allowing cancellation or retry`, async () => {
    const { api, options, calls } = runtime();
    let submitted = false;
    let invalidated = 0;
    const prepared = order();
    api.submit = async (input) => {
      calls.submit.push(input);
      submitted = true;
      throw new ProfileApiError({ status, code: status === 401 ? 'unauthenticated' : 'permission-denied', message: 'Ethereum verification failed.' });
    };
    api.status = async () => ({ order: submitted ? prepared : null });
    const { result } = renderHook(() => usePreorderCheckout({ ...options, onEthereumSessionInvalid: () => { invalidated += 1; } }, api));
    await waitFor(() => assert.equal(result.current.recoveryReady, true));
    await act(async () => { await result.current.purchase([1]); });
    assert.equal(result.current.order?.status, 'prepared');
    assert.equal(result.current.pending?.submittedAttempt, undefined);
    assert.equal(invalidated, status === 401 ? 1 : 0);
    assert.equal(result.current.error, 'Ethereum verification failed.');
    if (status === 401) {
      await act(async () => { await result.current.cancel(); });
      assert.deepEqual(calls.cancel, ['order-1']);
      assert.equal(result.current.pending, null);
    } else {
      api.submit = async (input) => { calls.submit.push(input); return { order: order('submitted') }; };
      await act(async () => { await result.current.purchase([1]); });
      assert.equal(calls.submit.length, 2);
      assert.equal(result.current.order?.status, 'submitted');
    }
  });
}

test('a definitive submission error with unavailable recovery keeps payment retries blocked', async () => {
  const { api, options, calls } = runtime();
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  api.submit = async (input) => {
    calls.submit.push(input);
    throw new ProfileApiError({ status: 403, code: 'permission-denied', message: 'Ownership changed.' });
  };
  api.status = async () => { throw new Error('Offline'); };
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(result.current.pending?.submittedAttempt, true);
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.signed, 1);
  assert.match(result.current.error!, /may have been submitted/);
});

test('a delayed submission 401 for Ethereum A cannot invalidate the newly verified Ethereum B session', async () => {
  const { api, options, calls } = runtime();
  let rejectSubmission!: (reason: Error) => void;
  api.submit = async (input) => {
    calls.submit.push(input);
    return new Promise((_resolve, reject) => { rejectSubmission = reject; });
  };
  api.status = async () => ({ order: calls.submit.length ? order() : null });
  const invalidated: string[] = [];
  const { result, rerender } = renderHook((session) => usePreorderCheckout({ ...options, ethereumSession: session,
    onEthereumSessionInvalid: () => { invalidated.push(session.token); } }, api), { initialProps: ethereumSession });
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(calls.submit.length, 1));
  const second = { ...ethereumSession, address: '0x0000000000000000000000000000000000000002', token: 'second-session' };
  rerender(second);
  await act(async () => {
    rejectSubmission(new ProfileApiError({ status: 401, code: 'unauthenticated', message: 'Verify your Ethereum wallet.' }));
    await purchase;
  });
  assert.deepEqual(invalidated, []);
  assert.equal(result.current.ethereumAddress, second.address);
  assert.equal(result.current.pending?.ethereumAddress, ethereumSession.address);
  assert.equal(result.current.pending?.submittedAttempt, undefined);
});

test('a delayed 4xx recovery cannot overwrite another tab’s newer pending checkout before its storage event', async () => {
  const { api, options, calls } = runtime();
  const prepared = order();
  const next = { ...order('submitted'), orderId: 'order-2', cardIds: [2],
    assets: [{ id: 2, address: Keypair.generate().publicKey.toBase58() }] };
  let statusCalls = 0;
  let finishRecovery!: (value: { order: PreorderOrder }) => void;
  api.status = async (_id, orderId) => {
    statusCalls += 1;
    if (statusCalls === 1) return { order: null };
    if (statusCalls === 2) return new Promise((resolve) => { finishRecovery = resolve; });
    assert.equal(orderId, next.orderId);
    return { order: next };
  };
  api.submit = async (input) => {
    calls.submit.push(input);
    throw new ProfileApiError({ status: 403, code: 'permission-denied', message: 'Ownership changed.' });
  };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await waitFor(() => assert.equal(result.current.recoveryReady, true));
  let purchase!: Promise<void>;
  act(() => { purchase = result.current.purchase([1]); });
  await waitFor(() => assert.equal(statusCalls, 2));
  const key = `mons:preorder:v1:${config.cluster}:${config.collection}:${buyer}`;
  const saved = { requestId: 'request-2', cardIds: next.cardIds, orderId: next.orderId,
    ethereumAddress: next.ethereumAddress, submittedAttempt: true };
  window.localStorage.setItem(key, JSON.stringify(saved));
  await act(async () => { finishRecovery({ order: prepared }); await purchase; });
  assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), saved);
  assert.deepEqual(result.current.pending, saved);
  assert.equal(calls.cancel.length, 0);
  assert.equal(calls.submit.length, 1);
});

test('unknown submission remains blocked when later status still reports prepared', async () => {
  const { api, options, calls } = runtime();
  api.submit = async (input) => { calls.submit.push(input); throw new Error('Timeout'); };
  const { result } = renderHook(() => usePreorderCheckout(options, api));
  await act(async () => { await result.current.purchase([1]); });
  api.status = async () => ({ order: order() });
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
  assert.equal(result.current.pending?.submittedAttempt, true);
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(calls.signed, 1);
  assert.equal(calls.submit.length, 1);
});

test('mainnet purchases use matching Ethereum verification and authenticated Solana checkout', async () => {
  const { api, options, calls } = runtime();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  const prepared = { ...order(), preorderId: mainnet.preorderId };
  api.prepare = async (input, session) => {
    assert.equal(session, mainnetSession);
    calls.prepare.push(input);
    return { order: prepared, transactionBase64 };
  };
  api.submit = async (input, session) => {
    assert.equal(session, mainnetSession);
    calls.submit.push(input);
    return { order: { ...prepared, status: 'submitted' } };
  };
  const { result } = renderHook(() => usePreorderCheckout({ ...options, config: mainnet, ethereumSession: mainnetSession }, api));
  await act(async () => { await result.current.purchase([1]); });
  assert.equal(calls.prepare[0].preorderId, mainnet.preorderId);
  assert.equal(calls.submit.length, 1);
  assert.equal(result.current.order?.status, 'submitted');
});

test('disabled collections and unsupported signing wallets cannot prepare purchases', async () => {
  const { api, options, calls } = runtime();
  const mainnet = renderHook(() => usePreorderCheckout({ ...options, config: { ...config, enabled: false } }, api));
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
  api.availability = async (...args) => { calls += 1; return availability(...args); };
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
  const view = renderHook((buyerValue) => usePreorderCheckout({ ...options, buyer: buyerValue, authenticatedBuyer: buyerValue }, api), { initialProps: buyer });
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
  const restoredTab = renderHook((signedIn) => usePreorderCheckout({ ...options, signedIn, authenticatedBuyer: signedIn ? buyer : undefined }, api), { initialProps: false });
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
  const previous = { requestId: 'request-1', cardIds: submitted.cardIds, orderId: submitted.orderId, ethereumAddress: ethereumSession.address };
  window.localStorage.setItem(key, JSON.stringify(previous));
  const view = renderHook((signedIn) => usePreorderCheckout({ ...options, signedIn, authenticatedBuyer: signedIn ? buyer : undefined }, api), { initialProps: false });
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
  const view = renderHook((signedIn) => usePreorderCheckout({ ...options, signedIn, authenticatedBuyer: signedIn ? buyer : undefined }, api), { initialProps: false });
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
  const restoredTab = renderHook((signedIn) => usePreorderCheckout({ ...options, signedIn, authenticatedBuyer: signedIn ? buyer : undefined }, restoredApi), { initialProps: false });
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
  window.localStorage.setItem(key, JSON.stringify({ requestId: 'request-1', cardIds: completed.cardIds, ethereumAddress: ethereumSession.address }));
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
  const saved = { requestId: 'request-2', cardIds: next.cardIds, orderId: next.orderId, ethereumAddress: ethereumSession.address };
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
  const saved = { requestId: 'request-2', cardIds: [2], ethereumAddress: ethereumSession.address };
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
    const saved = { requestId: 'request-2', cardIds: [2], ethereumAddress: ethereumSession.address };
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
    const expectedPending = { ...saved, ...(recovered ? { orderId: recovered.orderId, ethereumAddress: recovered.ethereumAddress } : {}) };
    assert.deepEqual(view.result.current.pending, expectedPending);
    assert.deepEqual(JSON.parse(window.localStorage.getItem(key)!), expectedPending);
    assert.equal(calls.prepare.length, 0);
    assert.equal(calls.signed, 0);
    assert.equal(calls.submit.length, 0);
    assert.equal(calls.cancel.length, 0);
  });
}

test('Ethereum-verified mainnet loads availability before Solana sign-in without recovering or purchasing', async () => {
  const { api, options, calls } = runtime();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  const requested: string[] = [];
  api.availability = async (preorderId) => {
    requested.push(preorderId);
    return { ...ownership, preorderId, items: [{ id: 1, status: 'available' }] };
  };
  api.status = async () => { throw new Error('Mainnet must not recover checkout'); };
  const { result } = renderHook(() => usePreorderCheckout({ ...options, config: mainnet, ethereumSession: mainnetSession, buyer: undefined, signedIn: false, authenticatedBuyer: undefined }, api));
  await waitFor(() => assert.equal(result.current.availability?.preorderId, mainnet.preorderId));
  assert.deepEqual(requested, [mainnet.preorderId]);
  await act(async () => { await result.current.purchase([1]); await result.current.cancel(); });
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.cancel.length, 0);
  assert.equal(result.current.pending, null);
  assert.equal(result.current.error, null);
});

for (const preorderId of ['mi_note_cards_devnet', 'mi_note_cards']) {
  for (const change of ['switching buyers', 'signing out'] as const) {
    test(`${preorderId} restores disconnected buyers' preorders and ${change} discards prior availability`, async () => {
      const { api, options } = runtime();
      const nextBuyer = Keypair.generate().publicKey.toBase58();
      const nextAuthenticatedBuyer = change === 'switching buyers' ? nextBuyer : undefined;
      type Availability = Awaited<ReturnType<typeof api.availability>>;
      const requests: { authenticated: boolean | undefined; resolve: (value: Availability) => void }[] = [];
      api.availability = (_preorderId, _session, authenticated) => new Promise((resolve) => {
        requests.push({ authenticated, resolve });
      });
      api.status = async () => { throw new Error('Disconnected viewing must not recover checkout'); };
      const observed: { authenticatedBuyer: string | undefined; availability: Availability | null }[] = [];
      const { result, rerender } = renderHook((authenticatedBuyer: string | undefined) => {
        const value = usePreorderCheckout({
          ...options, config: getPreorderConfig(preorderId)!, ethereumSession: sessionFor(preorderId),
          buyer: undefined, signedIn: false, signTransaction: undefined, authenticatedBuyer,
        }, api);
        observed.push({ authenticatedBuyer, availability: value.availability });
        return value;
      }, { initialProps: buyer });
      const previous: Availability = { ...ownership, preorderId, items: [{ id: 1, status: 'preordered' }, { id: 2, status: 'available' }] };
      await act(async () => { requests[0].resolve(previous); });
      assert.deepEqual(result.current.availability, previous);

      let previousRefresh!: Promise<void>;
      act(() => { previousRefresh = result.current.refreshAvailability(); });
      assert.equal(requests.length, 2);
      rerender(nextAuthenticatedBuyer);
      assert.equal(result.current.availability, null);
      assert.equal(observed.find((value) => value.authenticatedBuyer === nextAuthenticatedBuyer)?.availability, null);
      assert.deepEqual(requests.map((request) => request.authenticated), [true, true, Boolean(nextAuthenticatedBuyer)]);

      const current: Availability = { ...ownership, preorderId, items: [
        { id: 2, status: 'available' },
        ...(nextAuthenticatedBuyer ? [{ id: 3, status: 'preordered' as const }] : []),
      ] };
      await act(async () => { requests[2].resolve(current); });
      assert.deepEqual(result.current.availability, current);
      await act(async () => { requests[1].resolve(previous); await previousRefresh; });
      assert.deepEqual(result.current.availability, current);
      assert.ok(observed.filter((value) => value.authenticatedBuyer === nextAuthenticatedBuyer)
        .every((value) => !value.availability || value.availability === current));
    });
  }
}

test('collection changes hide old availability and errors and discard late responses', async () => {
  const { api, options } = runtime();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  type Availability = Awaited<ReturnType<typeof api.availability>>;
  const requests: { preorderId: string; resolve: (value: Availability) => void; reject: (error: Error) => void }[] = [];
  api.availability = (preorderId) => new Promise((resolve, reject) => { requests.push({ preorderId, resolve, reject }); });
  const observed: { preorderId: string; data: Availability | null; error: string | null }[] = [];
  const { result, rerender } = renderHook((nextConfig) => {
    const value = usePreorderCheckout({ ...options, config: nextConfig, ethereumSession: sessionFor(nextConfig.preorderId), buyer: undefined, signedIn: false, authenticatedBuyer: undefined }, api);
    observed.push({ preorderId: nextConfig.preorderId, data: value.availability, error: value.availabilityError });
    return value;
  }, { initialProps: config });
  const reply = (index: number): Availability => ({ ...ownership, preorderId: requests[index].preorderId, items: [{ id: 1, status: 'preordered' }] });
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
  api.availability = async (preorderId) => ({ ...ownership, preorderId, items: [{ id: 1, status: 'available' }] });
  let finishSigning!: (value: VersionedTransaction) => void;
  options.signTransaction = () => new Promise((resolve) => { finishSigning = resolve; });
  const { result, rerender } = renderHook((nextConfig) => usePreorderCheckout({ ...options, config: nextConfig, ethereumSession: sessionFor(nextConfig.preorderId) }, api), { initialProps: config });
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

test('an inactive collection refresh cannot block or overwrite a newly active collection', async () => {
  const { api, options } = runtime();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  type Availability = Awaited<ReturnType<typeof api.availability>>;
  const requests: { preorderId: string; resolve: (value: Availability) => void }[] = [];
  api.availability = (preorderId) => new Promise((resolve) => { requests.push({ preorderId, resolve }); });
  const { result, rerender } = renderHook(({ nextConfig, active }) => usePreorderCheckout({
    ...options, config: nextConfig, ethereumSession: sessionFor(nextConfig.preorderId), active, buyer: undefined, signedIn: false, authenticatedBuyer: undefined,
  }, api), { initialProps: { nextConfig: config, active: false } });
  act(() => { void result.current.refreshAvailability(); });
  rerender({ nextConfig: mainnet, active: true });
  assert.deepEqual(requests.map((request) => request.preorderId), [config.preorderId, mainnet.preorderId]);
  await act(async () => { requests[0].resolve({ ...ownership, preorderId: config.preorderId, items: [{ id: 1, status: 'preordered' }] }); });
  assert.equal(result.current.availability, null);
  await act(async () => { await result.current.refreshAvailability(); });
  assert.equal(requests.length, 2);
  const response: Availability = { ...ownership, preorderId: mainnet.preorderId, items: [{ id: 1, status: 'available' }] };
  await act(async () => { requests[1].resolve(response); });
  assert.deepEqual(result.current.availability, response);
});
