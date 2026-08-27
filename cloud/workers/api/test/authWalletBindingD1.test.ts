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

function bindingDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync('cloud/workers/api/ops-migrations/0001_current_schema.sql', 'utf8'));
  return database;
}

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
