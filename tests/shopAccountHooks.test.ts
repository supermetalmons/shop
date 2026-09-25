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
  let authenticatedWallet: string | null = null;
  return {
    auth: {
      loading: false,
      sessionResolution: 'settled',
      signIn: async () => {
        authenticatedWallet = publicKey.toBase58();
        return { wallet: authenticatedWallet };
      },
      hasAuthenticatedWalletSession: (wallet) => authenticatedWallet === wallet,
      awaitWalletSessionRestoration: async () => 'sign-in-required',
    },
    connectedWallet: publicKey.toBase58(),
    publicKey,
    wallet: { connecting: false, disconnecting: false },
    walletModalVisible: false,
    setVisible: () => undefined,
    isSignedInWallet: false,
    hasAuthenticatedAccount: false,
    showToast: () => undefined,
    isUserRejectedError: () => false,
    ...overrides,
  };
}

test('header and shipments wait for shared restoration without a toast or a signature', async () => {
  const restoration = deferred<'restored'>();
  let restores = 0;
  let signatures = 0;
  let restored = false;
  const messages: string[] = [];
  const initial = signInOptions({ showToast: (message) => messages.push(message) });
  initial.auth.sessionResolution = 'resolving';
  initial.auth.awaitWalletSessionRestoration = () => { restores += 1; return restoration.promise; };
  initial.auth.hasAuthenticatedWalletSession = () => restored;
  initial.auth.signIn = async () => { signatures += 1; return { wallet: initial.connectedWallet! }; };
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let header!: Promise<void>;
  let shipments!: Promise<void>;
  let action!: Promise<boolean>;
  act(() => {
    header = result.current.handleHeaderWalletSignIn();
    shipments = result.current.handleSignInForShipments();
    action = result.current.ensureSignedIn();
  });
  await waitFor(() => assert.equal(restores, 1));
  assert.equal(result.current.pendingHeaderWalletSignIn, true);
  assert.equal(result.current.pendingShipmentsSignIn, true);
  assert.equal(signatures, 0);
  assert.deepEqual(messages, []);
  await act(async () => {
    restored = true;
    restoration.resolve('restored');
    await Promise.all([header, shipments]);
    assert.equal(await action, true);
  });
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
  assert.equal(result.current.pendingShipmentsSignIn, false);
  assert.equal(signatures, 0);
  assert.deepEqual(messages, []);
});

test('an unsuccessful restoration requests one shared signature and resumes every active caller', async () => {
  const restoration = deferred<'sign-in-required'>();
  const signature = deferred<void>();
  let calls = 0;
  const initial = signInOptions();
  const completeSignIn = initial.auth.signIn;
  initial.auth.awaitWalletSessionRestoration = () => restoration.promise;
  initial.auth.signIn = async () => { calls += 1; await signature.promise; return completeSignIn(); };
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  act(() => {
    first = result.current.ensureSignedIn();
    second = result.current.ensureSignedIn();
    void result.current.handleHeaderWalletSignIn();
  });
  await act(async () => { restoration.resolve('sign-in-required'); });
  assert.equal(calls, 1);
  await act(async () => {
    signature.resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
  });
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
  assert.equal(calls, 1);
});

test('a disconnected request survives initial wallet selection and uses the latest auth implementation', async () => {
  const restoration = deferred<'sign-in-required'>();
  const pickerChanges: boolean[] = [];
  let signatures = 0;
  const connected = signInOptions({ setVisible: (visible) => pickerChanges.push(visible) });
  const initial = { ...connected, connectedWallet: undefined, publicKey: null };
  initial.auth = { ...connected.auth, signIn: async () => { throw new Error('Stale disconnected callback'); } };
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial as typeof connected });
  let request!: Promise<boolean>;
  act(() => { request = result.current.ensureSignedIn(); });
  assert.deepEqual(pickerChanges, [true]);
  rerender({ ...initial, walletModalVisible: true });
  rerender({ ...initial, wallet: { connecting: true, disconnecting: false } });
  const completeSignIn = connected.auth.signIn;
  rerender({
    ...connected,
    auth: {
      ...connected.auth,
      sessionResolution: 'resolving',
      awaitWalletSessionRestoration: () => restoration.promise,
      signIn: async () => { signatures += 1; return completeSignIn(); },
    },
  });
  assert.equal(signatures, 0);
  await act(async () => {
    restoration.resolve('sign-in-required');
    assert.equal(await request, true);
  });
  assert.equal(signatures, 1);
});

test('closing the wallet picker cancels all pending sign-ins once connection is idle', async () => {
  let signatures = 0;
  const connected = signInOptions();
  connected.auth.signIn = async () => { signatures += 1; return { wallet: connected.connectedWallet! }; };
  const initial = { ...connected, connectedWallet: undefined, publicKey: null, walletModalVisible: true };
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial as typeof connected });
  let header!: Promise<void>;
  let shipments!: Promise<void>;
  let action!: Promise<boolean>;
  act(() => {
    header = result.current.handleHeaderWalletSignIn();
    shipments = result.current.handleSignInForShipments();
    action = result.current.ensureSignedIn();
  });
  rerender({ ...initial, walletModalVisible: false, wallet: { connecting: true, disconnecting: false } });
  assert.equal(result.current.pendingShipmentsSignIn, true);
  assert.equal(result.current.pendingHeaderWalletSignIn, true);
  rerender({ ...initial, walletModalVisible: false });
  await act(async () => {
    await Promise.all([header, shipments]);
    assert.equal(await action, false);
  });
  assert.equal(result.current.pendingShipmentsSignIn, false);
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
  rerender(connected);
  await act(async () => undefined);
  assert.equal(signatures, 0);
});

test('aborting a restoring action prevents late sign-in and leaves no restoration feedback', async () => {
  const restoration = deferred<'sign-in-required'>();
  const controller = new AbortController();
  let signatures = 0;
  const messages: string[] = [];
  const initial = signInOptions({ showToast: (message) => messages.push(message) });
  initial.auth.awaitWalletSessionRestoration = () => restoration.promise;
  initial.auth.signIn = async () => { signatures += 1; return { wallet: initial.connectedWallet! }; };
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let action!: Promise<boolean>;
  act(() => { action = result.current.ensureSignedIn({ signal: controller.signal }); });
  await act(async () => undefined);
  await act(async () => {
    controller.abort();
    assert.equal(await action, false);
  });
  await act(async () => { restoration.resolve('sign-in-required'); });
  assert.equal(signatures, 0);
  assert.deepEqual(messages, []);
});

test('a cancelled caller does not cancel another caller sharing the same prerequisite', async () => {
  const restoration = deferred<'sign-in-required'>();
  const controller = new AbortController();
  const initial = signInOptions();
  initial.auth.awaitWalletSessionRestoration = () => restoration.promise;
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let action!: Promise<boolean>;
  let header!: Promise<void>;
  act(() => {
    action = result.current.ensureSignedIn({ signal: controller.signal });
    header = result.current.handleHeaderWalletSignIn();
  });
  await act(async () => {
    controller.abort();
    assert.equal(await action, false);
  });
  assert.equal(result.current.pendingHeaderWalletSignIn, true);
  await act(async () => {
    restoration.resolve('sign-in-required');
    await header;
  });
  assert.equal(initial.auth.hasAuthenticatedWalletSession(initial.connectedWallet!), true);
  assert.equal(result.current.pendingHeaderWalletSignIn, false);
});

test('an aborted signature retains the prompt lock until it settles and cannot restart itself', async () => {
  const signature = deferred<void>();
  const controller = new AbortController();
  let signatures = 0;
  const messages: string[] = [];
  const initial = signInOptions({ showToast: (message) => messages.push(message) });
  const completeSignIn = initial.auth.signIn;
  initial.auth.signIn = async () => {
    signatures += 1;
    if (signatures === 1) await signature.promise;
    return completeSignIn();
  };
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let action!: Promise<boolean>;
  act(() => { action = result.current.ensureSignedIn({ signal: controller.signal }); });
  await waitFor(() => assert.equal(signatures, 1));
  await act(async () => {
    controller.abort();
    assert.equal(await action, false);
    assert.equal(await result.current.ensureSignedIn(), false);
  });
  assert.equal(signatures, 1);
  await act(async () => { signature.reject(new Error('Late rejection')); });
  assert.deepEqual(messages, []);
  await act(async () => { assert.equal(await result.current.ensureSignedIn(), true); });
  assert.equal(signatures, 2);
});

test('changing or disconnecting the pinned wallet cancels the pending action', async (t) => {
  for (const disconnect of [false, true]) {
    await t.test(disconnect ? 'disconnect' : 'switch', async () => {
      const restoration = deferred<'sign-in-required'>();
      let signatures = 0;
      const initial = signInOptions();
      initial.auth.awaitWalletSessionRestoration = () => restoration.promise;
      initial.auth.signIn = async () => { signatures += 1; return { wallet: initial.connectedWallet! }; };
      const { result, rerender, unmount } = renderHook(useShopSignIn, { initialProps: initial });
      let action!: Promise<boolean>;
      act(() => { action = result.current.ensureSignedIn(); });
      await act(async () => undefined);
      const nextKey = new PublicKey(new Uint8Array(32).fill(2));
      rerender({ ...initial, connectedWallet: disconnect ? undefined : nextKey.toBase58(), publicKey: disconnect ? null : nextKey });
      await act(async () => {
        assert.equal(await action, false);
        restoration.resolve('sign-in-required');
      });
      assert.equal(signatures, 0);
      unmount();
    });
  }
});

test('wallet-only prerequisites share selection without restoring or signing in', async () => {
  let restorations = 0;
  let signatures = 0;
  const connected = signInOptions();
  connected.auth.awaitWalletSessionRestoration = async () => { restorations += 1; return 'sign-in-required'; };
  connected.auth.signIn = async () => { signatures += 1; return { wallet: connected.connectedWallet! }; };
  const initial = { ...connected, connectedWallet: undefined, publicKey: null, walletModalVisible: true };
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial as typeof connected });
  let first!: Promise<string | null>;
  let second!: Promise<string | null>;
  act(() => {
    first = result.current.ensureWalletConnected();
    second = result.current.ensureWalletConnected();
  });
  rerender(connected);
  await act(async () => {
    assert.deepEqual(await Promise.all([first, second]), [connected.connectedWallet, connected.connectedWallet]);
  });
  assert.equal(restorations, 0);
  assert.equal(signatures, 0);
});

test('selecting a different owner cancels inventory sign-in before any signature', async () => {
  const messages: string[] = [];
  let signatures = 0;
  const connected = signInOptions({ showToast: (message) => messages.push(message) });
  connected.auth.signIn = async () => { signatures += 1; return { wallet: connected.connectedWallet! }; };
  const owner = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
  const initial = { ...connected, connectedWallet: undefined, publicKey: null, walletModalVisible: true };
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial as typeof connected });
  let action!: Promise<boolean>;
  act(() => { action = result.current.ensureSignedIn({ expectedWallet: owner }); });
  rerender(connected);
  await act(async () => { assert.equal(await action, false); });
  assert.equal(signatures, 0);
  assert.deepEqual(messages, ['Choose the wallet that owns these items.']);
});

test('a valid authenticated session survives profile loading errors during sign-in', async () => {
  const messages: string[] = [];
  const initial = signInOptions({ showToast: (message) => messages.push(message) });
  const completeSignIn = initial.auth.signIn;
  initial.auth.signIn = async () => { await completeSignIn(); throw new Error('Profile unavailable'); };
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  await act(async () => { assert.equal(await result.current.ensureSignedIn(), true); });
  assert.deepEqual(messages, []);
});

test('rejecting sign-in cancels the action even if a background refresh restores the session', async () => {
  const signature = deferred<{ wallet: string }>();
  const messages: string[] = [];
  let signatures = 0;
  let restored = false;
  const initial = signInOptions({
    showToast: (message) => messages.push(message),
    isUserRejectedError: (error) => error instanceof Error && error.message === 'User rejected the request',
  });
  initial.auth.hasAuthenticatedWalletSession = () => restored;
  initial.auth.signIn = () => { signatures += 1; return signature.promise; };
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let action!: Promise<boolean>;
  act(() => { action = result.current.ensureSignedIn(); });
  await waitFor(() => assert.equal(signatures, 1));
  await act(async () => {
    restored = true;
    signature.reject(new Error('User rejected the request'));
    assert.equal(await action, false);
  });
  await act(async () => assert.equal(await result.current.ensureSignedIn(), true));
  assert.equal(signatures, 1);
  assert.deepEqual(messages, []);
});

test('a rejected shared signature cancels quietly or shows one actionable error', async (t) => {
  for (const userRejected of [true, false]) {
    await t.test(userRejected ? 'user rejection stays silent' : 'other failures are shown once', async () => {
      const signature = deferred<{ wallet: string }>();
      let signatures = 0;
      const messages: string[] = [];
      const initial = signInOptions({
        showToast: (message) => messages.push(message),
        isUserRejectedError: () => userRejected,
      });
      initial.auth.signIn = () => { signatures += 1; return signature.promise; };
      const { result, unmount } = renderHook(useShopSignIn, { initialProps: initial });
      let header!: Promise<void>;
      let shipments!: Promise<void>;
      act(() => {
        header = result.current.handleHeaderWalletSignIn();
        shipments = result.current.handleSignInForShipments();
      });
      await waitFor(() => assert.equal(signatures, 1));
      await act(async () => {
        signature.reject(new Error('Sign-in failed. Please try again.'));
        await Promise.all([header, shipments]);
      });
      assert.equal(result.current.pendingHeaderWalletSignIn, false);
      assert.equal(result.current.pendingShipmentsSignIn, false);
      assert.deepEqual(messages, userRejected ? [] : ['Sign-in failed. Please try again.']);
      unmount();
    });
  }
});

test('navigation and unmount cancel pending actions and suppress late errors', async (t) => {
  for (const navigation of [true, false]) {
    await t.test(navigation ? 'pagehide' : 'unmount', async () => {
      const signature = deferred<{ wallet: string }>();
      const messages: string[] = [];
      let signatures = 0;
      const initial = signInOptions({ showToast: (message) => messages.push(message) });
      initial.auth.signIn = () => { signatures += 1; return signature.promise; };
      const { result, unmount } = renderHook(useShopSignIn, { initialProps: initial });
      let action!: Promise<boolean>;
      act(() => { action = result.current.ensureSignedIn(); });
      await waitFor(() => assert.equal(signatures, 1));
      if (navigation) act(() => window.dispatchEvent(new dom.window.Event('pagehide')));
      else unmount();
      await act(async () => {
        assert.equal(await action, false);
        signature.reject(new Error('Late rejection'));
      });
      assert.deepEqual(messages, []);
      if (navigation) unmount();
    });
  }
});


test('external identity invalidation cancels a same-wallet action before restoration can resume it', async () => {
  const restoration = deferred<'sign-in-required'>();
  const identity = new AbortController();
  let signatures = 0;
  const initial = signInOptions();
  initial.auth.intentCancellationSignal = identity.signal;
  initial.auth.awaitWalletSessionRestoration = () => restoration.promise;
  initial.auth.signIn = async () => { signatures += 1; return { wallet: initial.connectedWallet! }; };
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let action!: Promise<boolean>;
  act(() => { action = result.current.ensureSignedIn(); });
  await act(async () => undefined);
  await act(async () => {
    identity.abort();
    assert.equal(await action, false);
    restoration.resolve('sign-in-required');
  });
  assert.equal(signatures, 0);
});


test('cancelling the last caller closes its wallet picker and releases the selection attempt', async () => {
  const controller = new AbortController();
  const pickerChanges: boolean[] = [];
  const initial = signInOptions({
    connectedWallet: undefined,
    publicKey: null,
    setVisible: (visible) => pickerChanges.push(visible),
  });
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial });
  let action!: Promise<boolean>;
  act(() => { action = result.current.ensureSignedIn({ signal: controller.signal }); });
  rerender({ ...initial, walletModalVisible: true });
  await act(async () => {
    controller.abort();
    assert.equal(await action, false);
  });
  assert.deepEqual(pickerChanges, [true, false]);
});
