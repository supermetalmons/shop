import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
} from '../src/commerceRepository.js';
import {
  commitCommerceWrites,
  createCommerceWrite,
  readCommerceDocuments,
  retryCommerceConflicts,
  runCommerceTransaction,
  updateCommerceWrite,
} from '../src/commerceTransactions.js';
import {
  createCommerceD1Harness,
  seedCommerceDocuments,
  type CommerceD1CallObservation,
} from './commerceD1Harness.js';

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

test('commerce conflict retries use the standard schedule', async () => {
  const delays: number[] = [];
  let attempts = 0;
  const result = await retryCommerceConflicts(async () => {
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

test('commerce conflict retries preserve exhausted and non-conflict errors', async () => {
  const conflict = new CommerceWriteConflict();
  let conflictAttempts = 0;
  await assert.rejects(
    retryCommerceConflicts(async () => {
      conflictAttempts += 1;
      throw conflict;
    }, { sleep: async () => undefined }),
    (error) => error === conflict,
  );
  assert.equal(conflictAttempts, 6);

  const failure = new Error('not a conflict');
  let failureAttempts = 0;
  await assert.rejects(
    retryCommerceConflicts(async () => {
      failureAttempts += 1;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(failureAttempts, 1);
});

test('commerce conflict filtering keeps create collisions non-retryable', async () => {
  const collision = new CommerceWriteConflict('already-exists');
  let attempts = 0;
  await assert.rejects(
    retryCommerceConflicts(async () => {
      attempts += 1;
      throw collision;
    }, {
      shouldRetry: (error) => error.code === 'aborted',
    }),
    (error) => error === collision,
  );
  assert.equal(attempts, 1);
});

test('commerce conflict retries preserve abort reasons', async () => {
  const before = new AbortController();
  const beforeReason = new Error('aborted before attempt');
  before.abort(beforeReason);
  let beforeAttempts = 0;
  await assert.rejects(
    retryCommerceConflicts(async () => {
      beforeAttempts += 1;
      return null;
    }, { signal: before.signal }),
    (error) => error === beforeReason,
  );
  assert.equal(beforeAttempts, 0);

  const during = new AbortController();
  const duringReason = new Error('aborted during wait');
  await assert.rejects(
    retryCommerceConflicts(async () => {
      throw new CommerceWriteConflict();
    }, {
      signal: during.signal,
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
