import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, mock, type TestContext } from 'node:test';
import { createElement } from 'react';
import { Connection } from '@solana/web3.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectionContext, WalletContext, type WalletContextState } from '@solana/wallet-adapter-react';
import { WalletModalContext } from '@solana/wallet-adapter-react-ui';
import type { useSolanaAuth } from '../src/hooks/useSolanaAuth.ts';
import { resolveAppRoute, type ResolvedAppRoute } from '../src/routes.ts';
import { resolveTarotConfig } from '../shared/ethereum/tarot.ts';
import { tarotApi, TarotApiError } from '../src/ethereum/tarotApi.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
const { cleanup, render, waitFor } = await import('@testing-library/react');
const { BackgroundBlurProvider } = await import('../src/components/BackgroundBlurLayer.tsx');
const accountError = 'Unable to refresh profile';
const auth: ReturnType<typeof useSolanaAuth> = {
  profile: null, shipments: [], shipmentsNextCursor: null, shipmentsRevision: 0,
  sessionWallet: null, authenticated: false, loading: false, profileReady: false, shipmentsReady: false,
  profileError: null, shipmentsError: null, deliveryRecoveryNextCheckAt: null, sessionResolution: 'settled',
  intentCancellationSignal: new AbortController().signal, authSubject: null, error: accountError,
  signIn: async () => ({ wallet: '' }), signOut: async () => {}, reconcileProfile: async () => null,
  refreshProfileState: async () => false, awaitWalletSessionRestoration: async () => 'sign-in-required',
  beginDeliveryRecoveryScheduleUpdate: () => () => false, hasAuthenticatedWalletSession: () => false,
};
const bridgeKey = '__nfcAppIsolationTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { useSolanaAuth: () => auth } });
const imports = registerHooks({
  load(url, context, nextLoad) {
    const source = url.endsWith('/hooks/useSolanaAuth.ts')
      ? `export const useSolanaAuth = globalThis.${bridgeKey}.useSolanaAuth;`
      : url.endsWith('/lib/discounts.ts')
        ? 'export async function isDiscountListed() { return false; } export async function getDiscountProof() { return null; }'
        : url.endsWith('.css') ? '' : undefined;
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };
  },
});
const { default: App } = await import('../src/App.tsx');
imports.deregister();

const config = resolveTarotConfig({ contractAddress: '0x2222222222222222222222222222222222222222', enabled: true, deploymentBlock: 1 });
const tarotRoute = resolveAppRoute({ pathname: '/nfc', search: '?code=00000000-0000-4000-8000-000000000001&tokenId=1&testnet=true' });
const wallet: WalletContextState = {
  publicKey: null, autoConnect: false, wallets: [], wallet: null, connecting: false, connected: false, disconnecting: false,
  select: () => {}, connect: async () => {}, disconnect: async () => {}, sendTransaction: async () => '',
  signTransaction: undefined, signAllTransactions: undefined, signMessage: undefined, signIn: undefined,
};

afterEach(() => { cleanup(); mock.restoreAll(); window.sessionStorage.clear(); window.localStorage.clear(); });
after(() => { Reflect.deleteProperty(globalThis, bridgeKey); dom.window.close(); });

function fixture(t: TestContext) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  t.after(() => queryClient.clear());
  const connection = new Connection('http://127.0.0.1:9999');
  return (route: ResolvedAppRoute) => createElement(QueryClientProvider, { client: queryClient },
    createElement(ConnectionContext.Provider, { value: { connection } },
      createElement(WalletContext.Provider, { value: wallet },
        createElement(WalletModalContext.Provider, { value: { visible: false, setVisible: () => {} } },
          createElement(BackgroundBlurProvider, null, createElement(App, { route }))))));
}

test('claimed Tarot artwork excludes account errors while ordinary shop navigation preserves them', async t => {
  mock.method(tarotApi, 'status', async () => ({ config, tokenId: 1, receiptTokenId: 778, claimed: true,
    observedBlock: 10, observedTimestamp: 1, blockHash: `0x${'b'.repeat(64)}` }));
  const page = fixture(t);
  const view = render(page(tarotRoute));
  await waitFor(() => assert.ok(view.queryByRole('main', { name: 'Tarot card' })));
  assert.equal(view.getAllByRole('img').length, 1);
  assert.equal(view.queryByText(accountError), null);
  assert.equal(view.container.textContent, '');
  view.rerender(page(resolveAppRoute({ pathname: '/' })));
  assert.equal(view.getByText(accountError).className, 'error');
});

test('NFC validation errors remain visible without unrelated account errors', async t => {
  mock.method(tarotApi, 'status', async () => { throw new TarotApiError('This Tarot claim link is invalid.', 401); });
  const view = render(fixture(t)(tarotRoute));
  assert.equal((await view.findByRole('alert')).textContent, 'This Tarot claim link is invalid.');
  assert.equal(view.queryByText(accountError), null);
  assert.equal(view.queryByRole('button', { name: 'Claim' }), null);
});
