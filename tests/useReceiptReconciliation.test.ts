import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import bs58 from 'bs58';
import type { Connection } from '@solana/web3.js';
import { rememberPendingAdminIrlRedeem } from '../src/lib/adminIrlRedeem.ts';
import type { ReceiptOperation } from '../src/lib/receiptTransfer.ts';
import type { SubmittedTransactionReconciliationResult } from '../src/lib/solana.ts';
import { useReceiptOperationState } from '../src/shop/commerce/useReceiptOperationState.ts';
import { useReceiptReconciliation } from '../src/shop/commerce/useReceiptReconciliation.ts';
import { RECEIPT_STATUS_CHECK_TIMEOUT_MS } from '../src/shop/commerce/transactionSupport.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
afterEach(() => {
  cleanup();
  dom.window.localStorage.clear();
});

const address = (value: number) => bs58.encode(new Uint8Array(32).fill(value));
const wallet = address(1);
const assetId = address(2);
const signature = bs58.encode(new Uint8Array(64).fill(3));
const recentBlockhash = address(4);
const connection = {} as Connection;
const requestId = 'admin-request';
type Reconcile = NonNullable<Parameters<typeof useReceiptReconciliation>[1]>['reconcileSubmittedTransaction'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(reconcileSubmittedTransaction: Reconcile, getDropConnection = () => connection) {
  const toasts: string[] = [];
  let refreshes = 0;
  const connectedWalletRef = { current: wallet as string | null };
  const { result } = renderHook(() => {
    const receiptState = useReceiptOperationState(wallet);
    const reconciliation = useReceiptReconciliation({
      receiptState, connectedWalletRef, getDropConnection,
      refetchInventory: async () => { refreshes += 1; return { data: [] }; },
      showToast: (message) => { toasts.push(message); },
    }, { reconcileSubmittedTransaction });
    return { receiptState, reconciliation };
  });
  const begin = (phase: ReceiptOperation['phase'] = 'hidden', submitted = true) => {
    let operation!: ReceiptOperation;
    act(() => {
      operation = result.current.receiptState.beginReceiptOperation({ wallet, assetId, dropId: 'card_nft_2' });
      if (submitted) {
        operation = result.current.receiptState.recordReceiptSubmission(operation, {
          phase: 'hidden', signature, recentBlockhash, adminFinalizeRequestId: requestId,
        }).operation;
        rememberPendingAdminIrlRedeem(wallet, { dropId: operation.dropId, requestId, transferSignature: signature, itemIds: [assetId] });
      }
      result.current.receiptState.updateReceiptOperation(operation, (current) => ({ ...current, phase }));
      operation = result.current.receiptState.receiptOperationsRef.current.get(operation.key)!;
    });
    return operation;
  };
  return { result, begin, toasts, connectedWalletRef, get refreshes() { return refreshes; } };
}

function persistedRequests() {
  return JSON.parse(dom.window.localStorage.getItem(`monsPendingAdminIrlRedeems:${wallet}`) || '[]') as { requestId: string }[];
}

for (const mode of ['automatic', 'manual'] as const) {
  for (const resolution of ['confirmed', 'failed', 'expired', 'unknown', 'error'] as const) {
    test(`${mode} reconciliation settles ${resolution} without sending another transaction`, async (t) => {
      t.mock.method(console, 'warn', () => undefined);
      let calls = 0;
      const state = harness(async (targetConnection, submission, options) => {
        calls += 1;
        assert.equal(targetConnection, connection);
        assert.deepEqual(submission, { signature, recentBlockhash });
        assert.deepEqual(options, mode === 'manual' ? { timeoutMs: RECEIPT_STATUS_CHECK_TIMEOUT_MS } : undefined);
        if (resolution === 'error') throw new Error('RPC unavailable');
        return resolution;
      });
      const operation = state.begin(mode === 'manual' ? 'unverified' : 'hidden');
      await act(async () => {
        if (mode === 'manual') state.result.current.reconciliation.checkReceiptOperationStatus(operation);
        else state.result.current.reconciliation.reconcilePendingReceiptSubmission({ connection, operation });
      });
      const settled = state.result.current.receiptState.receiptOperations.get(operation.key);
      const available = resolution === 'failed' || resolution === 'expired';
      assert.equal(settled?.phase, available ? undefined : resolution === 'confirmed' ? 'hidden' : 'unverified');
      if (settled) {
        assert.equal(settled.createdGeneration, operation.createdGeneration);
        assert.equal(settled.generation, operation.generation + Number(mode === 'manual'));
      }
      assert.equal(calls, 1);
      assert.equal(state.refreshes, 1);
      assert.deepEqual(persistedRequests().map((entry) => entry.requestId), available ? [] : [requestId]);
      assert.deepEqual(state.toasts, [resolution === 'confirmed'
        ? 'Admin IRL transfer confirmed'
        : available
          ? 'Admin IRL transfer did not complete · receipt restored'
          : mode === 'manual'
            ? 'Receipt transfer status is still unavailable · no new transfer was sent'
            : 'Admin IRL transfer status could not be verified · receipt is view-only for now']);
    });
  }
}

test('manual checks deduplicate before the first status response arrives', async () => {
  const pending = deferred<SubmittedTransactionReconciliationResult>();
  let calls = 0;
  const state = harness(() => { calls += 1; return pending.promise; });
  const operation = state.begin('unverified');
  act(() => {
    state.result.current.reconciliation.checkReceiptOperationStatus(operation);
    state.result.current.reconciliation.checkReceiptOperationStatus(operation);
  });
  const checking = state.result.current.receiptState.receiptOperations.get(operation.key)!;
  assert.equal(checking.phase, 'checking');
  assert.equal(checking.generation, operation.generation + 1);
  assert.equal(checking.createdGeneration, operation.createdGeneration);
  assert.equal(calls, 1);
  await act(async () => pending.resolve('confirmed'));
  assert.equal(state.result.current.receiptState.receiptOperations.get(operation.key)?.phase, 'hidden');
  assert.equal(state.toasts.length, 1);
});

for (const invalidation of ['wallet-change', 'replacement'] as const) {
  test(`stale reconciliation after ${invalidation} preserves admin recovery and newer ledger state`, async () => {
    const pending = deferred<SubmittedTransactionReconciliationResult>();
    const state = harness(() => pending.promise);
    const operation = state.begin();
    act(() => {
      state.result.current.reconciliation.reconcilePendingReceiptSubmission({ connection, operation });
      if (invalidation === 'wallet-change') state.result.current.receiptState.rebaseReceiptOperations(wallet);
      else state.result.current.receiptState.beginReceiptOperation({ wallet, assetId, dropId: 'card_nft_2' });
    });
    const registry = state.result.current.receiptState.receiptOperations;
    await act(async () => pending.resolve('failed'));
    assert.equal(state.result.current.receiptState.receiptOperations, registry);
    assert.deepEqual(persistedRequests().map((entry) => entry.requestId), [requestId]);
    assert.deepEqual(state.toasts, []);
    assert.equal(state.refreshes, 0);
  });
}

test('settlement still applies to the original wallet while suppressing another wallet UI effects', async () => {
  const pending = deferred<SubmittedTransactionReconciliationResult>();
  const state = harness(() => pending.promise);
  const operation = state.begin();
  act(() => state.result.current.reconciliation.reconcilePendingReceiptSubmission({ connection, operation }));
  state.connectedWalletRef.current = address(5);
  await act(async () => pending.resolve('failed'));
  assert.equal(state.result.current.receiptState.receiptOperations.has(operation.key), false);
  assert.deepEqual(persistedRequests(), []);
  assert.deepEqual(state.toasts, []);
  assert.equal(state.refreshes, 0);
});

test('manual checks ignore unsigned, non-unverified, and other-wallet operations', () => {
  const state = harness(async () => assert.fail('Ineligible checks must not contact RPC'));
  for (const reason of ['unsigned', 'hidden', 'other-wallet'] as const) {
    const operation = state.begin(reason === 'hidden' ? 'hidden' : 'unverified', reason !== 'unsigned');
    if (reason === 'other-wallet') state.connectedWalletRef.current = address(5);
    const registry = state.result.current.receiptState.receiptOperations;
    act(() => state.result.current.reconciliation.checkReceiptOperationStatus(operation));
    assert.equal(state.result.current.receiptState.receiptOperations, registry);
  }
  assert.deepEqual(state.toasts, []);
  assert.equal(state.refreshes, 0);
});

test('missing submission identifiers and unavailable drop connections remain unverified', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const state = harness(
    async () => assert.fail('Incomplete checks must not contact RPC'),
    () => { throw new Error('Unknown drop'); },
  );
  const unsigned = state.begin('in-flight', false);
  await act(async () => state.result.current.reconciliation.reconcilePendingReceiptSubmission({ connection, operation: unsigned }));
  assert.equal(state.result.current.receiptState.receiptOperations.get(unsigned.key)?.phase, 'unverified');
  const submitted = state.begin('unverified');
  await act(async () => state.result.current.reconciliation.checkReceiptOperationStatus(submitted));
  assert.equal(state.result.current.receiptState.receiptOperations.get(submitted.key)?.phase, 'unverified');
  assert.deepEqual(persistedRequests().map((entry) => entry.requestId), [requestId]);
  assert.equal(state.refreshes, 2);
});
