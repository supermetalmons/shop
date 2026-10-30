import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { ETHEREUM_API_PATHS as paths, ETHEREUM_SESSION_HEADER, type EthereumAuthChallenge,
  type EthereumSession } from '../../../../shared/ethereum/api.ts';
import { ethereumSignerAddress, personalMessageHash, signDigest } from '../../../../shared/ethereum/crypto.ts';
import { encodeAbi } from '../../../../shared/ethereum/abi.ts';
import { CommerceWriteConflict, D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { reconcileEthereum111k } from '../src/ethereumReconciliation.ts';
import { ETHEREUM_CHECKOUT_PATHS as checkoutPaths } from '../../../../shared/ethereum/checkout.ts';

const ORIGIN = 'https://mons.shop';
const KEY = `0x${'11'.repeat(32)}`;
const WALLET = ethereumSignerAddress(KEY);

async function activateEthereumControl(db: D1Database, contract: string): Promise<void> {
  await db.prepare(`UPDATE ethereum_111k_control SET paused = 0, revision = revision + 1,
    paused_at_ms = NULL, chain_id = 31337, contract_address = ?, updated_at_ms = ? WHERE singleton = 1`)
    .bind(contract, Date.now()).run();
}

function ethereumRuntime() {
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const config = {
    ...production, main: resolve('cloud/workers/api/src/index.ts'), routes: undefined,
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({
      ...database, remote: false, migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
    vars: { ...production.vars, ETHEREUM_111K_CHAIN_ID: '11155111', ETHEREUM_111K_CONTRACT_ADDRESS: '',
      ETHEREUM_111K_DEPLOYMENT_BLOCK: '0',
      ETHEREUM_111K_RPC_URL: '', ALCHEMY_MI_NOTE_API_KEY: '' },
  };
  delete config.$schema;
  delete config.secrets;
  delete config.services;
  return createTestHarness({ root: resolve('.'), workers: [{ config }] });
}

test('native Ethereum reconciliation and HTTP reads use the default Worker fetch', async (context) => {
  const methods: string[] = [];
  const rpc = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { id, method } = JSON.parse(body) as { id: number; method: string };
    methods.push(method);
    const results: Record<string, unknown> = {
      eth_chainId: '0x7a69', eth_blockNumber: '0x66', eth_getLogs: [],
      eth_call: encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256'],
        [0, 0, 0, 100000000000000n, 1100000000000000n, true, `0x${'ab'.repeat(32)}`, 50000000000000n, 1, 0]),
    };
    response.writeHead(Object.hasOwn(results, method) ? 200 : 400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] }));
  });
  context.after(() => new Promise<void>((resolve, reject) => rpc.close(error => error ? reject(error) : resolve())));
  await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  const address = rpc.address();
  assert.ok(address && typeof address === 'object');
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-default-fetch-runtime-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixturePath = join(directory, 'worker.ts');
  await writeFile(fixturePath, `
import { reconcileEthereum111k } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumReconciliation.ts'))};
import { handleEthereumRequest } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumHandler.ts'))};
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/ethereum/')) return handleEthereumRequest(request, {
      ...env, PUBLIC_SHOP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    }, path);
    try {
      return Response.json(await reconcileEthereum111k(env, AbortSignal.timeout(10_000)));
    } catch (error) {
      return Response.json({ name: error.name, message: error.message }, { status: 500 });
    }
  },
};
`, 'utf8');
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const contract = '0x1111111111111111111111111111111111111111';
  const server = createTestHarness({ root: resolve('.'), workers: [{ config: {
    name: 'ethereum-default-fetch-runtime', main: fixturePath,
    compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags,
    d1_databases: production.d1_databases.filter((database: Record<string, unknown>) =>
      database.binding === 'OPS_DB' || database.binding === 'COMMERCE_DB').map((database: Record<string, unknown>) => ({
      ...database, remote: false, migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
    vars: { ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: contract,
      ETHEREUM_111K_RPC_URL: `http://127.0.0.1:${address.port}`, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100' },
  } }] });
  context.after(() => server.close());
  await server.listen();
  const worker = server.getWorker<Env>('ethereum-default-fetch-runtime');
  await worker.applyD1Migrations('OPS_DB');
  await worker.applyD1Migrations('COMMERCE_DB');
  const pausedConfig = await worker.fetch(`https://api.mons.shop${paths.config}`, { headers: { Origin: ORIGIN } });
  assert.equal((await pausedConfig.json() as { enabled: boolean }).enabled, false);
  for (const path of [paths.deliveryPrepare, paths.deliveryConfirm, paths.claimPrepare, paths.claimConfirm]) {
    const paused = await worker.fetch(`https://api.mons.shop${path}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'X-Mons-CSRF': '1', 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(paused.status, 503, path);
  }
  assert.equal((await worker.fetch('https://api.mons.shop/reconcile')).status, 200);
  assert.deepEqual(methods, []);
  await activateEthereumControl((await worker.getEnv()).COMMERCE_DB, contract);
  const activeConfig = await worker.fetch(`https://api.mons.shop${paths.config}`, { headers: { Origin: ORIGIN } });
  assert.equal((await activeConfig.json() as { enabled: boolean }).enabled, true);
  const response = await worker.fetch('https://api.mons.shop/reconcile');
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(methods, ['eth_chainId', 'eth_blockNumber', 'eth_getLogs']);
  const env = await worker.getEnv();
  assert.deepEqual(await env.COMMERCE_DB.prepare(`SELECT next_block, scan_end_block FROM ethereum_reconciliation_cursor
    WHERE chain_id = ? AND contract_address = ?`).bind(31337, contract).first(), { next_block: 103, scan_end_block: null });
  const stats = await worker.fetch(`https://api.mons.shop${paths.stats}`, {
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.42' },
  });
  assert.equal(stats.status, 200, await stats.clone().text());
  assert.equal((await stats.json() as { remainingCrates: number }).remainingCrates, 5555);
  assert.deepEqual(methods, ['eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_chainId', 'eth_call']);
});

test('native Worker routes preserve Ethereum CORS, atomic D1 sessions and encrypted address isolation', async () => {
  const server = ethereumRuntime();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('OPS_DB');
    await worker.applyD1Migrations('COMMERCE_DB');
    const runtimeEnv = await worker.getEnv();
    for (const path of [paths.config, paths.inventory, paths.profile, paths.deliveryPrepare, paths.claimPrepare]) {
      const preflight = await worker.fetch(`https://api.mons.shop${path}`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
      assert.match(preflight.headers.get('access-control-allow-headers') || '', /X-Mons-Ethereum-Session/i);
      assert.match(preflight.headers.get('access-control-allow-headers') || '', /X-Mons-CSRF/i);
    }
    for (const origin of ['https://vvv.so', 'https://www.vvv.so']) {
      const resultPreflight = await worker.fetch(`https://api.mons.shop${checkoutPaths.status}`, {
        method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      });
      assert.equal(resultPreflight.status, 204);
      assert.equal(resultPreflight.headers.get('access-control-allow-origin'), origin);
      assert.equal(resultPreflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
      assert.doesNotMatch(resultPreflight.headers.get('access-control-allow-headers') || '', /Session|Authorization/i);
      const missingCheckout = await worker.fetch(`https://api.mons.shop${checkoutPaths.status}?checkoutId=10000000-0000-4000-8000-000000000001`, {
        headers: { Origin: origin, 'CF-Connecting-IP': '203.0.113.42' },
      });
      assert.equal(missingCheckout.status, 404);
      assert.equal(missingCheckout.headers.get('access-control-allow-origin'), origin);
      for (const path of [checkoutPaths.create, checkoutPaths.prepare, checkoutPaths.submission, checkoutPaths.refresh, paths.profile, paths.authChallenge]) {
        const forbidden = await worker.fetch(`https://api.mons.shop${path}`, { method: 'OPTIONS', headers: { Origin: origin } });
        assert.equal(forbidden.status, 403, path);
        assert.notEqual(forbidden.headers.get('access-control-allow-origin'), origin);
      }
    }
    for (const origin of ['https://other.vvv.so', 'https://www.vvv.so.evil.example', 'http://www.vvv.so', 'https://www.vvv.so:8443']) {
      const forbidden = await worker.fetch(`https://api.mons.shop${checkoutPaths.status}`, { method: 'OPTIONS', headers: { Origin: origin } });
      assert.equal(forbidden.status, 403, origin);
      assert.notEqual(forbidden.headers.get('access-control-allow-origin'), origin);
    }
    const publicConfig = await worker.fetch(`https://api.mons.shop${paths.config}`, { headers: { Origin: ORIGIN } });
    assert.equal(publicConfig.status, 200);
    const collectionConfig = await publicConfig.json() as { enabled: boolean; maxUnboxQuantity: number };
    assert.equal(collectionConfig.enabled, false);
    assert.equal(collectionConfig.maxUnboxQuantity, 15);
    assert.match(publicConfig.headers.get('cache-control') || '', /no-store/);
    const forged = await worker.fetch(`https://api.mons.shop${paths.config}`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(forged.status, 403);
    assert.notEqual(forged.headers.get('access-control-allow-origin'), 'https://evil.example');

    const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.42' };
    const challengeBody = { dropId: '111k_devnet', address: WALLET, chainId: 11155111 };
    const missingCsrf = await worker.fetch(`https://api.mons.shop${paths.authChallenge}`, {
      method: 'POST', headers, body: JSON.stringify(challengeBody),
    });
    assert.equal(missingCsrf.status, 403);
    const challenged = await worker.fetch(`https://api.mons.shop${paths.authChallenge}`, {
      method: 'POST', headers: { ...headers, 'X-Mons-CSRF': '1' }, body: JSON.stringify(challengeBody),
    });
    assert.equal(challenged.status, 200, await challenged.clone().text());
    const challenge = await challenged.json() as EthereumAuthChallenge;
    assert.equal(challenge.message.split('\n')[3], 'Sign in to the 111K test collection for delivery and receipt claims.');
    const proof = { challengeId: challenge.challengeId, signature: signDigest(KEY, personalMessageHash(challenge.message)) };
    const verify = () => worker.fetch(`https://api.mons.shop${paths.authVerify}`, {
      method: 'POST', headers: { ...headers, 'X-Mons-CSRF': '1' }, body: JSON.stringify(proof),
    });
    const responses = await Promise.all([verify(), verify()]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const session = await responses.find(response => response.status === 200)!.json() as EthereumSession;
    assert.equal(session.address, WALLET);
    assert.equal((await runtimeEnv.OPS_DB.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_sessions').first<{ n: number }>())!.n, 1);
    const sessionHeaders = { ...headers, 'X-Mons-CSRF': '1', [ETHEREUM_SESSION_HEADER]: session.token };
    const saved = await worker.fetch(`https://api.mons.shop${paths.addresses}`, { method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ encrypted: 'runtime-encrypted-address', country: 'United States', hint: 'Test recipient, US', email: 'test@example.com' }) });
    assert.equal(saved.status, 200, await saved.clone().text());
    const profile = await worker.fetch(`https://api.mons.shop${paths.profile}`, { headers: sessionHeaders });
    assert.equal(profile.status, 200);
    const body = await profile.json() as { wallet: string; addresses: { encrypted: string }[] };
    assert.equal(body.wallet, WALLET);
    assert.equal(body.addresses[0].encrypted, 'runtime-encrypted-address');
    const isolated = await worker.fetch(`https://api.mons.shop${paths.profile}`, {
      headers: { ...sessionHeaders, Origin: 'https://www.mons.shop' },
    });
    assert.equal(isolated.status, 401);
    const loggedOut = await worker.fetch(`https://api.mons.shop${paths.authLogout}`, {
      method: 'POST', headers: sessionHeaders, body: '{}',
    });
    assert.equal(loggedOut.status, 200);
    assert.equal((await worker.fetch(`https://api.mons.shop${paths.profile}`, { headers: sessionHeaders })).status, 401);
    assert.ok(await runtimeEnv.COMMERCE_DB.prepare("SELECT name FROM sqlite_schema WHERE name = 'ethereum_delivery_quotes'").first());
    assert.ok(await runtimeEnv.COMMERCE_DB.prepare("SELECT name FROM sqlite_schema WHERE name = 'ethereum_crate_claims'").first());
  } finally { await server.close(); }
});

test('native Worker contract batches consume synthetic metadata for a full 311-item confirmation and reject a changed snapshot', async () => {
  const production = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), '111k-read-runtime-'));
  const fixturePath = join(directory, 'worker.mjs');
  await writeFile(fixturePath, `
import { handleEthereumRequest } from ${JSON.stringify(resolve('cloud/workers/api/src/ethereumHandler.ts'))};
import { encodeAbi, encodeCall, decodeReturn, ETHEREUM_EVENT_TOPICS } from ${JSON.stringify(resolve('shared/ethereum/abi.ts'))};
const contract = '0x1111111111111111111111111111111111111111';
const wallet = ${JSON.stringify(WALLET)};
const zero = '0x0000000000000000000000000000000000000000';
const hash = '0x' + 'aa'.repeat(32);
const blockHash = number => '0x' + number.toString(16).padStart(64, '0');
const selector = signature => encodeCall(signature, [], []);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const calls = [];
    const envelopes = [];
    const metadataUrls = [];
    let changed = false;
    const provider = async (input, init) => {
      if (String(input).startsWith(env.ETHEREUM_111K_METADATA_BASE_URI)) {
        metadataUrls.push(String(input));
        if (url.searchParams.has('reorg')) changed = true;
        return Response.json({ name: 'Synthetic runtime metadata', image: 'https://future-cdn.example/artwork.webp',
          description: '', attributes: [{ trait_type: 'type', value: 'artwork' }] });
      }
      const payload = JSON.parse(init.body);
      const respond = rpc => {
        let result;
        if (rpc.method === 'eth_chainId') result = '0x7a69';
        else if (rpc.method === 'eth_blockNumber') result = '0x66';
        else if (rpc.method === 'eth_getBlockByNumber') {
          const number = rpc.params[0] === 'latest' ? 102 : Number(BigInt(rpc.params[0]));
          result = { number: '0x' + number.toString(16), hash: blockHash(changed && number === 102 ? 999 : number) };
        } else if (rpc.method === 'eth_getTransactionReceipt') {
          result = { transactionHash: hash, blockNumber: '0x64', blockHash: blockHash(100), status: '0x1', from: wallet, to: contract,
            logs: Array.from({ length: 311 }, (_, index) => ({ address: contract,
              topics: [ETHEREUM_EVENT_TOPICS.Transfer, encodeAbi(['address'], [zero]), encodeAbi(['address'], [wallet]), encodeAbi(['uint256'], [index + 1])],
              data: '0x', blockNumber: '0x64', blockHash: blockHash(100), transactionHash: hash, logIndex: '0x' + index.toString(16) })) };
        } else if (rpc.method === 'eth_call') {
          calls.push(rpc.params);
          const data = rpc.params[0].data;
          const argumentsHex = '0x' + data.slice(10);
          if (data.startsWith(selector('getTokenInfos(uint256[])'))) {
            const [ids] = decodeReturn(['uint256[]'], argumentsHex);
            if (ids.length > 150) throw new Error('Token information batch is too large');
            result = encodeAbi(['(uint8,uint256,address)[]'], [ids.map(id => [1, id, wallet])]);
          } else throw new Error('Unexpected contract read');
        } else throw new Error('Unexpected RPC: ' + rpc.method);
        return { jsonrpc: '2.0', id: rpc.id, result };
      };
      if (Array.isArray(payload)) envelopes.push(payload.length);
      return Response.json(Array.isArray(payload) ? payload.map(respond).reverse() : respond(payload));
    };
    const response = await handleEthereumRequest(request, { ...env, PUBLIC_SHOP_RATE_LIMITER: { limit: async () => ({ success: true }) } }, url.pathname, { fetch: provider });
    response.headers.set('X-Test-Contract-Calls', String(calls.length));
    response.headers.set('X-Test-Max-Envelope', String(Math.max(...envelopes)));
    response.headers.set('X-Test-Metadata-Reads', String(metadataUrls.length));
    response.headers.set('X-Test-Unique-Metadata-Reads', String(new Set(metadataUrls).size));
    response.headers.set('X-Test-Pinned-Calls', String(calls.every(params => params[1] === blockHash(102))));
    return response;
  },
};
`, 'utf8');
  const server = createTestHarness({ root: resolve('.'), workers: [{ config: {
    name: 'ethereum-read-runtime', main: fixturePath,
    compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags,
    vars: { ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
      ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545', ETHEREUM_111K_DEPLOYMENT_BLOCK: '0',
      ETHEREUM_111K_METADATA_BASE_URI: 'https://cdn.mons.shop/111k-sepolia/' },
  } }] });
  try {
    await server.listen();
    const worker = server.getWorker('ethereum-read-runtime');
    const confirm = (query = '') => worker.fetch(`https://api.mons.shop${paths.transactionsConfirm}${query}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'X-Mons-CSRF': '1', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.42' },
      body: JSON.stringify({ transactionHash: `0x${'aa'.repeat(32)}` }),
    });
    const confirmed = await confirm();
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const body = await confirmed.json() as { status: string; items: { tokenId: string; name: string;
      image: string; description: string; attributes: { trait_type: string; value: string }[] }[] };
    assert.equal(body.status, 'confirmed');
    assert.deepEqual(body.items.map(item => item.tokenId), Array.from({ length: 311 }, (_, index) => String(index + 1)));
    assert.ok(body.items.every(item => item.name === 'Synthetic runtime metadata'));
    assert.ok(body.items.every(item => item.image === 'https://future-cdn.example/artwork.webp' && item.description === ''));
    assert.ok(body.items.every(item => item.attributes.length === 1 && item.attributes[0].trait_type === 'type' &&
      item.attributes[0].value === 'artwork'));
    assert.equal(confirmed.headers.get('X-Test-Metadata-Reads'), '311');
    assert.equal(confirmed.headers.get('X-Test-Unique-Metadata-Reads'), '311');
    assert.equal(confirmed.headers.get('X-Test-Contract-Calls'), '3');
    assert.equal(confirmed.headers.get('X-Test-Max-Envelope'), '3');
    assert.equal(confirmed.headers.get('X-Test-Pinned-Calls'), 'true');
    const orphaned = await confirm('?reorg=1');
    assert.equal(orphaned.status, 503);
    assert.equal((await orphaned.json() as { items?: unknown }).items, undefined);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native D1 rejects stale Ethereum state inside the document commit', async () => {
  const server = ethereumRuntime();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    await worker.applyD1Migrations('OPS_DB');
    const runtimeEnv = await worker.getEnv();
    const db = runtimeEnv.COMMERCE_DB;
    const now = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
    const initialize = [
      db.prepare(`INSERT INTO commerce_authority_control_lease (singleton, lease_token, acquired_at_ms, expires_at_ms)
        VALUES (1, ?, ${now}, ${now} + 60000)`).bind(crypto.randomUUID()),
      db.prepare(`UPDATE commerce_authority_control SET paused_at_ms = ${now}, updated_at_ms = ${now} WHERE singleton = 1`),
    ];
    for (const table of ['commerce_notification_outbox_control', 'commerce_stripe_checkout_state_control',
      'commerce_pack_status_outbox_control', 'commerce_delivery_recovery_control']) {
      initialize.push(db.prepare(`UPDATE ${table} SET preparation_state = 'preparing', source_documents_revision = 0 WHERE singleton = 1`),
        db.prepare(`UPDATE ${table} SET preparation_state = 'ready', prepared_at_ms = 0 WHERE singleton = 1`),
        db.prepare(`UPDATE ${table} SET storage_mode = 'table' WHERE singleton = 1`));
    }
    initialize.push(db.prepare(`UPDATE commerce_authority_control SET authority_state = 'd1', revision = revision + 1,
      paused_at_ms = NULL, updated_at_ms = ${now} WHERE singleton = 1`),
    db.prepare('DELETE FROM commerce_authority_control_lease WHERE singleton = 1'));
    await db.batch(initialize);

    const contract = '0x1111111111111111111111111111111111111111';
    await activateEthereumControl(db, contract);
    const hash = `0x${'ab'.repeat(32)}`;
    await db.prepare(`INSERT INTO ethereum_delivery_quotes (chain_id, contract_address, order_id, request_id, wallet,
      address_id, address_json, token_ids_json, items_json, fee_wei, deadline, status, transaction_hash,
      block_number, block_hash, created_at_ms, updated_at_ms)
      VALUES (31337, ?, 7, 'runtime-request', ?, 'runtime-address', '{}', '[]', '[]', '0', 1000, 'prepared', ?, 100, ?, 100, 100)`)
      .bind(contract, WALLET, hash, hash).run();
    const repository = new D1CommerceRepository(db);
    const key = commerceKeys.deliveryOrder('111k_devnet', '7');
    await repository.run(100, unit => unit.create(key, { source: 'ethereum', chainId: 31337, contractAddress: contract,
      owner: WALLET, status: 'ready_to_ship', irlClaims: [] }));
    const expectation = { kind: 'delivery' as const, chainId: 31337, contractAddress: contract, id: '7',
      status: 'prepared', transactionHash: hash, blockNumber: 100, blockHash: hash, updatedAtMs: 100 };
    await assert.rejects(repository.run(200, async unit => {
      await unit.get(key);
      unit.expectEthereumState(expectation);
      await unit.update(key, { status: 'processing' });
      await db.prepare("UPDATE ethereum_delivery_quotes SET status = 'confirmed', updated_at_ms = 101 WHERE order_id = 7").run();
    }), CommerceWriteConflict);
    assert.equal((await repository.get(key))!.data.status, 'ready_to_ship');
    await assert.rejects(repository.run(201, async unit => { unit.expectEthereumState(expectation); }), CommerceWriteConflict);
    await repository.run(202, async unit => {
      await unit.get(key);
      unit.expectEthereumState({ ...expectation, status: 'confirmed', updatedAtMs: 101 });
      await unit.update(key, { fulfillmentStatus: 'Preparing' });
    });
    assert.equal((await repository.get(key))!.data.fulfillmentStatus, 'Preparing');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM commerce_commit_guards').first<{ count: number }>())!.count, 0);
    await reconcileEthereum111k({ ...runtimeEnv, ETHEREUM_111K_CHAIN_ID: '31337',
      ETHEREUM_111K_CONTRACT_ADDRESS: contract, ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545' },
    AbortSignal.timeout(10_000), { nowMs: () => 300, fetch: async (_input, init) => {
      const rpc = JSON.parse(String(init?.body)) as { id: number; method: string };
      const results: Record<string, unknown> = { eth_chainId: '0x7a69', eth_blockNumber: '0x66',
        eth_getTransactionReceipt: null, eth_call: encodeAbi(['bool'], [false]), eth_getLogs: [] };
      assert.ok(Object.hasOwn(results, rpc.method), `Unexpected RPC: ${rpc.method}`);
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: results[rpc.method] });
    } });
    assert.equal((await repository.get(key))!.data.status, 'processing');
    assert.equal((await db.prepare('SELECT transaction_hash FROM ethereum_delivery_quotes WHERE order_id = 7')
      .first<{ transaction_hash: string | null }>())!.transaction_hash, null);
  } finally { await server.close(); }
});

test('native Ethereum reconciliation reads only eligible rows in oldest-first order', async () => {
  const server = ethereumRuntime();
  try {
    await server.listen();
    const worker = server.getWorker<Env>('mons-shop-api');
    await worker.applyD1Migrations('COMMERCE_DB');
    await worker.applyD1Migrations('OPS_DB');
    const env = await worker.getEnv();
    const db = env.COMMERCE_DB;
    const queries: string[] = [];
    const contract = '0x1111111111111111111111111111111111111111';
    await activateEthereumControl(db, contract);
    const observedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => { queries.push(sql); return target.prepare(sql); };
        return Reflect.get(target, property, target);
      },
    });
    await reconcileEthereum111k({ ...env, COMMERCE_DB: observedDb, ETHEREUM_111K_CHAIN_ID: '31337',
      ETHEREUM_111K_CONTRACT_ADDRESS: contract, ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545' },
    AbortSignal.timeout(10_000), { fetch: async (_input, init) => {
      const rpc = JSON.parse(String(init?.body)) as { id: number; method: string };
      const results: Record<string, unknown> = { eth_chainId: '0x7a69', eth_blockNumber: '0x66', eth_getLogs: [] };
      assert.ok(Object.hasOwn(results, rpc.method), `Unexpected RPC: ${rpc.method}`);
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: results[rpc.method] });
    } });
    const sequence = 'WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 525)';
    await db.batch([
      db.prepare(`${sequence} INSERT INTO ethereum_delivery_quotes (chain_id, contract_address, order_id,
        request_id, wallet, address_id, address_json, token_ids_json, items_json, fee_wei, deadline, status,
        transaction_hash, block_number, published_at_ms, verified_at_block, created_at_ms, updated_at_ms)
        SELECT 31337, ?, n, CAST(n AS TEXT), ?, 'address', '{}', '[]', '[]', '0', 1000, 'confirmed',
          'transaction', 100, 1, CASE WHEN n > 500 THEN 163 ELSE 164 END, n, 1000 - n FROM sequence`)
        .bind(contract, WALLET),
      db.prepare(`${sequence} INSERT INTO ethereum_crate_claims (chain_id, contract_address, receipt_id,
        crate_id, order_id, code_hash, code, claim_id, status, transaction_hash, block_number, verified_at_block, updated_at_ms)
        SELECT 31337, ?, CAST(n AS TEXT), n, n, CAST(n AS TEXT), 'code', CAST(n AS TEXT), 'claimed',
          'transaction', 100, CASE WHEN n > 500 THEN 163 ELSE 164 END, 1000 - n FROM sequence`).bind(contract),
    ]);
    for (const table of ['ethereum_delivery_quotes', 'ethereum_crate_claims']) {
      const sql = queries.find(query => query.startsWith(`SELECT * FROM ${table}`));
      assert.ok(sql, `Missing reconciliation query for ${table}`);
      const rows = await db.prepare(sql).bind(31337, contract).all<{ order_id: number }>();
      assert.deepEqual(rows.results.map(row => row.order_id), Array.from({ length: 20 }, (_, index) => 525 - index));
      assert.ok(Number.isSafeInteger(rows.meta.rows_read) && rows.meta.rows_read <= 40,
        `${table} reconciliation read ${rows.meta.rows_read} rows`);
      const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(31337, contract).all<{ detail: string }>();
      const details = plan.results.map(row => row.detail).join('\n');
      assert.match(details, new RegExp(`SEARCH ${table} USING INDEX ${table}_reconciliation\\b`));
      assert.doesNotMatch(details, /USE TEMP B-TREE|SCAN /i);
    }
  } finally { await server.close(); }
});
