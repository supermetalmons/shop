import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { getPreorderConfig } from '../../../../shared/preorders.ts';
import { handlePreorderRequest, reconcilePendingPreorders } from '../src/preorders.ts';
import { PreorderStore, listSucceededPreorderAssets } from '../src/preorderStore.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

const config = getPreorderConfig('mi_note_cards_devnet')!;
const BUYER = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
type Overrides = NonNullable<Parameters<typeof handlePreorderRequest>[3]>;

function harness() {
  const database = createCommerceD1Harness();
  const store = new PreorderStore(database.db);
  let now = 1000;
  let wallet = BUYER;
  let outcome: 'pending' | 'confirmed' | 'failed' | 'expired' = 'pending';
  let valid = true;
  let prepares = 0;
  let authorizations = 0;
  let sends = 0;
  const rateKeys: string[] = [];
  const env = {
    COMMERCE_DB: database.db, OPS_DB: database.db, HELIUS_API_KEY: 'test', COSIGNER_SECRET: 'test',
    PREORDER_PREPARE_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { rateKeys.push(key); return { success: true }; } },
    PREORDER_PREPARE_IP_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { rateKeys.push(key); return { success: true }; } },
  } as Env;
  const deps: Overrides = {
    nowMs: () => now,
    verifyIdentity: async () => ({ kind: 'staff-wallet', wallet }),
    blockhashValid: async () => valid,
    prepare: async ({ ids }) => {
      prepares += 1;
      return { assets: ids.map((id) => ({ id, address: Keypair.generate().publicKey.toBase58() })),
        transactionBase64: `prepared-${prepares}`, blockhash: 'blockhash', lastValidBlockHeight: 100, blockhashContextSlot: 1 };
    },
    authorize: async ({ signedTransactionBase64 }) => {
      authorizations += 1;
      if (signedTransactionBase64 !== 'buyer-signed') throw new Error('unexpected transaction');
      return { transactionBase64: 'fully-signed', signature: 'signature' };
    },
    probe: async () => ({ status: outcome }),
    send: async () => {
      sends += 1;
      const rows = database.database.prepare("SELECT * FROM commerce_preorder_orders WHERE status = 'submitted'").all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].signed_transaction, 'fully-signed');
      assert.equal(rows[0].signature, 'signature');
      return 'signature';
    },
  };
  async function call(path: string, body: Record<string, unknown>, overrides: Overrides = {}) {
    const get = path === 'availability';
    const request = new Request(`https://mons.shop/preorders/${path}${get ? `?${new URLSearchParams(body as Record<string, string>)}` : ''}`, {
      method: get ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
      ...(get ? {} : { body: JSON.stringify(body) }),
    });
    const result = await handlePreorderRequest(request, env, {}, { ...deps, ...overrides });
    return { status: result.response.status, body: await result.response.json() as Record<string, any> };
  }
  const prepare = (cardIds = [1], requestId = crypto.randomUUID(), overrides: Overrides = {}) => call('prepare', {
    preorderId: config.preorderId, buyer: wallet, cardIds, requestId,
  }, overrides);
  return { ...database, store, env, deps, call, prepare, rateKeys,
    wallet: (value: string) => { wallet = value; }, time: (value: number) => { now = value; },
    outcome: (value: typeof outcome) => { outcome = value; }, valid: (value: boolean) => { valid = value; },
    counts: () => ({ prepares, authorizations, sends }) };
}

test('preorder preparation is idempotent, never renews a reservation, and rejects changed selections', async () => {
  const h = harness();
  const requestId = crypto.randomUUID();
  const first = await h.prepare([3, 1], requestId);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.order.cardIds, [1, 3]);
  h.time(2000);
  const second = await h.prepare([1, 3], requestId);
  assert.deepEqual(second.body, first.body);
  assert.equal(h.counts().prepares, 1);
  assert.equal(h.rateKeys.length, 3);
  assert.equal((await h.prepare([2], requestId)).status, 409);
});

test('overlapping concurrent claims are all or nothing', async () => {
  const h = harness();
  const first = await h.prepare([1, 2]);
  h.wallet(OTHER);
  const conflict = await h.prepare([2, 3]);
  assert.equal(first.status, 200);
  assert.equal(conflict.status, 409);
  assert.deepEqual((await h.store.claims(config.cluster, config.collection)).map((claim) => claim.id), [1, 2]);
  assert.equal(h.database.prepare('SELECT COUNT(*) AS count FROM commerce_preorder_orders').get()!.count, 1);
  const [left, right] = await Promise.all([h.prepare([4]), h.prepare([4])]);
  assert.deepEqual([left.status, right.status].sort(), [200, 409]);
});

test('one active preorder per authenticated wallet prevents reserving a second selection', async () => {
  const h = harness();
  assert.equal((await h.prepare()).status, 200);
  assert.equal((await h.prepare([2])).status, 409);
  assert.equal((await h.call('prepare', { preorderId: config.preorderId, buyer: OTHER, cardIds: [3], requestId: crypto.randomUUID() })).status, 403);
  assert.equal(h.counts().prepares, 1);
});

test('anonymous checkout requires the existing signed wallet binding and uses it instead of the body wallet', async () => {
  const h = harness();
  h.database.exec(`CREATE TABLE auth_wallet_bindings (
    auth_subject TEXT PRIMARY KEY, wallet TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL,
    reconcile_lease_id TEXT, reconcile_lease_expires_at_ms INTEGER)`);
  const auth: Overrides = { verifyIdentity: async () => ({ kind: 'anonymous', authSubject: 'session' }) };
  assert.equal((await h.prepare([1], crypto.randomUUID(), auth)).status, 401);
  h.database.prepare('INSERT INTO auth_wallet_bindings VALUES (?, ?, 1, 1, NULL, NULL)').run('session', OTHER);
  assert.equal((await h.prepare([1], crypto.randomUUID(), auth)).status, 403);
  h.wallet(OTHER);
  assert.equal((await h.prepare([1], crypto.randomUUID(), auth)).status, 200);
  assert.ok(h.rateKeys.includes(`wallet:${OTHER}`));
  assert.ok(h.rateKeys.includes('subject:session'));
});

test('invalid selections and disabled mainnet fail before preparing or signing', async () => {
  const h = harness();
  for (const ids of [[1, 1], [0], [1396], [1, 2, 3, 4]]) assert.equal((await h.prepare(ids)).status, 400);
  for (const path of ['status', 'prepare', 'submit', 'cancel']) {
    const response = await h.call(path, { preorderId: 'mi_note_cards',
      ...(path === 'prepare' ? { buyer: BUYER, cardIds: [1], requestId: crypto.randomUUID() } : {}),
      ...(['submit', 'cancel'].includes(path) ? { orderId: crypto.randomUUID() } : {}),
      ...(path === 'submit' ? { transactionBase64: 'buyer-signed' } : {}) });
    assert.equal(response.status, 409);
  }
  assert.deepEqual(h.counts(), { prepares: 0, authorizations: 0, sends: 0 });
});

test('prepare rate limits are enforced and idempotent retries do not consume them', async () => {
  const h = harness();
  h.env.PREORDER_PREPARE_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await h.prepare()).status, 429);
  assert.equal(h.counts().prepares, 0);
});

test('unsigned reservation expires after 120 seconds and expired request IDs are not renewed', async () => {
  const h = harness();
  const requestId = crypto.randomUUID();
  const first = await h.prepare([1], requestId);
  h.time(first.body.order.expiresAtMs);
  const repeat = await h.prepare([1], requestId);
  assert.equal(repeat.body.order.status, 'expired');
  assert.equal(repeat.body.transactionBase64, null);
  assert.equal(h.counts().prepares, 1);
  h.wallet(OTHER);
  assert.equal((await h.prepare([1])).status, 200);
});

test('invalid blockhash expires an unsigned order early without authority signing', async () => {
  const h = harness();
  const prepared = await h.prepare();
  h.valid(false);
  const result = await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' });
  assert.equal(result.body.order.status, 'expired');
  assert.deepEqual(h.counts(), { prepares: 1, authorizations: 0, sends: 0 });
});

test('authority-signed bytes are persisted before broadcasting and uncertain submission keeps claims', async () => {
  const h = harness();
  const prepared = await h.prepare([1, 2, 3]);
  const result = await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' });
  assert.equal(result.body.order.status, 'submitted');
  assert.equal(h.counts().sends, 1);
  h.time(999999);
  await h.call('cancel', { preorderId: config.preorderId, orderId: prepared.body.order.orderId });
  assert.equal((await h.store.get(prepared.body.order.orderId))!.status, 'submitted');
  assert.equal((await h.store.claims(config.cluster, config.collection)).length, 3);
});

test('cancellation winning while submit signs prevents broadcasting the lost candidate', async () => {
  const h = harness();
  const prepared = await h.prepare();
  const result = await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' }, {
    authorize: async () => {
      await h.call('cancel', { preorderId: config.preorderId, orderId: prepared.body.order.orderId });
      return { transactionBase64: 'fully-signed', signature: 'signature' };
    },
  });
  assert.equal(result.body.order.status, 'cancelled');
  assert.equal(h.counts().sends, 0);
  assert.equal((await h.store.claims(config.cluster, config.collection)).length, 0);
});

test('database submission failure cannot broadcast an authority signature', async () => {
  const h = harness();
  const prepared = await h.prepare();
  h.database.exec(`CREATE TRIGGER test_submission_failure BEFORE UPDATE ON commerce_preorder_orders
    WHEN NEW.status = 'submitted' BEGIN SELECT RAISE(ABORT, 'simulated storage outage'); END;`);
  const result = await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' });
  assert.equal(result.status, 500);
  assert.equal(h.counts().sends, 0);
  assert.equal((await h.store.get(prepared.body.order.orderId))!.status, 'prepared');
});

test('the first broadcast precedes recovery probes and survives a failed probe', async () => {
  const h = harness();
  const prepared = await h.prepare();
  const result = await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' }, {
    probe: async () => {
      assert.equal(h.counts().sends, 1);
      throw new Error('network unavailable');
    },
  });
  assert.equal(result.body.order.status, 'submitted');
  assert.equal(h.counts().sends, 1);
  h.outcome('confirmed');
  await h.call('status', { preorderId: config.preorderId, orderId: prepared.body.order.orderId });
  assert.equal((await h.store.get(prepared.body.order.orderId))!.status, 'succeeded');
  assert.equal(h.counts().sends, 1);
  assert.equal(h.counts().prepares, 1);
});

test('status polling and scheduled recovery broadcast persisted submissions after a crash', async () => {
  for (const recovery of ['status', 'scheduled']) {
    const h = harness();
    const prepared = await h.prepare();
    const order = (await h.store.get(prepared.body.order.orderId))!;
    await h.store.submit(order, { transactionBase64: 'fully-signed', signature: 'signature' }, 2000);
    h.time(3000);
    assert.equal(h.counts().sends, 0);
    if (recovery === 'status') {
      const result = await h.call('status', { preorderId: config.preorderId, orderId: order.orderId });
      assert.equal(result.body.order.status, 'submitted');
    } else {
      await reconcilePendingPreorders(h.env, new AbortController().signal, h.deps);
    }
    assert.equal(h.counts().sends, 1);
    assert.equal((await h.store.get(order.orderId))!.signedTransaction, 'fully-signed');
    assert.equal(h.counts().prepares, 1);
    assert.equal(h.counts().authorizations, 0);
  }
});

test('an uncertain first broadcast retains its transaction for status retry', async () => {
  const h = harness();
  const prepared = await h.prepare();
  let attempts = 0;
  const result = await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' }, {
    send: async () => { attempts += 1; throw new Error('network unavailable'); },
  });
  assert.equal(result.body.order.status, 'submitted');
  assert.equal(attempts, 1);
  assert.equal((await h.store.claims(config.cluster, config.collection)).length, 1);
  await h.call('status', { preorderId: config.preorderId, orderId: prepared.body.order.orderId });
  assert.deepEqual(h.counts(), { prepares: 1, authorizations: 1, sends: 1 });
});

test('finalized success permanently consumes IDs and exposes recent assets for verified inventory recovery', async () => {
  const h = harness();
  const prepared = await h.prepare([1, 1395]);
  await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' });
  h.outcome('confirmed');
  const result = await h.call('status', { preorderId: config.preorderId, orderId: prepared.body.order.orderId });
  assert.equal(result.body.order.status, 'succeeded');
  assert.equal((await h.call('availability', { preorderId: config.preorderId })).body.items[1394].status, 'preordered');
  h.wallet(OTHER);
  assert.equal((await h.prepare([1])).status, 409);
  assert.throws(() => h.database.exec('DELETE FROM commerce_preorder_claims'), /permanent/);
  assert.throws(() => h.database.exec('DELETE FROM commerce_preorder_orders'), /permanent/);
  assert.deepEqual((await listSucceededPreorderAssets(h.db, BUYER)).map((asset) => asset.id), [1, 1395]);
});

test('finalized failure or expiry releases claims but retains transaction history', async () => {
  for (const outcome of ['failed', 'expired'] as const) {
    const h = harness();
    const prepared = await h.prepare();
    await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' });
    h.outcome(outcome);
    const result = await h.call('status', { preorderId: config.preorderId, orderId: prepared.body.order.orderId });
    assert.equal(result.body.order.status, outcome);
    assert.equal((await h.store.claims(config.cluster, config.collection)).length, 0);
    assert.equal((await h.store.get(prepared.body.order.orderId))!.signedTransaction, 'fully-signed');
    h.wallet(OTHER);
    assert.equal((await h.prepare()).status, 200);
  }
});

test('foreign wallets cannot read, submit, or cancel another order', async () => {
  const h = harness();
  const prepared = await h.prepare();
  h.wallet(OTHER);
  for (const path of ['status', 'submit', 'cancel']) assert.equal((await h.call(path, {
    preorderId: config.preorderId, orderId: prepared.body.order.orderId,
    ...(path === 'submit' ? { transactionBase64: 'buyer-signed' } : {}),
  })).status, 403);
});

test('mainnet availability is public, collection-scoped, and does not expire or alter orders', async () => {
  const h = harness();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  const first = await h.prepare([1]);
  const template = (await h.store.get(first.body.order.orderId))!;
  const submitted = await h.store.submit(template, { transactionBase64: 'devnet-signed', signature: 'devnet-signature' }, 1000);
  await h.store.finish(submitted, 'succeeded', 1000);
  const mainnetOrder = await h.store.reserve({ ...template,
    orderId: crypto.randomUUID(), requestId: crypto.randomUUID(), preorderId: mainnet.preorderId,
    cluster: mainnet.cluster, collection: mainnet.collection, cardIds: [2],
    assets: [{ ...template.assets[0], id: 2, address: Keypair.generate().publicKey.toBase58() }],
    status: 'prepared',
  });
  const mainnetSubmitted = await h.store.submit(mainnetOrder, { transactionBase64: 'mainnet-signed', signature: 'mainnet-signature' }, 1000);
  await h.store.finish(mainnetSubmitted, 'succeeded', 1000);
  const expiring = await h.prepare([3]);
  h.time(1_000_000);
  const orders = h.database.prepare('SELECT * FROM commerce_preorder_orders ORDER BY order_id').all();
  const claims = h.database.prepare('SELECT * FROM commerce_preorder_claims ORDER BY order_id').all();
  const forbidden = async () => { throw new Error('Read-only availability must not authenticate or transact'); };
  const result = await h.call('availability', { preorderId: mainnet.preorderId }, {
    verifyIdentity: forbidden, prepare: forbidden, authorize: forbidden, probe: forbidden, send: forbidden,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.preorderId, mainnet.preorderId);
  assert.equal(result.body.items.length, 1395);
  assert.equal(result.body.items[0].status, 'available');
  assert.equal(result.body.items[1].status, 'preordered');
  assert.equal(result.body.items[2].status, 'available');
  assert.deepEqual(h.database.prepare('SELECT * FROM commerce_preorder_orders ORDER BY order_id').all(), orders);
  assert.deepEqual(h.database.prepare('SELECT * FROM commerce_preorder_claims ORDER BY order_id').all(), claims);
  assert.equal((await h.store.get(expiring.body.order.orderId))?.status, 'prepared');
  assert.equal((await h.call('availability', { preorderId: 'unknown' })).status, 409);
  const devnet = await h.call('availability', { preorderId: config.preorderId });
  assert.equal(devnet.body.items[0].status, 'preordered');
  assert.equal(devnet.body.items[1].status, 'available');
  assert.equal((await h.store.get(expiring.body.order.orderId))?.status, 'expired');
});
