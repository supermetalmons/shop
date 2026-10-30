import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import type { EIP1193Provider, EthereumProviderListener } from '../src/wallet/injectedEthereumProviders.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const imports = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { default: DirectPaymentPage } = await import('../src/ethereum/DirectPaymentPage.tsx');
imports.deregister();
dom.window.close();

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'ab'.repeat(32)}`;
type Request = Parameters<EIP1193Provider['request']>[0];

beforeEach(() => {
  ({ dom } = setupFrontendDom());
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  window.history.replaceState(null, '', '/111111');
});
afterEach(() => {
  cleanup();
  dom.window.close();
});

function walletFixture({ accounts = [OWNER], chain = '0x1' } = {}) {
  const requests: Request[] = [];
  const handlers = new Map<string, (request: Request) => unknown | Promise<unknown>>();
  const listeners = new Map<string, Set<EthereumProviderListener>>();
  const emit = (event: string, value?: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const provider: EIP1193Provider = {
    async request(request) {
      requests.push(request);
      const handler = handlers.get(request.method);
      if (handler) return handler(request);
      if (request.method === 'eth_accounts') return accounts;
      if (request.method === 'eth_requestAccounts') {
        accounts = [OWNER];
        emit('accountsChanged', accounts);
        return accounts;
      }
      if (request.method === 'eth_chainId') return chain;
      if (request.method === 'wallet_switchEthereumChain') {
        chain = (request.params as [{ chainId: string }])[0].chainId;
        emit('chainChanged', chain);
        return null;
      }
      if (request.method === 'wallet_addEthereumChain') return null;
      if (request.method === 'eth_sendTransaction') return HASH;
      assert.fail(`Unexpected wallet request: ${request.method}`);
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  return {
    provider, requests, handlers, emit,
    calls: (method: string) => requests.filter(request => request.method === method),
    listenerCount: () => [...listeners.values()].reduce((count, group) => count + group.size, 0),
    install() { Object.defineProperty(window, 'ethereum', { configurable: true, value: provider }); },
    announce(id: string) {
      window.addEventListener('eip6963:requestProvider', () => {
        window.dispatchEvent(new dom.window.CustomEvent('eip6963:announceProvider', { detail: {
          provider, info: { uuid: id, name: id, rdns: `com.example.${id}`, icon: '' },
        } }));
      });
    },
  };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(settle => { resolve = settle; });
  return { promise, resolve };
}

function paymentView() {
  const view = render(createElement(DirectPaymentPage), { reactStrictMode: true });
  const button = view.getByRole('button', { name: 'Pay 2.3 ETH' }) as HTMLButtonElement;
  return { ...view, button, pay: () => fireEvent.click(button) };
}

test('payment page only shows the home link, static artwork, and unchanged Pay button', () => {
  const wallet = walletFixture();
  wallet.install();
  const view = paymentView();
  assert.deepEqual(wallet.requests, []);
  assert.equal(view.getAllByRole('button').length, 1);
  assert.equal(view.getAllByRole('link').length, 1);
  assert.equal(view.queryByRole('dialog'), null);
  assert.equal(view.queryByRole('status'), null);
  const artwork = view.getByRole('img', { name: 'Artwork' }) as HTMLImageElement;
  assert.equal(artwork.src, 'https://wip.lil.org/111k/artwork_placeholder.png');
  assert.equal(artwork.closest('button, a'), null);
  assert.equal(view.container.querySelector('canvas'), null);
  assert.equal(document.body.classList.contains('drif-body'), true);
  fireEvent.click(view.getByRole('link', { name: 'Go to mons.shop home' }));
  assert.equal(window.location.pathname, '/');
  view.unmount();
  assert.equal(document.body.classList.contains('drif-body'), false);
});

test('authorized mainnet wallet sends exactly 2.3 ETH once while a request is open', async () => {
  const wallet = walletFixture();
  const pending = deferred();
  wallet.handlers.set('eth_sendTransaction', () => pending.promise);
  wallet.install();
  const view = paymentView();
  view.pay();
  view.pay();
  await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
  view.pay();
  assert.equal(view.button.disabled, false);
  assert.equal(view.button.textContent, 'Pay 2.3 ETH');
  assert.equal(wallet.calls('eth_requestAccounts').length, 0);
  assert.equal(wallet.calls('wallet_switchEthereumChain').length, 0);
  assert.deepEqual(wallet.calls('eth_sendTransaction')[0].params, [{
    from: OWNER,
    to: '0x72D0c5623A05033F9eE4495D408BC6c05DF8367d',
    data: '0x', value: '0x1feb3dd067660000', chainId: '0x1',
  }]);
  await act(async () => pending.resolve(HASH));
  assert.equal(wallet.calls('eth_sendTransaction').length, 1);
  assert.equal(wallet.listenerCount(), 0);
  wallet.handlers.delete('eth_sendTransaction');
  view.pay();
  await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 2));
  assert.equal(view.queryByRole('status'), null);
  assert.equal(view.button.textContent, 'Pay 2.3 ETH');
  assert.equal(window.localStorage.length, 0);
  assert.equal(window.sessionStorage.length, 0);
});

test('disconnected wallet connects and switches to mainnet before payment', async () => {
  const wallet = walletFixture({ accounts: [], chain: '0xaa36a7' });
  wallet.install();
  const view = paymentView();
  view.pay();
  await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
  const methods = wallet.requests.map(request => request.method);
  assert.equal(wallet.calls('eth_requestAccounts').length, 1);
  assert.ok(methods.indexOf('eth_requestAccounts') < methods.indexOf('wallet_switchEthereumChain'));
  assert.ok(methods.indexOf('wallet_switchEthereumChain') < methods.indexOf('eth_sendTransaction'));
  assert.deepEqual(wallet.calls('wallet_switchEthereumChain')[0].params, [{ chainId: '0x1' }]);
  assert.equal(wallet.listenerCount(), 0);
});

test('a pending payment remains guarded after leaving and remounting the page', async () => {
  const wallet = walletFixture();
  const pending = deferred();
  wallet.handlers.set('eth_sendTransaction', () => pending.promise);
  wallet.install();
  const first = paymentView();
  first.pay();
  await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
  first.unmount();
  const returned = paymentView();
  const requestCount = wallet.requests.length;
  await act(async () => returned.pay());
  assert.equal(wallet.requests.length, requestCount);
  assert.equal(wallet.calls('eth_sendTransaction').length, 1);
  await act(async () => pending.resolve(HASH));
  wallet.handlers.delete('eth_sendTransaction');
  returned.pay();
  await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 2));
  assert.equal(wallet.listenerCount(), 0);
});

test('unknown mainnet network uses the fixed mainnet add-network fallback', async () => {
  const wallet = walletFixture({ chain: '0xaa36a7' });
  wallet.handlers.set('wallet_switchEthereumChain', () => {
    wallet.handlers.delete('wallet_switchEthereumChain');
    throw { code: 4902 };
  });
  wallet.install();
  paymentView().pay();
  await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
  assert.deepEqual(wallet.calls('wallet_addEthereumChain')[0].params, [{
    chainId: '0x1', chainName: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://ethereum-rpc.publicnode.com'], blockExplorerUrls: ['https://etherscan.io'],
  }]);
});

test('payment does not submit if the wallet stays on the wrong network', async () => {
  const wallet = walletFixture({ chain: '0xaa36a7' });
  wallet.handlers.set('wallet_switchEthereumChain', () => null);
  wallet.install();
  const view = paymentView();
  view.pay();
  await waitFor(() => assert.equal(wallet.calls('wallet_switchEthereumChain').length, 1));
  await waitFor(() => assert.equal(wallet.listenerCount(), 0));
  assert.equal(wallet.calls('eth_sendTransaction').length, 0);
  assert.equal(view.getAllByRole('button').length, 1);
});

for (const method of ['eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_sendTransaction']) {
  test(`rejecting ${method} stays silent and allows another Pay attempt`, async () => {
    const wallet = walletFixture({ accounts: [], chain: '0xaa36a7' });
    wallet.handlers.set(method, () => { throw { code: 4001 }; });
    wallet.install();
    const view = paymentView();
    view.pay();
    await waitFor(() => assert.equal(wallet.calls(method).length, 1));
    await waitFor(() => assert.equal(wallet.listenerCount(), 0));
    assert.equal(wallet.calls('eth_sendTransaction').length, method === 'eth_sendTransaction' ? 1 : 0);
    assert.equal(view.queryByRole('alert'), null);
    assert.equal(view.queryByRole('status'), null);
    assert.equal(view.button.textContent, 'Pay 2.3 ETH');
    wallet.handlers.delete(method);
    view.pay();
    await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, method === 'eth_sendTransaction' ? 2 : 1));
  });
}

test('default injected provider takes precedence over announced wallets', async () => {
  const wallet = walletFixture();
  const other = walletFixture();
  wallet.install();
  other.announce('other');
  paymentView().pay();
  await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
  assert.deepEqual(other.requests, []);
});

test('without a default provider the first announced wallet handles payment', async () => {
  const first = walletFixture();
  const second = walletFixture();
  first.announce('first');
  second.announce('second');
  paymentView().pay();
  await waitFor(() => assert.equal(first.calls('eth_sendTransaction').length, 1));
  assert.deepEqual(second.requests, []);
});

test('missing wallet stays silent and a subsequently installed wallet can pay', async () => {
  const view = paymentView();
  await act(async () => {
    view.pay();
    await new Promise(resolve => window.setTimeout(resolve, 350));
  });
  assert.equal(view.getAllByRole('button').length, 1);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(view.button.textContent, 'Pay 2.3 ETH');
  const wallet = walletFixture();
  wallet.install();
  view.pay();
  await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
});

for (const interruption of ['account change', 'disconnect', 'unmount']) {
  test(`${interruption} before submission prevents payment and releases listeners`, async () => {
    const wallet = walletFixture();
    const pending = deferred();
    wallet.handlers.set('eth_chainId', () => pending.promise);
    wallet.install();
    const view = paymentView();
    view.pay();
    await waitFor(() => assert.equal(wallet.calls('eth_chainId').length, 1));
    if (interruption === 'account change') wallet.emit('accountsChanged', [OTHER]);
    else if (interruption === 'disconnect') wallet.emit('disconnect');
    else view.unmount();
    await act(async () => pending.resolve('0x1'));
    assert.equal(wallet.calls('eth_sendTransaction').length, 0);
    assert.equal(wallet.listenerCount(), 0);
  });
}

test('unmounting while connection is pending does not begin a transaction', async () => {
  const wallet = walletFixture({ accounts: [] });
  const pending = deferred();
  wallet.handlers.set('eth_requestAccounts', () => pending.promise);
  wallet.install();
  const view = paymentView();
  view.pay();
  await waitFor(() => assert.equal(wallet.calls('eth_requestAccounts').length, 1));
  view.unmount();
  await act(async () => pending.resolve([OWNER]));
  assert.equal(wallet.calls('eth_sendTransaction').length, 0);
  assert.equal(wallet.calls('eth_chainId').length, 0);
  assert.equal(wallet.listenerCount(), 0);
});
