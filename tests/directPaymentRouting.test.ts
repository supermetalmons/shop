import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { Root } from 'react-dom/client';
import { setupFrontendDom } from './helpers/frontendDom.ts';

test('leaving payment for a loading lazy route cancels the pending payment', async t => {
  const { dom } = setupFrontendDom();
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, '', '/111111');
  const { act, fireEvent, getByRole, waitFor } = await import('@testing-library/react');
  const { default: ReactDOM } = await import('react-dom/client');
  const { navigate } = await import('../src/navigation.ts');
  const createRoot = ReactDOM.createRoot;
  let root: Root | undefined;
  t.mock.method(ReactDOM, 'createRoot', (...args: Parameters<typeof createRoot>) => {
    root = createRoot(...args);
    return root;
  });

  let resolveAccounts!: (accounts: string[]) => void;
  const accounts = new Promise<string[]>(resolve => { resolveAccounts = resolve; });
  const requests: string[] = [];
  Object.defineProperty(window, 'ethereum', { configurable: true, value: {
    async request({ method }: { method: string }) {
      requests.push(method);
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_sendTransaction') return `0x${'ab'.repeat(32)}`;
      assert.fail(`Unexpected wallet request: ${method}`);
    },
  } });

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
      resolveAccounts([]);
      resolveDestination();
    });
    imports.deregister();
    Reflect.deleteProperty(globalThis, bridgeKey);
    dom.window.close();
  });

  await act(async () => { await import('../src/main.tsx'); });
  const button = await waitFor(() => getByRole(document.body, 'button', { name: 'Pay 2.3 ETH' }));
  fireEvent.click(button);
  assert.deepEqual(requests, ['eth_accounts']);
  await act(async () => navigate('/checkout'));
  await waitFor(() => assert.equal(bridge.loads, 1));
  await act(async () => resolveAccounts(['0x1111111111111111111111111111111111111111']));
  assert.equal(window.location.pathname, '/checkout');
  assert.deepEqual(requests, ['eth_accounts']);
  assert.equal(document.body.classList.contains('drif-body'), false);
});
