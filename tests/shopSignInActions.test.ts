import assert from 'node:assert/strict';
import test, { after, afterEach, mock } from 'node:test';
import { createElement, useRef, useState, type PropsWithChildren } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useShopSignIn } = await import('../src/shop/account/useShopSignIn.ts');
const { useShopActionContinuation } = await import('../src/shop/account/useShopActionContinuation.ts');
const { useShopActionHandlers } = await import('../src/shop/useShopActionHandlers.ts');
const { isUserRejectedError } = await import('../src/shop/commerce/transactionSupport.ts');
const { useSolanaAuthWithRuntime } = await import('../src/hooks/useSolanaAuth.ts');
const { useHeaderWallet } = await import('../src/shop/account/useHeaderWallet.ts');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

afterEach(() => { cleanup(); mock.restoreAll(); });
after(() => dom.window.close());

const publicKey = new PublicKey(new Uint8Array(32).fill(1));
const owner = publicKey.toBase58();
type RigProps = { connected: boolean; scopeKey: string };
type Restoration = 'restored' | 'sign-in-required' | 'cancelled';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function rig(connected = true) {
  const restoration = deferred<Restoration>();
  const signature = deferred<void>();
  const mint = deferred<void>();
  const calls = { restoration: 0, signature: 0, mint: 0 };
  const messages: string[] = [];
  const showToast = (message: string) => { messages.push(message); };
  const initial: RigProps = { connected, scopeKey: '/' };
  const view = renderHook((props: RigProps) => {
    const connectedWallet = props.connected ? owner : undefined;
    const [walletModalVisible, setWalletModalVisible] = useState(false);
    const [authenticated, setAuthenticated] = useState(false);
    const [authLoading, setAuthLoading] = useState(false);
    const authenticatedRef = useRef(false);
    const establishSession = () => {
      authenticatedRef.current = true;
      setAuthenticated(true);
      return { wallet: owner };
    };
    const signIn = useShopSignIn({
      auth: {
        loading: authLoading,
        sessionResolution: 'settled',
        hasAuthenticatedWalletSession: (wallet) => authenticatedRef.current && wallet === owner,
        awaitWalletSessionRestoration: async (_wallet, signal) => {
          calls.restoration += 1;
          const outcome = await restoration.promise;
          if (signal?.aborted) return 'cancelled';
          if (outcome === 'restored') establishSession();
          return outcome;
        },
        signIn: async () => {
          calls.signature += 1;
          setAuthLoading(true);
          try {
            await signature.promise;
            return establishSession();
          } finally {
            setAuthLoading(false);
          }
        },
      },
      connectedWallet,
      publicKey: props.connected ? publicKey : null,
      wallet: { connecting: false, disconnecting: false },
      walletModalVisible,
      setVisible: setWalletModalVisible,
      showToast,
      isUserRejectedError,
    });
    const continuation = useShopActionContinuation({
      connectedWallet,
      scopeKey: props.scopeKey,
      ensureSignedIn: signIn.ensureSignedIn,
      ensureWalletConnected: signIn.ensureWalletConnected,
      showToast,
    });
    const handlers = useShopActionHandlers({
      continuation,
      owner: connectedWallet,
      routeDropId: 'card_nft_2',
      blockViewerModeAction: () => false,
      showToast,
      purchase: { handleMint: async () => { calls.mint += 1; await mint.promise; } },
    } as unknown as Parameters<typeof useShopActionHandlers>[0]);
    return { signIn, continuation, handlers, walletModalVisible, setWalletModalVisible, authenticated, authLoading };
  }, { initialProps: initial });
  const connect = () => act(() => {
    view.rerender({ ...initial, connected: true });
    view.result.current.setWalletModalVisible(false);
  });
  return { ...view, initial, connect, restoration, signature, mint, calls, messages };
}

function headerSignInRig({ initiallyConnected = false, holdProfile = false } = {}) {
  const signedOut = { responseMode: 'profile-state' as const, sessionWallet: null, profile: null, shipments: null, nextCursor: null };
  const bootstrap = deferred<typeof signedOut>();
  const signature = deferred<void>();
  const profile = deferred<void>();
  const mint = deferred<void>();
  const calls = { profile: 0, picker: 0, signIn: 0, signature: 0, mint: 0 };
  const messages: string[] = [];
  const showToast = (message: string) => { messages.push(message); };
  let authenticated = false;
  let signaturePending = false;
  mock.method(Connection.prototype, 'getAccountInfo', async () => null);
  const runtime: Parameters<typeof useSolanaAuthWithRuntime>[1] = {
    currentAuthSubject: () => 'auth-a',
    subscribeAuthSubject: () => () => {},
    ensureAuthenticated: async () => 'auth-a',
    loadProfileState: async () => {
      calls.profile += 1;
      if (calls.profile === 1) return bootstrap.promise;
      if (authenticated && holdProfile) await profile.promise;
      return authenticated ? {
        responseMode: 'profile-state', sessionWallet: owner,
        profile: { status: 'ready', value: { wallet: owner } },
        shipments: { status: 'ready', value: [] }, nextCursor: null,
      } : signedOut;
    },
    reconcileProfileState: async () => ({ mergedStripeDeliveryOrders: 0 }),
    authenticateWallet: async () => { authenticated = true; return { wallet: owner }; },
    signOut: async () => { authenticated = false; },
    subscribeRefreshEvents: () => () => {},
    isPageVisible: () => true,
    now: Date.now,
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const view = renderHook(() => {
    const [connected, setConnected] = useState(initiallyConnected);
    const [walletModalVisible, setWalletModalVisible] = useState(false);
    const wallet = {
      connected, publicKey: connected ? publicKey : null, connecting: false, disconnecting: false, wallet: null,
      signMessage: async () => {
        calls.signature += 1;
        signaturePending = true;
        try {
          await signature.promise;
          return new Uint8Array(64);
        } finally {
          signaturePending = false;
        }
      },
      disconnect: async () => setConnected(false),
    };
    const auth = useSolanaAuthWithRuntime(wallet, runtime);
    const signIn = useShopSignIn({
      auth, connectedWallet: connected ? owner : undefined, publicKey: wallet.publicKey, wallet, walletModalVisible,
      setVisible: (visible) => { if (visible) calls.picker += 1; setWalletModalVisible(visible); },
      showToast, isUserRejectedError,
    });
    const continuation = useShopActionContinuation({
      connectedWallet: connected ? owner : undefined, scopeKey: '/', cancellationSignal: auth.intentCancellationSignal,
      ensureSignedIn: signIn.ensureSignedIn, ensureWalletConnected: signIn.ensureWalletConnected, showToast,
    });
    const handlers = useShopActionHandlers({
      continuation, showToast, owner, routeDropId: 'card_nft_2', blockViewerModeAction: () => false,
      purchase: { handleMint: async () => {
        assert.equal(signaturePending, false, 'A wallet signature approval is still pending');
        calls.mint += 1;
        await mint.promise;
      } },
    } as unknown as Parameters<typeof useShopActionHandlers>[0]);
    const control = useHeaderWallet({
      auth, wallet, walletModalVisible, scopeKey: '/',
      signIn: (request) => { calls.signIn += 1; return handlers.handleHeaderSignIn(request); },
      joinPendingSignIn: signIn.joinPendingSignIn,
      signInPending: continuation.pendingAction?.phase === 'authenticating',
      mutationPending: continuation.pendingAction?.phase === 'running',
      showToast,
    });
    return { auth, control, continuation, handlers, walletModalVisible, setWalletModalVisible, setConnected };
  }, { wrapper });
  return {
    ...view, calls, messages, signature, profile, mint,
    finishLoading: () => act(async () => { bootstrap.resolve(signedOut); }),
    connect: () => act(() => { view.result.current.setConnected(true); view.result.current.setWalletModalVisible(false); }),
    dispose: () => { view.unmount(); client.clear(); },
  };
}

test('an early wallet click restores through the real sign-in flow into its loaded popup', async () => {
  const context = headerSignInRig();
  try {
    await waitFor(() => assert.equal(context.result.current.auth.sessionResolution, 'resolving'));
    assert.equal(context.result.current.control.buttonDisabled, false);
    await act(async () => { await context.result.current.control.activate(); });
    assert.equal(context.result.current.control.open, true);
    assert.equal(context.result.current.control.status, 'loading');
    assert.equal(context.calls.signIn, 0);
    await context.finishLoading();
    await waitFor(() => assert.equal(context.result.current.walletModalVisible, true));
    assert.equal(context.calls.picker, 1);
    assert.equal(context.calls.signIn, 1);
    assert.equal(context.result.current.control.open, false);
    context.connect();
    await waitFor(() => assert.equal(context.calls.signature, 1));
    assert.equal(context.result.current.control.open, true);
    assert.equal(context.result.current.control.status, 'signing-in');
    await act(async () => { context.signature.resolve(); });
    await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
    assert.equal(context.result.current.control.open, true);
    assert.equal(context.result.current.control.status, 'account');
    assert.equal(context.result.current.control.address, owner);
    assert.equal(context.result.current.control.buttonDisabled, false);
    assert.equal(context.calls.picker, 1);
    assert.equal(context.calls.signIn, 1);
    assert.equal(context.calls.signature, 1);
    assert.deepEqual(context.messages, []);
  } finally {
    context.dispose();
  }
});

test('cancelling the early-click wallet picker closes its popup without restarting sign-in', async () => {
  const context = headerSignInRig();
  try {
    await waitFor(() => assert.equal(context.result.current.auth.sessionResolution, 'resolving'));
    await act(async () => { await context.result.current.control.activate(); });
    await context.finishLoading();
    await waitFor(() => assert.equal(context.result.current.walletModalVisible, true));
    act(() => { context.result.current.setWalletModalVisible(false); });
    await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
    assert.equal(context.result.current.control.open, false);
    context.connect();
    await waitFor(() => assert.equal(context.result.current.auth.sessionResolution, 'settled'));
    assert.equal(context.result.current.control.open, false);
    assert.equal(context.result.current.walletModalVisible, false);
    assert.equal(context.calls.picker, 1);
    assert.equal(context.calls.signIn, 1);
    assert.equal(context.calls.signature, 0);
    assert.deepEqual(context.messages, []);
  } finally {
    context.dispose();
  }
});

for (const outcome of ['approval', 'rejection'] as const) test(`reopening the header shares a pending signature and respects its ${outcome}`, async () => {
  const context = headerSignInRig({ initiallyConnected: true });
  mock.method(console, 'error', () => {});
  try {
    await context.finishLoading();
    await act(async () => { await context.result.current.control.activate(); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    await act(async () => { context.result.current.control.close(); });
    assert.equal(context.result.current.continuation.pendingAction, null);
    await act(async () => { await context.result.current.control.activate(); });
    assert.equal(context.result.current.control.status, 'signing-in');
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.calls.signature, 1);
    await act(async () => {
      if (outcome === 'approval') context.signature.resolve();
      else context.signature.reject(new Error('User rejected the request'));
    });
    await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
    assert.equal(context.result.current.control.open, outcome === 'approval');
    if (outcome === 'approval') {
      assert.equal(context.result.current.control.status, 'account');
      assert.equal(context.result.current.control.address, owner);
    }
    assert.equal(context.calls.signature, 1);
    assert.equal(context.calls.picker, 0);
    assert.deepEqual(context.messages, []);
  } finally {
    context.dispose();
    context.signature.resolve();
  }
});

for (const outcome of ['approval', 'rejection'] as const) test(`a reopened header observes signature ${outcome} before a waiting purchase runs`, async () => {
  const context = headerSignInRig({ initiallyConnected: true });
  mock.method(console, 'error', () => {});
  try {
    await context.finishLoading();
    await act(async () => { await context.result.current.control.activate(); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    await act(async () => { context.result.current.control.close(); });
    let purchase!: Promise<void>;
    await act(async () => { purchase = context.result.current.handlers.handleMint(1); });
    assert.equal(context.calls.mint, 0);
    await act(async () => { await context.result.current.control.activate(); });
    assert.equal(context.result.current.control.status, 'signing-in');
    assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'mint', phase: 'authenticating' });
    await act(async () => {
      if (outcome === 'approval') context.signature.resolve();
      else context.signature.reject(new Error('User rejected the request'));
    });
    await waitFor(() => assert.equal(context.calls.mint, 1));
    assert.equal(context.result.current.control.open, outcome === 'approval');
    if (outcome === 'approval') assert.equal(context.result.current.control.status, 'account');
    assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'mint', phase: 'running' });
    await act(async () => { context.mint.resolve(); await purchase; });
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.result.current.control.open, outcome === 'approval');
    assert.equal(context.calls.signature, 1);
    assert.equal(context.calls.signIn, 1);
    assert.deepEqual(context.messages, []);
  } finally {
    context.dispose();
    context.signature.resolve();
    context.mint.resolve();
  }
});

test('dismissing a header observing authentication preserves its waiting purchase and stays closed', async () => {
  const context = headerSignInRig({ initiallyConnected: true });
  try {
    await context.finishLoading();
    await act(async () => { await context.result.current.control.activate(); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    await act(async () => { context.result.current.control.close(); });
    let purchase!: Promise<void>;
    await act(async () => { purchase = context.result.current.handlers.handleMint(1); });
    assert.equal(context.calls.mint, 0);
    await act(async () => { await context.result.current.control.activate(); });
    await act(async () => { context.result.current.control.close(); });
    assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'mint', phase: 'authenticating' });
    await act(async () => { context.signature.resolve(); });
    await waitFor(() => assert.equal(context.calls.mint, 1));
    assert.equal(context.result.current.control.open, false);
    assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'mint', phase: 'running' });
    await act(async () => { context.mint.resolve(); await purchase; });
    assert.equal(context.result.current.control.open, false);
    assert.equal(context.calls.signature, 1);
    assert.equal(context.calls.signIn, 1);
    assert.deepEqual(context.messages, []);
  } finally {
    context.dispose();
    context.signature.resolve();
    context.mint.resolve();
  }
});

test('a fresh header request cannot start authentication until a running purchase finishes', async () => {
  const context = headerSignInRig({ initiallyConnected: true });
  try {
    await context.finishLoading();
    let purchase!: Promise<void>;
    act(() => { purchase = context.result.current.handlers.handleMint(1); });
    await waitFor(() => assert.equal(context.calls.mint, 1));
    await act(async () => { await context.result.current.control.activate(); });
    assert.equal(context.result.current.control.open, true);
    assert.equal(context.calls.signIn, 0);
    assert.equal(context.calls.signature, 0);
    assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'mint', phase: 'running' });
    await act(async () => { context.mint.resolve(); await purchase; });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    await act(async () => { context.signature.resolve(); });
    assert.equal(context.result.current.control.status, 'account');
    assert.equal(context.result.current.control.open, true);
  } finally {
    context.dispose();
    context.signature.resolve();
    context.mint.resolve();
  }
});

for (const stage of ['signature', 'profile refresh'] as const) test(`a later purchase waits for ${stage} after the header closes`, async () => {
  const context = headerSignInRig({ initiallyConnected: true, holdProfile: true });
  try {
    await context.finishLoading();
    await act(async () => { await context.result.current.control.activate(); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    if (stage === 'profile refresh') {
      await act(async () => { context.signature.resolve(); });
      await waitFor(() => assert.equal(context.result.current.control.status, 'account'));
    }
    await act(async () => { context.result.current.control.close(); });
    assert.equal(context.result.current.continuation.pendingAction, null);
    let purchase!: Promise<void>;
    await act(async () => { purchase = context.result.current.handlers.handleMint(1); });
    assert.equal(context.calls.mint, 0);
    assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'mint', phase: 'authenticating' });
    await act(async () => { context.signature.resolve(); context.profile.resolve(); });
    await waitFor(() => assert.equal(context.calls.mint, 1));
    assert.equal(context.result.current.auth.authenticated, true);
    assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'mint', phase: 'running' });
    assert.equal(context.result.current.control.open, false);
    assert.equal(context.calls.signature, 1);
    await act(async () => { context.mint.resolve(); await purchase; });
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.deepEqual(context.messages, []);
  } finally {
    context.signature.resolve();
    context.profile.resolve();
    context.mint.resolve();
    context.dispose();
  }
});

for (const stage of ['signature', 'profile refresh'] as const) test(`a new authenticated action after header cancellation shares the pending ${stage}`, async () => {
  const context = headerSignInRig({ initiallyConnected: true, holdProfile: true });
  try {
    await context.finishLoading();
    await act(async () => { await context.result.current.control.activate(); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    if (stage === 'profile refresh') {
      await act(async () => { context.signature.resolve(); });
      await waitFor(() => assert.equal(context.result.current.control.status, 'account'));
    }
    await act(async () => { context.result.current.control.close(); });
    let purchase!: Promise<boolean>;
    await act(async () => {
      purchase = context.result.current.continuation.run({
        key: 'authenticated-purchase', requirement: 'sign-in', cancelled: false,
        execute: async () => { context.calls.mint += 1; await context.mint.promise; return true; },
      });
    });
    assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'authenticated-purchase', phase: 'authenticating' });
    assert.equal(context.calls.signature, 1);
    assert.equal(context.calls.mint, 0);
    await act(async () => { context.signature.resolve(); context.profile.resolve(); });
    await waitFor(() => assert.equal(context.calls.mint, 1));
    assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'authenticated-purchase', phase: 'running' });
    assert.equal(context.result.current.control.open, false);
    assert.equal(context.calls.signature, 1);
    await act(async () => { context.mint.resolve(); assert.equal(await purchase, true); });
    assert.deepEqual(context.messages, []);
  } finally {
    context.signature.resolve();
    context.profile.resolve();
    context.mint.resolve();
    context.dispose();
  }
});

test('a dismissed header sign-in does not show a late signature error toast', async () => {
  const context = headerSignInRig({ initiallyConnected: true });
  mock.method(console, 'error', () => {});
  try {
    await context.finishLoading();
    await act(async () => { await context.result.current.control.activate(); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    await act(async () => { context.result.current.control.close(); });
    await act(async () => { context.signature.reject(new Error('Wallet request failed')); });
    await waitFor(() => assert.equal(context.result.current.auth.loading, false));
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.result.current.control.open, false);
    assert.deepEqual(context.messages, []);
  } finally {
    context.dispose();
  }
});

test('header logout blocks a new mint until session revocation and adapter disconnect finish', async () => {
  const logout = deferred<void>();
  const adapterDisconnect = deferred<void>();
  const events: string[] = [];
  let loggedOut = false;
  const runtime: Parameters<typeof useSolanaAuthWithRuntime>[1] = {
    currentAuthSubject: () => 'auth-a',
    subscribeAuthSubject: () => () => {},
    ensureAuthenticated: async () => 'auth-a',
    loadProfileState: async () => loggedOut
      ? { responseMode: 'profile-state', sessionWallet: null, profile: null, shipments: null, nextCursor: null }
      : {
        responseMode: 'profile-state', sessionWallet: owner,
        profile: { status: 'ready', value: { wallet: owner } },
        shipments: { status: 'ready', value: [] }, nextCursor: null,
      },
    reconcileProfileState: async () => ({ mergedStripeDeliveryOrders: 0 }),
    authenticateWallet: async () => ({ wallet: owner }),
    signOut: async () => { events.push('sign-out'); await logout.promise; loggedOut = true; },
    subscribeRefreshEvents: () => () => {},
    isPageVisible: () => true,
    now: Date.now,
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  const view = renderHook(() => {
    const [connected, setConnected] = useState(true);
    const [disconnecting, setDisconnecting] = useState(false);
    const wallet = {
      connected, publicKey: connected ? publicKey : null, connecting: false, disconnecting: false, wallet: null,
      signMessage: async () => new Uint8Array(64),
      disconnect: async () => { events.push('disconnect'); await adapterDisconnect.promise; setConnected(false); },
    };
    const auth = useSolanaAuthWithRuntime(wallet, runtime);
    const signIn = useShopSignIn({
      auth, connectedWallet: connected ? owner : undefined, publicKey: wallet.publicKey, wallet,
      walletModalVisible: false, setVisible: () => {}, showToast: () => {}, isUserRejectedError,
    });
    const continuation = useShopActionContinuation({
      connectedWallet: connected ? owner : undefined,
      blocked: disconnecting,
      cancellationSignal: auth.intentCancellationSignal,
      scopeKey: '/',
      ensureSignedIn: signIn.ensureSignedIn,
      ensureWalletConnected: signIn.ensureWalletConnected,
      showToast: () => {},
    });
    const control = useHeaderWallet({
      auth, wallet, signIn: signIn.ensureSignedIn,
      mutationPending: continuation.pendingAction?.phase === 'running',
      signInPending: continuation.pendingAction?.phase === 'authenticating',
      onBeforeDisconnect: continuation.cancel,
      onDisconnectingChange: setDisconnecting,
      showToast: () => {},
    });
    return { auth, control, continuation, connected, disconnecting };
  }, { wrapper });
  await waitFor(() => assert.equal(view.result.current.auth.authenticated, true));
  let completion!: Promise<void>;
  act(() => { completion = view.result.current.control.disconnect(); });
  assert.equal(view.result.current.disconnecting, true);
  assert.equal(view.result.current.connected, true);
  await act(async () => {
    await view.result.current.continuation.run({
      key: 'mint', requirement: 'wallet', cancelled: undefined,
      execute: () => { events.push('mint'); },
    });
  });
  assert.equal(view.result.current.continuation.pendingAction, null);
  assert.deepEqual(events, ['sign-out']);
  await act(async () => { logout.resolve(); });
  assert.equal(view.result.current.disconnecting, true);
  await act(async () => {
    await view.result.current.continuation.run({
      key: 'mint', requirement: 'wallet', cancelled: undefined,
      execute: () => { events.push('mint'); },
    });
  });
  assert.deepEqual(events, ['sign-out', 'disconnect']);
  await act(async () => { adapterDisconnect.resolve(); await completion; });
  assert.equal(view.result.current.disconnecting, false);
  assert.equal(view.result.current.connected, false);
  view.unmount();
  client.clear();
});

for (const [handler, key] of [
  ['handleHeaderSignIn', 'header-sign-in'],
  ['handleShipmentsSignIn', 'shipments-sign-in'],
] as const) {
  test(`${key} shares restoration through the live action flow and suppresses repeat clicks`, async () => {
    const context = rig();
    let completion!: Promise<void | boolean>;
    act(() => { completion = context.result.current.handlers[handler](); });
    assert.deepEqual(context.result.current.continuation.pendingAction, { key, phase: 'authenticating' });
    await waitFor(() => assert.equal(context.calls.restoration, 1));
    await act(async () => {
      await context.result.current.handlers.handleHeaderSignIn();
      await context.result.current.handlers.handleShipmentsSignIn();
    });
    assert.equal(context.calls.restoration, 1);
    assert.equal(context.result.current.continuation.pendingAction?.key, key);
    await act(async () => { context.restoration.resolve('restored'); });
    await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
    assert.equal(await completion, handler === 'handleHeaderSignIn' ? true : undefined);
    assert.equal(context.result.current.authenticated, true);
    assert.equal(context.calls.signature, 0);
    assert.deepEqual(context.messages, []);
  });

  test(`${key} continues from wallet selection through one signature`, async () => {
    const context = rig(false);
    let completion!: Promise<void | boolean>;
    act(() => { completion = context.result.current.handlers[handler](); });
    assert.equal(context.result.current.walletModalVisible, true);
    context.connect();
    await act(async () => { context.restoration.resolve('sign-in-required'); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    await act(async () => { await context.result.current.handlers[handler](); });
    assert.deepEqual(context.result.current.continuation.pendingAction, { key, phase: 'authenticating' });
    assert.equal(context.calls.signature, 1);
    await act(async () => { context.signature.resolve(); });
    await waitFor(() => assert.equal(context.result.current.continuation.pendingAction, null));
    assert.equal(await completion, handler === 'handleHeaderSignIn' ? true : undefined);
    assert.equal(context.result.current.authenticated, true);
    assert.deepEqual(context.messages, []);
  });

  test(`${key} picker dismissal releases the action without resetting wallet idle readiness`, async () => {
    const context = rig(false);
    await waitFor(() => assert.equal(context.result.current.signIn.walletIdleReady, true));
    let completion!: Promise<void | boolean>;
    act(() => { completion = context.result.current.handlers[handler](); });
    assert.equal(context.result.current.walletModalVisible, true);
    assert.equal(context.result.current.signIn.walletIdleReady, true);
    act(() => { context.result.current.setWalletModalVisible(false); });
    await act(async () => { assert.equal(await completion, handler === 'handleHeaderSignIn' ? false : undefined); });
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.result.current.signIn.walletIdleReady, true);
    context.connect();
    await act(async () => { context.restoration.resolve('sign-in-required'); });
    assert.deepEqual(context.calls, { restoration: 0, signature: 0, mint: 0 });
    assert.deepEqual(context.messages, []);
  });

  test(`${key} navigation cancels restoration and ignores late eligibility`, async () => {
    const context = rig();
    let completion!: Promise<void | boolean>;
    act(() => { completion = context.result.current.handlers[handler](); });
    await waitFor(() => assert.equal(context.calls.restoration, 1));
    context.rerender({ ...context.initial, scopeKey: '/card_nft_2' });
    await act(async () => { assert.equal(await completion, handler === 'handleHeaderSignIn' ? false : undefined); });
    assert.equal(context.result.current.continuation.pendingAction, null);
    await act(async () => { context.restoration.resolve('sign-in-required'); });
    assert.equal(context.calls.signature, 0);
    assert.equal(context.result.current.authenticated, false);
    assert.equal(context.result.current.signIn.authReady, true);
    assert.deepEqual(context.messages, []);
  });

  test(`${key} signature rejection clears authentication loading without a toast`, async () => {
    const context = rig();
    let completion!: Promise<void | boolean>;
    act(() => { completion = context.result.current.handlers[handler](); });
    await act(async () => { context.restoration.resolve('sign-in-required'); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    assert.equal(context.result.current.authLoading, true);
    await act(async () => {
      context.signature.reject(new Error('User rejected the request'));
      assert.equal(await completion, handler === 'handleHeaderSignIn' ? false : undefined);
    });
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.result.current.authLoading, false);
    assert.deepEqual(context.messages, []);
  });
}

test('cancelling a header request dismisses its picker without later connecting', async () => {
  const context = rig(false);
  const request = new AbortController();
  let completion!: Promise<boolean>;
  act(() => { completion = context.result.current.handlers.handleHeaderSignIn({ signal: request.signal }); });
  assert.equal(context.result.current.walletModalVisible, true);
  await act(async () => { request.abort(); assert.equal(await completion, false); });
  assert.equal(context.result.current.walletModalVisible, false);
  assert.equal(context.result.current.continuation.pendingAction, null);
  context.connect();
  await act(async () => { context.restoration.resolve('sign-in-required'); });
  assert.deepEqual(context.calls, { restoration: 0, signature: 0, mint: 0 });
  assert.deepEqual(context.messages, []);
});

test('cancelling a header request during restoration prevents a later signature', async () => {
  const context = rig();
  const request = new AbortController();
  let completion!: Promise<boolean>;
  act(() => { completion = context.result.current.handlers.handleHeaderSignIn({ signal: request.signal }); });
  await waitFor(() => assert.equal(context.calls.restoration, 1));
  await act(async () => { request.abort(); assert.equal(await completion, false); });
  await act(async () => { context.restoration.resolve('sign-in-required'); });
  assert.equal(context.calls.signature, 0);
  assert.equal(context.result.current.continuation.pendingAction, null);
  assert.equal(context.result.current.authenticated, false);
});

test('a pre-cancelled header request does not open a wallet picker', async () => {
  const context = rig(false);
  const request = new AbortController();
  request.abort();
  assert.equal(await context.result.current.handlers.handleHeaderSignIn({ signal: request.signal }), false);
  assert.equal(context.result.current.walletModalVisible, false);
  assert.equal(context.result.current.continuation.pendingAction, null);
  assert.deepEqual(context.calls, { restoration: 0, signature: 0, mint: 0 });
});

test('a running mint keeps both sign-in actions blocked until it completes', async () => {
  const context = rig();
  const request = new AbortController();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleMint(1); });
  await waitFor(() => assert.equal(context.calls.mint, 1));
  await act(async () => {
    assert.equal(await context.result.current.handlers.handleHeaderSignIn({ signal: request.signal }), false);
    await context.result.current.handlers.handleShipmentsSignIn();
    request.abort();
  });
  assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'mint', phase: 'running' });
  assert.equal(context.calls.restoration, 0);
  assert.equal(context.calls.signature, 0);
  await act(async () => { context.mint.resolve(); await completion; });
  assert.equal(context.result.current.continuation.pendingAction, null);
  assert.deepEqual(context.messages, []);
});
