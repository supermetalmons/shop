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
const { act, cleanup, fireEvent, render, waitFor, within } = await import('@testing-library/react');
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
        : url.endsWith('/lib/SoundPlayer.ts')
          ? 'export const soundPlayer = { isInitialized: false, initializeOnUserInteraction: async () => {}, playSound: async () => {}, preloadSound: async () => {} };'
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

function fixture(t: TestContext, setVisible: (visible: boolean) => void = () => {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  t.after(() => queryClient.clear());
  const connection = new Connection('http://127.0.0.1:9999');
  return (route: ResolvedAppRoute) => createElement(QueryClientProvider, { client: queryClient },
    createElement(ConnectionContext.Provider, { value: { connection } },
      createElement(WalletContext.Provider, { value: wallet },
        createElement(WalletModalContext.Provider, { value: { visible: false, setVisible } },
          createElement(BackgroundBlurProvider, null, createElement(App, { route }))))));
}

test('Tarot renders the standard header before validation and keeps it interactive after claiming', async t => {
  const validation = Promise.withResolvers<Awaited<ReturnType<typeof tarotApi.status>>>();
  mock.method(tarotApi, 'status', () => validation.promise);
  const setVisible = mock.fn();
  const page = fixture(t, setVisible);
  window.history.replaceState(null, '', '/nfc');
  const view = render(page(tarotRoute));
  const banner = view.getByRole('banner');
  const header = within(banner);
  const home = header.getByRole('link', { name: 'Go to mons.shop home' });
  assert.equal(header.getByRole('heading', { name: 'mons.shop' }).textContent, 'mons.shop');
  assert.ok(home.querySelector('img.brand-icon'));
  assert.equal((header.getByRole('button', { name: 'Wallet' }) as HTMLButtonElement).disabled, false);
  assert.equal(within(view.getByRole('main')).queryByRole('img'), null);
  assert.equal(view.queryByRole('button', { name: 'Claim' }), null);
  assert.equal(setVisible.mock.callCount(), 0);
  await act(async () => validation.resolve({ config, tokenId: 1, receiptTokenId: 778, claimed: true,
    observedBlock: 10, observedTimestamp: 1, blockHash: `0x${'b'.repeat(64)}` }));
  await waitFor(() => assert.ok(view.queryByRole('main', { name: 'Tarot card' })));
  assert.equal(view.getByRole('banner'), banner);
  const main = view.getByRole('main', { name: 'Tarot card' });
  assert.equal(within(main).getAllByRole('img').length, 1);
  assert.equal(within(main).queryByRole('button'), null);
  assert.equal(view.queryByText(accountError), null);
  assert.equal(main.textContent, '');
  await act(async () => fireEvent.click(header.getByRole('button', { name: 'Wallet' })));
  await waitFor(() => assert.equal(setVisible.mock.calls.some(call => call.arguments[0] === true), true));
  await act(async () => fireEvent.click(home));
  assert.equal(window.location.pathname, '/');
  await act(async () => view.rerender(page(resolveAppRoute({ pathname: '/' }))));
  assert.equal(view.getByText(accountError).className, 'error');
});

test('NFC validation errors remain visible without unrelated account errors', async t => {
  mock.method(tarotApi, 'status', async () => { throw new TarotApiError('This Tarot claim link is invalid.', 401); });
  const view = render(fixture(t)(tarotRoute));
  assert.equal((await view.findByRole('alert')).textContent, 'This Tarot claim link is invalid.');
  assert.ok(view.getByRole('banner'));
  assert.equal(view.queryByText(accountError), null);
  assert.equal(view.queryByRole('button', { name: 'Claim' }), null);
});
