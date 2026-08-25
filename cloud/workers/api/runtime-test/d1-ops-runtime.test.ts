import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import {
  compareAndSetReadyNotificationCursor,
  loadReadyNotificationControl,
} from '../src/d1ReadyNotificationControl.ts';
import {
  cleanupExpiredReceiptTransferRateLimitBuckets,
  consumeReceiptTransferRateLimit,
  RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
  RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
  receiptTransferAssetRateLimitBucket,
  receiptTransferCallerRateLimitBucket,
} from '../src/receiptTransferRateLimit.ts';
import {
  ensureD1Profile,
  loadD1Profile,
  loadD1ProfileAddress,
  saveD1ProfileAddress,
} from '../src/profileD1.ts';
import { profileReadTestHooks } from '../src/profileReads.ts';
import { deliveryPrepareTestHooks } from '../src/deliveryPrepare.ts';

const PROFILE_WALLET = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const RACE_WALLET = '11111111111111111111111111111111';

test('ops D1 migrations enforce notification control and receipt-transfer limits', async () => {
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
    await worker.applyD1Migrations('OPS_DB');
    const env = await worker.getEnv();
    const migrations = await env.OPS_DB.prepare(
      'SELECT name FROM d1_migrations ORDER BY name',
    ).all<{ name: string }>();
    assert.deepEqual(migrations.results.map((row) => row.name), [
      '0001_ops_state.sql',
      '0002_profiles.sql',
      '0003_profiles_d1_final.sql',
      '0004_profile_integrity.sql',
      '0005_profile_write_safety.sql',
    ]);
    assert.deepEqual(await saveD1ProfileAddress(env.OPS_DB, {
      wallet: PROFILE_WALLET,
      id: 'AbCdEfGhIjKlMnOpQrSt',
      country: 'United States',
      countryCode: 'US',
      encrypted: 'cipher-text',
      hint: '100…01',
      email: 'owner@example.com',
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    }), {
      id: 'AbCdEfGhIjKlMnOpQrSt',
      country: 'United States',
      countryCode: 'US',
      encrypted: 'cipher-text',
      hint: '100…01',
      email: 'owner@example.com',
    });
    assert.deepEqual(await saveD1ProfileAddress(env.OPS_DB, {
      wallet: PROFILE_WALLET,
      id: 'AbCdEfGhIjKlMnOpQrSt',
      country: 'United States',
      countryCode: 'US',
      encrypted: 'cipher-text',
      hint: '100…01',
      email: 'owner@example.com',
      createdAtMs: 1_500,
      updatedAtMs: 1_500,
    }), {
      id: 'AbCdEfGhIjKlMnOpQrSt',
      country: 'United States',
      countryCode: 'US',
      encrypted: 'cipher-text',
      hint: '100…01',
      email: 'owner@example.com',
    });
    assert.equal((await loadD1ProfileAddress(
      env.OPS_DB,
      PROFILE_WALLET,
      'AbCdEfGhIjKlMnOpQrSt',
    ))?.createdAtMs, 1_000);
    await saveD1ProfileAddress(env.OPS_DB, {
      wallet: PROFILE_WALLET,
      id: 'ZbCdEfGhIjKlMnOpQrSt',
      country: 'Türkiye',
      countryCode: 'TR',
      encrypted: 'cipher-two',
      hint: '340…TR',
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    });
    assert.deepEqual(await loadD1Profile(env.OPS_DB, PROFILE_WALLET), {
      wallet: PROFILE_WALLET,
      email: 'owner@example.com',
      createdAtMs: 1_000,
      updatedAtMs: 1_500,
    });
    assert.equal((await loadD1ProfileAddress(env.OPS_DB, PROFILE_WALLET, 'ZbCdEfGhIjKlMnOpQrSt'))?.countryCode, 'TR');
    await assert.rejects(saveD1ProfileAddress(env.OPS_DB, {
      wallet: PROFILE_WALLET,
      id: 'AbCdEfGhIjKlMnOpQrSt',
      country: 'Canada',
      encrypted: 'collision',
      hint: 'collision',
      email: 'replacement@example.com',
      createdAtMs: 3_000,
      updatedAtMs: 3_000,
    }));
    assert.equal((await loadD1Profile(env.OPS_DB, PROFILE_WALLET))?.email, 'owner@example.com');
    await saveD1ProfileAddress(env.OPS_DB, {
      wallet: PROFILE_WALLET,
      id: 'YbCdEfGhIjKlMnOpQrSt',
      country: 'United States',
      encrypted: 'legacy-cipher',
      hint: 'legacy',
      email: 'owner@example.com',
      label: 'Home',
      createdAtMs: 500,
      updatedAtMs: 500,
    });
    assert.equal((await loadD1ProfileAddress(
      env.OPS_DB,
      PROFILE_WALLET,
      'YbCdEfGhIjKlMnOpQrSt',
    ))?.label, 'Home');
    await assert.rejects(env.OPS_DB.prepare(
      "UPDATE profile_addresses SET encrypted = 'changed' WHERE wallet = ? AND address_id = 'AbCdEfGhIjKlMnOpQrSt'",
    ).bind(PROFILE_WALLET).run());
    await assert.rejects(env.OPS_DB.prepare(
      "DELETE FROM profile_addresses WHERE wallet = ? AND address_id = 'AbCdEfGhIjKlMnOpQrSt'",
    ).bind(PROFILE_WALLET).run());
    await assert.rejects(env.OPS_DB.prepare(
      'DELETE FROM profiles WHERE wallet = ?',
    ).bind(PROFILE_WALLET).run());
    assert.equal(await profileReadTestHooks.loadProfileEmail({
      accessTokenProvider: { get: async () => 'token', invalidate: () => undefined },
      db: env.OPS_DB,
      nowMs: 4_000,
      ownerWallet: PROFILE_WALLET,
      providerFetch: async () => assert.fail('D1 profile read reached Firestore'),
      serviceAccountJson: 'credential',
      signal: new AbortController().signal,
    }), 'owner@example.com');
    const missingWallet = 'So11111111111111111111111111111111111111112';
    assert.equal(await profileReadTestHooks.loadProfileEmail({
      accessTokenProvider: { get: async () => 'token', invalidate: () => undefined },
      db: env.OPS_DB,
      nowMs: 4_000,
      ownerWallet: missingWallet,
      providerFetch: async () => assert.fail('D1-only profile read reached Firestore'),
      serviceAccountJson: 'credential',
      signal: new AbortController().signal,
    }), undefined);
    await assert.rejects(deliveryPrepareTestHooks.loadAddress({
      accessTokenProvider: { get: async () => 'token', invalidate: () => undefined },
      nowMs: 4_000,
      providerFetch: async () => assert.fail('D1-only address read reached Firestore'),
      serviceAccountJson: 'credential',
      signal: new AbortController().signal,
    }, env.OPS_DB, missingWallet, 'XbCdEfGhIjKlMnOpQrSt'), /Address not found/);
    await ensureD1Profile(env.OPS_DB, {
      wallet: RACE_WALLET,
      createdAtMs: 3_000,
      updatedAtMs: 3_000,
    });
    await saveD1ProfileAddress(env.OPS_DB, {
      wallet: RACE_WALLET,
      id: 'RbCdEfGhIjKlMnOpQrSt',
      country: 'Türkiye',
      encrypted: 'race-cipher',
      hint: 'race',
      email: 'race@example.com',
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    });
    assert.deepEqual(await loadD1Profile(env.OPS_DB, RACE_WALLET), {
      wallet: RACE_WALLET,
      email: 'race@example.com',
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
    });
    await ensureD1Profile(env.OPS_DB, {
      wallet: RACE_WALLET,
      createdAtMs: 4_000,
      updatedAtMs: 4_000,
    });
    assert.equal((await loadD1Profile(env.OPS_DB, RACE_WALLET))?.updatedAtMs, 2_000);
    await assert.rejects(
      loadD1Profile(env.OPS_DB, PROFILE_WALLET, AbortSignal.abort(new Error('D1 deadline'))),
      /D1 deadline/,
    );
    await assert.rejects(
      env.OPS_DB.prepare(`INSERT INTO profile_addresses (
        wallet, address_id, encrypted, country, country_code,
        hint, email, label, created_at_ms, updated_at_ms
      ) VALUES (?, 'TbCdEfGhIjKlMnOpQrSt', 'cipher', 'US', 'US', 'hint', NULL, NULL, ?, ?)`)
        .bind(PROFILE_WALLET, 253_402_300_800_000, 253_402_300_800_000)
        .run(),
    );
    await assert.rejects(env.OPS_DB.prepare(
      "UPDATE profile_storage_control SET read_source = 'firestore_fallback' WHERE singleton = 1",
    ).run());
    await assert.rejects(env.OPS_DB.prepare(
      'DELETE FROM profile_storage_control WHERE singleton = 1',
    ).run());
    await assert.rejects(env.OPS_DB.prepare(
      "INSERT OR REPLACE INTO profile_storage_control (singleton, read_source, updated_at_ms) VALUES (1, 'firestore_fallback', 0)",
    ).run());
    await assert.rejects(env.OPS_DB.prepare(
      `INSERT INTO profile_addresses (
        wallet, address_id, encrypted, country, country_code,
        hint, email, label, created_at_ms, updated_at_ms
      ) VALUES (?, 'QbCdEfGhIjKlMnOpQrSt', 'cipher', 'US', 'US', 'hint', NULL, NULL, 0, 0)`,
    ).bind('So11111111111111111111111111111111111111112').run());
    assert.deepEqual(await loadReadyNotificationControl(env.OPS_DB, 1_000), {
      cursorPath: null,
      paused: false,
      revision: 1,
    });

    await env.OPS_DB.prepare(
      "DELETE FROM worker_controls WHERE control_key = 'ready_notifications'",
    ).run();
    assert.deepEqual(await loadReadyNotificationControl(env.OPS_DB, 2_000), {
      cursorPath: null,
      paused: false,
      revision: 1,
    });
    assert.equal(await compareAndSetReadyNotificationCursor(
      env.OPS_DB,
      'drops/card_nft_2/deliveryOrders/7',
      1,
      3_000,
    ), true);
    assert.equal(await compareAndSetReadyNotificationCursor(
      env.OPS_DB,
      'drops/card_nft_2/deliveryOrders/8',
      1,
      4_000,
    ), false);
    assert.deepEqual(await loadReadyNotificationControl(env.OPS_DB, 4_000), {
      cursorPath: 'drops/card_nft_2/deliveryOrders/7',
      paused: false,
      revision: 2,
    });

    await env.OPS_DB.prepare(
      `UPDATE worker_controls
      SET paused = 1, revision = revision + 1, updated_at_ms = ?
      WHERE control_key = 'ready_notifications'`,
    ).bind(5_000).run();
    assert.deepEqual(await loadReadyNotificationControl(env.OPS_DB, 5_000), {
      cursorPath: 'drops/card_nft_2/deliveryOrders/7',
      paused: true,
      revision: 3,
    });
    assert.equal(await compareAndSetReadyNotificationCursor(
      env.OPS_DB,
      'drops/card_nft_2/deliveryOrders/8',
      3,
      6_000,
    ), false);
    await assert.rejects(
      env.OPS_DB.prepare(
        `INSERT INTO worker_controls (
          control_key, paused, cursor_path, revision,
          created_at_ms, updated_at_ms, cursor_updated_at_ms
        ) VALUES ('other', 0, NULL, 1, 0, 0, NULL)`,
      ).run(),
    );

    const callerBucket = receiptTransferCallerRateLimitBucket('runtime-firebase-uid');
    const concurrent = await Promise.all(Array.from(
      { length: RECEIPT_TRANSFER_CALLER_RATE_LIMIT + 5 },
      () => consumeReceiptTransferRateLimit(env.OPS_DB, callerBucket, 10_000),
    ));
    assert.equal(concurrent.filter((decision) => decision.allowed).length, RECEIPT_TRANSFER_CALLER_RATE_LIMIT);
    assert.equal(concurrent.filter((decision) => !decision.allowed).length, 5);
    const limitedRow = await env.OPS_DB.prepare(
      `SELECT request_count, updated_at_ms
      FROM rate_limit_buckets
      WHERE scope = ? AND subject_hash = ?`,
    ).bind(callerBucket.scope, callerBucket.subjectHash).first<{
      request_count: number;
      updated_at_ms: number;
    }>();
    assert.deepEqual(limitedRow, {
      request_count: RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
      updated_at_ms: 10_000,
    });
    const boundary = await consumeReceiptTransferRateLimit(
      env.OPS_DB,
      callerBucket,
      10_000 + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
    );
    assert.deepEqual(boundary, {
      allowed: true,
      count: 1,
      windowStartedAtMs: 10_000 + RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
    });

    const reversedBucket = receiptTransferCallerRateLimitBucket('reversed-runtime-firebase-uid');
    const newerStartedAtMs = 2_000_000;
    const olderSampledAtMs = newerStartedAtMs - 1_000;
    assert.deepEqual(
      await consumeReceiptTransferRateLimit(env.OPS_DB, reversedBucket, newerStartedAtMs),
      {
        allowed: true,
        count: 1,
        windowStartedAtMs: newerStartedAtMs,
      },
    );
    assert.deepEqual(
      await consumeReceiptTransferRateLimit(env.OPS_DB, reversedBucket, olderSampledAtMs),
      {
        allowed: true,
        count: 2,
        windowStartedAtMs: newerStartedAtMs,
      },
    );
    const reversedRow = await env.OPS_DB.prepare(
      `SELECT request_count, window_started_at_ms, updated_at_ms
      FROM rate_limit_buckets
      WHERE scope = ? AND subject_hash = ?`,
    ).bind(reversedBucket.scope, reversedBucket.subjectHash).first<{
      request_count: number;
      window_started_at_ms: number;
      updated_at_ms: number;
    }>();
    assert.deepEqual(reversedRow, {
      request_count: 2,
      window_started_at_ms: newerStartedAtMs,
      updated_at_ms: newerStartedAtMs,
    });
    await env.OPS_DB.prepare(
      `UPDATE rate_limit_buckets
      SET request_count = ?
      WHERE scope = ? AND subject_hash = ?`,
    ).bind(
      RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
      reversedBucket.scope,
      reversedBucket.subjectHash,
    ).run();
    assert.deepEqual(
      await consumeReceiptTransferRateLimit(env.OPS_DB, reversedBucket, olderSampledAtMs),
      {
        allowed: false,
        count: RECEIPT_TRANSFER_CALLER_RATE_LIMIT,
        retryAfterMs: RECEIPT_TRANSFER_RATE_LIMIT_WINDOW_MS,
        windowStartedAtMs: newerStartedAtMs,
      },
    );

    const assetBucket = receiptTransferAssetRateLimitBucket({
      uid: 'runtime-firebase-uid',
      cluster: 'mainnet-beta',
      ownerWallet: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
      receiptAssetId: 'EAzEpagtyeRAx9npnpVMpygoA8ouX7DRpLTghhPvYTiu',
    });
    assert.deepEqual(await consumeReceiptTransferRateLimit(env.OPS_DB, assetBucket, 20_000), {
      allowed: true,
      count: 1,
      windowStartedAtMs: 20_000,
    });
    await env.OPS_DB.prepare(
      `UPDATE rate_limit_buckets
      SET schema_version = 1, owner_wallet = 'mismatched-wallet'
      WHERE scope = ? AND subject_hash = ?`,
    ).bind(assetBucket.scope, assetBucket.subjectHash).run();
    assert.deepEqual(await consumeReceiptTransferRateLimit(env.OPS_DB, assetBucket, 21_000), {
      allowed: true,
      count: 1,
      windowStartedAtMs: 21_000,
    });

    await env.OPS_DB.prepare('DELETE FROM rate_limit_buckets').run();
    await env.OPS_DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 1001
      )
      INSERT INTO rate_limit_buckets (
        scope, subject_hash, schema_version, cluster, owner_wallet,
        receipt_asset_id, window_started_at_ms, expires_at_ms,
        request_count, updated_at_ms
      )
      SELECT
        'caller', printf('%064x', value), 2, NULL, NULL,
        NULL, 0, 600000, 1, 0
      FROM sequence`,
    ).run();
    assert.deepEqual(await cleanupExpiredReceiptTransferRateLimitBuckets(env.OPS_DB, 720_000), {
      deletedCount: 1_000,
      limitReached: true,
      hasMore: true,
    });
    assert.deepEqual(await cleanupExpiredReceiptTransferRateLimitBuckets(env.OPS_DB, 720_000), {
      deletedCount: 1,
      limitReached: false,
      hasMore: false,
    });
    const quickCheck = await env.OPS_DB.prepare('PRAGMA quick_check').first<Record<string, unknown>>();
    assert.equal(quickCheck?.quick_check, 'ok');
  } finally {
    await server.close();
  }
});
