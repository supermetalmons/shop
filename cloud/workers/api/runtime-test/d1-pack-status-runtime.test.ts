import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';
import {
  applyD1PackStatusEvent,
  readD1PackStatus,
  readD1PackStatusRecord,
  readPackStatusRollout,
} from '../src/d1PackStatus.ts';
import { buildD1SummaryRebuildSql } from '../../../../scripts/migrate-pack-status-to-d1.ts';

test('D1 pack-status migration enforces idempotent projection updates', async () => {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const runtimeConfig = {
    ...productionConfig,
    main: resolve('cloud/workers/api/src/index.ts'),
    routes: undefined,
    d1_databases: productionConfig.d1_databases.map((database: Record<string, unknown>) => ({
      ...database,
      migrations_dir: resolve('cloud/workers/api/migrations'),
    })),
  };
  delete runtimeConfig.$schema;
  delete runtimeConfig.secrets;
  const server = createTestHarness({
    root: resolve('.'),
    workers: [{ config: runtimeConfig }],
  });
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('DATA_DB');
    const env = await worker.getEnv();
    const rollout = await readPackStatusRollout(env.DATA_DB);
    assert.deepEqual(rollout, { readSource: 'd1', cacheGeneration: 2 });
    const migrations = await env.DATA_DB.prepare(
      "SELECT name FROM d1_migrations WHERE name LIKE '%pack_status%' ORDER BY name",
    ).all<{ name: string }>();
    assert.deepEqual(migrations.results.map((row) => row.name), [
      '0001_pack_status.sql',
      '0002_pack_status_event_type_guard.sql',
      '0003_pack_status_d1_only.sql',
    ]);

    await env.DATA_DB.prepare(
      `INSERT INTO pack_status (
        drop_id, version, total_initial_supply, total_cards, cards_per_pack,
        unsealed_online, redeemed_irl_normal, redeemed_irl_stripe, redeemed_unsealed_cards,
        rebuilt_at_ms, updated_at_ms
      ) VALUES (?, 1, 10, 30, 3, 1, 2, 3, 4, 100, 200)`,
    ).bind('card_nft_2').run();

    const onlineReveal = {
      dropId: 'card_nft_2',
      type: 'onlineReveal' as const,
      eventKey: 'box-1',
      quantity: 3,
      increments: { unsealedOnline: 1 },
      boxAssetId: 'box-1',
      signature: 'signature-1',
      createdAtMs: 300,
    };
    assert.equal(await applyD1PackStatusEvent(env.DATA_DB, onlineReveal), 'applied');
    assert.equal(await applyD1PackStatusEvent(env.DATA_DB, onlineReveal), 'duplicate');
    await applyD1PackStatusEvent(env.DATA_DB, {
      dropId: 'card_nft_2',
      type: 'redeemedIrlNormal',
      eventKey: '7',
      quantity: 4,
      increments: { redeemedIrlNormal: 1, redeemedUnsealedCards: 1 },
      deliveryId: 7,
      createdAtMs: 400,
    });
    await applyD1PackStatusEvent(env.DATA_DB, {
      dropId: 'card_nft_2',
      type: 'redeemedIrlStripe',
      eventKey: 'historical-order',
      quantity: 3,
      increments: { redeemedIrlStripe: 1 },
      deliveryId: 8,
      checkoutSessionId: 'cs_historical',
      createdAtMs: 150,
    }, false);

    assert.deepEqual(await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'), {
      version: 1,
      dropId: 'card_nft_2',
      totalInitialSupply: 10,
      totalCards: 30,
      cardsPerPack: 3,
      unsealedOnline: 2,
      redeemedIrlNormal: 3,
      redeemedIrlStripe: 3,
      redeemedUnsealedCards: 5,
      rebuiltAtMs: 100,
      updatedAtMs: 400,
    });
    const breakdown = await readD1PackStatus(env.DATA_DB, 'card_nft_2');
    assert.equal(breakdown?.unsealedCards, 6);
    assert.equal(breakdown?.redeemedCards, 23);

    const rebuildSql = buildD1SummaryRebuildSql({
      dropId: 'card_nft_2',
      totalInitialSupply: 10,
      totalCards: 30,
      cardsPerPack: 3,
      unsealedOnline: 0,
      redeemedIrlNormal: 0,
      redeemedIrlStripe: 0,
      redeemedUnsealedCards: 0,
    }, 500);
    await env.DATA_DB.batch(
      unstable_splitSqlQuery(rebuildSql).map((query) => env.DATA_DB.prepare(query)),
    );
    assert.deepEqual(await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'), {
      version: 1,
      dropId: 'card_nft_2',
      totalInitialSupply: 10,
      totalCards: 30,
      cardsPerPack: 3,
      unsealedOnline: 0,
      redeemedIrlNormal: 0,
      redeemedIrlStripe: 0,
      redeemedUnsealedCards: 0,
      rebuiltAtMs: 500,
      updatedAtMs: 500,
    });
    assert.deepEqual(await readPackStatusRollout(env.DATA_DB), { readSource: 'd1', cacheGeneration: 3 });
    const eventCount = await env.DATA_DB.prepare(
      "SELECT COUNT(*) AS event_count FROM pack_status_events WHERE drop_id = 'card_nft_2'",
    ).first<{ event_count: number }>();
    assert.equal(eventCount?.event_count, 3);

    await applyD1PackStatusEvent(env.DATA_DB, {
      ...onlineReveal,
      eventKey: 'box-after-rebuild',
      createdAtMs: 600,
    });
    assert.equal((await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'))?.unsealedOnline, 1);
    assert.equal((await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'))?.updatedAtMs, 600);

    await assert.rejects(
      applyD1PackStatusEvent(env.DATA_DB, {
        ...onlineReveal,
        eventKey: 'negative',
        increments: { unsealedOnline: -1 },
      }),
    );
    await assert.rejects(
      env.DATA_DB.prepare(
        "UPDATE pack_status_rollout SET read_source = 'firestore' WHERE singleton = 1",
      ).run(),
      /permanently d1/,
    );
    await assert.rejects(
      env.DATA_DB.prepare(
        "UPDATE pack_status_events SET quantity = quantity + 1 WHERE drop_id = 'card_nft_2' AND event_type = 'onlineReveal' AND event_key = 'box-1'",
      ).run(),
      /events are immutable/,
    );
    await assert.rejects(
      env.DATA_DB.prepare(
        "DELETE FROM pack_status_events WHERE drop_id = 'card_nft_2' AND event_type = 'onlineReveal' AND event_key = 'box-1'",
      ).run(),
      /events are immutable/,
    );
    await assert.rejects(
      env.DATA_DB.prepare(
        "INSERT INTO pack_status_rollout (singleton, read_source, cache_generation, updated_at_ms) VALUES (1, 'firestore', 1, 0) ON CONFLICT(singleton) DO NOTHING",
      ).run(),
      /permanently d1/,
    );
    await assert.rejects(
      env.DATA_DB.prepare(`INSERT INTO pack_status_events (
        drop_id, event_type, event_key, quantity,
        unsealed_online_delta, redeemed_irl_normal_delta, redeemed_irl_stripe_delta,
        redeemed_unsealed_cards_delta, apply_delta, created_at_ms
      ) VALUES (?, 'onlineReveal', 'wrong-delta', 3, 0, 0, 1, 0, 1, 500)`)
        .bind('card_nft_2')
        .run(),
    );
    await assert.rejects(
      applyD1PackStatusEvent(env.DATA_DB, {
        ...onlineReveal,
        dropId: 'missing-drop',
        eventKey: 'missing-drop',
      }),
    );
    const schema = await env.DATA_DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type IN ('table', 'trigger') AND name LIKE 'pack_status%' ORDER BY name",
    ).all<{ name: string }>();
    assert.deepEqual(schema.results.map((row) => row.name), [
      'pack_status',
      'pack_status_event_apply',
      'pack_status_event_delete_guard',
      'pack_status_event_immutable',
      'pack_status_event_type_guard',
      'pack_status_events',
      'pack_status_rollout',
      'pack_status_rollout_d1_only_insert_guard',
      'pack_status_rollout_d1_only_update_guard',
    ]);
  } finally {
    await server.close();
  }
});
