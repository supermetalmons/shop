import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { useRef } from 'react';
import bs58 from 'bs58';
import { PublicKey, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { getFrontendDrop } from '../src/config/deployment.ts';
import type { ReceiptOperation } from '../src/lib/receiptTransfer.ts';
import type { InventoryItem } from '../src/types.ts';
import { usePreparedTransactionState } from '../src/shop/commerce/usePreparedTransactionState.ts';
import { useReceiptOperationState } from '../src/shop/commerce/useReceiptOperationState.ts';
import { useCommerceModals } from '../src/shop/commerce/useCommerceModals.ts';
import { useWalletTransactions } from '../src/shop/commerce/useWalletTransactions.ts';
import { useClaimPresentation } from '../src/shop/commerce/useClaimPresentation.ts';
import { usePreparedTransactionRecovery } from '../src/shop/commerce/usePreparedTransactionRecovery.ts';
import { createPreparedTransactionCoordinator, runPreparedSubmission } from '../src/shop/preparedSubmission.ts';
import { sendPreparedTransaction } from '../src/lib/solana.ts';
import { PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS } from '../src/shop/commerce/transactionSupport.ts';
import {
  forgetPendingPreparedTransaction,
  loadPendingPreparedTransaction,
  pendingPreparedTransactionStorageKey,
  persistPendingPreparedTransaction,
  replacePendingPreparedTransaction,
  type PendingPreparingDeliveryTransaction,
  type PendingPreparingTransaction,
  type PendingSubmittedClaimTransaction,
  type PendingSubmittedDeliveryTransaction,
} from '../src/lib/pendingPreparedTransactions.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
afterEach(() => {
  cleanup();
  dom.window.localStorage.clear();
});

const address = (value: number) => bs58.encode(new Uint8Array(32).fill(value));
const walletA = address(1);
const walletB = address(2);
const receiptId = address(3);
const signature = bs58.encode(new Uint8Array(64).fill(4));
const blockhash = address(5);
const drop = getFrontendDrop('card_nft_2')!;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function preparingDelivery(operation = 1): PendingPreparingDeliveryTransaction {
  return {
    kind: 'delivery', phase: 'preparing', wallet: walletA, dropId: 'card_nft_2',
    createdAt: Date.now(), operationId: operation.toString(16).padStart(32, '0'),
    blockhashContextSlot: 123, deliveryId: operation, itemIds: [receiptId],
  };
}

function submittedClaim(): PendingSubmittedClaimTransaction {
  return {
    kind: 'claim', phase: 'submitted', wallet: walletA, dropId: 'card_nft_2',
    createdAt: Date.now(), operationId: '01'.repeat(16), blockhashContextSlot: 123,
    certificateId: receiptId, certificates: [11], signature, recentBlockhash: blockhash,
  };
}

function walletContext(account = walletA): WalletContextState {
  return {
    publicKey: new PublicKey(account),
    wallet: { adapter: { publicKey: new PublicKey(account), supportedTransactionVersions: new Set([0]) } },
    signTransaction: async (transaction: VersionedTransaction) => transaction,
    sendTransaction: async () => signature,
  } as unknown as WalletContextState;
}

function requireKnownDropConfig() { return drop; }

test('prepared state shares reservations between delivery and claim and isolates wallet changes', () => {
  const connectedWalletRef = { current: walletA as string | null };
  const { result, rerender } = renderHook(
    ({ connectedWallet }) => usePreparedTransactionState(connectedWallet, connectedWalletRef),
    { initialProps: { connectedWallet: walletA } },
  );
  const coordinator = (kind: 'delivery' | 'claim') => createPreparedTransactionCoordinator(kind, {
    wallet: walletA,
    isCurrent: () => connectedWalletRef.current === walletA,
    readPending: result.current.readPendingPreparedTransaction,
    persistReservation: result.current.rememberPendingPreparedTransaction,
    persistSubmission: result.current.submitPendingPreparedTransaction,
    forget: result.current.forgetPendingPreparedTransaction,
  });
  const delivery = coordinator('delivery');
  act(() => delivery.reserve(preparingDelivery()));
  assert.throws(() => coordinator('claim').assertCurrent(), /already pending/);
  assert.deepEqual([...result.current.pendingDeliveryItemIds], [receiptId]);

  act(() => delivery.recordSubmitted(signature, { message: { recentBlockhash: blockhash } }));
  assert.equal(result.current.pendingPreparedTransaction?.phase, 'submitted');
  connectedWalletRef.current = walletB;
  rerender({ connectedWallet: walletB });
  assert.equal(result.current.pendingPreparedTransaction, null);
  assert.equal(result.current.pendingDeliveryItemIds.size, 0);
  assert.equal(loadPendingPreparedTransaction(walletA)?.phase, 'submitted');
  assert.throws(() => delivery.assertCurrent(), /Wallet changed/);
});

test('prepared storage events resync the active wallet without clearing another wallet reservation', () => {
  const { result } = renderHook(() => usePreparedTransactionState(walletA, { current: walletA }));
  const entry = preparingDelivery();
  persistPendingPreparedTransaction(entry);
  act(() => window.dispatchEvent(new dom.window.StorageEvent('storage', {
    key: pendingPreparedTransactionStorageKey(walletB),
  })));
  assert.equal(result.current.pendingPreparedTransaction, null);
  act(() => window.dispatchEvent(new dom.window.StorageEvent('storage', {
    key: pendingPreparedTransactionStorageKey(walletA),
  })));
  assert.deepEqual(result.current.pendingPreparedTransaction, entry);
});

test('receipt submissions retain their identity and clear retry metadata for normal and admin transfers', () => {
  for (const adminFinalizeRequestId of [undefined, 'admin-request']) {
    const { result } = renderHook(() => useReceiptOperationState(walletA));
    let operation!: ReceiptOperation;
    act(() => {
      operation = result.current.beginReceiptOperation({ wallet: walletA, assetId: receiptId, dropId: drop.dropId });
    });
    const original = operation;
    assert.equal(result.current.isReceiptOperationCurrent(operation), true);
    assert.equal(result.current.isReceiptOperationCurrent(null), false);

    act(() => {
      const recorded = result.current.recordReceiptSubmission(operation, {
        phase: 'in-flight', signature, recentBlockhash: blockhash,
        ...(adminFinalizeRequestId ? { adminFinalizeRequestId } : {}),
      });
      assert.equal(recorded.applied, true);
      operation = recorded.operation;
    });
    assert.equal(result.current.receiptOperations.get(original.key), operation);
    assert.equal(operation.adminFinalizeRequestId, adminFinalizeRequestId);
    assert.equal(result.current.receiptOperationHiddenAssets.has(receiptId), false);

    act(() => {
      const reset = result.current.resetReceiptSubmissionForRetry(operation);
      assert.ok(reset);
      operation = reset;
    });
    assert.equal(operation.phase, 'in-flight');
    assert.equal(operation.signature, undefined);
    assert.equal(operation.recentBlockhash, undefined);
    assert.equal(operation.adminFinalizeRequestId, undefined);

    act(() => {
      const recorded = result.current.recordReceiptSubmission(operation, {
        phase: 'hidden', signature: 'retry-signature', recentBlockhash: 'retry-blockhash',
        ...(adminFinalizeRequestId ? { adminFinalizeRequestId: 'retry-admin-request' } : {}),
      });
      assert.equal(recorded.applied, true);
      operation = recorded.operation;
    });
    assert.equal(result.current.receiptOperations.get(original.key), operation);
    assert.equal(operation.wallet, original.wallet);
    assert.equal(operation.assetId, original.assetId);
    assert.equal(operation.dropId, original.dropId);
    assert.equal(operation.generation, original.generation);
    assert.equal(operation.createdGeneration, original.createdGeneration);
    assert.equal(operation.adminFinalizeRequestId, adminFinalizeRequestId ? 'retry-admin-request' : undefined);
    assert.equal(result.current.receiptOperationGenerationRef.current, original.generation);
    assert.equal(result.current.receiptOperationHiddenAssets.has(receiptId), true);
  }
});

test('receipt adapter changes close transfer UI and invalidate pending operation callbacks', () => {
  const initialWallet = walletContext();
  const { result, rerender } = renderHook(({ wallet }) => {
    const connectedWalletRef = useRef<string | null>(walletA);
    const receiptState = useReceiptOperationState(walletA);
    const modals = useCommerceModals({
      wallet, connectedWallet: walletA, connectedWalletRef,
      rebaseReceiptOperations: receiptState.rebaseReceiptOperations,
      claimDeepLinkCode: null, navigate: () => undefined,
    });
    return { receiptState, modals };
  }, { initialProps: { wallet: initialWallet } });
  let operation!: ReturnType<typeof result.current.receiptState.beginReceiptOperation>;
  const receipt: InventoryItem = { id: receiptId, dropId: drop.dropId, kind: 'certificate', name: 'Receipt' };
  act(() => {
    operation = result.current.receiptState.beginReceiptOperation({ wallet: walletA, assetId: receiptId, dropId: drop.dropId });
    operation = result.current.receiptState.recordReceiptSubmission(operation, {
      phase: 'in-flight', signature, recentBlockhash: blockhash,
    }).operation;
    result.current.modals.openReceiptTransfer(receipt, document.createElement('button'));
  });
  const previousGeneration = result.current.modals.receiptTransferWalletSessionGenerationRef.current;
  rerender({ wallet: walletContext() });
  assert.equal(result.current.modals.receiptTransferTarget, null);
  assert.equal(result.current.modals.receiptTransferReturnFocusRef.current, null);
  assert.equal(result.current.modals.receiptTransferWalletSessionGenerationRef.current, previousGeneration + 1);
  assert.equal(result.current.receiptState.receiptOperations.get(operation.key)?.phase, 'unverified');
  const rebasedRegistry = result.current.receiptState.receiptOperations;
  assert.equal(result.current.receiptState.isReceiptOperationCurrent(operation), false);
  act(() => {
    const stale = result.current.receiptState.recordReceiptSubmission(operation, {
      phase: 'hidden', signature: 'late-signature', recentBlockhash: 'late-blockhash',
      adminFinalizeRequestId: 'late-admin-request',
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.operation.signature, 'late-signature');
    assert.equal(stale.operation.recentBlockhash, 'late-blockhash');
    assert.equal(stale.operation.adminFinalizeRequestId, 'late-admin-request');
    assert.equal(stale.operation.generation, operation.generation);
    assert.equal(result.current.receiptState.resetReceiptSubmissionForRetry(stale.operation), null);
  });
  assert.equal(result.current.receiptState.receiptOperations, rebasedRegistry);
  assert.equal(rebasedRegistry.get(operation.key)?.signature, signature);
  assert.equal(rebasedRegistry.get(operation.key)?.createdGeneration, operation.createdGeneration);
  let applied = true;
  act(() => { applied = result.current.receiptState.updateReceiptOperation(operation, () => null); });
  assert.equal(applied, false);
});

test('receipt submission helpers reject replaced operations without touching other wallets or assets', () => {
  const { result } = renderHook(() => useReceiptOperationState(walletA));
  let first!: ReceiptOperation;
  let replacement!: ReceiptOperation;
  let otherAsset!: ReceiptOperation;
  let otherWallet!: ReceiptOperation;
  act(() => {
    first = result.current.beginReceiptOperation({ wallet: walletA, assetId: receiptId, dropId: drop.dropId });
    otherAsset = result.current.beginReceiptOperation({ wallet: walletA, assetId: address(6), dropId: drop.dropId });
    otherWallet = result.current.beginReceiptOperation({ wallet: walletB, assetId: receiptId, dropId: drop.dropId });
    replacement = result.current.beginReceiptOperation({ wallet: walletA, assetId: receiptId, dropId: drop.dropId });
  });
  const registry = result.current.receiptOperations;
  act(() => {
    const stale = result.current.recordReceiptSubmission(first, {
      phase: 'hidden', signature, recentBlockhash: blockhash,
    });
    assert.equal(stale.applied, false);
    assert.equal(result.current.resetReceiptSubmissionForRetry(first), null);
  });
  assert.equal(result.current.receiptOperations, registry);
  assert.equal(result.current.isReceiptOperationCurrent(first), false);
  assert.equal(result.current.isReceiptOperationCurrent(replacement), true);
  assert.equal(registry.get(otherAsset.key), otherAsset);
  assert.equal(registry.get(otherWallet.key), otherWallet);
  assert.equal(result.current.receiptOperationGenerationRef.current, replacement.generation);
});

test('receipt cleanup uses creation generations after wallet changes and preserves newer transfers', () => {
  const { result, rerender } = renderHook(({ wallet }) => {
    const connectedWallet = wallet.publicKey!.toBase58();
    const connectedWalletRef = useRef<string | null>(connectedWallet);
    const receiptState = useReceiptOperationState(connectedWallet);
    useCommerceModals({
      wallet, connectedWallet, connectedWalletRef,
      rebaseReceiptOperations: receiptState.rebaseReceiptOperations,
      claimDeepLinkCode: null, navigate: () => undefined,
    });
    return receiptState;
  }, { initialProps: { wallet: walletContext() } });
  let returned!: ReceiptOperation;
  let newer!: ReceiptOperation;
  let claimStartedGeneration = 0;
  act(() => {
    returned = result.current.beginReceiptOperation({ wallet: walletA, assetId: receiptId, dropId: drop.dropId });
    returned = result.current.recordReceiptSubmission(returned, {
      phase: 'hidden', signature, recentBlockhash: blockhash,
    }).operation;
    claimStartedGeneration = result.current.receiptOperationGenerationRef.current;
    newer = result.current.beginReceiptOperation({ wallet: walletA, assetId: address(6), dropId: drop.dropId });
    newer = result.current.recordReceiptSubmission(newer, {
      phase: 'hidden', signature, recentBlockhash: blockhash,
    }).operation;
  });
  rerender({ wallet: walletContext(walletB) });
  const rebasedReturned = result.current.receiptOperations.get(returned.key)!;
  const rebasedNewer = result.current.receiptOperations.get(newer.key)!;
  assert.equal(result.current.isReceiptOperationCurrent(returned), false);
  assert.equal(result.current.isReceiptOperationCurrent(rebasedReturned), true);
  assert.equal(rebasedReturned.phase, 'unverified');
  assert.ok(rebasedReturned.generation > claimStartedGeneration);
  assert.equal(rebasedReturned.createdGeneration, returned.createdGeneration);
  act(() => {
    result.current.clearAuthoritativelyReturnedReceiptOperations(
      walletA, [returned.assetId, newer.assetId], claimStartedGeneration,
    );
  });
  assert.equal(result.current.receiptOperations.has(returned.key), false);
  assert.equal(result.current.receiptOperations.get(newer.key), rebasedNewer);
});

test('wallet signing checks the current wallet again before broadcasting', async () => {
  const signing = deferred<VersionedTransaction>();
  const wallet = { ...walletContext(), signTransaction: () => signing.promise } as WalletContextState;
  const { result } = renderHook(() => useWalletTransactions(wallet, () => undefined));
  let current = true;
  let broadcasts = 0;
  const connection = { sendRawTransaction: async () => { broadcasts += 1; return signature; } } as unknown as Connection;
  const transaction = {} as VersionedTransaction;
  const submission = result.current.signAndSendPreparedViaConnection(transaction, connection, {
    assertWalletCurrent: () => { if (!current) throw new Error('wallet changed'); },
  });
  current = false;
  signing.resolve(transaction);
  await assert.rejects(submission, /wallet changed/);
  assert.equal(broadcasts, 0);
});

for (const change of ['wallet', 'claim modal'] as const) {
  test(`prepared submission never signs when the ${change} changes after preparation`, async (t) => {
    t.mock.method(console, 'error', () => undefined);
    let currentWallet = walletA;
    let claimGeneration = 1;
    let signatures = 0;
    let broadcasts = 0;
    const wallet = {
      ...walletContext(),
      signTransaction: async (transaction: VersionedTransaction) => {
        signatures += 1;
        return transaction;
      },
    } as WalletContextState;
    const { result } = renderHook(() => useWalletTransactions(wallet, () => undefined));
    const connection = {
      sendRawTransaction: async () => { broadcasts += 1; return signature; },
    } as unknown as Connection;
    const transaction = new VersionedTransaction(new TransactionMessage({
      payerKey: new PublicKey(walletA), recentBlockhash: blockhash, instructions: [],
    }).compileToV0Message());
    const encodedTx = Buffer.from(transaction.serialize()).toString('base64');
    const reservation: PendingPreparingTransaction = change === 'wallet'
      ? preparingDelivery()
      : {
          kind: 'claim', phase: 'preparing', wallet: walletA, dropId: drop.dropId,
          createdAt: Date.now(), operationId: '01'.repeat(16), blockhashContextSlot: 123,
          certificateId: receiptId, certificates: [11],
        };
    const otherWalletReservation = { ...reservation, wallet: walletB };
    assert.equal(persistPendingPreparedTransaction(otherWalletReservation), true);
    const coordinator = createPreparedTransactionCoordinator(reservation.kind, {
      wallet: walletA,
      isCurrent: () => currentWallet === walletA && claimGeneration === 1,
      readPending: (wallet) => loadPendingPreparedTransaction(wallet),
      persistReservation: persistPendingPreparedTransaction,
      persistSubmission: replacePendingPreparedTransaction,
      forget: forgetPendingPreparedTransaction,
    });
    const pendingSubmissionKeys = new Set<string>();
    await assert.rejects(runPreparedSubmission({
      wallet: walletA, coordinator, pendingSubmissionKeys,
      forgetSubmission: forgetPendingPreparedTransaction,
      prepare: async () => {
        coordinator.assertCurrent();
        queueMicrotask(() => {
          if (change === 'wallet') currentWallet = walletB;
          else claimGeneration += 1;
        });
        return { context: encodedTx, reservation };
      },
      send: (encoded: string) => sendPreparedTransaction(
        encoded,
        connection,
        (prepared) => result.current.signAndSendPreparedViaConnection(prepared, connection, {
          assertWalletCurrent: coordinator.assertCurrent,
          signedSendTimeoutMs: PREPARED_TRANSACTION_SIGNED_SEND_TIMEOUT_MS,
          onBroadcastAttempt: coordinator.recordSubmitted,
        }),
        { onSubmitted: coordinator.recordSubmitted },
      ),
      onConfirmed: () => assert.fail('Stale submission cannot confirm'),
      onPending: () => assert.fail('Unsigned transaction cannot need recovery'),
      beforeRetry: () => assert.fail('Stale submission cannot retry'),
    }, { request: async (_name, _options, callback) => callback({}) }), /Wallet changed while preparing/);
    assert.equal(signatures, 0);
    assert.equal(broadcasts, 0);
    assert.equal(pendingSubmissionKeys.size, 0);
    assert.equal(loadPendingPreparedTransaction(walletA), null);
    assert.deepEqual(loadPendingPreparedTransaction(walletB), otherWalletReservation);
  });
}

test('numeric claim preview queues once and abandons presentation after modal generation changes', async () => {
  const inventory: InventoryItem[] = [{
    id: address(6), dropId: drop.dropId, kind: 'certificate', name: 'Claimed receipt', dudeId: 11, image: 'receipt.png',
  }];
  const refreshed = deferred<{ data: InventoryItem[] }>();
  const queued: (() => void)[] = [];
  const opened: unknown[] = [];
  const generation = { current: 1 };
  const { result } = renderHook(() => useClaimPresentation({
    requireKnownDropConfig,
    connectedWalletRef: { current: walletA }, ownerRef: { current: walletA },
    claimOpen: false, claimModalGenerationRef: generation, closeClaimModal: () => undefined,
    inventory, refetchInventory: () => refreshed.promise,
    queueOverlayAction: (run) => { queued.push(run); },
    openReceiptImageViewerGroup: (...args) => { opened.push(args); return true; },
  }));
  result.current(submittedClaim());
  assert.equal(queued.length, 1);
  generation.current += 1;
  queued.shift()?.();
  await act(async () => refreshed.resolve({ data: inventory }));
  queued.forEach((run) => run());
  assert.equal(opened.length, 0);
});

test('numeric claim preview uses the captured inventory and opens once when refresh also succeeds', async () => {
  const inventory: InventoryItem[] = [{
    id: address(6), dropId: drop.dropId, kind: 'certificate', name: 'Claimed receipt', dudeId: 11, image: 'receipt.png',
  }];
  const queued: (() => void)[] = [];
  const snapshots: InventoryItem[][] = [];
  const { result } = renderHook(() => useClaimPresentation({
    requireKnownDropConfig,
    connectedWalletRef: { current: walletA }, ownerRef: { current: walletA },
    claimOpen: false, claimModalGenerationRef: { current: 1 }, closeClaimModal: () => undefined,
    inventory, refetchInventory: async () => ({ data: [...inventory] }),
    queueOverlayAction: (run) => { queued.push(run); },
    openReceiptImageViewerGroup: (_items, _rect, options) => {
      snapshots.push(options!.inventorySnapshot!);
      return true;
    },
  }));
  await act(async () => { result.current(submittedClaim()); });
  assert.equal(queued.length, 2);
  queued.forEach((run) => run());
  assert.deepEqual(snapshots, [inventory]);
  assert.equal(snapshots[0], inventory);
});

test('confirmed prepared recovery deduplicates reconciliation and persists results for the original wallet', async () => {
  const status = deferred<{ context: { slot: number }; value: { slot: number; err: null; confirmations: number; confirmationStatus: 'confirmed' } }>();
  let checks = 0;
  const connection = { getSignatureStatus: () => { checks += 1; return status.promise; } } as unknown as Connection;
  const hidden: { wallet: string; ids: readonly string[] }[] = [];
  const toasts: string[] = [];
  const connectedWalletRef = { current: walletA as string | null };
  const ownerRef = { current: walletA as string | undefined };
  const entry: PendingSubmittedDeliveryTransaction = { ...preparingDelivery(), phase: 'submitted', signature, recentBlockhash: blockhash };
  const { result } = renderHook(() => {
    const prepared = usePreparedTransactionState(walletA, connectedWalletRef);
    const recovery = usePreparedTransactionRecovery({
      prepared, connectedWallet: walletA, connectedWalletRef, ownerRef,
      claimModalGenerationRef: { current: 1 }, isViewerMode: false, suspended: true,
      isSignedInWallet: true, requireKnownDropConfig, getDropConnection: () => connection,
      hasAuthenticatedWalletSession: () => true,
      hideAssetsForWallet: (wallet, ids) => { hidden.push({ wallet, ids }); },
      runDeliveryRecovery: async () => undefined,
      refetchInventory: async () => ({ data: [] }), refreshProfileState: async () => true,
      showToast: (message) => { toasts.push(message); },
      presentConfirmedNumericClaim: () => ({ itemsPerBox: 1, boxNamePrefix: '', figureNamePrefix: '', deferred: true }),
    });
    return { prepared, recovery };
  });
  act(() => { result.current.prepared.rememberPendingPreparedTransaction(entry); });
  const first = result.current.recovery.reconcilePendingPreparedTransaction(entry);
  const second = result.current.recovery.reconcilePendingPreparedTransaction(entry);
  assert.equal(first, second);
  assert.equal(checks, 1);
  connectedWalletRef.current = walletB;
  ownerRef.current = walletB;
  await act(async () => {
    status.resolve({ context: { slot: 123 }, value: { slot: 123, err: null, confirmations: 1, confirmationStatus: 'confirmed' } });
    assert.equal(await first, 'confirmed');
  });
  assert.deepEqual(hidden, [{ wallet: walletA, ids: [receiptId] }]);
  assert.equal(loadPendingPreparedTransaction(walletA), null);
  assert.equal(toasts.length, 0);
});

for (const finish of ['present', 'wallet-change', 'unmount'] as const) {
  test(`pending shipment refresh uses exact presence and stops on ${finish}`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    context.mock.method(console, 'warn', () => undefined);
    context.mock.method(console, 'error', () => undefined);
    let presenceCalls = 0;
    let refreshCalls = 0;
    const connectedWalletRef = { current: walletA as string | null };
    const ownerRef = { current: walletA as string | undefined };
    const delivery = { dropId: drop.dropId, deliveryId: 77 };
    context.mock.method(globalThis, 'fetch', async (input, init) => {
      if (String(input) === '/api/auth/anonymous/session') {
        return Response.json({
          subject: 'anon:00000000-0000-4000-8000-000000000001',
          refreshedAt: Date.now(), expiresAt: Date.now() + 86_400_000,
        });
      }
      assert.equal(String(input), '/api/profile/shipment-presence');
      assert.deepEqual(JSON.parse(String(init?.body)), { scope: 'wallet', expectedWallet: walletA, stripeSessionIds: [], deliveries: [delivery] });
      presenceCalls += 1;
      if (presenceCalls === 1) {
        return Response.json({ error: { code: 'unavailable', message: 'Presence temporarily unavailable.' } }, { status: 503 });
      }
      return Response.json({ stripeSessionIds: [], deliveries: presenceCalls === 2 ? [] : [delivery] });
    });
    const { result, unmount } = renderHook(() => {
      const prepared = usePreparedTransactionState(walletA, connectedWalletRef);
      return usePreparedTransactionRecovery({
        prepared, connectedWallet: walletA, connectedWalletRef, ownerRef,
        claimModalGenerationRef: { current: 1 }, isViewerMode: false, suspended: true,
        isSignedInWallet: true, requireKnownDropConfig,
        getDropConnection: () => assert.fail('unexpected transaction reconciliation'),
        hasAuthenticatedWalletSession: (wallet) => wallet === connectedWalletRef.current,
        hideAssetsForWallet: () => undefined, runDeliveryRecovery: async () => undefined,
        refetchInventory: async () => ({ data: [] }),
        refreshProfileState: async () => { refreshCalls += 1; return true; },
        showToast: () => undefined,
        presentConfirmedNumericClaim: () => ({ itemsPerBox: 1, boxNamePrefix: '', figureNamePrefix: '', deferred: true }),
      });
    });
    await act(async () => { result.current.startShipmentRefresh(walletA, delivery.dropId, delivery.deliveryId); });
    assert.equal(presenceCalls, 1);
    if (finish === 'present') {
      await act(async () => { context.mock.timers.tick(2_000); });
      assert.equal(presenceCalls, 2);
      await act(async () => { context.mock.timers.tick(4_000); });
      assert.equal(presenceCalls, 3);
    } else if (finish === 'wallet-change') {
      connectedWalletRef.current = walletB;
      ownerRef.current = walletB;
    } else {
      unmount();
    }
    await act(async () => { context.mock.timers.tick(60_000); });
    assert.equal(presenceCalls, finish === 'present' ? 3 : 1);
    assert.equal(refreshCalls, presenceCalls - 1);
  });
}

for (const failure of ['incomplete', 'rejected'] as const) {
  test(`present shipments keep refreshing when the profile refresh is ${failure}`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    context.mock.method(console, 'warn', () => undefined);
    const calls: string[] = [];
    let refreshCalls = 0;
    const connectedWalletRef = { current: walletA as string | null };
    const ownerRef = { current: walletA as string | undefined };
    const delivery = { dropId: drop.dropId, deliveryId: 77 };
    context.mock.method(globalThis, 'fetch', async (input, init) => {
      if (String(input) === '/api/auth/anonymous/session') {
        return Response.json({
          subject: 'anon:00000000-0000-4000-8000-000000000001',
          refreshedAt: Date.now(), expiresAt: Date.now() + 86_400_000,
        });
      }
      assert.equal(String(input), '/api/profile/shipment-presence');
      assert.deepEqual(JSON.parse(String(init?.body)), { scope: 'wallet', expectedWallet: walletA, stripeSessionIds: [], deliveries: [delivery] });
      calls.push('presence');
      return Response.json({ stripeSessionIds: [], deliveries: [delivery] });
    });
    const { result } = renderHook(() => {
      const prepared = usePreparedTransactionState(walletA, connectedWalletRef);
      return usePreparedTransactionRecovery({
        prepared, connectedWallet: walletA, connectedWalletRef, ownerRef,
        claimModalGenerationRef: { current: 1 }, isViewerMode: false, suspended: true,
        isSignedInWallet: true, requireKnownDropConfig,
        getDropConnection: () => assert.fail('unexpected transaction reconciliation'),
        hasAuthenticatedWalletSession: (wallet) => wallet === connectedWalletRef.current,
        hideAssetsForWallet: () => undefined, runDeliveryRecovery: async () => undefined,
        refetchInventory: async () => ({ data: [] }),
        refreshProfileState: async () => {
          calls.push('refresh');
          refreshCalls += 1;
          if (refreshCalls === 1 && failure === 'rejected') throw new Error('Profile refresh failed');
          return refreshCalls > 1;
        },
        showToast: () => undefined,
        presentConfirmedNumericClaim: () => ({ itemsPerBox: 1, boxNamePrefix: '', figureNamePrefix: '', deferred: true }),
      });
    });
    await act(async () => { result.current.startShipmentRefresh(walletA, delivery.dropId, delivery.deliveryId); });
    assert.deepEqual(calls, ['presence', 'refresh']);
    await act(async () => { context.mock.timers.tick(2_000); });
    assert.deepEqual(calls, ['presence', 'refresh', 'presence', 'refresh']);
    await act(async () => { context.mock.timers.tick(30_000); });
    assert.equal(refreshCalls, 2);
  });
}

test('claim deep links increment presentation generation and closing navigates home', () => {
  const navigations: unknown[] = [];
  const wallet = walletContext();
  const { result, rerender } = renderHook(({ code }) => useCommerceModals({
    wallet, connectedWallet: walletA, connectedWalletRef: { current: walletA },
    rebaseReceiptOperations: () => undefined,
    claimDeepLinkCode: code,
    navigate: (...args) => { navigations.push(args); },
  }), { initialProps: { code: '123' as string | null } });
  assert.equal(result.current.claimOpen, true);
  assert.equal(result.current.claimInitialCode, '123');
  const generation = result.current.claimModalGenerationRef.current;
  rerender({ code: '456' });
  assert.ok(result.current.claimModalGenerationRef.current > generation);
  assert.equal(result.current.claimInitialCode, '456');
  act(() => result.current.closeClaimModal());
  assert.equal(result.current.claimOpen, false);
  assert.equal(result.current.claimInitialCode, '');
  assert.deepEqual(navigations, [['/', { replace: true }]]);
});
