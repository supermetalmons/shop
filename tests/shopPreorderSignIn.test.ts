import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { useRef, useState } from 'react';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getPreorderConfig, type PreorderOrder } from '../shared/preorders.ts';
import type { createPreorderApi } from '../src/lib/preorderApi.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { useShopSignIn } = await import('../src/shop/account/useShopSignIn.ts');
const { useShopActionContinuation } = await import('../src/shop/account/useShopActionContinuation.ts');
const { useShopActionHandlers } = await import('../src/shop/useShopActionHandlers.ts');
const { usePreorderCheckout } = await import('../src/hooks/usePreorderCheckout.ts');

afterEach(() => { cleanup(); window.localStorage.clear(); });
after(() => dom.window.close());

const config = getPreorderConfig('mi_note_cards_devnet')!;
type PreorderApi = ReturnType<typeof createPreorderApi>;
type RigProps = { connected: boolean; scopeKey: string; ethereumAddress?: string };
const ethereumSession = {
  address: '0x0000000000000000000000000000000000000001', token: 'ethereum-session',
  preorderId: config.preorderId, expiresAtMs: Date.now() + 3_600_000,
};
const secondEthereumSession = { ...ethereumSession, address: '0x0000000000000000000000000000000000000002', token: 'second-ethereum-session' };
type Restoration = 'restored' | 'sign-in-required' | 'cancelled';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function rig() {
  const payer = Keypair.generate();
  const buyer = payer.publicKey.toBase58();
  const restoration = deferred<Restoration>();
  const signInApproval = deferred<void>();
  const recovered = deferred<{ order: PreorderOrder | null }>();
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message());
  const transactionBase64 = Buffer.from(transaction.serialize()).toString('base64');
  const calls = {
    restoration: 0, signIn: 0, transactionSign: 0, recovery: 0,
    prepare: [] as Parameters<PreorderApi['prepare']>[0][],
    submit: [] as Parameters<PreorderApi['submit']>[0][],
  };
  const messages: string[] = [];
  let preparedOrder: PreorderOrder | null = null;
  const api: PreorderApi = {
    availability: async () => ({ preorderId: config.preorderId, ethereumAddress: ethereumSession.address, ownershipStatus: 'success', requiresAdminSignIn: false, items: [1, 2, 3].map((id) => ({ id, status: 'available' })) }),
    status: async () => { calls.recovery += 1; return recovered.promise; },
    prepare: async (input) => {
      calls.prepare.push(input);
      preparedOrder = {
        orderId: 'order-1', preorderId: config.preorderId, buyer: input.buyer, ethereumAddress: ethereumSession.address, cardIds: input.cardIds,
        assets: input.cardIds.map((id) => ({ id, address: Keypair.generate().publicKey.toBase58() })),
        status: 'prepared', expiresAtMs: Date.now() + 120_000, signature: null,
      };
      return { order: preparedOrder, transactionBase64 };
    },
    submit: async (input) => {
      calls.submit.push(input);
      assert.ok(preparedOrder);
      return { order: { ...preparedOrder, status: 'submitted' } };
    },
    cancel: async () => { throw new Error('Unexpected preorder cancellation'); },
  };
  const initial: RigProps = { connected: false, scopeKey: '/mi_note_cards_devnet' };
  const view = renderHook((props: RigProps) => {
    const publicKey = props.connected ? payer.publicKey : null;
    const connectedWallet = publicKey?.toBase58();
    const [walletModalVisible, setWalletModalVisible] = useState(false);
    const [authenticatedWallet, setAuthenticatedWallet] = useState<string | null>(null);
    const authenticatedWalletRef = useRef<string | null>(null);
    const authenticated = Boolean(connectedWallet && authenticatedWallet === connectedWallet);
    const establishSession = () => {
      assert.ok(connectedWallet, 'Sign-in must use the current connected wallet');
      authenticatedWalletRef.current = connectedWallet;
      setAuthenticatedWallet(connectedWallet);
      return { wallet: connectedWallet };
    };
    const signIn = useShopSignIn({
      auth: {
        loading: !authenticated,
        sessionResolution: authenticated ? 'settled' : 'resolving',
        hasAuthenticatedWalletSession: (wallet) => authenticatedWalletRef.current === wallet,
        awaitWalletSessionRestoration: async () => {
          calls.restoration += 1;
          const outcome = await restoration.promise;
          if (outcome === 'restored') establishSession();
          return outcome;
        },
        signIn: async () => {
          calls.signIn += 1;
          await signInApproval.promise;
          return establishSession();
        },
      },
      connectedWallet, publicKey,
      wallet: { connecting: false, disconnecting: false },
      walletModalVisible, setVisible: setWalletModalVisible,
      isSignedInWallet: authenticated, hasAuthenticatedAccount: authenticated,
      showToast: (message) => { messages.push(message); },
      isUserRejectedError: () => false,
    });
    const continuation = useShopActionContinuation({
      connectedWallet, scopeKey: props.scopeKey,
      ensureSignedIn: signIn.ensureSignedIn, ensureWalletConnected: signIn.ensureWalletConnected,
      showToast: (message) => { messages.push(message); },
    });
    const preorder = usePreorderCheckout({
      config, active: props.scopeKey === initial.scopeKey, buyer: connectedWallet, signedIn: authenticated,
      ethereumSession: props.ethereumAddress === secondEthereumSession.address ? secondEthereumSession : ethereumSession,
      ensureSignedIn: continuation.ensureActionSignedIn,
      signTransaction: publicKey ? async (tx) => { calls.transactionSign += 1; tx.sign([payer]); return tx; } : undefined,
      onSucceeded: () => {},
    }, api);
    const handlers = useShopActionHandlers({
      continuation, preorder, owner: connectedWallet, routeDropId: config.preorderId,
      blockViewerModeAction: () => false,
      showToast: (message: string) => { messages.push(message); },
    } as unknown as Parameters<typeof useShopActionHandlers>[0]);
    return { handlers, continuation, preorder, walletModalVisible, setWalletModalVisible };
  }, { initialProps: initial });
  const connect = () => {
    act(() => {
      view.result.current.setWalletModalVisible(false);
      view.rerender({ ...initial, connected: true });
    });
  };
  return { ...view, api, initial, connect, buyer, restoration, signInApproval, recovered, calls, messages };
}

async function waitForAvailabilityRefresh() {
  const context = rig();
  await act(async () => {});
  const availability = context.result.current.preorder.availability!;
  assert.ok(availability);
  const refreshed = deferred<typeof availability>();
  context.api.availability = async () => refreshed.promise;
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handlePreorder([1]); });
  context.connect();
  await act(async () => { context.restoration.resolve('sign-in-required'); });
  await act(async () => { context.signInApproval.resolve(); context.recovered.resolve({ order: null }); });
  assert.equal(context.result.current.preorder.availability, null);
  assert.equal(context.result.current.preorder.recoveryReady, true);
  assert.ok(context.result.current.continuation.pendingAction);
  assert.equal(context.calls.prepare.length, 0);
  return { ...context, refreshed, availability, completion };
}

for (const delayMs of [25_000, 130_000]) {
  test(`preorder automatically continues after a ${delayMs / 1_000}-second availability refresh following sign-in`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const context = await waitForAvailabilityRefresh();
    await act(async () => { t.mock.timers.tick(delayMs); });
    assert.ok(context.result.current.continuation.pendingAction);
    assert.equal(context.calls.prepare.length, 0);
    await act(async () => { context.refreshed.resolve(context.availability); });
    await act(async () => { await context.completion; });
    assert.equal(context.calls.prepare.length, 1);
    assert.deepEqual(context.calls.prepare[0].cardIds, [1]);
    assert.equal(context.calls.submit.length, 1);
    assert.equal(context.calls.transactionSign, 1);
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.deepEqual(context.messages, []);
  });
}

test('preorder readiness stops waiting after the availability and fallback request budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const context = await waitForAvailabilityRefresh();
  await act(async () => { t.mock.timers.tick(134_999); });
  assert.ok(context.result.current.continuation.pendingAction);
  await act(async () => { t.mock.timers.tick(1); await context.completion; });
  assert.equal(context.result.current.continuation.pendingAction, null);
  assert.equal(context.calls.prepare.length, 0);
  assert.equal(context.messages.length, 1);
  await act(async () => { context.refreshed.resolve(context.availability); });
  assert.equal(context.calls.prepare.length, 0);
  assert.equal(context.calls.submit.length, 0);
});

test('an availability failure cancels preorder readiness without waiting for its timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const context = await waitForAvailabilityRefresh();
  await act(async () => { context.refreshed.reject(new Error('Availability unavailable')); });
  await act(async () => { await context.completion; });
  assert.equal(context.result.current.continuation.pendingAction, null);
  assert.equal(context.calls.prepare.length, 0);
  assert.equal(context.calls.submit.length, 0);
  assert.deepEqual(context.messages, ['Couldn’t check card availability. Please try again.']);
});

for (const cancellation of ['cancel', 'navigation', 'ethereum-wallet'] as const) {
  test(`${cancellation} during a delayed availability refresh prevents late checkout`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const context = await waitForAvailabilityRefresh();
    await act(async () => { t.mock.timers.tick(25_000); });
    act(() => {
      if (cancellation === 'cancel') context.result.current.continuation.cancel();
      else context.rerender({
        ...context.initial, connected: true,
        ...(cancellation === 'navigation' ? { scopeKey: '/another-drop' } : { ethereumAddress: secondEthereumSession.address }),
      });
    });
    await act(async () => { await context.completion; });
    await act(async () => { context.refreshed.resolve(context.availability); });
    assert.equal(context.result.current.continuation.pendingAction, null);
    assert.equal(context.calls.prepare.length, 0);
    assert.equal(context.calls.submit.length, 0);
    assert.deepEqual(context.messages, []);
  });
}

test('one disconnected preorder continues through wallet choice, sign-in, buyer recovery and actual submission', async () => {
  const context = rig();
  let completion!: Promise<void>;
  const cardIds = [2, 1];
  act(() => { completion = context.result.current.handlers.handlePreorder(cardIds); });
  cardIds.splice(0, cardIds.length, 3);
  assert.equal(context.result.current.walletModalVisible, true);
  assert.equal(context.result.current.continuation.pendingAction?.phase, 'authenticating');
  assert.equal(context.result.current.preorder.phase, 'idle');
  assert.equal(context.calls.prepare.length, 0);

  context.connect();
  await waitFor(() => assert.equal(context.calls.restoration, 1));
  await act(async () => { context.restoration.resolve('sign-in-required'); });
  assert.equal(context.calls.signIn, 1);
  assert.equal(context.calls.prepare.length, 0);
  await act(async () => { context.signInApproval.resolve(); });
  await waitFor(() => assert.equal(context.calls.recovery, 1));
  assert.equal(context.result.current.preorder.recoveryReady, false);
  assert.equal(context.calls.prepare.length, 0);
  await act(async () => { context.recovered.resolve({ order: null }); });
  await waitFor(() => assert.equal(context.calls.submit.length, 1));
  await act(async () => { await completion; });

  assert.equal(context.calls.prepare.length, 1);
  assert.equal(context.calls.prepare[0].buyer, context.buyer);
  assert.deepEqual(context.calls.prepare[0].cardIds, [1, 2]);
  assert.equal(context.calls.transactionSign, 1);
  assert.equal(context.calls.signIn, 1);
  assert.equal(context.result.current.preorder.order?.status, 'submitted');
  assert.equal(context.result.current.continuation.pendingAction, null);
  assert.equal(window.localStorage.length, 1);
  assert.ok(window.localStorage.key(0)?.endsWith(`:${context.buyer}`));
  assert.deepEqual(context.messages, []);
});

test('delayed session restoration submits the original preorder without a sign-in signature', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handlePreorder([1]); });
  context.connect();
  await waitFor(() => assert.equal(context.calls.restoration, 1));
  assert.equal(context.calls.signIn, 0);
  assert.equal(context.calls.prepare.length, 0);
  await act(async () => { context.restoration.resolve('restored'); });
  await waitFor(() => assert.equal(context.calls.recovery, 1));
  await act(async () => { context.recovered.resolve({ order: null }); });
  await waitFor(() => assert.equal(context.calls.submit.length, 1));
  await act(async () => { await completion; });
  assert.equal(context.calls.signIn, 0);
  assert.equal(context.calls.transactionSign, 1);
  assert.equal(context.calls.prepare[0].buyer, context.buyer);
  assert.deepEqual(context.calls.prepare[0].cardIds, [1]);
  assert.deepEqual(context.messages, []);
});

test('closing the wallet chooser cancels the preorder before any API preparation', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handlePreorder([1]); });
  assert.equal(context.result.current.walletModalVisible, true);
  act(() => { context.result.current.setWalletModalVisible(false); });
  await act(async () => { await completion; });
  context.connect();
  await act(async () => {
    context.restoration.resolve('sign-in-required');
    context.signInApproval.resolve();
    context.recovered.resolve({ order: null });
  });
  assert.equal(context.calls.restoration, 0);
  assert.equal(context.calls.signIn, 0);
  assert.equal(context.calls.prepare.length, 0);
  assert.equal(context.calls.submit.length, 0);
  assert.equal(context.result.current.continuation.pendingAction, null);
  assert.deepEqual(context.messages, []);
});

test('navigation during restoration cancels the preorder and ignores late sign-in eligibility', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handlePreorder([1]); });
  context.connect();
  await waitFor(() => assert.equal(context.calls.restoration, 1));
  context.rerender({ connected: true, scopeKey: '/another-drop' });
  await act(async () => { await completion; });
  await act(async () => {
    context.restoration.resolve('sign-in-required');
    context.signInApproval.resolve();
    context.recovered.resolve({ order: null });
  });
  assert.equal(context.calls.signIn, 0);
  assert.equal(context.calls.prepare.length, 0);
  assert.equal(context.calls.submit.length, 0);
  assert.equal(context.result.current.continuation.pendingAction, null);
  assert.deepEqual(context.messages, []);
});

test('an Ethereum account change during Solana restoration cancels the original preorder continuation', async () => {
  const context = rig();
  let completion!: Promise<void>;
  act(() => { completion = context.result.current.handlers.handlePreorder([1]); });
  context.connect();
  await waitFor(() => assert.equal(context.calls.restoration, 1));
  context.rerender({ ...context.initial, connected: true, ethereumAddress: secondEthereumSession.address });
  await act(async () => {
    context.restoration.resolve('restored');
    context.recovered.resolve({ order: null });
    await completion;
  });
  assert.equal(context.calls.prepare.length, 0);
  assert.equal(context.calls.submit.length, 0);
  assert.equal(context.calls.transactionSign, 0);
  assert.equal(context.result.current.continuation.pendingAction, null);
});
