import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceKeys,
} from '../src/commerceRepository.js';
import {
  readCommerceDocuments,
  retryCommerceConflicts,
  runCommerceTransaction,
} from '../src/commerceTransactions.js';
import {
  createCommerceD1Harness,
  seedCommerceDocuments,
  type CommerceD1CallObservation,
} from './commerceD1Harness.js';

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
