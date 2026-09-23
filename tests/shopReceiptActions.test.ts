import assert from 'node:assert/strict';
import test, { after, afterEach } from 'node:test';
import { useRef } from 'react';
import bs58 from 'bs58';
import { PublicKey, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { FULFILLMENT_ADMIN_WALLET_ADDRESSES } from '../shared/fulfillmentAccess.ts';
import { getFrontendDrop } from '../src/config/deployment.ts';
import { PotentiallySubmittedTransactionError, SubmittedTransactionFailureError } from '../src/lib/solana.ts';
import { receiptOperationKey } from '../src/lib/receiptTransfer.ts';
import { useCommerceModals } from '../src/shop/commerce/useCommerceModals.ts';
import { useReceiptActions } from '../src/shop/commerce/useReceiptActions.ts';
import { useReceiptOperationState } from '../src/shop/commerce/useReceiptOperationState.ts';
import type { RevealOverlayState } from '../src/shop/reveal/types.ts';
import type { InventoryItem } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
afterEach(() => {
  cleanup();
  dom.window.localStorage.clear();
});
after(() => dom.window.close());

const address = (value: number) => bs58.encode(new Uint8Array(32).fill(value));
const owner = FULFILLMENT_ADMIN_WALLET_ADDRESSES[0];
const destination = address(2);
const signature = bs58.encode(new Uint8Array(64).fill(3));
const drop = getFrontendDrop('card_nft_2')!;
const receipt: InventoryItem = { id: address(4), dropId: drop.dropId, kind: 'certificate', name: 'Receipt', dudeId: 1 };
const pack: InventoryItem = { id: address(5), dropId: drop.dropId, kind: 'box', name: 'Pack', boxId: '1' };
const transaction = new VersionedTransaction(new TransactionMessage({
  payerKey: new PublicKey(owner), recentBlockhash: address(6), instructions: [],
}).compileToV0Message());
const encodedTx = Buffer.from(transaction.serialize()).toString('base64');
const operationKey = receiptOperationKey(owner, receipt.id);
type Mode = 'direct' | 'admin receipt' | 'admin pack';
type Runtime = NonNullable<Parameters<typeof useReceiptActions>[1]>;
type SendOptions = Parameters<NonNullable<Runtime['sendReceiptSubmission']>>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function walletContext(account: string): WalletContextState {
  return {
    publicKey: new PublicKey(account),
    wallet: { adapter: { publicKey: new PublicKey(account), supportedTransactionVersions: new Set([0]) } },
    signTransaction: async (tx: VersionedTransaction) => tx,
  } as unknown as WalletContextState;
}

function recordBroadcast(options: SendOptions) {
  options.receiptWallet?.assertCurrent();
  options.receiptWallet?.onBroadcastAttempt(signature, transaction);
}

function recordSubmission(options: SendOptions) {
  recordBroadcast(options);
  options.onSubmitted(signature, transaction);
  return signature;
}

function receiptHarness(mode: Mode) {
  const calls = { prepared: 0, sent: [] as SendOptions[], finalized: [] as unknown[], reconciled: 0, refreshed: 0, cleared: 0, closed: 0 };
  const toasts: string[] = [];
  const behavior: {
    prepare?: () => Promise<void>;
    send?: (options: SendOptions, attempt: number) => Promise<string>;
    finalize?: () => Promise<void>;
  } = {};
  let overlay: RevealOverlayState | null = {
    id: receipt.id, dropId: drop.dropId, name: receipt.name,
    originRect: { left: 0, top: 0, width: 100, height: 100 },
    targetRect: { left: 0, top: 0, width: 100, height: 100 },
    phase: 'revealed', frame: 0, advanceClicks: 0,
    viewerMode: 'receipt-image', imageViewerSize: 'receipt',
    receiptImages: [{ key: receipt.id, name: receipt.name }], adminIrlRedeemReceipt: receipt,
  };
  const runtime: Runtime = {
    prepareReceiptTransferTx: async () => {
      calls.prepared += 1;
      await behavior.prepare?.();
      return { encodedTx, dropId: drop.dropId, certificateId: receipt.id };
    },
    prepareAdminIrlRedeemTx: async () => {
      calls.prepared += 1;
      await behavior.prepare?.();
      return {
        encodedTx, requestId: `request-${calls.prepared}`, dropId: drop.dropId,
        adminWallet: owner, itemCount: 1, targetKind: mode === 'admin pack' ? 'pack' : 'card_receipt',
        blockhashContextSlot: 1,
      };
    },
    sendReceiptSubmission: async (options) => {
      calls.sent.push(options);
      return behavior.send ? behavior.send(options, calls.sent.length) : recordSubmission(options);
    },
    finalizeAdminIrlRedeem: async (request) => {
      calls.finalized.push(request);
      await behavior.finalize?.();
      return { processed: true, deliveryId: 7, claimCodes: ['code'] };
    },
    reconcileSubmittedTransaction: async () => {
      calls.reconciled += 1;
      return 'unknown';
    },
  };
  const view = renderHook(({ connectedWallet, wallet }) => {
    const connectedWalletRef = useRef<string | null>(connectedWallet);
    const receiptState = useReceiptOperationState(connectedWallet);
    const modals = useCommerceModals({
      wallet, connectedWallet, connectedWalletRef,
      rebaseReceiptOperations: receiptState.rebaseReceiptOperations,
      claimDeepLinkCode: null, navigate: () => undefined,
    });
    const actions = useReceiptActions({
      wallet, modals, receiptState, connectedWallet, connectedWalletRef,
      publicKey: wallet.publicKey, owner: connectedWallet,
      ensureSignedIn: async () => true, blockViewerModeAction: () => false, isSignedInWallet: true,
      getDropConfig: () => drop, requireKnownDropConfig: () => drop,
      getDropConnection: () => ({} as Connection), selectedDropId: drop.dropId,
      adminIrlRedeemSelection: {
        selectedCount: 1, selectedDropIds: [drop.dropId], selectedItems: [pack],
        deliverableItems: [pack], selectionOwner: connectedWallet, selectedDropFamily: drop.dropFamily,
      },
      deliverableItems: [pack], clearSelection: () => { calls.cleared += 1; },
      getCurrentOverlay: () => overlay,
      closeRevealOverlay: () => { calls.closed += 1; overlay = null; },
      setVisible: () => undefined, showToast: (message) => { toasts.push(message); },
      markAssetsHidden: () => undefined,
      refetchInventory: async () => { calls.refreshed += 1; return { data: [] }; },
      signAndSendPreparedViaConnection: async () => { throw new Error('Unexpected real submission'); },
    }, runtime);
    return { actions, receiptState, modals };
  }, { initialProps: { connectedWallet: owner, wallet: walletContext(owner) } });
  if (mode === 'direct') act(() => view.result.current.modals.setReceiptTransferTarget(receipt));
  return {
    ...view, calls, toasts, behavior,
    run: () => mode === 'direct'
      ? view.result.current.actions.handleReceiptTransfer(destination)
      : view.result.current.actions.handleAdminIrlRedeem(mode === 'admin receipt' ? receipt : undefined),
    pendingRecords: () => JSON.parse(window.localStorage.getItem(`monsPendingAdminIrlRedeems:${owner}`) || '[]') as Array<{ requestId: string; transferSignature: string }>,
    operation: () => view.result.current.receiptState.receiptOperations.get(operationKey),
  };
}

for (const mode of ['direct', 'admin receipt', 'admin pack'] as const) {
  test(`${mode} action preserves submission policy and success cleanup`, async () => {
    const rig = receiptHarness(mode);
    await act(async () => { await rig.run(); });
    assert.equal(rig.calls.prepared, 1);
    assert.equal(rig.calls.sent.length, 1);
    assert.equal(rig.calls.sent[0].simulateBeforeSigning, mode === 'direct' ? true : undefined);
    assert.equal(Boolean(rig.calls.sent[0].receiptWallet), mode !== 'admin pack');
    assert.equal(rig.calls.finalized.length, mode === 'direct' ? 0 : 1);
    assert.equal(rig.calls.reconciled, 0);
    assert.equal(rig.calls.refreshed, 1);
    assert.equal(rig.operation()?.phase, mode === 'admin pack' ? undefined : 'hidden');
    assert.equal(rig.calls.cleared, mode === 'admin pack' ? 1 : 0);
    assert.equal(rig.calls.closed, mode === 'admin pack' ? 0 : 1);
    assert.deepEqual(rig.pendingRecords(), []);
    assert.equal(rig.result.current.modals.receiptTransferInFlight, false);
    assert.equal(rig.result.current.modals.adminIrlRedeeming, false);
  });

  test(`${mode} action retries an expired pre-submission transaction exactly once`, async () => {
    const rig = receiptHarness(mode);
    rig.behavior.send = async (options, attempt) => {
      if (attempt === 1) {
        recordBroadcast(options);
        throw new Error('Blockhash expired');
      }
      assert.deepEqual(rig.pendingRecords(), []);
      assert.equal(rig.operation()?.signature, undefined);
      assert.equal(rig.operation()?.recentBlockhash, undefined);
      assert.equal(rig.operation()?.adminFinalizeRequestId, undefined);
      return recordSubmission(options);
    };
    await act(async () => { await rig.run(); });
    assert.equal(rig.calls.prepared, 2);
    assert.equal(rig.calls.sent.length, 2);
    assert.equal(rig.calls.reconciled, 0);
    assert.deepEqual(rig.pendingRecords(), []);
  });

  test(`${mode} action stops after the second expiry`, async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const rig = receiptHarness(mode);
    rig.behavior.send = async () => { throw new Error('Blockhash expired'); };
    await act(async () => {
      if (mode === 'direct') await assert.rejects(rig.run(), /Blockhash expired/);
      else await rig.run();
    });
    assert.equal(rig.calls.prepared, 2);
    assert.equal(rig.calls.sent.length, 2);
    assert.equal(rig.calls.finalized.length, 0);
    assert.equal(rig.operation(), undefined);
    assert.deepEqual(rig.pendingRecords(), []);
  });

  test(`${mode} action retains an uncertain submission without resending`, async (t) => {
    t.mock.method(console, 'error', () => undefined);
    t.mock.method(console, 'warn', () => undefined);
    const rig = receiptHarness(mode);
    rig.behavior.send = async (options) => {
      recordSubmission(options);
      throw new PotentiallySubmittedTransactionError(signature, new Error('Blockhash expired'));
    };
    await act(async () => { await rig.run(); });
    assert.equal(rig.calls.prepared, 1);
    assert.equal(rig.calls.sent.length, 1);
    assert.equal(rig.calls.finalized.length, 0);
    assert.equal(rig.calls.reconciled, mode === 'admin pack' ? 0 : 1);
    assert.equal(rig.operation()?.phase, mode === 'admin pack' ? undefined : 'unverified');
    assert.deepEqual(rig.pendingRecords().map(({ requestId }) => requestId), mode === 'direct' ? [] : ['request-1']);
  });

  test(`${mode} action removes a definitively failed submission`, async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const rig = receiptHarness(mode);
    rig.behavior.send = async (options) => {
      recordSubmission(options);
      throw new SubmittedTransactionFailureError(signature, { InstructionError: [0, 'Custom'] });
    };
    await act(async () => {
      if (mode === 'direct') await assert.rejects(rig.run(), /Transaction failed/);
      else await rig.run();
    });
    assert.equal(rig.calls.sent.length, 1);
    assert.equal(rig.calls.reconciled, 0);
    assert.equal(rig.operation(), undefined);
    assert.deepEqual(rig.pendingRecords(), []);
  });
}

for (const mode of ['admin receipt', 'admin pack'] as const) {
  test(`${mode} finalization failure preserves recovery records after confirmation`, async (t) => {
    t.mock.method(console, 'error', () => undefined);
    t.mock.method(console, 'warn', () => undefined);
    const rig = receiptHarness(mode);
    rig.behavior.finalize = async () => { throw new Error('Finalization unavailable'); };
    await act(async () => { await rig.run(); });
    assert.equal(rig.calls.sent.length, 1);
    assert.equal(rig.calls.finalized.length, 1);
    assert.equal(rig.calls.reconciled, 0);
    assert.equal(rig.operation()?.phase, mode === 'admin receipt' ? 'hidden' : undefined);
    assert.equal(rig.pendingRecords()[0]?.transferSignature, signature);
    assert.match(rig.toasts.at(-1) || '', /finalization details saved locally/);
  });
}

test('direct action reconciles a possible broadcast even when the submitted callback did not run', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const rig = receiptHarness('direct');
  rig.behavior.send = async (options) => {
    recordBroadcast(options);
    throw new PotentiallySubmittedTransactionError(signature, new Error('Network unavailable'));
  };
  await act(async () => { await rig.run(); });
  assert.equal(rig.calls.sent.length, 1);
  assert.equal(rig.calls.reconciled, 1);
  assert.equal(rig.operation()?.phase, 'unverified');
});

test('wallet changes after preparation prevent receipt broadcast', async () => {
  const rig = receiptHarness('direct');
  const preparation = deferred<void>();
  const started = deferred<void>();
  rig.behavior.prepare = () => { started.resolve(); return preparation.promise; };
  let completion!: Promise<unknown>;
  await act(async () => {
    completion = assert.rejects(rig.run(), /wallet changed/);
    await started.promise;
  });
  rig.rerender({ connectedWallet: destination, wallet: walletContext(destination) });
  await act(async () => { preparation.resolve(); await completion; });
  assert.equal(rig.calls.sent.length, 1);
  assert.equal(rig.calls.refreshed, 0);
  assert.equal(rig.calls.closed, 0);
  assert.equal(rig.result.current.receiptState.receiptOperations.size, 0);
});

test('late direct submission callbacks cannot replace newer receipt operations or close their UI', async () => {
  const rig = receiptHarness('direct');
  const started = deferred<void>();
  const release = deferred<void>();
  rig.behavior.send = async (options) => {
    started.resolve();
    await release.promise;
    return recordSubmission(options);
  };
  let completion!: Promise<void>;
  await act(async () => { completion = rig.run(); await started.promise; });
  act(() => {
    rig.result.current.receiptState.beginReceiptOperation({ wallet: owner, assetId: receipt.id, dropId: drop.dropId });
  });
  const current = rig.operation();
  await act(async () => { release.resolve(); await completion; });
  assert.deepEqual(rig.operation(), current);
  assert.equal(rig.calls.closed, 0);
  assert.equal(rig.calls.refreshed, 0);
  assert.deepEqual(rig.toasts, []);
  assert.equal(rig.result.current.modals.receiptTransferTarget?.id, receipt.id);
});
