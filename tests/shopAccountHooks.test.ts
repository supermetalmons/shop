import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { PublicKey } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useShopAccount, useShopAccountEffects } = await import('../src/shop/account/useShopAccount.ts');
const { useShopSignIn } = await import('../src/shop/account/useShopSignIn.ts');
const { ADMIN_WALLETS } = await import('../src/lib/fulfillmentAccess.ts');
const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
after(() => dom.window.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('admin viewing uses its own cache and returning to the owner restores the authenticated profile', async () => {
  const admin = [...ADMIN_WALLETS][0];
  assert.ok(admin);
  const accountProfile = { wallet: admin, email: 'owner@example.com' };
  const profileRequests: string[] = [];
  const ownerRequests: Array<{ cursor?: string; pageSize?: number }> = [];
  const runtime: NonNullable<Parameters<typeof useShopAccount>[1]> = {
    getAdminProfileView: async (owner) => {
      profileRequests.push(owner);
      return { profile: { wallet: owner, email: 'viewed@example.com' } };
    },
    listDeliveryOrderOwners: async (request = {}) => {
      ownerRequests.push(request);
      return { owners: ['viewed-wallet', admin, 'viewed-wallet'], hasMore: false, nextCursor: null };
    },
  };
  const initial: Parameters<typeof useShopAccount>[0] = {
    auth: { profile: accountProfile, sessionWallet: admin, authenticated: true, deliveryRecoveryNextCheckAt: 123 },
    connectedWallet: admin,
    stripeCheckoutDataOwner: admin,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const { result, rerender } = renderHook((options: typeof initial) => {
    const account = useShopAccount(options, runtime);
    useShopAccountEffects(account);
    return account;
  }, { initialProps: initial, wrapper });

  assert.equal(result.current.viewedProfile, accountProfile);
  assert.equal(result.current.currentOwnerDeliveryRecoveryNextCheckAt, 123);
  assert.deepEqual(ownerRequests, []);
  act(() => result.current.setSettingsOpen(true));
  act(() => result.current.setOwnerPickerOpened(true));
  await waitFor(() => assert.equal(ownerRequests.length, 1));
  assert.deepEqual(ownerRequests, [{ cursor: undefined, pageSize: 200 }]);
  await waitFor(() => assert.deepEqual(result.current.deliveryOrderOwners, [admin, 'viewed-wallet'].sort((a, b) => a.localeCompare(b))));

  act(() => result.current.setAdminViewedOwner('viewed-wallet'));
  await waitFor(() => assert.equal(result.current.viewedProfile?.email, 'viewed@example.com'));
  assert.equal(result.current.owner, 'viewed-wallet');
  assert.equal(result.current.localAccountWallet, admin);
  assert.equal(result.current.isViewerMode, true);
  assert.equal(result.current.canReadOwnProfile, false);
  assert.equal(result.current.currentOwnerDeliveryRecoveryNextCheckAt, null);
  assert.deepEqual(profileRequests, ['viewed-wallet']);
  assert.deepEqual(client.getQueryData(['viewedProfile', admin, 'viewed-wallet', true]), {
    profile: { wallet: 'viewed-wallet', email: 'viewed@example.com' },
  });

  act(() => result.current.setAdminViewedOwner(admin));
  assert.equal(result.current.adminViewedOwner, null);
  assert.equal(result.current.viewedProfile, accountProfile);
  rerender({
    ...initial,
    auth: { ...initial.auth, profile: null, authenticated: false, sessionWallet: null },
    stripeCheckoutDataOwner: undefined,
  });
  assert.equal(result.current.settingsOpen, false);
  assert.equal(result.current.ownerPickerOpened, false);
  assert.equal(result.current.viewedProfile, null);
  assert.equal(result.current.owner, undefined);
});

function signInOptions(overrides: Partial<Parameters<typeof useShopSignIn>[0]> = {}): Parameters<typeof useShopSignIn>[0] {
  const publicKey = new PublicKey(new Uint8Array(32).fill(1));
  return {
    auth: {
      sessionWallet: null,
      authenticated: false,
      loading: false,
      sessionResolution: 'settled',
      signIn: async () => ({ wallet: publicKey.toBase58() }),
      hasAuthenticatedWalletSession: () => false,
    },
    connectedWallet: publicKey.toBase58(),
    publicKey,
    wallet: { connecting: false, disconnecting: false },
    walletModalVisible: false,
    setVisible: () => undefined,
    isSignedInWallet: false,
    hasAuthenticatedAccount: false,
    claimOpen: false,
    showToast: () => undefined,
    isUserRejectedError: () => false,
    ...overrides,
  };
}

test('header and shipment sign-in share a pending signature and wait for session restoration', async () => {
  const signature = deferred<{ wallet: string }>();
  let calls = 0;
  const initial = signInOptions();
  initial.auth.signIn = async () => { calls += 1; return signature.promise; };
  const messages: string[] = [];
  initial.showToast = (message) => { messages.push(message); };
  initial.auth.sessionResolution = 'resolving';
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial });
  await act(async () => { assert.equal(await result.current.ensureSignedIn(), false); });
  assert.equal(calls, 0);
  assert.deepEqual(messages, ['Restoring wallet session…']);

  rerender({ ...initial, auth: { ...initial.auth, sessionResolution: 'settled' } });
  let header!: Promise<void>;
  let shipments!: Promise<void>;
  act(() => {
    header = result.current.handleHeaderWalletSignIn();
    shipments = result.current.handleSignInForShipments();
  });
  assert.equal(result.current.pendingHeaderWalletSignIn, true);
  assert.equal(result.current.pendingShipmentsSignIn, false);
  assert.equal(calls, 1);
  await act(async () => {
    signature.resolve({ wallet: initial.connectedWallet! });
    await Promise.all([header, shipments]);
  });
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
  assert.equal(calls, 1);
});

test('overlapping queued sign-ins wait for restoration and keep only the header pending during signing', async () => {
  const signature = deferred<{ wallet: string }>();
  let calls = 0;
  const connected = signInOptions({ claimOpen: true });
  connected.auth.signIn = () => { calls += 1; return signature.promise; };
  const initial: typeof connected = { ...connected, connectedWallet: undefined, publicKey: null, walletModalVisible: true };
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial });

  act(() => {
    void result.current.handleSignInForShipments();
    void result.current.handleHeaderWalletSignIn();
    result.current.requestClaimSignIn();
  });
  assert.equal(result.current.pendingShipmentsSignIn, true);
  assert.equal(result.current.pendingHeaderWalletSignIn, true);
  assert.equal(result.current.pendingClaimSignIn, true);
  assert.equal(calls, 0);

  rerender({ ...connected, auth: { ...connected.auth, sessionResolution: 'resolving' } });
  assert.equal(calls, 0);
  assert.equal(result.current.pendingShipmentsSignIn, true);
  assert.equal(result.current.pendingHeaderWalletSignIn, true);
  assert.equal(result.current.pendingClaimSignIn, true);

  rerender({ ...connected, auth: { ...connected.auth, loading: true } });
  assert.equal(calls, 0);
  rerender(connected);
  assert.equal(calls, 1);
  assert.equal(result.current.pendingShipmentsSignIn, false);
  assert.equal(result.current.pendingClaimSignIn, false);
  assert.equal(result.current.pendingHeaderWalletSignIn, true);

  await act(async () => { signature.resolve({ wallet: connected.connectedWallet! }); });
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
  assert.equal(calls, 1);
});

test('closing a claim clears only its queued sign-in intent', async () => {
  const signature = deferred<{ wallet: string }>();
  let calls = 0;
  const connected = signInOptions({ claimOpen: true });
  connected.auth.signIn = () => { calls += 1; return signature.promise; };
  const initial: typeof connected = { ...connected, connectedWallet: undefined, publicKey: null, walletModalVisible: true };
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial });

  act(() => result.current.requestClaimSignIn());
  rerender({ ...initial, claimOpen: false });
  assert.equal(result.current.pendingClaimSignIn, false);
  rerender({ ...connected, claimOpen: false });
  assert.equal(calls, 0);

  rerender(initial);
  act(() => {
    void result.current.handleSignInForShipments();
    void result.current.handleHeaderWalletSignIn();
    result.current.requestClaimSignIn();
  });
  rerender({ ...initial, claimOpen: false });
  assert.equal(result.current.pendingClaimSignIn, false);
  assert.equal(result.current.pendingShipmentsSignIn, true);
  assert.equal(result.current.pendingHeaderWalletSignIn, true);

  rerender({ ...connected, claimOpen: false });
  assert.equal(calls, 1);
  assert.equal(result.current.pendingHeaderWalletSignIn, true);
  await act(async () => { signature.resolve({ wallet: connected.connectedWallet! }); });
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
});

test('closing the wallet modal cancels queued sign-ins only after connection is idle', () => {
  let calls = 0;
  const connected = signInOptions({ claimOpen: true });
  connected.auth.signIn = async () => { calls += 1; return { wallet: connected.connectedWallet! }; };
  const initial: typeof connected = { ...connected, connectedWallet: undefined, publicKey: null, walletModalVisible: true };
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial });

  act(() => {
    void result.current.handleSignInForShipments();
    void result.current.handleHeaderWalletSignIn();
    result.current.requestClaimSignIn();
  });
  rerender({ ...initial, walletModalVisible: false, wallet: { connecting: true, disconnecting: false } });
  assert.equal(result.current.pendingShipmentsSignIn, true);
  assert.equal(result.current.pendingHeaderWalletSignIn, true);
  assert.equal(result.current.pendingClaimSignIn, true);

  rerender({ ...initial, walletModalVisible: false });
  assert.equal(result.current.pendingShipmentsSignIn, false);
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
  assert.equal(result.current.pendingClaimSignIn, false);
  rerender(connected);
  assert.equal(calls, 0);
});

test('a restored wallet session consumes queued sign-ins without requesting a signature', () => {
  let calls = 0;
  const connected = signInOptions({ claimOpen: true });
  connected.auth.signIn = async () => { calls += 1; return { wallet: connected.connectedWallet! }; };
  const initial: typeof connected = { ...connected, connectedWallet: undefined, publicKey: null, walletModalVisible: true };
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial });

  act(() => {
    void result.current.handleSignInForShipments();
    void result.current.handleHeaderWalletSignIn();
    result.current.requestClaimSignIn();
  });
  rerender({
    ...connected,
    isSignedInWallet: true,
    hasAuthenticatedAccount: true,
    auth: { ...connected.auth, authenticated: true, sessionWallet: connected.connectedWallet! },
  });
  assert.equal(calls, 0);
  assert.equal(result.current.pendingShipmentsSignIn, false);
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
  assert.equal(result.current.pendingClaimSignIn, false);
});

test('a rejected shared signature clears header pending and preserves error feedback', async (t) => {
  for (const userRejected of [true, false]) {
    await t.test(userRejected ? 'user rejection stays silent' : 'other failures are shown once', async () => {
      const signature = deferred<{ wallet: string }>();
      let calls = 0;
      const messages: string[] = [];
      const initial = signInOptions({
        showToast: (message) => { messages.push(message); },
        isUserRejectedError: () => userRejected,
      });
      initial.auth.signIn = () => { calls += 1; return signature.promise; };
      const { result, unmount } = renderHook(useShopSignIn, { initialProps: initial });
      let header!: Promise<void>;
      let shipments!: Promise<void>;
      act(() => {
        header = result.current.handleHeaderWalletSignIn();
        shipments = result.current.handleSignInForShipments();
      });
      assert.equal(calls, 1);
      assert.equal(result.current.pendingHeaderWalletSignIn, true);
      await act(async () => {
        signature.reject(new Error('Signature failed'));
        await Promise.all([header, shipments]);
      });
      assert.equal(result.current.pendingHeaderWalletSignIn, false);
      assert.deepEqual(messages, userRejected ? [] : ['Signature failed']);
      unmount();
    });
  }
});

test('a stale header completion cannot clear a later wallet sign-in', async () => {
  const first = deferred<{ wallet: string }>();
  const second = deferred<{ wallet: string }>();
  let calls = 0;
  const initial = signInOptions();
  initial.auth.signIn = () => (++calls === 1 ? first.promise : second.promise);
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial });
  let oldHeader!: Promise<void>;
  act(() => { oldHeader = result.current.handleHeaderWalletSignIn(); });
  const nextKey = new PublicKey(new Uint8Array(32).fill(2));
  rerender({ ...initial, connectedWallet: nextKey.toBase58(), publicKey: nextKey });
  assert.equal(calls, 2);
  await act(async () => {
    first.resolve({ wallet: initial.connectedWallet! });
    await oldHeader;
  });
  assert.equal(result.current.pendingHeaderWalletSignIn, true);
  let currentRequest!: Promise<boolean>;
  act(() => { currentRequest = result.current.ensureSignedIn(); });
  assert.equal(calls, 2);
  await act(async () => {
    second.resolve({ wallet: nextKey.toBase58() });
    assert.equal(await currentRequest, true);
  });
  await waitFor(() => assert.equal(result.current.pendingHeaderWalletSignIn, false));
});
