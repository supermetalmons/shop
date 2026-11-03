import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { Root } from 'react-dom/client';
import type { EIP1193Provider, EthereumProviderListener } from '../src/wallet/injectedEthereumProviders.ts';
import { encodePre111kReservation, resolvePre111kConfig, type Pre111kNetwork, type Pre111kPrepareResponse } from '../shared/ethereum/pre111k.ts';
import { pre111kApi } from '../src/ethereum/pre111kApi.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'ab'.repeat(32)}`;
const DEVNET_HASH = `0x${'cd'.repeat(32)}`;
const contracts = { mainnet: '0x3333333333333333333333333333333333333333', devnet: '0x4444444444444444444444444444444444444444' };
const config = (network: Pre111kNetwork) => resolvePre111kConfig(network, { contractAddress: contracts[network], enabled: true });
function prepared(network: Pre111kNetwork, wallet: string, nonce = 0): Pre111kPrepareResponse {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const signature = `0x${'11'.repeat(65)}`;
  return { network, wallet, nonce, deadline, expiresAtMs: deadline * 1000, signature,
    transaction: { to: contracts[network], data: encodePre111kReservation(nonce, deadline, signature), value: `0x${BigInt(config(network).priceWei).toString(16)}`, chainId: config(network).chainId } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('relic routes scope authorizations and transaction links without retaining abandoned wallet attempts', async t => {
  const { dom } = setupFrontendDom();
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  window.localStorage.setItem('mons.shop.pre111k.access-code', 'TESTPASS');
  t.mock.method(pre111kApi, 'verifyAccess', async () => ({ ok: true }));
  t.mock.method(pre111kApi, 'confirm', async (_network, _wallet, transactionHash) => ({
    status: 'pending', confirmations: 0, transactionHash, reservationNonce: null,
  }));
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, '', '/111k/relics');
  const { act, fireEvent, getByRole, getByText, queryByRole, waitFor } = await import('@testing-library/react');
  const { default: ReactDOM } = await import('react-dom/client');
  const { QueryClient } = await import('@tanstack/react-query');
  const { navigate } = await import('../src/navigation.ts');
  const clients: InstanceType<typeof QueryClient>[] = [];
  const originalMount = QueryClient.prototype.mount;
  t.mock.method(QueryClient.prototype, 'mount', function (this: InstanceType<typeof QueryClient>) { clients.push(this); originalMount.call(this); });
  const createRoot = ReactDOM.createRoot;
  let root: Root | undefined;
  t.mock.method(ReactDOM, 'createRoot', (...args: Parameters<typeof createRoot>) => { root = createRoot(...args); return root; });

  let address = OWNER;
  let chain = '0x1';
  const requests: Parameters<EIP1193Provider['request']>[0][] = [];
  const listeners = new Map<string, Set<EthereumProviderListener>>();
  let pendingSend: ReturnType<typeof deferred<string>> | null = null;
  const provider: EIP1193Provider = {
    async request(request) {
      requests.push(request);
      if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [address];
      if (request.method === 'eth_chainId') return chain;
      if (request.method === 'wallet_switchEthereumChain') { chain = (request.params as [{ chainId: string }])[0].chainId; return null; }
      if (request.method === 'eth_sendTransaction') return pendingSend ? pendingSend.promise : HASH;
      assert.fail(`Unexpected wallet request: ${request.method}`);
    },
    on(event, listener) { const entries = listeners.get(event) ?? new Set(); entries.add(listener); listeners.set(event, entries); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  Object.defineProperty(window, 'ethereum', { configurable: true, value: provider });
  window.localStorage.setItem('mons.shop.mi-note.ethereum-wallet', JSON.stringify({ type: 'legacy' }));
  let prepareGate: ReturnType<typeof deferred<Pre111kPrepareResponse>> | null = null;
  let prepareCalls = 0;
  t.mock.method(pre111kApi, 'status', async (network, wallet) => ({ config: config(network), wallet,
    totalReserved: 0, reservedRelics: wallet ? 0 : null, remainingRelics: 18, observedBlock: 1, blockHash: `0x${'aa'.repeat(32)}` }));
  t.mock.method(pre111kApi, 'prepare', async (network, wallet) => { prepareCalls++; return prepareGate ? prepareGate.promise : prepared(network, wallet); });
  let resolveDestination!: () => void;
  const bridge = { ready: new Promise<void>(resolve => { resolveDestination = resolve; }), loads: 0 };
  Object.defineProperty(globalThis, '__directPaymentRoutingTest', { configurable: true, value: bridge });
  const imports = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith('/src/main.tsx')) {
        if (specifier === './ShopRoute') return { url: 'test:payment-shop-route', shortCircuit: true };
        if (specifier === './wallet/WalletContext') return { url: 'test:payment-wallet-context', shortCircuit: true };
        if (specifier === './checkout/CheckoutPage') return { url: 'test:payment-checkout', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const source = url.endsWith('.css') ? ''
        : url === 'test:payment-shop-route' ? 'export default function ShopRoute() { return null; }'
        : url === 'test:payment-wallet-context' ? 'export function WalletContextProvider({ children }) { return children; }'
        : url === 'test:payment-checkout' ? 'const bridge = globalThis.__directPaymentRoutingTest; bridge.loads += 1; await bridge.ready; export default function CheckoutPage() { return null; }' : null;
      return source === null ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
    },
  });
  t.after(async () => {
    await act(async () => { root?.unmount(); resolveDestination(); pendingSend?.resolve(HASH); prepareGate?.resolve(prepared('mainnet', OWNER)); });
    clients.forEach(client => client.clear());
    imports.deregister(); Reflect.deleteProperty(globalThis, '__directPaymentRoutingTest'); dom.window.close();
  });
  const reserveButton = (network: Pre111kNetwork) => getByRole(document.body, 'button', { name: `Premint · ${network === 'mainnet' ? '2.3' : '0.0023'} ETH` }) as HTMLButtonElement;
  const transactionKey = (network: Pre111kNetwork) => `mons.shop.pre111k.last-transaction:${config(network).chainId}:${contracts[network]}:${OWNER}`;
  const ready = async (network: Pre111kNetwork) => {
    await waitFor(() => {
      getByRole(document.body, 'button', { name: 'Disconnect' });
      assert.equal(reserveButton(network).disabled, false);
    }, { timeout: 3_000 });
  };
  await act(async () => { await import('../src/main.tsx'); });
  await ready('mainnet');

  await t.test('leaving for a loading route cancels an outstanding authorization', async () => {
    prepareGate = deferred<Pre111kPrepareResponse>();
    fireEvent.click(reserveButton('mainnet'));
    await waitFor(() => assert.equal(prepareCalls, 1));
    await act(async () => navigate('/checkout'));
    await waitFor(() => assert.equal(bridge.loads, 1));
    await act(async () => prepareGate!.resolve(prepared('mainnet', OWNER)));
    assert.equal(requests.filter(request => request.method === 'eth_sendTransaction').length, 0);
    assert.equal(document.body.classList.contains('drif-body'), false);
    prepareGate = null;
    await act(async () => resolveDestination());
  });

  await t.test('a prepared response for the previous account never opens a transaction request', async () => {
    await act(async () => navigate('/111k/relics'));
    await ready('mainnet');
    prepareGate = deferred<Pre111kPrepareResponse>();
    fireEvent.click(reserveButton('mainnet'));
    await waitFor(() => assert.equal(prepareCalls, 2));
    await act(async () => { address = OTHER; for (const listener of listeners.get('accountsChanged') ?? []) listener([OTHER]); });
    await act(async () => prepareGate!.resolve(prepared('mainnet', OWNER)));
    prepareGate = null;
    await ready('mainnet');
    assert.equal(requests.filter(request => request.method === 'eth_sendTransaction').length, 0);
    getByText(document.body, '0x2222…2222');
    await act(async () => { address = OWNER; for (const listener of listeners.get('accountsChanged') ?? []) listener([OWNER]); });
    await ready('mainnet');
  });

  await t.test('network navigation releases the old attempt and late wallet responses cannot finish the next attempt', async () => {
    const abandonedSend = deferred<string>();
    pendingSend = abandonedSend;
    fireEvent.click(reserveButton('mainnet'));
    await waitFor(() => assert.equal(requests.filter(request => request.method === 'eth_sendTransaction').length, 1));
    await act(async () => navigate('/111k/relics_devnet'));
    await ready('devnet');
    pendingSend = deferred<string>();
    fireEvent.click(reserveButton('devnet'));
    await waitFor(() => assert.equal(requests.filter(request => request.method === 'eth_sendTransaction').length, 2));
    assert.equal(prepareCalls, 4);
    await act(async () => abandonedSend.resolve(HASH));
    assert.equal((getByRole(document.body, 'button', { name: 'Confirm in your wallet…' }) as HTMLButtonElement).disabled, true);
    assert.equal(queryByRole(document.body, 'alert'), null);
    assert.equal(queryByRole(document.body, 'link', { name: 'View transaction ↗' }), null);
    assert.equal(window.localStorage.getItem(transactionKey('mainnet')), null);
    assert.equal(window.localStorage.getItem(transactionKey('devnet')), null);
    const last = requests.filter(request => request.method === 'eth_sendTransaction').at(-1)!;
    const transaction = (last.params as Array<{ to: string; value: string; data: string; chainId: string }>)[0];
    assert.equal(transaction.to, contracts.devnet);
    assert.equal(BigInt(transaction.value), 2300000000000000n);
    assert.equal(transaction.chainId, '0xaa36a7');
    assert.notEqual(transaction.data, '0x');
    await act(async () => pendingSend!.resolve(DEVNET_HASH));
    pendingSend = null;
    await ready('devnet');
    assert.equal(window.localStorage.getItem(transactionKey('devnet')), null);
    assert.equal(getByRole(document.body, 'link', { name: 'View transaction ↗' }).getAttribute('href'), `https://sepolia.etherscan.io/tx/${DEVNET_HASH}`);
    assert.equal(window.localStorage.getItem(`mons.shop.pre111k.pending:1:${contracts.mainnet}:${OWNER}`), null);
    assert.equal(window.localStorage.getItem(`mons.shop.pre111k.pending:11155111:${contracts.devnet}:${OWNER}`), null);
  });

  await t.test('transaction links only appear for the current visit when navigating between networks', async () => {
    await act(async () => navigate('/111k/relics'));
    await ready('mainnet');
    assert.equal(queryByRole(document.body, 'link', { name: 'View transaction ↗' }), null);
    assert.equal(requests.filter(request => request.method === 'eth_sendTransaction').length, 2);
    fireEvent.click(reserveButton('mainnet'));
    await waitFor(() => assert.equal(requests.filter(request => request.method === 'eth_sendTransaction').length, 3));
    await ready('mainnet');
    assert.equal(window.localStorage.getItem(transactionKey('mainnet')), null);
    assert.equal(getByRole(document.body, 'link', { name: 'View transaction ↗' }).getAttribute('href'), `https://etherscan.io/tx/${HASH}`);
    await act(async () => navigate('/111k/relics_devnet'));
    await ready('devnet');
    assert.equal(queryByRole(document.body, 'link', { name: 'View transaction ↗' }), null);
    await act(async () => navigate('/111k/relics'));
    await ready('mainnet');
    assert.equal(queryByRole(document.body, 'link', { name: 'View transaction ↗' }), null);
    assert.equal(requests.filter(request => request.method === 'eth_sendTransaction').length, 3);
  });
});
