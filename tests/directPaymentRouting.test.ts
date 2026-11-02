import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { Root } from 'react-dom/client';
import type { EIP1193Provider } from '../src/wallet/injectedEthereumProviders.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const OWNER = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}`;
type WalletRequest = Parameters<EIP1193Provider['request']>[0];

test('payment routing cancels old operations and preserves the shared pending-payment guard', async t => {
  const { dom } = setupFrontendDom();
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, '', '/111k/relics');
  const { act, fireEvent, getByRole, waitFor } = await import('@testing-library/react');
  const { default: ReactDOM } = await import('react-dom/client');
  const { navigate } = await import('../src/navigation.ts');
  const createRoot = ReactDOM.createRoot;
  let root: Root | undefined;
  t.mock.method(ReactDOM, 'createRoot', (...args: Parameters<typeof createRoot>) => {
    root = createRoot(...args);
    return root;
  });

  const unsettled = new Set<() => void>();
  function walletFixture(initialChain: string, pendingMethod: 'eth_accounts' | 'eth_sendTransaction') {
    const requests: WalletRequest[] = [];
    let chain = initialChain;
    let pendingAvailable = true;
    let resolvePending!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => { resolvePending = resolve; });
    const settle = () => {
      resolvePending(pendingMethod === 'eth_accounts' ? [OWNER] : HASH);
      unsettled.delete(settle);
    };
    unsettled.add(settle);
    const provider: EIP1193Provider = {
      async request(request) {
        requests.push(request);
        if (request.method === pendingMethod && pendingAvailable) {
          pendingAvailable = false;
          return pending;
        }
        if (request.method === 'eth_accounts') return [OWNER];
        if (request.method === 'eth_chainId') return chain;
        if (request.method === 'wallet_switchEthereumChain') {
          chain = (request.params as [{ chainId: string }])[0].chainId;
          return null;
        }
        if (request.method === 'eth_sendTransaction') return HASH;
        assert.fail(`Unexpected wallet request: ${request.method}`);
      },
    };
    Object.defineProperty(window, 'ethereum', { configurable: true, value: provider });
    return { requests, settle, calls: (method: string) => requests.filter(request => request.method === method) };
  }

  let resolveDestination!: () => void;
  const bridge = {
    ready: new Promise<void>(resolve => { resolveDestination = resolve; }),
    loads: 0,
  };
  const bridgeKey = '__directPaymentRoutingTest';
  Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: bridge });
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
        : url === 'test:payment-checkout'
          ? `const bridge = globalThis.${bridgeKey}; bridge.loads += 1; await bridge.ready; export default function CheckoutPage() { return null; }`
          : null;
      return source === null ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
    },
  });
  t.after(async () => {
    await act(async () => {
      root?.unmount();
      for (const settle of unsettled) settle();
      resolveDestination();
    });
    imports.deregister();
    Reflect.deleteProperty(globalThis, bridgeKey);
    dom.window.close();
  });

  const payButton = () => getByRole(document.body, 'button', { name: 'Pay 2.3 ETH' });
  await act(async () => { await import('../src/main.tsx'); });
  await waitFor(payButton);

  await t.test('leaving payment for a loading lazy route cancels the pending payment', async () => {
    const wallet = walletFixture('0x1', 'eth_accounts');
    fireEvent.click(payButton());
    assert.deepEqual(wallet.requests.map(request => request.method), ['eth_accounts']);
    await act(async () => navigate('/checkout'));
    await waitFor(() => assert.equal(bridge.loads, 1));
    await act(async () => wallet.settle());
    assert.equal(window.location.pathname, '/checkout');
    assert.deepEqual(wallet.requests.map(request => request.method), ['eth_accounts']);
    assert.equal(document.body.classList.contains('drif-body'), false);
    await act(async () => resolveDestination());
  });

  const transitions = [
    { from: '/111k/relics', to: '/111k/relics_devnet', fromChain: '0x1', toChain: '0xaa36a7' },
    { from: '/111k/relics_devnet', to: '/111k/relics', fromChain: '0xaa36a7', toChain: '0x1' },
  ];
  for (const { from, to, fromChain, toChain } of transitions) {
    for (const pendingMethod of ['eth_accounts', 'eth_sendTransaction'] as const) {
      await t.test(`${from} to ${to} while ${pendingMethod} is pending requires a new destination payment`, async () => {
        await act(async () => navigate(from));
        const wallet = walletFixture(fromChain, pendingMethod);
        const oldButton = payButton();
        fireEvent.click(oldButton);
        await waitFor(() => assert.equal(wallet.calls(pendingMethod).length, 1));
        const requestsBeforeNavigation = wallet.requests.slice();

        await act(async () => navigate(to));
        const newButton = payButton();
        assert.equal(window.location.pathname, to);
        assert.notEqual(newButton, oldButton);
        assert.equal(oldButton.isConnected, false);
        assert.equal(document.body.classList.contains('drif-body'), true);
        fireEvent.click(newButton);
        assert.deepEqual(wallet.requests, requestsBeforeNavigation);

        await act(async () => wallet.settle());
        assert.deepEqual(wallet.requests, requestsBeforeNavigation);
        const previousTransactions = pendingMethod === 'eth_sendTransaction' ? 1 : 0;
        assert.equal(wallet.calls('eth_sendTransaction').length, previousTransactions);

        await act(async () => { fireEvent.click(newButton); });
        await waitFor(() => assert.equal(wallet.calls('eth_sendTransaction').length, previousTransactions + 1));
        assert.deepEqual(wallet.calls('wallet_switchEthereumChain').map(request => request.params), [[{ chainId: toChain }]]);
        assert.deepEqual(wallet.calls('eth_sendTransaction').at(-1)?.params, [{
          from: OWNER,
          to: '0x72D0c5623A05033F9eE4495D408BC6c05DF8367d',
          value: '0x1feb3dd067660000',
          data: '0x',
          chainId: toChain,
        }]);
      });
    }
  }
});
