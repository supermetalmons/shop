import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ETHEREUM_API_PATHS, ETHEREUM_SESSION_HEADER, type EthereumShipmentsResponse } from '../../../../shared/ethereum/api.ts';
import { commerceKeys, D1CommerceRepository, type CommerceDocumentData } from '../src/commerceRepository.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import type { EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { sha256Hex } from '../src/sessionSecrets.ts';
import { createCommerceD1Harness, d1Database, seedCommerceDocuments } from './commerceD1Harness.ts';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const DROP = '111k_devnet';
const NOW = 2_000_000_000_000;

async function fixture(t: TestContext) {
  let commerceReads = 0;
  const commerce = createCommerceD1Harness({ observeCall: () => { commerceReads++; } });
  commerce.database.prepare(`UPDATE ethereum_111k_control SET paused = 0, revision = revision + 1,
    paused_at_ms = NULL, chain_id = 31337, contract_address = ? WHERE singleton = 1`).run(OWNER);
  const ops = new DatabaseSync(':memory:');
  t.after(() => { commerce.database.close(); ops.close(); });
  ops.exec(readFileSync('cloud/workers/api/ops-migrations/0008_ethereum_profiles.sql', 'utf8'));
  const sessionId = '10000000-0000-4000-8000-000000000001';
  const secret = 'a'.repeat(43);
  const token = `mons_eth_v1.${sessionId}.${secret}`;
  ops.prepare(`INSERT INTO ethereum_auth_sessions
    (session_id, challenge_id, secret_hash, wallet, chain_id, drop_id, origin, created_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, 31337, ?, 'https://mons.shop', ?, ?)`).run(
    sessionId, sessionId, await sha256Hex(secret), OWNER, DROP, NOW, NOW + 60_000);
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: EthereumEnvironment = {
    OPS_DB: d1Database(ops), COMMERCE_DB: commerce.db, ALCHEMY_MI_NOTE_API_KEY: 'test-key',
    ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: OWNER,
    ETHEREUM_111K_DEPLOYMENT_BLOCK: '2', ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/',
    ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545', STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter,
    STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
  };
  return {
    commerce,
    readCount: () => commerceReads,
    seed(rows: Array<{ id: number; dropId?: string; data?: CommerceDocumentData }>) {
      seedCommerceDocuments(commerce, rows.map(({ id, dropId = DROP, data }) => ({
        key: commerceKeys.deliveryOrder(dropId, String(id)),
        data: { owner: OWNER, status: 'ready_to_ship', createdAt: id, source: 'ethereum', chainId: 31337, contractAddress: OWNER,
          items: [{ kind: 'box', refId: id }], privateAddress: 'secret address', ...data },
      })));
    },
    read(query = '', authenticated = true) {
      return handleEthereumRequest(new Request(`https://api.mons.shop${ETHEREUM_API_PATHS.shipments}${query ? `?${query}` : ''}`, {
        headers: { Origin: 'https://mons.shop', ...(authenticated ? { [ETHEREUM_SESSION_HEADER]: token } : {}) },
      }), env, ETHEREUM_API_PATHS.shipments, { nowMs: () => NOW, fetch: async () => assert.fail('Shipments must not call Ethereum RPC.') });
    },
  };
}

test('Ethereum shipment pages retain the default 100 and expose older owner/drop-scoped orders', async t => {
  const f = await fixture(t);
  f.seed([
    ...Array.from({ length: 105 }, (_, index) => ({ id: index + 1 })),
    { id: 106, data: { owner: OTHER } }, { id: 107, dropId: 'other' },
    { id: 108, data: { status: 'prepared' } },
  ]);
  const response = await f.read();
  assert.equal(response.status, 200);
  const first = await response.json() as EthereumShipmentsResponse;
  assert.equal(first.orders.length, 100);
  assert.ok(first.nextCursor);
  assert.equal(first.nextCursor.owner, OWNER);
  const tailResponse = await f.read(new URLSearchParams({ cursor: JSON.stringify(first.nextCursor) }).toString());
  assert.equal(tailResponse.status, 200);
  const tail = await tailResponse.json() as EthereumShipmentsResponse;
  assert.equal(tail.nextCursor, null);
  assert.deepEqual([...first.orders, ...tail.orders].map(order => order.deliveryId),
    Array.from({ length: 105 }, (_, index) => 105 - index));
  assert.ok([...first.orders, ...tail.orders].every(order => order.dropId === DROP));
  assert.doesNotMatch(JSON.stringify([first, tail]), /privateAddress|secret address/);
  assert.deepEqual(await (await f.read('limit=100')).json(), first);
  assert.equal(((await (await f.read('limit=1')).json()) as EthereumShipmentsResponse).orders.length, 1);
});

test('Ethereum shipment pagination rejects invalid or foreign cursors before commerce reads', async t => {
  const f = await fixture(t);
  const cursor = { version: 1, owner: OWNER, sortAtMs: 10, documentPath: `drops/${DROP}/deliveryOrders/1` };
  const queries = [
    ...['0', '-1', '101', '1.5', '', 'NaN', '01', '1e2'].map(limit => new URLSearchParams({ limit }).toString()),
    ...['', '{', 'null', '{}', 'a'.repeat(2049), JSON.stringify({ ...cursor, owner: OTHER }),
      JSON.stringify({ ...cursor, documentPath: 'drops/other/deliveryOrders/1' })]
      .map(value => new URLSearchParams({ cursor: value }).toString()),
    'limit=1&limit=2', 'cursor=null&cursor=null', 'dropId=other', 'allowPaused=false',
  ];
  for (const query of queries) {
    const response = await f.read(query);
    assert.equal(response.status, 400, query);
  }
  assert.equal(f.readCount(), 0);
  assert.equal((await f.read('', false)).status, 401);
  assert.equal(f.readCount(), 0);
});

test('Ethereum shipment reads stay available through Ethereum and global commerce pauses', async t => {
  const f = await fixture(t);
  f.seed([{ id: 1 }]);
  const before = await (await f.read()).json();
  f.commerce.database.prepare(`UPDATE ethereum_111k_control SET paused = 1, paused_at_ms = ?,
    revision = revision + 1 WHERE singleton = 1`).run(NOW);
  assert.deepEqual(await (await f.read()).json(), before);
  f.commerce.database.exec(`INSERT INTO commerce_authority_control_lease
    (singleton, lease_token, acquired_at_ms, expires_at_ms)
    VALUES (1, '123e4567-e89b-42d3-a456-426614174000',
      CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 60000);
    UPDATE commerce_authority_control SET authority_state = 'paused', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE singleton = 1;
    DELETE FROM commerce_authority_control_lease;`);
  const response = await f.read();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), before);
  await assert.rejects(new D1CommerceRepository(f.commerce.db).queryShipmentHistoryPage({ owner: OWNER, limit: 100 }),
    { code: 'unavailable' });
});

test('Ethereum empty shipment history returns an explicit terminal cursor', async t => {
  const f = await fixture(t);
  const response = await f.read();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { orders: [], nextCursor: null });
});
