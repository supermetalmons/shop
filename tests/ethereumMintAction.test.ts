import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { useState } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import type { EthereumWallet } from '../src/ethereum/useEthereum111k.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useEthereumMintAction } = await import('../src/ethereum/useEthereumMintAction.ts');
dom.window.close();

type Options = Parameters<typeof useEthereumMintAction>[0];
const address = '0x1111111111111111111111111111111111111111';
const provider = { request: async () => [address] };
const config = { enabled: true, chainId: 11155111, contractAddress: '0x3333333333333333333333333333333333333333' };
const disconnected: EthereumWallet = {
  address: null, provider: null, ready: true, status: 'disconnected', wallets: [], error: null,
  connect() {}, cancel() {}, disconnect() {}, selectWallet() {},
};
const connected: EthereumWallet = { ...disconnected, status: 'connected', address, provider };

beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { cleanup(); dom.window.close(); });

function harness(overrides: Partial<Options> = {}, connectState: EthereumWallet = { ...disconnected, status: 'connecting' }) {
  const calls = { connect: 0, cancel: 0, quantities: [] as number[] };
  let finish!: (success: boolean) => void;
  const initialProps: Options = {
    wallet: disconnected, config, quantity: 2, remaining: 100, saleActive: true,
    blocked: false, suspended: false,
    onMint: quantity => {
      calls.quantities.push(quantity);
      return new Promise(resolve => { finish = resolve; });
    },
    ...overrides,
  };
  const view = renderHook((props: Options) => {
    const [walletState, setWallet] = useState(props.wallet);
    const wallet = {
      ...walletState,
      connect() { calls.connect++; setWallet(connectState); },
      cancel() { calls.cancel++; setWallet(disconnected); },
    };
    const action = useEthereumMintAction({ ...props, wallet });
    return { ...action, setWallet };
  }, { initialProps, reactStrictMode: true });
  return {
    ...view, calls,
    update: (next: Partial<Options>) => view.rerender(Object.assign(initialProps, next)),
    settle: async (success = true) => { await act(async () => { finish(success); }); },
  };
}

test('a disconnected Mint captures its quantity and continues exactly once after choosing a wallet', async () => {
  const view = harness();
  act(() => { view.result.current.mint(); view.result.current.mint(); });
  assert.equal(view.calls.connect, 1);
  assert.equal(view.result.current.connecting, true);
  assert.equal(view.result.current.pending, true);
  act(() => view.result.current.setWallet({ ...disconnected, status: 'choosing' }));
  view.update({ quantity: 7 });
  act(() => view.result.current.setWallet(connected));
  assert.deepEqual(view.calls.quantities, [2]);
  assert.equal(view.result.current.connecting, false);
  assert.equal(view.result.current.pending, true);
  view.update({ blocked: true });
  act(() => { view.result.current.mint(); view.result.current.mint(); });
  assert.deepEqual(view.calls.quantities, [2]);
  assert.equal(view.result.current.pending, true);
  await view.settle();
  assert.equal(view.result.current.pending, false);
});

test('batched connection success continues without requiring an intermediate connecting render', async () => {
  const view = harness({}, connected);
  act(() => view.result.current.mint());
  assert.equal(view.calls.connect, 1);
  assert.deepEqual(view.calls.quantities, [2]);
  await view.settle();
  act(() => view.result.current.mint());
  assert.equal(view.calls.connect, 1);
  assert.deepEqual(view.calls.quantities, [2, 2]);
  await view.settle(false);
  assert.equal(view.result.current.pending, false);
});

test('a connected Mint starts synchronously and ignores repeated clicks and cancellation during submission', async () => {
  const view = harness({ wallet: connected });
  act(() => { view.result.current.mint(); view.result.current.mint(); view.result.current.cancel(); });
  assert.equal(view.calls.connect, 0);
  assert.equal(view.calls.cancel, 0);
  assert.deepEqual(view.calls.quantities, [2]);
  assert.equal(view.result.current.pending, true);
  await view.settle();
});

for (const ending of ['picker-cancel', 'rejected', 'missing-provider', 'disconnect'] as const) {
  test(`${ending} clears the waiting mint and a later wallet connection does not submit it`, () => {
    const view = harness();
    act(() => view.result.current.mint());
    if (ending === 'picker-cancel') {
      act(() => view.result.current.setWallet({ ...disconnected, status: 'choosing' }));
      act(() => view.result.current.cancel());
    } else {
      act(() => view.result.current.setWallet({
        ...disconnected,
        error: ending === 'disconnect' ? null : ending === 'rejected' ? 'Wallet connection was cancelled.' : 'No Ethereum wallet found.',
      }));
    }
    assert.equal(view.result.current.pending, false);
    act(() => view.result.current.setWallet(connected));
    assert.deepEqual(view.calls.quantities, []);
  });
}

test('a batched rejected connection clears an attempt even when its error matches the previous failure', () => {
  const rejected = { ...disconnected, error: 'Wallet connection was cancelled.' };
  const view = harness({ wallet: rejected }, rejected);
  act(() => view.result.current.mint());
  assert.equal(view.calls.connect, 1);
  assert.equal(view.result.current.pending, false);
  assert.deepEqual(view.calls.quantities, []);
});

for (const change of [
  { suspended: true },
  { blocked: true },
  { saleActive: false },
  { remaining: 1 },
  { remaining: undefined },
  { config: { ...config, enabled: false } },
  { config: { ...config, chainId: 31337 } },
  { config: { ...config, contractAddress: '0x4444444444444444444444444444444444444444' } },
] satisfies Partial<Options>[]) {
  test(`a waiting mint is cancelled when prerequisites change to ${JSON.stringify(change)}`, () => {
    const view = harness();
    act(() => view.result.current.mint());
    view.update(change);
    assert.equal(view.result.current.pending, false);
    assert.equal(view.calls.cancel, 1);
    act(() => view.result.current.setWallet(connected));
    assert.deepEqual(view.calls.quantities, []);
  });
}

test('passive restoration never connects or mints, and Mint remains blocked until restoration finishes', () => {
  const view = harness({ wallet: { ...disconnected, ready: false, status: 'restoring' } });
  act(() => view.result.current.mint());
  assert.equal(view.calls.connect, 0);
  act(() => view.result.current.setWallet(connected));
  assert.deepEqual(view.calls.quantities, []);
  assert.equal(view.result.current.pending, false);
});

for (const initial of [
  { blocked: true },
  { suspended: true },
  { saleActive: false },
  { saleActive: undefined },
  { remaining: 0 },
  { remaining: undefined },
  { config: { ...config, enabled: false } },
  { quantity: 0 },
  { quantity: 1.5 },
] satisfies Partial<Options>[]) {
  test(`Mint cannot connect or submit while prerequisites are ${JSON.stringify(initial)}`, () => {
    const view = harness(initial);
    act(() => view.result.current.mint());
    assert.equal(view.calls.connect, 0);
    assert.deepEqual(view.calls.quantities, []);
    assert.equal(view.result.current.pending, false);
  });
}

test('pagehide cancels a waiting Mint without resuming when its wallet later connects', () => {
  const view = harness();
  act(() => view.result.current.mint());
  act(() => window.dispatchEvent(new dom.window.Event('pagehide')));
  assert.equal(view.result.current.pending, false);
  assert.equal(view.calls.cancel, 1);
  act(() => view.result.current.setWallet(connected));
  assert.deepEqual(view.calls.quantities, []);
});

test('unmount cancels only a waiting connection and does not leave a mint continuation', () => {
  const view = harness();
  act(() => view.result.current.mint());
  view.unmount();
  assert.equal(view.calls.cancel, 1);
  assert.deepEqual(view.calls.quantities, []);
});

test('a failed mint releases its click guard and permits an explicit retry', async () => {
  let attempts = 0;
  const view = harness({ wallet: connected, onMint: async () => { attempts++; throw new Error('Rejected'); } });
  await act(async () => view.result.current.mint());
  assert.equal(view.result.current.pending, false);
  await act(async () => view.result.current.mint());
  assert.equal(attempts, 2);
});
