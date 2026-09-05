import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  CommerceRepositoryError,
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
} from '../src/commerceRepository.js';
import {
  commitCommerceWrites,
  createCommerceWrite,
  readCommerceDocument,
  readCommerceDocuments,
  runCommerceTransaction,
  runCommerceWriteTransaction,
  updateCommerceWrite,
  type CommerceDocumentContext,
  type CommerceTransactionTarget,
  type CommerceWrite,
} from '../src/commerceTransactions.js';
import {
  createCommerceD1Harness,
  seedCommerceDocuments,
  type CommerceD1CallObservation,
} from './commerceD1Harness.js';
import { ProfileReadError } from '../src/dataAccess.js';

const writeBatchRunners = {
  commitCommerceWrites: async (context: CommerceDocumentContext, writes: readonly CommerceWrite[]) => {
    await commitCommerceWrites(context, writes);
  },
  runCommerceWriteTransaction: async (context: CommerceDocumentContext, writes: readonly CommerceWrite[]) => {
    const result = await runCommerceWriteTransaction(context, async () => ({ result: 'committed', writes }), {
      shouldRetry: () => false,
    });
    assert.equal(result, 'committed');
  },
};

function transactionTarget(context: TestContext, signal?: AbortSignal): CommerceTransactionTarget {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  return { nowMs: 100, repository: new D1CommerceRepository(harness.db), signal };
}

for (const [name, runWrites] of Object.entries(writeBatchRunners)) {
  test(`${name} commits multiple timestamp-guarded updates`, async () => {
    const harness = createCommerceD1Harness();
    const repository = new D1CommerceRepository(harness.db);
    const keys = [commerceKeys.claimCode('FIRST'), commerceKeys.claimCode('SECOND')];
    const updateTime = '2026-09-05T00:00:00.000Z';
    const nowMs = Date.parse(updateTime) + 1000;
    seedCommerceDocuments(harness, keys.map((key) => ({
      key, data: { status: 'available' }, updateTime,
    })));

    await runWrites({ commerceDb: harness.db, repository, nowMs, signal: new AbortController().signal },
      keys.map((key) => updateCommerceWrite({
        path: key.path,
        expectedUpdateTime: updateTime,
        values: { status: 'claimed' },
      })));

    for (const key of keys) {
      const stored = (await repository.get(key))!;
      assert.deepEqual(stored.data, { status: 'claimed' });
      assert.equal(Date.parse(stored.updateTime), nowMs);
      assert.equal(stored.version, 2);
    }
  });

  test(`${name} rejects a stale timestamp later in the batch without changing any documents`, async () => {
    const harness = createCommerceD1Harness();
    const repository = new D1CommerceRepository(harness.db);
    const keys = [commerceKeys.claimCode('FIRST'), commerceKeys.claimCode('SECOND')];
    const updateTime = '2026-09-05T00:00:00.000Z';
    seedCommerceDocuments(harness, keys.map((key) => ({
      key, data: { status: 'available' }, updateTime,
    })));

    await assert.rejects(runWrites({
      commerceDb: harness.db, repository, nowMs: Date.parse(updateTime) + 1000,
      signal: new AbortController().signal,
    }, keys.map((key, index) => updateCommerceWrite({
      path: key.path,
      expectedUpdateTime: index === 0 ? updateTime : '2026-09-04T00:00:00.000Z',
      values: { status: 'claimed' },
    }))), (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted');

    for (const key of keys) {
      const stored = (await repository.get(key))!;
      assert.deepEqual(stored.data, { status: 'available' });
      assert.equal(stored.updateTime, updateTime);
      assert.equal(stored.version, 1);
    }
  });

  test(`${name} batches uncached reads and preserves ordered writes to the same document`, async () => {
    const calls: CommerceD1CallObservation[] = [];
    const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
    const repository = new D1CommerceRepository(harness.db);
    const existing = commerceKeys.claimCode('EXISTING');
    const created = commerceKeys.claimCode('CREATED');
    const merged = commerceKeys.claimCode('MERGED');
    seedCommerceDocuments(harness, [{ key: existing, data: { status: 'available', count: 1 } }]);

    await runWrites({ commerceDb: harness.db, repository, nowMs: 100, signal: new AbortController().signal }, [
      updateCommerceWrite({ path: existing.path, values: { count: commerceFieldValue.increment(1) }, mustExist: true }),
      createCommerceWrite({ path: created.path, values: { status: 'available', count: 0 } }),
      updateCommerceWrite({ path: merged.path, values: { status: 'available' } }),
      updateCommerceWrite({ path: created.path, values: { status: 'claimed', count: commerceFieldValue.increment(1) }, mustExist: true }),
      updateCommerceWrite({ path: existing.path, values: { status: 'claimed', count: commerceFieldValue.increment(1) } }),
    ]);

    assert.equal(calls.length, 3);
    assert.deepEqual((await repository.get(existing))?.data, { status: 'claimed', count: 3 });
    assert.deepEqual((await repository.get(created))?.data, { status: 'claimed', count: 1 });
    assert.deepEqual((await repository.get(merged))?.data, { status: 'available' });
  });
}

test('commerce value maps preserve omitted fields and apply explicit deletes and transforms', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.deliveryOrder('poncho', '7');
  const nowMs = 1_700_000_000_000;
  const context = { commerceDb: harness.db, repository, nowMs, signal: new AbortController().signal };
  await commitCommerceWrites(context, [createCommerceWrite({
    path: key.path,
    values: {
      status: 'prepared',
      retained: 'keep',
      obsolete: 'remove',
      lease: { id: 'old-claim', attempts: 2 },
      tags: ['first'],
      createdAt: commerceFieldValue.serverTimestamp(),
    },
  })]);
  const created = (await repository.get(key))!;

  await commitCommerceWrites({ ...context, nowMs: nowMs + 1000 }, [updateCommerceWrite({
    path: key.path,
    expectedUpdateTime: created.updateTime,
    values: {
      status: 'ready_to_ship',
      obsolete: commerceFieldValue.delete(),
      'lease.id': commerceFieldValue.delete(),
      'lease.attempts': commerceFieldValue.increment(1),
      tags: commerceFieldValue.arrayUnion('first', 'second'),
      optional: null,
      updatedAt: commerceFieldValue.serverTimestamp(),
      processedAt: commerceFieldValue.timestamp(1_700_000_001, 123_456_789),
    },
  })]);

  const updated = (await repository.get(key))!;
  assert.deepEqual(updated.data, {
    status: 'ready_to_ship',
    retained: 'keep',
    lease: { attempts: 3 },
    tags: ['first', 'second'],
    optional: null,
    createdAt: nowMs,
    updatedAt: nowMs + 1000,
    processedAt: nowMs + 1123,
  });
  assert.deepEqual(updated.processedAt, { seconds: 1_700_000_001, nanos: 123_456_789 });
});

test('commerce value maps preserve create, must-exist and merge preconditions', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const existing = commerceKeys.claimCode('EXISTING');
  const missing = commerceKeys.claimCode('MISSING');
  seedCommerceDocuments(harness, [{ key: existing, data: { status: 'available' } }]);
  const context = { commerceDb: harness.db, repository, nowMs: 100, signal: new AbortController().signal };

  await assert.rejects(commitCommerceWrites(context, [createCommerceWrite({
    path: existing.path,
    values: { status: 'replacement' },
  })]), (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'already-exists');
  await assert.rejects(commitCommerceWrites(context, [
    updateCommerceWrite({ path: existing.path, values: { status: 'claimed' }, mustExist: true }),
    updateCommerceWrite({ path: missing.path, values: { status: 'claimed' }, mustExist: true }),
  ]), (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'failed-precondition');
  assert.equal(await repository.get(missing), null);

  await commitCommerceWrites(context, [updateCommerceWrite({
    path: missing.path,
    values: { status: 'available', absent: commerceFieldValue.delete() },
  })]);
  assert.deepEqual((await repository.get(existing))?.data, { status: 'available' });
  assert.deepEqual((await repository.get(missing))?.data, { status: 'available' });
});

test('stale commerce write timestamps reject the whole batch', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const first = commerceKeys.claimCode('FIRST');
  const second = commerceKeys.claimCode('SECOND');
  const updateTime = '2026-09-05T00:00:00.000Z';
  seedCommerceDocuments(harness, [
    { key: first, data: { status: 'available' }, updateTime },
    { key: second, data: { status: 'available' }, updateTime },
  ]);

  await assert.rejects(commitCommerceWrites({
    commerceDb: harness.db,
    repository,
    nowMs: 100,
    signal: new AbortController().signal,
  }, [
    updateCommerceWrite({
      path: first.path,
      values: { status: 'claimed' },
      expectedUpdateTime: '2026-09-04T00:00:00.000Z',
    }),
    updateCommerceWrite({ path: second.path, values: { status: 'claimed' }, mustExist: true }),
  ]), (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted');

  for (const key of [first, second]) {
    const stored = (await repository.get(key))!;
    assert.deepEqual(stored.data, { status: 'available' });
    assert.equal(stored.updateTime, updateTime);
  }
});

test('transactional document read failures retain their cause and unavailable status', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const cause = new Error('D1 read failed');
  for (const signal of [new AbortController().signal, AbortSignal.abort(new Error('unrelated cancellation'))]) {
    const transaction = await repository.begin(100);
    context.mock.method(transaction, 'get', async () => { throw cause; });
    await assert.rejects(readCommerceDocument({
      commerceDb: harness.db, repository, nowMs: 100, signal,
    }, commerceKeys.claimCode('READ').path, transaction), (error: unknown) => {
      assert.ok(error instanceof CommerceRepositoryError);
      assert.equal(error.code, 'unavailable');
      assert.equal(error.status, 503);
      assert.equal(error.cause, cause);
      return true;
    });
    transaction.rollback();
  }
});

test('transactional document reads preserve typed errors and cancellation identity', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const cancellation = new Error('cancelled during read');
  const activeSignal = new AbortController().signal;
  const cancelledSignal = AbortSignal.abort(cancellation);
  const cases = [
    { error: new CommerceWriteConflict(), signal: activeSignal },
    { error: new CommerceRepositoryError('invalid-argument', 'Invalid read'), signal: activeSignal },
    { error: new ProfileReadError('unavailable', 503, 'Read unavailable'), signal: activeSignal },
    { error: cancellation, signal: cancelledSignal },
    { error: new Error('Read interrupted', { cause: cancellation }), signal: cancelledSignal },
  ];
  for (const { error, signal } of cases) {
    const transaction = await repository.begin(100);
    context.mock.method(transaction, 'get', async () => { throw error; });
    await assert.rejects(readCommerceDocument({
      commerceDb: harness.db, repository, nowMs: 100, signal,
    }, commerceKeys.claimCode('READ').path, transaction), (caught) => caught === error);
    transaction.rollback();
  }
});

test('commerce document batches preserve caller order, missing documents, and document metadata', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  const claimKey = commerceKeys.claimCode('BATCH');
  const orderKey = commerceKeys.deliveryOrder('poncho', '7');
  const missingKey = commerceKeys.claimCode('MISSING');
  const updateTime = '2026-09-05T00:00:00.000Z';
  seedCommerceDocuments(harness, [
    { key: claimKey, data: { code: 'BATCH' }, updateTime },
    { key: orderKey, data: { status: 'prepared' }, updateTime },
  ]);
  const transaction = await new D1CommerceRepository(harness.db).begin(100);
  calls.length = 0;

  const documents = await readCommerceDocuments(transaction, [
    orderKey.path, missingKey.path, claimKey.path, orderKey.path,
  ]);

  const order = { fields: { status: 'prepared' }, id: '7', path: orderKey.path, updateTime };
  assert.deepEqual(documents, [
    order,
    null,
    { fields: { code: 'BATCH' }, id: 'BATCH', path: claimKey.path, updateTime },
    order,
  ]);
  assert.equal(calls.length, 1);
  transaction.rollback();
});

test('commerce document batches validate every path before issuing reads', async () => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  const transaction = await new D1CommerceRepository(harness.db).begin(100);
  calls.length = 0;

  await assert.rejects(
    readCommerceDocuments(transaction, ['claimCodes/VALID', 'not-a-commerce-path']),
    /Invalid commerce document path/,
  );

  assert.equal(calls.length, 0);
  transaction.rollback();
});

test('commerce conflict retries use the standard schedule', async (context) => {
  const delays: number[] = [];
  let attempts = 0;
  const result = await runCommerceTransaction(transactionTarget(context), async () => {
    attempts += 1;
    if (attempts < 6) throw new CommerceWriteConflict();
    return 'committed';
  }, {
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.equal(result, 'committed');
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [50, 100, 200, 400, 800]);
});

test('commerce conflict retries preserve exhausted and non-conflict errors', async (context) => {
  const conflict = new CommerceWriteConflict();
  let conflictAttempts = 0;
  await assert.rejects(
    runCommerceTransaction(transactionTarget(context), async () => {
      conflictAttempts += 1;
      throw conflict;
    }, { sleep: async () => undefined }),
    (error) => error === conflict,
  );
  assert.equal(conflictAttempts, 6);

  const failure = new Error('not a conflict');
  let failureAttempts = 0;
  await assert.rejects(
    runCommerceTransaction(transactionTarget(context), async () => {
      failureAttempts += 1;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(failureAttempts, 1);
});

test('commerce conflict filtering keeps create collisions non-retryable', async (context) => {
  const collision = new CommerceWriteConflict('already-exists');
  let attempts = 0;
  await assert.rejects(
    runCommerceTransaction(transactionTarget(context), async () => {
      attempts += 1;
      throw collision;
    }, {
      shouldRetry: (error) => error.code === 'aborted',
    }),
    (error) => error === collision,
  );
  assert.equal(attempts, 1);
});

test('commerce conflict retries preserve abort reasons', async (context) => {
  const before = new AbortController();
  const beforeReason = new Error('aborted before attempt');
  before.abort(beforeReason);
  let beforeAttempts = 0;
  await assert.rejects(
    runCommerceTransaction(transactionTarget(context, before.signal), async () => {
      beforeAttempts += 1;
      return null;
    }),
    (error) => error === beforeReason,
  );
  assert.equal(beforeAttempts, 0);

  const during = new AbortController();
  const duringReason = new Error('aborted during wait');
  await assert.rejects(
    runCommerceTransaction(transactionTarget(context, during.signal), async () => {
      throw new CommerceWriteConflict();
    }, {
      sleep: async (_milliseconds, signal) => {
        during.abort(duringReason);
        signal?.throwIfAborted();
      },
    }),
    (error) => error === duringReason,
  );
});

test('commerce transaction retries delegate fresh repository runs', async () => {
  const timestamps: number[] = [];
  let calls = 0;
  const repository: Pick<D1CommerceRepository, 'run'> = {
    async run<T>(nowMs: number): Promise<T> {
      timestamps.push(nowMs);
      calls += 1;
      if (calls < 3) throw new CommerceWriteConflict();
      return 'done' as T;
    },
  };

  const result = await runCommerceTransaction({
    nowMs: () => 100 + calls,
    repository,
  }, async () => 'unused', {
    sleep: async () => undefined,
  });

  assert.equal(result, 'done');
  assert.deepEqual(timestamps, [100, 101, 102]);
});

test('commerce transaction rolls back failed attempts before committing a retry', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.claimCode('RETRY');
  let attempts = 0;

  const result = await runCommerceTransaction({
    nowMs: 100,
    repository,
  }, async (transaction) => {
    attempts += 1;
    assert.equal(await transaction.get(key), null);
    await transaction.create(key, { attempt: attempts });
    if (attempts === 1) throw new CommerceWriteConflict();
    return 'committed';
  }, {
    sleep: async () => undefined,
  });

  assert.equal(result, 'committed');
  assert.equal(attempts, 2);
  assert.deepEqual((await repository.get(key))?.data, { attempt: 2 });
});
