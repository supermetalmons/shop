import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { useState } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import type { EthereumWallet } from '../src/ethereum/useEthereum111k.ts';
import type { EthereumRelicStatus } from '../shared/ethereum/api.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useEthereumRelicClaimAction } = await import('../src/ethereum/useEthereumRelicClaimAction.ts');
dom.window.close();

type Options = Parameters<typeof useEthereumRelicClaimAction>[0];
const address = '0x1111111111111111111111111111111111111111';
const provider = { request: async () => [address] };
const config = { enabled: true, chainId: 11155111, contractAddress: '0x3333333333333333333333333333333333333333' };
const disconnected: EthereumWallet = {
  address: null, provider: null, ready: true, status: 'disconnected', wallets: [], error: null,
  connect() {}, cancel() {}, disconnect() {}, selectWallet() {}, chooseWallet() {}, changeAccount() {}, checkAccount() {},
};
const connected: EthereumWallet = { ...disconnected, status: 'connected', address, provider };
const status = (owner: string | null = address, overrides: Partial<EthereumRelicStatus> = {}): EthereumRelicStatus => ({
  chainId: config.chainId, contractAddress: config.contractAddress, owner, observedBlock: 10, blockHash: `0x${'ab'.repeat(32)}`,
  saleActive: true, relicsAllocated: 12, relicsMinted: 0, publicRelicsMinted: 0, publicSale: null, remainingRelics: 12, claimedMask: 0,
  relicLimit: owner ? 3 : 0, relicsUsed: 0, remainingAllowance: owner ? 3 : 0, ...overrides,
});

beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { cleanup(); dom.window.close(); });

function harness(overrides: Partial<Options> = {}, connectState: EthereumWallet = { ...disconnected, status: 'connecting' }) {
  const calls = { connect: 0, cancel: 0, ids: [] as number[] };
  let finish!: (success: boolean) => void;
  const initialProps: Options = {
    wallet: disconnected, config, active: true, selectedId: 18, status: status(null), blocked: false, suspended: false,
    onClaim: id => { calls.ids.push(id); return new Promise(resolve => { finish = resolve; }); }, ...overrides,
  };
  const view = renderHook((props: Options) => {
    const [walletState, setWallet] = useState(props.wallet);
    const wallet = { ...walletState, connect() { calls.connect++; setWallet(connectState); },
      cancel() { calls.cancel++; setWallet(disconnected); } };
    return { ...useEthereumRelicClaimAction({ ...props, wallet }), setWallet };
  }, { initialProps, reactStrictMode: true });
  return { ...view, calls,
    update: (next: Partial<Options>) => view.rerender(Object.assign(initialProps, next)),
    settle: async (success = true) => { await act(async () => { finish(success); }); },
  };
}

test('Claim preserves the selected ID while connecting and waits for that wallet’s allowance', async () => {
  const view = harness();
  act(() => { view.result.current.claim(); view.result.current.claim(); });
  assert.equal(view.calls.connect, 1);
  act(() => view.result.current.setWallet({ ...disconnected, status: 'choosing' }));
  act(() => view.result.current.setWallet(connected));
  assert.deepEqual(view.calls.ids, []);
  view.update({ status: status() });
  assert.deepEqual(view.calls.ids, [18]);
  assert.equal(view.result.current.pending, true);
  act(() => { view.result.current.claim(); view.result.current.cancel(); });
  assert.deepEqual(view.calls.ids, [18]);
  await view.settle();
  assert.equal(view.result.current.pending, false);
});

test('batched connection success still waits for matching state before claiming once', async () => {
  const view = harness({}, connected);
  act(() => view.result.current.claim());
  assert.equal(view.calls.connect, 1);
  assert.deepEqual(view.calls.ids, []);
  view.update({ status: status() });
  assert.deepEqual(view.calls.ids, [18]);
  await view.settle();
});

for (const change of [
  { active: false }, { selectedId: 2 }, { suspended: true }, { blocked: true },
  { config: { ...config, contractAddress: '0x4444444444444444444444444444444444444444' } },
  { status: status(null, { claimedMask: 1 << 17, relicsMinted: 1, remainingRelics: 11 }) },
  { status: status(null, { saleActive: false }) },
  { status: status(null, { remainingRelics: 0 }) },
  { loadError: 'Availability failed.' },
] satisfies Partial<Options>[]) {
  test(`a waiting claim is cancelled when prerequisites change: ${JSON.stringify(change)}`, () => {
    const view = harness();
    act(() => view.result.current.claim());
    view.update(change);
    assert.equal(view.result.current.pending, false);
    assert.equal(view.calls.cancel, 1);
    act(() => view.result.current.setWallet(connected));
    view.update({ status: status() });
    assert.deepEqual(view.calls.ids, []);
  });
}

for (const remaining of [status(address, { relicLimit: 0, remainingAllowance: 0 }), status(address, { relicsUsed: 3, remainingAllowance: 0 })]) {
  test(`an ineligible or exhausted wallet cannot claim: ${remaining.relicLimit}`, () => {
    const view = harness({ wallet: connected, status: remaining });
    act(() => view.result.current.claim());
    assert.equal(view.result.current.pending, false);
    assert.deepEqual(view.calls.ids, []);
    assert.match(view.result.current.error!, /not eligible|allowance/);
  });
}

test('a fresh state for another wallet or deployment cannot authorize a claim', () => {
  const view = harness({ wallet: connected, status: status('0x2222222222222222222222222222222222222222') });
  act(() => view.result.current.claim());
  assert.deepEqual(view.calls.ids, []);
  view.update({ status: status(address, { contractAddress: '0x4444444444444444444444444444444444444444' }) });
  assert.deepEqual(view.calls.ids, []);
  act(() => view.result.current.setWallet({ ...connected, address: '0x2222222222222222222222222222222222222222' }));
  assert.equal(view.result.current.pending, false);
  view.update({ status: status() });
  assert.deepEqual(view.calls.ids, []);
});

test('three explicit sequential claims consume fresh wallet allowances and stop at zero', async () => {
  const view = harness({ wallet: connected, status: status() });
  for (const [index, id] of [18, 4, 9].entries()) {
    view.update({ selectedId: id, status: status(address, { relicsUsed: index, remainingAllowance: 3 - index }) });
    act(() => view.result.current.claim());
    await view.settle();
  }
  view.update({ selectedId: 2, status: status(address, { relicsUsed: 3, remainingAllowance: 0 }) });
  act(() => view.result.current.claim());
  assert.deepEqual(view.calls.ids, [18, 4, 9]);
  assert.equal(view.result.current.pending, false);
});

test('an absent fresh snapshot does not submit and a failed claim permits explicit retry', async () => {
  const view = harness({ wallet: connected, status: undefined });
  act(() => view.result.current.claim());
  assert.deepEqual(view.calls.ids, []);
  view.update({ status: status() });
  assert.deepEqual(view.calls.ids, [18]);
  await view.settle(false);
  act(() => view.result.current.claim());
  assert.deepEqual(view.calls.ids, [18, 18]);
  await view.settle();
});

test('cancelling a wallet picker or hiding the page never leaves a claim continuation', () => {
  const view = harness();
  act(() => view.result.current.claim());
  act(() => window.dispatchEvent(new dom.window.Event('pagehide')));
  assert.equal(view.result.current.pending, false);
  assert.equal(view.calls.cancel, 1);
  act(() => view.result.current.setWallet(connected));
  view.update({ status: status() });
  assert.deepEqual(view.calls.ids, []);
});
