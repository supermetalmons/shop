import assert from 'node:assert/strict';
import test from 'node:test';
import bs58 from 'bs58';
import {
  forgetPendingPreparedTransaction,
  loadPendingPreparedTransaction,
  persistPendingPreparedTransaction,
  replacePendingPreparedTransaction,
  type PendingPreparingTransaction,
} from '../src/lib/pendingPreparedTransactions.ts';
import { PotentiallySubmittedTransactionError } from '../src/lib/solana.ts';
import {
  createPreparedTransactionCoordinator,
  runPreparedSubmission,
  type BrowserLockManager,
} from '../src/shop/preparedSubmission.ts';

type Kind = PendingPreparingTransaction['kind'];
type Context = { attempt: number; connection: { endpoint: string } };
type RunnerOptions<K extends Kind> = Parameters<typeof runPreparedSubmission<K, Context>>[0];

const base58 = (length: number, value: number) => bs58.encode(new Uint8Array(length).fill(value));
const wallet = base58(32, 1);
const otherWallet = base58(32, 2);
const signature = base58(64, 3);
const transaction = { message: { recentBlockhash: base58(32, 4) } };

function reservation<K extends Kind>(kind: K, attempt: number): Extract<PendingPreparingTransaction, { kind: K }> {
  const base = {
    wallet,
    dropId: 'card_nft_2',
    phase: 'preparing' as const,
    createdAt: Date.now(),
    operationId: (attempt + 1).toString(16).padStart(32, '0'),
    blockhashContextSlot: 123 + attempt,
  };
  return (kind === 'delivery'
    ? { ...base, kind, deliveryId: 17 + attempt, itemIds: [base58(32, 5)] }
    : { ...base, kind, certificates: [11 + attempt], certificateId: base58(32, 6) }
  ) as Extract<PendingPreparingTransaction, { kind: K }>;
}

function setup<K extends Kind>(kind: K) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const pendingSubmissionKeys = new Set([otherWallet]);
  const state = {
    current: true,
    locked: false,
    reservationWritable: true,
    submissionWritable: true,
    removable: true,
    attempts: [] as number[],
    contexts: [] as Context[],
    sent: [] as Context[],
    retries: 0,
    confirmations: 0,
    pending: 0,
    forgets: 0,
    sendBehavior: null as null | ((context: Context) => Promise<string>),
  };
  const stored = () => loadPendingPreparedTransaction(wallet, storage);
  const forget = (entry: Parameters<typeof forgetPendingPreparedTransaction>[0]) => {
    state.forgets += 1;
    return state.removable && forgetPendingPreparedTransaction(entry, storage);
  };
  const coordinator = createPreparedTransactionCoordinator(kind, {
    wallet,
    isCurrent: () => state.current,
    readPending: (expectedWallet) => loadPendingPreparedTransaction(expectedWallet, storage),
    persistReservation: (entry) => state.reservationWritable && persistPendingPreparedTransaction(entry, storage),
    persistSubmission: (preparing, submitted) => state.submissionWritable && replacePendingPreparedTransaction(preparing, submitted, storage),
    forget,
  });
  const lockManager: BrowserLockManager = {
    async request(name, options, callback) {
      assert.equal(name, `mons:pending-prepared-submission:${wallet}`);
      assert.deepEqual(options, { ifAvailable: true });
      state.locked = true;
      try {
        return await callback({});
      } finally {
        state.locked = false;
      }
    },
  };
  const options: RunnerOptions<K> = {
    wallet,
    coordinator,
    pendingSubmissionKeys,
    forgetSubmission: forget,
    prepare: async (attempt) => {
      assert.equal(state.locked, true);
      coordinator.assertCurrent();
      state.attempts.push(attempt);
      const context = { attempt, connection: { endpoint: `connection-${attempt}` } };
      state.contexts.push(context);
      return { context, reservation: reservation(kind, attempt) };
    },
    send: async (context) => {
      assert.equal(state.locked, true);
      assert.equal(pendingSubmissionKeys.has(wallet), true);
      assert.equal(stored()?.phase, 'preparing');
      state.sent.push(context);
      if (state.sendBehavior) return state.sendBehavior(context);
      coordinator.recordSubmitted(signature, transaction);
      return signature;
    },
    onConfirmed: (submission, context) => {
      state.confirmations += 1;
      assert.equal(state.locked, true);
      assert.equal(pendingSubmissionKeys.has(wallet), false);
      assert.deepEqual(stored(), submission);
      assert.equal(context, state.contexts.at(-1));
    },
    onPending: (submission, context) => {
      state.pending += 1;
      assert.equal(state.locked, true);
      assert.equal(pendingSubmissionKeys.has(wallet), false);
      assert.deepEqual(stored(), submission);
      assert.equal(context, state.contexts.at(-1));
      assert.throws(() => coordinator.assertCurrent(), /Another wallet transaction is already pending/);
    },
    beforeRetry: () => {
      state.retries += 1;
      assert.equal(state.locked, true);
      assert.equal(pendingSubmissionKeys.has(wallet), false);
      assert.equal(stored(), null);
      return true;
    },
  };
  const run = (overrides: Partial<RunnerOptions<K>> = {}) => runPreparedSubmission({ ...options, ...overrides }, lockManager);
  const assertReleased = () => {
    assert.deepEqual([...pendingSubmissionKeys], [otherWallet]);
    assert.equal(state.locked, false);
  };
  return { state, storage, stored, coordinator, options, run, assertReleased };
}

for (const kind of ['delivery', 'claim'] as const) {
  test(`${kind} runner completes feature bookkeeping before forgetting the submitted record`, async () => {
    const harness = setup(kind);
    const result = await harness.run();
    assert.equal(result.status, 'confirmed');
    if (result.status !== 'confirmed') return;
    assert.equal(result.context, harness.state.contexts[0]);
    assert.equal(result.signature, signature);
    assert.equal(result.submission?.kind, kind);
    assert.equal(result.submission?.operationId, reservation(kind, 0).operationId);
    assert.equal(harness.state.confirmations, 1);
    assert.equal(harness.state.forgets, 1);
    assert.equal(harness.stored(), null);
    harness.assertReleased();
  });

  test(`${kind} runner retries one expired send with fresh reservation and context`, async () => {
    const harness = setup(kind);
    harness.state.sendBehavior = async (context) => {
      harness.coordinator.recordSubmitted(signature, transaction);
      if (context.attempt === 0) throw new Error('Blockhash not found');
      return signature;
    };
    const result = await harness.run();
    assert.equal(result.status, 'confirmed');
    if (result.status !== 'confirmed') return;
    assert.deepEqual(harness.state.attempts, [0, 1]);
    assert.equal(result.context, harness.state.contexts[1]);
    assert.notEqual(harness.state.sent[0].connection, harness.state.sent[1].connection);
    assert.equal(result.submission?.operationId, reservation(kind, 1).operationId);
    assert.equal(result.submission?.blockhashContextSlot, 124);
    assert.equal(harness.state.retries, 1);
    assert.equal(harness.stored(), null);
    harness.assertReleased();
  });

  test(`${kind} runner stops after the second expired send`, async () => {
    const harness = setup(kind);
    const failure = new Error('Blockhash expired');
    harness.state.sendBehavior = async () => { throw failure; };
    await assert.rejects(harness.run(), (error) => error === failure);
    assert.deepEqual(harness.state.attempts, [0, 1]);
    assert.equal(harness.state.retries, 1);
    assert.equal(harness.stored(), null);
    harness.assertReleased();
  });

  test(`${kind} runner preserves ambiguous submissions even when the cause mentions expiry`, async () => {
    const harness = setup(kind);
    harness.state.sendBehavior = async () => {
      harness.coordinator.recordSubmitted(signature, transaction);
      throw new PotentiallySubmittedTransactionError(signature, new Error('Blockhash expired'));
    };
    const result = await harness.run();
    assert.equal(result.status, 'pending');
    if (result.status !== 'pending') return;
    assert.deepEqual(harness.stored(), result.submission);
    assert.equal(harness.state.pending, 1);
    assert.equal(harness.state.retries, 0);
    assert.equal(harness.state.forgets, 0);
    harness.assertReleased();
  });

  test(`${kind} runner does not recover an ambiguous error without a persisted submission`, async () => {
    const harness = setup(kind);
    const failure = new PotentiallySubmittedTransactionError(signature, new Error('Network request failed'));
    harness.state.sendBehavior = async () => { throw failure; };
    await assert.rejects(harness.run(), (error) => error === failure);
    assert.equal(harness.state.pending, 0);
    assert.equal(harness.state.retries, 0);
    assert.equal(harness.stored(), null);
    harness.assertReleased();
  });

  test(`${kind} runner preserves a null submission for the caller's existing success policy`, async () => {
    const harness = setup(kind);
    harness.state.sendBehavior = async () => signature;
    const result = await harness.run();
    assert.equal(result.status, 'confirmed');
    if (result.status !== 'confirmed') return;
    assert.equal(result.submission, null);
    assert.equal(harness.state.confirmations, 0);
    assert.equal(harness.state.forgets, 0);
    assert.equal(harness.stored()?.phase, 'preparing');
    assert.throws(() => harness.coordinator.assertCurrent(), /Another wallet transaction is already pending/);
    harness.assertReleased();
  });
}

test('runner defers a null preparation without reserving or sending', async () => {
  const harness = setup('claim');
  assert.deepEqual(await harness.run({ prepare: async () => null }), { status: 'deferred' });
  assert.equal(harness.state.sent.length, 0);
  assert.equal(harness.state.forgets, 0);
  assert.equal(harness.stored(), null);
  harness.assertReleased();
});

test('stale claim retry defers while delivery retains its wallet assertion failure', async () => {
  for (const kind of ['claim', 'delivery'] as const) {
    const harness = setup(kind);
    harness.state.sendBehavior = async () => {
      harness.state.current = false;
      throw new Error('Blockhash expired');
    };
    const submission = harness.run({ beforeRetry: () => kind === 'delivery' || harness.state.current });
    if (kind === 'claim') assert.deepEqual(await submission, { status: 'deferred' });
    else await assert.rejects(submission, /Wallet changed while preparing shipment/);
    assert.equal(harness.state.sent.length, 1);
    assert.equal(harness.stored(), null);
    harness.assertReleased();
  }
});

test('runner checks wallet and pending-operation ownership before preparation', async () => {
  for (const reason of ['wallet changed', 'another operation'] as const) {
    const harness = setup('delivery');
    let preparations = 0;
    if (reason === 'wallet changed') harness.state.current = false;
    else persistPendingPreparedTransaction(reservation('claim', 1), harness.storage);
    await assert.rejects(harness.run({ prepare: async (attempt) => {
      preparations += 1;
      return harness.options.prepare(attempt);
    } }), reason === 'wallet changed' ? /Wallet changed/ : /Another wallet transaction is already pending/);
    assert.equal(preparations, 0);
    assert.equal(harness.state.attempts.length, 0);
    assert.equal(harness.state.sent.length, 0);
    assert.equal(harness.state.forgets, 0);
    harness.assertReleased();
  }
});

test('runner refuses unavailable or contended locks before preparation', async () => {
  const harness = setup('delivery');
  await assert.rejects(runPreparedSubmission(harness.options, null), /cannot safely coordinate wallet transactions/);
  const contended: BrowserLockManager = { request: async (_name, _options, callback) => callback(null) };
  await assert.rejects(runPreparedSubmission(harness.options, contended), /Another wallet transaction is already in progress/);
  assert.equal(harness.state.attempts.length, 0);
  assert.equal(harness.state.sent.length, 0);
  harness.assertReleased();
});

test('runner does not retry preparation failures even when they mention blockhash expiry', async () => {
  const harness = setup('claim');
  const failure = new Error('Blockhash expired while requesting transaction');
  await assert.rejects(harness.run({ prepare: async () => { throw failure; } }), (error) => error === failure);
  assert.equal(harness.state.retries, 0);
  assert.equal(harness.state.sent.length, 0);
  assert.equal(harness.stored(), null);
  harness.assertReleased();
});

test('runner never sends when the reservation cannot be persisted', async () => {
  const harness = setup('delivery');
  harness.state.reservationWritable = false;
  await assert.rejects(harness.run(), /Unable to save shipment reservation/);
  assert.equal(harness.state.sent.length, 0);
  assert.equal(harness.state.retries, 0);
  assert.equal(harness.stored(), null);
  harness.assertReleased();
});

test('runner clears a preparing record when recording the submission fails', async () => {
  const harness = setup('claim');
  harness.state.submissionWritable = false;
  await assert.rejects(harness.run(), /Unable to save submitted claim/);
  assert.equal(harness.coordinator.getSubmitted(), null);
  assert.equal(harness.state.pending, 0);
  assert.equal(harness.state.retries, 0);
  assert.equal(harness.stored(), null);
  harness.assertReleased();
});

test('runner stops retrying if the failed reservation cannot be cleared', async () => {
  const harness = setup('delivery');
  harness.state.removable = false;
  harness.state.sendBehavior = async () => { throw new Error('Blockhash expired'); };
  await assert.rejects(harness.run(), /Unable to clear shipment reservation/);
  assert.equal(harness.state.sent.length, 1);
  assert.equal(harness.state.retries, 0);
  assert.equal(harness.stored()?.phase, 'preparing');
  harness.assertReleased();
});

test('runner retains existing success behavior when forgetting the submission returns false', async () => {
  const harness = setup('claim');
  harness.state.removable = false;
  assert.equal((await harness.run()).status, 'confirmed');
  assert.equal(harness.stored()?.phase, 'submitted');
  assert.equal(harness.state.confirmations, 1);
  assert.equal(harness.state.forgets, 1);
  harness.assertReleased();
});

test('runner awaits confirmed bookkeeping before forgetting the submission and unlocking', async () => {
  const harness = setup('delivery');
  let finish!: () => void;
  let started!: () => void;
  const bookkeeping = new Promise<void>((resolve) => { finish = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const submission = harness.run({ onConfirmed: async () => {
    started();
    await bookkeeping;
  } });
  await entered;
  assert.equal(harness.state.locked, true);
  assert.equal(harness.options.pendingSubmissionKeys.has(wallet), false);
  assert.equal(harness.stored()?.phase, 'submitted');
  assert.equal(harness.state.forgets, 0);
  finish();
  assert.equal((await submission).status, 'confirmed');
  assert.equal(harness.stored(), null);
  harness.assertReleased();
});

for (const callback of ['onConfirmed', 'onPending', 'forgetSubmission'] as const) {
  test(`runner propagates ${callback} failure without resending or losing submitted recovery data`, async () => {
    const harness = setup('delivery');
    const failure = new Error('Blockhash expired in feature callback');
    if (callback === 'onPending') {
      harness.state.sendBehavior = async () => {
        harness.coordinator.recordSubmitted(signature, transaction);
        throw new PotentiallySubmittedTransactionError(signature, new Error('Confirmation unavailable'));
      };
    }
    const fail = callback === 'forgetSubmission'
      ? () => { throw failure; }
      : async () => { throw failure; };
    await assert.rejects(harness.run({ [callback]: fail }), (error) => error === failure);
    assert.equal(harness.state.sent.length, 1);
    assert.equal(harness.state.retries, 0);
    assert.equal(harness.stored()?.phase, 'submitted');
    assert.throws(() => harness.coordinator.assertCurrent(), /Another wallet transaction is already pending/);
    harness.assertReleased();
  });
}

test('runner propagates retry callback failure without another preparation', async () => {
  const harness = setup('claim');
  const failure = new Error('Blockhash expired in retry callback');
  harness.state.sendBehavior = async () => { throw new Error('Blockhash expired'); };
  await assert.rejects(harness.run({ beforeRetry: () => { throw failure; } }), (error) => error === failure);
  assert.deepEqual(harness.state.attempts, [0]);
  assert.equal(harness.state.sent.length, 1);
  assert.equal(harness.stored(), null);
  harness.assertReleased();
});
