import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { decodeReturn, encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.ts';
import { ethereumHexQuantity, ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import { ETHEREUM_REVEAL_PATHS, type EthereumRevealTokensResponse, type EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.ts';
import { initializeLocalEthereumReveal, localEthereumRevealBindings } from '../../../../scripts/shared/ethereum111kLocalReveal.ts';

const REVEAL_TRANSIENT_TRANSACTION_LIMIT = 10_000;
const REVEAL_TRANSIENT_TRANSACTION_TTL_MS = 15 * 60_000;
const CONTRACT = `0x${'11'.repeat(20)}`;
const WALLET = `0x${'22'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const BASE_URI = 'https://cdn.mons.shop/111k-sepolia/';
const HEAD = 1000;
const word = (value: number | string) => encodeAbi(['uint256'], [value]);
const address = (value: string) => encodeAbi(['address'], [value]);
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const blockHash = (number: number) => hash(1_000_000 + number);

function fixture(index: number, crates = [{ crateTokenId: 111112 + index, firstTokenId: index * 20 + 1 }], block = HEAD) {
  const transactionHash = hash(index + 1);
  const log = (topics: string[], data: string, logIndex: number) => ({ address: CONTRACT, topics, data,
    blockNumber: ethereumHexQuantity(block), blockHash: blockHash(block), transactionHash,
    logIndex: ethereumHexQuantity(logIndex), removed: false });
  const logs = crates.flatMap((crate, crateIndex) => {
    const start = index * 64 + crateIndex * 22;
    return [
      log([ETHEREUM_EVENT_TOPICS.Transfer, address(WALLET), address(ZERO), word(crate.crateTokenId)], '0x', start),
      ...Array.from({ length: 20 }, (_, tokenIndex) => log([
        ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(WALLET), word(crate.firstTokenId + tokenIndex),
      ], '0x', start + tokenIndex + 1)),
      log([ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(crate.crateTokenId), address(WALLET)],
        encodeAbi(['uint256', 'uint256'], [crate.firstTokenId, 20]), start + 21),
    ];
  });
  return { transactionHash, blockNumber: ethereumHexQuantity(block), blockHash: blockHash(block), status: '0x1',
    from: WALLET, to: CONTRACT, logs };
}

const rounded = (value: number) => Math.round(value * 100) / 100;
function percentile(values: number[], fraction: number): number {
  return rounded([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]);
}

test('native reveal handles concurrent unpacking, publication conflicts and durable recovery without exposing unrelated history', { timeout: 120_000 }, async context => {
  const receipts = new Map(Array.from({ length: 201 }, (_, index) => {
    const value = fixture(index);
    return [value.transactionHash, value] as const;
  }));
  const partial = fixture(300, [{ crateTokenId: 111500, firstTokenId: 5001 }, { crateTokenId: 111501, firstTokenId: 5021 }]);
  const unasked = fixture(1000, [{ crateTokenId: 116000, firstTokenId: 80001 }], HEAD - 1);
  receipts.set(partial.transactionHash, partial);
  receipts.set(unasked.transactionHash, unasked);
  const rpcCalls: Array<{ method: string; durationMs: number }> = [];
  const rpcErrors: string[] = [];
  let blockedReceiptHash: string | null = null;
  const receiptStarted = Promise.withResolvers<void>();
  const releaseReceipt = Promise.withResolvers<void>();
  const require = createRequire(import.meta.url);
  const undici = createRequire(require.resolve('miniflare'))('undici');
  const previousDispatcher = undici.getGlobalDispatcher();
  // Bound loopback sockets while all 200 client requests are dispatched concurrently.
  const dispatcher = new undici.Agent({ factory: (origin: string, options: object) =>
    new undici.Pool(origin, { ...options, connections: 64 }) });
  undici.setGlobalDispatcher(dispatcher);
  context.after(async () => { undici.setGlobalDispatcher(previousDispatcher); await dispatcher.close(); });
  let runningRpc = 0, maximumRpc = 0;
  const rpc = createServer(async (request, response) => {
    const started = performance.now();
    runningRpc++;
    maximumRpc = Math.max(maximumRpc, runningRpc);
    let method = 'unparsed';
    try {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const input = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      method = input.method;
      const params = input.params;
      let result: unknown;
      if (method === 'eth_chainId') result = '0x7a69';
      else if (method === 'eth_blockNumber') result = ethereumHexQuantity(HEAD);
      else if (method === 'eth_getCode') result = (params[1] as { blockHash: string }).blockHash === blockHash(99) ? '0x' : '0x60006000';
      else if (method === 'eth_getTransactionReceipt') {
        if (params[0] === blockedReceiptHash) { receiptStarted.resolve(); await releaseReceipt.promise; }
        result = receipts.get(String(params[0])) || null;
      }
      else if (method === 'eth_getTransactionByHash') result = null;
      else if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'latest' ? HEAD : Number(BigInt(String(params[0])));
        result = { number: ethereumHexQuantity(number), hash: blockHash(number) };
      } else if (method === 'eth_call') {
        const data = String((params[0] as { data: string }).data);
        if (data.slice(0, 10) === encodeCall('baseURI()', [], [])) result = encodeAbi(['string'], [BASE_URI]);
        else if (data.slice(0, 10) === encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, [], [])) {
          const [ids] = decodeReturn(['uint256[]'], `0x${data.slice(10)}`) as [bigint[]];
          result = encodeAbi(['(uint8,uint256,address)[]'], [ids.map(id => [2, id - 111111n, WALLET])]);
        } else if (data.slice(0, 10) === encodeCall(ETHEREUM_FUNCTIONS.stats, [], [])) {
          result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256'],
            [5555, 0, 80020, 1, 1, true, word(0), 1, 1, 0]);
        } else throw new Error(`Unexpected contract call ${data.slice(0, 10)}`);
      } else if (method === 'eth_getLogs') {
        const filter = params[0] as { fromBlock: string; toBlock: string; topics: Array<string | string[] | null> };
        result = [...receipts.values()].flatMap(receipt => receipt.logs).filter(log =>
          BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock) &&
          filter.topics.every((topic, index) => topic === null || (Array.isArray(topic) ? topic.includes(log.topics[index]) : topic === log.topics[index])));
      } else throw new Error(`Unexpected RPC ${method}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    } catch (error) {
      rpcErrors.push(String(error));
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: String(error) } }));
    } finally {
      runningRpc--;
      rpcCalls.push({ method, durationMs: performance.now() - started });
    }
  });
  await new Promise<void>(done => rpc.listen(0, '127.0.0.1', done));
  const rpcAddress = rpc.address();
  assert.ok(rpcAddress && typeof rpcAddress === 'object');
  const directory = await mkdtemp(join(tmpdir(), 'ethereum-reveal-runtime-'));
  const production = JSON.parse(await readFile(resolve('cloud/workers/api/wrangler.jsonc'), 'utf8'));
  const config = { ...production, ...localEthereumRevealBindings(), main: resolve('cloud/workers/api/src/index.ts'),
    vars: { ...production.vars, ...Object.fromEntries((production.secrets?.required || []).map((name: string) => [name, ''])),
      ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
      ETHEREUM_111K_RPC_URL: `http://127.0.0.1:${rpcAddress.port}`, ETHEREUM_111K_METADATA_BASE_URI: BASE_URI },
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({
      ...database, remote: false, migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)),
    })),
  };
  delete config.$schema;
  delete config.account_id;
  delete config.routes;
  delete config.secrets;
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  const runtime = createTestHarness({ root: directory, workers: [{ config }] });
  try {
    let apiUrl = (await runtime.listen()).url;
    const worker = runtime.getWorker<Env>('mons-shop-api');
    for (const binding of ['DATA_DB', 'OPS_DB', 'COMMERCE_DB'] as const) await worker.applyD1Migrations(binding);
    let env = await worker.getEnv();
    const seedStarted = performance.now();
    const deployment = await initializeLocalEthereumReveal(env, { contractAddress: CONTRACT, metadataBaseUri: BASE_URI, deploymentBlock: 100 });
    const seedMs = performance.now() - seedStarted;
    const name = `31337:${CONTRACT}`;
    const object = env.ETHEREUM_REVEAL.getByName(name);
    let storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name });
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM assignments'))[0].count, 0);
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM transactions'))[0].count, 0);
    async function request<T>(path: string, body: object): Promise<T> {
      const response = await undici.fetch(new URL(path, apiUrl), {
        method: 'POST', headers: { Origin: 'https://vvv.so', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1',
          'CF-Connecting-IP': '192.0.2.250' },
        body: JSON.stringify({ chainId: 31337, contractAddress: CONTRACT, ...body }),
      });
      const value = await response.json();
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://vvv.so');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      return value as T;
    }
    const baselineRpc = rpcCalls.length;
    const baselineStarted = performance.now();
    const baseline = await request<EthereumRevealTransactionResponse>(ETHEREUM_REVEAL_PATHS.transaction, { transactionHash: hash(1) });
    const singleCrateMs = performance.now() - baselineStarted;
    assert.equal(baseline.status, 'revealed');
    assert.equal(baseline.artworks.length, 20);
    const singleCrateRpcCalls = rpcCalls.length - baselineRpc;
    const tampered = '{"image":"https://example.invalid/tampered.webp"}\n';
    const admittedAt = Date.now();
    await storage.exec(`WITH RECURSIVE ids(id) AS (SELECT 100000 UNION ALL SELECT id+1 FROM ids WHERE id<?)
      INSERT INTO transactions(hash,from_block,next_check_ms,created_at_ms,last_requested_at_ms,incarnation,transient,admission_expires_at_ms)
      SELECT '0x' || printf('%064x',id),100,?,?,?,printf('load-%d',id),1,? FROM ids`,
    100000 + REVEAL_TRANSIENT_TRANSACTION_LIMIT - 1, admittedAt + REVEAL_TRANSIENT_TRANSACTION_TTL_MS,
    admittedAt, admittedAt, admittedAt + REVEAL_TRANSIENT_TRANSACTION_TTL_MS);
    const transientCount = async () => (await storage.exec<{ count: number }>('SELECT count FROM transaction_admission_count WHERE id=1'))[0].count;
    assert.equal(await transientCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
    const batchRpc = rpcCalls.length;
    const batchStarted = performance.now();
    const latencies: number[] = [];
    const outcomes = await Promise.allSettled(Array.from({ length: 200 }, async (_, offset) => {
      const started = performance.now();
      const response = await request<EthereumRevealTransactionResponse>(ETHEREUM_REVEAL_PATHS.transaction,
        { transactionHash: hash(offset + 2) });
      latencies.push(performance.now() - started);
      assert.equal(response.status, 'revealed');
      assert.equal(response.artworks.length, 20);
      assert.ok(response.artworks.every(artwork => artwork.crateTokenId === String(111113 + offset)));
      return response;
    }));
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length) {
      context.diagnostic(JSON.stringify({ concurrentFailures: failures.length, rpcErrors,
        firstErrors: failures.slice(0, 3).map(result => ({ message: String(result.reason),
          cause: result.reason instanceof Error ? String(result.reason.cause) : undefined })),
        logs: runtime.getLogs().filter(log => log.level === 'error').slice(0, 10) }));
    }
    assert.equal(failures.length, 0, 'Every concurrent request must return its frozen artwork.');
    const concurrent = outcomes.map(result => { assert.equal(result.status, 'fulfilled'); return result.value; });
    const concurrentTotalMs = performance.now() - batchStarted;
    const concurrentRpcCalls = rpcCalls.length - batchRpc;
    const artworks = [baseline, ...concurrent].flatMap(response => response.artworks);
    assert.equal(artworks.length, 4020);
    assert.equal(new Set(artworks.map(artwork => artwork.tokenId)).size, 4020);
    assert.equal(new Set(artworks.map(artwork => artwork.image)).size, 4020);
    assert.ok(artworks.every(artwork => artwork.aspectRatio.width > 0 && artwork.aspectRatio.height > 0 &&
      artwork.observation.blockNumber === HEAD && artwork.observation.blockHash === blockHash(HEAD)));
    const sqlStarted = performance.now();
    const counts = (await storage.exec<{ frozen: number; uniqueAssets: number }>(`SELECT COUNT(*) AS frozen,
      COUNT(DISTINCT category || ':' || asset_id) AS uniqueAssets FROM assignments WHERE token_id IS NOT NULL`))[0];
    const sqliteInspectionMs = performance.now() - sqlStarted;
    assert.deepEqual(counts, { frozen: 4020, uniqueAssets: 4020 });
    const publicationDeadline = performance.now() + 60_000;
    let publishedCount = 0;
    while (performance.now() < publicationDeadline) {
      publishedCount = (await storage.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM publication
        WHERE status='published' AND CAST(token_id AS INTEGER) BETWEEN 21 AND 4020`))[0].count;
      if (publishedCount === 4000) break;
      await new Promise(done => setTimeout(done, 25));
    }
    assert.equal(publishedCount, 4000, 'The complete concurrent backlog must publish through durable background work.');
    const publicationTotalMs = performance.now() - batchStarted;
    const pollingStarted = performance.now();
    await Promise.all(concurrent.map((expected, offset) => request<EthereumRevealTransactionResponse>(
      ETHEREUM_REVEAL_PATHS.transaction, { transactionHash: hash(offset + 2) }).then(value => assert.deepEqual(value, expected))));
    const pollingTotalMs = performance.now() - pollingStarted;
    assert.equal(await transientCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM transactions WHERE transient=0'))[0].count, 201);
    await storage.exec('DELETE FROM transactions WHERE transient=1 AND hash BETWEEN ? AND ?', hash(100000), hash(100000 + REVEAL_TRANSIENT_TRANSACTION_LIMIT - 1));
    assert.equal(await transientCount(), 0);
    await storage.exec('UPDATE transactions SET next_check_ms=?,lease_until_ms=0', Date.now() + 86_400_000);
    await env.ETHEREUM_REVEAL_METADATA.put('111k-sepolia/21.json', tampered);
    await storage.exec("UPDATE publication SET status='pending',next_check_ms=0 WHERE token_id='21'");
    for (let attempt = 0; attempt < 8; attempt++) {
      await storage.exec(`UPDATE publication SET next_check_ms=0 WHERE token_id IN ('1','21') AND status='pending'`);
      await object.watchdog(deployment);
      const status = (await storage.exec<{ status: string }>(`SELECT status FROM publication WHERE token_id='21'`))[0].status;
      if (status === 'conflict') break;
    }
    assert.equal((await storage.exec<{ status: string }>(`SELECT status FROM publication WHERE token_id='21'`))[0].status, 'conflict');
    assert.equal(await (await env.ETHEREUM_REVEAL_METADATA.get('111k-sepolia/21.json'))!.text(), tampered);
    assert.equal((await env.OPS_DB.prepare('SELECT last_error FROM ethereum_reveal_deployments WHERE deployment_id=?')
      .bind(deployment.deploymentId).first<{ last_error: string }>())!.last_error, 'metadata-conflict');
    const conflicted = await request<EthereumRevealTokensResponse>(ETHEREUM_REVEAL_PATHS.tokens, { tokenIds: ['21'] });
    assert.deepEqual(conflicted.artworks, concurrent[0].artworks.slice(0, 1));
    const partialResult = await request<EthereumRevealTokensResponse>(ETHEREUM_REVEAL_PATHS.tokens, { tokenIds: ['5001'] });
    assert.equal(partialResult.artworks.length, 1);
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM assignments WHERE token_id IS NOT NULL'))[0].count, 4040);
    assert.equal((await storage.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM assignments WHERE token_id='5021'`))[0].count, 0);
    const full = await request<EthereumRevealTransactionResponse>(ETHEREUM_REVEAL_PATHS.transaction, { transactionHash: partial.transactionHash });
    assert.equal(full.status, 'revealed');
    assert.equal(full.artworks.length, 40);
    assert.deepEqual(full.artworks[0], partialResult.artworks[0]);
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM assignments WHERE token_id IS NOT NULL'))[0].count, 4060);
    assert.equal((await storage.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM assignments WHERE CAST(token_id AS INTEGER)>=80001`))[0].count, 0);
    assert.equal((await storage.exec<{ count: number }>('SELECT COUNT(*) AS count FROM transactions WHERE hash=?', unasked.transactionHash))[0].count, 0);
    await storage.exec('UPDATE transactions SET next_check_ms=?,lease_until_ms=0', Date.now() + 86_400_000);
    await env.ETHEREUM_REVEAL_METADATA.delete('111k-sepolia/4020.json');
    await storage.exec("UPDATE publication SET status='pending',next_check_ms=? WHERE token_id='4020'", Date.now() + 60_000);
    await storage.exec(`UPDATE publication SET next_check_ms=? WHERE status='pending'`, Date.now() + 60_000);
    await object.watchdog(deployment);
    await runtime.update({ root: directory, workers: [{ config: { ...config, vars: { ...config.vars, LOCAL_REVEAL_RESTART: '1' } } }] });
    apiUrl = (await runtime.listen()).url;
    env = await worker.getEnv();
    storage = await worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name });
    const warmRpc = rpcCalls.length;
    const warmStarted = performance.now();
    const restored = await request<EthereumRevealTransactionResponse>(ETHEREUM_REVEAL_PATHS.transaction, { transactionHash: hash(1) });
    const restoredTokens = await request<EthereumRevealTokensResponse>(ETHEREUM_REVEAL_PATHS.tokens, { tokenIds: ['1', '21', '4020', '5001', '5040'] });
    const warmReadMs = performance.now() - warmStarted;
    assert.deepEqual(restored, baseline);
    assert.equal(restoredTokens.artworks.length, 5);
    assert.equal(rpcCalls.length, warmRpc, 'Frozen reads after restart must not wait for an RPC request.');
    const warmRpcCalls = rpcCalls.length - warmRpc;
    assert.equal(await (await env.ETHEREUM_REVEAL_METADATA.get('111k-sepolia/21.json'))!.text(), tampered);
    assert.equal(await env.ETHEREUM_REVEAL_METADATA.get('111k-sepolia/4020.json'), null);
    await storage.exec(`UPDATE publication SET next_check_ms=0 WHERE token_id='4020' AND status='pending'`);
    for (let attempt = 0; attempt < 8; attempt++) {
      await env.ETHEREUM_REVEAL.getByName(name).watchdog(deployment);
      if (await env.ETHEREUM_REVEAL_METADATA.get('111k-sepolia/4020.json')) break;
      await storage.exec(`UPDATE publication SET next_check_ms=? WHERE token_id!='4020' AND status='pending'`, Date.now() + 60_000);
      await storage.exec(`UPDATE publication SET next_check_ms=0 WHERE token_id='4020' AND status='pending'`);
    }
    const recoveredPublication = await env.ETHEREUM_REVEAL_METADATA.get('111k-sepolia/4020.json');
    assert.ok(recoveredPublication);
    assert.equal((await recoveredPublication.json<{ image: string }>()).image, concurrent[199].artworks[19].image);
    const waitingHash = hash(9000);
    await request<EthereumRevealTransactionResponse>(ETHEREUM_REVEAL_PATHS.transaction, { transactionHash: waitingHash });
    await storage.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', waitingHash);
    blockedReceiptHash = waitingHash;
    const slowWatchdog = env.ETHEREUM_REVEAL.getByName(name).watchdog(deployment);
    await receiptStarted.promise;
    await slowWatchdog;
    const fresh = fixture(400);
    receipts.set(fresh.transactionHash, fresh);
    const freshReveal = await request<EthereumRevealTransactionResponse>(ETHEREUM_REVEAL_PATHS.transaction, { transactionHash: fresh.transactionHash });
    assert.equal(freshReveal.artworks.length, 20);
    let alarmPublished: R2ObjectBody | null = null;
    for (let attempt = 0; attempt < 200; attempt++) {
      alarmPublished = await env.ETHEREUM_REVEAL_METADATA.get('111k-sepolia/8020.json');
      if (alarmPublished) break;
      await new Promise(done => setTimeout(done, 25));
    }
    assert.ok(alarmPublished, 'Alarms must publish subsequent batches while an unrelated RPC remains blocked.');
    assert.equal((await alarmPublished.json<{ image: string }>()).image, freshReveal.artworks[19].image);
    releaseReceipt.resolve();
    assert.deepEqual(rpcErrors, []);
    const report = {
      runtime: 'native-workerd', storage: 'isolated-local-sqlite-and-r2', loopbackConnectionsPerOrigin: 64, seeded: 111111, seedMs: rounded(seedMs),
      singleCrate: { artworks: 20, apiMs: rounded(singleCrateMs), rpcCalls: singleCrateRpcCalls },
      concurrent: { requests: 200, artworks: 4000, totalMs: rounded(concurrentTotalMs), p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95), maxMs: rounded(Math.max(...latencies)), rpcCalls: concurrentRpcCalls, maximumRpcHandlerConcurrency: maximumRpc,
        sameOriginAndIp: true, rateLimitedRequests: 0 },
      publication: { artworks: publishedCount, totalMsFromAdmission: rounded(publicationTotalMs) },
      sameIpPolling: { requests: 200, totalMs: rounded(pollingTotalMs), rateLimitedRequests: 0 },
      sqlite: { ...counts, inspectionMs: rounded(sqliteInspectionMs) },
      restartedFrozenReads: { requests: 2, totalMs: rounded(warmReadMs), rpcCalls: warmRpcCalls },
      rpc: { total: rpcCalls.length, handlerP95Ms: percentile(rpcCalls.map(call => call.durationMs), 0.95),
        methods: Object.fromEntries([...new Set(rpcCalls.map(call => call.method))].map(method => [method, rpcCalls.filter(call => call.method === method).length])) },
      publicationConflictPreserved: true, publicationRecoveredAfterRestart: true, publicationContinuesDuringSlowRpc: true,
      partialThenFullTransaction: true, unrelatedHistoryUnrevealed: true,
      fullTransientBudget: { queued: REVEAL_TRANSIENT_TRANSACTION_LIMIT, verifiedUnpacksAccepted: 200, rateLimitedRequests: 0 },
    };
    await mkdir(resolve('.cache'), { recursive: true });
    await writeFile(resolve('.cache/111k-reveal-runtime-results.json'), `${JSON.stringify(report, null, 2)}\n`);
    context.diagnostic(JSON.stringify(report));
  } finally {
    releaseReceipt.resolve();
    await runtime.close();
    rpc.closeAllConnections();
    await new Promise<void>((done, reject) => rpc.close(error => error ? reject(error) : done()));
    await rm(directory, { recursive: true, force: true });
  }
});
