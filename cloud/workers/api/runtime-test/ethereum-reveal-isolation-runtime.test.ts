import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestHarness } from 'wrangler';
import { encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.ts';
import { ethereumHexQuantity, ethereumMetadataTokenId, ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import { ETHEREUM_REVEAL_PATHS, type EthereumRevealTokensResponse, type EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.ts';
import { parseEthereumRevealDeployment, type EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { buildEthereumRevealRegistration, buildEthereumRevealTransition } from '../../../../scripts/ops/ethereumRevealControl.ts';
import { localEthereumRevealBindings } from '../../../../scripts/shared/ethereum111kLocalReveal.ts';
import { loadMetadataTemplates, renderMetadata, type MetadataTemplates } from '../../../../scripts/ethereum-metadata/catalog.ts';
import { mapWithConcurrency } from '../src/mapWithConcurrency.ts';

const CONTRACT_A = `0x${'11'.repeat(20)}`;
const CONTRACT_B = `0x${'22'.repeat(20)}`;
const OWNER = `0x${'33'.repeat(20)}`;
const WRAPPER = `0x${'44'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const HEAD = 1000;
const INCLUSION = 900;
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const blockHash = (chainId: number, number: number) => hash(chainId * 10_000 + number);
const word = (value: number) => encodeAbi(['uint256'], [value]);
const address = (value: string) => encodeAbi(['address'], [value]);
const SCOPES = [
  { deploymentId: 'old-sepolia', chainId: 11155111, contractAddress: CONTRACT_A, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/' },
  { deploymentId: 'new-sepolia', chainId: 11155111, contractAddress: CONTRACT_B, metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/new-sepolia/' },
  { deploymentId: 'mainnet', chainId: 1, contractAddress: CONTRACT_A, metadataBaseUri: 'https://cdn.mons.shop/111k/mainnet/' },
] as const;
type Scope = typeof SCOPES[number];
const objectName = (scope: Scope) => `${scope.chainId}:${scope.contractAddress}`;
const metadataKey = (scope: Scope, tokenId: number | string) => `${new URL(scope.metadataBaseUri).pathname.slice(1)}${tokenId}.json`;

function receipt(chainId: number, transactionHash: string, contracts: readonly string[], firstToken = 1) {
  const log = (contractAddress: string, topics: string[], data: string, logIndex: number) => ({
    address: contractAddress, topics, data, blockNumber: ethereumHexQuantity(INCLUSION), blockHash: blockHash(chainId, INCLUSION),
    transactionHash, logIndex: ethereumHexQuantity(logIndex), removed: false,
  });
  const crateToken = 111112 + (firstToken - 1) / 20;
  return { transactionHash, blockNumber: ethereumHexQuantity(INCLUSION), blockHash: blockHash(chainId, INCLUSION),
    status: '0x1', from: OWNER, to: contracts.length > 1 ? WRAPPER : contracts[0],
    logs: contracts.flatMap((contractAddress, index) => [
      log(contractAddress, [ETHEREUM_EVENT_TOPICS.Transfer, address(OWNER), address(ZERO), word(crateToken)], '0x', index * 22),
      ...Array.from({ length: 20 }, (_, offset) => log(contractAddress,
        [ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(OWNER), word(firstToken + offset)], '0x', index * 22 + offset + 1)),
      log(contractAddress, [ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(crateToken), address(OWNER)],
        encodeAbi(['uint256', 'uint256'], [firstToken, 20]), index * 22 + 21),
    ]),
  };
}

test('native reveal isolates old Sepolia, replacement Sepolia and mainnet with overlapping token and transaction IDs', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reveal-isolation-runtime-'));
  const production = JSON.parse(await readFile(resolve('cloud/workers/api/wrangler.jsonc'), 'utf8'));
  const config = { ...production, ...localEthereumRevealBindings(), main: resolve('cloud/workers/api/src/index.ts'),
    vars: { ...production.vars, ...Object.fromEntries((production.secrets?.required || []).map((name: string) => [name, ''])),
      ALCHEMY_MI_NOTE_API_KEY: 'isolation-test-only', ETHEREUM_111K_CHAIN_ID: '11155111',
      ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT_B, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
      ETHEREUM_111K_METADATA_BASE_URI: SCOPES[1].metadataBaseUri },
    d1_databases: production.d1_databases.map((database: Record<string, unknown>) => ({ ...database, remote: false,
      migrations_dir: resolve('cloud/workers/api', String(database.migrations_dir)) })),
  };
  delete config.$schema; delete config.account_id; delete config.routes; delete config.secrets;
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
  const runtime = createTestHarness({ root: directory, workers: [{ config }] });
  const receipts = new Map([
    [`11155111:${hash(1)}`, receipt(11155111, hash(1), [CONTRACT_A, CONTRACT_B])],
    [`1:${hash(1)}`, receipt(1, hash(1), [CONTRACT_A])],
    [`11155111:${hash(2)}`, receipt(11155111, hash(2), [CONTRACT_A])],
    [`1:${hash(3)}`, receipt(1, hash(3), [CONTRACT_A])],
    [`11155111:${hash(4)}`, receipt(11155111, hash(4), [CONTRACT_A, CONTRACT_B], 21)],
    [`1:${hash(4)}`, receipt(1, hash(4), [CONTRACT_A], 21)],
  ]);
  const rpcCalls: Array<{ chainId: number; method: string; params: unknown[] }> = [];
  const rpcErrors: string[] = [];
  let wrongMainnetChain = false;
  try {
    await runtime.listen();
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      try {
        assert.ok(['eth-sepolia.g.alchemy.com', 'eth-mainnet.g.alchemy.com'].includes(url.hostname), `Unexpected outbound request: ${url.origin}`);
        assert.equal(url.pathname, '/v2/isolation-test-only');
        const chainId = url.hostname === 'eth-mainnet.g.alchemy.com' ? 1 : 11155111;
        const { id, method, params } = await request.json() as { id: number; method: string; params: unknown[] };
        rpcCalls.push({ chainId, method, params });
        let result: unknown;
        if (method === 'eth_chainId') result = ethereumHexQuantity(chainId === 1 && wrongMainnetChain ? 11155111 : chainId);
        else if (method === 'eth_blockNumber') result = ethereumHexQuantity(HEAD);
        else if (method === 'eth_getBlockByNumber') {
          const number = params[0] === 'latest' ? HEAD : Number(BigInt(String(params[0])));
          result = { number: ethereumHexQuantity(number), hash: blockHash(chainId, number) };
        } else if (method === 'eth_getCode') {
          assert.ok(SCOPES.some(scope => scope.chainId === chainId && scope.contractAddress === params[0]));
          result = (params[1] as { blockHash: string }).blockHash === blockHash(chainId, 99) ? '0x' : '0x60006000';
        } else if (method === 'eth_getTransactionReceipt') result = receipts.get(`${chainId}:${params[0]}`) ?? null;
        else if (method === 'eth_getTransactionByHash') result = null;
        else if (method === 'eth_call') {
          const call = params[0] as { to: string; data: string };
          const scope = SCOPES.find(value => value.chainId === chainId && value.contractAddress === call.to);
          assert.ok(scope, `Unexpected contract call on chain ${chainId}: ${call.to}`);
          if (call.data === encodeCall('baseURI()', [], [])) result = encodeAbi(['string'], [scope.metadataBaseUri]);
          else if (call.data.startsWith(encodeCall(ETHEREUM_FUNCTIONS.stats, [], []))) {
            result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256'],
              [2, 0, 40, 0, 0, true, word(0), 0, 0, 0]);
          } else assert.fail(`Unexpected contract method: ${call.data.slice(0, 10)}`);
        } else if (method === 'eth_getLogs') {
          const filter = params[0] as { address: string; fromBlock: string; toBlock: string; topics: Array<string | string[] | null> };
          assert.ok(SCOPES.some(scope => scope.chainId === chainId && scope.contractAddress === filter.address));
          result = [...receipts.entries()].filter(([key]) => key.startsWith(`${chainId}:`)).flatMap(([, value]) => value.logs)
            .filter(log => log.address === filter.address && BigInt(log.blockNumber) >= BigInt(filter.fromBlock) &&
              BigInt(log.blockNumber) <= BigInt(filter.toBlock) && filter.topics.every((topic, index) => topic === null ||
                (Array.isArray(topic) ? topic.includes(log.topics[index]) : topic === log.topics[index])));
        } else assert.fail(`Unexpected RPC method: ${method}`);
        return Response.json({ jsonrpc: '2.0', id, result });
      } catch (error) {
        rpcErrors.push(String(error));
        throw error;
      }
    });
    const worker = runtime.getWorker<Env>('mons-shop-api');
    for (const binding of ['DATA_DB', 'OPS_DB', 'COMMERCE_DB'] as const) await worker.applyD1Migrations(binding);
    let env = await worker.getEnv();
    const deployments = new Map<string, EthereumRevealDeployment>();
    const templates = new Map<string, MetadataTemplates>();
    const { templates: sourceTemplates } = await loadMetadataTemplates();
    for (const scope of SCOPES) {
      const scopedTemplates = structuredClone(sourceTemplates);
      for (const template of Object.values(scopedTemplates)) template.description = scope.deploymentId;
      scopedTemplates.artwork.name = `${scope.deploymentId} #{{tokenId}}`;
      templates.set(scope.deploymentId, scopedTemplates);
      const templateJson = JSON.stringify(scopedTemplates.artwork);
      const registered = await env.OPS_DB.prepare(buildEthereumRevealRegistration({ ...scope,
        dropId: '111k_devnet', deploymentBlock: 100, catalogVersion: '111k-v1', templateJson,
        templateSha256: createHash('sha256').update(templateJson).digest('hex') })).first<Record<string, unknown>>();
      assert.ok(registered);
      let deployment = parseEthereumRevealDeployment(registered);
      const object = env.ETHEREUM_REVEAL.getByName(objectName(scope));
      for (let attempt = 0; deployment.state === 'provisioning' && attempt < 32; attempt++) {
        await object.initialize(deployment);
        const row = await env.OPS_DB.prepare('SELECT * FROM ethereum_reveal_deployments WHERE deployment_id=?')
          .bind(scope.deploymentId).first<Record<string, unknown>>();
        assert.ok(row);
        deployment = parseEthereumRevealDeployment(row);
      }
      assert.equal(deployment.state, 'ready');
      const activated = await env.OPS_DB.prepare(buildEthereumRevealTransition('activate', deployment, deployment.revision))
        .first<Record<string, unknown>>();
      assert.ok(activated);
      deployments.set(scope.deploymentId, parseEthereumRevealDeployment(activated));
    }
    const storage = (scope: Scope) => worker.getDurableObjectStorage('ETHEREUM_REVEAL', { name: objectName(scope) });
    const ledger = async (scope: Scope) => {
      const db = await storage(scope);
      return { pools: await db.exec<{ category: string; total: number; seeded: number; available: number }>('SELECT * FROM pools ORDER BY category'),
        assignments: await db.exec<{ token_id: string; metadata_json: string; placeholder_json: string }>('SELECT token_id,metadata_json,placeholder_json FROM assignments ORDER BY CAST(token_id AS INTEGER)'),
        publication: await db.exec<{ token_id: string; status: string }>('SELECT token_id,status FROM publication ORDER BY CAST(token_id AS INTEGER)') };
    };
    const initialLedgers = await Promise.all(SCOPES.map(ledger));
    for (const value of initialLedgers) {
      assert.equal(value.pools.reduce((total, pool) => total + pool.available, 0), 111111);
      assert.ok(value.pools.every(pool => pool.total === pool.seeded && pool.seeded === pool.available));
      assert.deepEqual(value.assignments, []);
      assert.deepEqual(value.publication, []);
    }
    const baseline = new Map<string, string>();
    const samples = [...Array.from({ length: 40 }, (_, index) => ['artwork', index + 1] as const),
      ['artwork_receipt', 1], ['artwork_receipt', 111112], ['artwork_receipt', 222222],
      ['crate_receipt', 1], ['crate', 1], ['warehouse', 1], ['monument', 1]] as const;
    for (const scope of SCOPES) {
      for (const [kind, displayId] of samples) baseline.set(metadataKey(scope, ethereumMetadataTokenId(kind, displayId)),
        `${JSON.stringify(renderMetadata(kind, displayId, templates.get(scope.deploymentId)!), null, 2)}\n`);
    }
    await mapWithConcurrency([...baseline], 8, ([key, body]) => env.ETHEREUM_REVEAL_METADATA.put(key, body), { signal: t.signal });
    const objects = async () => {
      const listed = await env.ETHEREUM_REVEAL_METADATA.list();
      assert.equal(listed.truncated, false);
      return Object.fromEntries(await mapWithConcurrency(listed.objects, 8, async item => {
        const object = await env.ETHEREUM_REVEAL_METADATA.get(item.key);
        assert.ok(object);
        return [item.key, { body: await object.text(), etag: object.etag }] as const;
      }, { signal: t.signal }));
    };
    const initialObjects = await objects();
    const waitFor = async (message: string, predicate: () => Promise<boolean>) => {
      const deadline = performance.now() + 15_000;
      do {
        if (await predicate()) return;
        await new Promise(done => setTimeout(done, 20));
      } while (performance.now() < deadline);
      assert.fail(`${message}: ${JSON.stringify({ rpcErrors, logs: runtime.getLogs().filter(log => log.level === 'error').slice(-4) })}`);
    };
    const request = async <T>(scope: Scope, path: string, input: object, status = 200): Promise<T> => {
      const response = await worker.fetch(`https://api.mons.shop${path}`, { method: 'POST', headers: {
        Origin: 'https://vvv.so', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1', 'CF-Connecting-IP': '192.0.2.249',
      }, body: JSON.stringify({ chainId: scope.chainId, contractAddress: scope.contractAddress, ...input }) });
      const body = await response.json();
      assert.equal(response.status, status, JSON.stringify(body));
      return body as T;
    };
    const reveal = async (scope: Scope, transactionHash: string) => {
      let result: EthereumRevealTransactionResponse | undefined;
      await waitFor(`Reveal ${objectName(scope)}:${transactionHash} did not finish`, async () => {
        result = await request(scope, ETHEREUM_REVEAL_PATHS.transaction, { transactionHash });
        return result?.status === 'revealed';
      });
      assert.ok(result);
      assert.equal(result.deploymentId, scope.deploymentId);
      assert.equal(result.chainId, scope.chainId);
      assert.equal(result.contractAddress, scope.contractAddress);
      assert.equal(result.artworks.length, 20);
      assert.ok(result.artworks.every(artwork => artwork.name.startsWith(`${scope.deploymentId} #`) &&
        artwork.observation.blockHash === blockHash(scope.chainId, INCLUSION)));
      return result;
    };
    const published = async (scope: Scope, count: number) => waitFor(`Publication ${objectName(scope)} did not drain`, async () =>
      (await ledger(scope)).publication.filter(value => value.status === 'published').length === count);
    const assertMetadata = async (revealedCounts: readonly number[]) => {
      const current = await objects();
      assert.deepEqual(Object.keys(current).sort(), Object.keys(initialObjects).sort());
      for (const [index, scope] of SCOPES.entries()) {
        const value = await ledger(scope);
        assert.equal(value.assignments.length, revealedCounts[index]);
        assert.equal(value.pools.reduce((total, pool) => total + pool.available, 0), 111111 - revealedCounts[index]);
        const expected = new Map(value.assignments.map(row => [metadataKey(scope, row.token_id), row.metadata_json]));
        for (const row of value.assignments) assert.equal(row.placeholder_json, baseline.get(metadataKey(scope, row.token_id)));
        const prefix = new URL(scope.metadataBaseUri).pathname.slice(1);
        for (const key of baseline.keys()) {
          if (!key.startsWith(prefix) || key.slice(prefix.length).includes('/')) continue;
          if (expected.has(key)) assert.equal(current[key].body, expected.get(key));
          else assert.deepEqual(current[key], initialObjects[key], `Unrevealed or receipt metadata changed: ${key}`);
        }
      }
    };

    await t.test('public callers cannot override deployment identity or publication prefix', async () => {
      const callsBefore = rpcCalls.length;
      for (const scope of SCOPES) for (const extra of [
        { metadataBaseUri: SCOPES[2].metadataBaseUri }, { deploymentId: 'mainnet' }, { chainId: 10 },
      ]) await request(scope, ETHEREUM_REVEAL_PATHS.transaction, { transactionHash: hash(1), ...extra }, 400);
      assert.equal(rpcCalls.length, callsBefore);
      assert.deepEqual(await Promise.all(SCOPES.map(ledger)), initialLedgers);
      assert.deepEqual(await objects(), initialObjects);
    });

    await t.test('foreign contract receipts and wrong-chain providers cannot allocate or publish', async () => {
      const foreign = await request<EthereumRevealTransactionResponse>(SCOPES[1], ETHEREUM_REVEAL_PATHS.transaction, { transactionHash: hash(2) });
      assert.equal(foreign.status, 'not_unpack');
      assert.deepEqual(foreign.artworks, []);
      wrongMainnetChain = true;
      const callsBefore = rpcCalls.length;
      const wrongChain = await request<EthereumRevealTransactionResponse>(SCOPES[2], ETHEREUM_REVEAL_PATHS.transaction, { transactionHash: hash(3) });
      assert.equal(wrongChain.status, 'pending');
      assert.deepEqual(wrongChain.artworks, []);
      assert.ok(rpcCalls.slice(callsBefore).some(call => call.chainId === 1 && call.method === 'eth_chainId'));
      receipts.delete(`1:${hash(3)}`);
      wrongMainnetChain = false;
      assert.deepEqual(await Promise.all(SCOPES.map(ledger)), initialLedgers);
      assert.deepEqual(await objects(), initialObjects);
    });

    const first = await reveal(SCOPES[0], hash(1));
    await t.test('revealing old Sepolia leaves the replacement and mainnet pools and metadata untouched', async () => {
      assert.deepEqual(first.artworks.map(value => value.tokenId), Array.from({ length: 20 }, (_, index) => String(index + 1)));
      assert.ok(first.artworks.every(value => value.crateTokenId === '111112'));
      await published(SCOPES[0], 20);
      assert.deepEqual(await ledger(SCOPES[1]), initialLedgers[1]);
      assert.deepEqual(await ledger(SCOPES[2]), initialLedgers[2]);
      await assertMetadata([20, 0, 0]);
    });

    const results = await Promise.all(SCOPES.map(scope => reveal(scope, hash(1))));
    await t.test('concurrent overlapping identities reveal only each registered deployment', async () => {
      assert.deepEqual(results[0], first);
      for (const result of results) assert.ok(result.artworks.every(value => value.crateTokenId === '111112'));
      await Promise.all(SCOPES.map(scope => published(scope, 20)));
      await assertMetadata([20, 20, 20]);
      assert.equal(new Set((await Promise.all(SCOPES.map(ledger))).map(value => value.assignments[0].metadata_json)).size, 3);
    });

    await t.test('wrapped receipts filter both contracts while concurrent publication stays within each prefix', async () => {
      const wrapped = await Promise.all(SCOPES.map(scope => reveal(scope, hash(4))));
      for (const result of wrapped) {
        assert.deepEqual(result.artworks.map(value => value.tokenId), Array.from({ length: 20 }, (_, index) => String(index + 21)));
        assert.ok(result.artworks.every(value => value.crateTokenId === '111113'));
      }
      await Promise.all(SCOPES.map(scope => published(scope, 40)));
      await assertMetadata([40, 40, 40]);
    });

    await t.test('fresh executors retain scoped frozen reads and recover only their own publication jobs', async () => {
      const before = await Promise.all(SCOPES.map(ledger));
      const beforeObjects = await objects();
      const future = Date.now() + 86_400_000;
      for (const scope of SCOPES) {
        await (await storage(scope)).exec('UPDATE reveal_dispatch_control SET pause_until_ms=? WHERE id=1', future);
      }
      await waitFor('Recovery claims did not drain before restart', async () => {
        const claims = await Promise.all(SCOPES.map(async scope => (await (await storage(scope)).exec<{ count: number }>(
          `SELECT (SELECT COUNT(*) FROM receipt_work WHERE claim_id IS NOT NULL AND lease_until_ms>?)
            +(SELECT COUNT(*) FROM recovery_jobs WHERE claim_id IS NOT NULL AND lease_until_ms>?)
            +(SELECT COUNT(*) FROM crate_recovery_jobs WHERE scan_claim_id IS NOT NULL AND scan_lease_until_ms>?) AS count`,
          Date.now(), Date.now(), Date.now()))[0].count));
        return claims.every(count => count === 0);
      });
      for (const scope of SCOPES) {
        const db = await storage(scope);
        await db.exec('UPDATE receipt_work SET next_check_ms=?,active_until_ms=0', future);
        await db.exec('UPDATE crate_candidates SET next_check_ms=?', future);
        await db.exec('UPDATE crate_recovery_jobs SET receipt_due_ms=?,scan_due_ms=NULL,active_until_ms=0', future);
        await db.exec('UPDATE recovery_jobs SET next_check_ms=?,active_until_ms=0', future);
        await db.exec("UPDATE publication SET status='pending',next_check_ms=? WHERE token_id IN ('1','20')", future);
        await env.ETHEREUM_REVEAL_METADATA.delete(metadataKey(scope, 20));
        await db.exec('UPDATE reveal_dispatch_control SET pause_until_ms=0 WHERE id=1');
      }
      await runtime.update({ root: directory, workers: [{ config: { ...config,
        vars: { ...config.vars, LOCAL_ISOLATION_RESTART: '1' } } }] });
      env = await worker.getEnv();
      const callsBefore = rpcCalls.length;
      const reread = await Promise.all(SCOPES.map(scope => request<EthereumRevealTokensResponse>(scope, ETHEREUM_REVEAL_PATHS.tokens, { tokenIds: ['1', '20'] })));
      for (const [index, scope] of SCOPES.entries()) {
        assert.equal(reread[index].deploymentId, scope.deploymentId);
        assert.equal(reread[index].chainId, scope.chainId);
        assert.equal(reread[index].contractAddress, scope.contractAddress);
        assert.deepEqual(reread[index].unresolved, []);
        assert.deepEqual(reread[index].artworks, [results[index].artworks[0], results[index].artworks[19]]);
        const current = await ledger(scope);
        assert.deepEqual(current.assignments, before[index].assignments);
        assert.deepEqual(current.pools, before[index].pools);
      }
      assert.equal(rpcCalls.length, callsBefore, JSON.stringify(rpcCalls.slice(callsBefore)));
      await Promise.all(SCOPES.map(async scope => {
        await (await storage(scope)).exec("UPDATE publication SET next_check_ms=0 WHERE status='pending'");
        await env.ETHEREUM_REVEAL.getByName(objectName(scope)).watchdog(deployments.get(scope.deploymentId)!);
        await published(scope, 40);
      }));
      await assertMetadata([40, 40, 40]);
      const afterObjects = await objects();
      for (const [key, value] of Object.entries(beforeObjects)) assert.deepEqual(afterObjects[key], value);
      assert.equal(rpcCalls.length, callsBefore, JSON.stringify(rpcCalls.slice(callsBefore)));
    });
    assert.deepEqual(rpcErrors, []);
    t.diagnostic(JSON.stringify({ runtime: 'native-workerd', deployments: 3, overlappingTokenId: '1', overlappingCrateId: '111112',
      overlappingTransactionHash: hash(1), frozenArtworksPerDeployment: 40, isolatedMetadataObjects: baseline.size,
      blockedForeignEvidence: true, wrappedContractFiltering: true, scopedRestartRecovery: true }));
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
