import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  CommerceRepositoryError, D1CommerceRepository, commerceKeys,
} from '../src/commerceRepository.ts';
import {
  createCommerceD1Harness, initializeCommerceInventory, seedCommerceDocument,
  type CommerceD1CallObservation, type CommerceD1Harness,
} from './commerceD1Harness.ts';
import { initializeNewInventoryDrop } from '../../../../scripts/shared/dudeInventoryMaintenance.ts';
import { sqlString } from '../../../../scripts/shared/commerceD1Maintenance.ts';
import { miNoteManifestFixture } from '../../../../tests/helpers/miNoteManifest.ts';

const NOW = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
const dense = { dropId: 'dense', dropFamily: 'clear_cards', itemsPerBox: 1, maxDudeId: 3 };

async function fixture(t: TestContext) {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  t.after(() => harness.database.close());
  const denseGeneration = initializeCommerceInventory(harness, dense);
  const source = miNoteManifestFixture();
  const manifest = await source.manifest();
  const args = {
    dropId: 'sparse', dropFamily: 'mi_note_cards', itemsPerBox: 2, maxDudeId: 1430,
    inventoryManifest: { sha256: manifest.sha256, cardIds: manifest.eligibleCardIds },
  };
  harness.database.exec(`INSERT INTO commerce_preorder_orders (
    order_id, preorder_id, cluster, collection, buyer, request_id, card_ids_json, assets_json,
    status, prepared_transaction, blockhash, blockhash_context_slot, last_valid_block_height,
    expires_at_ms, created_at_ms, updated_at_ms, next_check_at_ms, ethereum_address
  ) VALUES ('order', ${sqlString(source.config.preorderId)}, ${sqlString(source.config.cluster)},
    ${sqlString(source.config.collection)}, 'buyer', 'request', '[1,4]',
    ${sqlString(JSON.stringify(source.snapshot.orders[0].assets))}, 'prepared', 'prepared', 'blockhash', 1, 2,
    1000, 0, 0, 1000, '0x1111111111111111111111111111111111111111');
    INSERT INTO commerce_preorder_claims VALUES
      (${sqlString(source.config.cluster)}, ${sqlString(source.config.collection)}, 1, 'order'),
      (${sqlString(source.config.cluster)}, ${sqlString(source.config.collection)}, 4, 'order');
    UPDATE commerce_preorder_orders SET status = 'submitted', signed_transaction = 'signed', signature = 'signature', revision = revision + 1;
    UPDATE commerce_preorder_orders SET status = 'succeeded', revision = revision + 1;`);
  const leaseToken = randomUUID();
  const generation = randomUUID();
  harness.database.prepare(`INSERT INTO commerce_authority_control_lease
    VALUES (1, ?, ${NOW}, ${NOW} + 60000)`).run(leaseToken);
  try {
    await initializeNewInventoryDrop({
      query: (sql) => harness.database.prepare(sql).all().map((row) => ({ ...row })),
      config: args, manifest, leaseToken, generation,
      authorityRevision: Number(harness.database.prepare('SELECT revision FROM commerce_authority_control').get()!.revision),
    });
  } finally {
    harness.database.prepare('DELETE FROM commerce_authority_control_lease WHERE lease_token = ?').run(leaseToken);
  }
  return { harness, args, generation, denseGeneration, calls, repository: new D1CommerceRepository(harness.db) };
}

function assign(harness: CommerceD1Harness, dropId: string, generation: string, id: number): void {
  seedCommerceDocument(harness, {
    key: commerceKeys.dudeAssignment(dropId, String(id)),
    data: { dudeId: id, boxAssetId: `pack-${id}`, inventoryGeneration: generation },
  });
}

function corrupt(harness: CommerceD1Harness, sql: string): void {
  const triggers = harness.database.prepare(`SELECT name, sql FROM sqlite_schema
    WHERE type = 'trigger' AND tbl_name IN (
      'commerce_inventory_drops', 'commerce_inventory_initializations', 'commerce_available_dudes', 'commerce_documents'
    )`).all();
  for (const row of triggers) harness.database.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
  try { harness.database.exec(sql); } finally {
    for (const row of triggers) harness.database.exec(String(row.sql));
  }
}

function unavailable(error: unknown): boolean {
  assert.ok(error instanceof CommerceRepositoryError);
  assert.equal(error.code, 'unavailable');
  return true;
}

function repositoryWithInventoryRows(
  harness: CommerceD1Harness,
  change: (available: Record<string, unknown>[], assignments: Record<string, unknown>[]) => void,
): D1CommerceRepository {
  const db = new Proxy(harness.db, {
    get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        const results = await target.batch<Record<string, unknown>>(statements);
        change(results[2].results, results[4].results);
        return results;
      };
      return Reflect.get(target, property, target);
    },
  });
  return new D1CommerceRepository(db);
}

test('explicit inventory reads ordered available rows and assignments in one consistent D1 batch', async (t) => {
  const f = await fixture(t);
  const rowCounts: number[] = [];
  const inventory = await repositoryWithInventoryRows(f.harness, (available, assignments) => {
    rowCounts.push(available.length, assignments.length);
  }).getDudeInventory(f.args);
  assert.equal(inventory.generation, f.generation);
  assert.equal(inventory.pool.length, 4);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'batch');
  if (f.calls[0].method !== 'batch') assert.fail('expected an atomic D1 read');
  assert.equal(f.calls[0].statements.length, 5);
  assert.match(f.calls[0].statements[2].sql, /SELECT dude_id, pool_position/);
  assert.match(f.calls[0].statements[2].sql, /ORDER BY pool_position LIMIT 100001/);
  assert.match(f.calls[0].statements[3].sql, /commerce_inventory_initializations/);
  assert.match(f.calls[0].statements[4].sql, /dude_assignment/);
  assert.match(f.calls[0].statements[4].sql, /AS inventory_generation/);
  assert.match(f.calls[0].statements[4].sql, /LIMIT \?/);
  assert.deepEqual(rowCounts, [4, 0]);
  assert.deepEqual(inventory, { generation: f.generation, pool: [2, 3, 1401, 1430] });
});

test('available plus assigned cards conserve the manifest through ID 1430 and exhaustion', async (t) => {
  const f = await fixture(t);
  assign(f.harness, dense.dropId, f.denseGeneration, 1);
  for (const id of [2, 3, 1401]) assign(f.harness, f.args.dropId, f.generation, id);
  assert.deepEqual(await f.repository.getDudeInventory(f.args), { generation: f.generation, pool: [1430] });
  assign(f.harness, f.args.dropId, f.generation, 1430);
  assert.deepEqual(await f.repository.getDudeInventory(f.args), { generation: f.generation, pool: [] });
});

const authorizationCorruptions = [
  ['missing authorization', "DELETE FROM commerce_inventory_initializations WHERE drop_id = 'sparse'"],
  ['different manifest hash', `UPDATE commerce_inventory_initializations SET manifest_sha256 = '${'b'.repeat(64)}' WHERE drop_id = 'sparse'`],
  ['different generation', `UPDATE commerce_inventory_initializations SET generation = '${randomUUID()}' WHERE drop_id = 'sparse'`],
  ['changed eligible IDs', "UPDATE commerce_inventory_initializations SET eligible_card_ids_json = '[2,3,1401,1429]' WHERE drop_id = 'sparse'"],
  ['unfinished initialization', "UPDATE commerce_inventory_initializations SET completed_at_ms = NULL WHERE drop_id = 'sparse'"],
] as const;

for (const [label, sql] of authorizationCorruptions) {
  test(`explicit inventory fails closed with ${label}`, async (t) => {
    const f = await fixture(t);
    corrupt(f.harness, sql);
    await assert.rejects(f.repository.getDudeInventory(f.args), unavailable);
  });
}

for (const [label, sql] of [
  ['excluded available ID', "UPDATE commerce_available_dudes SET dude_id = 1 WHERE drop_id = 'sparse' AND dude_id = 2"],
  ['lost available card', "DELETE FROM commerce_available_dudes WHERE drop_id = 'sparse' AND dude_id = 1430"],
  ['incorrect pool position', "UPDATE commerce_available_dudes SET pool_position = 7 WHERE drop_id = 'sparse' AND dude_id = 1430"],
] as const) {
  test(`explicit inventory rejects ${label}`, async (t) => {
    const f = await fixture(t);
    corrupt(f.harness, sql);
    await assert.rejects(f.repository.getDudeInventory(f.args), unavailable);
  });
}

for (const [label, field, value] of [
  ['string available ID', 'dude_id', '2'],
  ['null available ID', 'dude_id', null],
  ['fractional available ID', 'dude_id', 2.5],
  ['missing available ID', 'dude_id', undefined],
  ['string pool position', 'pool_position', '0'],
  ['null pool position', 'pool_position', null],
  ['fractional pool position', 'pool_position', 0.5],
  ['negative pool position', 'pool_position', -1],
  ['missing pool position', 'pool_position', undefined],
] as const) {
  test(`explicit inventory rejects ${label} from its row response`, async (t) => {
    const f = await fixture(t);
    const repository = repositoryWithInventoryRows(f.harness, (available) => {
      available[0][field] = value;
    });

    await assert.rejects(repository.getDudeInventory(f.args), unavailable);
  });
}

for (const corruption of ['reversed order', 'duplicate ID', 'duplicate position'] as const) {
  test(`explicit inventory rejects available rows with ${corruption}`, async (t) => {
    const f = await fixture(t);
    const repository = repositoryWithInventoryRows(f.harness, (available) => {
      if (corruption === 'reversed order') available.reverse();
      else if (corruption === 'duplicate ID') available[1].dude_id = available[0].dude_id;
      else available[1].pool_position = available[0].pool_position;
    });

    await assert.rejects(repository.getDudeInventory(f.args), unavailable);
  });
}

for (const [label, sql] of [
  ['available and assigned overlap', "INSERT INTO commerce_available_dudes VALUES ('sparse', 1430, 3)"],
  ['lost assigned card', "DELETE FROM commerce_documents WHERE document_path = 'drops/sparse/dudeAssignments/1430'"],
  ['wrong assignment generation', `UPDATE commerce_documents SET document_json = json_set(document_json, '$.inventoryGeneration', '${randomUUID()}') WHERE document_path = 'drops/sparse/dudeAssignments/1430'`],
  ['noncanonical assignment identity', "UPDATE commerce_documents SET document_id = '01430' WHERE document_path = 'drops/sparse/dudeAssignments/1430'"],
  ['excluded assigned card', "UPDATE commerce_documents SET document_json = json_set(document_json, '$.dudeId', 1), document_id = '1' WHERE document_path = 'drops/sparse/dudeAssignments/1430'"],
] as const) {
  test(`explicit inventory rejects ${label}`, async (t) => {
    const f = await fixture(t);
    assign(f.harness, f.args.dropId, f.generation, 1430);
    corrupt(f.harness, sql);
    await assert.rejects(f.repository.getDudeInventory(f.args), unavailable);
  });
}

for (const [label, field, value] of [
  ['string assigned ID', 'dude_id', '1430'],
  ['null assigned ID', 'dude_id', null],
  ['fractional assigned ID', 'dude_id', 1430.5],
  ['missing assigned ID', 'dude_id', undefined],
  ['numeric assignment identity', 'document_id', 1430],
  ['missing assignment identity', 'document_id', undefined],
  ['null assignment generation', 'inventory_generation', null],
  ['missing assignment generation', 'inventory_generation', undefined],
] as const) {
  test(`explicit inventory rejects ${label} from its row response`, async (t) => {
    const f = await fixture(t);
    assign(f.harness, f.args.dropId, f.generation, 1430);
    const repository = repositoryWithInventoryRows(f.harness, (_available, assignments) => {
      assignments[0][field] = value;
    });

    await assert.rejects(repository.getDudeInventory(f.args), unavailable);
  });
}

for (const corruption of ['duplicate figure and identity', 'duplicate document identity', 'available overlap'] as const) {
  test(`explicit inventory rejects assigned rows with ${corruption}`, async (t) => {
    const f = await fixture(t);
    for (const id of [1401, 1430]) assign(f.harness, f.args.dropId, f.generation, id);
    const repository = repositoryWithInventoryRows(f.harness, (available, assignments) => {
      if (corruption === 'duplicate figure and identity') assignments[1] = { ...assignments[0] };
      else if (corruption === 'duplicate document identity') assignments[1].document_id = assignments[0].document_id;
      else {
        assignments[0].dude_id = available[0].dude_id;
        assignments[0].document_id = String(available[0].dude_id);
      }
    });

    await assert.rejects(repository.getDudeInventory(f.args), unavailable);
  });
}

test('explicit inventory rejects an assignment response larger than its manifest', async (t) => {
  const f = await fixture(t);
  for (const id of f.args.inventoryManifest.cardIds) assign(f.harness, f.args.dropId, f.generation, id);
  const repository = repositoryWithInventoryRows(f.harness, (_available, assignments) => {
    assignments.push({ ...assignments[0] });
  });

  await assert.rejects(repository.getDudeInventory(f.args), unavailable);
});

test('dense existing drops retain the three-query read and need no explicit authorization', async (t) => {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({ observeCall: (call) => calls.push(call) });
  t.after(() => harness.database.close());
  const generation = initializeCommerceInventory(harness, dense);
  const repository = new D1CommerceRepository(harness.db);
  assert.equal(harness.database.prepare('SELECT COUNT(*) AS count FROM commerce_inventory_initializations').get()!.count, 0);
  assert.deepEqual(await repository.getDudeInventory(dense), { generation, pool: [1, 2, 3] });
  assign(harness, dense.dropId, generation, 2);
  assert.deepEqual(await repository.getDudeInventory(dense), { generation, pool: [1, 3] });
  const summaries = calls.filter((call) => call.method === 'batch' &&
    call.statements.some(({ sql }) => sql.includes('COUNT(*) AS available_count')));
  assert.equal(summaries.length, 2);
  for (const call of summaries) {
    assert.equal(call.method, 'batch');
    if (call.method !== 'batch') assert.fail('expected a D1 read batch');
    assert.equal(call.statements.length, 3);
    assert.ok(call.statements.every(({ sql }) => !sql.includes('commerce_inventory_initializations')));
  }
});

test('an inventory snapshot keeps its ordered IDs when another assignment commits', async (t) => {
  const f = await fixture(t);
  const inventory = await f.repository.getDudeInventory(f.args);
  assign(f.harness, f.args.dropId, f.generation, 2);
  assert.deepEqual(inventory, { generation: f.generation, pool: [2, 3, 1401, 1430] });
  assert.deepEqual(await f.repository.getDudeInventory(f.args), { generation: f.generation, pool: [3, 1401, 1430] });
});

for (const timing of ['before', 'during'] as const) {
  test(`cancellation ${timing} the compact inventory read preserves its reason`, async (t) => {
    const harness = createCommerceD1Harness();
    t.after(() => harness.database.close());
    initializeCommerceInventory(harness, dense);
    const controller = new AbortController();
    const reason = new Error('inventory read cancelled');
    let batches = 0;
    const db = new Proxy(harness.db, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          batches += 1;
          const results = await target.batch(statements);
          controller.abort(reason);
          return results;
        };
        return Reflect.get(target, property, target);
      },
    });
    if (timing === 'before') controller.abort(reason);

    await assert.rejects(new D1CommerceRepository(db).getDudeInventory(dense, controller.signal),
      (error: unknown) => error === reason);

    assert.equal(batches, timing === 'before' ? 0 : 1);
  });
}

for (const size of [100_000, 100_001]) {
  test(`compact inventory ${size === 100_000 ? 'accepts its limit' : 'rejects overflow without truncating'}`, async (t) => {
    const statements: string[] = [];
    const harness = createCommerceD1Harness({ observeStatement: ({ sql }) => statements.push(sql) });
    t.after(() => harness.database.close());
    const config = { ...dense, maxDudeId: 100_001 };
    const generation = initializeCommerceInventory(harness, { ...config, available: [1] });
    const pool = Array.from({ length: size }, (_, index) => index + 1);
    const db = new Proxy(harness.db, {
      get(target, property) {
        if (property === 'batch') return async (prepared: D1PreparedStatement[]) => {
          const results = await target.batch(prepared);
          results[2].results = [{ available_ids_json: JSON.stringify(pool), available_count: size, invalid_count: 0 }];
          return results;
        };
        return Reflect.get(target, property, target);
      },
    });
    const snapshot = new D1CommerceRepository(db).getDudeInventory(config);

    if (size === 100_000) assert.deepEqual(await snapshot, { generation, pool });
    else await assert.rejects(snapshot, unavailable);

    const aggregate = statements.filter((sql) => sql.includes('json_group_array'));
    assert.equal(aggregate.length, 1);
    assert.match(aggregate[0], /ORDER BY pool_position LIMIT 100001/);
  });
}

for (const [label, json, count] of [
  ['string ID', '["1"]', 1],
  ['fractional ID', '[1.5]', 1],
  ['zero ID', '[0]', 1],
  ['out-of-range ID', '[4]', 1],
  ['unsafe integer ID', '[9007199254740992]', 1],
  ['null ID', '[null]', 1],
  ['non-array JSON', '{"id":1}', 1],
  ['malformed JSON', '[1', 1],
  ['inconsistent count', '[1,2]', 1],
] as const) {
  test(`compact inventory rejects ${label}`, async (t) => {
    const harness = createCommerceD1Harness();
    t.after(() => harness.database.close());
    initializeCommerceInventory(harness, dense);
    const db = new Proxy(harness.db, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          results[2].results = [{ available_ids_json: json, available_count: count, invalid_count: 0 }];
          return results;
        };
        return Reflect.get(target, property, target);
      },
    });

    await assert.rejects(new D1CommerceRepository(db).getDudeInventory(dense), unavailable);
  });
}
