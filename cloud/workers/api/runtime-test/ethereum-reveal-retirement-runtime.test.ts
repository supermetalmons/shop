import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { decodeReturn, encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import { initializeLocalEthereumReveal, localEthereumRevealBindings } from '../../../../scripts/shared/ethereum111kLocalReveal.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const OWNER = `0x${'22'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const BASE_URI = 'https://cdn.mons.shop/111k-sepolia/';
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const ids = (first: number) => Array.from({ length: 20 }, (_, index) => String(first + index));

function receipt(id: number, block: number, crate = 111112, first = 1) {
  const transactionHash = hash(id);
  const word = (value: number | string) => encodeAbi(['uint256'], [value]);
  const address = (value: string) => encodeAbi(['address'], [value]);
  const log = (topics: string[], data: string, index: number) => ({ address: CONTRACT, topics, data,
    blockNumber: `0x${block.toString(16)}`, blockHash: hash(block), transactionHash, logIndex: `0x${index.toString(16)}` });
  return { transactionHash, blockNumber: `0x${block.toString(16)}`, blockHash: hash(block), status: '0x1', logs: [
    log([ETHEREUM_EVENT_TOPICS.Transfer, address(OWNER), address(ZERO), word(crate)], '0x', 0),
    ...ids(first).map((tokenId, index) => log([ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(OWNER), word(tokenId)], '0x', index + 1)),
    log([ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(crate), address(OWNER)], encodeAbi(['uint256', 'uint256'], [first, 20]), 21),
  ] };
}

test('native stable crate jobs preserve late candidates through chained reorgs and restart', { timeout: 120_000 }, async t => {
  let head = 1000;
  let logsUnavailable = false;
  const receipts = new Map<string, ReturnType<typeof receipt>>();
  const pending = new Map<string, string[]>();
  const owned = new Set(['111112', '111113']);
  const heldReceipt = Promise.withResolvers<void>(), releaseReceipt = Promise.withResolvers<void>();
  const calls: string[] = [];
  const rpcErrors: string[] = [];
  const rpc = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const { id, method, params } = JSON.parse(body);
      calls.push(method);
      let result: unknown;
      if (method === 'eth_chainId') result = '0x7a69';
      else if (method === 'eth_blockNumber') result = `0x${head.toString(16)}`;
      else if (method === 'eth_getCode') result = params[1].blockHash === hash(99) ? '0x' : '0x60006000';
      else if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'latest' ? head : Number(BigInt(params[0]));
        result = { number: `0x${number.toString(16)}`, hash: hash(number) };
      } else if (method === 'eth_call') {
        const data = String(params[0].data);
        if (data.slice(0, 10) === encodeCall('baseURI()', [], [])) result = encodeAbi(['string'], [BASE_URI]);
        else {
          const [tokenIds] = decodeReturn(['uint256[]'], `0x${data.slice(10)}`) as [bigint[]];
          result = encodeAbi(['(uint8,uint256,address)[]'], [tokenIds.map(tokenId => owned.has(String(tokenId))
            ? [2, tokenId - 111111n, OWNER] : [0, 0, ZERO])]);
        }
      } else if (method === 'eth_getTransactionReceipt') {
        if (params[0] === hash(5)) { heldReceipt.resolve(); await releaseReceipt.promise; }
        result = receipts.get(params[0]) ?? null;
      } else if (method === 'eth_getTransactionByHash') {
        const crates = pending.get(params[0]);
        result = crates ? { hash: params[0], chainId: '0x7a69', from: OWNER, to: CONTRACT, value: '0x0', blockNumber: null,
          input: crates.length === 1 ? encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], crates)
            : encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [crates]) } : null;
      } else if (method === 'eth_getLogs') {
        if (logsUnavailable) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Logs temporarily unavailable' } }));
          return;
        }
        const filter = params[0];
        result = [...receipts.values()].flatMap(value => value.logs).filter(log =>
          BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock) &&
          filter.topics.every((topic: string | string[] | null, index: number) => topic === null ||
            (Array.isArray(topic) ? topic.includes(log.topics[index]) : topic === log.topics[index])));
      } else throw new Error(`Unexpected RPC ${method}`);
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
  const directory = await mkdtemp(join(tmpdir(), 'stable-crate-recovery-runtime-'));
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
      assert.fail(`Expected recovery state did not arrive: ${JSON.stringify({ rpcErrors, logs: runtime.getLogs().filter(entry => entry.level === 'error').slice(-4) })}`);
    };
    const frozen = async (first: number) => storage.exec<{ token_id: string; artwork_json: string; metadata_json: string }>(
      'SELECT token_id,artwork_json,metadata_json FROM assignments WHERE CAST(token_id AS INTEGER) BETWEEN ? AND ? ORDER BY CAST(token_id AS INTEGER)', first, first + 19);
    const makeDue = async () => {
      await storage.exec('UPDATE receipt_work SET next_check_ms=0,last_checked_ms=0 WHERE claim_id IS NULL');
      await storage.exec('UPDATE crate_candidates SET next_check_ms=0');
      await storage.exec('UPDATE crate_recovery_jobs SET receipt_due_ms=0,scan_due_ms=CASE WHEN scan_due_ms IS NULL THEN NULL ELSE 0 END WHERE scan_claim_id IS NULL');
    };
    pending.set(hash(1), ['111112', '111113']);
    const admitted = await object.revealTransaction(deployment, hash(1), true);
    assert.equal(admitted.kind, 'ready');
    if (admitted.kind !== 'ready') assert.fail();
    assert.equal(admitted.value.status, 'pending');
    assert.deepEqual(admitted.value.artworks, []);
    const identity = await storage.exec<{ rowid: number; crate_token_id: string }>('SELECT rowid,crate_token_id FROM crate_recovery_jobs ORDER BY crate_token_id');
    assert.equal(identity.length, 2);
    head = 1001;
    owned.clear();
    receipts.set(hash(2), receipt(2, 1001));
    receipts.set(hash(5), receipt(5, 1001, 111113, 21));
    await makeDue();
    await object.watchdog(deployment);
    await heldReceipt.promise;
    await waitFor(async () => (await frozen(1)).length === 20);
    const firstFrozen = await frozen(1);
    receipts.delete(hash(2));
    head = 1002;
    receipts.set(hash(3), receipt(3, 1002, 111112, 41));
    await makeDue();
    await object.watchdog(deployment);
    await waitFor(async () => (await frozen(41)).length === 20);
    const secondFrozen = await frozen(41);
    receipts.delete(hash(3));
    head = 1003;
    owned.add('111112');
    pending.set(hash(4), ['111112']);
    logsUnavailable = true;
    const late = await object.revealTransaction(deployment, hash(4), true);
    assert.equal(late.kind, 'ready');
    if (late.kind !== 'ready') assert.fail();
    assert.equal(late.value.status, 'pending');
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM crate_candidates WHERE crate_token_id=? AND hash=?', '111112', hash(4)))[0].count, 1);
    pending.clear();
    owned.clear();
    receipts.set(hash(4), receipt(4, 1003, 111112, 61));
    releaseReceipt.resolve();
    await makeDue();
    await object.watchdog(deployment);
    await waitFor(async () => (await frozen(21)).length === 20 && (await frozen(61)).length === 20);
    await waitFor(async () => (await storage.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publication WHERE status='published'"))[0].count === 80);
    assert.deepEqual(await frozen(1), firstFrozen);
    assert.deepEqual(await frozen(41), secondFrozen);
    assert.deepEqual(await storage.exec('SELECT rowid,crate_token_id FROM crate_recovery_jobs ORDER BY crate_token_id'), identity);
    await storage.exec('UPDATE receipt_work SET next_check_ms=?,active_until_ms=0 WHERE claim_id IS NULL', Date.now() + 86_400_000);
    await storage.exec('UPDATE crate_recovery_jobs SET receipt_due_ms=?,scan_due_ms=NULL', Date.now() + 86_400_000);
    await runtime.update({ root: directory, workers: [{ config: { ...config, vars: { ...config.vars, LOCAL_STABLE_CRATE_RESTART: '1' } } }] });
    env = await worker.getEnv();
    object = env.ETHEREUM_REVEAL.getByName(name);
    storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name });
    const rpcBefore = calls.length;
    const restored = await object.revealTransaction(deployment, hash(4));
    assert.equal(restored.kind, 'ready');
    if (restored.kind !== 'ready') assert.fail();
    assert.equal(restored.value.status, 'revealed');
    assert.deepEqual(restored.value.artworks.map(artwork => artwork.tokenId), ids(61));
    assert.equal(calls.length, rpcBefore);
    assert.deepEqual(await frozen(1), firstFrozen);
    assert.deepEqual(await frozen(41), secondFrozen);
    assert.deepEqual(await storage.exec('SELECT rowid,crate_token_id FROM crate_recovery_jobs ORDER BY crate_token_id'), identity);
    assert.deepEqual(rpcErrors, []);
    t.diagnostic(JSON.stringify({ runtime: 'native-workerd', stableCrateJobs: identity.length, frozenArtworks: 80,
      lateCandidateRecoveredWithoutLogs: true, frozenHistoryPreserved: true, cachedRestartRpcCalls: calls.length - rpcBefore }));
  } finally {
    releaseReceipt.resolve();
    await runtime.close();
    rpc.closeAllConnections();
    await new Promise<void>(done => rpc.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
