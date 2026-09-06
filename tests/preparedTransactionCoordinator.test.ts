import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  PENDING_PREPARED_TRANSACTION_PREPARING_TTL_MS,
  forgetPendingPreparedTransaction,
  loadPendingPreparedTransaction,
  persistPendingPreparedTransaction,
  replacePendingPreparedTransaction,
  type PendingPreparingTransaction,
} from '../src/lib/pendingPreparedTransactions.ts';
import { createPreparedTransactionCoordinator } from '../src/shop/preparedSubmission.ts';

type TransactionKind = PendingPreparingTransaction['kind'];

const base58Bytes = (length: number, value: number) => bs58.encode(new Uint8Array(length).fill(value));
const wallet = base58Bytes(32, 1);
const signature = base58Bytes(64, 2);
const transaction = { message: { recentBlockhash: base58Bytes(32, 3) } };

function reservation(kind: TransactionKind, operation = 1, createdAt = Date.now()): PendingPreparingTransaction {
  const base = {
    wallet,
    dropId: 'card_nft_2',
    phase: 'preparing' as const,
    createdAt,
    operationId: operation.toString(16).padStart(32, '0'),
    blockhashContextSlot: 123 + operation,
  };
  return kind === 'delivery'
    ? { ...base, kind, deliveryId: 17, itemIds: [base58Bytes(32, 4), base58Bytes(32, 5)] }
    : { ...base, kind, certificates: [11, 12], certificateId: base58Bytes(32, 6) };
}

function setup(kind: TransactionKind) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const state = {
    current: true,
    reservationWritable: true,
    submissionWritable: true,
    removable: true,
    submissionWrites: 0,
    removalAttempts: 0,
    reads: [] as { wallet: string; sync: boolean | undefined }[],
  };
  const coordinator = createPreparedTransactionCoordinator(kind, {
    wallet,
    isCurrent: () => state.current,
    readPending: (expectedWallet, sync) => {
      state.reads.push({ wallet: expectedWallet, sync });
      return loadPendingPreparedTransaction(expectedWallet, storage);
    },
    persistReservation: (entry) => state.reservationWritable && persistPendingPreparedTransaction(entry, storage),
    persistSubmission: (preparing, submitted) => {
      state.submissionWrites += 1;
      return state.submissionWritable && replacePendingPreparedTransaction(preparing, submitted, storage);
    },
    forget: (entry) => {
      state.removalAttempts += 1;
      return state.removable && forgetPendingPreparedTransaction(entry, storage);
    },
  });
  return { coordinator, state, storage, stored: () => loadPendingPreparedTransaction(wallet, storage) };
}

for (const kind of ['delivery', 'claim'] as const) {
  const action = kind === 'delivery' ? 'shipment' : 'claim';
  const title = kind === 'delivery' ? 'Shipment' : 'Claim';

  test(`${kind} coordinator forwards read synchronization and avoids it during wallet checks`, () => {
    const { coordinator, state } = setup(kind);
    assert.equal(coordinator.readPending(), null);
    assert.equal(coordinator.readPending(false), null);
    coordinator.assertCurrent();
    assert.deepEqual(state.reads, [
      { wallet, sync: true },
      { wallet, sync: false },
      { wallet, sync: false },
    ]);
    state.current = false;
    assert.throws(() => coordinator.assertCurrent(), { message: `Wallet changed while preparing ${action}` });
    assert.equal(state.reads.length, 3);
  });

  test(`${kind} coordinator rejects another pending operation and allows its own reservation`, () => {
    const { coordinator, storage } = setup(kind);
    const foreign = reservation(kind === 'claim' ? 'delivery' : 'claim');
    assert.equal(persistPendingPreparedTransaction(foreign, storage), true);
    assert.throws(() => coordinator.assertCurrent(), /Another wallet transaction is already pending/);
    assert.equal(forgetPendingPreparedTransaction(foreign, storage), true);
    coordinator.reserve(reservation(kind));
    coordinator.assertCurrent();
    const newer = reservation(kind, 2);
    assert.equal(persistPendingPreparedTransaction(newer, storage), true);
    assert.throws(() => coordinator.assertCurrent(), /Another wallet transaction is already pending/);
  });

  test(`${kind} coordinator only clears expired reservations belonging to other attempts`, () => {
    const { coordinator, state, storage, stored } = setup(kind);
    const expired = reservation(kind, 1, Date.now() - PENDING_PREPARED_TRANSACTION_PREPARING_TTL_MS);
    assert.equal(persistPendingPreparedTransaction(expired, storage), true);
    state.removable = false;
    assert.deepEqual(coordinator.readPending(), expired);
    assert.throws(() => coordinator.assertCurrent(), /Another wallet transaction is already pending/);
    state.removable = true;
    coordinator.assertCurrent();
    assert.equal(stored(), null);

    coordinator.reserve(expired);
    const removalAttempts = state.removalAttempts;
    assert.throws(() => coordinator.assertCurrent(), { message: `${title} preparation expired` });
    assert.equal(state.removalAttempts, removalAttempts);
    assert.deepEqual(stored(), expired);
  });

  test(`${kind} coordinator drops ownership when reservation persistence fails`, () => {
    const { coordinator, state, storage, stored } = setup(kind);
    const preparing = reservation(kind);
    assert.equal(persistPendingPreparedTransaction(preparing, storage), true);
    state.reservationWritable = false;
    assert.throws(() => coordinator.reserve(preparing), { message: `Unable to save ${action} reservation` });
    assert.equal(coordinator.getSubmitted(), null);
    assert.throws(() => coordinator.recordSubmitted(signature, transaction), { message: `${title} reservation is missing` });
    assert.throws(() => coordinator.assertCurrent(), /Another wallet transaction is already pending/);
    coordinator.clearReservation();
    assert.equal(state.removalAttempts, 0);
    assert.deepEqual(stored(), preparing);
  });

  test(`${kind} coordinator preserves operation details and records identical submission callbacks once`, () => {
    const { coordinator, state, stored } = setup(kind);
    const preparing = reservation(kind);
    coordinator.reserve(preparing);
    coordinator.recordSubmitted(signature, transaction);
    const submitted = {
      ...preparing,
      phase: 'submitted',
      signature,
      recentBlockhash: transaction.message.recentBlockhash,
    };
    assert.deepEqual(coordinator.getSubmitted(), submitted);
    assert.deepEqual(stored(), submitted);
    coordinator.assertCurrent();
    coordinator.recordSubmitted(signature, transaction);
    assert.equal(state.submissionWrites, 1);
    assert.throws(
      () => coordinator.recordSubmitted(base58Bytes(64, 7), transaction),
      { message: `${title} submission changed unexpectedly` },
    );
    assert.throws(
      () => coordinator.recordSubmitted(signature, { message: { recentBlockhash: base58Bytes(32, 8) } }),
      { message: `${title} submission changed unexpectedly` },
    );
    assert.equal(state.submissionWrites, 1);
    assert.deepEqual(stored(), submitted);
  });

  test(`${kind} coordinator does not expose a submission whose persistence failed`, () => {
    const { coordinator, state, stored } = setup(kind);
    const preparing = reservation(kind);
    coordinator.reserve(preparing);
    state.submissionWritable = false;
    assert.throws(() => coordinator.recordSubmitted(signature, transaction), { message: `Unable to save submitted ${action}` });
    assert.equal(coordinator.getSubmitted(), null);
    assert.deepEqual(stored(), preparing);
    coordinator.assertCurrent();
    state.submissionWritable = true;
    coordinator.recordSubmitted(signature, transaction);
    assert.equal(coordinator.getSubmitted()?.signature, signature);
    assert.equal(state.submissionWrites, 2);
  });

  test(`${kind} coordinator retains reservation ownership until cleanup succeeds`, () => {
    const { coordinator, state, stored } = setup(kind);
    const preparing = reservation(kind);
    coordinator.reserve(preparing);
    state.removable = false;
    assert.throws(() => coordinator.clearReservation(), { message: `Unable to clear ${action} reservation` });
    assert.deepEqual(stored(), preparing);
    coordinator.assertCurrent();
    coordinator.recordSubmitted(signature, transaction);
    assert.throws(() => coordinator.clearReservation(), { message: `Unable to clear ${action} reservation` });
    assert.equal(stored()?.phase, 'submitted');
    state.removable = true;
    coordinator.clearReservation();
    assert.equal(stored(), null);
    assert.equal(coordinator.getSubmitted()?.signature, signature);
  });

  test(`${kind} coordinator releases ownership while retaining submitted recovery data`, () => {
    const { coordinator, state, stored } = setup(kind);
    coordinator.reserve(reservation(kind));
    coordinator.recordSubmitted(signature, transaction);
    const submitted = coordinator.getSubmitted();
    coordinator.releaseReservation();
    assert.deepEqual(stored(), submitted);
    assert.deepEqual(coordinator.getSubmitted(), submitted);
    assert.equal(state.removalAttempts, 0);
    assert.throws(() => coordinator.assertCurrent(), /Another wallet transaction is already pending/);
  });

  test(`${kind} coordinator starts a fresh submission record for the next reserved attempt`, () => {
    const { coordinator, stored } = setup(kind);
    coordinator.reserve(reservation(kind));
    coordinator.recordSubmitted(signature, transaction);
    coordinator.clearReservation();
    const next = reservation(kind, 2);
    coordinator.reserve(next);
    assert.equal(coordinator.getSubmitted(), null);
    assert.deepEqual(stored(), next);
    const nextSignature = base58Bytes(64, 9);
    coordinator.recordSubmitted(nextSignature, transaction);
    assert.equal(coordinator.getSubmitted()?.signature, nextSignature);
    assert.equal(coordinator.getSubmitted()?.operationId, next.operationId);
  });
}
