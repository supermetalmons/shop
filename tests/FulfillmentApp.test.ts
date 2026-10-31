import { MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES } from '../shared/fulfillmentAccess.ts';
import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { createElement, useMemo, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalletContext, type WalletContextState } from '@solana/wallet-adapter-react';
import { WalletModalContext } from '@solana/wallet-adapter-react-ui';
import type { FulfillmentOrder } from '../src/types.ts';
import { listFrontendDrops } from '../src/config/deployment.ts';
import { listAllowedFulfillmentDropIds } from '../src/lib/fulfillmentAccess.ts';
import { readStaffWalletSession, saveStaffWalletSession, clearStaffWalletSession } from '../src/lib/staffWalletSession.ts';
import { anonymousSessionTestHooks } from '../src/lib/anonymousSession.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { default: FulfillmentApp } = await import('../src/FulfillmentApp.tsx');

const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const ADDRESS_OPERATOR = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const ETHEREUM_DROP = '111k_devnet';
const ORDERS_PATH = '/api/fulfillment/orders';
const MANUAL_REVIEW_PATH = '/api/fulfillment/manual-review-checkouts';

Object.defineProperty(globalThis, 'IntersectionObserver', {
  configurable: true,
  value: class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect() {}
  },
});

afterEach(async () => {
  cleanup();
  await clearStaffWalletSession();
  window.localStorage.clear();
  window.sessionStorage.clear();
  anonymousSessionTestHooks.resetValidation();
  mock.restoreAll();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function order(dropId = 'card_nft_2'): FulfillmentOrder {
  return {
    dropId,
    deliveryId: dropId === ETHEREUM_DROP ? 111 : 7,
    owner: 'owner-wallet',
    status: 'ready_to_ship',
    fulfillmentStatus: 'Preparing',
    address: { full: 'Ada\n123 Main St\nUS', countryCode: 'US' },
    boxes: dropId === ETHEREUM_DROP ? [{ boxId: 5555, claimCode: 'ABCDEF123456', dudeIds: [111111] }] : [],
    looseDudes: [],
    cardClaims: [],
    ...(dropId === ETHEREUM_DROP ? { source: 'ethereum' as const } : {}),
  };
}

async function installSession(wallet: string) {
  return saveStaffWalletSession({
    wallet,
    token: `mons_staff_v1.123e4567-e89b-42d3-a456-426614174000.${(wallet === ADMIN ? 'A' : 'B').repeat(43)}`,
    refreshedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  });
}

function AppHarness({ wallet, initialDropId = '', onDisconnect }: {
  wallet: string;
  initialDropId?: string;
  onDisconnect?: () => void;
}) {
  const [selectedDropId, setSelectedDropId] = useState(initialDropId);
  const [disconnectedWallet, setDisconnectedWallet] = useState<string | null>(null);
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
  const walletState = useMemo<WalletContextState>(() => ({
    autoConnect: false, wallets: [], wallet: null, publicKey: disconnectedWallet === wallet ? null : new PublicKey(wallet),
    connecting: false, connected: disconnectedWallet !== wallet, disconnecting: false,
    select: () => undefined, connect: async () => undefined,
    disconnect: async () => { onDisconnect?.(); setDisconnectedWallet(wallet); },
    sendTransaction: async () => '', signTransaction: undefined, signAllTransactions: undefined,
    signMessage: undefined, signIn: undefined,
  }), [disconnectedWallet, onDisconnect, wallet]);
  return createElement(QueryClientProvider, { client: queryClient },
    createElement(WalletContext.Provider, { value: walletState },
    createElement(WalletModalContext.Provider, { value: { visible: false, setVisible: () => undefined } },
      createElement(FulfillmentApp, {
        selectedDropId,
        onSelectedDropIdChange: setSelectedDropId,
        orderVisibilityFilter: 'all',
        onOrderVisibilityFilterChange: () => undefined,
      }))));
}

function interceptRequests(options: {
  pendingEthereumOrders?: Promise<Response>;
  pendingEthereumReview?: Promise<Response>;
  pendingStatusUpdate?: Promise<Response>;
} = {}) {
  const requests: Array<{ path: string; dropId?: string }> = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const body = JSON.parse(String(init?.body || '{}')) as { dropId?: string };
    requests.push({ path, dropId: body.dropId });
    if (path === '/api/auth/anonymous/session') return Response.json({
      subject: 'anon:123e4567-e89b-42d3-a456-426614174000',
      refreshedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    if (path === '/api/auth/anonymous/logout' || path === '/api/staff/auth/logout') return Response.json({ ok: true });
    if (path === '/api/profile/state') {
      const wallet = readStaffWalletSession()?.wallet ?? null;
      return Response.json({
        responseMode: 'profile-state', sessionWallet: wallet,
        profile: wallet ? { status: 'ready', value: { wallet } } : null,
        shipments: wallet ? { status: 'ready', value: [] } : null, nextCursor: null,
      });
    }
    if (path === '/api/profile/reconcile') return Response.json({ mergedStripeDeliveryOrders: 0 });
    if (path === '/api/fulfillment/order-status' && options.pendingStatusUpdate) return options.pendingStatusUpdate;
    if (path === ORDERS_PATH) {
      if (body.dropId === ETHEREUM_DROP && options.pendingEthereumOrders) return options.pendingEthereumOrders;
      return Response.json({
        orders: body.dropId === 'card_nft_2' || body.dropId === ETHEREUM_DROP ? [order(body.dropId)] : [],
        nextCursor: null,
      });
    }
    if (path === MANUAL_REVIEW_PATH) {
      if (body.dropId === ETHEREUM_DROP && options.pendingEthereumReview) return options.pendingEthereumReview;
      return Response.json({ checkouts: [], nextCursor: null });
    }
    if (path === '/ethereum/111k/metadata') {
      return Response.json({ image: 'data:image/svg+xml;base64,PHN2Zy8+' });
    }
    assert.fail(`Unexpected request: ${path}`);
  });
  return requests;
}

function assertOrdinaryRequests(requests: ReturnType<typeof interceptRequests>, wallet: string) {
  const expected = listAllowedFulfillmentDropIds(wallet, listFrontendDrops().map(({ dropId }) => dropId))
    .filter((dropId) => dropId !== ETHEREUM_DROP).sort();
  for (const path of [ORDERS_PATH, MANUAL_REVIEW_PATH]) {
    assert.deepEqual(requests.filter((request) => request.path === path).map(({ dropId }) => dropId).sort(), expected);
  }
  assert.equal(requests.some(({ path, dropId }) => path.startsWith('/ethereum/') || dropId === ETHEREUM_DROP), false);
}

async function assertOrdinaryExports(view: ReturnType<typeof render>) {
  const blobs: Blob[] = [];
  mock.method(URL, 'createObjectURL', (blob: Blob) => {
    blobs.push(blob);
    return `blob:fulfillment-test-${blobs.length}`;
  });
  mock.method(dom.window.HTMLAnchorElement.prototype, 'click', () => undefined);
  for (const name of ['Download Orders', 'Download Addresses [SENSITIVE]']) {
    fireEvent.click(view.getByRole('button', { name: 'Fulfillment export menu' }));
    assert.equal(view.getByRole('menuitem', { name: 'Download Secret Codes ZIP' }).hasAttribute('disabled'), true);
    fireEvent.click(view.getByRole('menuitem', { name }));
  }
  assert.equal(blobs.length, 2);
  const [orders, addresses] = await Promise.all(blobs.map(async (blob) => JSON.parse(await blob.text())));
  assert.deepEqual(orders.map((entry: { orderId: string }) => entry.orderId), ['card_nft_2:7']);
  assert.deepEqual(Object.keys(addresses), ['card_nft_2:7']);
}

for (const [label, wallet] of [
  ['admin', ADMIN],
  ...MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES.map((wallet) => [`mainnet admin-shipper ${wallet.slice(0, 4)}`, wallet]),
  ['address operator', ADDRESS_OPERATOR],
]) {
  test(`All drops excludes Ethereum requests, cards, and exports for the ${label}`, async () => {
    await installSession(wallet);
    const requests = interceptRequests();
    const view = render(createElement(AppHarness, { wallet }));
    await view.findByText('Order 7');
    assert.equal(Boolean(view.queryByRole('button', { name: 'Edit address for order 7' })), wallet !== ADMIN);
    assert.equal((view.getByRole('combobox', { name: 'Drop' }) as HTMLSelectElement).value, '');
    assert.equal(Boolean(view.queryByRole('option', { name: '111K · Ethereum testnet' })), wallet === ADMIN);
    assert.equal(view.queryByText('111K · Ethereum test order'), null);
    await assertOrdinaryExports(view);
    assertOrdinaryRequests(requests, wallet);
  });
}

test('the admin loads Ethereum only when selected and returning to All drops clears its cards and exports', async () => {
  await installSession(ADMIN);
  const requests = interceptRequests();
  const view = render(createElement(AppHarness, { wallet: ADMIN }));
  await view.findByText('Order 7');
  requests.length = 0;

  fireEvent.change(view.getByRole('combobox', { name: 'Drop' }), { target: { value: ETHEREUM_DROP } });
  await view.findByText('111K · Ethereum test order');
  assert.equal(view.queryByText('Order 7'), null);
  for (const path of [ORDERS_PATH, MANUAL_REVIEW_PATH]) {
    assert.deepEqual(requests.filter((request) => request.path === path).map(({ dropId }) => dropId), [ETHEREUM_DROP]);
  }
  requests.length = 0;

  fireEvent.change(view.getByRole('combobox', { name: 'Drop' }), { target: { value: '' } });
  await view.findByText('Order 7');
  assert.equal(view.queryByText('111K · Ethereum test order'), null);
  await assertOrdinaryExports(view);
  assertOrdinaryRequests(requests, ADMIN);
});

test('fulfillment exposes mainnet wallet balance and disconnect removes its authenticated orders', async () => {
  await installSession(ADMIN);
  const requests = interceptRequests();
  const balances: string[] = [];
  mock.method(Connection.prototype, 'getAccountInfo', async function (this: Connection, address: PublicKey) {
    balances.push(this.rpcEndpoint);
    assert.equal(address.toBase58(), ADMIN);
    return { lamports: 1_234_567_890, owner: new PublicKey(ADMIN), executable: false, data: Buffer.alloc(0), rentEpoch: 0 };
  });
  let disconnects = 0;
  const view = render(createElement(AppHarness, { wallet: ADMIN, onDisconnect: () => { disconnects += 1; } }));
  await view.findByText('Order 7');
  const walletButton = view.getByRole('button', { name: 'Wallet' });
  assert.equal(view.queryByRole('button', { name: 'App menu' }), null);
  assert.equal(balances.length, 0);
  fireEvent.click(walletButton);
  await view.findByText('1.2346 SOL');
  assert.ok(balances.every((endpoint) => endpoint.endsWith('/rpc/mainnet-beta')));
  fireEvent.click(view.getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => assert.equal(disconnects, 1));
  await waitFor(() => assert.equal(view.queryByText('Order 7'), null));
  assert.equal(readStaffWalletSession(), null);
  assert.ok(requests.some(({ path }) => path === '/api/staff/auth/logout'));
  assert.ok(requests.some(({ path }) => path === '/api/auth/anonymous/logout'));
  assert.ok(view.getByRole('button', { name: 'Wallet' }));
});

test('closing the status editor while saving keeps Disconnect disabled until the mutation settles', async () => {
  await installSession(ADMIN);
  const pending = deferred<Response>();
  const requests = interceptRequests({ pendingStatusUpdate: pending.promise });
  mock.method(Connection.prototype, 'getAccountInfo', async () => null);
  const view = render(createElement(AppHarness, { wallet: ADMIN }));
  await view.findByText('Order 7');
  fireEvent.click(view.getByRole('button', { name: 'Edit status' }));
  fireEvent.change(view.getByRole('combobox', { name: 'Fulfillment status' }), { target: { value: 'Shipped' } });
  fireEvent.click(view.getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.ok(requests.some(({ path }) => path === '/api/fulfillment/order-status')));
  fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(view.getByRole('button', { name: 'Wallet' }));
  assert.equal((view.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled, true);
  await act(async () => {
    pending.resolve(Response.json({ deliveryId: 7, fulfillmentStatus: 'Shipped' }));
  });
  await waitFor(() => assert.equal((view.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled, false));
});

for (const wallet of MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES) {
  test(`the mainnet admin-shipper cannot select or request devnet drops even from a saved selection (${wallet.slice(0, 4)})`, async () => {
    await installSession(wallet);
    const requests = interceptRequests();
    const view = render(createElement(AppHarness, { wallet, initialDropId: 'card_nft_binder_devnet' }));
    await view.findByText('Order 7');
    const selector = view.getByRole('combobox', { name: 'Drop' }) as HTMLSelectElement;
    assert.equal(selector.value, '');
    assert.deepEqual(
      Array.from(selector.options).map((option) => option.value).filter(Boolean).sort(),
      listFrontendDrops().filter((drop) => drop.solanaCluster === 'mainnet-beta').map((drop) => drop.dropId).sort(),
    );
    assertOrdinaryRequests(requests, wallet);
  });
}

test('an Ethereum direct selection resets to All drops for another operator without requesting Ethereum', async () => {
  await installSession(ADDRESS_OPERATOR);
  const requests = interceptRequests();
  const view = render(createElement(AppHarness, { wallet: ADDRESS_OPERATOR, initialDropId: ETHEREUM_DROP }));
  await view.findByText('Order 7');
  assert.equal((view.getByRole('combobox', { name: 'Drop' }) as HTMLSelectElement).value, '');
  assert.equal(view.queryByRole('option', { name: '111K · Ethereum testnet' }), null);
  assertOrdinaryRequests(requests, ADDRESS_OPERATOR);
});

test('switching from the admin to another operator ignores pending Ethereum orders and manual review', async () => {
  await installSession(ADMIN);
  const pendingOrders = deferred<Response>();
  const pendingReview = deferred<Response>();
  const requests = interceptRequests({
    pendingEthereumOrders: pendingOrders.promise,
    pendingEthereumReview: pendingReview.promise,
  });
  const view = render(createElement(AppHarness, { wallet: ADMIN, initialDropId: ETHEREUM_DROP }));
  await waitFor(() => {
    assert.equal(requests.filter(({ path, dropId }) => path === ORDERS_PATH && dropId === ETHEREUM_DROP).length, 1);
    assert.equal(requests.filter(({ path, dropId }) => path === MANUAL_REVIEW_PATH && dropId === ETHEREUM_DROP).length, 1);
  });
  requests.length = 0;

  await act(async () => {
    view.rerender(createElement(AppHarness, { wallet: ADDRESS_OPERATOR }));
    await installSession(ADDRESS_OPERATOR);
  });
  await view.findByText('Order 7');
  assert.equal((view.getByRole('combobox', { name: 'Drop' }) as HTMLSelectElement).value, '');
  assert.equal(view.queryByRole('option', { name: '111K · Ethereum testnet' }), null);
  await act(async () => {
    pendingOrders.resolve(Response.json({ orders: [order(ETHEREUM_DROP)], nextCursor: null }));
    pendingReview.resolve(Response.json({
      checkouts: [{ dropId: ETHEREUM_DROP, sessionId: 'ethereum-review', owner: 'owner-wallet', address: {} }],
      nextCursor: null,
    }));
  });
  assert.equal(view.queryByText('111K · Ethereum test order'), null);
  assert.equal(view.queryByRole('button', { name: /Needs manual review/ }), null);
  await assertOrdinaryExports(view);
  assertOrdinaryRequests(requests, ADDRESS_OPERATOR);
});
