import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  PENDING_PREPARED_TRANSACTION_PREPARING_TTL_MS,
  forgetPendingPreparedTransaction,
  loadPendingPreparedTransaction,
  parsePendingPreparedTransaction,
  pendingDeliveryAssetIds,
  pendingPreparingTransactionExpired,
  pendingPreparedTransactionStorageKey,
  pendingSubmittedClaim,
  persistPendingPreparedTransaction,
  replacePendingPreparedTransaction,
  samePendingPreparedTransaction,
  type PendingPreparingClaimTransaction,
  type PendingPreparingDeliveryTransaction,
  type PendingSubmittedClaimTransaction,
  type PendingSubmittedDeliveryTransaction,
} from '../src/lib/pendingPreparedTransactions.ts';

const base58Bytes = (length: number, value: number) => bs58.encode(Uint8Array.from({ length }, () => value));
const walletA = base58Bytes(32, 1);
const walletB = base58Bytes(32, 2);

const preparingDelivery: PendingPreparingDeliveryTransaction = {
  kind: 'delivery',
  phase: 'preparing',
  wallet: walletA,
  dropId: 'card_nft_2',
  createdAt: 1_750_000_000_000,
  operationId: '01'.repeat(16),
  blockhashContextSlot: 123,
  deliveryId: 17,
  itemIds: [base58Bytes(32, 5), base58Bytes(32, 6)],
};

const submittedDelivery: PendingSubmittedDeliveryTransaction = {
  ...preparingDelivery,
  phase: 'submitted',
  signature: base58Bytes(64, 3),
  recentBlockhash: base58Bytes(32, 4),
};

const preparingClaim: PendingPreparingClaimTransaction = {
  kind: 'claim',
  phase: 'preparing',
  wallet: walletA,
  dropId: 'card_nft_2',
  createdAt: 1_750_000_000_001,
  operationId: '02'.repeat(16),
  blockhashContextSlot: 456,
  certificates: [11, 12],
  certificateId: base58Bytes(32, 9),
};

const submittedClaim: PendingSubmittedClaimTransaction = {
  ...preparingClaim,
  phase: 'submitted',
  signature: base58Bytes(64, 7),
  recentBlockhash: base58Bytes(32, 8),
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test('pending prepared records strictly parse preparing and submitted phases', () => {
  assert.deepEqual(parsePendingPreparedTransaction(preparingDelivery), preparingDelivery);
  assert.deepEqual(parsePendingPreparedTransaction(submittedDelivery), submittedDelivery);
  assert.deepEqual(parsePendingPreparedTransaction(preparingClaim), preparingClaim);
  assert.deepEqual(parsePendingPreparedTransaction(submittedClaim), submittedClaim);
  assert.equal(parsePendingPreparedTransaction({ ...preparingClaim, code: '1234' }), null);
  assert.equal(parsePendingPreparedTransaction({ ...submittedClaim, phase: 'preparing' }), null);
  assert.equal(parsePendingPreparedTransaction({ ...preparingClaim, operationId: 'bad' }), null);
  assert.equal(parsePendingPreparedTransaction({ ...preparingClaim, blockhashContextSlot: -1 }), null);
});

test('submitted records reject zero signatures and blockhashes', () => {
  assert.equal(parsePendingPreparedTransaction({
    ...submittedClaim,
    signature: bs58.encode(new Uint8Array(64)),
  }), null);
  assert.equal(parsePendingPreparedTransaction({
    ...submittedClaim,
    recentBlockhash: bs58.encode(new Uint8Array(32)),
  }), null);
});

test('per-wallet storage isolates records without a shared read-modify-write registry', () => {
  const storage = memoryStorage();
  const walletBDelivery = { ...preparingDelivery, wallet: walletB, operationId: '03'.repeat(16) };
  assert.equal(persistPendingPreparedTransaction(preparingClaim, storage), true);
  assert.equal(persistPendingPreparedTransaction(walletBDelivery, storage), true);
  assert.deepEqual(loadPendingPreparedTransaction(walletA, storage), preparingClaim);
  assert.deepEqual(loadPendingPreparedTransaction(walletB, storage), walletBDelivery);
  assert.notEqual(pendingPreparedTransactionStorageKey(walletA), pendingPreparedTransactionStorageKey(walletB));
});

test('submitted replacement requires ownership of the matching preparing reservation', () => {
  const storage = memoryStorage();
  persistPendingPreparedTransaction(preparingClaim, storage);
  assert.equal(replacePendingPreparedTransaction(preparingClaim, submittedClaim, storage), true);
  assert.deepEqual(loadPendingPreparedTransaction(walletA, storage), submittedClaim);

  const differentContext = { ...preparingClaim, blockhashContextSlot: preparingClaim.blockhashContextSlot + 1 };
  assert.equal(samePendingPreparedTransaction(preparingClaim, differentContext), false);

  const differentReservation = { ...preparingClaim, operationId: '04'.repeat(16) };
  assert.equal(replacePendingPreparedTransaction(differentReservation, {
    ...submittedClaim,
    operationId: differentReservation.operationId,
  }, storage), false);
  assert.deepEqual(loadPendingPreparedTransaction(walletA, storage), submittedClaim);
});

test('terminal cleanup removes a matching preparing fallback after submitted persistence failure', () => {
  const storage = memoryStorage();
  persistPendingPreparedTransaction(preparingDelivery, storage);
  assert.equal(samePendingPreparedTransaction(preparingDelivery, submittedDelivery), true);
  assert.equal(forgetPendingPreparedTransaction(submittedDelivery, storage), true);
  assert.equal(loadPendingPreparedTransaction(walletA, storage), null);
});

test('terminal cleanup cannot remove a newer submitted operation', () => {
  const storage = memoryStorage();
  const newer = {
    ...submittedClaim,
    operationId: '05'.repeat(16),
    signature: base58Bytes(64, 10),
  };
  persistPendingPreparedTransaction(newer, storage);
  assert.equal(forgetPendingPreparedTransaction(submittedClaim, storage), true);
  assert.deepEqual(loadPendingPreparedTransaction(walletA, storage), newer);
});

test('preparing expiry and wallet-scoped helpers preserve one operation', () => {
  assert.equal(pendingPreparingTransactionExpired(
    preparingClaim,
    preparingClaim.createdAt + PENDING_PREPARED_TRANSACTION_PREPARING_TTL_MS - 1,
  ), false);
  assert.equal(pendingPreparingTransactionExpired(
    preparingClaim,
    preparingClaim.createdAt + PENDING_PREPARED_TRANSACTION_PREPARING_TTL_MS,
  ), true);
  assert.equal(pendingSubmittedClaim(submittedClaim, walletA), submittedClaim);
  assert.equal(pendingSubmittedClaim(preparingClaim, walletA), null);
  assert.deepEqual([...pendingDeliveryAssetIds(preparingDelivery, walletA)], preparingDelivery.itemIds);
  assert.deepEqual([...pendingDeliveryAssetIds(preparingDelivery, walletB)], []);
});

test('persistence failures are reported before signing can begin', () => {
  assert.equal(persistPendingPreparedTransaction(preparingClaim, null), false);
  assert.equal(persistPendingPreparedTransaction(preparingClaim, {
    getItem: () => null,
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => undefined,
  }), false);
});
