import { MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES } from '../shared/fulfillmentAccess.ts';
import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { PublicKey } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveDropContent } from '../src/lib/dropContent.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useShopAccount, useShopAccountEffects } = await import('../src/shop/account/useShopAccount.ts');
const { useShopSignIn } = await import('../src/shop/account/useShopSignIn.ts');
const { useShopShipments } = await import('../src/shop/account/useShopShipments.ts');
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
      return { profile: { wallet: owner, email: 'viewed@example.com' }, nextCursor: null };
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
    nextCursor: null,
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

for (const wallet of MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES) {
  test(`mainnet admin-shipper cannot view other customers and keeps inventory scoped (${wallet.slice(0, 4)})`, async () => {
    const existingAdmin = [...ADMIN_WALLETS][0];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
    const initial: Parameters<typeof useShopAccount>[0] = {
      auth: { profile: { wallet }, sessionWallet: wallet, authenticated: true, deliveryRecoveryNextCheckAt: null },
      connectedWallet: wallet,
      stripeCheckoutDataOwner: wallet,
      routeCluster: 'devnet',
    };
    const adminRequests: string[] = [];
    const runtime: NonNullable<Parameters<typeof useShopAccount>[1]> = {
      getAdminProfileView: async (owner) => {
        adminRequests.push('profile');
        return { profile: { wallet: owner }, nextCursor: null };
      },
      listDeliveryOrderOwners: async () => {
        adminRequests.push('directory');
        return { owners: [], hasMore: false, nextCursor: null };
      },
    };
    const { result, rerender } = renderHook((options: typeof initial) => {
      const account = useShopAccount(options, runtime);
      useShopAccountEffects(account);
      return account;
    }, { initialProps: initial, wrapper });
    assert.equal(result.current.canUseAdminMenu, true);
    assert.equal(result.current.canUseAdminViewer, false);
    assert.equal(result.current.includeDevnetInventory, false);
    act(() => {
      result.current.setSettingsOpen(true);
      result.current.setOwnerPickerOpened(true);
      result.current.setAdminViewedOwner(existingAdmin);
    });
    await waitFor(() => assert.equal(result.current.adminViewedOwner, null));
    assert.equal(result.current.ownerPickerOpened, false);
    assert.equal(result.current.owner, wallet);
    assert.equal(result.current.viewedProfile?.wallet, wallet);
    assert.equal(result.current.includeDevnetInventory, false);
    assert.deepEqual(adminRequests, []);
    rerender({ ...initial, connectedWallet: undefined });
    assert.equal(result.current.includeDevnetInventory, false);
    rerender({ ...initial, auth: { ...initial.auth, sessionWallet: existingAdmin } });
    assert.equal(result.current.includeDevnetInventory, false);

    const ordinaryWallet = '11111111111111111111111111111111';
    rerender({
      auth: { ...initial.auth, sessionWallet: ordinaryWallet },
      connectedWallet: ordinaryWallet,
      stripeCheckoutDataOwner: ordinaryWallet,
      routeCluster: 'devnet',
    });
    assert.equal(result.current.includeDevnetInventory, true);
    rerender({
      auth: { ...initial.auth, sessionWallet: ordinaryWallet },
      connectedWallet: ordinaryWallet,
      stripeCheckoutDataOwner: ordinaryWallet,
      routeCluster: 'mainnet-beta',
    });
    assert.equal(result.current.includeDevnetInventory, false);
  });
}

test('mainnet-only admin-shipper shipment views hide devnet rows from every loaded page', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const wallet = 'ETaETZU82ZFnaz3j3TKAxRRzbQvt1Bn5tnF9EGMZe5zy';
  const owner = wallet;
  const orders = ['card_nft_2', 'card_nft_binder_devnet', '111k_devnet'].map((dropId) => ({
    dropId, deliveryId: 7, status: 'ready_to_ship', items: [],
  }));
  const options = {
    account: {
      canReadOwnProfile: true, isViewerMode: false, canUseAdminViewer: false, mainnetOnlyStaff: true,
      viewedProfile: { wallet: owner }, viewedProfileLoading: false, viewedProfileError: null,
      viewedProfileNextCursor: null, viewedProfileUpdatedAt: 1,
    },
    auth: {
      authSubject: wallet, sessionWallet: wallet, shipments: orders, shipmentsReady: true, shipmentsError: null, loading: false,
      shipmentsNextCursor: null, shipmentsRevision: 1,
    },
    stripeRecovery: { profileRecoveryPending: false, anonymousHistory: { orders: [], visible: false } },
    source: { figureMetadataByKey: {} },
    view: { inventoryInitialResponseReady: true, receiptItems: [], inventoryEmptyStateVisibility: 'visible' },
    signIn: { authReady: true, walletIdleReady: true },
    connectedWallet: wallet,
    getDropContent: resolveDropContent,
  } as Parameters<typeof useShopShipments>[0];
  const { result, rerender } = renderHook(useShopShipments, { initialProps: options, wrapper });
  await act(async () => undefined);
  assert.deepEqual(result.current.deliveryOrders.map((order) => order.dropId), ['card_nft_2']);
  const key = ['shipmentHistory', JSON.stringify([wallet, wallet, 'wallet', owner])];
  act(() => {
    client.setQueryData(key, {
      pages: [
        { orders, nextCursor: null },
        { orders: [
          { dropId: 'mi_note_cards_devnet', deliveryId: 8, status: 'ready_to_ship', items: [] },
          { dropId: 'mi_note_cards', deliveryId: 8, status: 'ready_to_ship', items: [] },
        ], nextCursor: null },
      ],
      pageParams: [null, null],
    });
  });
  await waitFor(() => assert.deepEqual(result.current.deliveryOrders.map((order) => order.dropId), ['card_nft_2', 'mi_note_cards']));
  rerender({ ...options, account: { ...options.account, mainnetOnlyStaff: false } });
  assert.equal(result.current.deliveryOrders.length, 5);
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
    showToast: () => undefined,
    isUserRejectedError: () => false,
    ...overrides,
  };
}

test('concurrent sign-in callers wait for shared restoration without a toast or a signature', async () => {
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
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  let third!: Promise<boolean>;
  const outcomes: boolean[] = [];
  act(() => {
    first = result.current.ensureSignedIn();
    second = result.current.ensureSignedIn();
    third = result.current.ensureSignedIn();
    for (const request of [first, second, third]) void request.then((outcome) => { outcomes.push(outcome); });
  });
  await waitFor(() => assert.equal(restores, 1));
  assert.deepEqual(outcomes, []);
  assert.equal(signatures, 0);
  assert.deepEqual(messages, []);
  await act(async () => {
    restored = true;
    restoration.resolve('restored');
    assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  });
  assert.deepEqual(outcomes, [true, true, true]);
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
  let third!: Promise<boolean>;
  act(() => {
    first = result.current.ensureSignedIn();
    second = result.current.ensureSignedIn();
    third = result.current.ensureSignedIn();
  });
  await act(async () => { restoration.resolve('sign-in-required'); });
  assert.equal(calls, 1);
  await act(async () => {
    signature.resolve();
    assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  });
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
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  let third!: Promise<boolean>;
  const outcomes: boolean[] = [];
  act(() => {
    first = result.current.ensureSignedIn();
    second = result.current.ensureSignedIn();
    third = result.current.ensureSignedIn();
    for (const request of [first, second, third]) void request.then((outcome) => { outcomes.push(outcome); });
  });
  rerender({ ...initial, walletModalVisible: false, wallet: { connecting: true, disconnecting: false } });
  await act(async () => undefined);
  assert.deepEqual(outcomes, []);
  rerender({ ...initial, walletModalVisible: false });
  await act(async () => {
    assert.deepEqual(await Promise.all([first, second, third]), [false, false, false]);
  });
  assert.deepEqual(outcomes, [false, false, false]);
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
  assert.equal(result.current.joinPendingSignIn(), null);
  let action!: Promise<boolean>;
  act(() => { action = result.current.ensureSignedIn({ signal: controller.signal }); });
  await act(async () => undefined);
  assert.equal(result.current.joinPendingSignIn(), null);
  await act(async () => {
    controller.abort();
    assert.equal(await action, false);
  });
  await act(async () => { restoration.resolve('sign-in-required'); });
  assert.equal(signatures, 0);
  assert.deepEqual(messages, []);
});

test('late cleanup of a cancelled restoration preserves an immediate replacement request', async () => {
  const firstRestoration = deferred<'sign-in-required'>();
  const nextRestoration = deferred<'sign-in-required'>();
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  let signatures = 0;
  let replacementSettled = false;
  const initial = signInOptions();
  const completeSignIn = initial.auth.signIn;
  initial.auth.awaitWalletSessionRestoration = (_wallet, signal) => {
    signals.push(signal);
    return signals.length === 1 ? firstRestoration.promise : nextRestoration.promise;
  };
  initial.auth.signIn = async () => { signatures += 1; return completeSignIn(); };
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let cancelled!: Promise<boolean>;
  let replacement!: Promise<boolean>;
  act(() => { cancelled = result.current.ensureSignedIn({ signal: controller.signal }); });
  await waitFor(() => assert.equal(signals.length, 1));
  act(() => {
    controller.abort();
    replacement = result.current.ensureSignedIn();
    void replacement.then(() => { replacementSettled = true; });
  });
  assert.equal(await cancelled, false);
  await waitFor(() => assert.equal(signals.length, 2));
  assert.equal(signals[0]?.aborted, true);
  assert.notEqual(signals[0], signals[1]);
  await act(async () => { firstRestoration.resolve('sign-in-required'); });
  assert.equal(signals[1]?.aborted, false);
  assert.equal(replacementSettled, false);
  assert.equal(signatures, 0);
  await act(async () => {
    nextRestoration.resolve('sign-in-required');
    assert.equal(await replacement, true);
  });
  assert.equal(signatures, 1);
});

test('a cancelled caller does not cancel another caller sharing the same prerequisite', async () => {
  const restoration = deferred<'sign-in-required'>();
  const controller = new AbortController();
  const initial = signInOptions();
  initial.auth.awaitWalletSessionRestoration = () => restoration.promise;
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let action!: Promise<boolean>;
  let otherCaller!: Promise<boolean>;
  let otherCallerSettled = false;
  act(() => {
    action = result.current.ensureSignedIn({ signal: controller.signal });
    otherCaller = result.current.ensureSignedIn();
    void otherCaller.then(() => { otherCallerSettled = true; });
  });
  await act(async () => {
    controller.abort();
    assert.equal(await action, false);
  });
  assert.equal(otherCallerSettled, false);
  await act(async () => {
    restoration.resolve('sign-in-required');
    assert.equal(await otherCaller, true);
  });
  assert.equal(initial.auth.hasAuthenticatedWalletSession(initial.connectedWallet!), true);
  assert.equal(otherCallerSettled, true);
});

test('new callers share a pending signature after the original caller cancels', async () => {
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
  let nextAction!: Promise<boolean>;
  act(() => { action = result.current.ensureSignedIn({ signal: controller.signal }); });
  await waitFor(() => assert.equal(signatures, 1));
  await act(async () => {
    controller.abort();
    assert.equal(await action, false);
    nextAction = result.current.ensureSignedIn();
  });
  assert.equal(signatures, 1);
  await act(async () => {
    signature.reject(new Error('Late rejection'));
    assert.equal(await nextAction, false);
  });
  assert.deepEqual(messages, ['Late rejection']);
  await act(async () => { assert.equal(await result.current.ensureSignedIn(), true); });
  assert.equal(signatures, 2);
});

for (const reason of ['wallet switch', 'identity change'] as const) test(`${reason} retains the signature lock until the pending request settles`, async () => {
  const signature = deferred<void>();
  const identity = new AbortController();
  let signatures = 0;
  const messages: string[] = [];
  const initial = signInOptions({ showToast: (message) => messages.push(message) });
  initial.auth.intentCancellationSignal = identity.signal;
  const completeSignIn = initial.auth.signIn;
  initial.auth.signIn = async () => {
    signatures += 1;
    if (signatures === 1) await signature.promise;
    return completeSignIn();
  };
  const { result, rerender } = renderHook(useShopSignIn, { initialProps: initial });
  let action!: Promise<boolean>;
  act(() => { action = result.current.ensureSignedIn(); });
  await waitFor(() => assert.equal(signatures, 1));
  if (reason === 'wallet switch') {
    const nextKey = new PublicKey(new Uint8Array(32).fill(2));
    rerender({ ...initial, connectedWallet: nextKey.toBase58(), publicKey: nextKey });
    rerender(initial);
  } else {
    act(() => identity.abort());
    rerender({ ...initial, auth: { ...initial.auth, intentCancellationSignal: new AbortController().signal } });
  }
  assert.equal(await action, false);
  assert.equal(result.current.joinPendingSignIn(), null);
  await act(async () => { assert.equal(await result.current.ensureSignedIn(), false); });
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

for (const approved of [true, false]) test(`wallet-only actions wait for a dismissed signature to be ${approved ? 'approved' : 'rejected'}`, async () => {
  const signature = deferred<void>();
  const controller = new AbortController();
  let signatures = 0;
  let walletReady = false;
  const initial = signInOptions({ isUserRejectedError: () => true });
  const completeSignIn = initial.auth.signIn;
  initial.auth.signIn = async () => {
    signatures += 1;
    await signature.promise;
    return completeSignIn();
  };
  const { result } = renderHook(useShopSignIn, { initialProps: initial });
  let signIn!: Promise<boolean>;
  act(() => { signIn = result.current.ensureSignedIn({ signal: controller.signal }); });
  await waitFor(() => assert.equal(signatures, 1));
  let wallet!: Promise<string | null>;
  await act(async () => {
    controller.abort();
    assert.equal(await signIn, false);
    wallet = result.current.ensureWalletConnected();
    void wallet.then(() => { walletReady = true; });
  });
  assert.equal(walletReady, false);
  await act(async () => {
    if (approved) signature.resolve();
    else signature.reject(new Error('User rejected the request'));
    assert.equal(await wallet, initial.connectedWallet);
  });
  assert.equal(walletReady, true);
  assert.equal(signatures, 1);
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
      let first!: Promise<boolean>;
      let second!: Promise<boolean>;
      act(() => {
        first = result.current.ensureSignedIn();
        second = result.current.ensureSignedIn();
      });
      await waitFor(() => assert.equal(signatures, 1));
      await act(async () => {
        signature.reject(new Error('Sign-in failed. Please try again.'));
        assert.deepEqual(await Promise.all([first, second]), [false, false]);
      });
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
