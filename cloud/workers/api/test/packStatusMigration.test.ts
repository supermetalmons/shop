import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertD1Integrity,
  buildD1SummaryRebuildSql,
  parseArgs,
  parseBookmarkOutput,
  type D1IntegrityInput,
} from '../../../../scripts/migrate-pack-status-to-d1.ts';
import {
  parseArgs as parseRebuildArgs,
  requireSettledPackStatusProjectionOutboxes,
} from '../../../../scripts/ops/rebuildPackStatus.ts';

const dropRows = [
  ['card_nft_2', 100, 300, 3],
  ['little_swag_boxes', 50, 150, 3],
  ['poncho_drifella', 140, 420, 3],
] as const;

function integrityInput(): D1IntegrityInput {
  return {
    rollout: [{ singleton: 1, read_source: 'd1', cache_generation: 8 }],
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
    schema: [
      { name: 'pack_status', type: 'table' },
      { name: 'pack_status_events', type: 'table' },
      { name: 'pack_status_rollout', type: 'table' },
      { name: 'pack_status_event_apply', type: 'trigger' },
      { name: 'pack_status_event_delete_guard', type: 'trigger' },
      { name: 'pack_status_event_immutable', type: 'trigger' },
      { name: 'pack_status_event_type_guard', type: 'trigger' },
      { name: 'pack_status_rollout_d1_only_insert_guard', type: 'trigger' },
      { name: 'pack_status_rollout_d1_only_update_guard', type: 'trigger' },
    ],
    migrations: [
      { name: '0001_pack_status.sql' },
      { name: '0002_pack_status_event_type_guard.sql' },
      { name: '0003_pack_status_d1_only.sql' },
    ],
    quickCheck: [{ quick_check: 'ok' }],
    foreignKeyCheck: [],
    invalidEvents: [],
  };
}

test('D1-only pack-status commands reject reversible migration operations', () => {
  assert.deepEqual(parseArgs(['integrity']), { command: 'integrity' });
  assert.deepEqual(parseArgs(['probe']), { command: 'probe' });
  assert.deepEqual(parseArgs(['bookmark']), { command: 'bookmark' });
  for (const command of ['backfill', 'verify', 'cutover', 'rollback']) {
    assert.throws(() => parseArgs([command]), /Usage/);
  }
  assert.throws(() => parseArgs(['integrity', '--unknown']), /Usage/);
});

test('D1 integrity requires exact supported summaries, migrations, guards, and event ownership', () => {
  const input = integrityInput();
  const report = assertD1Integrity(input);
  assert.equal(report.cacheGeneration, 8);
  assert.equal(report.drops.length, 3);
  assert.equal(report.eventCount, 870);
  assert.equal(report.drops.find((drop) => drop.dropId === 'card_nft_2')?.appliedEventCount, 1);

  assert.throws(() => assertD1Integrity({
    ...input,
    rollout: [{ singleton: 1, read_source: 'firestore', cache_generation: 8 }],
  }), /locked to D1/);
  assert.throws(() => assertD1Integrity({
    ...input,
    migrations: input.migrations.slice(0, 2),
  }), /migrations/);
  assert.throws(() => assertD1Integrity({
    ...input,
    schema: input.schema.filter((row) => row.name !== 'pack_status_rollout_d1_only_update_guard'),
  }), /update_guard/);
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
    foreignKeyCheck: [{ table: 'pack_status_events', rowid: 1 }],
  }), /foreign_key_check/);
  assert.throws(() => assertD1Integrity({
    ...input,
    invalidEvents: [{ drop_id: 'card_nft_2', event_type: 'onlineReveal', event_key: 'bad' }],
  }), /invalid pack-status event payloads/);
});

test('authoritative rebuild SQL updates only one allowlisted D1 summary and cache generation', () => {
  const sql = buildD1SummaryRebuildSql({
    dropId: 'card_nft_2',
    totalInitialSupply: 10,
    totalCards: 30,
    cardsPerPack: 3,
    unsealedOnline: 2,
    redeemedIrlNormal: 1,
    redeemedIrlStripe: 2,
    redeemedUnsealedCards: 1,
  }, 500);
  assert.match(sql, /INSERT INTO pack_status/);
  assert.match(sql, /ON CONFLICT\(drop_id\) DO UPDATE SET/);
  assert.match(sql, /UPDATE pack_status_rollout/);
  assert.match(sql, /cache_generation = cache_generation \+ 1/);
  assert.doesNotMatch(sql, /pack_status_events/);
  assert.doesNotMatch(sql, /firestore/i);
  assert.equal((sql.match(/total_initial_supply = excluded\.total_initial_supply/g) || []).length, 1);
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

test('all-drop authoritative rebuild is one batch with one cache invalidation', () => {
  const sql = buildD1SummaryRebuildSql(dropRows.map(([
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
  })), 500, [
    { dropId: 'card_nft_2', eventCount: 700, historicalEventCount: 699, appliedEventCount: 1 },
    { dropId: 'little_swag_boxes', eventCount: 100, historicalEventCount: 100, appliedEventCount: 0 },
    { dropId: 'poncho_drifella', eventCount: 70, historicalEventCount: 70, appliedEventCount: 0 },
  ]);
  assert.equal((sql.match(/INSERT INTO pack_status/g) || []).length, 3);
  assert.equal((sql.match(/cache_generation = cache_generation \+ 1/g) || []).length, 1);
  assert.equal((sql.match(/UPDATE pack_status_rollout/g) || []).length, 1);
  assert.equal((sql.match(/SELECT COUNT\(\*\) FROM pack_status_events\) = 870/g) || []).length, 4);
  assert.match(sql, /drop_id = 'card_nft_2' AND apply_delta = 1\) = 1/);
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

test('migration 0003 forces D1, invalidates cache, and installs permanent source guards', () => {
  const migration = readFileSync('cloud/workers/api/migrations/0003_pack_status_d1_only.sql', 'utf8');
  assert.match(migration, /read_source = 'd1'/);
  assert.match(migration, /cache_generation = cache_generation \+ 1/);
  assert.match(migration, /CREATE TRIGGER pack_status_rollout_d1_only_insert_guard/);
  assert.match(migration, /CREATE TRIGGER pack_status_rollout_d1_only_update_guard/);
  assert.match(migration, /CREATE TRIGGER pack_status_event_immutable/);
  assert.match(migration, /CREATE TRIGGER pack_status_event_delete_guard/);
  assert.match(migration, /RAISE\(ABORT, 'pack-status read source is permanently d1'\)/);
});

test('Time Travel bookmark parser accepts Wrangler JSON without logging credentials', () => {
  const bookmark = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
  assert.equal(parseBookmarkOutput(JSON.stringify({ bookmark })), bookmark);
  assert.equal(parseBookmarkOutput(JSON.stringify({ result: { bookmark } })), bookmark);
  assert.throws(() => parseBookmarkOutput(JSON.stringify({ result: {} })), /no bookmark/);
});
