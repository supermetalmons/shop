import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { encodeAbi, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.ts';
import { initializeLocalEthereumReveal, localEthereumRevealBindings } from '../../../../scripts/shared/ethereum111kLocalReveal.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const OWNER = `0x${'22'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const BASE_URI = 'https://cdn.mons.shop/111k-sepolia/';
const REPAIR = 'reveal-recovery-lifecycle-v1';
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;

function confirmedReceipt() {
  const word = (value: number) => encodeAbi(['uint256'], [value]);
  const address = (value: string) => encodeAbi(['address'], [value]);
  const log = (topics: string[], data: string, index: number) => ({ address: CONTRACT, topics, data,
    blockNumber: '0x3e8', blockHash: hash(1000), transactionHash: hash(1), logIndex: `0x${index.toString(16)}` });
  return { transactionHash: hash(1), blockNumber: '0x3e8', blockHash: hash(1000), status: '0x1', logs: [
    log([ETHEREUM_EVENT_TOPICS.Transfer, address(OWNER), address(ZERO), word(111112)], '0x', 0),
    ...Array.from({ length: 20 }, (_, index) => log([
      ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(OWNER), word(index + 1),
    ], '0x', index + 1)),
    log([ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(111112), address(OWNER)], encodeAbi(['uint256', 'uint256'], [1, 20]), 21),
  ] };
}

test('native lifecycle repair upgrades deployed watches, orphan deadlines and stale interests without rewriting frozen data', { timeout: 120_000 }, async t => {
  const rpcErrors: string[] = [];
  let rpcCalls = 0;
  const rpc = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const { id, method, params } = JSON.parse(body);
      rpcCalls++;
      let result: unknown;
      if (method === 'eth_chainId') result = '0x7a69';
      else if (method === 'eth_blockNumber') result = '0x3e8';
      else if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'latest' ? 1000 : Number(BigInt(params[0]));
        result = { number: `0x${number.toString(16)}`, hash: hash(number) };
      } else if (method === 'eth_getCode') result = params[1].blockHash === hash(99) ? '0x' : '0x60006000';
      else if (method === 'eth_call') result = encodeAbi(['string'], [BASE_URI]);
      else if (method === 'eth_getTransactionReceipt') result = params[0] === hash(1) ? confirmedReceipt() : null;
      else if (method === 'eth_getTransactionByHash') result = null;
      else if (method === 'eth_getLogs') result = [];
      else throw new Error(`Unexpected RPC ${method}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      rpcErrors.push(String(error));
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: String(error) } }));
    }
  });
  await new Promise<void>(done => rpc.listen(0, '127.0.0.1', done));
  const address = rpc.address();
  assert.ok(address && typeof address === 'object');
  const directory = await mkdtemp(join(tmpdir(), 'reveal-lifecycle-repair-runtime-'));
  const production = JSON.parse(await readFile(resolve('cloud/workers/api/wrangler.jsonc'), 'utf8'));
  const config = { ...production, ...localEthereumRevealBindings(), main: resolve('cloud/workers/api/src/index.ts'),
    vars: { ...production.vars, ...Object.fromEntries((production.secrets?.required || []).map((name: string) => [name, ''])),
      ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
      ETHEREUM_111K_RPC_URL: `http://127.0.0.1:${address.port}`, ETHEREUM_111K_METADATA_BASE_URI: BASE_URI },
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({ ...database, remote: false,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)) })),
  };
  delete config.$schema; delete config.account_id; delete config.routes; delete config.secrets;
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  const runtime = createTestHarness({ root: directory, workers: [{ config }] });
  try {
    await runtime.listen();
    const worker = runtime.getWorker<Env>('mons-shop-api');
    for (const binding of ['DATA_DB', 'OPS_DB', 'COMMERCE_DB'] as const) await worker.applyD1Migrations(binding);
    let env = await worker.getEnv();
    const deployment = await initializeLocalEthereumReveal(env, { contractAddress: CONTRACT, metadataBaseUri: BASE_URI, deploymentBlock: 100 });
    const name = `31337:${CONTRACT}`;
    let object = env.ETHEREUM_REVEAL.getByName(name);
    let storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name });
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        if (await predicate()) return;
        await new Promise(done => setTimeout(done, 5));
      }
      assert.fail(`Lifecycle repair did not finish: ${JSON.stringify({ rpcErrors, logs: runtime.getLogs().filter(entry => entry.level === 'error').slice(-4) })}`);
    };
    assert.equal((await object.revealTransaction(deployment, hash(1), true)).kind, 'ready');
    await waitFor(async () => (await storage.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publication WHERE status='published'"))[0].count === 20);
    const snapshot = JSON.parse(JSON.stringify(await object.revealTransaction(deployment, hash(1))));
    const future = Date.now() + 86_400_000, created = Date.now() - 3_600_000;
    await storage.exec('UPDATE receipt_work SET next_check_ms=?,active_until_ms=0 WHERE claim_id IS NULL', future);
    await storage.exec('UPDATE crate_candidates SET next_check_ms=?', future);
    await storage.exec('UPDATE crate_recovery_jobs SET receipt_due_ms=?,scan_due_ms=NULL,active_until_ms=0', future);
    await storage.exec(`WITH RECURSIVE ids(id) AS (SELECT 100 UNION ALL SELECT id+1 FROM ids WHERE id<228)
      INSERT INTO transactions(hash,from_block,requested_all,created_at_ms,last_requested_at_ms,incarnation,transient)
      SELECT '0x'||printf('%064x',id),100,1,?,?,printf('deployed-%d',id),0 FROM ids`, created, created);
    await storage.exec(`INSERT INTO receipt_work(hash,requested_all,observed,opaque,next_check_ms,created_at_ms)
      SELECT hash,1,1,0,?,created_at_ms FROM transactions WHERE hash BETWEEN ? AND ?`, future, hash(100), hash(228));
    await storage.exec("INSERT INTO crates(crate_token_id) VALUES('111113')");
    await storage.exec(`INSERT INTO crate_recovery_jobs(crate_token_id,from_block,ranges_json,generation,receipt_due_ms,scan_due_ms)
      VALUES('111113',200,'[{"fromBlock":200,"toBlock":500}]',7,0,?)`, future);
    await storage.exec("INSERT INTO token_recovery(token_id,job_id,status,checked_at_ms) VALUES('999',NULL,'unminted',?)", created);
    await storage.exec("INSERT INTO receipt_token_interest(hash,token_id) VALUES(?,'999')", hash(100));
    const frozen = await storage.exec('SELECT * FROM assignments ORDER BY category,asset_id');
    const publication = await storage.exec('SELECT * FROM publication ORDER BY token_id');
    const pools = await storage.exec('SELECT * FROM pools ORDER BY category');
    const identities = await storage.exec('SELECT rowid,hash,created_at_ms,incarnation FROM transactions ORDER BY hash');
    const crateIdentities = await storage.exec('SELECT rowid,crate_token_id FROM crate_recovery_jobs ORDER BY crate_token_id');
    const metadata = await (await env.ETHEREUM_REVEAL_METADATA.get('111k-sepolia/1.json'))!.text();
    await storage.exec('DELETE FROM reveal_migrations WHERE name=?', REPAIR);
    await runtime.update({ root: directory, workers: [{ config: { ...config, vars: { ...config.vars, LOCAL_REPAIR_RESTART: '1' } } }] });
    env = await worker.getEnv();
    object = env.ETHEREUM_REVEAL.getByName(name);
    storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name });
    const callsBefore = rpcCalls;
    assert.deepEqual(JSON.parse(JSON.stringify(await object.revealTransaction(deployment, hash(1)))), snapshot);
    assert.equal(rpcCalls, callsBefore);
    assert.equal((await storage.exec<{ phase: string }>('SELECT phase FROM reveal_recovery_migration'))[0].phase, 'repair-watches');
    await object.watchdog(deployment);
    await waitFor(async () => (await storage.exec<{ phase: string }>('SELECT phase FROM reveal_recovery_migration'))[0].phase === 'ready');
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM receipt_work WHERE opaque=1 AND resolved=0'))[0].count, 129);
    const restored = (await storage.exec<{ observed: number; requested_all: number; opaque: number; created_at_ms: number; next_check_ms: number }>(
      'SELECT observed,requested_all,opaque,created_at_ms,next_check_ms FROM receipt_work WHERE hash=?', hash(100)))[0];
    assert.deepEqual(restored, { observed: 1, requested_all: 1, opaque: 1, created_at_ms: created, next_check_ms: future });
    const orphan = (await storage.exec<{ receipt_due_ms: number; scan_due_ms: number; generation: number; ranges_json: string }>(
      "SELECT receipt_due_ms,scan_due_ms,generation,ranges_json FROM crate_recovery_jobs WHERE crate_token_id='111113'"))[0];
    assert.deepEqual(orphan, { receipt_due_ms: Number.MAX_SAFE_INTEGER, scan_due_ms: future, generation: 7, ranges_json: '[{"fromBlock":200,"toBlock":500}]' });
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM receipt_token_interest'))[0].count, 0);
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM reveal_migrations WHERE name=?', REPAIR))[0].count, 1);
    assert.deepEqual(await storage.exec('SELECT * FROM assignments ORDER BY category,asset_id'), frozen);
    assert.deepEqual(await storage.exec('SELECT * FROM publication ORDER BY token_id'), publication);
    assert.deepEqual(await storage.exec('SELECT * FROM pools ORDER BY category'), pools);
    assert.deepEqual(await storage.exec('SELECT rowid,hash,created_at_ms,incarnation FROM transactions ORDER BY hash'), identities);
    assert.deepEqual(await storage.exec('SELECT rowid,crate_token_id FROM crate_recovery_jobs ORDER BY crate_token_id'), crateIdentities);
    assert.equal(await (await env.ETHEREUM_REVEAL_METADATA.get('111k-sepolia/1.json'))!.text(), metadata);
    assert.deepEqual(rpcErrors, []);
    assert.equal(rpcCalls, callsBefore);
    t.diagnostic(JSON.stringify({ runtime: 'native-workerd', repairedWatches: 129, migrationReady: true,
      orphanReceiptInactive: true, staleInterestRemoved: true, frozenArtworksPreserved: frozen.length, repairRpcCalls: rpcCalls - callsBefore }));
  } finally {
    await runtime.close();
    rpc.closeAllConnections();
    await new Promise<void>(done => rpc.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
