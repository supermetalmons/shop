import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testPre111kConfig } from './helpers/pre111k.ts';
import { registerHooks } from 'node:module';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { createElement } from 'react';
import { encodePre111kReservation, type Pre111kConfirmResponse, type Pre111kNetwork, type Pre111kStatus } from '../shared/ethereum/pre111k.ts';
import { formatEtherAmount } from '../shared/ethereum/protocol.ts';
import type { EIP1193Provider, EthereumProviderListener } from '../src/wallet/injectedEthereumProviders.ts';
import { pre111kApi } from '../src/ethereum/pre111kApi.ts';
import { EthereumApiError } from '../src/ethereum/api.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

let { dom, setMediaQueryMatches } = setupFrontendDom();
const imports = registerHooks({ load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); } });
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider, focusManager, onlineManager } = await import('@tanstack/react-query');
const { default: DirectPaymentPage } = await import('../src/ethereum/DirectPaymentPage.tsx');
const { BackgroundBlurProvider } = await import('../src/components/BackgroundBlurLayer.tsx');
imports.deregister(); dom.window.close();
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'ab'.repeat(32)}`;
const NEXT_HASH = `0x${'cd'.repeat(32)}`;
const ACCESS_KEY = 'mons.shop.pre111k.access-code';
const ACCESS_CODE = 'TESTPASS';
const { vars } = JSON.parse(readFileSync(new URL('../cloud/workers/api/wrangler.jsonc', import.meta.url), 'utf8'));
const configuredPriceWei = { mainnet: vars.ETHEREUM_PRE111K_MAINNET_PRICE_WEI, devnet: vars.ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI };
const clients: InstanceType<typeof QueryClient>[] = [];
let address = OWNER;
let reserved = 0;
let sendError: unknown;
let sendCount = 0;
let connectCount = 0;
let sendImpl: () => Promise<string>;
let preparedCodes: string[];
let preparedNonces: number[];
let prepareError: unknown;
let verifiedCodes: string[];
let verifyImpl: (code: string, signal?: AbortSignal) => Promise<{ ok: true }>;
let statusImpl: (network: Pre111kNetwork, wallet: string | null) => Promise<Pre111kStatus>;
let confirmImpl: typeof pre111kApi.confirm;
let listeners: Map<string, Set<EthereumProviderListener>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function status(network: Pre111kNetwork, wallet: string | null): Pre111kStatus {
  return { config: testPre111kConfig(network, { contractAddress: CONTRACT, enabled: true }), wallet,
    totalReserved: reserved, reservedRelics: wallet ? reserved : null, remainingRelics: 17 - reserved, observedBlock: 1, blockHash: HASH };
}
function pendingKey(network: Pre111kNetwork = 'devnet') { return `mons.shop.pre111k.pending:${network === 'mainnet' ? 1 : 11155111}:${CONTRACT}:${OWNER}`; }
function lastTransactionKey(network: Pre111kNetwork = 'devnet', wallet = OWNER) {
  return `mons.shop.pre111k.last-transaction:${network === 'mainnet' ? 1 : 11155111}:${CONTRACT}:${wallet}`;
}
beforeEach(context => {
  const t = context as TestContext;
  ({ dom, setMediaQueryMatches } = setupFrontendDom());
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  address = OWNER; reserved = 0; sendError = null; sendCount = 0; connectCount = 0; listeners = new Map();
  preparedCodes = []; preparedNonces = []; prepareError = null; verifiedCodes = [];
  sendImpl = async () => { if (sendError) throw sendError; return HASH; };
  verifyImpl = async () => ({ ok: true });
  window.localStorage.setItem(ACCESS_KEY, ACCESS_CODE);
  let chain = '0xaa36a7';
  const provider: EIP1193Provider = {
    async request({ method, params }) {
      if (method === 'eth_requestAccounts') connectCount++;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') { chain = (params as [{ chainId: string }])[0].chainId; return null; }
      if (method === 'eth_sendTransaction') { sendCount++; return sendImpl(); }
      throw new Error(`Unexpected wallet method ${method}`);
    },
    on(event, listener) { const entries = listeners.get(event) ?? new Set(); entries.add(listener); listeners.set(event, entries); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  Object.defineProperty(window, 'ethereum', { configurable: true, value: provider });
  statusImpl = async (network, wallet) => status(network, wallet);
  confirmImpl = async (_network, _wallet, transactionHash) => ({ status: 'pending', confirmations: 0, transactionHash, reservationNonce: null });
  t.mock.method(pre111kApi, 'verifyAccess', (code, signal) => { verifiedCodes.push(code); return verifyImpl(code, signal); });
  t.mock.method(pre111kApi, 'status', (network, wallet) => statusImpl(network, wallet));
  t.mock.method(pre111kApi, 'confirm', (...args: Parameters<typeof pre111kApi.confirm>) => confirmImpl(...args));
  t.mock.method(pre111kApi, 'prepare', async (network, wallet, code) => {
    preparedCodes.push(code);
    preparedNonces.push(reserved);
    if (prepareError) throw prepareError;
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const signature = `0x${'11'.repeat(65)}`;
    const config = status(network, wallet).config;
    return { network, wallet, nonce: reserved, deadline, expiresAtMs: deadline * 1000, signature,
      transaction: { to: CONTRACT, data: encodePre111kReservation(reserved, deadline, signature), value: `0x${BigInt(config.priceWei).toString(16)}`, chainId: config.chainId } };
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  dom.window.close();
});
function page(network: Pre111kNetwork = 'devnet', restore = true) {
  if (restore) window.localStorage.setItem('mons.shop.mi-note.ethereum-wallet', JSON.stringify({ type: 'legacy' }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const view = render(createElement(QueryClientProvider, { client }, createElement(BackgroundBlurProvider, null, createElement(DirectPaymentPage, { network }))));
  return { ...view, client, primary: () => view.container.querySelector('.relic-preorder__reserve') as HTMLButtonElement,
    reservedLabel: () => view.container.querySelector('.relic-preorder__reserved')?.textContent ?? null,
    availability: () => view.container.querySelector('.mint-panel__availability')?.textContent,
    rerenderNetwork(next: Pre111kNetwork) {
      network = next;
      view.rerender(createElement(QueryClientProvider, { client }, createElement(BackgroundBlurProvider, null, createElement(DirectPaymentPage, { network }))));
    }, async ready() {
    await waitFor(() => {
      view.getByTitle(address);
      assert.equal((view.getByRole('button', { name: `Reserve · ${network === 'mainnet' ? '2.23' : '0.00333'} ETH` }) as HTMLButtonElement).disabled, false);
    }, { timeout: 3_000 });
  }, reserve() { fireEvent.click(view.getByRole('button', { name: `Reserve · ${network === 'mainnet' ? '2.23' : '0.00333'} ETH` })); } };
}

async function disconnectProvider() {
  await act(async () => {
    for (const listener of listeners.get('disconnect') ?? []) listener();
  });
}

for (const during of ['status', 'prepare'] as const) {
  test(`a price change during ${during} refreshes the displayed amount and requires another click`, async t => {
    const view = page();
    await view.ready();
    const repriced = () => {
      statusImpl = async (network, wallet) => {
        const current = status(network, wallet);
        return { ...current, config: { ...current.config, priceWei: '1' } };
      };
    };
    if (during === 'status') repriced();
    const originalPrepare = pre111kApi.prepare;
    t.mock.method(pre111kApi, 'prepare', async (...args: Parameters<typeof pre111kApi.prepare>) => {
      const quote = await originalPrepare(...args);
      repriced();
      return { ...quote, transaction: { ...quote.transaction, value: '0x1' } };
    });
    view.reserve();
    const label = 'Reserve · 0.000000000000000001 ETH';
    await waitFor(() => assert.equal((view.getByRole('button', { name: label }) as HTMLButtonElement).disabled, false));
    assert.match(view.getByRole('alert').textContent ?? '', /price changed/i);
    assert.equal(sendCount, 0);
    fireEvent.click(view.getByRole('button', { name: label }));
    await waitFor(() => assert.equal(sendCount, 1));
  });
}

test('Connect Wallet shows the address and reservations until the provider disconnects', async () => {
  reserved = 3;
  const view = page('devnet', false);
  const reserve = () => view.getByRole('button', { name: 'Reserve · 0.00333 ETH' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(reserve().disabled, false));
  const connect = view.getByRole('button', { name: 'Connect Wallet' });
  assert.equal(view.reservedLabel(), null);
  fireEvent.click(connect);
  await view.ready();
  assert.equal(view.reservedLabel(), '3 reserved');
  const count = view.getByText('reserved');
  const walletAddress = view.getByText('0x1111…1111');
  assert.ok(walletAddress.compareDocumentPosition(count) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(view.queryByRole('button', { name: 'Disconnect' }), null);
  await disconnectProvider();
  await waitFor(() => assert.equal(view.queryByTitle(address), null));
  assert.equal((view.getByRole('button', { name: 'Connect Wallet' }) as HTMLButtonElement).disabled, false);
  assert.equal(reserve().disabled, false);
  assert.equal(view.reservedLabel(), null);
  assert.equal(sendCount, 0);
  assert.deepEqual(preparedCodes, []);
});

test('Retry comes before Connect Wallet on wide screens and after it on narrow screens', async () => {
  statusImpl = async () => { throw new Error('Unavailable'); };
  const view = page('devnet', false);
  const retry = await view.findByRole('button', { name: 'Retry' }, { timeout: 3_000 });
  const connect = view.getByRole('button', { name: 'Connect Wallet' });
  assert.ok(retry.compareDocumentPosition(connect) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  act(() => setMediaQueryMatches('(max-width: 860px)', true));
  assert.ok(connect.compareDocumentPosition(retry) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
});

for (const unavailable of ['API failure', 'disabled reservations'] as const) {
  test(`${unavailable} still allows wallet connection but blocks reservation`, async () => {
    if (unavailable === 'API failure') statusImpl = async () => { throw new Error('Unavailable'); };
    else statusImpl = async (network, wallet) => ({
      ...status(network, wallet),
      config: testPre111kConfig(network, { contractAddress: CONTRACT, enabled: false, priceWei: configuredPriceWei[network] }),
    });
    const view = page('devnet', false);
    const label = `Reserve · ${formatEtherAmount(configuredPriceWei.devnet, 18)} ETH`;
    const unavailableMessage = () => unavailable === 'API failure'
      ? view.findByRole('button', { name: 'Retry' }, { timeout: 3_000 })
      : view.findByText('Reservations are not open yet.');
    await unavailableMessage();
    await waitFor(() => assert.equal((view.getByRole('button', { name: label }) as HTMLButtonElement).disabled, false));
    fireEvent.click(view.getByRole('button', { name: label }));
    await waitFor(() => view.getByTitle(address));
    await unavailableMessage();
    await waitFor(() => assert.equal((view.getByRole('button', { name: label }) as HTMLButtonElement).disabled, true));
    fireEvent.click(view.getByRole('button', { name: label }));
    assert.deepEqual(preparedCodes, []);
    assert.equal(sendCount, 0);
  });
}

for (const network of ['devnet'] as const) {
  for (const [remaining, availability] of [[17, '17 / 18 left'], [1, '01 / 18 left']] as const) {
    test(`${network} displays and allows purchase with ${remaining} remaining while preserving purchase counts and nonce`, async () => {
      reserved = 17 - remaining;
      const view = page(network); await view.ready();
      assert.equal(view.availability(), availability);
      const cached = () => view.client.getQueryData<Pre111kStatus>(['pre111k', network, OWNER])!;
      assert.equal(cached().remainingRelics, remaining);
      assert.equal(cached().totalReserved, reserved);
      assert.equal(cached().reservedRelics, reserved);
      assert.equal(cached().config.maxRelics, 17);
      assert.equal(view.reservedLabel(), `${reserved} reserved`);
      view.reserve();
      await waitFor(() => assert.equal(sendCount, 1));
      assert.deepEqual(preparedNonces, [reserved]);
      assert.deepEqual(preparedCodes, [ACCESS_CODE]);
      assert.equal(cached().remainingRelics, remaining);
      assert.equal(cached().reservedRelics, reserved);
    });
  }

  for (const connected of [false, true]) {
    test(`${network} ends preorders at zero remaining with the wallet ${connected ? 'connected' : 'disconnected'}`, async () => {
      reserved = 17;
      const view = page(network, connected);
      if (connected) await waitFor(() => view.getByTitle(address));
      await waitFor(() => {
        view.getByRole('button', { name: 'Preorders ended' });
        assert.equal(view.availability(), '00 / 18 left');
        assert.equal(view.primary().disabled, true);
      });
      await act(async () => { fireEvent.click(view.primary()); });
      assert.equal(connectCount, 0);
      assert.deepEqual(preparedCodes, []);
      assert.equal(sendCount, 0);
      if (!connected) assert.equal(view.queryByTitle(address), null);
    });
  }

  test(`${network} blocks preparation when the final slot sells before preparation`, async () => {
    reserved = 16;
    const view = page(network); await view.ready();
    assert.equal(view.availability(), '01 / 18 left');
    reserved = 17;
    view.reserve();
    await waitFor(() => assert.equal(view.getByRole('alert').textContent, 'Preorders ended'));
    const ended = view.getByRole('button', { name: 'Preorders ended' }) as HTMLButtonElement;
    assert.equal(ended.disabled, true);
    assert.equal(view.availability(), '00 / 18 left');
    assert.equal(view.client.getQueryData<Pre111kStatus>(['pre111k', network, OWNER])?.remainingRelics, 0);
    assert.deepEqual(preparedCodes, []);
    assert.equal(sendCount, 0);
  });

  for (const connected of [false, true]) {
    test(`${network} polling updates availability and the ended button while ${connected ? 'connected' : 'disconnected'}`, async t => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      reserved = 15;
      const view = page(network, connected);
      if (connected) await view.ready();
      await waitFor(() => assert.equal(view.availability(), '02 / 18 left'));
      for (const [remaining, availability] of [[1, '01 / 18 left'], [0, '00 / 18 left'], [1, '01 / 18 left']] as const) {
        reserved = 17 - remaining;
        await act(async () => { t.mock.timers.tick(connected ? 3_000 : 10_000); });
        await waitFor(() => {
          assert.equal(view.availability(), availability);
          assert.equal(view.primary().disabled, remaining === 0);
          assert.equal(Boolean(view.queryByRole('button', { name: 'Preorders ended' })), remaining === 0);
        });
        assert.equal(view.client.getQueryData<Pre111kStatus>(['pre111k', network, connected ? OWNER : null])?.remainingRelics, remaining);
      }
      assert.equal(connectCount, 0);
      assert.deepEqual(preparedCodes, []);
      assert.equal(sendCount, 0);
    });
  }

  test(`${network} preserves pending, unknown, and failed availability without inventing zero`, async () => {
    const pending = deferred<void>();
    statusImpl = async (requestedNetwork, wallet) => {
      await pending.promise;
      return { config: testPre111kConfig(requestedNetwork, { priceWei: '0' }), wallet, totalReserved: null, reservedRelics: null,
        remainingRelics: null, observedBlock: null, blockHash: null };
    };
    const view = page(network);
    const initialPrice = view.getByText(`${formatEtherAmount(configuredPriceWei[network], 18)} ETH`);
    assert.ok(view.primary().contains(initialPrice));
    await waitFor(() => view.getByTitle(address));
    view.getByRole('status', { name: 'Loading availability' });
    assert.notEqual(view.availability(), '00 / 18 left');
    assert.equal(view.primary().disabled, true);
    await act(async () => pending.resolve());
    await waitFor(() => assert.equal(view.availability(), '— / 18 left'));
    assert.equal(view.getByText('0 ETH'), initialPrice);
    view.getByRole('button', { name: 'Reserve · 0 ETH' });
    assert.equal(view.queryByRole('button', { name: 'Preorders ended' }), null);
    statusImpl = async (requestedNetwork, wallet) => status(requestedNetwork, wallet);
    reserved = 17;
    await act(async () => { await view.client.refetchQueries({ queryKey: ['pre111k', network, OWNER] }); });
    await waitFor(() => view.getByRole('button', { name: 'Preorders ended' }));
    statusImpl = async () => { throw new Error('Unavailable'); };
    await act(async () => { await view.client.refetchQueries({ queryKey: ['pre111k', network, OWNER] }); });
    await waitFor(() => assert.equal(view.availability(), '— / 18 left'));
    view.getByRole('button', { name: 'Retry' });
    assert.equal(view.primary().disabled, true);
    assert.equal(view.queryByRole('button', { name: 'Preorders ended' }), null);
    assert.equal(view.client.getQueryData<Pre111kStatus>(['pre111k', network, OWNER])?.remainingRelics, 0);
    assert.deepEqual(preparedCodes, []);
    assert.equal(sendCount, 0);
  });

  test(`${network} shows a new transaction only until remount while allowing another reservation before mining`, async () => {
    const sent = deferred<string>();
    sendImpl = () => sent.promise;
    const view = page(network); await view.ready();
    view.reserve(); fireEvent.click(view.primary());
    await waitFor(() => assert.equal(sendCount, 1));
    assert.equal(view.primary().disabled, true);
    assert.equal(view.queryByRole('link', { name: 'View transaction ↗' }), null);
    await act(async () => sent.resolve(`0x${'AB'.repeat(32)}`));
    await view.ready();
    assert.equal(window.localStorage.getItem(lastTransactionKey(network)), null);
    assert.equal(window.localStorage.getItem(pendingKey(network)), null);
    assert.equal(view.reservedLabel(), '0 reserved');
    assert.equal(view.queryByText('Relic reserved.'), null);
    assert.equal(view.queryByRole('button', { name: 'Confirming reservation…' }), null);
    assert.equal(view.getByRole('link', { name: 'View transaction ↗' }).getAttribute('href'), `${status(network, OWNER).config.explorerUrl}/tx/${HASH}`);
    view.unmount();
    const remounted = page(network); await remounted.ready();
    assert.equal(remounted.queryByRole('link', { name: 'View transaction ↗' }), null);
    assert.equal(sendCount, 1);
  });

  for (const result of ['confirmed', 'failed'] as const) {
    test(`${network} removes the transaction link when its own receipt is ${result}`, async t => {
      t.mock.timers.enable({ apis: ['setInterval'] });
      const view = page(network); await view.ready(); view.reserve();
      await waitFor(() => view.getByRole('link', { name: 'View transaction ↗' }));
      confirmImpl = async (_network, _wallet, transactionHash) => ({ status: result, confirmations: 3, transactionHash, reservationNonce: 0 });
      await act(async () => { t.mock.timers.tick(3_000); });
      await waitFor(() => assert.equal(view.queryByRole('link', { name: 'View transaction ↗' }) === null, true));
      assert.equal(view.queryByRole('region', { name: 'Reservation messages' }), null);
      assert.equal(window.localStorage.getItem(lastTransactionKey(network)), null);
    });
  }
}

test('confirming an earlier transaction cannot remove the latest pending transaction link', async () => {
  const firstConfirmation = deferred<Pre111kConfirmResponse>();
  let firstSignal: AbortSignal | undefined;
  confirmImpl = async (_network, _wallet, transactionHash, signal) => {
    if (transactionHash === HASH) { firstSignal = signal; return firstConfirmation.promise; }
    return { status: 'pending', confirmations: 0, transactionHash, reservationNonce: null };
  };
  const view = page(); await view.ready(); view.reserve();
  await waitFor(() => assert.ok(firstSignal));
  await view.ready();
  sendImpl = async () => NEXT_HASH;
  view.reserve();
  const link = () => view.queryByRole('link', { name: 'View transaction ↗' })?.getAttribute('href');
  await waitFor(() => assert.equal(link(), `https://sepolia.etherscan.io/tx/${NEXT_HASH}`));
  assert.deepEqual(preparedNonces, [0, 0]);
  assert.equal(firstSignal?.aborted, true);
  reserved = 1;
  await act(async () => {
    firstConfirmation.resolve({ status: 'confirmed', confirmations: 3, transactionHash: HASH, reservationNonce: 0 });
    await view.client.refetchQueries({ queryKey: ['pre111k', 'devnet', OWNER] });
  });
  await waitFor(() => assert.equal(view.reservedLabel(), '1 reserved'));
  assert.equal(link(), `https://sepolia.etherscan.io/tx/${NEXT_HASH}`);
  confirmImpl = async (_network, _wallet, transactionHash) => ({ status: 'failed', confirmations: 3, transactionHash, reservationNonce: 0 });
  await act(async () => { await view.client.refetchQueries({ queryKey: ['pre111k-confirmation'] }); });
  await waitFor(() => assert.equal(link(), undefined));
});

for (const { name, error, message } of [
  { name: 'wallet rejection', error: Object.assign(new Error('Rejected'), { code: 4001 }), message: /cancelled/i },
  { name: 'insufficient funds', error: Object.assign(new Error('insufficient funds for gas * price + value'), { code: -32000 }), message: /insufficient funds/i },
  { name: 'provider failure', error: new Error('Provider disconnected'), message: /Provider disconnected/ },
]) {
  test(`${name} releases the active request and allows a new reservation`, async () => {
    window.localStorage.setItem(lastTransactionKey(), HASH);
    sendError = error;
    const view = page(); await view.ready(); view.reserve();
    await waitFor(() => assert.match(view.getByRole('alert').textContent!, message));
    await view.ready();
    assert.equal(window.localStorage.getItem(pendingKey()), null);
    assert.equal(window.localStorage.getItem(lastTransactionKey()), HASH);
    assert.equal(view.queryByRole('link', { name: 'View transaction ↗' }), null);
    assert.equal(view.queryByRole('button', { name: 'Track transaction' }), null);
    assert.equal(view.queryByRole('textbox', { name: 'Transaction hash' }), null);
    sendImpl = async () => NEXT_HASH;
    view.reserve();
    await waitFor(() => assert.equal(sendCount, 2));
    await view.ready();
    assert.equal(view.queryByRole('alert'), null);
    assert.equal(window.localStorage.getItem(lastTransactionKey()), HASH);
    assert.equal(view.getByRole('link', { name: 'View transaction ↗' }).getAttribute('href'), `https://sepolia.etherscan.io/tx/${NEXT_HASH}`);
  });
}

for (const completion of ['hash', 'error'] as const) {
  test(`a polled count increase releases a hung send and its late ${completion} cannot affect the next attempt`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const oldSend = deferred<string>();
    const nextSend = deferred<string>();
    sendImpl = () => oldSend.promise;
    const view = page(); await view.ready(); view.reserve();
    await waitFor(() => assert.equal(sendCount, 1));
    await act(async () => { t.mock.timers.tick(3_000); });
    assert.equal(view.primary().disabled, true);
    assert.equal(window.localStorage.getItem(pendingKey()), null);
    reserved = 1;
    await act(async () => { t.mock.timers.tick(3_000); });
    await view.ready();
    assert.equal(view.reservedLabel(), '1 reserved');
    assert.equal(view.queryByText('Relic reserved.'), null);
    sendImpl = () => nextSend.promise;
    view.reserve();
    await waitFor(() => assert.equal(sendCount, 2));
    assert.deepEqual(preparedNonces, [0, 1]);
    await act(async () => {
      if (completion === 'hash') oldSend.resolve(HASH);
      else oldSend.reject(new Error('Old wallet failure'));
    });
    assert.equal(view.primary().disabled, true);
    assert.equal(view.queryByRole('alert'), null);
    assert.equal(window.localStorage.getItem(lastTransactionKey()), null);
    await act(async () => nextSend.resolve(NEXT_HASH));
    await view.ready();
    assert.equal(window.localStorage.getItem(lastTransactionKey()), null);
    assert.equal(view.getByRole('link', { name: 'View transaction ↗' }).getAttribute('href'), `https://sepolia.etherscan.io/tx/${NEXT_HASH}`);
  });
}

test('a late hash is tracked by receipt even when a count increase already released Reserve', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const sent = deferred<string>();
  sendImpl = () => sent.promise;
  const view = page(); await view.ready(); view.reserve();
  await waitFor(() => assert.equal(sendCount, 1));
  reserved = 1;
  await act(async () => { t.mock.timers.tick(3_000); });
  await view.ready();
  assert.equal(view.queryByRole('link', { name: 'View transaction ↗' }), null);
  await act(async () => sent.resolve(HASH));
  assert.equal(view.primary().disabled, false);
  assert.equal(window.localStorage.getItem(lastTransactionKey()), null);
  view.getByRole('link', { name: 'View transaction ↗' });
  confirmImpl = async (_network, _wallet, transactionHash) => ({ status: 'confirmed', confirmations: 3, transactionHash, reservationNonce: 0 });
  await act(async () => { t.mock.timers.tick(3_000); });
  await waitFor(() => assert.equal(view.queryByRole('link', { name: 'View transaction ↗' }) === null, true));
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(sendCount, 1);
});

for (const interruption of ['disconnect', 'account change', 'network change', 'unmount'] as const) {
  test(`${interruption} invalidates an active request before another reservation starts`, async () => {
    const oldSend = deferred<string>();
    sendImpl = () => oldSend.promise;
    const view = page(); await view.ready(); view.reserve();
    await waitFor(() => assert.equal(sendCount, 1));
    let current = view;
    if (interruption === 'disconnect') {
      await disconnectProvider();
      await waitFor(() => assert.equal(view.primary().disabled, false));
      view.reserve();
    } else if (interruption === 'account change') {
      await act(async () => {
        address = OTHER;
        for (const listener of listeners.get('accountsChanged') ?? []) listener([OTHER]);
      });
    } else if (interruption === 'network change') {
      view.rerenderNetwork('mainnet');
      view.getByRole('link', { name: 'Claim on VVV' });
      view.rerenderNetwork('devnet');
    } else {
      view.unmount();
      current = page();
    }
    await current.ready();
    sendImpl = async () => NEXT_HASH;
    current.reserve();
    await waitFor(() => assert.equal(sendCount, 2));
    await current.ready();
    await act(async () => oldSend.resolve(HASH));
    assert.equal(current.queryByRole('alert'), null);
    assert.equal(current.primary().disabled, false);
    assert.equal(window.localStorage.getItem(lastTransactionKey('devnet', address)), null);
    assert.equal(current.getByRole('link', { name: 'View transaction ↗' }).getAttribute('href'), `https://sepolia.etherscan.io/tx/${NEXT_HASH}`);
    if (interruption === 'account change' || interruption === 'network change') {
      assert.equal(window.localStorage.getItem(lastTransactionKey()), null);
    }
  });
}

for (const { name, legacy } of [
  { name: 'valid hash', legacy: JSON.stringify({ hash: `0x${'AB'.repeat(32)}`, nonce: 0, submittedAt: 1 }) },
  { name: 'missing hash', legacy: JSON.stringify({ hash: null, nonce: 0, submittedAt: 1 }) },
  { name: 'invalid hash', legacy: JSON.stringify({ hash: 'not-a-hash', nonce: 0, submittedAt: 1 }) },
  { name: 'malformed JSON', legacy: '{' },
]) {
  test(`a legacy pending record with ${name} never restores a transaction link or locks reservations`, async () => {
    window.localStorage.setItem(pendingKey(), legacy);
    const view = page(); await view.ready();
    assert.equal(view.queryByRole('link', { name: 'View transaction ↗' }), null);
    assert.equal(view.queryByRole('button', { name: 'Confirming reservation…' }), null);
    assert.equal(view.queryByText('Relic reserved.'), null);
    assert.equal(sendCount, 0);
    assert.deepEqual(preparedCodes, []);
  });
}

test('previously saved transactions never restore a link', async () => {
  window.localStorage.setItem(lastTransactionKey(), NEXT_HASH);
  window.localStorage.setItem(pendingKey(), JSON.stringify({ hash: HASH, nonce: 0, submittedAt: 1 }));
  const view = page(); await view.ready();
  assert.equal(view.queryByRole('link', { name: 'View transaction ↗' }), null);
});

test('a count decrease displays zero reservations even if the next refresh fails', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  reserved = 1;
  window.localStorage.setItem(lastTransactionKey(), HASH);
  const view = page(); await view.ready(); assert.equal(view.reservedLabel(), '1 reserved');
  reserved = 0;
  await act(async () => { t.mock.timers.tick(3_000); });
  await waitFor(() => assert.equal(view.reservedLabel(), '0 reserved'));
  assert.equal(view.queryByText('Relic reserved.'), null);
  assert.equal(view.primary().disabled, false);
  assert.equal(view.queryByRole('link', { name: 'View transaction ↗' }), null);
  statusImpl = async () => { throw new Error('Unavailable'); };
  await act(async () => { await view.client.refetchQueries({ queryKey: ['pre111k', 'devnet', OWNER] }); });
  await view.findByRole('button', { name: 'Retry' });
  assert.equal(view.reservedLabel(), '0 reserved');
});

test('switching accounts clears old counts and preserves the latest network price while loading', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const switchAccount = (next: string) => act(async () => {
    address = next;
    for (const listener of listeners.get('accountsChanged') ?? []) listener([next]);
  });
  reserved = 2;
  const newStatus = deferred<Pre111kStatus>();
  const view = page(); await view.ready(); assert.equal(view.reservedLabel(), '2 reserved');
  statusImpl = async (network, wallet) => wallet === OTHER ? newStatus.promise : status(network, wallet);
  await switchAccount(OTHER);
  view.getByText('0x2222…2222');
  const loading = view.getByRole('status', { name: 'Loading reserved count' });
  assert.equal(loading.querySelectorAll('.mint-panel__digit-placeholder').length, 1);
  assert.equal(view.reservedLabel()?.trim(), 'reserved');
  const updatedAt = view.client.getQueryState(['pre111k', 'devnet', OWNER])!.dataUpdatedAt + 1;
  t.mock.method(Date, 'now', () => updatedAt);
  const updated = status('devnet', OTHER);
  updated.config.priceWei = '0';
  await act(async () => newStatus.resolve({ ...updated, reservedRelics: 1 }));
  await waitFor(() => assert.equal(view.reservedLabel(), '1 reserved'));
  view.getByText('0 ETH');
  await switchAccount(OWNER);
  assert.equal(view.reservedLabel(), '2 reserved');
  statusImpl = async () => { throw new Error('Unavailable'); };
  await act(async () => { await view.client.refetchQueries({ queryKey: ['pre111k', 'devnet', OWNER] }); });
  await view.findByRole('button', { name: 'Retry' });
  assert.equal((view.getByRole('button', { name: 'Reserve · 0 ETH' }) as HTMLButtonElement).disabled, true);
  const pending = deferred<Pre111kStatus>();
  statusImpl = () => pending.promise;
  await switchAccount('0x4444444444444444444444444444444444444444');
  assert.equal(view.primary().disabled, true);
  view.getByRole('button', { name: 'Reserve · 0 ETH' });
});

test('undeployed devnet remains closed and never displays a fake count', async () => {
  statusImpl = async (network, wallet) => ({ config: testPre111kConfig(network), wallet, totalReserved: null, reservedRelics: null,
    remainingRelics: null, observedBlock: null, blockHash: null });
  const view = page('devnet');
  await waitFor(() => view.getByText('0x1111…1111'));
  await waitFor(() => view.getByText('Reservations are not open yet.'));
  assert.equal(view.queryByText('Reservations unavailable'), null);
  assert.equal(view.reservedLabel(), null);
  assert.equal(view.queryByText('Loading reservations…'), null);
  assert.equal((view.getByRole('button', { name: 'Reserve · 0.00333 ETH' }) as HTMLButtonElement).disabled, true);
});

for (const network of ['devnet'] as const) {
  test(`${network} hides the header and keeps reservation content inactive until code verification`, async () => {
    window.localStorage.removeItem(ACCESS_KEY);
    const view = page(network);
    assert.equal(Boolean(view.queryByRole('link', { name: 'Go to mons.shop home' })), false);
    const input = view.getByRole('textbox', { name: 'Secret code' }) as HTMLInputElement;
    assert.equal(input.type, 'text');
    assert.equal(input.placeholder, 'SECRET CODE');
    assert.notEqual(document.activeElement, input);
    assert.equal(view.queryByRole('button', { name: /Reserve|Preorders ended/ }), null);
    const content = view.container.querySelector('.relic-page__content')!;
    assert.equal(content.getAttribute('aria-hidden'), 'true');
    assert.equal(content.hasAttribute('inert'), true);
    fireEvent.click(content.querySelector('.relic-preorder__reserve')!);
    await act(async () => {});
    assert.deepEqual(verifiedCodes, []);
    assert.deepEqual(preparedCodes, []);
    assert.equal(sendCount, 0);
  });
}

for (const submitWithArrow of [false, true]) {
  test(`a verified uppercase code unlocks the page through ${submitWithArrow ? 'the arrow' : 'form submission'}`, async t => {
    window.localStorage.removeItem(ACCESS_KEY);
    const verification = deferred<{ ok: true }>();
    const view = page();
    const input = view.getByRole('textbox', { name: 'Secret code' }) as HTMLInputElement;
    const reservation = view.container.querySelector<HTMLElement>('.relic-preorder')!;
    const focus = t.mock.method(reservation, 'focus');
    const scroll = t.mock.method(window, 'scrollTo');
    verifyImpl = () => {
      assert.notEqual(document.activeElement, input);
      return verification.promise;
    };
    fireEvent.change(input, { target: { value: '  testpass  ' } });
    act(() => input.focus());
    assert.equal(input.value, '  TESTPASS  ');
    assert.equal(document.activeElement, input);
    if (submitWithArrow) fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    else fireEvent.submit(input.closest('form')!);
    assert.notEqual(document.activeElement, input);
    await waitFor(() => assert.deepEqual(verifiedCodes, [ACCESS_CODE]));
    assert.equal(focus.mock.callCount(), 0);
    assert.equal(scroll.mock.callCount(), 0);
    assert.equal((view.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled, true);
    assert.equal(window.localStorage.getItem(ACCESS_KEY), null);
    assert.equal(view.queryByRole('button', { name: /Reserve|Preorders ended/ }), null);
    await act(async () => verification.resolve({ ok: true }));
    await view.ready();
    view.getByRole('link', { name: 'Go to mons.shop home' });
    assert.equal(view.queryByRole('textbox', { name: 'Secret code' }), null);
    assert.equal(window.localStorage.getItem(ACCESS_KEY), ACCESS_CODE);
    assert.equal(view.container.querySelector('.relic-page__content')!.hasAttribute('inert'), false);
    assert.equal(document.activeElement, reservation);
    assert.equal(focus.mock.callCount(), 1);
    assert.deepEqual(focus.mock.calls[0].arguments, [{ preventScroll: true }]);
    assert.equal(scroll.mock.callCount(), 0);
    assert.equal(sendCount, 0);
    view.reserve();
    await waitFor(() => assert.equal(sendCount, 1));
    assert.deepEqual(preparedCodes, [ACCESS_CODE]);
  });
}

test('empty and in-progress code submissions leave the focused input in place', async () => {
  window.localStorage.removeItem(ACCESS_KEY);
  const verification = deferred<{ ok: true }>();
  verifyImpl = () => verification.promise;
  const view = page();
  const input = view.getByRole('textbox', { name: 'Secret code' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '   ' } });
  act(() => input.focus());
  fireEvent.submit(input.closest('form')!);
  assert.equal(document.activeElement, input);
  assert.deepEqual(verifiedCodes, []);

  fireEvent.change(input, { target: { value: ACCESS_CODE } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => assert.deepEqual(verifiedCodes, [ACCESS_CODE]));
  act(() => input.focus());
  fireEvent.submit(input.closest('form')!);
  assert.equal(document.activeElement, input);
  assert.deepEqual(verifiedCodes, [ACCESS_CODE]);
  await act(async () => verification.resolve({ ok: true }));
  await view.ready();
});

test('a rejected code remains locked and can be corrected without saving the rejected value', async t => {
  window.localStorage.removeItem(ACCESS_KEY);
  verifyImpl = async code => {
    if (code !== ACCESS_CODE) throw new EthereumApiError(401, 'That code did not work. Try again.', 'unauthenticated');
    return { ok: true };
  };
  const view = page();
  const input = view.getByRole('textbox', { name: 'Secret code' });
  fireEvent.change(input, { target: { value: 'wrong' } });
  act(() => input.focus());
  const focus = t.mock.method(input, 'focus');
  fireEvent.submit(input.closest('form')!);
  assert.notEqual(document.activeElement, input);
  await waitFor(() => assert.match(view.getByRole('alert').textContent!, /code/i));
  assert.equal(document.activeElement, input);
  assert.deepEqual(focus.mock.calls[0].arguments, [{ preventScroll: true }]);
  assert.equal(window.localStorage.getItem(ACCESS_KEY), null);
  assert.equal(view.queryByRole('button', { name: /Reserve|Preorders ended/ }), null);
  fireEvent.change(input, { target: { value: 'testpass' } });
  fireEvent.submit(input.closest('form')!);
  await view.ready();
  assert.deepEqual(verifiedCodes, ['WRONG', ACCESS_CODE]);
  assert.equal(sendCount, 0);
});

test('a temporary verification failure keeps the input retryable without granting access', async t => {
  window.localStorage.removeItem(ACCESS_KEY);
  verifyImpl = async () => { throw new TypeError('Failed to fetch'); };
  const view = page();
  const input = view.getByRole('textbox', { name: 'Secret code' });
  fireEvent.change(input, { target: { value: ACCESS_CODE } });
  act(() => input.focus());
  const focus = t.mock.method(input, 'focus');
  fireEvent.submit(input.closest('form')!);
  assert.notEqual(document.activeElement, input);
  await waitFor(() => view.getByRole('alert'));
  assert.equal(document.activeElement, input);
  assert.deepEqual(focus.mock.calls[0].arguments, [{ preventScroll: true }]);
  assert.equal((view.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled, false);
  assert.equal(window.localStorage.getItem(ACCESS_KEY), null);
  verifyImpl = async () => ({ ok: true });
  fireEvent.click(view.getByRole('button', { name: 'Continue' }));
  await view.ready();
  assert.deepEqual(verifiedCodes, [ACCESS_CODE, ACCESS_CODE]);
});

test('saved approval restores immediately while background verification is pending', async () => {
  const verification = deferred<{ ok: true }>();
  verifyImpl = () => verification.promise;
  const view = page();
  assert.equal(view.queryByRole('textbox', { name: 'Secret code' }), null);
  view.getByRole('region', { name: 'Reserve a relic' });
  await view.ready();
  assert.deepEqual(verifiedCodes, [ACCESS_CODE]);
  await act(async () => verification.resolve({ ok: true }));
  assert.equal(window.localStorage.getItem(ACCESS_KEY), ACCESS_CODE);
  assert.equal(sendCount, 0);
});

test('a rejected saved code relocks without focusing the input and clears persisted approval', async () => {
  const verification = deferred<{ ok: true }>();
  verifyImpl = () => verification.promise;
  const view = page();
  await view.ready();
  await act(async () => verification.reject(new EthereumApiError(401, 'That code did not work. Try again.', 'unauthenticated')));
  await waitFor(() => view.getByRole('textbox', { name: 'Secret code' }));
  assert.equal(document.activeElement, document.body);
  assert.equal(window.localStorage.getItem(ACCESS_KEY), null);
  assert.equal(view.queryByRole('button', { name: /Reserve|Preorders ended/ }), null);
  assert.deepEqual(preparedCodes, []);
});

test('a background service failure preserves saved approval while reservation preparation still checks the code', async () => {
  verifyImpl = async () => { throw new EthereumApiError(503, 'Temporarily unavailable.', 'unavailable'); };
  const view = page();
  await view.ready();
  assert.equal(window.localStorage.getItem(ACCESS_KEY), ACCESS_CODE);
  assert.equal(view.queryByRole('textbox', { name: 'Secret code' }), null);
  view.reserve();
  await waitFor(() => assert.equal(sendCount, 1));
  assert.deepEqual(preparedCodes, [ACCESS_CODE]);
});

test('visiting the public mainnet page preserves devnet approval without revalidating it', async () => {
  window.localStorage.removeItem(ACCESS_KEY);
  const devnet = page();
  const input = devnet.getByRole('textbox', { name: 'Secret code' });
  fireEvent.change(input, { target: { value: ACCESS_CODE } });
  fireEvent.submit(input.closest('form')!);
  await devnet.ready();
  devnet.unmount();
  const mainnet = page('mainnet');
  assert.equal(mainnet.queryByRole('textbox', { name: 'Secret code' }), null);
  mainnet.getByRole('link', { name: 'Claim on VVV' });
  assert.deepEqual(verifiedCodes, [ACCESS_CODE]);
  assert.equal(window.localStorage.getItem(ACCESS_KEY), ACCESS_CODE);
  mainnet.unmount();
  const restored = page('devnet');
  await restored.ready();
  assert.deepEqual(verifiedCodes, [ACCESS_CODE, ACCESS_CODE]);
  assert.equal(sendCount, 0);
});

test('editing a code cancels verification and a late result cannot replace the newer submitted value', async () => {
  window.localStorage.removeItem(ACCESS_KEY);
  const oldVerification = deferred<{ ok: true }>();
  let oldSignal: AbortSignal | undefined;
  verifyImpl = (code, signal) => {
    if (code === 'OLDVALUE') { oldSignal = signal; return oldVerification.promise; }
    return Promise.resolve({ ok: true });
  };
  const view = page();
  const input = view.getByRole('textbox', { name: 'Secret code' });
  fireEvent.change(input, { target: { value: 'OLDVALUE' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => assert.deepEqual(verifiedCodes, ['OLDVALUE']));
  fireEvent.change(input, { target: { value: ACCESS_CODE } });
  assert.equal(oldSignal?.aborted, true);
  fireEvent.submit(input.closest('form')!);
  await view.ready();
  await act(async () => oldVerification.resolve({ ok: true }));
  assert.equal(window.localStorage.getItem(ACCESS_KEY), ACCESS_CODE);
  assert.deepEqual(verifiedCodes, ['OLDVALUE', ACCESS_CODE]);
});

test('unmounting aborts verification and its late success does not persist approval', async () => {
  window.localStorage.removeItem(ACCESS_KEY);
  const verification = deferred<{ ok: true }>();
  let signal: AbortSignal | undefined;
  verifyImpl = (_code, verificationSignal) => { signal = verificationSignal; return verification.promise; };
  const view = page();
  const input = view.getByRole('textbox', { name: 'Secret code' });
  fireEvent.change(input, { target: { value: ACCESS_CODE } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => assert.equal(verifiedCodes.length, 1));
  view.unmount();
  assert.equal(signal?.aborted, true);
  await act(async () => verification.resolve({ ok: true }));
  assert.equal(window.localStorage.getItem(ACCESS_KEY), null);
});

test('verification remains usable and survives a remount when localStorage is unavailable', async t => {
  window.localStorage.removeItem(ACCESS_KEY);
  t.mock.method(dom.window.Storage.prototype, 'getItem', () => { throw new Error('Storage blocked'); });
  t.mock.method(dom.window.Storage.prototype, 'setItem', () => { throw new Error('Storage blocked'); });
  const view = page('devnet', false);
  const input = view.getByRole('textbox', { name: 'Secret code' });
  fireEvent.change(input, { target: { value: ACCESS_CODE } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => assert.equal(view.queryByRole('textbox', { name: 'Secret code' }) === null, true));
  view.unmount();
  const remounted = page('devnet', false);
  assert.equal(remounted.queryByRole('textbox', { name: 'Secret code' }), null);
  await waitFor(() => assert.deepEqual(verifiedCodes, [ACCESS_CODE, ACCESS_CODE]));
  assert.equal(sendCount, 0);
});

test('a code rejected during preparation relocks the page before wallet submission', async () => {
  prepareError = new EthereumApiError(401, 'Enter a valid secret code.', 'unauthenticated');
  const view = page();
  await view.ready();
  view.reserve();
  await waitFor(() => view.getByRole('textbox', { name: 'Secret code' }));
  assert.equal(window.localStorage.getItem(ACCESS_KEY), null);
  assert.deepEqual(preparedCodes, [ACCESS_CODE]);
  assert.equal(sendCount, 0);
  assert.equal(window.localStorage.getItem(pendingKey()), null);
});

test('locked pages preload status once, then poll only while the gate is open', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  window.localStorage.removeItem(ACCESS_KEY);
  let requests = 0;
  statusImpl = async (network, wallet) => { requests++; return status(network, wallet); };
  const view = page('devnet', false);
  await waitFor(() => assert.equal(view.client.getQueryState(['pre111k', 'devnet', null])?.status, 'success'));
  assert.equal(requests, 1);
  await act(async () => {
    t.mock.timers.tick(30_000);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
  });
  assert.equal(requests, 1);

  const input = view.getByRole('textbox', { name: 'Secret code' });
  fireEvent.change(input, { target: { value: ACCESS_CODE } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => assert.equal(requests, 2));
  assert.equal(view.queryByRole('textbox', { name: 'Secret code' }) === null, true);
  await act(async () => { t.mock.timers.tick(10_000); });
  assert.equal(requests, 3);

  await act(async () => {
    window.localStorage.removeItem(ACCESS_KEY);
    window.dispatchEvent(new dom.window.StorageEvent('storage', { key: ACCESS_KEY }));
  });
  view.getByRole('textbox', { name: 'Secret code' });
  await act(async () => { t.mock.timers.tick(30_000); });
  assert.equal(requests, 3);
});

test('a failed locked prefetch does not retry until the gate opens', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  window.localStorage.removeItem(ACCESS_KEY);
  let requests = 0;
  statusImpl = async () => { requests++; throw new Error('Temporarily unavailable'); };
  const view = page('devnet', false);
  await act(async () => {});
  assert.equal(requests, 1);
  assert.equal(view.client.getQueryState(['pre111k', 'devnet', null])?.status, 'error');
  await act(async () => { t.mock.timers.tick(30_000); });
  assert.equal(requests, 1);

  statusImpl = async (network, wallet) => { requests++; return status(network, wallet); };
  const input = view.getByRole('textbox', { name: 'Secret code' });
  fireEvent.change(input, { target: { value: ACCESS_CODE } });
  fireEvent.submit(input.closest('form')!);
  await act(async () => {});
  assert.equal(requests, 2);
  assert.equal(view.client.getQueryState(['pre111k', 'devnet', null])?.status, 'success');
});
