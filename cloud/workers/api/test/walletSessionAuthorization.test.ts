import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1 } from './commerceD1Harness.ts';
import { Keypair } from '@solana/web3.js';
import { adminIrlRedeemPrepareTestHooks } from '../src/adminIrlRedeemPrepare.js';
import { deliveryPrepareTestHooks } from '../src/deliveryPrepare.js';
import { deliveryReceiptTestHooks } from '../src/deliveryReceipts.js';
import { irlClaimTestHooks } from '../src/irlClaim.js';
import { revealDudesTestHooks } from '../src/revealDudes.js';
import { D1CommerceRepository } from '../src/commerceRepository.js';

const AUTH_SUBJECT = 'anon:00000000-0000-4000-8000-000000000001';
const WALLET = Keypair.generate().publicKey.toBase58();

function authWalletBindingDb(): D1Database {
  return {
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
    prepare: (sql: string) => {
      assert.match(sql, /FROM auth_wallet_bindings/);
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
          updated_at_ms: 1_700_000_000_000,
          revision: 1,
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

test('delivery, reveal, claim, receipt, and admin authorization load auth-wallet bindings only from D1', async () => {
  let providerRequests = 0;
  const commerceDb = createCommerceD1();
  const context = {
    commerceDb,
    repository: new D1CommerceRepository(commerceDb),
    nowMs: 1_700_000_000_000,
    providerFetch: async () => {
      providerRequests += 1;
      throw new Error('Wallet authorization must not request an external provider');
    },
    signal: new AbortController().signal,
  };
  const db = authWalletBindingDb();
  const loaders = [
    deliveryPrepareTestHooks.loadBoundWallet,
    revealDudesTestHooks.loadBoundWallet,
    irlClaimTestHooks.loadBoundWallet,
    deliveryReceiptTestHooks.loadBoundWallet,
    adminIrlRedeemPrepareTestHooks.loadBoundWallet,
  ];
  for (const loadBoundWallet of loaders) {
    assert.equal(await loadBoundWallet(context, db, AUTH_SUBJECT), WALLET);
  }
  assert.equal(providerRequests, 0);
});
