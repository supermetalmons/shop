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
  const calls = { connect: 0, cancel: 0, kinds: [] as Options['kind'][], quantities: [] as number[] };
  let finish!: (success: boolean) => void;
  const initialProps: Options = {
    wallet: disconnected, config, kind: 'crate', quantity: 2, remaining: 100, saleActive: true,
    blocked: false, suspended: false,
    onMint: (kind, quantity) => {
      calls.kinds.push(kind);
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
  assert.deepEqual(view.calls.kinds, ['crate']);
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

test('a warehouse Mint preserves its selected kind and quantity through wallet connection', async () => {
  const view = harness({ kind: 'warehouse', quantity: 3 });
  act(() => view.result.current.mint());
  act(() => view.result.current.setWallet({ ...disconnected, status: 'choosing' }));
  view.update({ quantity: 8 });
  act(() => view.result.current.setWallet(connected));
  assert.deepEqual(view.calls.kinds, ['warehouse']);
  assert.deepEqual(view.calls.quantities, [3]);
  await view.settle();
});

test('changing container kind cancels a waiting Mint and requires a fresh action for the new kind', async () => {
  const view = harness();
  act(() => view.result.current.mint());
  view.update({ kind: 'warehouse', quantity: 1 });
  assert.equal(view.result.current.pending, false);
  assert.equal(view.calls.cancel, 1);
  act(() => view.result.current.setWallet(connected));
  assert.deepEqual(view.calls.quantities, []);
  act(() => view.result.current.mint());
  assert.deepEqual(view.calls.kinds, ['warehouse']);
  assert.deepEqual(view.calls.quantities, [1]);
  await view.settle();
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

test('passive restoration never connects or mints without an explicit Mint click', () => {
  const view = harness({ wallet: { ...disconnected, ready: false, status: 'restoring' } });
  assert.equal(view.calls.connect, 0);
  act(() => view.result.current.setWallet(connected));
  assert.deepEqual(view.calls.quantities, []);
  assert.equal(view.result.current.pending, false);
});

for (const initial of [
  { blocked: true },
  { suspended: true },
  { saleActive: false },
  { remaining: 0 },
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
  assert.equal(view.result.current.error, null);
});

test('an early Mint connects while authoritative config and stats load, then submits the captured choice once', async () => {
  const view = harness({ config: undefined, remaining: undefined, saleActive: undefined, kind: 'warehouse', quantity: 3 });
  act(() => { view.result.current.mint(); view.result.current.mint(); });
  assert.equal(view.calls.connect, 1);
  assert.equal(view.result.current.pending, true);
  assert.deepEqual(view.calls.quantities, []);
  act(() => view.result.current.setWallet(connected));
  assert.equal(view.result.current.pending, true);
  view.update({ config, quantity: 8 });
  assert.deepEqual(view.calls.quantities, []);
  view.update({ remaining: 10, saleActive: true });
  assert.deepEqual(view.calls.kinds, ['warehouse']);
  assert.deepEqual(view.calls.quantities, [3]);
  await view.settle();
  assert.equal(view.result.current.pending, false);
});

test('stats arriving before config cannot submit against a fallback contract', async () => {
  const view = harness({ wallet: connected, config: undefined, remaining: undefined, saleActive: undefined });
  act(() => view.result.current.mint());
  view.update({ remaining: 100, saleActive: true });
  assert.equal(view.result.current.pending, true);
  assert.deepEqual(view.calls.quantities, []);
  view.update({ config });
  assert.deepEqual(view.calls.quantities, [2]);
  await view.settle();
});

test('a fresh wallet initialization delays connection without losing the early Mint', async () => {
  const view = harness({ wallet: { ...disconnected, ready: false } });
  act(() => { view.result.current.mint(); view.result.current.mint(); });
  assert.equal(view.result.current.pending, true);
  assert.equal(view.calls.connect, 0);
  act(() => view.result.current.setWallet(disconnected));
  assert.equal(view.calls.connect, 1);
  act(() => view.result.current.setWallet(connected));
  assert.deepEqual(view.calls.quantities, [2]);
  await view.settle();
});

for (const restored of [true, false]) {
  test(`an explicit Mint during passive restoration continues after restoration ${restored ? 'succeeds' : 'fails'}`, async () => {
    const view = harness({ wallet: { ...disconnected, ready: false, status: 'restoring' } });
    act(() => view.result.current.mint());
    assert.equal(view.result.current.pending, true);
    assert.equal(view.calls.connect, 0);
    act(() => view.result.current.setWallet(restored ? connected : { ...disconnected, error: 'Restoration failed' }));
    if (!restored) {
      assert.equal(view.calls.connect, 1);
      act(() => view.result.current.setWallet(connected));
    }
    assert.deepEqual(view.calls.quantities, [2]);
    assert.equal(view.result.current.error, null);
    await view.settle();
  });
}

for (const missing of [{ remaining: undefined }, { saleActive: undefined }, { config: undefined }] satisfies Partial<Options>[]) {
  test(`temporary readiness loss ${JSON.stringify(Object.keys(missing))} waits instead of dropping an explicit Mint`, async () => {
    const view = harness();
    act(() => view.result.current.mint());
    view.update(missing);
    act(() => view.result.current.setWallet(connected));
    assert.equal(view.result.current.pending, true);
    assert.equal(view.result.current.error, null);
    assert.deepEqual(view.calls.quantities, []);
    view.update({ remaining: 100, saleActive: true, config });
    assert.deepEqual(view.calls.quantities, [2]);
    await view.settle();
  });
}

for (const failure of [
  { props: { config: { ...config, enabled: false } }, error: 'Minting is unavailable for this drop.' },
  { props: { config: { ...config, contractAddress: null } }, error: 'Minting is unavailable for this drop.' },
  { props: { saleActive: false }, error: 'Minting is paused.' },
  { props: { remaining: 0 }, error: 'Crates are sold out.' },
  { props: { remaining: 1 }, error: 'That quantity is no longer available. Choose fewer crates.' },
  { props: { loadError: 'Couldn’t load availability.' }, error: 'Couldn’t load availability.' },
] satisfies { props: Partial<Options>; error: string }[]) {
  test(`early readiness failure reports "${failure.error}" and never resumes after a later refresh`, () => {
    const view = harness({ config: undefined, remaining: undefined, saleActive: undefined });
    act(() => view.result.current.mint());
    view.update(failure.props);
    assert.equal(view.result.current.pending, false);
    assert.equal(view.result.current.error, failure.error);
    act(() => view.result.current.setWallet(connected));
    view.update({ config, remaining: 100, saleActive: true, loadError: null });
    assert.deepEqual(view.calls.quantities, []);
  });
}

test('warehouse readiness failures use the selected container label', () => {
  const view = harness({ kind: 'warehouse', remaining: undefined });
  act(() => view.result.current.mint());
  view.update({ remaining: 1 });
  assert.equal(view.result.current.error, 'That quantity is no longer available. Choose fewer warehouses.');
  view.update({ remaining: 0 });
  act(() => view.result.current.mint());
  assert.equal(view.result.current.error, 'Warehouses are sold out.');
});

test('a readiness error can be dismissed and a new explicit attempt clears earlier errors', async () => {
  const view = harness({ loadError: 'Couldn’t load this drop.', config: undefined });
  act(() => view.result.current.mint());
  assert.equal(view.calls.connect, 0);
  assert.equal(view.result.current.error, 'Couldn’t load this drop.');
  act(() => view.result.current.clearError());
  assert.equal(view.result.current.error, null);
  act(() => view.result.current.mint());
  assert.equal(view.result.current.error, 'Couldn’t load this drop.');
  view.update({ config, loadError: null });
  act(() => view.result.current.mint());
  assert.equal(view.result.current.error, null);
  act(() => view.result.current.setWallet(connected));
  await view.settle();
});

test('data recovery clears a stopped Mint load error without restarting its intent', () => {
  const view = harness({ config: undefined, remaining: undefined, saleActive: undefined });
  act(() => view.result.current.mint());
  view.update({ loadError: 'Couldn’t load this drop.' });
  assert.equal(view.result.current.error, 'Couldn’t load this drop.');
  assert.equal(view.result.current.pending, false);
  view.update({ config, remaining: 100, saleActive: true, loadError: null });
  assert.equal(view.result.current.error, null);
  act(() => view.result.current.setWallet(connected));
  assert.deepEqual(view.calls.quantities, []);
  view.update({ loadError: 'Couldn’t load this drop.' });
  assert.equal(view.result.current.error, null);
  assert.equal(view.result.current.pending, false);
});

test('a changed load failure retires the previous error and a fresh failed attempt reports the new source', () => {
  const view = harness({ config: undefined, loadError: 'Couldn’t load this drop.' });
  act(() => view.result.current.mint());
  assert.equal(view.result.current.error, 'Couldn’t load this drop.');
  view.update({ config, remaining: undefined, loadError: 'Couldn’t load availability.' });
  assert.equal(view.result.current.error, null);
  act(() => view.result.current.mint());
  assert.equal(view.result.current.error, 'Couldn’t load availability.');
  assert.equal(view.result.current.pending, false);
  assert.equal(view.calls.connect, 0);
  view.update({ remaining: 100, loadError: undefined });
  assert.equal(view.result.current.error, null);
});

test('recovering data does not dismiss a wallet identity error from a stopped Mint', () => {
  const view = harness({ wallet: connected, config: undefined, remaining: undefined, saleActive: undefined });
  act(() => view.result.current.mint());
  act(() => view.result.current.setWallet({ ...connected, address: '0x2222222222222222222222222222222222222222' }));
  assert.equal(view.result.current.error, 'Your Ethereum wallet changed. Please try minting again.');
  view.update({ loadError: 'Couldn’t load this drop.' });
  view.update({ config, remaining: 100, saleActive: true, loadError: null });
  assert.equal(view.result.current.error, 'Your Ethereum wallet changed. Please try minting again.');
  assert.deepEqual(view.calls.quantities, []);
});

test('recovering data does not dismiss an invalid quantity error', () => {
  const view = harness({ quantity: 0, config: undefined, loadError: 'Couldn’t load this drop.' });
  act(() => view.result.current.mint());
  assert.equal(view.result.current.error, 'Choose a whole-number quantity of at least 1.');
  view.update({ config, loadError: null });
  assert.equal(view.result.current.error, 'Choose a whole-number quantity of at least 1.');
});

for (const replacement of [
  { ...connected, address: '0x2222222222222222222222222222222222222222' },
  { ...connected, provider: { request: async () => [address] } },
  disconnected,
]) {
  test(`a connected wallet identity change while data loads cancels the early Mint (${replacement.status}, ${replacement.address})`, () => {
    const view = harness({ config: undefined, remaining: undefined, saleActive: undefined });
    act(() => view.result.current.mint());
    act(() => view.result.current.setWallet(connected));
    act(() => view.result.current.setWallet(replacement));
    assert.equal(view.result.current.pending, false);
    assert.equal(view.result.current.error, 'Your Ethereum wallet changed. Please try minting again.');
    view.update({ config, remaining: 100, saleActive: true });
    act(() => view.result.current.setWallet(connected));
    assert.deepEqual(view.calls.quantities, []);
  });
}

for (const replacement of [
  { ...config, chainId: 31337 },
  { ...config, contractAddress: '0x4444444444444444444444444444444444444444' },
]) {
  test(`the first authoritative config stays pinned while stats load (${replacement.chainId}, ${replacement.contractAddress})`, () => {
    const view = harness({ wallet: connected, config: undefined, remaining: undefined, saleActive: undefined });
    act(() => view.result.current.mint());
    view.update({ config });
    view.update({ config: undefined });
    assert.equal(view.result.current.pending, true);
    view.update({ config: replacement, remaining: 100, saleActive: true });
    assert.equal(view.result.current.pending, false);
    assert.equal(view.result.current.error, 'This drop changed. Please try minting again.');
    assert.deepEqual(view.calls.quantities, []);
  });
}

for (const stop of ['cancel', 'pagehide', 'suspend', 'kind-change', 'unmount'] as const) {
  test(`${stop} removes an early Mint before delayed data and restoration can finish`, () => {
    const view = harness({ config: undefined, remaining: undefined, saleActive: undefined,
      wallet: { ...disconnected, ready: false, status: 'restoring' } });
    act(() => view.result.current.mint());
    if (stop === 'unmount') {
      view.unmount();
    } else {
      if (stop === 'cancel') act(() => view.result.current.cancel());
      if (stop === 'pagehide') act(() => window.dispatchEvent(new dom.window.Event('pagehide')));
      if (stop === 'suspend') view.update({ suspended: true });
      if (stop === 'kind-change') view.update({ kind: 'warehouse' });
      assert.equal(view.result.current.pending, false);
      view.update({ config, remaining: 100, saleActive: true, suspended: false });
      act(() => view.result.current.setWallet(connected));
    }
    assert.equal(view.calls.connect, 0);
    assert.deepEqual(view.calls.quantities, []);
  });
}
