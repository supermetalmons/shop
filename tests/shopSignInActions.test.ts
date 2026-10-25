import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { createElement, useRef, useState, type PropsWithChildren } from 'react';
import { PublicKey } from '@solana/web3.js';
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

afterEach(cleanup);
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
    let completion!: Promise<void>;
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
    await completion;
    assert.equal(context.result.current.authenticated, true);
    assert.equal(context.calls.signature, 0);
    assert.deepEqual(context.messages, []);
  });

  test(`${key} continues from wallet selection through one signature`, async () => {
    const context = rig(false);
    let completion!: Promise<void>;
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
    await completion;
    assert.equal(context.result.current.authenticated, true);
    assert.deepEqual(context.messages, []);
  });

  test(`${key} picker dismissal releases the action without resetting wallet idle readiness`, async () => {
    const context = rig(false);
    await waitFor(() => assert.equal(context.result.current.signIn.walletIdleReady, true));
    let completion!: Promise<void>;
    act(() => { completion = context.result.current.handlers[handler](); });
    assert.equal(context.result.current.walletModalVisible, true);
    assert.equal(context.result.current.signIn.walletIdleReady, true);
    act(() => { context.result.current.setWalletModalVisible(false); });
    await act(async () => { await completion; });
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.result.current.signIn.walletIdleReady, true);
    context.connect();
    await act(async () => { context.restoration.resolve('sign-in-required'); });
    assert.deepEqual(context.calls, { restoration: 0, signature: 0, mint: 0 });
    assert.deepEqual(context.messages, []);
  });

  test(`${key} navigation cancels restoration and ignores late eligibility`, async () => {
    const context = rig();
    let completion!: Promise<void>;
    act(() => { completion = context.result.current.handlers[handler](); });
    await waitFor(() => assert.equal(context.calls.restoration, 1));
    context.rerender({ ...context.initial, scopeKey: '/card_nft_2' });
    await act(async () => { await completion; });
    assert.equal(context.result.current.continuation.pendingAction, null);
    await act(async () => { context.restoration.resolve('sign-in-required'); });
    assert.equal(context.calls.signature, 0);
    assert.equal(context.result.current.authenticated, false);
    assert.equal(context.result.current.signIn.authReady, true);
    assert.deepEqual(context.messages, []);
  });

  test(`${key} signature rejection clears authentication loading without a toast`, async () => {
    const context = rig();
    let completion!: Promise<void>;
    act(() => { completion = context.result.current.handlers[handler](); });
    await act(async () => { context.restoration.resolve('sign-in-required'); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    assert.equal(context.result.current.authLoading, true);
    await act(async () => {
      context.signature.reject(new Error('User rejected the request'));
      await completion;
    });
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.result.current.authLoading, false);
    assert.deepEqual(context.messages, []);
  });
}

test('a running mint keeps both sign-in actions blocked until it completes', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handleMint(1); });
  await waitFor(() => assert.equal(context.calls.mint, 1));
  await act(async () => {
    await context.result.current.handlers.handleHeaderSignIn();
    await context.result.current.handlers.handleShipmentsSignIn();
  });
  assert.deepEqual(context.result.current.continuation.pendingAction, { key: 'mint', phase: 'running' });
  assert.equal(context.calls.restoration, 0);
  assert.equal(context.calls.signature, 0);
  await act(async () => { context.mint.resolve(); await completion; });
  assert.equal(context.result.current.continuation.pendingAction, null);
  assert.deepEqual(context.messages, []);
});
