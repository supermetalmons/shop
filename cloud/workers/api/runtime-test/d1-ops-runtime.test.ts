import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createCommerceD1 } from '../test/commerceD1Harness.ts';
import { createTestHarness } from 'wrangler';
import { OPS_EXPIRY_CLEANUP_STATEMENTS } from '../../../../shared/opsExpiryCleanupSql.ts';
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
import {
  AuthWalletBindingD1BusyError,
  AuthWalletBindingD1SupersededError,
  acquireAuthWalletBindingReconcileLease,
  establishD1AuthWalletBinding,
  loadD1AuthWalletBinding,
  releaseAuthWalletBindingReconcileLease,
  resolveD1AuthWalletBinding,
} from '../src/authWalletBindingD1.ts';
import {
  loadD1RevealSubmission,
  loadRevealSubmissionStorageControl,
  reserveD1RevealSubmission,
  RevealSubmissionStoragePausedError,
  setD1RevealSubmissionStatus,
  type RevealSubmissionRecord,
} from '../src/revealSubmissionD1.ts';
import { cleanupExpiredAnonymousAuthSessions } from '../src/anonymousAuth.ts';

const PROFILE_WALLET = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const RACE_WALLET = '11111111111111111111111111111111';
const REVEAL_DROP_ID = 'runtime_drop';
const REVEAL_BOX_ASSET_ID = 'So11111111111111111111111111111111111111112';
const REVEAL_OWNER = PROFILE_WALLET;
const REVEAL_SIGNATURE = '2'.repeat(88);
const REVEAL_BLOCKHASH = '3'.repeat(44);

function normalizeRuntimeRevealSubmission(
  raw: Record<string, unknown>,
): RevealSubmissionRecord {
  const dudeIds = Array.isArray(raw.dudeIds) ? raw.dudeIds.map(Number) : [];
  if (
    raw.version !== 1 ||
    raw.owner !== REVEAL_OWNER ||
    typeof raw.signature !== 'string' ||
    typeof raw.recentBlockhash !== 'string' ||
    !Number.isSafeInteger(raw.blockhashContextSlot) ||
    dudeIds.length !== 1 ||
    !Number.isSafeInteger(dudeIds[0]) ||
    typeof raw.reservationId !== 'string' ||
    (raw.status !== 'pending' && raw.status !== 'confirmed' && raw.status !== 'failed')
  ) throw new Error('Invalid runtime reveal submission');
  return {
    owner: raw.owner,
    signature: raw.signature,
    recentBlockhash: raw.recentBlockhash,
    blockhashContextSlot: Number(raw.blockhashContextSlot),
    dudeIds,
    reservationId: raw.reservationId,
    status: raw.status,
  };
}

test('ops D1 migrations preserve historical controls and receipt-transfer limits', async () => {
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
      '0001_current_schema.sql',
      '0002_reveal_submission_write_fence.sql',
      '0003_remove_ready_notification_pause.sql',
      '0004_repair_ready_notification_cursor.sql',
      '0005_remove_redundant_anonymous_auth_subject_index.sql',
      '0006_cover_expiry_cleanup_indexes.sql',
    ]);
    assert.equal((await env.OPS_DB.prepare(`SELECT COUNT(*) AS count
      FROM sqlite_schema
      WHERE name = 'anonymous_auth_sessions_auth_subject'`).first<{ count: number }>())?.count, 0);
    const anonymousAuthSubjectPlan = await env.OPS_DB.prepare(`EXPLAIN QUERY PLAN
      SELECT session_id
      FROM anonymous_auth_sessions
      WHERE auth_subject = ?`)
      .bind('anon:10000000-0000-4000-8000-000000000001')
      .all<{ detail: string }>();
    assert.ok(anonymousAuthSubjectPlan.results.some((row) =>
      /^SEARCH anonymous_auth_sessions USING INDEX sqlite_autoindex_anonymous_auth_sessions_\d+ \(auth_subject=\?\)$/.test(row.detail)));
    for (const query of Object.values(OPS_EXPIRY_CLEANUP_STATEMENTS)) {
      const plan = await env.OPS_DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(1_000, query.limit)
        .all<{ detail: string }>();
      assert.ok(plan.results.some((row) =>
        row.detail.includes(`USING COVERING INDEX ${query.indexName}`)));
      assert.ok(plan.results.every((row) => !row.detail.includes('USE TEMP B-TREE')));
    }
    const anonymousExpiry = 30 * 24 * 60 * 60 * 1000;
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO anonymous_auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          '10000000-0000-4000-8000-000000000001',
          'a'.repeat(64),
          'anon:10000000-0000-4000-8000-000000000001',
          'mons.shop',
          0,
          0,
          anonymousExpiry,
        ),
      env.OPS_DB.prepare(`INSERT INTO anonymous_auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          '20000000-0000-4000-8000-000000000002',
          'b'.repeat(64),
          'anon:20000000-0000-4000-8000-000000000002',
          'mons.shop',
          anonymousExpiry,
          anonymousExpiry,
          anonymousExpiry * 2,
        ),
    ]);
    assert.deepEqual(await cleanupExpiredAnonymousAuthSessions(env.OPS_DB, anonymousExpiry + 1), {
      deletedCount: 1,
      limitReached: false,
      hasMore: false,
    });
    assert.equal(
      Number((await env.OPS_DB.prepare('SELECT COUNT(*) AS count FROM anonymous_auth_sessions').first<{ count: number }>())?.count),
      1,
    );
    const revealStorageControl = await loadRevealSubmissionStorageControl(env.OPS_DB);
    assert.equal(revealStorageControl.paused, false);
    assert.equal(revealStorageControl.revision, 1);
    assert.equal(revealStorageControl.updatedAtMs, 0);
    const statusPlan = await env.OPS_DB.prepare(`EXPLAIN QUERY PLAN
      SELECT box_asset_id
      FROM reveal_submissions
      WHERE status = 'confirmed'
      ORDER BY created_at_ms`)
      .all<{ detail: string }>();
    assert.ok(statusPlan.results.some((row) =>
      row.detail.includes('reveal_submissions_status_created_at_ms')));
    const initialReveal: RevealSubmissionRecord = {
      owner: REVEAL_OWNER,
      signature: REVEAL_SIGNATURE,
      recentBlockhash: REVEAL_BLOCKHASH,
      blockhashContextSlot: 42,
      dudeIds: [9],
      reservationId: '123e4567-e89b-42d3-a456-426614174000',
      status: 'pending',
    };
    assert.deepEqual(await reserveD1RevealSubmission({
      boxAssetId: REVEAL_BOX_ASSET_ID,
      candidate: initialReveal,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 1_000,
    }), { submission: initialReveal, owned: true });
    assert.deepEqual(await reserveD1RevealSubmission({
      boxAssetId: REVEAL_BOX_ASSET_ID,
      candidate: {
        ...initialReveal,
        signature: '4'.repeat(88),
        reservationId: '123e4567-e89b-42d3-b456-426614174001',
      },
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 1_001,
    }), { submission: initialReveal, owned: false });
    assert.equal(await setD1RevealSubmissionStatus({
      boxAssetId: REVEAL_BOX_ASSET_ID,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 2_000,
      status: 'failed',
      submission: initialReveal,
    }), 'failed');
    const replacement = {
      ...initialReveal,
      signature: '5'.repeat(88),
      reservationId: '123e4567-e89b-42d3-8456-426614174002',
    };
    assert.deepEqual(await reserveD1RevealSubmission({
      boxAssetId: REVEAL_BOX_ASSET_ID,
      candidate: replacement,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 3_000,
      replaceSubmission: { ...initialReveal, status: 'failed' },
    }), { submission: replacement, owned: true });
    assert.equal(await setD1RevealSubmissionStatus({
      boxAssetId: REVEAL_BOX_ASSET_ID,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 4_000,
      status: 'confirmed',
      submission: replacement,
    }), 'confirmed');
    assert.equal(await setD1RevealSubmissionStatus({
      boxAssetId: REVEAL_BOX_ASSET_ID,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 5_000,
      status: 'failed',
      submission: replacement,
    }), 'confirmed');
    assert.equal((await loadD1RevealSubmission(
      env.OPS_DB,
      REVEAL_DROP_ID,
      REVEAL_BOX_ASSET_ID,
      normalizeRuntimeRevealSubmission,
    ))?.status, 'confirmed');
    const replaceBoxAssetId = '4'.repeat(44);
    const terminalBoxAssetId = '5'.repeat(44);
    const insertBoxAssetId = '6'.repeat(44);
    const replaceExisting: RevealSubmissionRecord = {
      ...initialReveal,
      signature: '6'.repeat(88),
      reservationId: '123e4567-e89b-42d3-8456-426614174003',
    };
    const terminalExisting: RevealSubmissionRecord = {
      ...initialReveal,
      signature: '7'.repeat(88),
      reservationId: '123e4567-e89b-42d3-8456-426614174004',
    };
    await reserveD1RevealSubmission({
      boxAssetId: replaceBoxAssetId,
      candidate: replaceExisting,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 5_100,
    });
    assert.equal(await setD1RevealSubmissionStatus({
      boxAssetId: replaceBoxAssetId,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 5_200,
      status: 'failed',
      submission: replaceExisting,
    }), 'failed');
    await reserveD1RevealSubmission({
      boxAssetId: terminalBoxAssetId,
      candidate: terminalExisting,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 5_300,
    });
    await env.OPS_DB.prepare(`UPDATE reveal_submission_storage_control
      SET paused = 1, revision = revision + 1, updated_at_ms = 6_000
      WHERE singleton = 1`).run();
    const insertedAfterResume: RevealSubmissionRecord = {
      ...initialReveal,
      signature: '8'.repeat(88),
      reservationId: '123e4567-e89b-42d3-8456-426614174005',
    };
    const replacementAfterResume: RevealSubmissionRecord = {
      ...replaceExisting,
      signature: '9'.repeat(88),
      reservationId: '123e4567-e89b-42d3-8456-426614174006',
    };
    await assert.rejects(
      reserveD1RevealSubmission({
        boxAssetId: insertBoxAssetId,
        candidate: insertedAfterResume,
        db: env.OPS_DB,
        dropId: REVEAL_DROP_ID,
        normalize: normalizeRuntimeRevealSubmission,
        nowMs: 6_100,
      }),
      RevealSubmissionStoragePausedError,
    );
    await assert.rejects(
      reserveD1RevealSubmission({
        boxAssetId: replaceBoxAssetId,
        candidate: replacementAfterResume,
        db: env.OPS_DB,
        dropId: REVEAL_DROP_ID,
        normalize: normalizeRuntimeRevealSubmission,
        nowMs: 6_200,
        replaceSubmission: { ...replaceExisting, status: 'failed' },
      }),
      RevealSubmissionStoragePausedError,
    );
    await assert.rejects(
      setD1RevealSubmissionStatus({
        boxAssetId: terminalBoxAssetId,
        db: env.OPS_DB,
        dropId: REVEAL_DROP_ID,
        normalize: normalizeRuntimeRevealSubmission,
        nowMs: 6_300,
        status: 'confirmed',
        submission: terminalExisting,
      }),
      RevealSubmissionStoragePausedError,
    );
    assert.equal((await loadD1RevealSubmission(
      env.OPS_DB,
      REVEAL_DROP_ID,
      insertBoxAssetId,
      normalizeRuntimeRevealSubmission,
    )), null);
    assert.equal((await loadD1RevealSubmission(
      env.OPS_DB,
      REVEAL_DROP_ID,
      replaceBoxAssetId,
      normalizeRuntimeRevealSubmission,
    ))?.status, 'failed');
    assert.equal((await loadD1RevealSubmission(
      env.OPS_DB,
      REVEAL_DROP_ID,
      terminalBoxAssetId,
      normalizeRuntimeRevealSubmission,
    ))?.status, 'pending');
    const deletedWhilePaused = await env.OPS_DB.prepare(`DELETE FROM reveal_submissions
      WHERE drop_id = ? AND box_asset_id = ?`)
      .bind(REVEAL_DROP_ID, REVEAL_BOX_ASSET_ID)
      .run();
    assert.equal(Number(deletedWhilePaused.meta.changes), 1);
    await env.OPS_DB.prepare(`UPDATE reveal_submission_storage_control
      SET paused = 0, revision = revision + 1, updated_at_ms = 7_000
      WHERE singleton = 1`).run();
    assert.deepEqual(await reserveD1RevealSubmission({
      boxAssetId: insertBoxAssetId,
      candidate: insertedAfterResume,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 7_100,
    }), { submission: insertedAfterResume, owned: true });
    assert.deepEqual(await reserveD1RevealSubmission({
      boxAssetId: replaceBoxAssetId,
      candidate: replacementAfterResume,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 7_200,
      replaceSubmission: { ...replaceExisting, status: 'failed' },
    }), { submission: replacementAfterResume, owned: true });
    assert.equal(await setD1RevealSubmissionStatus({
      boxAssetId: terminalBoxAssetId,
      db: env.OPS_DB,
      dropId: REVEAL_DROP_ID,
      normalize: normalizeRuntimeRevealSubmission,
      nowMs: 7_300,
      status: 'confirmed',
      submission: terminalExisting,
    }), 'confirmed');
    const pauseGuardSchema = await env.OPS_DB.prepare(`SELECT name
      FROM sqlite_schema
      WHERE name IN (
        'reveal_submission_insert_pause_guard',
        'reveal_submission_update_pause_guard'
      )
      ORDER BY name`).all<{ name: string }>();
    assert.deepEqual(pauseGuardSchema.results.map((row) => row.name), [
      'reveal_submission_insert_pause_guard',
      'reveal_submission_update_pause_guard',
    ]);
    await assert.rejects(env.OPS_DB.prepare(`INSERT INTO reveal_submissions (
      drop_id, box_asset_id, schema_version, owner_wallet, signature,
      recent_blockhash, blockhash_context_slot, dude_ids_json,
      reservation_id, status, revision, created_at_ms, updated_at_ms, confirmed_at_ms
    ) VALUES ('invalid', ?, 1, ?, ?, ?, 1, 'not-json', ?, 'pending', 1, 0, 0, NULL)`)
      .bind(
        '1'.repeat(32),
        REVEAL_OWNER,
        REVEAL_SIGNATURE,
        REVEAL_BLOCKHASH,
        '123e4567-e89b-42d3-a456-426614174000',
      ).run());
    await assert.rejects(env.OPS_DB.prepare(`UPDATE reveal_submission_storage_control
      SET
        revision = revision + 1,
        updated_at_ms = updated_at_ms + 1,
        created_at_ms = created_at_ms + 1
      WHERE singleton = 1`).run());
    assert.equal((await env.OPS_DB.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE name IN ('profile_storage_control', 'wallet_session_storage_control')`).first<{ count: number }>())?.count, 0);
    assert.deepEqual(await resolveD1AuthWalletBinding(env.OPS_DB, 'missing-auth-subject'), {
      wallet: null,
      reason: 'missing-binding',
    });
    assert.deepEqual(await resolveD1AuthWalletBinding(env.OPS_DB, RACE_WALLET), {
      wallet: null,
      reason: 'missing-binding',
    });
    await assert.rejects(establishD1AuthWalletBinding({
      baseline: null,
      db: env.OPS_DB,
      authSubject: 'invalid-wallet-session-uid',
      nowMs: 1_000,
      wallet: '1'.repeat(45),
    }), /Auth-wallet binding data is invalid/);
    assert.equal((await env.OPS_DB.prepare(
      'SELECT COUNT(*) AS count FROM auth_wallet_bindings WHERE auth_subject = ?',
    ).bind('invalid-wallet-session-uid').first<{ count: number }>())?.count, 0);
    const sessionUid = 'runtime-wallet-session-uid';
    const initialSession = await establishD1AuthWalletBinding({
      baseline: null,
      db: env.OPS_DB,
      authSubject: sessionUid,
      nowMs: 1_000,
      wallet: PROFILE_WALLET,
    });
    assert.deepEqual(initialSession, {
      authSubject: sessionUid,
      wallet: PROFILE_WALLET,
      updatedAtMs: 1_000,
      revision: 1,
      reconcileLeaseId: null,
      reconcileLeaseExpiresAtMs: null,
    });
    const reboundSession = await establishD1AuthWalletBinding({
      baseline: initialSession,
      db: env.OPS_DB,
      authSubject: sessionUid,
      nowMs: 2_000,
      wallet: RACE_WALLET,
    });
    assert.deepEqual(reboundSession, {
      ...initialSession,
      wallet: RACE_WALLET,
      updatedAtMs: 2_000,
      revision: 2,
    });
    await assert.rejects(
      establishD1AuthWalletBinding({
        baseline: initialSession,
        db: env.OPS_DB,
        authSubject: sessionUid,
        nowMs: 3_000,
        wallet: PROFILE_WALLET,
      }),
      AuthWalletBindingD1SupersededError,
    );
    const lease = await acquireAuthWalletBindingReconcileLease({
      db: env.OPS_DB,
      authSubject: sessionUid,
      leaseId: '00000000-0000-4000-8000-000000000001',
      nowMs: 4_000,
    });
    assert.equal(lease?.wallet, RACE_WALLET);
    const renewedDuringLease = await establishD1AuthWalletBinding({
      baseline: reboundSession,
      db: env.OPS_DB,
      authSubject: sessionUid,
      nowMs: 5_000,
      wallet: RACE_WALLET,
    });
    assert.deepEqual(renewedDuringLease, {
      ...reboundSession,
      updatedAtMs: 5_000,
      revision: 3,
      reconcileLeaseId: lease!.id,
      reconcileLeaseExpiresAtMs: lease!.expiresAtMs,
    });
    await assert.rejects(
      establishD1AuthWalletBinding({
        baseline: reboundSession,
        db: env.OPS_DB,
        authSubject: sessionUid,
        nowMs: 5_500,
        wallet: PROFILE_WALLET,
      }),
      AuthWalletBindingD1SupersededError,
    );
    await assert.rejects(
      establishD1AuthWalletBinding({
        baseline: renewedDuringLease,
        db: env.OPS_DB,
        authSubject: sessionUid,
        nowMs: 6_000,
        wallet: PROFILE_WALLET,
      }),
      AuthWalletBindingD1BusyError,
    );
    await releaseAuthWalletBindingReconcileLease(env.OPS_DB, sessionUid, lease!.id);
    const releasedSession = await loadD1AuthWalletBinding(env.OPS_DB, sessionUid);
    assert.equal(releasedSession?.reconcileLeaseId, null);
    const reboundAfterRelease = await establishD1AuthWalletBinding({
      baseline: releasedSession,
      db: env.OPS_DB,
      authSubject: sessionUid,
      nowMs: 7_000,
      wallet: PROFILE_WALLET,
    });
    assert.equal(reboundAfterRelease.wallet, PROFILE_WALLET);
    const expiringLease = await acquireAuthWalletBindingReconcileLease({
      db: env.OPS_DB,
      authSubject: sessionUid,
      leaseId: '00000000-0000-4000-8000-000000000002',
      nowMs: 20_000,
    });
    await releaseAuthWalletBindingReconcileLease(
      env.OPS_DB,
      sessionUid,
      '00000000-0000-4000-8000-000000000099',
    );
    await assert.rejects(acquireAuthWalletBindingReconcileLease({
      db: env.OPS_DB,
      authSubject: sessionUid,
      leaseId: '00000000-0000-4000-8000-000000000003',
      nowMs: 21_000,
    }), AuthWalletBindingD1BusyError);
    const reclaimedLease = await acquireAuthWalletBindingReconcileLease({
      db: env.OPS_DB,
      authSubject: sessionUid,
      leaseId: '00000000-0000-4000-8000-000000000004',
      nowMs: expiringLease!.expiresAtMs + 1,
    });
    assert.equal(reclaimedLease?.id, '00000000-0000-4000-8000-000000000004');
    await releaseAuthWalletBindingReconcileLease(env.OPS_DB, sessionUid, reclaimedLease!.id);
    await establishD1AuthWalletBinding({
      baseline: null,
      db: env.OPS_DB,
      authSubject: 'duplicate-wallet-session-uid',
      nowMs: 8_000,
      wallet: PROFILE_WALLET,
    });
    assert.equal((await env.OPS_DB.prepare(
      'SELECT COUNT(*) AS count FROM auth_wallet_bindings WHERE wallet = ?',
    ).bind(PROFILE_WALLET).first<{ count: number }>())?.count, 2);
    assert.deepEqual(await resolveD1AuthWalletBinding(env.OPS_DB, sessionUid), {
      wallet: PROFILE_WALLET,
      source: 'binding',
    });
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
      db: env.OPS_DB,
      nowMs: 4_000,
      ownerWallet: PROFILE_WALLET,
      providerFetch: async () => assert.fail('D1 profile read reached an external provider'),
      signal: new AbortController().signal,
    }), 'owner@example.com');
    const missingWallet = 'So11111111111111111111111111111111111111112';
    assert.equal(await profileReadTestHooks.loadProfileEmail({
      db: env.OPS_DB,
      nowMs: 4_000,
      ownerWallet: missingWallet,
      providerFetch: async () => assert.fail('D1-only profile read reached an external provider'),
      signal: new AbortController().signal,
    }), undefined);
    await assert.rejects(deliveryPrepareTestHooks.loadAddress({
      commerceDb: createCommerceD1(),
      nowMs: 4_000,
      providerFetch: async () => assert.fail('D1-only address read reached an external provider'),
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
      `INSERT INTO profile_addresses (
        wallet, address_id, encrypted, country, country_code,
        hint, email, label, created_at_ms, updated_at_ms
      ) VALUES (?, 'QbCdEfGhIjKlMnOpQrSt', 'cipher', 'US', 'US', 'hint', NULL, NULL, 0, 0)`,
    ).bind('So11111111111111111111111111111111111111112').run());
    assert.deepEqual(await env.OPS_DB.prepare(
      "SELECT * FROM worker_controls WHERE control_key = 'ready_notifications'",
    ).first(), {
      control_key: 'ready_notifications',
      cursor_path: null,
      revision: 1,
      created_at_ms: 0,
      updated_at_ms: 0,
      cursor_updated_at_ms: null,
    });
    assert.equal(
      (await env.OPS_DB.prepare(`SELECT COUNT(*) AS count
        FROM pragma_table_info('worker_controls')
        WHERE name = 'paused'`).first<{ count: number }>())?.count,
      0,
    );
    await assert.rejects(
      env.OPS_DB.prepare(
        `INSERT INTO worker_controls (
          control_key, cursor_path, revision,
          created_at_ms, updated_at_ms, cursor_updated_at_ms
        ) VALUES ('other', NULL, 1, 0, 0, NULL)`,
      ).run(),
    );

    const callerBucket = receiptTransferCallerRateLimitBucket('runtime-auth-subject');
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

    const reversedBucket = receiptTransferCallerRateLimitBucket('reversed-runtime-auth-subject');
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
      uid: 'runtime-auth-subject',
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
