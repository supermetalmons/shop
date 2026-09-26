import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { getPreorderConfig } from '../../../../shared/preorders.ts';
import { handlePreorderRequest, reconcilePendingPreorders } from '../src/preorders.ts';
import { PreorderStore, listPreorderInventoryAssets } from '../src/preorderStore.ts';
import { MiNoteAuthError } from '../src/miNoteAuth.ts';
import { loadMiNoteEligibility } from '../src/miNoteEligibility.ts';
import { verifyRequestIdentity } from '../src/requestIdentity.ts';
import { handleAnonymousAuthRequest } from '../src/anonymousAuth.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

const config = getPreorderConfig('mi_note_cards_devnet')!;
const BUYER = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const ETHEREUM = '0x0000000000000000000000000000000000000001';
const OTHER_ETHEREUM = '0x0000000000000000000000000000000000000002';
type Overrides = NonNullable<Parameters<typeof handlePreorderRequest>[3]>;

function harness(options?: Parameters<typeof createCommerceD1Harness>[0]) {
  const database = createCommerceD1Harness(options);
  const store = new PreorderStore(database.db);
  let now = 1000;
  let wallet = BUYER;
  let ethereumAddress = ETHEREUM;
  let signedIn = true;
  let ownedIds = Array.from({ length: 1395 }, (_, index) => index + 1);
  let outcome: 'pending' | 'confirmed' | 'finalized' | 'failed' | 'expired' = 'pending';
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
    verifyEthereumSession: async (_request, _db, preorderId) => ({ sessionId: 'proof', address: ethereumAddress, preorderId, origin: 'https://mons.shop', createdAtMs: now, expiresAtMs: now + 3_600_000 }),
    eligibility: async () => ({ cardIds: ownedIds, unavailableCardIds: [], ownershipStatus: 'success', requiresAdminSignIn: false }),
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
    probe: async () => ({ status: outcome, slot: 550 }),
    send: async ({ transactionBase64 }) => {
      sends += 1;
      const rows = database.database.prepare("SELECT * FROM commerce_preorder_orders WHERE status = 'submitted'").all();
      assert.ok(rows.some((row) => row.signed_transaction === transactionBase64 && row.signature === 'signature'));
      return 'signature';
    },
  };
  async function call(path: string, body: Record<string, unknown>, overrides: Overrides = {}) {
    const get = path === 'availability';
    const request = new Request(`https://mons.shop/preorders/${path}${get ? `?${new URLSearchParams(body as Record<string, string>)}` : ''}`, {
      method: get ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...(signedIn ? { Authorization: 'test-session' } : {}) },
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
    ethereum: (value: string) => { ethereumAddress = value; }, holdings: (value: number[]) => { ownedIds = value; },
    signedIn: (value: boolean) => { signedIn = value; },
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

test('availability and preparation require an Ethereum proof and only reveal its eligible cards', async () => {
  const h = harness();
  const rejected: Overrides = { verifyEthereumSession: async () => { throw new MiNoteAuthError('unauthenticated', 401, 'Verify your Ethereum wallet.'); } };
  assert.equal((await h.call('availability', { preorderId: config.preorderId }, rejected)).status, 401);
  assert.equal((await h.prepare([1], crypto.randomUUID(), rejected)).status, 401);
  h.holdings([2, 9]);
  const response = await h.call('availability', { preorderId: config.preorderId });
  assert.equal(response.body.ethereumAddress, ETHEREUM);
  assert.deepEqual(response.body.items, [{ id: 2, status: 'available' }, { id: 9, status: 'available' }]);
  assert.equal((await h.prepare([1])).status, 403);
  assert.equal(h.counts().prepares, 0);
  assert.equal((await h.prepare([2])).status, 200);
});

test('availability permits verified Ethereum access before a Solana wallet has signed in', async () => {
  const h = harness();
  h.database.exec(`CREATE TABLE auth_wallet_bindings (
    auth_subject TEXT PRIMARY KEY, wallet TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL,
    reconcile_lease_id TEXT, reconcile_lease_expires_at_ms INTEGER)`);
  h.holdings([9]);
  const response = await h.call('availability', { preorderId: config.preorderId }, {
    verifyIdentity: async () => ({ kind: 'anonymous', authSubject: 'ethereum-only-session' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items, [{ id: 9, status: 'available' }]);
  h.signedIn(false);
  const ethereumOnly = await h.call('availability', { preorderId: config.preorderId }, { verifyIdentity: verifyRequestIdentity });
  assert.equal(ethereumOnly.status, 200);
  assert.deepEqual(ethereumOnly.body.items, [{ id: 9, status: 'available' }]);
  h.signedIn(true);
  const invalidCredentials = await h.call('availability', { preorderId: config.preorderId }, { verifyIdentity: verifyRequestIdentity });
  assert.equal(invalidCredentials.status, 401);
});

for (const preorderId of ['mi_note_cards_devnet', 'mi_note_cards']) {
  test(`${preorderId} availability shows claimed cards only to their original Solana buyer with current Ethereum ownership`, async () => {
    const h = harness();
    h.holdings([1, 2, 3, 4, 5]);
    const claim = async (buyer: string, id: number, succeeded: boolean) => {
      h.wallet(buyer);
      const prepared = await h.call('prepare', { preorderId, buyer, cardIds: [id], requestId: crypto.randomUUID() });
      assert.equal(prepared.status, 200);
      if (succeeded) {
        const order = (await h.store.get(prepared.body.order.orderId))!;
        const submitted = await h.store.submit(order, { transactionBase64: 'signed', signature: `signature-${id}` }, 1000);
        await h.store.finish(submitted, 'succeeded', 1000);
      }
    };
    const availability = async () => {
      const response = await h.call('availability', { preorderId });
      assert.equal(response.status, 200);
      return response.body.items;
    };
    await claim(BUYER, 1, true);
    await claim(OTHER, 2, true);
    await claim(BUYER, 3, false);
    await claim(OTHER, 4, false);

    assert.deepEqual(await availability(), [
      { id: 2, status: 'preordered' }, { id: 4, status: 'reserved' }, { id: 5, status: 'available' },
    ]);
    h.wallet(BUYER);
    assert.deepEqual(await availability(), [
      { id: 1, status: 'preordered' }, { id: 3, status: 'reserved' }, { id: 5, status: 'available' },
    ]);
    h.signedIn(false);
    assert.deepEqual(await availability(), [{ id: 5, status: 'available' }]);

    h.ethereum(OTHER_ETHEREUM);
    h.holdings([1, 2, 5]);
    h.signedIn(true);
    assert.deepEqual(await availability(), [{ id: 1, status: 'preordered' }, { id: 5, status: 'available' }]);
    h.wallet(OTHER);
    assert.deepEqual(await availability(), [{ id: 2, status: 'preordered' }, { id: 5, status: 'available' }]);
    h.holdings([5]);
    assert.deepEqual(await availability(), [{ id: 5, status: 'available' }]);
  });
}

test('signed-in availability POST verifies the real anonymous cookie binding while ETH-only GET needs no Solana session', async () => {
  const h = harness();
  h.database.exec(`CREATE TABLE anonymous_auth_sessions (
    session_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, auth_subject TEXT NOT NULL, origin_hostname TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL, refreshed_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL);
    CREATE TABLE auth_wallet_bindings (
      auth_subject TEXT PRIMARY KEY, wallet TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL,
      reconcile_lease_id TEXT, reconcile_lease_expires_at_ms INTEGER)`);
  const headers = { Origin: 'https://mons.shop', 'X-Mons-CSRF': '1', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' };
  const auth = await handleAnonymousAuthRequest(new Request('https://mons.shop/auth/anonymous/session', {
    method: 'POST', headers, body: '{}',
  }), { OPS_DB: h.db, ANONYMOUS_AUTH_SESSION_RATE_LIMITER: { limit: async () => ({ success: true }) } }, '/auth/anonymous/session', 1000);
  assert.equal(auth.status, 201);
  const { subject } = await auth.json() as { subject: string };
  const cookie = auth.headers.get('Set-Cookie')!.split(';')[0];
  h.database.prepare('INSERT INTO auth_wallet_bindings VALUES (?, ?, 1000, 1, NULL, NULL)')
    .run(subject, 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz');
  h.ethereum('0xe26067c76fdbe877f48b0a8400cf5db8b47af0fe');
  const overrides = { ...h.deps, verifyIdentity: verifyRequestIdentity, eligibility: loadMiNoteEligibility, log: () => {} };
  const url = 'https://mons.shop/preorders/availability';
  const post = await handlePreorderRequest(new Request(url, {
    method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ preorderId: config.preorderId }),
  }), h.env, {}, overrides);
  assert.equal(post.response.status, 200);
  const available = await post.response.json() as { items: { id: number }[]; requiresAdminSignIn: boolean };
  assert.deepEqual(available.items.map((item) => item.id), Array.from({ length: 10 }, (_, index) => index + 1));
  assert.equal(available.requiresAdminSignIn, false);
  const get = await handlePreorderRequest(new Request(`${url}?preorderId=${config.preorderId}`), h.env, {}, overrides);
  assert.equal(get.response.status, 200);
  const publicAvailability = await get.response.json() as typeof available;
  assert.deepEqual(publicAvailability.items, []);
  assert.equal(publicAvailability.requiresAdminSignIn, true);
  const unsignedOrigin = await handlePreorderRequest(new Request(`${url}?preorderId=${config.preorderId}`, {
    headers: { Cookie: cookie, 'X-Mons-CSRF': '1' },
  }), h.env, {}, overrides);
  assert.equal(unsignedOrigin.response.status, 401);
});

test('orders bind Ethereum identity for idempotent retries and submission', async () => {
  const h = harness();
  const requestId = crypto.randomUUID();
  const prepared = await h.prepare([1], requestId);
  assert.equal(prepared.body.order.ethereumAddress, ETHEREUM);
  h.ethereum(OTHER_ETHEREUM);
  assert.equal((await h.prepare([1], requestId)).status, 403);
  const submitted = await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' });
  assert.equal(submitted.status, 403);
  assert.equal(h.counts().authorizations, 0);
  const cancelled = await h.call('cancel', { preorderId: config.preorderId, orderId: prepared.body.order.orderId });
  assert.equal(cancelled.body.order.status, 'cancelled');
});

test('ownership and proof expiry are rechecked before authority signing', async () => {
  const h = harness();
  const prepared = await h.prepare([1]);
  const input = { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' };
  h.holdings([]);
  assert.equal((await h.call('submit', input)).status, 403);
  h.holdings([1]);
  assert.equal((await h.call('submit', input, { eligibility: async () => {
    h.time(3_601_001);
    return { cardIds: [1], unavailableCardIds: [], ownershipStatus: 'success', requiresAdminSignIn: false };
  } })).status, 401);
  assert.equal(h.counts().authorizations, 0);
  assert.equal(h.counts().sends, 0);
});

test('devnet stub availability and mint authorization isolate both Ethereum test wallets', async () => {
  const h = harness();
  h.wallet('A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz');
  const realEligibility: Overrides = { eligibility: loadMiNoteEligibility };
  for (const [index, address] of ['0xe26067c76fdbe877f48b0a8400cf5db8b47af0fe', '0x5bfce4149f520fe0823dc8c0afaf979121e824ec'].entries()) {
    h.ethereum(address);
    const firstId = index * 10 + 1;
    const response = await h.call('availability', { preorderId: config.preorderId }, realEligibility);
    assert.deepEqual(response.body.items.map((item: { id: number }) => item.id), Array.from({ length: 10 }, (_, offset) => firstId + offset));
    assert.equal((await h.prepare([index ? 1 : 11], crypto.randomUUID(), realEligibility)).status, 403);
    const prepared = await h.prepare([firstId], crypto.randomUUID(), realEligibility);
    assert.equal(prepared.status, 200);
    h.outcome('finalized');
    const submitted = await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' }, realEligibility);
    assert.equal(submitted.body.order.status, 'succeeded');
  }
});

function markLegacy(h: ReturnType<typeof harness>, orderId: string): void {
  const trigger = h.database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'commerce_preorder_order_update_guard'").get()!.sql;
  h.database.exec('DROP TRIGGER commerce_preorder_order_update_guard');
  h.database.prepare('UPDATE commerce_preorder_orders SET ethereum_address = NULL WHERE order_id = ?').run(orderId);
  h.database.exec(String(trigger));
}

test('legacy unsigned orders can be cancelled but cannot obtain an authority signature', async () => {
  const h = harness();
  const prepared = await h.prepare([1]);
  markLegacy(h, prepared.body.order.orderId);
  assert.equal((await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' })).status, 409);
  assert.equal(h.counts().authorizations, 0);
  assert.equal((await h.call('cancel', { preorderId: config.preorderId, orderId: prepared.body.order.orderId })).body.order.status, 'cancelled');
});

test('database guards require normalized Ethereum identity on new orders and forbid changing it', async () => {
  const h = harness();
  const prepared = await h.prepare([1]);
  const order = (await h.store.get(prepared.body.order.orderId))!;
  await assert.rejects(h.store.reserve({ ...order, orderId: crypto.randomUUID(), requestId: crypto.randomUUID(), ethereumAddress: null }), /invalid preorder initial state/);
  await assert.rejects(h.db.prepare(`UPDATE commerce_preorder_orders SET ethereum_address = ?, status = 'cancelled', revision = revision + 1 WHERE order_id = ?`)
    .bind(OTHER_ETHEREUM, order.orderId).run(), /identity is immutable/);
  assert.equal((await h.store.get(order.orderId))!.ethereumAddress, ETHEREUM);
});

test('mainnet prepares and submits verified owned cards through the same checkout flow', async () => {
  const h = harness();
  const mainnet = getPreorderConfig('mi_note_cards')!;
  h.holdings([11]);
  const result = await h.call('prepare', { preorderId: mainnet.preorderId, buyer: BUYER, requestId: crypto.randomUUID(), cardIds: [11] });
  assert.equal(result.status, 200);
  const order = (await h.store.get(result.body.order.orderId))!;
  assert.equal(order.cluster, 'mainnet-beta');
  assert.equal(order.collection, mainnet.collection);
  assert.equal(order.ethereumAddress, ETHEREUM);
  h.outcome('finalized');
  const submitted = await h.call('submit', { preorderId: mainnet.preorderId, orderId: order.orderId, transactionBase64: 'buyer-signed' });
  assert.equal(submitted.body.order.status, 'succeeded');
});

test('submitted legacy orders and submitted retries recover without Ethereum verification', async () => {
  const h = harness();
  const prepared = await h.prepare([1]);
  const input = { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' };
  await h.call('submit', input);
  markLegacy(h, prepared.body.order.orderId);
  const noEthereum: Overrides = {
    verifyEthereumSession: async () => { throw new Error('Submitted funds must remain recoverable'); },
    eligibility: async () => { throw new Error('Submitted funds must remain recoverable'); },
  };
  assert.equal((await h.call('submit', input, noEthereum)).body.order.status, 'submitted');
  h.outcome('finalized');
  assert.equal((await h.call('status', { preorderId: config.preorderId, orderId: prepared.body.order.orderId }, noEthereum)).body.order.status, 'succeeded');
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

test('invalid selections and unknown collections fail before preparing or signing', async () => {
  const h = harness();
  for (const ids of [[1, 1], [0], [1396], [1, 2, 3, 4]]) assert.equal((await h.prepare(ids)).status, 400);
  for (const path of ['status', 'prepare', 'submit', 'cancel']) {
    const response = await h.call(path, { preorderId: 'unknown',
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
  h.outcome('finalized');
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
  h.outcome('finalized');
  const result = await h.call('status', { preorderId: config.preorderId, orderId: prepared.body.order.orderId });
  assert.equal(result.body.order.status, 'succeeded');
  assert.equal((await h.call('availability', { preorderId: config.preorderId })).body.items[1394].status, 'preordered');
  h.wallet(OTHER);
  const availability = await h.call('availability', { preorderId: config.preorderId });
  assert.equal(availability.body.items.some((item: { id: number }) => item.id === 1 || item.id === 1395), false);
  assert.equal((await h.prepare([1])).status, 409);
  assert.throws(() => h.database.exec('DELETE FROM commerce_preorder_claims'), /permanent/);
  assert.throws(() => h.database.exec('DELETE FROM commerce_preorder_orders'), /permanent/);
  assert.deepEqual((await listPreorderInventoryAssets(h.db, BUYER)).map((asset) => asset.id), [1, 1395]);
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

test('mainnet availability is verified, collection-scoped, and expires unsigned reservations', async () => {
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
  const forbidden = async () => { throw new Error('Availability must not prepare, sign, or broadcast'); };
  const result = await h.call('availability', { preorderId: mainnet.preorderId }, {
    prepare: forbidden, authorize: forbidden, probe: forbidden, send: forbidden,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.preorderId, mainnet.preorderId);
  assert.equal(result.body.items.length, 1395);
  assert.equal(result.body.items[0].status, 'available');
  assert.equal(result.body.items[1].status, 'preordered');
  assert.equal(result.body.items[2].status, 'available');
  assert.equal(result.body.ethereumAddress, ETHEREUM);
  assert.equal((await h.store.get(expiring.body.order.orderId))?.status, 'expired');
  assert.equal((await h.call('availability', { preorderId: 'unknown' })).status, 409);
  const devnet = await h.call('availability', { preorderId: config.preorderId });
  assert.equal(devnet.body.items[0].status, 'preordered');
  assert.equal(devnet.body.items[1].status, 'available');
  assert.equal((await h.store.get(expiring.body.order.orderId))?.status, 'expired');
});

for (const preorderId of ['mi_note_cards_devnet', 'mi_note_cards']) {
  test(`${preorderId} confirmed success keeps card claims while permitting the next checkout`, async () => {
    const h = harness();
    const prepare = (cardIds: number[]) => h.call('prepare', { preorderId, buyer: BUYER, cardIds, requestId: crypto.randomUUID() });
    const first = await prepare([1]);
    h.outcome('confirmed');
    const confirmed = await h.call('submit', { preorderId, orderId: first.body.order.orderId, transactionBase64: 'buyer-signed' });
    assert.equal(confirmed.body.order.status, 'submitted');
    assert.equal(confirmed.body.order.confirmedSlot, 550);
    assert.equal((await h.call('availability', { preorderId })).body.items.find((item: { id: number }) => item.id === 1).status, 'preordered');
    assert.equal((await h.store.active(preorderId, BUYER)), null);
    assert.equal((await prepare([1])).status, 409);
    const second = await prepare([2]);
    assert.equal(second.status, 200);
    assert.equal((await prepare([3])).status, 409);
    const snapshot = await h.call('status', { preorderId, includeRecoveries: true });
    assert.equal(snapshot.body.order.orderId, second.body.order.orderId);
    assert.deepEqual(snapshot.body.recoveries.map((order: { orderId: string }) => order.orderId), [first.body.order.orderId]);
    assert.equal(snapshot.body.nextRecoveryCursor, null);
    const uncertain = await h.call('status', { preorderId, orderId: first.body.order.orderId }, {
      probe: async () => { throw new Error('RPC timeout'); },
    });
    assert.equal(uncertain.body.order.status, 'submitted');
    assert.equal(uncertain.body.order.confirmedSlot, 550);
    const cancelled = await h.call('cancel', { preorderId, orderId: first.body.order.orderId });
    assert.equal(cancelled.body.order.status, 'submitted');
    const finalized = await h.call('status', { preorderId, orderId: first.body.order.orderId }, {
      probe: async () => ({ status: 'finalized', slot: 560 }),
    });
    assert.equal(finalized.body.order.status, 'succeeded');
    assert.equal(finalized.body.order.confirmedSlot, 560);
    await assert.rejects(h.db.prepare('DELETE FROM commerce_preorder_claims WHERE order_id = ?')
      .bind(first.body.order.orderId).run(), /permanent/);
    assert.equal((await h.call('status', { preorderId, includeRecoveries: true })).body.recoveries.length, 0);
  });
}

test('confirmed rollback releases only its own claims while another checkout remains active', async () => {
  for (const outcome of ['failed', 'expired'] as const) {
    const h = harness();
    const prepared = await h.prepare([1]);
    h.outcome('confirmed');
    await h.call('submit', { preorderId: config.preorderId, orderId: prepared.body.order.orderId, transactionBase64: 'buyer-signed' });
    const next = await h.prepare([2]);
    h.outcome(outcome);
    const rolledBack = await h.call('status', { preorderId: config.preorderId, orderId: prepared.body.order.orderId });
    assert.equal(rolledBack.body.order.status, outcome);
    assert.equal(rolledBack.body.order.confirmedSlot, 550);
    assert.deepEqual((await h.store.claims(config.cluster, config.collection)).map((claim) => claim.id), [2]);
    assert.equal((await h.store.active(config.preorderId, BUYER))?.orderId, next.body.order.orderId);
  }
});

test('confirmation CAS cannot revive terminal orders and a stale terminal write cannot erase confirmation', async () => {
  const h = harness();
  const prepared = await h.prepare([1]);
  const source = (await h.store.get(prepared.body.order.orderId))!;
  const submitted = await h.store.submit(source, { signature: 'signature', transactionBase64: 'fully-signed' }, 1100);
  const confirmed = await h.store.confirm(submitted, 550, 1200);
  const staleFailure = await h.store.finish(submitted, 'failed', 1300);
  assert.equal(staleFailure.status, 'submitted');
  assert.equal(staleFailure.confirmedSlot, 550);
  await assert.rejects(h.db.prepare(`UPDATE commerce_preorder_orders SET confirmed_slot = NULL,
    revision = revision + 1 WHERE order_id = ?`).bind(confirmed.orderId).run(), /confirmation is permanent/);
  const terminal = await h.store.finish(confirmed, 'failed', 1400);
  const staleConfirmation = await h.store.confirm(submitted, 560, 1500);
  assert.deepEqual(staleConfirmation, terminal);
  assert.equal((await h.store.claims(config.cluster, config.collection)).length, 0);
});

test('recovery discovery is paginated, wallet scoped, stable through finalization, and does not probe every order', async () => {
  const h = harness();
  const orders = [];
  for (let id = 1; id <= 22; id += 1) {
    const prepared = await h.prepare([id]);
    const source = (await h.store.get(prepared.body.order.orderId))!;
    const submitted = await h.store.submit(source, { signature: 'signature', transactionBase64: 'fully-signed' }, 1000);
    orders.push(await h.store.confirm(submitted, 500 + id, 1000));
  }
  orders.sort((left, right) => left.orderId.localeCompare(right.orderId));
  h.time(2000);
  const foreground = await h.prepare([23]);
  assert.equal(foreground.status, 200);
  const noProbe: Overrides = { probe: async () => { throw new Error('Discovery must only read recovery snapshots'); } };
  const first = await h.call('status', { preorderId: config.preorderId, includeRecoveries: true }, noProbe);
  assert.equal(first.status, 200);
  assert.equal(first.body.order.orderId, foreground.body.order.orderId);
  assert.deepEqual(first.body.recoveries.map((order: { orderId: string }) => order.orderId), orders.slice(0, 20).map((order) => order.orderId));
  assert.equal(typeof first.body.nextRecoveryCursor, 'string');
  await h.store.finish(orders[0], 'succeeded', 1100, 600);
  const second = await h.call('status', { preorderId: config.preorderId, includeRecoveries: true,
    recoveryCursor: first.body.nextRecoveryCursor }, noProbe);
  assert.equal(second.body.order.orderId, foreground.body.order.orderId);
  assert.deepEqual(second.body.recoveries.map((order: { orderId: string }) => order.orderId), orders.slice(20).map((order) => order.orderId));
  assert.equal(second.body.nextRecoveryCursor, null);
  const legacy = await h.call('status', { preorderId: config.preorderId });
  assert.equal(legacy.body.order.orderId, orders[1].orderId);
  assert.equal('recoveries' in legacy.body, false);
  assert.equal((await h.call('status', { preorderId: config.preorderId, includeRecoveries: true, recoveryCursor: 'invalid' })).status, 400);
  assert.equal((await h.call('status', { preorderId: config.preorderId, includeRecoveries: true, orderId: orders[1].orderId })).status, 400);
  assert.equal((await h.call('status', { preorderId: config.preorderId, recoveryCursor: first.body.nextRecoveryCursor })).status, 400);
  h.wallet(OTHER);
  const other = await h.call('status', { preorderId: config.preorderId, includeRecoveries: true });
  assert.equal(other.body.order, null);
  assert.deepEqual(other.body.recoveries, []);
  assert.deepEqual((await h.call('status', { preorderId: 'mi_note_cards', includeRecoveries: true })).body.recoveries, []);
});

for (const preorderId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  for (const boundary of ['before', 'after'] as const) {
    test(`${preorderId} discovery retains an order confirmed ${boundary} its snapshot read`, async context => {
      let confirm: (() => void) | undefined;
      let advanced = false;
      const advance = (stage: typeof boundary, observation: { method: string; sql: string }) => {
        if (stage !== boundary || !confirm || !['first', 'all'].includes(observation.method) ||
          !observation.sql.includes('commerce_preorder_orders')) return;
        const update = confirm;
        confirm = undefined;
        advanced = true;
        update();
      };
      const h = harness({
        observeCall: observation => { if ('sql' in observation) advance('before', observation); },
        observeStatement: observation => advance('after', observation),
      });
      context.after(() => h.database.close());
      const prepared = await h.call('prepare', { preorderId, buyer: BUYER, cardIds: [1], requestId: crypto.randomUUID() });
      const submitted = await h.store.submit((await h.store.get(prepared.body.order.orderId))!,
        { signature: 'signature', transactionBase64: 'fully-signed' }, 1100);
      confirm = () => {
        const changed = h.database.prepare(`UPDATE commerce_preorder_orders SET confirmed_slot = 550,
          updated_at_ms = 1200, next_check_at_ms = 16200, revision = revision + 1
          WHERE order_id = ? AND revision = ? AND status = 'submitted'`).run(submitted.orderId, submitted.revision);
        assert.equal(changed.changes, 1);
      };
      let rpcCalls = 0;
      const unexpected = async (): Promise<never> => { rpcCalls++; throw new Error('Discovery must not contact RPC'); };
      const result = await h.call('status', { preorderId, includeRecoveries: true }, {
        probe: unexpected, send: unexpected, blockhashValid: unexpected,
      });
      assert.equal(result.status, 200);
      assert.equal(advanced, true);
      assert.equal(rpcCalls, 0);
      const discovered = [result.body.order, ...result.body.recoveries].filter(Boolean);
      assert.deepEqual(discovered.map(order => order.orderId), [submitted.orderId]);
      assert.equal(result.body.nextRecoveryCursor, null);
      if (boundary === 'before') {
        assert.equal(result.body.order, null);
        assert.equal(result.body.recoveries[0].confirmedSlot, 550);
      } else {
        assert.equal(result.body.order.confirmedSlot, null);
        assert.deepEqual(result.body.recoveries, []);
      }
      assert.equal((await h.store.get(submitted.orderId))?.confirmedSlot, 550);
    });
  }
}

for (const preorderId of ['mi_note_cards', 'mi_note_cards_devnet']) {
  for (const foregroundStatus of ['prepared', 'submitted'] as const) {
    test(`${preorderId} recovery discovery reads ${foregroundStatus} foreground snapshots during RPC outages`, async () => {
      const h = harness();
      const prepare = (cardIds: number[]) => h.call('prepare', { preorderId, buyer: BUYER, cardIds, requestId: crypto.randomUUID() });
      const first = await prepare([1]);
      h.outcome('confirmed');
      await h.call('submit', { preorderId, orderId: first.body.order.orderId, transactionBase64: 'buyer-signed' });
      h.time(2000);
      const second = await prepare([2]);
      let foreground = (await h.store.get(second.body.order.orderId))!;
      if (foregroundStatus === 'submitted') {
        foreground = await h.store.submit(foreground, { signature: 'signature', transactionBase64: 'fully-signed' }, 2000);
      }
      const recovery = (await h.store.get(first.body.order.orderId))!;
      let rpcCalls = 0;
      const unavailable = async (): Promise<never> => { rpcCalls += 1; throw new Error('RPC outage'); };
      const outage: Overrides = { blockhashValid: unavailable, probe: unavailable, send: unavailable };
      const discovery = await h.call('status', { preorderId, includeRecoveries: true }, outage);
      assert.equal(discovery.status, 200);
      assert.equal(discovery.body.order.orderId, foreground.orderId);
      assert.equal(discovery.body.order.status, foregroundStatus);
      assert.deepEqual(discovery.body.recoveries.map((order: { orderId: string }) => order.orderId), [recovery.orderId]);
      assert.equal(rpcCalls, 0);
      assert.deepEqual(await h.store.get(foreground.orderId), foreground);
      assert.deepEqual(await h.store.get(recovery.orderId), recovery);
      if (foregroundStatus === 'prepared') {
        h.time(foreground.expiresAtMs + 1);
        const overdue = await h.call('status', { preorderId, includeRecoveries: true }, outage);
        assert.equal(overdue.status, 200);
        assert.equal(overdue.body.order.status, 'prepared');
        assert.deepEqual(await h.store.get(foreground.orderId), foreground);
        assert.equal(rpcCalls, 0);
      }
      h.outcome('finalized');
      const legacy = await h.call('status', { preorderId });
      assert.equal(legacy.body.order.orderId, recovery.orderId);
      assert.equal(legacy.body.order.status, 'succeeded');
      assert.equal('recoveries' in legacy.body, false);
      const individual = await h.call('status', { preorderId, orderId: foreground.orderId });
      assert.equal(individual.body.order.status, foregroundStatus === 'prepared' ? 'expired' : 'succeeded');
    });
  }
}

test('bounded preorder inventory candidates prioritize requested older assets without losing confirmation evidence', async () => {
  const h = harness();
  const orders = [];
  for (let id = 1; id <= 17; id += 1) {
    h.time(1000 + id);
    const prepared = await h.prepare([id]);
    const submitted = await h.store.submit((await h.store.get(prepared.body.order.orderId))!,
      { signature: 'signature', transactionBase64: 'fully-signed' }, 1000 + id);
    orders.push(await h.store.confirm(submitted, 500 + id, 1000 + id));
  }
  const recent = await listPreorderInventoryAssets(h.db, BUYER);
  assert.equal(recent.length, 15);
  assert.equal(recent.some((asset) => asset.id === 1), false);
  const requested = await listPreorderInventoryAssets(h.db, BUYER, [orders[0].assets[0].address]);
  assert.equal(requested.length, 15);
  assert.deepEqual(requested[0], { ...orders[0].assets[0], preorderId: config.preorderId, status: 'submitted', confirmedSlot: 501 });
  assert.deepEqual(await listPreorderInventoryAssets(h.db, OTHER, [orders[0].assets[0].address]), []);
  await h.store.finish(orders[0], 'failed', 2000);
  assert.equal((await listPreorderInventoryAssets(h.db, BUYER, [orders[0].assets[0].address])).some((asset) => asset.id === 1), false);
});
