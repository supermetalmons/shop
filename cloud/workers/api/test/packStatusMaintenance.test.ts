import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  assertD1Integrity,
  buildD1SummaryRebuildSql,
  type D1IntegrityInput,
} from '../../../../scripts/shared/d1PackStatusMaintenance.ts';
import {
  parseArgs as parseRebuildArgs,
  rebuildPackStatusCounters,
  requireSettledPackStatusProjectionOutboxes,
} from '../../../../scripts/ops/rebuildPackStatus.ts';
import type { CommerceD1Document } from '../../../../scripts/shared/commerceD1Maintenance.ts';
import type { PackStatusCounters } from '../../../../shared/packStatus.ts';

const dropRows = [
  ['card_nft_2', 100, 300, 3],
  ['little_swag_boxes', 50, 150, 3],
  ['poncho_drifella', 140, 420, 3],
] as const;

const packStatusMigrationPaths = [
  'cloud/workers/api/migrations/0001_current_schema.sql',
  'cloud/workers/api/migrations/0002_pack_status_event_conflict_guard.sql',
  'cloud/workers/api/migrations/0003_pack_status_historical_replay.sql',
] as const;

function createPackStatusDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const path of packStatusMigrationPaths) database.exec(readFileSync(path, 'utf8'));
  return database;
}

function databaseState(database: DatabaseSync) {
  return {
    summaries: database.prepare('SELECT * FROM pack_status ORDER BY drop_id').all(),
    events: database.prepare('SELECT * FROM pack_status_events ORDER BY drop_id, event_type, event_key').all(),
    metadata: database.prepare('SELECT * FROM pack_status_metadata').all(),
  };
}

function countersRow(counters: PackStatusCounters, nowMs: number) {
  return {
    drop_id: counters.dropId,
    version: 1,
    total_initial_supply: counters.totalInitialSupply,
    total_cards: counters.totalCards,
    cards_per_pack: counters.cardsPerPack,
    unsealed_online: counters.unsealedOnline,
    redeemed_irl_normal: counters.redeemedIrlNormal,
    redeemed_irl_stripe: counters.redeemedIrlStripe,
    redeemed_unsealed_cards: counters.redeemedUnsealedCards,
    rebuilt_at_ms: nowMs,
    updated_at_ms: nowMs,
  };
}

function applicationSchema(): Record<string, unknown>[] {
  const database = createPackStatusDatabase();
  try {
    return database.prepare(`SELECT name, type, tbl_name, sql
      FROM sqlite_schema
      WHERE
        name NOT LIKE 'sqlite_%' AND
        name NOT GLOB '_cf_*' AND
        name <> 'd1_migrations'
      ORDER BY name`).all().map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

function integrityInput(): D1IntegrityInput {
  return {
    migrations: packStatusMigrationPaths.map((path) => ({ name: path.split('/').at(-1) })),
    metadata: [{ singleton: 1, cache_generation: 8 }],
    summaries: dropRows.map(([dropId, totalInitialSupply, totalCards, cardsPerPack]) => ({
      drop_id: dropId,
      version: 1,
      total_initial_supply: totalInitialSupply,
      total_cards: totalCards,
      cards_per_pack: cardsPerPack,
      unsealed_online: 2,
      redeemed_irl_normal: 1,
      redeemed_irl_stripe: 2,
      redeemed_unsealed_cards: 1,
      rebuilt_at_ms: 100,
      updated_at_ms: 200,
    })),
    eventCounts: [
      { drop_id: 'card_nft_2', event_count: 700, historical_event_count: 699, applied_event_count: 1 },
      { drop_id: 'little_swag_boxes', event_count: 100, historical_event_count: 100, applied_event_count: 0 },
      { drop_id: 'poncho_drifella', event_count: 70, historical_event_count: 70, applied_event_count: 0 },
    ],
    schema: applicationSchema(),
    quickCheck: [{ quick_check: 'ok' }],
    foreignKeyCheck: [],
    invalidEvents: [],
  };
}

function commerceDocument(
  kind: 'box_assignment' | 'delivery_order',
  documentId: string,
  data: Record<string, unknown>,
): CommerceD1Document {
  const collection = kind === 'box_assignment' ? 'boxAssignments' : 'deliveryOrders';
  return {
    data,
    documentId,
    dropId: 'card_nft_2',
    kind,
    path: `drops/card_nft_2/${collection}/${documentId}`,
    version: 1,
    createTime: '2026-08-25T10:00:00.000000000Z',
    updateTime: '2026-08-25T10:00:00.000000001Z',
  };
}

test('D1 integrity requires valid metadata, exact supported summaries, guards, and event ownership', () => {
  const input = integrityInput();
  const report = assertD1Integrity(input);
  assert.equal(report.cacheGeneration, 8);
  assert.equal(report.drops.length, 3);
  assert.equal(report.eventCount, 870);
  assert.equal(report.drops.find((drop) => drop.dropId === 'card_nft_2')?.appliedEventCount, 1);

  for (const metadata of [
    [],
    [{ singleton: 1, cache_generation: 8 }, { singleton: 1, cache_generation: 9 }],
    [{ singleton: 2, cache_generation: 8 }],
    [{ singleton: 1, cache_generation: 0 }],
  ]) {
    assert.throws(() => assertD1Integrity({ ...input, metadata }), /metadata|cache_generation/);
  }
  assert.throws(() => assertD1Integrity({
    ...input,
    schema: input.schema.filter((row) => row.name !== 'pack_status_metadata'),
  }), /schema/);
  assert.throws(() => assertD1Integrity({
    ...input,
    eventCounts: [...input.eventCounts, {
      drop_id: 'unsupported',
      event_count: 1,
      historical_event_count: 1,
      applied_event_count: 0,
    }],
  }), /unsupported/);
  assert.throws(() => assertD1Integrity({
    ...input,
    eventCounts: input.eventCounts.map((row) => row.drop_id === 'card_nft_2'
      ? { ...row, applied_event_count: 2 }
      : row),
  }), /inconsistent/);
  assert.throws(() => assertD1Integrity({
    ...input,
    quickCheck: [{ quick_check: 'corrupt' }],
  }), /quick_check/);
  assert.throws(() => assertD1Integrity({
    ...input,
    foreignKeyCheck: [{ table: 'pack_status_events', rowid: 1 }],
  }), /foreign_key_check/);
  assert.throws(() => assertD1Integrity({
    ...input,
    invalidEvents: [{ drop_id: 'card_nft_2', event_type: 'onlineReveal', event_key: 'bad' }],
  }), /invalid pack-status event payloads/);
});

test('D1 integrity rejects an incomplete migration ledger and drifted trigger SQL', () => {
  const input = integrityInput();
  assert.throws(() => assertD1Integrity({
    ...input,
    migrations: input.migrations.filter((row) => row.name !== '0003_pack_status_historical_replay.sql'),
  }), /migrations/);
  assert.throws(() => assertD1Integrity({
    ...input,
    schema: input.schema.map((row) => row.name === 'pack_status_event_conflict_guard'
      ? { ...row, sql: String(row.sql).replace('payload conflict', 'payload drift') }
      : row),
  }), /schema/);
  assert.throws(() => assertD1Integrity({
    ...input,
    schema: input.schema.map((row) => row.name === 'pack_status_event_conflict_guard'
      ? { ...row, sql: String(row.sql).replace('payload conflict', 'payload  conflict') }
      : row),
  }), /schema/);
});

test('authoritative rebuild inserts and updates one summary while preserving other drops and events', (t) => {
  const database = createPackStatusDatabase();
  t.after(() => database.close());
  const counters: PackStatusCounters = {
    dropId: 'card_nft_2',
    totalInitialSupply: 10,
    totalCards: 30,
    cardsPerPack: 3,
    unsealedOnline: 2,
    redeemedIrlNormal: 1,
    redeemedIrlStripe: 2,
    redeemedUnsealedCards: 1,
  };
  database.exec(buildD1SummaryRebuildSql(counters, 500));
  assert.deepEqual(databaseState(database).summaries.map((row) => ({ ...row })), [countersRow(counters, 500)]);
  assert.deepEqual({ ...databaseState(database).metadata[0] }, { singleton: 1, cache_generation: 2, updated_at_ms: 500 });

  database.exec(buildD1SummaryRebuildSql({ ...counters, dropId: 'little_swag_boxes' }, 510));
  database.prepare(`INSERT INTO pack_status_events (
    drop_id, event_type, event_key, quantity, unsealed_online_delta, apply_delta, created_at_ms
  ) VALUES (?, 'onlineReveal', 'historical-box', 1, 1, 0, 520)`).run('card_nft_2');
  const before = databaseState(database);
  const updated = { ...counters, totalInitialSupply: 20, totalCards: 60, unsealedOnline: 4 };
  database.exec(buildD1SummaryRebuildSql(updated, 600));
  const after = databaseState(database);
  assert.deepEqual({ ...after.summaries[0] }, countersRow(updated, 600));
  assert.deepEqual(after.summaries[1], before.summaries[1]);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual({ ...after.metadata[0] }, { singleton: 1, cache_generation: 4, updated_at_ms: 600 });
  assert.throws(() => buildD1SummaryRebuildSql({
    dropId: 'unsupported',
    totalInitialSupply: 1,
    totalCards: 3,
    cardsPerPack: 3,
    unsealedOnline: 0,
    redeemedIrlNormal: 0,
    redeemedIrlStripe: 0,
    redeemedUnsealedCards: 0,
  }, 500), /Unsupported/);
});

test('all-drop authoritative rebuild preserves events and rejects stale event counts without changing state', (t) => {
  const database = createPackStatusDatabase();
  t.after(() => database.close());
  const counters = dropRows.map(([
    dropId,
    totalInitialSupply,
    totalCards,
    cardsPerPack,
  ]) => ({
    dropId,
    totalInitialSupply,
    totalCards,
    cardsPerPack,
    unsealedOnline: 0,
    redeemedIrlNormal: 0,
    redeemedIrlStripe: 0,
    redeemedUnsealedCards: 0,
  }));
  const expectedEvents = [
    { dropId: 'card_nft_2', eventCount: 3, historicalEventCount: 2, appliedEventCount: 1 },
    { dropId: 'little_swag_boxes', eventCount: 1, historicalEventCount: 1, appliedEventCount: 0 },
    { dropId: 'poncho_drifella', eventCount: 2, historicalEventCount: 1, appliedEventCount: 1 },
  ];
  database.exec(buildD1SummaryRebuildSql(counters, 100));
  const insertEvent = database.prepare(`INSERT INTO pack_status_events (
    drop_id, event_type, event_key, quantity, unsealed_online_delta, apply_delta, created_at_ms
  ) VALUES (?, 'onlineReveal', ?, 1, 1, ?, 200)`);
  for (const expectation of expectedEvents) {
    for (let index = 0; index < expectation.eventCount; index += 1) {
      insertEvent.run(expectation.dropId, `box-${index}`, index < expectation.historicalEventCount ? 0 : 1);
    }
  }
  const before = databaseState(database);
  database.exec(buildD1SummaryRebuildSql(counters, 500, expectedEvents));
  const after = databaseState(database);
  assert.deepEqual(after.summaries.map((row) => ({ ...row })), counters.map((entry) => countersRow(entry, 500)));
  assert.deepEqual(after.events, before.events);
  assert.deepEqual({ ...after.metadata[0] }, { singleton: 1, cache_generation: 3, updated_at_ms: 500 });

  for (const staleCardCounts of [
    { eventCount: 2, historicalEventCount: 1, appliedEventCount: 1 },
    { eventCount: 3, historicalEventCount: 1, appliedEventCount: 2 },
  ]) {
    const staleEvents = expectedEvents.map((entry) => entry.dropId === 'card_nft_2'
      ? { ...entry, ...staleCardCounts }
      : entry);
    database.exec(buildD1SummaryRebuildSql(counters, 600, staleEvents));
    assert.deepEqual(databaseState(database), after);
  }
  assert.throws(() => buildD1SummaryRebuildSql([
    {
      dropId: 'card_nft_2',
      totalInitialSupply: 1,
      totalCards: 3,
      cardsPerPack: 3,
      unsealedOnline: 0,
      redeemedIrlNormal: 0,
      redeemedIrlStripe: 0,
      redeemedUnsealedCards: 0,
    },
    {
      dropId: 'card_nft_2',
      totalInitialSupply: 1,
      totalCards: 3,
      cardsPerPack: 3,
      unsealedOnline: 0,
      redeemedIrlNormal: 0,
      redeemedIrlStripe: 0,
      redeemedUnsealedCards: 0,
    },
  ], 500), /duplicate drop/);
});

test('rebuild CLI supports exact one-drop or all-drop D1 rebuilds', () => {
  assert.deepEqual(parseRebuildArgs([]), {
    dropIds: ['card_nft_2'],
    write: false,
    json: false,
  });
  assert.deepEqual(parseRebuildArgs(['--all', '--write']), {
    dropIds: ['card_nft_2', 'poncho_drifella', 'little_swag_boxes'],
    write: true,
    json: false,
  });
  assert.throws(() => parseRebuildArgs(['--all', '--drop-id', 'card_nft_2']), /mutually exclusive/);
});

test('authoritative rebuild rejects unsettled durable delivery projection outboxes', () => {
  assert.doesNotThrow(() => requireSettledPackStatusProjectionOutboxes([
    { status: 'ready_to_ship', packStatusProjectionState: 'completed' },
    { status: 'ready_to_ship' },
  ]));
  for (const state of ['pending', 'failed', 'unexpected']) {
    assert.throws(
      () => requireSettledPackStatusProjectionOutboxes([
        { status: 'ready_to_ship', packStatusProjectionState: state },
      ]),
      /outbox to be settled/,
    );
  }
});

test('authoritative rebuild derives assignment and delivery counters from Commerce D1 documents', () => {
  const result = rebuildPackStatusCounters({
    dropId: 'card_nft_2',
    cluster: 'mainnet-beta',
    itemsPerBox: 3,
    maxSupply: 10,
  }, {
    assignments: [
      commerceDocument('box_assignment', 'normal-box', {}),
      commerceDocument('box_assignment', 'irl-box', { irlClaim: { namespace: 'irl_v2' } }),
      commerceDocument('box_assignment', 'revealed-box', {}),
    ],
    deliveryOrders: [
      commerceDocument('delivery_order', '1', {
        status: 'processing',
        items: [{ assetId: 'normal-box', kind: 'box' }],
        packStatusProjectionState: 'completed',
      }),
      commerceDocument('delivery_order', '2', {
        status: 'ready_to_ship',
        source: 'admin_irl_redeem',
        items: [{ assetId: 'admin-receipt', kind: 'box' }],
        packStatusProjectionState: 'completed',
      }),
      commerceDocument('delivery_order', '3', {
        status: 'ready_to_ship',
        items: [{ assetId: 'irl-box', kind: 'box' }],
        packStatusProjectionState: 'completed',
      }),
    ],
  });
  assert.deepEqual(result.historicalAssignmentCounts, {
    boxAssignments: 3,
    irlClaimAssignments: 1,
    adminIrlAssignments: 1,
    inFlightNormalAssignments: 1,
  });
  assert.equal(result.counters.unsealedOnline, 0);
  assert.equal(result.counters.redeemedIrlNormal, 2);
});
