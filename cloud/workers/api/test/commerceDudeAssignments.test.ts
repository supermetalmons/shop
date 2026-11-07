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

for (const timing of ['before', 'after'] as const) {
  test(`same-box sell-out ${timing} the inventory snapshot returns the winning assignment`, async (t) => {
    const harness = createCommerceD1Harness();
    t.after(() => harness.database.close());
    const repository = new D1CommerceRepository(harness.db);
    const competitor = new D1CommerceRepository(harness.db);
    const args = { ...assignmentArgs(repository), maxDudeId: 1 };
    initializeCommerceInventory(harness, args);
    let inventoryLoads = 0;
    let sleeps = 0;
    const compete = async () => {
      assert.deepEqual(await assignCommerceDudes({ ...args, repository: competitor }),
        { dudeIds: [1], outcome: 'created' });
    };
    const load = repository.getDudeInventory.bind(repository);
    t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
      if (++inventoryLoads !== 1) return load(...parameters);
      if (timing === 'before') await compete();
      const inventory = await load(...parameters);
      if (timing === 'after') await compete();
      return inventory;
    });

    const result = await assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } });

    assert.deepEqual(result, { dudeIds: [1], outcome: 'existing' });
    assert.equal(inventoryLoads, 1);
    assert.equal(sleeps, 1);
    assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), []);
    assert.equal((await competitor.get(commerceKeys.dudeAssignment('drop', '1')))?.data.boxAssetId, 'box');
  });
}

test('same-box sell-out after the snapshot returns the complete winning assignment', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const competitor = new D1CommerceRepository(harness.db);
  const args = { ...assignmentArgs(repository), itemsPerBox: 2, maxDudeId: 2 };
  initializeCommerceInventory(harness, args);
  let inventoryLoads = 0;
  let sleeps = 0;
  const load = repository.getDudeInventory.bind(repository);
  t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
    const inventory = await load(...parameters);
    if (++inventoryLoads === 1) {
      assert.deepEqual(await assignCommerceDudes({ ...args, repository: competitor }),
        { dudeIds: [1, 2], outcome: 'created' });
    }
    return inventory;
  });

  const result = await assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } });

  assert.deepEqual(result, { dudeIds: [1, 2], outcome: 'existing' });
  assert.equal(inventoryLoads, 1);
  assert.equal(sleeps, 1);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), []);
  for (const id of [1, 2]) {
    assert.equal((await competitor.get(commerceKeys.dudeAssignment('drop', String(id))))?.data.boxAssetId, 'box');
  }
});

test('another box selling out a snapshot retries once before reporting exhaustion', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const competitor = new D1CommerceRepository(harness.db);
  const args = { ...assignmentArgs(repository), maxDudeId: 1 };
  initializeCommerceInventory(harness, args);
  let inventoryLoads = 0;
  let sleeps = 0;
  const load = repository.getDudeInventory.bind(repository);
  t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
    const inventory = await load(...parameters);
    if (++inventoryLoads === 1) {
      assert.deepEqual(await assignCommerceDudes({ ...args, repository: competitor, boxAssetId: 'other-box' }),
        { dudeIds: [1], outcome: 'created' });
    }
    return inventory;
  });

  await assert.rejects(assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } }),
    (error: unknown) => error instanceof CommerceDudeAssignmentError && error.code === 'pool-exhausted');

  assert.equal(inventoryLoads, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), []);
  assert.equal(await competitor.get(commerceKeys.boxAssignment('drop', 'box')), null);
  assert.equal((await competitor.get(commerceKeys.dudeAssignment('drop', '1')))?.data.boxAssetId, 'other-box');
});

for (const timing of ['before', 'during'] as const) {
  test(`cancellation ${timing} the exhausted-assignment recheck preserves its reason`, async (t) => {
    const harness = createCommerceD1Harness();
    t.after(() => harness.database.close());
    const repository = new D1CommerceRepository(harness.db);
    const controller = new AbortController();
    const reason = new Error('assignment recheck cancelled');
    const args = { ...assignmentArgs(repository), signal: controller.signal };
    initializeCommerceInventory(harness, { ...args, available: [] });
    const load = repository.getDudeInventory.bind(repository);
    t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
      const inventory = await load(...parameters);
      if (timing === 'before') controller.abort(reason);
      return inventory;
    });
    const get = repository.get.bind(repository);
    let rechecks = 0;
    let sleeps = 0;
    t.mock.method(repository, 'get', async (...parameters: Parameters<typeof get>) => {
      rechecks += 1;
      const assignment = await get(...parameters);
      controller.abort(reason);
      return assignment;
    });

    await assert.rejects(assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } }),
      (error: unknown) => error === reason);

    assert.equal(rechecks, timing === 'before' ? 0 : 1);
    assert.equal(sleeps, 0);
    assert.equal(await get(commerceKeys.boxAssignment('drop', 'box')), null);
  });
}

test('an exhausted-assignment recheck failure propagates without retries', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const args = assignmentArgs(repository);
  initializeCommerceInventory(harness, { ...args, available: [] });
  const failure = new CommerceRepositoryError('unavailable', 'Assignment recheck unavailable.');
  let sleeps = 0;
  t.mock.method(repository, 'get', async () => { throw failure; });

  await assert.rejects(assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } }),
    (error: unknown) => error === failure);

  assert.equal(sleeps, 0);
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
  assert.deepEqual(harness.database.prepare(
    "SELECT document_path FROM commerce_documents WHERE document_kind = 'dude_assignment'",
  ).all(), []);
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

test('compact inventory snapshots preserve array picker results and random calls across rarity fallbacks', async (t) => {
  const { pickDudeIdsForAssignment } = await import('../../../../shared/assignDudesPicker.ts');
  const rare = CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS.slice(0, 4);
  const common = CARD_NFT_2_COMMON_CARD_IDS.slice(0, 4);
  const neither: number[] = [];
  for (let id = 1; neither.length < 4; id += 1) {
    if (!CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(id) && !CARD_NFT_2_COMMON_CARD_ID_SET.has(id)) neither.push(id);
  }
  const cases = [
    { family: 'card_nft_2', pool: [common[0], rare[0], neither[1], rare[1], common[1], neither[0]] },
    { family: 'card_nft_2', pool: [...common, ...neither] },
    { family: 'card_nft_2', pool: [...rare, ...neither] },
    { family: 'card_nft_2', pool: [...rare, ...common] },
    { family: 'card_nft_2', pool: rare },
    { family: 'clear_cards', pool: [7, 2, 9, 1, 4] },
  ];
  for (const { family, pool } of cases) {
    for (const fractions of [[0], [0.999], [0.7, 0.1, 0.6, 0.4]]) {
      let countQueries = 0;
      const harness = createCommerceD1Harness({ observeStatement: ({ sql }) => {
        if (sql.includes('COUNT(*) AS available_count')) countQueries += 1;
      } });
      t.after(() => harness.database.close());
      const repository = new D1CommerceRepository(harness.db);
      const args = { ...assignmentArgs(repository), dropFamily: family, itemsPerBox: 3, maxDudeId: CARD_NFT_2_MAX_CARD_ID };
      initializeCommerceInventory(harness, { ...args, available: pool });
      const actualCalls: number[] = [];
      const expectedCalls: number[] = [];
      const rng = (calls: number[]) => (maximum: number) => {
        const fraction = fractions[calls.length % fractions.length];
        calls.push(maximum);
        return Math.floor(fraction * maximum);
      };
      const expected = await pickDudeIdsForAssignment({ ...args, pool: [...pool], isAssigned: () => false, randomInt: rng(expectedCalls) });
      const actual = await assignCommerceDudes({ ...args, randomInt: rng(actualCalls) });
      assert.deepEqual(actual.dudeIds, expected.chosen, `${family}: ${pool}`);
      assert.deepEqual(actualCalls, expectedCalls);
      assert.equal(countQueries, 1, `${family}: assignment must read a single inventory snapshot`);
    }
  }
});

test('compact inventory snapshots return one pool row and need no additional picker reads', async (t) => {
  const { pickDudeIdsForAssignment } = await import('../../../../shared/assignDudesPicker.ts');
  const responseSizes: number[] = [];
  for (const size of [100, 10_000]) {
    const harness = createCommerceD1Harness();
    t.after(() => harness.database.close());
    let rowsReturned = 0;
    const db = new Proxy(harness.db, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          for (const result of results) {
            assert.ok(result.results.length <= 1);
            rowsReturned += result.results.length;
          }
          return results;
        };
        return Reflect.get(target, property, target);
      },
    });
    const repository = new D1CommerceRepository(db);
    const args = { ...assignmentArgs(repository), itemsPerBox: 2, maxDudeId: size };
    initializeCommerceInventory(harness, args);
    const inventory = await repository.getDudeInventory(args);
    const picked = await pickDudeIdsForAssignment({ ...args, pool: inventory.pool,
      isAssigned: () => false, randomInt: (maximum) => maximum - 1 });
    assert.deepEqual(picked.chosen, [size, size - 1]);
    responseSizes.push(rowsReturned);
  }
  assert.deepEqual(responseSizes, [3, 3]);
});

test('multiple disjoint commits after the inventory snapshot do not restart an assignment', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const competitor = new D1CommerceRepository(harness.db);
  const args = { ...assignmentArgs(repository), itemsPerBox: 2, maxDudeId: 6 };
  initializeCommerceInventory(harness, args);
  let sleeps = 0;
  let inventoryLoads = 0;
  const competingAssignments: number[][] = [];
  const compete = async (boxAssetId: string) => {
    const result = await assignCommerceDudes({ ...args, repository: competitor, boxAssetId,
      randomInt: (maximum) => maximum - 1, sleep: async () => { sleeps += 1; } });
    competingAssignments.push(result.dudeIds);
  };
  const load = repository.getDudeInventory.bind(repository);
  t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
    const inventory = await load(...parameters);
    if (++inventoryLoads === 1) {
      await compete('first-competitor');
      await compete('second-competitor');
    }
    return inventory;
  });
  const result = await assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } });
  assert.deepEqual(result, { dudeIds: [1, 2], outcome: 'created' });
  assert.deepEqual(competingAssignments, [[6, 5], [4, 3]]);
  assert.equal(inventoryLoads, 1);
  assert.equal(sleeps, 0);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), []);
});

test('a selected snapshot figure consumed by another box retries the assignment', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const competitor = new D1CommerceRepository(harness.db);
  const args = assignmentArgs(repository);
  initializeCommerceInventory(harness, args);
  let inventoryLoads = 0;
  let sleeps = 0;
  const bounds: number[] = [];
  const load = repository.getDudeInventory.bind(repository);
  t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
    const inventory = await load(...parameters);
    if (++inventoryLoads === 1) {
      assert.deepEqual(await assignCommerceDudes({ ...args, repository: competitor, boxAssetId: 'highest',
        randomInt: (maximum) => maximum - 1 }), { dudeIds: [3], outcome: 'created' });
    }
    return inventory;
  });
  const result = await assignCommerceDudes({ ...args,
    randomInt: (maximum) => { bounds.push(maximum); return maximum - 1; },
    sleep: async () => { sleeps += 1; },
  });
  assert.deepEqual(result, { dudeIds: [2], outcome: 'created' });
  assert.deepEqual(bounds, [3, 2]);
  assert.equal(inventoryLoads, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [1]);
});

test('a consumed rare snapshot figure retries and then preserves depleted-bucket fallback', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const competitor = new D1CommerceRepository(harness.db);
  const rare = CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_IDS[0];
  const common = CARD_NFT_2_COMMON_CARD_IDS.slice(0, 4);
  let neither = 1;
  while (CARD_NFT_2_AS_GOOD_AS_SUPER_RARE_CARD_ID_SET.has(neither) || CARD_NFT_2_COMMON_CARD_ID_SET.has(neither)) neither += 1;
  const args = { ...assignmentArgs(repository), dropFamily: 'card_nft_2', itemsPerBox: 3, maxDudeId: CARD_NFT_2_MAX_CARD_ID };
  initializeCommerceInventory(harness, { ...args, available: [rare, ...common, neither] });
  let inventoryLoads = 0;
  let sleeps = 0;
  const load = repository.getDudeInventory.bind(repository);
  t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
    const inventory = await load(...parameters);
    if (++inventoryLoads === 1) {
      assert.deepEqual(await assignCommerceDudes({ ...args, repository: competitor, boxAssetId: 'last-rare',
        randomInt: (maximum) => maximum - 1 }), { dudeIds: [rare, common[3], neither], outcome: 'created' });
    }
    return inventory;
  });
  const result = await assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } });
  assert.equal(result.outcome, 'created');
  assert.deepEqual([...result.dudeIds].sort((left, right) => left - right), [...common.slice(0, 3)].sort((left, right) => left - right));
  assert.equal(inventoryLoads, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), []);
});

test('cancellation after an inventory snapshot prevents assignment reads and writes', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const controller = new AbortController();
  const reason = new Error('assignment cancelled after its inventory snapshot');
  let snapshotLoaded = false;
  let subsequentBatches = 0;
  const db = new Proxy(harness.db, {
    get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (snapshotLoaded) subsequentBatches += 1;
        return target.batch(statements);
      };
      return Reflect.get(target, property, target);
    },
  });
  const repository = new D1CommerceRepository(db);
  const args = assignmentArgs(repository);
  initializeCommerceInventory(harness, args);
  const load = repository.getDudeInventory.bind(repository);
  t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
    const inventory = await load(...parameters);
    snapshotLoaded = true;
    controller.abort(reason);
    return inventory;
  });
  let sleeps = 0;

  await assert.rejects(assignCommerceDudes({ ...args, signal: controller.signal,
    sleep: async () => { sleeps += 1; },
  }), (error) => error === reason);

  assert.equal(subsequentBatches, 0);
  assert.equal(sleeps, 0);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [1, 2, 3]);
  assert.equal(await new D1CommerceRepository(harness.db).get(commerceKeys.boxAssignment('drop', 'box')), null);
});

test('a competitor consuming multiple snapshot figures triggers one transaction retry', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const competitor = new D1CommerceRepository(harness.db);
  const args = { ...assignmentArgs(repository), itemsPerBox: 2, maxDudeId: 5 };
  initializeCommerceInventory(harness, args);
  let inventoryLoads = 0;
  let sleeps = 0;
  const load = repository.getDudeInventory.bind(repository);
  t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
    const inventory = await load(...parameters);
    if (++inventoryLoads === 1) {
      assert.deepEqual(await assignCommerceDudes({ ...args, repository: competitor, boxAssetId: 'other-box' }),
        { dudeIds: [1, 2], outcome: 'created' });
    }
    return inventory;
  });
  const result = await assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } });
  assert.deepEqual(result, { dudeIds: [3, 4], outcome: 'created' });
  assert.equal(inventoryLoads, 2);
  assert.equal(sleeps, 1);
  for (const id of [1, 2, 3, 4]) {
    assert.equal((await competitor.get(commerceKeys.dudeAssignment('drop', String(id))))?.data.boxAssetId,
      id <= 2 ? 'other-box' : 'box');
  }
  assert.deepEqual((await competitor.get(commerceKeys.boxAssignment('drop', 'other-box')))?.data.dudeIds, [1, 2]);
  assert.deepEqual((await competitor.get(commerceKeys.boxAssignment('drop', 'box')))?.data.dudeIds, [3, 4]);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [5]);
});

test('a changed inventory generation rejects the stale snapshot at commit and retries', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const args = assignmentArgs(repository);
  initializeCommerceInventory(harness, args);
  const generation = '00000000-0000-4000-8000-000000000777';
  let inventoryLoads = 0;
  let sleeps = 0;
  const load = repository.getDudeInventory.bind(repository);
  t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
    const inventory = await load(...parameters);
    if (++inventoryLoads === 1) {
      const trigger = harness.database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'commerce_inventory_drop_update_guard'").get()!;
      harness.database.exec('DROP TRIGGER commerce_inventory_drop_update_guard');
      try {
        harness.database.prepare('UPDATE commerce_inventory_drops SET generation = ? WHERE drop_id = ?').run(generation, args.dropId);
      } finally {
        harness.database.exec(String(trigger.sql));
      }
    }
    return inventory;
  });

  const result = await assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } });

  assert.deepEqual(result, { dudeIds: [1], outcome: 'created' });
  assert.equal(inventoryLoads, 2);
  assert.equal(sleeps, 1);
  assert.equal((await repository.get(commerceKeys.dudeAssignment('drop', '1')))?.data.inventoryGeneration, generation);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [2, 3]);
});

test('paused authority prevents committing an already loaded inventory snapshot', async (t) => {
  const harness = createCommerceD1Harness();
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const args = assignmentArgs(repository);
  initializeCommerceInventory(harness, args);
  const load = repository.getDudeInventory.bind(repository);
  t.mock.method(repository, 'getDudeInventory', async (...parameters: Parameters<typeof load>) => {
    const inventory = await load(...parameters);
    const now = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
    harness.database.exec(`INSERT INTO commerce_authority_control_lease
      VALUES (1, '00000000-0000-4000-8000-000000000778', ${now}, ${now} + 60000);
      UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
        paused_at_ms = NULL, updated_at_ms = ${now} WHERE singleton = 1`);
    return inventory;
  });
  let sleeps = 0;

  await assert.rejects(assignCommerceDudes({ ...args, sleep: async () => { sleeps += 1; } }),
    (error: unknown) => error instanceof CommerceRepositoryError && error.code === 'unavailable');

  assert.equal(sleeps, 0);
  assert.deepEqual(availableCommerceDudeIds(harness, 'drop'), [1, 2, 3]);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_documents').get()!.count, 0);
});
