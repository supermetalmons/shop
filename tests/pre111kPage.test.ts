import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import { encodePre111kReservation, resolvePre111kConfig, type Pre111kNetwork, type Pre111kStatus, type Pre111kConfirmResponse } from '../shared/ethereum/pre111k.ts';
import type { EIP1193Provider, EthereumProviderListener } from '../src/wallet/injectedEthereumProviders.ts';
import { pre111kApi } from '../src/ethereum/pre111kApi.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let { dom } = setupFrontendDom();
const imports = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: DirectPaymentPage } = await import('../src/ethereum/DirectPaymentPage.tsx');
const { BackgroundBlurProvider } = await import('../src/components/BackgroundBlurLayer.tsx');
imports.deregister(); dom.window.close();
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;
const clients: InstanceType<typeof QueryClient>[] = [];
let address = OWNER;
let reserved = 0;
let sendError: unknown;
let sendCount = 0;
let statusImpl: (network: Pre111kNetwork, wallet: string | null) => Promise<Pre111kStatus>;
let confirmImpl: (network: Pre111kNetwork, wallet: string, hash: string) => Promise<Pre111kConfirmResponse>;
let listeners: Map<string, Set<EthereumProviderListener>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function status(network: Pre111kNetwork, wallet: string | null): Pre111kStatus {
  return { config: resolvePre111kConfig(network, { contractAddress: CONTRACT, enabled: true }), wallet,
    totalReserved: reserved, reservedRelics: wallet ? reserved : null, remainingRelics: 18 - reserved, observedBlock: 1, blockHash: HASH };
}
function pendingKey(network: Pre111kNetwork = 'devnet') { return `mons.shop.pre111k.pending:${network === 'mainnet' ? 1 : 11155111}:${CONTRACT}:${OWNER}`; }
beforeEach(context => {
  const t = context as TestContext;
  ({ dom } = setupFrontendDom());
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  address = OWNER; reserved = 0; sendError = null; sendCount = 0; listeners = new Map();
  let chain = '0xaa36a7';
  const provider: EIP1193Provider = {
    async request({ method, params }) {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') { chain = (params as [{ chainId: string }])[0].chainId; return null; }
      if (method === 'eth_sendTransaction') { sendCount++; if (sendError) throw sendError; return HASH; }
      throw new Error(`Unexpected wallet method ${method}`);
    },
    on(event, listener) { const entries = listeners.get(event) ?? new Set(); entries.add(listener); listeners.set(event, entries); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  Object.defineProperty(window, 'ethereum', { configurable: true, value: provider });
  statusImpl = async (network, wallet) => status(network, wallet);
  confirmImpl = async (_network, _wallet, transactionHash) => ({ status: 'pending', confirmations: 0, reservationNonce: null, transactionHash });
  t.mock.method(pre111kApi, 'status', (network, wallet) => statusImpl(network, wallet));
  t.mock.method(pre111kApi, 'confirm', (network, wallet, hash) => confirmImpl(network, wallet, hash));
  t.mock.method(pre111kApi, 'prepare', async (network, wallet) => {
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const signature = `0x${'11'.repeat(65)}`;
    const config = status(network, wallet).config;
    return { network, wallet, nonce: reserved, deadline, expiresAtMs: deadline * 1000, signature,
      transaction: { to: CONTRACT, data: encodePre111kReservation(reserved, deadline, signature), value: `0x${BigInt(config.priceWei).toString(16)}`, chainId: config.chainId } };
  });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); dom.window.close(); });
function page(network: Pre111kNetwork = 'devnet', restore = true) {
  if (restore) window.localStorage.setItem('mons.shop.mi-note.ethereum-wallet', JSON.stringify({ type: 'legacy' }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const view = render(createElement(QueryClientProvider, { client }, createElement(BackgroundBlurProvider, null, createElement(DirectPaymentPage, { network }))));
  return { ...view, client, async ready() {
    await waitFor(() => assert.equal((view.getByRole('button', { name: `Reserve relic · ${network === 'mainnet' ? '2.3' : '0.0023'} ETH` }) as HTMLButtonElement).disabled, false), { timeout: 3_000 });
  }, reserve() { fireEvent.click(view.getByRole('button', { name: `Reserve relic · ${network === 'mainnet' ? '2.3' : '0.0023'} ETH` })); } };
}

test('wallet controls connect, show the address count and disconnect without requesting payment', async () => {
  reserved = 3;
  const view = page('devnet', false);
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Connect wallet' }) as HTMLButtonElement).disabled, false));
  assert.equal(view.queryByText('3 reserved'), null);
  fireEvent.click(view.getByRole('button', { name: 'Connect wallet' }));
  await view.ready();
  view.getByText('3 reserved'); view.getByText('0x1111…1111');
  fireEvent.click(view.getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => view.getByRole('button', { name: 'Connect wallet' }));
  assert.equal(view.queryByText('3 reserved'), null);
  assert.equal(sendCount, 0);
});

test('a reservation remains pending until confirmation and then refreshes its count', async () => {
  const confirmation = deferred<Pre111kConfirmResponse>();
  confirmImpl = () => confirmation.promise;
  const view = page();
  await view.ready();
  const reserve = view.getByRole('button', { name: 'Reserve relic · 0.0023 ETH' });
  fireEvent.click(reserve); fireEvent.click(reserve);
  await waitFor(() => view.getByRole('button', { name: 'Confirming reservation…' }));
  assert.equal(sendCount, 1);
  view.getByText('0 reserved');
  assert.equal(JSON.parse(window.localStorage.getItem(pendingKey())!).hash, HASH);
  reserved = 1;
  await act(async () => confirmation.resolve({ status: 'confirmed', confirmations: 3, transactionHash: HASH, reservationNonce: 0 }));
  await waitFor(() => view.getByText('1 reserved'));
  await view.ready();
  view.getByText('Relic reserved.');
  assert.equal(window.localStorage.getItem(pendingKey()), null);
});

test('wallet rejection clears the pending attempt and presents a retryable error', async () => {
  sendError = Object.assign(new Error('Rejected'), { code: 4001 });
  const view = page(); await view.ready(); view.reserve();
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /cancelled/i));
  await view.ready();
  assert.equal(window.localStorage.getItem(pendingKey()), null);
});

test('uncertain wallet submission preserves recovery state instead of allowing a duplicate payment', async () => {
  sendError = new Error('Provider disconnected');
  const view = page(); await view.ready(); view.reserve();
  await waitFor(() => view.getByRole('button', { name: 'Check your wallet…' }));
  await waitFor(() => view.getByRole('button', { name: 'Track transaction' }));
  const saved = JSON.parse(window.localStorage.getItem(pendingKey())!);
  assert.equal(saved.hash, null);
  fireEvent.click(view.getByRole('button', { name: 'Track transaction' }));
  fireEvent.change(view.getByLabelText('Transaction hash'), { target: { value: HASH } });
  fireEvent.submit(view.getByLabelText('Transaction hash').closest('form')!);
  await waitFor(() => view.getByRole('button', { name: 'Confirming reservation…' }));
  assert.equal(sendCount, 1);
  assert.equal(JSON.parse(window.localStorage.getItem(pendingKey())!).hash, HASH);
});

test('a saved transaction resumes confirmation on reload without resending ETH', async () => {
  window.localStorage.setItem(pendingKey(), JSON.stringify({ hash: HASH, nonce: 0, submittedAt: Date.now() }));
  const view = page();
  await waitFor(() => view.getByRole('button', { name: 'Confirming reservation…' }));
  assert.equal(sendCount, 0);
  assert.equal(view.getByRole('link', { name: 'View transaction ↗' }).getAttribute('href'), `https://sepolia.etherscan.io/tx/${HASH}`);
});

test('a failed receipt clears tracking and reports that no reservation completed', async () => {
  confirmImpl = async (_network, _wallet, transactionHash) => ({ status: 'failed', confirmations: 3, reservationNonce: 0, transactionHash });
  const view = page(); await view.ready(); view.reserve();
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /did not complete/));
  assert.equal(window.localStorage.getItem(pendingKey()), null);
  view.getByText('0 reserved'); await view.ready();
});

test('switching accounts clears old counts until the new address finishes loading', async () => {
  reserved = 2;
  const newStatus = deferred<Pre111kStatus>();
  const view = page(); await view.ready(); view.getByText('2 reserved');
  statusImpl = async (network, wallet) => wallet === OTHER ? newStatus.promise : status(network, wallet);
  await act(async () => { address = OTHER; for (const listener of listeners.get('accountsChanged') ?? []) listener([OTHER]); });
  view.getByText('Loading reservations…');
  assert.equal(view.queryByText('2 reserved'), null);
  await act(async () => newStatus.resolve({ ...status('devnet', OTHER), reservedRelics: 1 }));
  await waitFor(() => view.getByText('1 reserved'));
});

test('a sold-out fresh read prevents authorization and wallet submission', async () => {
  const view = page(); await view.ready();
  reserved = 18;
  view.reserve();
  await waitFor(() => view.getByRole('button', { name: 'All relics reserved' }));
  assert.equal(sendCount, 0);
});

test('undeployed mainnet remains closed and never displays a fake count', async () => {
  statusImpl = async (network, wallet) => ({ config: resolvePre111kConfig(network), wallet, totalReserved: null, reservedRelics: null,
    remainingRelics: null, observedBlock: null, blockHash: null });
  const view = page('mainnet');
  await waitFor(() => view.getByText('0x1111…1111'));
  await waitFor(() => view.getByText('Reservations unavailable'));
  view.getByText('Reservations are not open yet.');
  assert.equal(view.queryByText('0 reserved'), null);
  assert.equal(view.queryByText('Loading reservations…'), null);
  assert.equal((view.getByRole('button', { name: 'Reserve relic · 2.3 ETH' }) as HTMLButtonElement).disabled, true);
});
