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
type RigProps = { connected: boolean; scopeKey: string };
type Restoration = 'restored' | 'sign-in-required' | 'cancelled';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
    availability: async () => ({ preorderId: config.preorderId, items: [1, 2, 3].map((id) => ({ id, status: 'available' })) }),
    status: async () => { calls.recovery += 1; return recovered.promise; },
    prepare: async (input) => {
      calls.prepare.push(input);
      preparedOrder = {
        orderId: 'order-1', preorderId: config.preorderId, buyer: input.buyer, cardIds: input.cardIds,
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
    const preorder = usePreorderCheckout({
      config, active: props.scopeKey === initial.scopeKey, buyer: connectedWallet, signedIn: authenticated,
      ensureSignedIn: signIn.ensureSignedIn,
      signTransaction: publicKey ? async (tx) => { calls.transactionSign += 1; tx.sign([payer]); return tx; } : undefined,
      onSucceeded: () => {},
    }, api);
    const continuation = useShopActionContinuation({
      connectedWallet, scopeKey: props.scopeKey,
      ensureSignedIn: signIn.ensureSignedIn, ensureWalletConnected: signIn.ensureWalletConnected,
      showToast: (message) => { messages.push(message); },
    });
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
  return { ...view, initial, connect, buyer, restoration, signInApproval, recovered, calls, messages };
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
