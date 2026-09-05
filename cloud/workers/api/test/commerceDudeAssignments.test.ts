import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS,
  CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET,
  CARD_NFT_2_COMMON_CARD_IDS,
  CARD_NFT_2_COMMON_CARD_ID_SET,
} from '../../../../shared/cardNft2RevealIds.ts';
import { CARD_NFT_2_MAX_CARD_ID } from '../../../../shared/cardNft2AssetCore.ts';
import {
  CommerceDudeAssignmentError,
  assignCommerceDudes,
} from '../src/commerceDudeAssignments.js';
import {
  D1CommerceRepository,
  CommerceRepositoryError,
  commerceKeys,
} from '../src/commerceRepository.js';
import {
  availableCommerceDudeIds,
  createCommerceD1Harness,
  initializeCommerceInventory,
} from './commerceD1Harness.js';

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
  initializeCommerceInventory(harness, assignmentArgs(repository));

  const created = await assignCommerceDudes(assignmentArgs(repository));
  const existing = await assignCommerceDudes(assignmentArgs(repository));

  assert.deepEqual(created, { dudeIds: [1], outcome: 'created' });
  assert.deepEqual(existing, { dudeIds: [1], outcome: 'existing' });
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [2, 3]);
  assert.equal(await repository.get(commerceKeys.dudePool('drop')), null);
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
  initializeCommerceInventory(harness, assignmentArgs(repository));

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

test('commerce assignment fails closed before inventory activation and for missing drops', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await assert.rejects(assignCommerceDudes(assignmentArgs(repository)), CommerceRepositoryError);
  initializeCommerceInventory(harness, assignmentArgs(repository));
  await assert.rejects(assignCommerceDudes({ ...assignmentArgs(repository), dropId: 'uninitialized' }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable');
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [1, 2, 3]);
});

test('commerce assignment preserves pool order and excludes legacy markers', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  await repository.run(1, async (transaction) => {
    await transaction.create(commerceKeys.dudePool('drop'), { available: [3, 1, 2, 3, 0] });
    await transaction.create(commerceKeys.dudeAssignment('drop', '1'), { dudeId: 1, boxAssetId: 'old-box' });
  });
  initializeCommerceInventory(harness, assignmentArgs(repository));
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [3, 2]);
  assert.deepEqual(await assignCommerceDudes(assignmentArgs(repository)), { dudeIds: [3], outcome: 'created' });
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [2]);
  assert.deepEqual((await repository.get(commerceKeys.dudePool('drop')))?.data.available, [3, 1, 2, 3, 0]);
});

test('commerce assignment rejects changed registry configuration', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  initializeCommerceInventory(harness, assignmentArgs(repository));
  await assert.rejects(assignCommerceDudes({ ...assignmentArgs(repository), maxDudeId: 4 }), CommerceRepositoryError);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [1, 2, 3]);
});

test('disjoint concurrent assignments do not conflict on shared inventory', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  initializeCommerceInventory(harness, assignmentArgs(repository));
  let sleeps = 0;
  const shared = { ...assignmentArgs(repository), sleep: async () => { sleeps += 1; } };
  const results = await Promise.all([
    assignCommerceDudes(shared),
    assignCommerceDudes({ ...shared, boxAssetId: 'other-box', randomInt: (maximum) => maximum - 1 }),
  ]);
  assert.deepEqual(results.map((result) => result.dudeIds), [[1], [3]]);
  assert.equal(sleeps, 0);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [2]);
});

test('overlapping concurrent assignments retry without assigning the same figure twice', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  initializeCommerceInventory(harness, assignmentArgs(repository));
  let sleeps = 0;
  const shared = { ...assignmentArgs(repository), sleep: async () => { sleeps += 1; } };
  const results = await Promise.all([
    assignCommerceDudes(shared),
    assignCommerceDudes({ ...shared, boxAssetId: 'other-box' }),
  ]);
  assert.deepEqual(results.map((result) => result.dudeIds).sort(), [[1], [2]]);
  assert.equal(sleeps, 1);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [3]);
});

test('concurrent retries for one box consume inventory once', async () => {
  const harness = createCommerceD1Harness();
  const repository = new D1CommerceRepository(harness.db);
  initializeCommerceInventory(harness, assignmentArgs(repository));
  const results = await Promise.all([
    assignCommerceDudes(assignmentArgs(repository)),
    assignCommerceDudes(assignmentArgs(repository)),
  ]);
  assert.deepEqual(results.map((result) => result.dudeIds), [[1], [1]]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['created', 'existing']);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [2, 3]);
});

test('failed assignment batches roll back consumed inventory and every document', async () => {
  let rejectWrites = false;
  const harness = createCommerceD1Harness({
    observeStatement: (statement) => {
      if (rejectWrites && statement.sql.includes('INSERT INTO commerce_documents')) throw new Error('injected storage failure');
    },
  });
  const repository = new D1CommerceRepository(harness.db);
  const args = { ...assignmentArgs(repository), itemsPerBox: 2 };
  initializeCommerceInventory(harness, args);
  rejectWrites = true;
  await assert.rejects(assignCommerceDudes(args), /injected storage failure/);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [1, 2, 3]);
  assert.equal(await repository.get(commerceKeys.boxAssignment('drop', 'box')), null);
  assert.deepEqual(await repository.query({ kind: 'dude_assignment' }), []);
});

test('native card inventory preserves rarity selection and depleted-bucket fallbacks', async () => {
  const rare = CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS[0];
  const [common, anotherCommon] = CARD_NFT_2_COMMON_CARD_IDS;
  let neither = 1;
  while (CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(neither) || CARD_NFT_2_COMMON_CARD_ID_SET.has(neither)) {
    neither += 1;
  }
  for (const pool of [[common, rare, neither], [common, anotherCommon, neither]]) {
    const harness = createCommerceD1Harness();
    const repository = new D1CommerceRepository(harness.db);
    const args = {
      ...assignmentArgs(repository), dropFamily: 'card_nft_2', itemsPerBox: 3, maxDudeId: CARD_NFT_2_MAX_CARD_ID,
    };
    initializeCommerceInventory(harness, { ...args, available: pool });
    const result = await assignCommerceDudes(args);
    assert.deepEqual([...result.dudeIds].sort((left, right) => left - right), [...pool].sort((left, right) => left - right));
    assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), []);
  }
});
