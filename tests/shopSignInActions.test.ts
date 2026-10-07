import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useShopSignIn } = await import('../src/shop/account/useShopSignIn.ts');
const { useShopActionContinuation } = await import('../src/shop/account/useShopActionContinuation.ts');
const { useShopActionHandlers } = await import('../src/shop/useShopActionHandlers.ts');
const { isUserRejectedError } = await import('../src/shop/commerce/transactionSupport.ts');

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
      isSignedInWallet: authenticated,
      hasAuthenticatedAccount: authenticated,
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
    return { signIn, continuation, handlers, walletModalVisible, setWalletModalVisible, authenticated };
  }, { initialProps: initial });
  const connect = () => act(() => {
    view.rerender({ ...initial, connected: true });
    view.result.current.setWalletModalVisible(false);
  });
  return { ...view, initial, connect, restoration, signature, mint, calls, messages };
}

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

  test(`${key} picker dismissal releases the action without resetting header readiness`, async () => {
    const context = rig(false);
    await waitFor(() => assert.equal(context.result.current.signIn.headerWalletButtonRevealed, true));
    let completion!: Promise<void>;
    act(() => { completion = context.result.current.handlers[handler](); });
    assert.equal(context.result.current.walletModalVisible, true);
    assert.equal(context.result.current.signIn.headerWalletButtonRevealed, true);
    act(() => { context.result.current.setWalletModalVisible(false); });
    await act(async () => { await completion; });
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.result.current.signIn.headerWalletButtonRevealed, true);
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
    assert.equal(context.result.current.signIn.headerWalletButtonRevealed, true);
    assert.deepEqual(context.messages, []);
  });

  test(`${key} signature rejection restores header readiness without a toast`, async () => {
    const context = rig();
    let completion!: Promise<void>;
    act(() => { completion = context.result.current.handlers[handler](); });
    await act(async () => { context.restoration.resolve('sign-in-required'); });
    await waitFor(() => assert.equal(context.calls.signature, 1));
    assert.equal(context.result.current.signIn.headerWalletButtonRevealed, false);
    await act(async () => {
      context.signature.reject(new Error('User rejected the request'));
      await completion;
    });
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.result.current.signIn.headerWalletButtonRevealed, true);
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
