import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { d1Database, type CommerceD1CallObservation } from './commerceD1Harness.ts';
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

for (const operation of ['create', 'renew', 'rebind'] as const) {
  test(`auth-wallet ${operation} returns its committed row with two D1 calls`, async () => {
    const database = bindingDatabase();
    const baseline = operation === 'create' ? null : await establishD1AuthWalletBinding({
      baseline: null,
      db: d1Database(database),
      authSubject: 'canonical-subject',
      nowMs: NOW_MS,
      wallet: WALLET,
    });
    const wallet = operation === 'rebind' ? OTHER_WALLET : WALLET;
    const calls: CommerceD1CallObservation[] = [];
    const db = d1Database(database, ({ sql }) => {
      if (/^(INSERT|UPDATE)/.test(sql)) {
        database.prepare(`UPDATE auth_wallet_bindings
          SET wallet = ?, revision = revision + 1, updated_at_ms = ?
          WHERE auth_subject = ?`)
          .run(wallet === WALLET ? OTHER_WALLET : WALLET, NOW_MS + 2, 'canonical-subject');
      }
    }, undefined, (call) => calls.push(call));
    const committed = await establishD1AuthWalletBinding({
      baseline,
      db,
      authSubject: 'canonical-subject',
      nowMs: NOW_MS + 1,
      wallet,
    });
    assert.deepEqual(committed, {
      authSubject: 'canonical-subject',
      wallet,
      updatedAtMs: NOW_MS + 1,
      revision: baseline ? 2 : 1,
      reconcileLeaseId: null,
      reconcileLeaseExpiresAtMs: null,
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.method), ['first', 'first']);
    const latest = await loadD1AuthWalletBinding(d1Database(database), 'canonical-subject');
    assert.notEqual(latest?.wallet, committed.wallet);
    assert.equal(latest?.revision, committed.revision + 1);
  });

  for (const cancelAfter of ['read', 'write'] as const) {
    test(`auth-wallet ${operation} respects cancellation after its ${cancelAfter}`, async () => {
      const database = bindingDatabase();
      const baseline = operation === 'create' ? null : await establishD1AuthWalletBinding({
        baseline: null,
        db: d1Database(database),
        authSubject: 'canonical-subject',
        nowMs: NOW_MS,
        wallet: WALLET,
      });
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const calls: CommerceD1CallObservation[] = [];
      const db = d1Database(database, ({ sql }) => {
        if (cancelAfter === 'read' ? sql.startsWith('SELECT') : /^(INSERT|UPDATE)/.test(sql)) {
          controller.abort(reason);
        }
      }, undefined, (call) => calls.push(call));
      await assert.rejects(establishD1AuthWalletBinding({
        baseline,
        db,
        authSubject: 'canonical-subject',
        nowMs: NOW_MS + 1,
        signal: controller.signal,
        wallet: operation === 'rebind' ? OTHER_WALLET : WALLET,
      }), (error) => error === reason);
      assert.equal(calls.length, cancelAfter === 'read' ? 1 : 2);
      const stored = await loadD1AuthWalletBinding(d1Database(database), 'canonical-subject');
      assert.equal(stored?.revision ?? 0, (baseline?.revision ?? 0) + (cancelAfter === 'write' ? 1 : 0));
    });
  }
}

test('auth-wallet creation retries when another request inserts the same binding first', async () => {
  const database = bindingDatabase();
  const calls: CommerceD1CallObservation[] = [];
  let raced = false;
  const db = d1Database(database, ({ sql }) => {
    if (!raced && sql.startsWith('SELECT')) {
      raced = true;
      database.prepare(`INSERT INTO auth_wallet_bindings
        (auth_subject, wallet, updated_at_ms, revision)
        VALUES (?, ?, ?, 1)`)
        .run('canonical-subject', WALLET, NOW_MS);
    }
  }, undefined, (call) => calls.push(call));
  const binding = await establishD1AuthWalletBinding({
    baseline: null,
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS + 1,
    wallet: WALLET,
  });
  assert.equal(binding.revision, 2);
  assert.equal(binding.updatedAtMs, NOW_MS + 1);
  assert.equal(calls.length, 4);
});

for (const operation of ['renew', 'rebind'] as const) {
  test(`auth-wallet ${operation} rejects a superseding write during its first attempt`, async () => {
    const database = bindingDatabase();
    const baseline = await establishD1AuthWalletBinding({
      baseline: null,
      db: d1Database(database),
      authSubject: 'canonical-subject',
      nowMs: NOW_MS,
      wallet: WALLET,
    });
    let raced = false;
    const calls: CommerceD1CallObservation[] = [];
    const db = d1Database(database, ({ sql }) => {
      if (!raced && sql.startsWith('SELECT')) {
        raced = true;
        database.prepare(`UPDATE auth_wallet_bindings
          SET wallet = ?, revision = revision + 1 WHERE auth_subject = ?`)
          .run(operation === 'renew' ? OTHER_WALLET : WALLET, 'canonical-subject');
      }
    }, undefined, (call) => calls.push(call));
    await assert.rejects(establishD1AuthWalletBinding({
      baseline,
      db,
      authSubject: 'canonical-subject',
      nowMs: NOW_MS + 1,
      wallet: operation === 'renew' ? WALLET : OTHER_WALLET,
    }), AuthWalletBindingD1SupersededError);
    assert.equal(calls.length, 3);
    assert.equal((await loadD1AuthWalletBinding(d1Database(database), 'canonical-subject'))?.revision, 2);
  });
}

test('auth-wallet rebinding clears an expired lease in its returned row', async () => {
  const database = bindingDatabase();
  const db = d1Database(database);
  const baseline = await establishD1AuthWalletBinding({
    baseline: null,
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS,
    wallet: WALLET,
  });
  const lease = await acquireAuthWalletBindingReconcileLease({
    db,
    authSubject: 'canonical-subject',
    nowMs: NOW_MS + 1,
  });
  const rebound = await establishD1AuthWalletBinding({
    baseline,
    db,
    authSubject: 'canonical-subject',
    nowMs: lease!.expiresAtMs,
    wallet: OTHER_WALLET,
  });
  assert.equal(rebound.wallet, OTHER_WALLET);
  assert.equal(rebound.revision, 2);
  assert.equal(rebound.reconcileLeaseId, null);
  assert.equal(rebound.reconcileLeaseExpiresAtMs, null);
});

test('auth-wallet establishment performs no D1 calls when already cancelled', async () => {
  const database = bindingDatabase();
  const calls: CommerceD1CallObservation[] = [];
  const reason = new Error('cancelled');
  await assert.rejects(establishD1AuthWalletBinding({
    baseline: null,
    db: d1Database(database, undefined, undefined, (call) => calls.push(call)),
    authSubject: 'canonical-subject',
    nowMs: NOW_MS,
    signal: AbortSignal.abort(reason),
    wallet: WALLET,
  }), (error) => error === reason);
  assert.equal(calls.length, 0);
});
