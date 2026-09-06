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
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
  assert.equal(calls, 1);
  await act(async () => {
    signature.resolve({ wallet: initial.connectedWallet! });
    await Promise.all([header, shipments]);
  });
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
  assert.equal(calls, 1);
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
  await act(async () => { second.resolve({ wallet: nextKey.toBase58() }); });
  await waitFor(() => assert.equal(result.current.pendingHeaderWalletSignIn, false));
});
