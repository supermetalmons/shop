import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import bs58 from 'bs58';
import type { VersionedTransaction } from '@solana/web3.js';
import { createReceiptOperationTracker } from '../src/shop/commerce/receiptOperationTracker.ts';
import { useReceiptOperationState } from '../src/shop/commerce/useReceiptOperationState.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
afterEach(cleanup);

const address = (value: number) => bs58.encode(new Uint8Array(32).fill(value));
const wallet = address(1);
const assetId = address(2);
const transaction = (blockhash: string) => ({ message: { recentBlockhash: blockhash } }) as VersionedTransaction;
type Tracker = ReturnType<typeof createReceiptOperationTracker>;

for (const adminFinalizeRequestId of [undefined, 'admin-request']) {
  test(`${adminFinalizeRequestId ? 'admin' : 'direct'} tracking preserves identity across broadcast, retry, and submission`, () => {
    const { result } = renderHook(() => useReceiptOperationState(wallet));
    let tracker!: Tracker;
    act(() => {
      tracker = createReceiptOperationTracker(result.current, { wallet, assetId, dropId: 'card_nft_2' });
    });
    const original = tracker.operation;
    act(() => {
      assert.equal(tracker.recordSubmission({
        phase: 'in-flight', signature: 'first-signature', transaction: transaction('first-blockhash'), adminFinalizeRequestId,
      }), true);
    });
    assert.equal(result.current.receiptOperations.get(original.key), tracker.operation);
    assert.equal(result.current.receiptOperationHiddenAssets.has(assetId), false);
    assert.equal(tracker.operation.adminFinalizeRequestId, adminFinalizeRequestId);
    act(() => tracker.resetForRetry());
    assert.equal(tracker.operation.signature, undefined);
    assert.equal(tracker.operation.recentBlockhash, undefined);
    assert.equal(tracker.operation.adminFinalizeRequestId, undefined);
    act(() => {
      tracker.recordSubmission({
        phase: 'hidden', signature: 'retry-signature', transaction: transaction('retry-blockhash'),
        ...(adminFinalizeRequestId ? { adminFinalizeRequestId: 'retry-admin-request' } : {}),
      });
    });
    assert.equal(result.current.receiptOperations.get(original.key), tracker.operation);
    assert.equal(tracker.operation.key, original.key);
    assert.equal(tracker.operation.wallet, original.wallet);
    assert.equal(tracker.operation.assetId, original.assetId);
    assert.equal(tracker.operation.dropId, original.dropId);
    assert.equal(tracker.operation.createdGeneration, original.createdGeneration);
    assert.equal(tracker.operation.generation, original.generation);
    assert.equal(tracker.operation.signature, 'retry-signature');
    assert.equal(tracker.operation.recentBlockhash, 'retry-blockhash');
    assert.equal(result.current.receiptOperationHiddenAssets.has(assetId), true);
  });
}

for (const invalidation of ['wallet-change', 'replacement'] as const) {
  test(`stale tracker keeps its local submission without changing the ledger after ${invalidation}`, () => {
    const { result } = renderHook(() => useReceiptOperationState(wallet));
    let tracker!: Tracker;
    act(() => {
      tracker = createReceiptOperationTracker(result.current, { wallet, assetId, dropId: 'card_nft_2' });
      tracker.recordSubmission({ phase: 'in-flight', signature: 'first', transaction: transaction('first-blockhash') });
      result.current.beginReceiptOperation({ wallet: address(3), assetId, dropId: 'card_nft_2' });
      result.current.beginReceiptOperation({ wallet, assetId: address(4), dropId: 'card_nft_2' });
      if (invalidation === 'wallet-change') result.current.rebaseReceiptOperations(wallet);
      else result.current.beginReceiptOperation({ wallet, assetId, dropId: 'card_nft_2' });
    });
    const registry = result.current.receiptOperations;
    const previous = tracker.operation;
    act(() => {
      assert.equal(tracker.recordSubmission({
        phase: 'hidden', signature: 'late-signature', transaction: transaction('late-blockhash'),
        adminFinalizeRequestId: 'late-request',
      }), false);
    });
    assert.notEqual(tracker.operation, previous);
    assert.equal(tracker.operation.signature, 'late-signature');
    assert.equal(tracker.operation.recentBlockhash, 'late-blockhash');
    assert.equal(tracker.operation.adminFinalizeRequestId, 'late-request');
    assert.equal(result.current.receiptOperations, registry);
    const submitted = tracker.operation;
    act(() => tracker.resetForRetry());
    assert.equal(tracker.operation, submitted);
    assert.equal(result.current.receiptOperations, registry);
  });
}
