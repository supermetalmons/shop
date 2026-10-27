import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ethereumSignerAddress } from '../../../../shared/ethereum/crypto.ts';
import { cleanupExpiredEthereumCheckouts } from '../src/ethereumCheckoutCleanup.ts';
import { prepareEthereumDeliveryQuote } from '../src/ethereumCommerce.ts';
import { reconcileEthereum111k } from '../src/ethereumReconciliation.ts';
import { ethereumConfig, type EthereumContext, type EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { commerceKeys } from '../src/commerceRepository.ts';
import { createCommerceD1Harness, d1Database, seedCommerceDocument } from './commerceD1Harness.ts';

const NOW = 2_000_000_000_000;
const CONTRACT = `0x${'11'.repeat(20)}`;
const OTHER_CONTRACT = `0x${'22'.repeat(20)}`;
const WALLET = `0x${'33'.repeat(20)}`;
const SIGNER_KEY = `0x${'0'.repeat(59)}a11ce`;
const ADDRESS_ID = 'ABCDEFGHIJKLMNOPQRST';
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function fixture(t: TestContext) {
  const hooks = { beforeDelete: null as (() => void) | null, beforeBlock: null as (() => Promise<void>) | null };
  const deletes: string[] = [];
  const commerce = createCommerceD1Harness({ observeCall: operation => {
    if (operation.method !== 'run' || !operation.sql.startsWith('DELETE FROM ethereum_delivery_checkouts')) return;
    deletes.push(operation.sql);
    const callback = hooks.beforeDelete;
    hooks.beforeDelete = null;
    callback?.();
  } });
  const ops = new DatabaseSync(':memory:');
  ops.exec(readFileSync('cloud/workers/api/ops-migrations/0008_ethereum_profiles.sql', 'utf8'));
  ops.prepare('INSERT INTO ethereum_profiles VALUES (?, NULL, ?, ?)').run(WALLET, NOW, NOW);
  ops.prepare('INSERT INTO ethereum_profile_addresses VALUES (?, ?, ?, ?)')
    .run(WALLET, ADDRESS_ID, JSON.stringify({ id: ADDRESS_ID, encrypted: 'saved-address', country: 'US', hint: 'US' }), NOW);
  t.after(() => { ops.close(); commerce.database.close(); });
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: EthereumEnvironment = {
    OPS_DB: d1Database(ops), COMMERCE_DB: commerce.db, ALCHEMY_MI_NOTE_API_KEY: '',
    ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT,
    ETHEREUM_111K_DEPLOYMENT_BLOCK: '2',
    ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/',
    ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545', ETHEREUM_111K_SIGNER_SECRET: SIGNER_KEY,
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
  };
  let rpcCalls = 0;
  const providerFetch: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body));
    const respond = async (request: { id: number; method: string; params: unknown[] }) => {
      rpcCalls++;
      let result: unknown;
      if (request.method === 'eth_chainId') result = '0x7a69';
      else if (request.method === 'eth_blockNumber') result = '0x1';
      else if (request.method === 'eth_getBlockByNumber') {
        const callback = hooks.beforeBlock;
        hooks.beforeBlock = null;
        await callback?.();
        result = { number: '0x1', hash: `0x${'44'.repeat(32)}`, timestamp: `0x${Math.floor(NOW / 1000).toString(16)}` };
      } else if (request.method === 'eth_call') {
        const data = (request.params[0] as { data: string }).data;
        if (data.startsWith(encodeCall('quoteSigner()', [], []))) result = encodeAbi(['address'], [ethereumSignerAddress(SIGNER_KEY)]);
        else if (data.startsWith(encodeCall('getTokenInfos(uint256[])', [], []))) {
          result = encodeAbi(['(uint8,uint256,address)[]'], [[[2, 1, WALLET]]]);
        } else throw new Error(`Unexpected contract read: ${data}`);
      } else throw new Error(`Unexpected RPC: ${request.method}`);
      return { jsonrpc: '2.0', id: request.id, result };
    };
    return Response.json(Array.isArray(payload) ? await Promise.all(payload.map(respond)) : await respond(payload));
  };
  function activate(chainId = 31337, contract = CONTRACT) {
    commerce.database.prepare(`UPDATE ethereum_111k_control SET paused = 0, paused_at_ms = NULL,
      reset_guard_id = NULL, revision = revision + 1, chain_id = ?, contract_address = ?, updated_at_ms = ?`)
      .run(chainId, contract, NOW);
  }
  activate();
  function seed(number: number, expiresAt = NOW, chainId = 31337, contract = CONTRACT) {
    activate(chainId, contract);
    commerce.database.prepare(`INSERT INTO ethereum_delivery_checkouts
      (checkout_id, request_id, origin, drop_id, chain_id, contract_address, token_ids_json, items_json,
        callback_url, created_block, created_at_ms, expires_at_ms)
      VALUES (?, ?, 'https://mons.shop', '111k_devnet', ?, ?, '["111112"]', '[]', 'https://mons.shop/111k_devnet', 1, ?, ?)`)
      .run(id(number), id(number), chainId, contract, NOW - 86_400_000, expiresAt);
    activate();
    return id(number);
  }
  function quote(number: number) {
    commerce.database.prepare(`INSERT INTO ethereum_delivery_quotes
      (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json,
        items_json, fee_wei, deadline, status, created_at_ms, updated_at_ms, checkout_id)
      VALUES (31337, ?, ?, ?, ?, ?, '{}', '["111112"]', '[]', '0', ?, 'prepared', ?, ?, ?)`)
      .run(CONTRACT, number, id(number), WALLET, ADDRESS_ID, Math.floor(NOW / 1000) + 600, NOW, NOW, id(number));
  }
  const context = (nowMs = NOW): EthereumContext => ({ env, config: ethereumConfig(env), nowMs,
    signal: AbortSignal.timeout(10_000), fetch: providerFetch });
  const rows = (table: string) => commerce.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { commerce, env, hooks, deletes, providerFetch, activate, seed, quote, context, rows, rpcCalls: () => rpcCalls };
}

test('checkout cleanup deletes bounded expired drafts with an indexed scope and preserves prepared recovery data', async t => {
  const f = fixture(t);
  for (let number = 1; number <= 101; number++) f.seed(number, NOW - number);
  const fresh = f.seed(200, NOW + 1);
  const otherContract = f.seed(201, NOW, 31337, OTHER_CONTRACT);
  const otherChain = f.seed(202, NOW, 11155111);
  const prepared = f.seed(203);
  f.quote(203);
  const attempted = f.seed(204);
  f.quote(204);
  f.commerce.database.prepare(`INSERT INTO ethereum_delivery_checkout_attempts
    (attempt_id, checkout_id, order_id, wallet, status, quote_deadline, created_at_ms, updated_at_ms)
    VALUES (?, ?, 204, ?, 'started', ?, ?, ?)`).run(id(1000), attempted, WALLET, Math.floor(NOW / 1000) + 600, NOW, NOW);
  const expired = f.seed(205);
  f.quote(205);
  f.commerce.database.prepare(`INSERT INTO ethereum_delivery_checkout_attempts
    (attempt_id, checkout_id, order_id, wallet, status, quote_deadline, created_at_ms, updated_at_ms)
    VALUES (?, ?, 205, ?, 'expired', ?, ?, ?)`).run(id(1001), expired, WALLET, Math.floor(NOW / 1000), NOW, NOW);
  seedCommerceDocument(f.commerce, { key: commerceKeys.deliveryOrder('111k_devnet', '205'),
    data: { source: 'ethereum', chainId: 31337, contractAddress: CONTRACT, owner: WALLET, testnet: true, status: 'processing', items: [] } });
  const preserved = ['ethereum_delivery_quotes', 'ethereum_delivery_checkout_attempts', 'commerce_documents', 'commerce_delivery_recovery']
    .map(table => [table, f.rows(table)] as const);
  assert.equal(await cleanupExpiredEthereumCheckouts(f.context()), 100);
  assert.ok(f.commerce.database.prepare('SELECT 1 FROM ethereum_delivery_checkouts WHERE checkout_id = ?').get(id(1)));
  assert.equal(await cleanupExpiredEthereumCheckouts(f.context()), 1);
  assert.equal(await cleanupExpiredEthereumCheckouts(f.context()), 0);
  assert.deepEqual(f.rows('ethereum_delivery_checkouts').map(row => row.checkout_id), [fresh, otherContract, otherChain, prepared, attempted, expired]);
  for (const [table, rows] of preserved) assert.deepEqual(f.rows(table), rows, table);
  const plan = f.commerce.database.prepare(`EXPLAIN QUERY PLAN ${f.deletes[0]}`).all(31337, CONTRACT, NOW);
  assert.ok(plan.some(row => String(row.detail).includes('USING COVERING INDEX ethereum_delivery_checkouts_expiry')));
  assert.equal(f.rpcCalls(), 0);
});

test('scheduled reconciliation cleans drafts only when the configured scope is active', async t => {
  const f = fixture(t);
  const checkoutId = f.seed(1);
  f.commerce.database.prepare(`UPDATE ethereum_111k_control SET paused = 1, paused_at_ms = ?, revision = revision + 1`).run(NOW);
  await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { nowMs: () => NOW, fetch: f.providerFetch });
  assert.equal(f.deletes.length, 0);
  assert.equal(f.rpcCalls(), 0);
  f.activate(31337, OTHER_CONTRACT);
  await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { nowMs: () => NOW, fetch: f.providerFetch });
  assert.equal(f.deletes.length, 0);
  f.activate();
  await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { nowMs: () => NOW, fetch: f.providerFetch });
  assert.equal(f.deletes.length, 1);
  assert.equal(f.commerce.database.prepare('SELECT 1 FROM ethereum_delivery_checkouts WHERE checkout_id = ?').get(checkoutId), undefined);
});

for (const transition of ['pause', 'reset'] as const) test(`a ${transition} immediately before cleanup keeps every draft intact`, async t => {
  const f = fixture(t);
  f.seed(1);
  f.seed(2);
  const before = f.rows('ethereum_delivery_checkouts');
  f.hooks.beforeDelete = () => {
    if (transition === 'reset') f.commerce.database.prepare(`INSERT INTO commerce_commit_guards
      (guard_id, expectations_json, created_at_ms) VALUES (?, '[]', ?)`).run(id(1000), NOW);
    f.commerce.database.prepare(`UPDATE ethereum_111k_control SET paused = 1, paused_at_ms = ?,
      reset_guard_id = ?, revision = revision + 1`).run(NOW, transition === 'reset' ? id(1000) : null);
  };
  assert.equal(await cleanupExpiredEthereumCheckouts(f.context()), 0);
  assert.deepEqual(f.rows('ethereum_delivery_checkouts'), before);
});

test('a quote persisted immediately before the cleanup statement preserves its draft', async t => {
  const f = fixture(t);
  const checkoutId = f.seed(1);
  f.hooks.beforeDelete = () => f.quote(1);
  assert.equal(await cleanupExpiredEthereumCheckouts(f.context()), 0);
  assert.equal(f.rows('ethereum_delivery_checkouts')[0].checkout_id, checkoutId);
  assert.equal(f.rows('ethereum_delivery_quotes')[0].checkout_id, checkoutId);
});

test('cleanup winning a preparation race prevents a quote and signature from being returned', async t => {
  const f = fixture(t);
  const checkoutId = f.seed(1);
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  f.hooks.beforeBlock = async () => { reached(); await released; };
  const preparation = prepareEthereumDeliveryQuote(f.context(NOW - 1), WALLET,
    { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: checkoutId },
    { checkoutId, items: [{ tokenId: '111112', kind: 'crate', displayId: 1 }] });
  await paused;
  assert.equal(await cleanupExpiredEthereumCheckouts(f.context()), 1);
  resume();
  await assert.rejects(preparation, /checkout identity does not match|FOREIGN KEY/);
  assert.deepEqual(f.rows('ethereum_delivery_quotes'), []);
  assert.deepEqual(f.rows('ethereum_delivery_checkouts'), []);
});
