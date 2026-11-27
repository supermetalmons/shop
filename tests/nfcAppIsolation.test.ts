import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, mock, type TestContext } from 'node:test';
import { createElement } from 'react';
import { Connection } from '@solana/web3.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectionContext, WalletContext, type WalletContextState } from '@solana/wallet-adapter-react';
import { WalletModalContext } from '@solana/wallet-adapter-react-ui';
import { useAppRoute } from '../src/hooks/useAppRoute.ts';
import type { useSolanaAuth } from '../src/hooks/useSolanaAuth.ts';
import { resolveAppRoute, type ResolvedAppRoute } from '../src/routes.ts';
import { resolveTarotConfig, tarotReceiptTokenId } from '../shared/ethereum/tarot.ts';
import { tarotApi, TarotApiError } from '../src/ethereum/tarotApi.ts';
import { FULFILLMENT_ADMIN_WALLET_ADDRESSES } from '../shared/fulfillmentAccess.ts';
import { anonymousSessionTestHooks } from '../src/lib/anonymousSession.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
function blockLocalStorage(): never { throw new DOMException('Storage unavailable', 'SecurityError'); }
const startupStorage = mock.getter(window, 'localStorage', blockLocalStorage);
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
let activeAuth = auth;
const bridgeKey = '__nfcAppIsolationTest';
Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: { useSolanaAuth: () => activeAuth } });
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
startupStorage.mock.restore();
imports.deregister();

const config = resolveTarotConfig({ contractAddress: '0x2222222222222222222222222222222222222222', enabled: true, deploymentBlock: 1, testnet: true });
const tarotRoute = resolveAppRoute({ pathname: '/nfc', search: '?code=00000000-0000-4000-8000-000000000001&tokenId=1&testnet=true' });
const wallet: WalletContextState = {
  publicKey: null, autoConnect: false, wallets: [], wallet: null, connecting: false, connected: false, disconnecting: false,
  select: () => {}, connect: async () => {}, disconnect: async () => {}, sendTransaction: async () => '',
  signTransaction: undefined, signAllTransactions: undefined, signMessage: undefined, signIn: undefined,
};

afterEach(() => {
  cleanup();
  mock.restoreAll();
  activeAuth = auth;
  anonymousSessionTestHooks.resetValidation();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
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

test('a scanned card reaches Claim when the browser denies local storage', async t => {
  mock.getter(window, 'localStorage', blockLocalStorage);
  const status = mock.method(tarotApi, 'status', async (request: Parameters<typeof tarotApi.status>[0]) => ({
    config, tokenId: request.tokenId, receiptTokenId: tarotReceiptTokenId(request.tokenId), claimed: false,
    observedBlock: 10, observedTimestamp: 1, blockHash: `0x${'b'.repeat(64)}`,
  }));
  const page = fixture(t);
  function RoutedApp() { return page(useAppRoute()); }
  const code = crypto.randomUUID();
  window.history.replaceState(null, '', `/nfc?code=${code}&tokenId=1&testnet=true`);
  const view = render(createElement(RoutedApp));
  await view.findByRole('button', { name: 'Claim' }, { timeout: 3000 });
  assert.equal(window.location.search, '?tokenId=1&testnet=true');
  assert.deepEqual(status.mock.calls[0].arguments[0], { code, tokenId: 1, testnet: true });
});

test('Tarot renders the standard header and artwork immediately and preserves both after validation', async t => {
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
  assert.ok(header.getByRole('link', { name: 'mons.shop on X' }));
  assert.equal(view.container.querySelector('.top__wallet-button'), null);
  assert.equal(view.container.querySelector('.top__actions'), null);
  const artwork = within(view.getByRole('main', { name: 'Tarot card' })).getByRole('img', { name: 'Mutating Card' });
  assert.equal(artwork.getAttribute('src'), 'https://cdn.lil.org/nft/dmx/clean/1.webp');
  assert.equal(view.queryByRole('button', { name: 'Claim' }), null);
  assert.equal(setVisible.mock.callCount(), 0);
  await act(async () => validation.resolve({ config, tokenId: 1, receiptTokenId: 778, claimed: true,
    observedBlock: 10, observedTimestamp: 1, blockHash: `0x${'b'.repeat(64)}` }));
  await waitFor(() => assert.ok(view.queryByRole('main', { name: 'Tarot card' })));
  assert.equal(view.getByRole('banner'), banner);
  const main = view.getByRole('main', { name: 'Tarot card' });
  assert.equal(within(main).getAllByRole('img').length, 1);
  assert.equal(within(main).getByRole('img', { name: 'Mutating Card' }), artwork);
  assert.equal(within(main).queryByRole('button'), null);
  assert.equal(view.queryByText(accountError), null);
  assert.equal(within(main).queryByRole('heading'), null);
  assert.equal(view.container.querySelector('.top__wallet-button'), null);
  await act(async () => fireEvent.click(home));
  assert.equal(window.location.pathname, '/');
  await act(async () => view.rerender(page(resolveAppRoute({ pathname: '/' }))));
  assert.ok(view.getByRole('button', { name: 'Wallet' }));
  assert.equal(view.getByText(accountError).className, 'error');
});

test('NFC validation failures remain silent alongside public artwork and the standard header', async t => {
  mock.method(tarotApi, 'status', async () => { throw new TarotApiError('This Tarot claim link is invalid.', 401); });
  const view = render(fixture(t)(tarotRoute));
  const image = within(view.getByRole('main', { name: 'Tarot card' })).getByRole('img');
  await act(async () => undefined);
  assert.equal(within(view.getByRole('main', { name: 'Tarot card' })).getByRole('img'), image);
  assert.equal(view.queryByRole('alert'), null);
  assert.ok(view.getByRole('banner'));
  assert.equal(view.queryByText(accountError), null);
  assert.equal(view.queryByRole('button', { name: 'Claim' }), null);
});

test('eligible NFC claim appears without the Solana header wallet', async t => {
  const validation = Promise.withResolvers<Awaited<ReturnType<typeof tarotApi.status>>>();
  const service = mock.method(tarotApi, 'status', () => validation.promise);
  const view = render(fixture(t)(tarotRoute));
  const header = view.getByRole('banner');
  assert.equal(view.container.querySelector('.top__wallet-button'), null);
  await act(async () => validation.resolve({ config, tokenId: 1, receiptTokenId: 778, claimed: false,
    observedBlock: 10, observedTimestamp: 1, blockHash: `0x${'b'.repeat(64)}` }));
  await view.findByRole('button', { name: 'Claim' }, { timeout: 3000 });
  assert.equal(view.getByRole('banner'), header);
  assert.equal(view.container.querySelector('.top__wallet-button'), null);
  assert.equal(service.mock.callCount(), 1);
});

test('NFC hides the staff menu and closes it when entering from another page', async t => {
  activeAuth = { ...auth, authenticated: true, sessionWallet: FULFILLMENT_ADMIN_WALLET_ADDRESSES[0], error: null };
  mock.method(globalThis, 'fetch', async (input: unknown) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === '/api/auth/anonymous/session') return Response.json({
      subject: 'anon:123e4567-e89b-42d3-a456-426614174000',
      refreshedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
    });
    if (path === '/api/preorders/status') return Response.json({ order: null, recoveries: [], nextRecoveryCursor: null });
    assert.fail(`Unexpected request: ${path}`);
  });
  const page = fixture(t);
  const view = render(page(resolveAppRoute({ pathname: '/' })));
  await act(async () => fireEvent.click(view.getByRole('button', { name: 'App menu' })));
  assert.ok(view.getByRole('menu', { name: 'App menu' }));

  await act(async () => view.rerender(page(resolveAppRoute({ pathname: '/nfc', search: '?tokenId=777' }))));
  assert.equal(view.container.querySelector('.top__actions'), null);
  assert.equal(view.container.querySelector('.top__wallet-button'), null);
  assert.ok(view.getByRole('link', { name: 'mons.shop on X' }));

  await act(async () => view.rerender(page(resolveAppRoute({ pathname: '/' }))));
  assert.equal(view.getByRole('button', { name: 'App menu' }).getAttribute('aria-expanded'), 'false');
  assert.equal(view.queryByRole('menu', { name: 'App menu' }), null);
});

test('public artwork navigation keeps the standard header and requires no Tarot backend request', async t => {
  const service = mock.method(tarotApi, 'status');
  const page = fixture(t);
  const route = resolveAppRoute({ pathname: '/nfc', search: '?tokenId=777' });
  const view = render(page(route));
  const artwork = within(view.getByRole('main', { name: 'Tarot card' })).getByRole('img');
  assert.equal(artwork.getAttribute('src'), 'https://cdn.lil.org/nft/dmx/clean/777.webp');
  await act(async () => view.rerender(page(resolveAppRoute({ pathname: '/nfc', search: '?tokenId=777&code=wrong&testnet=true' }))));
  assert.ok(view.getByRole('banner'));
  assert.equal(within(view.getByRole('main', { name: 'Tarot card' })).getByRole('img').getAttribute('src'), artwork.getAttribute('src'));
  assert.equal(service.mock.callCount(), 0);
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(view.queryByRole('button', { name: 'Claim' }), null);
});
