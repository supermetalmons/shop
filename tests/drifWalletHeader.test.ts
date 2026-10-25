import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, afterEach, mock } from 'node:test';
import { createElement, useMemo, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalletContext, type WalletContextState } from '@solana/wallet-adapter-react';
import { WalletModalContext } from '@solana/wallet-adapter-react-ui';
import { clearStaffWalletSession, readStaffWalletSession, saveStaffWalletSession } from '../src/lib/staffWalletSession.ts';
import { anonymousSessionTestHooks } from '../src/lib/anonymousSession.ts';
import { drifCardVisualAssetsCache } from '../src/lib/drifCardVisualAssets.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { mockCardAssetImages } from './helpers/cardAssets.ts';

const { dom } = setupFrontendDom();
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const imports = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { default: DrifApp } = await import('../src/DrifApp.tsx');
imports.deregister();

const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';

afterEach(async () => {
  cleanup();
  drifCardVisualAssetsCache.clear();
  await clearStaffWalletSession();
  window.localStorage.clear();
  anonymousSessionTestHooks.resetValidation();
  mock.restoreAll();
});
after(() => dom.window.close());

function Harness({ onPickerOpen, onDisconnect }: { onPickerOpen?: () => void; onDisconnect?: () => void }) {
  const [visible, setVisible] = useState(false);
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
  const wallet = useMemo<WalletContextState>(() => ({
    autoConnect: false, wallets: [], wallet: null, publicKey: null,
    connected: false, connecting: false, disconnecting: false,
    select: () => undefined, connect: async () => undefined, disconnect: async () => { onDisconnect?.(); },
    sendTransaction: async () => '', signTransaction: undefined, signAllTransactions: undefined,
    signMessage: undefined, signIn: undefined,
  }), [onDisconnect]);
  return createElement(QueryClientProvider, { client: queryClient },
    createElement(WalletContext.Provider, { value: wallet },
      createElement(WalletModalContext.Provider, {
        value: { visible, setVisible: (next) => { if (next) onPickerOpen?.(); setVisible(next); } },
      },
      createElement(DrifApp),
      visible ? createElement('button', { onClick: () => setVisible(false) }, 'Dismiss test wallet picker') : null,
      )));
}

function interceptRequests() {
  const requests: string[] = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input), window.location.origin).pathname;
    requests.push(path);
    if (path === '/api/auth/anonymous/session') return Response.json({
      subject: 'anon:123e4567-e89b-42d3-a456-426614174000',
      refreshedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    if (path === '/api/profile/state') {
      const wallet = readStaffWalletSession()?.wallet ?? null;
      return Response.json({
        responseMode: 'profile-state', sessionWallet: wallet,
        profile: wallet ? { status: 'ready', value: { wallet } } : null,
        shipments: wallet ? { status: 'ready', value: [] } : null,
        nextCursor: null,
      });
    }
    if (path === '/api/profile/reconcile') return Response.json({ mergedStripeDeliveryOrders: 0 });
    if (path === '/api/auth/anonymous/logout' || path === '/api/staff/auth/logout') return Response.json({ ok: true });
    assert.fail(`Unexpected request: ${path}`);
  });
  return requests;
}

test('notify keeps its wallet icon visible and opens the existing picker once when signed out', async (t) => {
  mockCardAssetImages(t);
  interceptRequests();
  let pickerOpens = 0;
  const view = render(createElement(Harness, { onPickerOpen: () => { pickerOpens += 1; } }));
  const button = view.getByRole('button', { name: 'Wallet' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(button.disabled, false));
  assert.equal(view.queryByRole('button', { name: 'App menu' }), null);
  fireEvent.click(button);
  fireEvent.click(button);
  assert.equal(pickerOpens, 1);
  assert.equal(button.disabled, true);
  fireEvent.click(view.getByRole('button', { name: 'Dismiss test wallet picker' }));
  await waitFor(() => assert.equal(button.disabled, false));
  assert.equal(view.queryByRole('dialog', { name: 'Wallet' }), null);
});

test('notify restores a session-only wallet popup and signs it out without an attached adapter', async (t) => {
  mockCardAssetImages(t);
  await saveStaffWalletSession({
    wallet: ADMIN,
    token: `mons_staff_v1.123e4567-e89b-42d3-a456-426614174000.${'A'.repeat(43)}`,
    refreshedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  });
  const requests = interceptRequests();
  const endpoints: string[] = [];
  mock.method(Connection.prototype, 'getAccountInfo', async function (this: Connection, address: PublicKey) {
    endpoints.push(this.rpcEndpoint);
    assert.equal(address.toBase58(), ADMIN);
    return null;
  });
  let disconnects = 0;
  const view = render(createElement(Harness, { onDisconnect: () => { disconnects += 1; } }));
  const button = view.getByRole('button', { name: 'Wallet' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(button.disabled, false));
  fireEvent.click(button);
  await view.findByText('0 SOL');
  assert.equal(view.getByLabelText(`Solana wallet ${ADMIN}`).textContent, `${ADMIN.slice(0, 6)}…${ADMIN.slice(-4)}`);
  assert.ok(endpoints.every((endpoint) => endpoint.endsWith('/rpc/mainnet-beta')));
  fireEvent.click(view.getByRole('button', { name: 'Notify me' }));
  assert.equal(view.queryByRole('dialog', { name: 'Wallet' }), null);
  assert.ok(view.getByRole('dialog', { name: 'Notify me' }));
  assert.equal(button.disabled, true);
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(button);
  fireEvent.click(view.getByRole('button', { name: 'Disconnect', exact: true }));
  await waitFor(() => assert.equal(readStaffWalletSession(), null));
  await waitFor(() => assert.equal(view.queryByRole('dialog', { name: 'Wallet' }), null));
  assert.equal(disconnects, 0);
  assert.ok(requests.includes('/api/staff/auth/logout'));
  assert.ok(requests.includes('/api/auth/anonymous/logout'));
});
