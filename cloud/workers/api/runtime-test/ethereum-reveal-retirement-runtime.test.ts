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
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
function receipt(id: number) {
  const transactionHash = hash(id), blockHash = hash(1000 + id);
  const word = (value: number | string) => encodeAbi(['uint256'], [value]);
  const addr = (value: string) => encodeAbi(['address'], [value]);
  const log = (topics: string[], data: string, index: number) => ({ address: CONTRACT, topics, data,
    blockNumber: '0x3e8', blockHash, transactionHash, logIndex: `0x${index.toString(16)}` });
  return { transactionHash, blockNumber: '0x3e8', blockHash, status: '0x1', logs: [
    log([ETHEREUM_EVENT_TOPICS.Transfer, addr(OWNER), addr(ZERO), word(111112)], '0x', 0),
    ...Array.from({ length: 20 }, (_, index) => log([ETHEREUM_EVENT_TOPICS.Transfer, addr(ZERO), addr(OWNER), word(index + 1)], '0x', index + 1)),
    log([ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(111112), addr(OWNER)], encodeAbi(['uint256', 'uint256'], [1, 20]), 21),
  ] };
}
test('native replacement retirement keeps a tracker after concurrent reactivation', { timeout: 120_000 }, async t => {
  let phase = 'initialize';
  const cStarted = Promise.withResolvers<void>(), dStarted = Promise.withResolvers<void>();
  const releaseC = Promise.withResolvers<void>(), releaseD = Promise.withResolvers<void>();
  const trace: string[] = [];
  const rpc = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const { id, method, params } = JSON.parse(body);
      let result: unknown;
      if (method === 'eth_chainId') result = '0x7a69';
      else if (method === 'eth_blockNumber') result = '0x3e8';
      else if (method === 'eth_getCode') result = params[1].blockHash === hash(99) ? '0x' : '0x60006000';
      else if (method === 'eth_call') result = encodeAbi(['string'], [BASE_URI]);
      else if (method === 'eth_getTransactionReceipt') {
        const key = params[0];
        trace.push(`${phase}:receipt:${key.slice(-2)}`);
        if (key === hash(3)) { cStarted.resolve(); await releaseC.promise; result = null; }
        else if (key === hash(4)) { dStarted.resolve(); await releaseD.promise; result = null; }
        else if (phase === 'A') result = key === hash(1) ? null : receipt(2);
        else if (phase === 'B') result = key === hash(2) ? null : receipt(1);
        else result = null;
      } else if (method === 'eth_getTransactionByHash') result = null;
      else if (method === 'eth_getBlockByNumber') {
        trace.push(`${phase}:canonical`);
        const number = params[0] === 'latest' ? 1000 : Number(BigInt(params[0]));
        result = { number: `0x${number.toString(16)}`, hash: number < 1000 ? hash(number) : phase === 'A' ? hash(1002) : hash(1001) };
      } else if (method === 'eth_getLogs') throw new Error('Unexpected log scan');
      else throw new Error(`Unexpected RPC ${method}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: String(error) } }));
    }
  });
  await new Promise<void>(done => rpc.listen(0, '127.0.0.1', done));
  const address = rpc.address();
  assert.ok(address && typeof address === 'object');
  const directory = await mkdtemp(join(tmpdir(), 'reveal-race-runtime-'));
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
    const env = await worker.getEnv();
    const deployment = await initializeLocalEthereumReveal(env, { contractAddress: CONTRACT, metadataBaseUri: BASE_URI, deploymentBlock: 100 });
    const name = `31337:${CONTRACT}`, object = env.ETHEREUM_REVEAL.getByName(name);
    const storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name });
    for (const id of [1, 2]) await storage.exec(`INSERT INTO transactions(hash,crates_json,from_block,next_check_ms,attempts,requested_all,created_at_ms,last_requested_at_ms)
      VALUES(?,'["111112"]',100,?,1,1,?,?)`, hash(id), Date.now() + 86_400_000, Date.now(), Date.now());
    for (const [original, candidate] of [[1,2], [1,3], [2,1], [2,4]]) await storage.exec(
      'INSERT INTO replacement_candidates(original_hash,transaction_hash,crate_token_id) VALUES(?,?,?)', hash(original), hash(candidate), '111112');
    const rows = () => storage.exec<{ hash: string; status: string; dormant: number; observation_json: string | null }>(
      'SELECT hash,status,dormant,observation_json FROM transactions WHERE hash IN (?,?) ORDER BY hash', hash(1), hash(2));
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error('Stored condition did not arrive.');
    };
    phase = 'A';
    const a = object.revealTransaction(deployment, hash(1));
    await cStarted.promise;
    await waitFor(async () => (await rows())[1].status === 'revealed');
    trace.push('B reactivated; C socket still blocked');
    phase = 'B';
    await storage.exec('UPDATE transactions SET attempts=1,next_check_ms=0,lease_until_ms=0 WHERE hash=?', hash(2));
    await object.revealTransaction(deployment, hash(2));
    await dStarted.promise;
    await waitFor(async () => (await rows())[0].status === 'revealed');
    trace.push('A reactivated; C and D sockets still blocked');
    releaseC.resolve();
    await a;
    assert.equal((await rows())[0].dormant, 0);
    assert.equal((await rows())[1].dormant, 0);
    trace.push('A retirement rejected; D socket still blocked');
    releaseD.resolve();
    await waitFor(async () => (await rows())[1].dormant === 1);
    const final = await rows();
    trace.push('B retired');
    t.diagnostic(JSON.stringify({ runtime: 'native-workerd', externalIo: 'loopback HTTP receipts held independently', trace, final }));
    assert.equal(final[0].dormant, 0, 'The reactivated original must keep its background tracker.');
    assert.equal(final[1].dormant, 1);
  } finally {
    releaseC.resolve(); releaseD.resolve();
    await runtime.close();
    rpc.closeAllConnections();
    await new Promise<void>(done => rpc.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
