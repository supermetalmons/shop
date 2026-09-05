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
  readCommerceRecord,
  requireCommerceKey,
  runCommerceTransaction,
  type CommerceRepositoryContext,
  type CommerceTransactionTarget,
} from '../src/commerceTransactions.js';
import {
  createCommerceD1Harness,
  seedCommerceDocuments,
  type CommerceD1CallObservation,
} from './commerceD1Harness.js';
import { ProfileReadError } from '../src/dataAccess.js';

function transactionTarget(context: TestContext, signal?: AbortSignal): CommerceTransactionTarget {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  return { nowMs: 100, repository: new D1CommerceRepository(harness.db), signal };
}

test('native transactions commit multiple timestamp-guarded updates', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const keys = [commerceKeys.claimCode('FIRST'), commerceKeys.claimCode('SECOND')];
  const updateTime = '2026-09-05T00:00:00.000Z';
  const nowMs = Date.parse(updateTime) + 1000;
  seedCommerceDocuments(harness, keys.map((key) => ({
    key, data: { status: 'available' }, updateTime,
  })));

  const result = await runCommerceTransaction({ repository, nowMs }, async (transaction) => {
    const records = await transaction.getMany(keys);
    if (records.some((record) => record?.updateTime !== updateTime)) throw new CommerceWriteConflict();
    for (const key of keys) await transaction.update(key, { status: 'claimed' });
    return 'committed';
  });

  assert.equal(result, 'committed');
  for (const key of keys) {
    const stored = (await repository.get(key))!;
    assert.deepEqual(stored.data, { status: 'claimed' });
    assert.equal(Date.parse(stored.updateTime), nowMs);
    assert.equal(stored.version, 2);
  }
});

test('native transactions reject a stale timestamp later in the batch atomically', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const keys = [commerceKeys.claimCode('FIRST'), commerceKeys.claimCode('SECOND')];
  const updateTime = '2026-09-05T00:00:00.000Z';
  const expectedUpdateTimes = [updateTime, '2026-09-04T00:00:00.000Z'];
  seedCommerceDocuments(harness, keys.map((key) => ({
    key, data: { status: 'available' }, updateTime,
  })));

  await assert.rejects(runCommerceTransaction({
    repository, nowMs: Date.parse(updateTime) + 1000,
  }, async (transaction) => {
    const records = await transaction.getMany(keys);
    if (records.some((record, index) => record?.updateTime !== expectedUpdateTimes[index])) {
      throw new CommerceWriteConflict();
    }
    for (const key of keys) await transaction.update(key, { status: 'claimed' });
  }, { shouldRetry: () => false }), (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'aborted');

  for (const key of keys) {
    const stored = (await repository.get(key))!;
    assert.deepEqual(stored.data, { status: 'available' });
    assert.equal(stored.updateTime, updateTime);
    assert.equal(stored.version, 1);
  }
});

test('native transactions batch uncached reads and preserve ordered writes to the same record', async (context) => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const existing = commerceKeys.claimCode('EXISTING');
  const created = commerceKeys.claimCode('CREATED');
  const merged = commerceKeys.claimCode('MERGED');
  seedCommerceDocuments(harness, [{ key: existing, data: { status: 'available', count: 1 } }]);

  await runCommerceTransaction({ repository, nowMs: 100 }, async (transaction) => {
    await transaction.getMany([existing, created, merged, created, existing]);
    await transaction.update(existing, { count: commerceFieldValue.increment(1) });
    await transaction.create(created, { status: 'available', count: 0 });
    await transaction.set(merged, { status: 'available' }, { merge: true });
    await transaction.update(created, { status: 'claimed', count: commerceFieldValue.increment(1) });
    await transaction.set(existing, { status: 'claimed', count: commerceFieldValue.increment(1) }, { merge: true });
  });

  assert.equal(calls.length, 3);
  assert.deepEqual((await repository.get(existing))?.data, { status: 'claimed', count: 3 });
  assert.deepEqual((await repository.get(created))?.data, { status: 'claimed', count: 1 });
  assert.deepEqual((await repository.get(merged))?.data, { status: 'available' });
});

test('native value maps preserve omitted fields and apply explicit deletes and transforms', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const key = commerceKeys.deliveryOrder('poncho', '7');
  const nowMs = 1_700_000_000_000;
  await runCommerceTransaction({ repository, nowMs }, async (transaction) => {
    await transaction.get(key);
    await transaction.create(key, {
      status: 'prepared',
      retained: 'keep',
      obsolete: 'remove',
      lease: { id: 'old-claim', attempts: 2 },
      tags: ['first'],
      createdAt: commerceFieldValue.serverTimestamp(),
    });
  });
  const created = (await repository.get(key))!;

  await runCommerceTransaction({ repository, nowMs: nowMs + 1000 }, async (transaction) => {
    const record = await transaction.get(key);
    if (record?.updateTime !== created.updateTime) throw new CommerceWriteConflict();
    await transaction.update(key, {
      status: 'ready_to_ship',
      obsolete: commerceFieldValue.delete(),
      'lease.id': commerceFieldValue.delete(),
      'lease.attempts': commerceFieldValue.increment(1),
      tags: commerceFieldValue.arrayUnion('first', 'second'),
      optional: null,
      updatedAt: commerceFieldValue.serverTimestamp(),
      processedAt: commerceFieldValue.timestamp(1_700_000_001, 123_456_789),
    });
  });

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

test('native create, update and merge retain existence preconditions and atomicity', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const existing = commerceKeys.claimCode('EXISTING');
  const missing = commerceKeys.claimCode('MISSING');
  seedCommerceDocuments(harness, [{ key: existing, data: { status: 'available' } }]);
  const target = { repository, nowMs: 100 };

  await assert.rejects(runCommerceTransaction(target, async (transaction) => {
    await transaction.get(existing);
    await transaction.create(existing, { status: 'replacement' });
  }, { shouldRetry: () => false }), (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'already-exists');
  await assert.rejects(runCommerceTransaction(target, async (transaction) => {
    await transaction.getMany([existing, missing]);
    await transaction.update(existing, { status: 'claimed' });
    await transaction.update(missing, { status: 'claimed' });
  }, { shouldRetry: () => false }), (error: unknown) => error instanceof CommerceWriteConflict && error.code === 'failed-precondition');
  assert.equal(await repository.get(missing), null);
  assert.deepEqual((await repository.get(existing))?.data, { status: 'available' });

  await runCommerceTransaction(target, async (transaction) => {
    await transaction.get(missing);
    await transaction.set(missing, { status: 'available', absent: commerceFieldValue.delete() }, { merge: true });
  });
  assert.deepEqual((await repository.get(missing))?.data, { status: 'available' });
});

test('transactional record read failures retain their cause and unavailable status', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const cause = new Error('D1 read failed');
  for (const signal of [new AbortController().signal, AbortSignal.abort(new Error('unrelated cancellation'))]) {
    const transaction = await repository.begin(100);
    context.mock.method(transaction, 'get', async () => { throw cause; });
    await assert.rejects(readCommerceRecord({
      repository, nowMs: 100, signal,
    }, commerceKeys.claimCode('READ'), transaction), (error: unknown) => {
      assert.ok(error instanceof CommerceRepositoryError);
      assert.equal(error.code, 'unavailable');
      assert.equal(error.status, 503);
      assert.equal(error.cause, cause);
      return true;
    });
    transaction.rollback();
  }
});

test('transactional record reads preserve typed errors and cancellation identity', async (context) => {
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
    await assert.rejects(readCommerceRecord({
      repository, nowMs: 100, signal,
    }, commerceKeys.claimCode('READ'), transaction), (caught) => caught === error);
    transaction.rollback();
  }
});

test('native record batches preserve caller order, missing records, and metadata', async (context) => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  context.after(() => harness.database.close());
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

  const records = await transaction.getMany([orderKey, missingKey, claimKey, orderKey]);

  const metadata = { createTime: updateTime, updateTime, version: 1, processedAt: null };
  const order = { ...metadata, data: { status: 'prepared' }, key: orderKey };
  assert.deepEqual(records, [
    order,
    null,
    { ...metadata, data: { code: 'BATCH' }, key: claimKey },
    order,
  ]);
  assert.equal(calls.length, 1);
  transaction.rollback();
});

test('stored commerce paths validate before issuing reads', async (context) => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  context.after(() => harness.database.close());
  const transaction = await new D1CommerceRepository(harness.db).begin(100);
  calls.length = 0;

  assert.deepEqual(requireCommerceKey('claimCodes/VALID'), commerceKeys.claimCode('VALID'));
  await assert.rejects(async () => {
    await transaction.getMany(['claimCodes/VALID', 'not-a-commerce-path'].map(requireCommerceKey));
  }, /Invalid commerce document path/);

  assert.equal(calls.length, 0);
  transaction.rollback();
});

test('a one-shot commit omits surrounding cancellation and never retries conflicts', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  const surrounding: CommerceRepositoryContext = {
    nowMs: 100,
    repository: new D1CommerceRepository(harness.db),
    signal: AbortSignal.abort(new Error('request already cancelled')),
  };
  const target = { repository: surrounding.repository, nowMs: surrounding.nowMs };
  const key = commerceKeys.claimCode('ONE_SHOT');
  const options = { shouldRetry: () => false, sleep: async () => assert.fail('one-shot operation retried') };

  const result = await runCommerceTransaction(target, async (transaction) => {
    await readCommerceRecord(surrounding, key, transaction);
    await transaction.create(key, { status: 'committed' });
    return 'committed';
  }, options);
  assert.equal(surrounding.signal.aborted, true);
  assert.equal(result, 'committed');
  assert.deepEqual((await surrounding.repository.get(key))?.data, { status: 'committed' });

  const conflict = new CommerceWriteConflict();
  let attempts = 0;
  await assert.rejects(runCommerceTransaction(target, async (transaction) => {
    attempts += 1;
    await readCommerceRecord(surrounding, key, transaction);
    await transaction.update(key, { status: 'rolled-back' });
    throw conflict;
  }, options), (error) => error === conflict);
  assert.equal(attempts, 1);
  assert.deepEqual((await surrounding.repository.get(key))?.data, { status: 'committed' });
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
