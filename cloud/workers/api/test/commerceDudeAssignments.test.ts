import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CommerceDudeAssignmentError,
  assignCommerceDudes,
} from '../src/commerceDudeAssignments.js';
import {
  D1CommerceRepository,
  commerceKeys,
} from '../src/commerceRepository.js';
import { createCommerceD1Harness } from './commerceD1Harness.js';

const signal = new AbortController().signal;

function assignmentArgs(repository: D1CommerceRepository) {
  return {
    boxAssetId: 'box',
    dropFamily: 'poncho_drifella',
    dropId: 'drop',
    itemsPerBox: 1,
    maxDudeId: 3,
    nowMs: 100,
    randomInt: () => 0,
    repository,
    signal,
    sleep: async () => undefined,
  };
}

test('commerce assignment atomically creates and reuses an assignment', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);

  const created = await assignCommerceDudes(assignmentArgs(repository));
  const existing = await assignCommerceDudes(assignmentArgs(repository));

  assert.deepEqual(created, { dudeIds: [1], outcome: 'created' });
  assert.deepEqual(existing, { dudeIds: [1], outcome: 'existing' });
  assert.deepEqual((await repository.get(commerceKeys.dudePool('drop')))?.data.available, [2, 3]);
  assert.equal(
    (await repository.get(commerceKeys.dudeAssignment('drop', '1')))?.data.boxAssetId,
    'box',
  );
});

test('commerce assignment rejects malformed stored assignments', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(100, async (transaction) => transaction.create(
    commerceKeys.boxAssignment('drop', 'box'),
    { dudeIds: [1, 1] },
  ));

  await assert.rejects(
    assignCommerceDudes(assignmentArgs(repository)),
    (error: unknown) =>
      error instanceof CommerceDudeAssignmentError &&
      error.code === 'invalid-stored-assignment',
  );
});

test('commerce assignment fails closed when the pool is exhausted', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(100, async (transaction) => transaction.create(
    commerceKeys.dudePool('drop'),
    { available: [] },
  ));

  let failure: CommerceDudeAssignmentError | undefined;
  await assert.rejects(
    assignCommerceDudes(assignmentArgs(repository)),
    (error: unknown) => {
      if (!(error instanceof CommerceDudeAssignmentError)) return false;
      failure = error;
      return error.code === 'pool-exhausted';
    },
  );
  assert.deepEqual(failure?.details, { boxAssetId: 'box', poolLen: 0, required: 1 });
});
