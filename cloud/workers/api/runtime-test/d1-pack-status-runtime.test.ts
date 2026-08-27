import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';
import {
  applyD1PackStatusEvent,
  readD1PackStatus,
  readD1PackStatusRecord,
  readPackStatusMetadata,
} from '../src/d1PackStatus.ts';
import { buildD1SummaryRebuildSql } from '../../../../scripts/shared/d1PackStatusMaintenance.ts';

test('D1 pack-status steady state keeps events, metadata, and rebuilds atomic', async () => {
  const productionConfig = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const runtimeConfig = {
    ...productionConfig,
    main: resolve('cloud/workers/api/src/index.ts'),
    routes: undefined,
    d1_databases: productionConfig.d1_databases.map((database: Record<string, unknown>) => ({
      ...database,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
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
    assert.deepEqual(await readPackStatusMetadata(env.DATA_DB), { cacheGeneration: 1 });
    const migrations = await env.DATA_DB.prepare(
      'SELECT name FROM d1_migrations ORDER BY name',
    ).all<{ name: string }>();
    assert.deepEqual(migrations.results.map((row) => row.name), [
      '0001_current_schema.sql',
      '0002_pack_status_event_conflict_guard.sql',
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
    assert.equal(await applyD1PackStatusEvent(env.DATA_DB, {
      ...onlineReveal,
      createdAtMs: onlineReveal.createdAtMs + 1,
    }), 'duplicate');
    await assert.rejects(
      applyD1PackStatusEvent(env.DATA_DB, { ...onlineReveal, quantity: 4 }),
      (error: unknown) => error instanceof Error && error.message === 'pack_status_event_conflict',
    );
    const persistedEvent = [
      onlineReveal.dropId,
      onlineReveal.type,
      onlineReveal.eventKey,
      onlineReveal.quantity,
      1,
      0,
      0,
      0,
      null,
      null,
      onlineReveal.boxAssetId,
      onlineReveal.signature,
      1,
      onlineReveal.createdAtMs,
    ] satisfies unknown[];
    const replayMismatches = [
      ['quantity', 3, 4],
      ['unsealed_online_delta', 4, 2],
      ['redeemed_irl_normal_delta', 5, 1],
      ['redeemed_irl_stripe_delta', 6, 1],
      ['redeemed_unsealed_cards_delta', 7, 1],
      ['delivery_id', 8, 7],
      ['checkout_session_id', 9, 'cs_changed'],
      ['box_asset_id', 10, 'box-changed'],
      ['signature', 11, 'signature-changed'],
      ['apply_delta', 12, 0],
    ] as const;
    for (const [field, index, value] of replayMismatches) {
      const bindings = [...persistedEvent];
      bindings[index] = value;
      await assert.rejects(
        env.DATA_DB.prepare(`INSERT INTO pack_status_events (
          drop_id, event_type, event_key, quantity,
          unsealed_online_delta, redeemed_irl_normal_delta, redeemed_irl_stripe_delta,
          redeemed_unsealed_cards_delta, delivery_id, checkout_session_id,
          box_asset_id, signature, apply_delta, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(drop_id, event_type, event_key) DO NOTHING`)
          .bind(...bindings)
          .run(),
        /pack-status event payload conflict/,
        field,
      );
    }
    assert.equal((await env.DATA_DB.prepare(
      `SELECT COUNT(*) AS count
      FROM pack_status_events
      WHERE drop_id = ? AND event_type = ? AND event_key = ?`,
    ).bind(onlineReveal.dropId, onlineReveal.type, onlineReveal.eventKey)
      .first<{ count: number }>())?.count, 1);
    assert.deepEqual(await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'), {
      version: 1,
      dropId: 'card_nft_2',
      totalInitialSupply: 10,
      totalCards: 30,
      cardsPerPack: 3,
      unsealedOnline: 2,
      redeemedIrlNormal: 2,
      redeemedIrlStripe: 3,
      redeemedUnsealedCards: 4,
      rebuiltAtMs: 100,
      updatedAtMs: 300,
    });
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
    });

    assert.deepEqual(await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'), {
      version: 1,
      dropId: 'card_nft_2',
      totalInitialSupply: 10,
      totalCards: 30,
      cardsPerPack: 3,
      unsealedOnline: 2,
      redeemedIrlNormal: 3,
      redeemedIrlStripe: 4,
      redeemedUnsealedCards: 5,
      rebuiltAtMs: 100,
      updatedAtMs: 400,
    });
    const breakdown = await readD1PackStatus(env.DATA_DB, 'card_nft_2');
    assert.equal(breakdown?.unsealedCards, 6);
    assert.equal(breakdown?.redeemedCards, 26);

    const rebuildSql = buildD1SummaryRebuildSql({
      dropId: 'card_nft_2',
      totalInitialSupply: 10,
      totalCards: 30,
      cardsPerPack: 3,
      unsealedOnline: 0,
      redeemedIrlNormal: 0,
      redeemedIrlStripe: 0,
      redeemedUnsealedCards: 0,
    }, 500, [
      { dropId: 'card_nft_2', eventCount: 3, historicalEventCount: 0, appliedEventCount: 3 },
      { dropId: 'little_swag_boxes', eventCount: 0, historicalEventCount: 0, appliedEventCount: 0 },
      { dropId: 'poncho_drifella', eventCount: 0, historicalEventCount: 0, appliedEventCount: 0 },
    ]);
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
    assert.deepEqual(await readPackStatusMetadata(env.DATA_DB), { cacheGeneration: 2 });

    const staleRebuildSql = buildD1SummaryRebuildSql({
      dropId: 'card_nft_2',
      totalInitialSupply: 9,
      totalCards: 27,
      cardsPerPack: 3,
      unsealedOnline: 9,
      redeemedIrlNormal: 0,
      redeemedIrlStripe: 0,
      redeemedUnsealedCards: 0,
    }, 600, [
      { dropId: 'card_nft_2', eventCount: 2, historicalEventCount: 0, appliedEventCount: 2 },
      { dropId: 'little_swag_boxes', eventCount: 0, historicalEventCount: 0, appliedEventCount: 0 },
      { dropId: 'poncho_drifella', eventCount: 0, historicalEventCount: 0, appliedEventCount: 0 },
    ]);
    await env.DATA_DB.batch(
      unstable_splitSqlQuery(staleRebuildSql).map((query) => env.DATA_DB.prepare(query)),
    );
    assert.equal((await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'))?.totalInitialSupply, 10);
    assert.equal((await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'))?.rebuiltAtMs, 500);
    assert.deepEqual(await readPackStatusMetadata(env.DATA_DB), { cacheGeneration: 2 });

    await env.DATA_DB.prepare(
      'UPDATE pack_status_metadata SET cache_generation = 4, updated_at_ms = 700 WHERE singleton = 1',
    ).run();
    assert.deepEqual(await readPackStatusMetadata(env.DATA_DB), { cacheGeneration: 4 });

    const eventCount = await env.DATA_DB.prepare(
      "SELECT COUNT(*) AS event_count FROM pack_status_events WHERE drop_id = 'card_nft_2'",
    ).first<{ event_count: number }>();
    assert.equal(eventCount?.event_count, 3);
    await applyD1PackStatusEvent(env.DATA_DB, {
      ...onlineReveal,
      eventKey: 'box-after-rebuild',
      createdAtMs: 900,
    });
    assert.equal((await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'))?.unsealedOnline, 1);
    assert.equal((await readD1PackStatusRecord(env.DATA_DB, 'card_nft_2'))?.updatedAtMs, 900);

    await assert.rejects(
      applyD1PackStatusEvent(env.DATA_DB, {
        ...onlineReveal,
        eventKey: 'negative',
        increments: { unsealedOnline: -1 },
      }),
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
      'pack_status_event_conflict_guard',
      'pack_status_event_delete_guard',
      'pack_status_event_immutable',
      'pack_status_event_type_guard',
      'pack_status_events',
      'pack_status_metadata',
    ]);
  } finally {
    await server.close();
  }
});
