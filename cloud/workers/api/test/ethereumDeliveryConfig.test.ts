import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { requireEthereumDeliveryConfigId, resolveEthereumDeliveryConfig } from '../src/ethereumDeliveryConfig.ts';
import { ethereumConfig, type EthereumContext, type EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { createCommerceD1Harness } from './commerceD1Harness.ts';

const CONTRACT = '0x1111111111111111111111111111111111111111';
const FIRST = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ZERO = '0x0000000000000000000000000000000000000000';
const MIGRATION = 'cloud/workers/api/commerce-migrations/0047_ethereum_delivery_routing.sql';
const configResult = (fields: readonly unknown[]) => encodeAbi(['address', 'address', 'uint16', 'uint256', 'uint256', 'uint256'], fields);

function fixture(t: TestContext) {
  const h = createCommerceD1Harness();
  t.after(() => h.database.close());
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const base: EthereumEnvironment = {
    OPS_DB: h.db, COMMERCE_DB: h.db, ALCHEMY_MI_NOTE_API_KEY: '', ETHEREUM_111K_CHAIN_ID: '31337',
    ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_111K_DEPLOYMENT_BLOCK: '1',
    ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/', ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545',
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
  };
  const calls: { method: string; params: unknown[] }[] = [];
  const context = (raw: string | undefined, result: string): EthereumContext => ({
    env: { ...base, ETHEREUM_111K_DELIVERY_CONFIG_ID: raw }, config: ethereumConfig(base),
    nowMs: 2_000_000_000_000, signal: AbortSignal.timeout(10_000),
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      calls.push(request);
      assert.ok(request.method === 'eth_chainId' || request.method === 'eth_call');
      if (request.method === 'eth_call') assert.deepEqual(request.params,
        [{ to: CONTRACT, data: encodeCall('deliveryConfigs(uint256)', ['uint256'], [Number(raw)]) }, 'latest']);
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? '0x7a69' : result });
    },
  });
  return { context, calls };
}

test('configuration IDs are required canonical integers in the supported range', async t => {
  for (let value = 1; value <= 32; value++) assert.equal(requireEthereumDeliveryConfigId(value), value);
  for (const value of [undefined, null, '1', 0, 33, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => requireEthereumDeliveryConfigId(value), /configuration is unavailable/);
  }
  const f = fixture(t);
  for (const raw of [undefined, '', '0', '33', '01', '1.0', '1e0', ' 1', '1 ', '-1', 'NaN']) {
    await assert.rejects(resolveEthereumDeliveryConfig(f.context(raw, '0x')), /configuration is unavailable/);
  }
  assert.equal(f.calls.length, 0);
});

test('new orders can select registered single or split configurations with valid cumulative accounting', async t => {
  const f = fixture(t);
  const max = (1n << 256n) - 1n;
  for (const [id, fields] of [
    [1, [FIRST, ZERO, 0, 0, 0, 0]],
    [2, [FIRST, SECOND, 2500, 101, 76, 25]],
    [32, [FIRST, SECOND, 9999, max, max - max * 9999n / 10000n, max * 9999n / 10000n]],
  ] as const) {
    assert.equal(await resolveEthereumDeliveryConfig(f.context(String(id), configResult(fields))), id);
  }
  assert.equal(f.calls.filter(call => call.method === 'eth_call').length, 3);
});

test('missing and noncanonical registered configurations fail before an order can be signed', async t => {
  const f = fixture(t);
  for (const fields of [
    [ZERO, ZERO, 0, 0, 0, 0], [CONTRACT, ZERO, 0, 0, 0, 0], [FIRST, CONTRACT, 2500, 0, 0, 0],
    [FIRST, FIRST, 2500, 0, 0, 0], [FIRST, ZERO, 1, 0, 0, 0], [FIRST, SECOND, 0, 0, 0, 0],
    [FIRST, SECOND, 10000, 0, 0, 0], [FIRST, ZERO, 0, 0, 1, 0], [FIRST, ZERO, 0, 10, 0, 1],
    [FIRST, SECOND, 2500, 10, 9, 0], [FIRST, SECOND, 2500, 10, 0, 3],
  ]) await assert.rejects(resolveEthereumDeliveryConfig(f.context('1', configResult(fields))), /configuration is unavailable/);
  const valid = configResult([FIRST, ZERO, 0, 0, 0, 0]);
  for (const result of ['0x', valid.slice(0, -2), `${valid}${'0'.repeat(64)}`,
    encodeAbi(['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256'], [FIRST, ZERO, 65536, 0, 0, 0])]) {
    await assert.rejects(resolveEthereumDeliveryConfig(f.context('1', result)), /configuration is unavailable/);
  }
});

test('configuration migration refuses historical quotes and creates required immutable IDs only after reset', () => {
  const { database } = createCommerceD1Harness({ ethereumDeliveryRoutingMigration: false });
  try {
    database.prepare(`UPDATE ethereum_111k_control SET paused = 0, paused_at_ms = NULL, chain_id = 31337,
      contract_address = ?, revision = revision + 1 WHERE singleton = 1`).run(CONTRACT);
    const oldInsert = `INSERT INTO ethereum_delivery_quotes
      (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json,
       items_json, fee_wei, deadline, status, created_at_ms, updated_at_ms)
      VALUES (31337, ?, 1, 'historical', ?, 'address', '{}', '["7"]', '[]', '100', 1000, 'prepared', 1, 1)`;
    database.prepare(oldInsert).run(CONTRACT, FIRST);
    const migration = readFileSync(MIGRATION, 'utf8');
    assert.throws(() => database.exec(migration), /malformed JSON/);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 1);
    assert.equal(database.prepare("SELECT name FROM pragma_table_info('ethereum_delivery_quotes') WHERE name = 'config_id'").get(), undefined);
    database.exec('DELETE FROM ethereum_delivery_quotes');
    database.exec(migration);
    assert.deepEqual({ ...database.prepare("SELECT type, [notnull], dflt_value FROM pragma_table_info('ethereum_delivery_quotes') WHERE name = 'config_id'").get()! },
      { type: 'INTEGER', notnull: 1, dflt_value: null });
    assert.throws(() => database.prepare(oldInsert).run(CONTRACT, FIRST), /NOT NULL/);
    const insert = database.prepare(`INSERT INTO ethereum_delivery_quotes
      (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json,
       items_json, fee_wei, deadline, status, created_at_ms, updated_at_ms, config_id)
      VALUES (31337, ?, 1, 'new', ?, 'address', '{}', '["7"]', '[]', '100', 1000, 'prepared', 1, 1, ?)`);
    for (const value of [null, 0, 33, 1.5]) assert.throws(() => insert.run(CONTRACT, FIRST, value), /NOT NULL|CHECK|REAL/);
    insert.run(CONTRACT, FIRST, 1);
    assert.throws(() => database.exec('UPDATE ethereum_delivery_quotes SET config_id = 2'), /configuration is immutable/);
    database.exec('UPDATE ethereum_delivery_quotes SET deadline = 2000');
    assert.equal(database.prepare('SELECT config_id FROM ethereum_delivery_quotes').get()!.config_id, 1);
  } finally { database.close(); }
});
