import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { d1Database } from './commerceD1Harness.ts';
import {
  acquireWalletSessionReconcileLease,
  establishD1WalletSession,
  loadD1WalletSession,
  releaseWalletSessionReconcileLease,
} from '../src/walletSessionD1.ts';

const WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';
const NOW_MS = 1_700_000_000_000;

function migration(name: string): string {
  return readFileSync(`cloud/workers/api/ops-migrations/${name}`, 'utf8');
}

function bridgeDatabase(seedCount = 0): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(migration('0006_wallet_sessions.sql'));
  database.exec(migration('0007_wallet_sessions_d1_only.sql'));
  const insert = database.prepare(`INSERT INTO wallet_sessions (
    firebase_uid, wallet, expires_at_ms, updated_at_ms, wallet_revision,
    reconcile_lease_id, reconcile_lease_expires_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (let index = 0; index < seedCount; index += 1) {
    const leased = index === seedCount - 1;
    insert.run(
      `legacy-${index}`,
      WALLET,
      253_402_300_799_999,
      NOW_MS + index,
      index + 1,
      leased ? '00000000-0000-4000-8000-000000000001' : null,
      leased ? NOW_MS + 120_000 : null,
    );
  }
  database.exec(migration('0014_auth_subject_bridge.sql'));
  return database;
}

test('auth-subject bridge preserves all rows, revisions, and leases', () => {
  const database = bridgeDatabase(1_205);
  assert.deepEqual({ ...database.prepare(`SELECT
      COUNT(*) AS count,
      COUNT(DISTINCT firebase_uid) AS legacy_count,
      COUNT(DISTINCT auth_subject) AS canonical_count,
      SUM(firebase_uid = auth_subject) AS synchronized_count
    FROM wallet_sessions`).get() }, {
    count: 1_205,
    legacy_count: 1_205,
    canonical_count: 1_205,
    synchronized_count: 1_205,
  });
  assert.deepEqual({ ...database.prepare(`SELECT
      wallet_revision,
      reconcile_lease_id,
      reconcile_lease_expires_at_ms
    FROM wallet_sessions
    WHERE auth_subject = ?`).get('legacy-1204') }, {
    wallet_revision: 1_205,
    reconcile_lease_id: '00000000-0000-4000-8000-000000000001',
    reconcile_lease_expires_at_ms: NOW_MS + 120_000,
  });
});

test('old and new workers can insert, read, renew, and lease through the bridge', async () => {
  const database = bridgeDatabase();
  database.prepare(`INSERT INTO wallet_sessions (
      firebase_uid, wallet, expires_at_ms, updated_at_ms, wallet_revision,
      reconcile_lease_id, reconcile_lease_expires_at_ms
    ) VALUES (?, ?, ?, ?, 1, NULL, NULL)
    ON CONFLICT (firebase_uid) DO NOTHING`)
    .run('legacy-subject', WALLET, 253_402_300_799_999, NOW_MS);
  assert.deepEqual({ ...database.prepare(
    'SELECT firebase_uid, auth_subject FROM wallet_sessions WHERE firebase_uid = ?',
  ).get('legacy-subject') }, {
    firebase_uid: 'legacy-subject',
    auth_subject: 'legacy-subject',
  });

  const db = d1Database(database);
  const created = await establishD1WalletSession({
    baseline: null,
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS,
    wallet: WALLET,
  });
  assert.equal(created.authSubject, 'canonical-subject');
  assert.deepEqual({ ...database.prepare(
    'SELECT firebase_uid, auth_subject FROM wallet_sessions WHERE auth_subject = ?',
  ).get('canonical-subject') }, {
    firebase_uid: 'canonical-subject',
    auth_subject: 'canonical-subject',
  });

  const rebound = await establishD1WalletSession({
    baseline: created,
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS + 1,
    wallet: OTHER_WALLET,
  });
  assert.equal(rebound.wallet, OTHER_WALLET);
  assert.equal(rebound.walletRevision, 2);

  const lease = await acquireWalletSessionReconcileLease({
    authSubject: 'canonical-subject',
    db,
    leaseId: '00000000-0000-4000-8000-000000000002',
    nowMs: NOW_MS + 2,
  });
  assert.equal(lease?.wallet, OTHER_WALLET);
  await releaseWalletSessionReconcileLease(db, 'canonical-subject', lease!.id);
  assert.equal((await loadD1WalletSession(db, 'canonical-subject'))?.reconcileLeaseId, null);
});

test('auth-subject bridge rejects mixed identities and duplicate cross-path inserts', () => {
  const database = bridgeDatabase();
  assert.throws(() => database.prepare(`INSERT INTO wallet_sessions (
      firebase_uid, auth_subject, wallet, expires_at_ms, updated_at_ms, wallet_revision,
      reconcile_lease_id, reconcile_lease_expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, 1, NULL, NULL)`)
    .run('legacy-a', 'canonical-b', WALLET, 253_402_300_799_999, NOW_MS));

  database.prepare(`INSERT INTO wallet_sessions (
      auth_subject, wallet, expires_at_ms, updated_at_ms, wallet_revision,
      reconcile_lease_id, reconcile_lease_expires_at_ms
    ) VALUES (?, ?, ?, ?, 1, NULL, NULL)`)
    .run('same-subject', WALLET, 253_402_300_799_999, NOW_MS);
  assert.throws(() => database.prepare(`INSERT INTO wallet_sessions (
      firebase_uid, wallet, expires_at_ms, updated_at_ms, wallet_revision,
      reconcile_lease_id, reconcile_lease_expires_at_ms
    ) VALUES (?, ?, ?, ?, 1, NULL, NULL)`)
    .run('same-subject', WALLET, 253_402_300_799_999, NOW_MS));
});
