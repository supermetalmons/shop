import assert from 'node:assert/strict';
import { testPre111kConfig } from './helpers/pre111k.ts';
import { registerHooks } from 'node:module';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { encodePre111kReservation, type Pre111kNetwork } from '../shared/ethereum/pre111k.ts';
import { pre111kApi } from '../src/ethereum/pre111kApi.ts';
import type { EIP1193Provider, EthereumProviderListener } from '../src/wallet/injectedEthereumProviders.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const imports = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { default: DirectPaymentPage } = await import('../src/ethereum/DirectPaymentPage.tsx');
imports.deregister(); dom.window.close();
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;
type Request = Parameters<EIP1193Provider['request']>[0];
const clients: InstanceType<typeof QueryClient>[] = [];
let prepareCalls = 0;
const NETWORKS = [
  { network: 'mainnet', chain: '0x1', wrongChain: '0xaa36a7', chainName: 'Ethereum', rpcUrl: 'https://ethereum-rpc.publicnode.com', explorerUrl: 'https://etherscan.io' },
  { network: 'devnet', chain: '0xaa36a7', wrongChain: '0x1', chainName: 'Sepolia', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', explorerUrl: 'https://sepolia.etherscan.io' },
] as const;

beforeEach(context => {
  const t = context as TestContext;
  ({ dom } = setupFrontendDom());
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  prepareCalls = 0;
  window.localStorage.setItem('mons.shop.pre111k.access-code', 'TESTPASS');
  t.mock.method(pre111kApi, 'verifyAccess', async () => ({ ok: true }));
  t.mock.method(pre111kApi, 'status', async (network, wallet) => ({ config: testPre111kConfig(network, { contractAddress: CONTRACT, enabled: true }), wallet,
    totalReserved: 0, reservedRelics: wallet ? 0 : null, remainingRelics: 17, observedBlock: 1, blockHash: HASH }));
  t.mock.method(pre111kApi, 'prepare', async (network, wallet) => {
    prepareCalls++;
    const config = testPre111kConfig(network, { contractAddress: CONTRACT, enabled: true });
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const signature = `0x${'11'.repeat(65)}`;
    return { network, wallet, nonce: 0, deadline, expiresAtMs: deadline * 1000, signature,
      transaction: { to: CONTRACT, chainId: config.chainId, data: encodePre111kReservation(0, deadline, signature), value: `0x${BigInt(config.priceWei).toString(16)}` } };
  });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); dom.window.close(); });

function walletFixture(chain = '0x1') {
  const requests: Request[] = [];
  const handlers = new Map<string, (request: Request) => unknown | Promise<unknown>>();
  const listeners = new Map<string, Set<EthereumProviderListener>>();
  const emit = (event: string, value?: unknown) => { for (const listener of listeners.get(event) ?? []) listener(value); };
  const provider: EIP1193Provider = {
    async request(request) {
      requests.push(request);
      const handler = handlers.get(request.method);
      if (handler) return handler(request);
      if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [OWNER];
      if (request.method === 'eth_chainId') return chain;
      if (request.method === 'wallet_switchEthereumChain') { chain = (request.params as [{ chainId: string }])[0].chainId; emit('chainChanged', chain); return null; }
      if (request.method === 'wallet_addEthereumChain') return null;
      if (request.method === 'eth_sendTransaction') return HASH;
      assert.fail(`Unexpected wallet request: ${request.method}`);
    },
    on(event, listener) { const entries = listeners.get(event) ?? new Set(); entries.add(listener); listeners.set(event, entries); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  return { provider, requests, handlers, emit, calls: (method: string) => requests.filter(request => request.method === method),
    listenerCount: () => [...listeners.values()].reduce((count, entries) => count + entries.size, 0),
    install() { Object.defineProperty(window, 'ethereum', { configurable: true, value: provider }); },
    announce(name: string) { window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new dom.window.CustomEvent('eip6963:announceProvider',
      { detail: { provider, info: { uuid: name, name, rdns: `com.example.${name}`, icon: '' } } }))); } };
}
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(done => { resolve = done; }); return { promise, resolve }; }
function page(network: Pre111kNetwork = 'mainnet') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client);
  const view = render(createElement(QueryClientProvider, { client }, createElement(DirectPaymentPage, { network })), { reactStrictMode: true });
  const button = () => view.getByRole('button', { name: `Reserve · ${network === 'mainnet' ? '2.23' : '0.00333'} ETH` }) as HTMLButtonElement;
  return { ...view, button, reserve: () => fireEvent.click(button()),
    async connect() {
      await waitFor(() => assert.equal(button().disabled, false));
      fireEvent.click(button());
      await waitFor(() => view.getByRole('button', { name: 'Disconnect' }));
    },
    async ready() {
      await waitFor(() => {
        view.getByRole('button', { name: 'Disconnect' });
        assert.equal(button().disabled, false);
      }, { timeout: 3_000 });
    } };
}

for (const restored of [true, false]) {
  test(`a saved wallet waits for account restoration before showing ${restored ? 'Disconnect' : 'Connect Wallet'}`, async () => {
    window.localStorage.setItem('mons.shop.mi-note.ethereum-wallet', JSON.stringify({ type: 'legacy' }));
    const wallet = walletFixture();
    const accounts = deferred();
    wallet.handlers.set('eth_accounts', () => accounts.promise);
    wallet.install();
    const view = page();
    await waitFor(() => assert.ok(wallet.calls('eth_accounts').length));
    assert.equal(view.queryByRole('button', { name: 'Connect Wallet' }) === null, true);
    await act(async () => accounts.resolve(restored ? [OWNER] : []));
    view.getByRole('button', { name: restored ? 'Disconnect' : 'Connect Wallet' });
  });
}

for (const { network, chain, wrongChain, chainName, rpcUrl, explorerUrl } of NETWORKS) {
  test(`${network} requires a second Reserve click after connecting before authorizing payment`, async () => {
    const wallet = walletFixture(chain); wallet.install();
    const view = page(network);
    view.getByRole('button', { name: 'Connect Wallet' });
    await view.connect(); await view.ready();
    assert.equal(wallet.calls('eth_requestAccounts').length, 1);
    assert.equal(prepareCalls, 0);
    assert.equal(wallet.calls('eth_sendTransaction').length, 0);
    view.reserve();
    await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
    assert.equal(prepareCalls, 1);
  });

  test(`${network} reservation switches networks before sending the contract call`, async () => {
    const wallet = walletFixture(wrongChain); wallet.install();
    const view = page(network); await view.connect(); await view.ready(); view.reserve();
    await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
    assert.deepEqual(wallet.calls('wallet_switchEthereumChain')[0].params, [{ chainId: chain }]);
    const methods = wallet.requests.map(request => request.method);
    assert.ok(methods.indexOf('wallet_switchEthereumChain') < methods.indexOf('eth_sendTransaction'));
    const transaction = (wallet.calls('eth_sendTransaction')[0].params as Array<{ to: string; chainId: string; value: string; data: string }>)[0];
    assert.equal(transaction.chainId, chain); assert.equal(transaction.to, CONTRACT);
    assert.equal(BigInt(transaction.value), network === 'mainnet' ? 2230000000000000000n : 3330000000000000n);
    assert.notEqual(transaction.data, '0x');
  });
  test(`unknown ${network} uses the fixed add-network fallback`, async () => {
    const wallet = walletFixture(wrongChain);
    wallet.handlers.set('wallet_switchEthereumChain', () => { wallet.handlers.delete('wallet_switchEthereumChain'); throw { code: 4902 }; });
    wallet.install(); const view = page(network); await view.connect(); await view.ready(); view.reserve();
    await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
    assert.deepEqual(wallet.calls('wallet_addEthereumChain')[0].params, [{ chainId: chain, chainName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [rpcUrl], blockExplorerUrls: [explorerUrl] }]);
  });
  test(`${network} refuses payment if the provider stays on another chain`, async () => {
    const wallet = walletFixture(wrongChain); wallet.handlers.set('wallet_switchEthereumChain', () => null); wallet.install();
    const view = page(network); await view.connect(); await view.ready(); view.reserve();
    await waitFor(() => assert.match(view.getByRole('alert').textContent!, new RegExp(`Switch your wallet to ${chainName}`)));
    assert.equal(wallet.calls('eth_sendTransaction').length, 0); await view.ready();
  });
}

for (const interruption of ['account change', 'chain change', 'disconnect', 'unmount'] as const) {
  test(`${interruption} during wallet preparation cancels the reservation before sending`, async () => {
    const wallet = walletFixture(); const pending = deferred(); wallet.handlers.set('eth_chainId', () => pending.promise); wallet.install();
    const view = page(); await view.connect(); await view.ready(); view.reserve();
    await waitFor(() => assert.equal(wallet.calls('eth_chainId').length, 1));
    await act(async () => {
      if (interruption === 'account change') wallet.emit('accountsChanged', [OTHER]);
      else if (interruption === 'chain change') wallet.emit('chainChanged', '0xaa36a7');
      else if (interruption === 'disconnect') wallet.emit('disconnect');
      else view.unmount();
      pending.resolve('0x1');
    });
    assert.equal(wallet.calls('eth_sendTransaction').length, 0);
    view.unmount(); assert.equal(wallet.listenerCount(), 0);
  });
}

test('multiple announced wallets require an explicit choice instead of sending through an arbitrary provider', async () => {
  const first = walletFixture(); const second = walletFixture(); first.announce('first'); second.announce('second');
  const view = page();
  await waitFor(() => assert.equal(view.button().disabled, false));
  view.reserve();
  await waitFor(() => view.getByRole('group', { name: 'Select Ethereum wallet' }));
  assert.equal(first.requests.length, 0); assert.equal(second.requests.length, 0);
  assert.equal(view.button().disabled, true);
  fireEvent.click(view.getByRole('button', { name: 'second' }));
  await view.ready();
  assert.equal(prepareCalls, 0);
  assert.equal(second.calls('eth_sendTransaction').length, 0);
  view.reserve();
  await waitFor(() => assert.equal(second.calls('eth_sendTransaction').length, 1));
  assert.equal(first.requests.length, 0);
});

test('a cancelled wallet connection can be retried through Reserve without submitting payment', async () => {
  const wallet = walletFixture();
  wallet.handlers.set('eth_requestAccounts', () => { throw { code: 4001 }; });
  wallet.install();
  const view = page();
  await waitFor(() => assert.equal(view.button().disabled, false));
  view.reserve();
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /Wallet connection was cancelled/));
  const feedback = view.getByRole('region', { name: 'Reservation messages' });
  assert.equal(feedback.tabIndex, 0);
  feedback.focus();
  assert.equal(document.activeElement === feedback, true);
  assert.equal(view.queryByRole('button', { name: 'Disconnect' }), null);
  assert.equal((view.getByRole('button', { name: 'Connect Wallet' }) as HTMLButtonElement).disabled, false);
  assert.equal(view.button().disabled, false);
  assert.equal(prepareCalls, 0);
  assert.equal(wallet.calls('eth_sendTransaction').length, 0);
  wallet.handlers.delete('eth_requestAccounts');
  await view.connect(); await view.ready();
  assert.equal(view.queryByRole('region', { name: 'Reservation messages' }), null);
  assert.equal(view.container.querySelector('.relic-preorder__feedback')!.hasAttribute('tabindex'), false);
  assert.equal(wallet.calls('eth_requestAccounts').length, 2);
  assert.equal(prepareCalls, 0);
  assert.equal(wallet.calls('eth_sendTransaction').length, 0);
  view.reserve();
  await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, 1));
});

for (const [trigger, cancelWithEscape] of [['Reserve', false], ['Connect Wallet', true]] as const) {
  test(`cancelling wallet choice with ${cancelWithEscape ? 'Escape' : 'Cancel'} restores focus to ${trigger}`, async () => {
    const first = walletFixture(); const second = walletFixture(); first.announce('first'); second.announce('second');
    const view = page();
    await waitFor(() => assert.equal(view.button().disabled, false));
    const opener = trigger === 'Reserve' ? view.button() : view.getByRole('button', { name: trigger });
    fireEvent.click(opener);
    const choices = await waitFor(() => view.getByRole('group', { name: 'Select Ethereum wallet' }));
    assert.equal(view.button().disabled, true);
    if (cancelWithEscape) fireEvent.keyDown(choices, { key: 'Escape' });
    else fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => assert.ok(document.activeElement === opener));
    assert.equal(view.queryByRole('group', { name: 'Select Ethereum wallet' }), null);
    assert.equal(view.button().disabled, false);
    assert.equal(prepareCalls, 0);
    assert.equal(first.requests.length, 0); assert.equal(second.requests.length, 0);
  });
}
