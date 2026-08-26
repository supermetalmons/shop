import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1 } from './commerceD1Harness.ts';
import { Keypair } from '@solana/web3.js';
import { adminIrlRedeemPrepareTestHooks } from '../src/adminIrlRedeemPrepare.js';
import { deliveryPrepareTestHooks } from '../src/deliveryPrepare.js';
import { deliveryReceiptTestHooks } from '../src/deliveryReceipts.js';
import { irlClaimTestHooks } from '../src/irlClaim.js';
import { revealDudesTestHooks } from '../src/revealDudes.js';

const AUTH_SUBJECT = 'anon:00000000-0000-4000-8000-000000000001';
const WALLET = Keypair.generate().publicKey.toBase58();

function walletSessionDb(): D1Database {
  return {
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
    prepare: (sql: string) => {
      assert.match(sql, /FROM wallet_sessions/);
      let authSubject: unknown;
      let statement: D1PreparedStatement;
      statement = {
        all: async () => { throw new Error('Unexpected D1 all'); },
        bind: (...values: unknown[]) => {
          [authSubject] = values;
          return statement;
        },
        first: async () => authSubject === AUTH_SUBJECT ? {
          auth_subject: AUTH_SUBJECT,
          wallet: WALLET,
          expires_at_ms: 253_402_300_799_999,
          updated_at_ms: 1_700_000_000_000,
          wallet_revision: 1,
          reconcile_lease_id: null,
          reconcile_lease_expires_at_ms: null,
        } : null,
        raw: async () => { throw new Error('Unexpected D1 raw'); },
        run: async () => { throw new Error('Unexpected D1 run'); },
      } as D1PreparedStatement;
      return statement;
    },
    withSession: () => { throw new Error('Unexpected D1 session'); },
  } as D1Database;
}

test('delivery, reveal, claim, receipt, and admin authorization load wallet sessions only from D1', async () => {
  let providerRequests = 0;
  const context = {
    commerceDb: createCommerceD1(),
    nowMs: 1_700_000_000_000,
    providerFetch: async () => {
      providerRequests += 1;
      throw new Error('Wallet authorization must not request an external provider');
    },
    signal: new AbortController().signal,
  };
  const db = walletSessionDb();
  const loaders = [
    deliveryPrepareTestHooks.loadWalletSession,
    revealDudesTestHooks.loadWalletSession,
    irlClaimTestHooks.loadWalletSession,
    deliveryReceiptTestHooks.loadWalletSession,
    adminIrlRedeemPrepareTestHooks.loadWalletSession,
  ];
  for (const loadWalletSession of loaders) {
    assert.equal(await loadWalletSession(context, db, AUTH_SUBJECT), WALLET);
  }
  assert.equal(providerRequests, 0);
});
