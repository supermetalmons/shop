import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { d1Database } from './commerceD1Harness.ts';
import {
  AuthWalletBindingD1BusyError,
  AuthWalletBindingD1SupersededError,
  acquireAuthWalletBindingReconcileLease,
  establishD1AuthWalletBinding,
  loadD1AuthWalletBinding,
  releaseAuthWalletBindingReconcileLease,
  resolveD1AuthWalletBinding,
} from '../src/authWalletBindingD1.ts';

const WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';
const NOW_MS = 1_700_000_000_000;

function migration(name: string): string {
  return readFileSync(`cloud/workers/api/ops-migrations/${name}`, 'utf8');
}

function legacyDatabase(seedCount = 0): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const name of [
    '0006_wallet_sessions.sql',
    '0007_wallet_sessions_d1_only.sql',
    '0014_auth_subject_bridge.sql',
    '0015_auth_subject_cutover.sql',
  ]) database.exec(migration(name));
  const insert = database.prepare(`INSERT INTO wallet_sessions (
    auth_subject, wallet, expires_at_ms, updated_at_ms, wallet_revision,
    reconcile_lease_id, reconcile_lease_expires_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (let index = 0; index < seedCount; index += 1) {
    const leased = index === seedCount - 1;
    insert.run(
      `legacy-${index}`,
      WALLET,
      index % 2 ? 253_402_300_799_999 : NOW_MS + index,
      NOW_MS + index,
      index + 1,
      leased ? '00000000-0000-4000-8000-000000000001' : null,
      leased ? NOW_MS + 120_000 : null,
    );
  }
  return database;
}

function bindingDatabase(seedCount = 0): DatabaseSync {
  const database = legacyDatabase(seedCount);
  database.exec(migration('0017_auth_wallet_bindings.sql'));
  return database;
}

test('auth-wallet migration preserves mappings, revisions, timestamps, and leases', () => {
  const database = legacyDatabase(1_205);
  const expected = database.prepare(`SELECT
    auth_subject,
    wallet,
    updated_at_ms,
    wallet_revision AS revision,
    reconcile_lease_id,
    reconcile_lease_expires_at_ms
    FROM wallet_sessions
    ORDER BY auth_subject`).all().map((row) => ({ ...row }));
  database.exec(migration('0017_auth_wallet_bindings.sql'));
  assert.deepEqual(
    database.prepare('SELECT * FROM auth_wallet_bindings ORDER BY auth_subject').all().map((row) => ({ ...row })),
    expected,
  );
  assert.equal(expected.length, 1_205);
  assert.deepEqual(
    database.prepare('PRAGMA table_info(auth_wallet_bindings)').all().map((row) => String(row.name)),
    [
      'auth_subject',
      'wallet',
      'updated_at_ms',
      'revision',
      'reconcile_lease_id',
      'reconcile_lease_expires_at_ms',
    ],
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'wallet_sessions'").get()!.count, 0);
});

test('auth-wallet resolution never creates a wallet-shaped fallback binding', async () => {
  const database = bindingDatabase();
  const db = d1Database(database);
  assert.deepEqual(await resolveD1AuthWalletBinding(db, WALLET), {
    wallet: null,
    reason: 'missing-binding',
  });
  assert.equal(await acquireAuthWalletBindingReconcileLease({
    authSubject: WALLET,
    db,
    nowMs: NOW_MS,
  }), null);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM auth_wallet_bindings').get()!.count, 0);
});

test('auth-wallet binding operations remain optimistic and lease-safe', async () => {
  const database = bindingDatabase();
  const db = d1Database(database);
  const created = await establishD1AuthWalletBinding({
    baseline: null,
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS,
    wallet: WALLET,
  });
  assert.equal(created.revision, 1);
  const renewed = await establishD1AuthWalletBinding({
    baseline: created,
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS + 1,
    wallet: WALLET,
  });
  assert.equal(renewed.revision, 2);
  const lease = await acquireAuthWalletBindingReconcileLease({
    authSubject: 'canonical-subject',
    db,
    leaseId: '00000000-0000-4000-8000-000000000002',
    nowMs: NOW_MS + 2,
  });
  assert.equal(lease?.wallet, WALLET);
  await assert.rejects(establishD1AuthWalletBinding({
    baseline: renewed,
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS + 3,
    wallet: OTHER_WALLET,
  }), AuthWalletBindingD1BusyError);
  await releaseAuthWalletBindingReconcileLease(db, 'canonical-subject', lease!.id);
  const released = await loadD1AuthWalletBinding(db, 'canonical-subject');
  const rebound = await establishD1AuthWalletBinding({
    baseline: released,
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS + 4,
    wallet: OTHER_WALLET,
  });
  assert.equal(rebound.revision, 3);
  await assert.rejects(establishD1AuthWalletBinding({
    baseline: renewed,
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS + 5,
    wallet: WALLET,
  }), AuthWalletBindingD1SupersededError);
  assert.deepEqual(await resolveD1AuthWalletBinding(db, 'canonical-subject'), {
    wallet: OTHER_WALLET,
    source: 'binding',
  });
});
