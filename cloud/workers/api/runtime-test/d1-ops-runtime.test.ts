import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createCommerceD1, firestoreProviderCommerceRequester } from '../test/commerceD1Harness.ts';
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
import {
  WalletSessionD1BusyError,
  WalletSessionD1SupersededError,
  acquireWalletSessionReconcileLease,
  establishD1WalletSession,
  loadD1WalletSession,
  releaseWalletSessionReconcileLease,
  resolveD1WalletSession,
} from '../src/walletSessionD1.ts';
import {
  loadD1RevealSubmission,
  loadRevealSubmissionStorageControl,
  reserveD1RevealSubmission,
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
      '0006_wallet_sessions.sql',
      '0007_wallet_sessions_d1_only.sql',
      '0008_reveal_submissions.sql',
      '0009_reveal_submissions_d1_only.sql',
      '0010_reveal_submissions_baseline_index.sql',
      '0011_staff_wallet_auth.sql',
      '0012_anonymous_auth.sql',
      '0013_remove_firebase_auth_fallback.sql',
      '0014_auth_subject_bridge.sql',
      '0015_auth_subject_cutover.sql',
    ]);
    const authControl = await env.OPS_DB.prepare(`SELECT firebase_fallback_enabled, revision, firebase_disabled_at_ms
      FROM anonymous_auth_control
      WHERE singleton = 1`).first<Record<string, unknown>>();
    assert.equal(authControl?.firebase_fallback_enabled, 0);
    assert.equal(authControl?.revision, 2);
    assert.ok(Number.isSafeInteger(authControl?.firebase_disabled_at_ms));
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
    await assert.rejects(loadRevealSubmissionStorageControl(env.OPS_DB));
    await env.OPS_DB.batch(Array.from({ length: 14 }, (_, index) => env.OPS_DB.prepare(
      `INSERT INTO reveal_submissions (
        drop_id, box_asset_id, schema_version, owner_wallet, signature,
        recent_blockhash, blockhash_context_slot, dude_ids_json,
        reservation_id, status, revision, created_at_ms, updated_at_ms, confirmed_at_ms
      ) VALUES ('baseline', ?, 1, ?, ?, ?, 1, '[1]', ?, 'confirmed', 1, 1, 1, 1)`,
    ).bind(
      String(index).padStart(32, '0'),
      RACE_WALLET,
      '2'.repeat(64),
      '3'.repeat(32),
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    )));
    const revealStorageControl = await loadRevealSubmissionStorageControl(env.OPS_DB);
    assert.equal(revealStorageControl.paused, false);
    assert.equal(revealStorageControl.source, 'd1');
    assert.equal(revealStorageControl.revision, 3);
    assert.ok(revealStorageControl.updatedAtMs > 0);
    assert.equal(revealStorageControl.cutoverAtMs, revealStorageControl.updatedAtMs);
    const baselinePlan = await env.OPS_DB.prepare(`EXPLAIN QUERY PLAN
      SELECT COUNT(*)
      FROM reveal_submissions
      WHERE status = 'confirmed' AND created_at_ms <= ?`)
      .bind(revealStorageControl.cutoverAtMs)
      .all<{ detail: string }>();
    assert.ok(baselinePlan.results.some((row) =>
      row.detail.includes('reveal_submissions_status_created_at_ms')));
    for (const status of ['pending', 'failed'] as const) {
      await env.OPS_DB.prepare(`UPDATE reveal_submissions
        SET status = ?, confirmed_at_ms = NULL, revision = revision + 1, updated_at_ms = 2
        WHERE drop_id = 'baseline' AND box_asset_id = ?`)
        .bind(status, String(0).padStart(32, '0'))
        .run();
      await assert.rejects(loadRevealSubmissionStorageControl(env.OPS_DB));
      await env.OPS_DB.prepare(`UPDATE reveal_submissions
        SET status = 'confirmed', confirmed_at_ms = 2, revision = revision + 1
        WHERE drop_id = 'baseline' AND box_asset_id = ?`)
        .bind(String(0).padStart(32, '0'))
        .run();
    }
    await env.OPS_DB.prepare(`UPDATE reveal_submissions
      SET status = 'failed', confirmed_at_ms = NULL, revision = revision + 1
      WHERE drop_id = 'baseline' AND box_asset_id = ?`)
      .bind(String(0).padStart(32, '0'))
      .run();
    const newerTimestamp = revealStorageControl.cutoverAtMs + 1;
    await env.OPS_DB.prepare(`INSERT INTO reveal_submissions (
      drop_id, box_asset_id, schema_version, owner_wallet, signature,
      recent_blockhash, blockhash_context_slot, dude_ids_json,
      reservation_id, status, revision, created_at_ms, updated_at_ms, confirmed_at_ms
    ) VALUES ('newer', ?, 1, ?, ?, ?, 1, '[1]', ?, 'confirmed', 1, ?, ?, ?)`)
      .bind(
        '9'.repeat(32),
        RACE_WALLET,
        '4'.repeat(64),
        '5'.repeat(32),
        '00000000-0000-4000-8000-999999999999',
        newerTimestamp,
        newerTimestamp,
        newerTimestamp,
      )
      .run();
    await assert.rejects(loadRevealSubmissionStorageControl(env.OPS_DB));
    await env.OPS_DB.prepare(`UPDATE reveal_submissions
      SET status = 'confirmed', confirmed_at_ms = updated_at_ms, revision = revision + 1
      WHERE drop_id = 'baseline' AND box_asset_id = ?`)
      .bind(String(0).padStart(32, '0'))
      .run();
    assert.equal((await loadRevealSubmissionStorageControl(env.OPS_DB)).source, 'd1');
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
        storage_source = 'firestore',
        revision = revision + 1,
        updated_at_ms = updated_at_ms + 1,
        cutover_at_ms = NULL
      WHERE singleton = 1`).run());
    assert.deepEqual(await env.OPS_DB.prepare(`SELECT storage_source, revision
      FROM wallet_session_storage_control WHERE singleton = 1`).first(), {
      storage_source: 'd1',
      revision: 3,
    });
    assert.deepEqual(await resolveD1WalletSession(env.OPS_DB, 'missing-firebase-uid'), {
      wallet: null,
      reason: 'legacy_uid_invalid',
    });
    assert.deepEqual(await resolveD1WalletSession(env.OPS_DB, RACE_WALLET), {
      wallet: RACE_WALLET,
      source: 'legacy_uid',
    });
    await assert.rejects(establishD1WalletSession({
      baseline: null,
      db: env.OPS_DB,
      authSubject: 'invalid-wallet-session-uid',
      nowMs: 1_000,
      wallet: '1'.repeat(45),
    }), /Wallet-session data is invalid/);
    assert.equal((await env.OPS_DB.prepare(
      'SELECT COUNT(*) AS count FROM wallet_sessions WHERE auth_subject = ?',
    ).bind('invalid-wallet-session-uid').first<{ count: number }>())?.count, 0);
    const sessionUid = 'runtime-wallet-session-uid';
    const initialSession = await establishD1WalletSession({
      baseline: null,
      db: env.OPS_DB,
      authSubject: sessionUid,
      nowMs: 1_000,
      wallet: PROFILE_WALLET,
    });
    assert.equal(initialSession.walletRevision, 1);
    const reboundSession = await establishD1WalletSession({
      baseline: initialSession,
      db: env.OPS_DB,
      authSubject: sessionUid,
      nowMs: 2_000,
      wallet: RACE_WALLET,
    });
    assert.equal(reboundSession.walletRevision, 2);
    await assert.rejects(
      establishD1WalletSession({
        baseline: initialSession,
        db: env.OPS_DB,
        authSubject: sessionUid,
        nowMs: 3_000,
        wallet: PROFILE_WALLET,
      }),
      WalletSessionD1SupersededError,
    );
    const lease = await acquireWalletSessionReconcileLease({
      db: env.OPS_DB,
      authSubject: sessionUid,
      leaseId: '00000000-0000-4000-8000-000000000001',
      nowMs: 4_000,
    });
    assert.equal(lease?.wallet, RACE_WALLET);
    const renewedDuringLease = await establishD1WalletSession({
      baseline: reboundSession,
      db: env.OPS_DB,
      authSubject: sessionUid,
      nowMs: 5_000,
      wallet: RACE_WALLET,
    });
    assert.equal(renewedDuringLease.wallet, RACE_WALLET);
    assert.equal(renewedDuringLease.walletRevision, 3);
    await assert.rejects(
      establishD1WalletSession({
        baseline: reboundSession,
        db: env.OPS_DB,
        authSubject: sessionUid,
        nowMs: 5_500,
        wallet: PROFILE_WALLET,
      }),
      WalletSessionD1SupersededError,
    );
    await assert.rejects(
      establishD1WalletSession({
        baseline: renewedDuringLease,
        db: env.OPS_DB,
        authSubject: sessionUid,
        nowMs: 6_000,
        wallet: PROFILE_WALLET,
      }),
      WalletSessionD1BusyError,
    );
    await releaseWalletSessionReconcileLease(env.OPS_DB, sessionUid, lease!.id);
    const releasedSession = await loadD1WalletSession(env.OPS_DB, sessionUid);
    assert.equal(releasedSession?.reconcileLeaseId, null);
    const reboundAfterRelease = await establishD1WalletSession({
      baseline: releasedSession,
      db: env.OPS_DB,
      authSubject: sessionUid,
      nowMs: 7_000,
      wallet: PROFILE_WALLET,
    });
    assert.equal(reboundAfterRelease.wallet, PROFILE_WALLET);
    const expiringLease = await acquireWalletSessionReconcileLease({
      db: env.OPS_DB,
      authSubject: sessionUid,
      leaseId: '00000000-0000-4000-8000-000000000002',
      nowMs: 20_000,
    });
    await releaseWalletSessionReconcileLease(
      env.OPS_DB,
      sessionUid,
      '00000000-0000-4000-8000-000000000099',
    );
    await assert.rejects(acquireWalletSessionReconcileLease({
      db: env.OPS_DB,
      authSubject: sessionUid,
      leaseId: '00000000-0000-4000-8000-000000000003',
      nowMs: 21_000,
    }), WalletSessionD1BusyError);
    const reclaimedLease = await acquireWalletSessionReconcileLease({
      db: env.OPS_DB,
      authSubject: sessionUid,
      leaseId: '00000000-0000-4000-8000-000000000004',
      nowMs: expiringLease!.expiresAtMs + 1,
    });
    assert.equal(reclaimedLease?.id, '00000000-0000-4000-8000-000000000004');
    await releaseWalletSessionReconcileLease(env.OPS_DB, sessionUid, reclaimedLease!.id);
    await establishD1WalletSession({
      baseline: null,
      db: env.OPS_DB,
      authSubject: 'duplicate-wallet-session-uid',
      nowMs: 8_000,
      wallet: PROFILE_WALLET,
    });
    assert.equal((await env.OPS_DB.prepare(
      'SELECT COUNT(*) AS count FROM wallet_sessions WHERE wallet = ?',
    ).bind(PROFILE_WALLET).first<{ count: number }>())?.count, 2);
    assert.deepEqual(await resolveD1WalletSession(env.OPS_DB, sessionUid), {
      wallet: PROFILE_WALLET,
      source: 'session',
    });
    await assert.rejects(env.OPS_DB.prepare(`UPDATE wallet_session_storage_control
      SET storage_source = 'firestore', revision = revision + 1, updated_at_ms = 11_000
      WHERE singleton = 1`).run());
    await assert.rejects(env.OPS_DB.prepare(`UPDATE wallet_session_storage_control
      SET revision = revision + 1, updated_at_ms = 11_000
      WHERE singleton = 1`).run());
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
      providerFetch: async () => assert.fail('D1 profile read reached Firestore'),
      signal: new AbortController().signal,
    }), 'owner@example.com');
    const missingWallet = 'So11111111111111111111111111111111111111112';
    assert.equal(await profileReadTestHooks.loadProfileEmail({
      db: env.OPS_DB,
      nowMs: 4_000,
      ownerWallet: missingWallet,
      providerFetch: async () => assert.fail('D1-only profile read reached Firestore'),
      signal: new AbortController().signal,
    }), undefined);
    await assert.rejects(deliveryPrepareTestHooks.loadAddress({
      requestCommerceDocument: firestoreProviderCommerceRequester,
      commerceDb: createCommerceD1(),
      nowMs: 4_000,
      providerFetch: async () => assert.fail('D1-only address read reached Firestore'),
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
