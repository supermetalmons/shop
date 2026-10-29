import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import { ETHEREUM_REVEAL_PATHS } from '../../../../shared/ethereum/reveal.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import type { EthereumRevealStore, RevealSql, RevealTransactionJob } from '../src/ethereumRevealStore.ts';
import type { EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';
import { d1Database } from './commerceD1Harness.ts';

const { EthereumRevealObject } = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealObject.ts'));
const REVEAL_TRANSIENT_TRANSACTION_LIMIT = 10_000;
const REVEAL_TRANSIENT_TRANSACTION_TTL_MS = 15 * 60_000;
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const CONTRACT = `0x${'11'.repeat(20)}`;
const OWNER = `0x${'22'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const ids = (first: number) => Array.from({ length: 20 }, (_, index) => String(first + index));
const deployment: EthereumRevealDeployment = {
  deploymentId: 'test-local', dropId: '111k_devnet', chainId: 31337, contractAddress: CONTRACT,
  metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/', deploymentBlock: 100, catalogVersion: '111k-v1',
  templateJson: JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://wip.lil.org/111k/artwork_placeholder.png', attributes: [] }),
  templateSha256: '0'.repeat(64), state: 'active', revision: 3,
  createdAtMs: 1, updatedAtMs: 3, provisionedAtMs: 2, activatedAtMs: 3, lastError: null,
};

function receipt(transactionHash: string, blockNumber: number, crates = [{ crateTokenId: '111112', first: 1 }]) {
  const word = (value: string | number) => encodeAbi(['uint256'], [value]);
  const address = (value: string) => encodeAbi(['address'], [value]);
  const log = (topics: string[], data: string, index: number) => ({ address: CONTRACT, topics, data,
    blockNumber: `0x${blockNumber.toString(16)}`, blockHash: hash(blockNumber), transactionHash, logIndex: `0x${index.toString(16)}` });
  return { transactionHash, blockNumber: `0x${blockNumber.toString(16)}`, blockHash: hash(blockNumber), status: '0x1',
    logs: crates.flatMap((crate, crateIndex) => [
      log([ETHEREUM_EVENT_TOPICS.Transfer, address(OWNER), address(ZERO), word(crate.crateTokenId)], '0x', crateIndex * 22),
      ...ids(crate.first).map((tokenId, index) => log([ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(OWNER), word(tokenId)], '0x', crateIndex * 22 + index + 1)),
      log([ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(crate.crateTokenId), address(OWNER)],
        encodeAbi(['uint256', 'uint256'], [crate.first, 20]), crateIndex * 22 + 21),
    ]),
  };
}

function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  const sql: RevealSql = { exec(query, ...bindings) {
    const statement = database.prepare(query);
    const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    return { toArray: () => rows as never[] };
  } };
  let alarm: number | null = null;
  const tasks = new Set<Promise<unknown>>();
  const published = new Map<string, string>();
  const firstBatch = Promise.withResolvers<void>();
  const context = {
    storage: { sql, transactionSync<T>(action: () => T) {
      database.exec('BEGIN');
      try { const result = action(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    }, getAlarm: async () => alarm, setAlarm: async (value: number) => { alarm = value; } },
    waitUntil(promise: Promise<unknown>) {
      tasks.add(promise);
      void promise.finally(() => tasks.delete(promise)).catch(() => undefined);
    },
  };
  const env = { ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545', ALCHEMY_MI_NOTE_API_KEY: '',
    ETHEREUM_REVEAL_METADATA: {
      async get(key: string) {
        const body = published.get(key);
        return body === undefined ? null : { size: body.length, text: async () => body, etag: 'test' };
      },
      async put(key: string, body: string) {
        published.set(key, body);
        if (published.size >= 8) firstBatch.resolve();
        return {};
      },
    },
  };
  const object = new EthereumRevealObject(context as unknown as DurableObjectState, env as unknown as Env);
  const internal = object as unknown as {
    store: EthereumRevealStore;
    processTransaction(deployment: EthereumRevealDeployment, hash: string): Promise<void>;
    findReplacement(deployment: EthereumRevealDeployment, job: RevealTransactionJob, signal: AbortSignal): Promise<boolean>;
    runPublications(deployment: EthereumRevealDeployment): Promise<void>;
  };
  internal.store.configure(deployment);
  while (!internal.store.initializeChunk()) {}
  const state = { head: 1000, receipts: new Map<string, ReturnType<typeof receipt> | Promise<ReturnType<typeof receipt> | null>>(),
    missingReceipts: new Set<string>(), canonicalHashes: new Map<number, string>(), logsUnavailable: false,
    ranges: [] as Array<{ from: number; to: number }>, calls: [] as string[], receiptLookups: [] as string[], runningReceipts: 0, peakReceipts: 0 };
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    state.calls.push(method);
    let result: unknown;
    if (method === 'eth_chainId') result = '0x7a69';
    else if (method === 'eth_blockNumber') result = `0x${state.head.toString(16)}`;
    else if (method === 'eth_getTransactionReceipt') {
      state.receiptLookups.push(params[0]);
      state.runningReceipts++;
      state.peakReceipts = Math.max(state.peakReceipts, state.runningReceipts);
      try { result = state.missingReceipts.has(params[0]) ? null : await state.receipts.get(params[0]) ?? null; }
      finally { state.runningReceipts--; }
    }
    else if (method === 'eth_getTransactionByHash') result = null;
    else if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'latest' ? state.head : Number(BigInt(params[0]));
      result = { number: `0x${number.toString(16)}`, hash: state.canonicalHashes.get(number) ?? hash(number) };
    } else if (method === 'eth_getLogs') {
      if (state.logsUnavailable) throw new Error('Logs unavailable');
      const filter = params[0];
      const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
      state.ranges.push({ from, to });
      result = [...state.receipts.values()].filter((value): value is ReturnType<typeof receipt> => !(value instanceof Promise)).flatMap(value => value.logs)
        .filter(log => Number(BigInt(log.blockNumber)) >= from && Number(BigInt(log.blockNumber)) <= to &&
          filter.topics.every((topic: string | string[] | null, index: number) => topic === null ||
            (Array.isArray(topic) ? topic.includes(log.topics[index]) : topic === log.topics[index])));
    } else throw new Error(`Unexpected RPC ${method}`);
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  t.after(() => database.close());
  const freeze = (transactionHash: string, first = 1, crateTokenId = '111112', all = true) => internal.store.freeze(deployment,
    { transactionHash, blockNumber: 101, blockHash: hash(101) }, [{ crateTokenId, tokenIds: ids(first) }], Date.now(), all);
  return { object, internal, store: internal.store, database, sql, state, published, firstBatch: firstBatch.promise, freeze,
    metadata: env.ETHEREUM_REVEAL_METADATA, getAlarm: () => alarm,
    reopen: () => new EthereumRevealObject(context as unknown as DurableObjectState, env as unknown as Env) as unknown as typeof internal,
    settle: () => Promise.allSettled([...tasks]) };
}

function fillTransientQueue(f: ReturnType<typeof fixture>) {
  const now = Date.now();
  f.sql.exec(`WITH RECURSIVE ids(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM ids WHERE id<?)
    INSERT INTO transactions(hash,from_block,created_at_ms,last_requested_at_ms,next_check_ms,admission_expires_at_ms)
    SELECT printf('0x%064x',id+1000000),100,?,?,?,? FROM ids`, REVEAL_TRANSIENT_TRANSACTION_LIMIT,
    now, now, now + 3_600_000, now + REVEAL_TRANSIENT_TRANSACTION_TTL_MS);
}

test('full transient capacity returns retrying pending without storage and later reveals a legitimate transaction', async t => {
  const f = fixture(t);
  fillTransientQueue(f);
  const first = await f.object.revealTransaction(deployment, hash(1));
  assert.equal(first.status, 'pending');
  assert.equal(first.retryAfterMs, 2_000);
  assert.equal(f.store.transactionJob(hash(1)), undefined);
  assert.equal(f.store.transientTransactionCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  f.state.receipts.set(hash(1), receipt(hash(1), 1000));
  const revealed = await f.object.revealTransaction(deployment, hash(1));
  await f.settle();
  assert.equal(revealed.status, 'revealed');
  assert.equal(revealed.artworks.length, 20);
  assert.equal(f.store.transactionJob(hash(1))!.transient, 0);
  assert.equal(f.store.transientTransactionCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  assert.equal(f.state.receiptLookups.filter(value => value === hash(1)).length, 2);
  assert.equal(f.published.size, 20);
});

test('a validated owned pending unpack bypasses a full transient queue and keeps background tracking', async t => {
  const f = fixture(t);
  fillTransientQueue(f);
  const provider = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    let result: unknown;
    if (method === 'eth_getTransactionByHash') result = { hash: hash(1), from: OWNER, to: CONTRACT, value: '0x0',
      input: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], ['111112']), blockNumber: null, chainId: '0x7a69' };
    else if (method === 'eth_call') result = encodeAbi(['(uint8,uint256,address)[]'], [[[2, 1, OWNER]]]);
    else return provider(url, init);
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  });
  const response = await f.object.revealTransaction(deployment, hash(1));
  await f.settle();
  assert.equal(response.status, 'pending');
  assert.deepEqual(response.artworks, []);
  assert.deepEqual(JSON.parse(f.store.transactionJob(hash(1))!.crates_json), ['111112']);
  assert.equal(f.store.transactionJob(hash(1))!.transient, 0);
  assert.equal(f.store.summary().reserved, 20);
  assert.equal(f.store.transientTransactionCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
});

for (const status of ['reverted', 'not_unpack'] as const) test(`overflow ${status} receipts keep clients polling until stable evidence without adding storage`, async t => {
  const f = fixture(t);
  fillTransientQueue(f);
  const failed = { ...receipt(hash(1), 1000), status: status === 'reverted' ? '0x0' : '0x1', logs: [] };
  f.state.receipts.set(hash(1), failed);
  const recent = await f.object.revealTransaction(deployment, hash(1));
  assert.equal(recent.status, 'pending');
  assert.equal(recent.retryAfterMs, 2_000);
  assert.equal(f.store.transactionJob(hash(1)), undefined);
  f.state.head = 1063;
  const stable = await f.object.revealTransaction(deployment, hash(1));
  assert.equal(stable.status, status);
  assert.equal(stable.retryAfterMs, 0);
  assert.equal(f.store.transactionJob(hash(1)), undefined);
  assert.equal(f.store.transientTransactionCount(), REVEAL_TRANSIENT_TRANSACTION_LIMIT);
  f.state.receipts.set(hash(2), { ...failed, transactionHash: hash(2), blockNumber: '0x427', blockHash: hash(1063) });
  assert.equal((await f.object.revealTransaction(deployment, hash(2))).status, 'pending');
  f.state.receipts.set(hash(2), receipt(hash(2), 1063));
  assert.equal((await f.object.revealTransaction(deployment, hash(2))).status, 'revealed');
  await f.settle();
});

for (const outcome of ['confirmed', 'failure'] as const) test(`an expired inspector cannot mutate a reinserted hash after a late ${outcome}`, async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const pending = Promise.withResolvers<ReturnType<typeof receipt> | null>();
  f.state.receipts.set(hash(1), pending.promise);
  const first = f.object.revealTransaction(deployment, hash(1)).then(value => value, () => null);
  try {
    for (let attempt = 0; attempt < 100 && !f.state.receiptLookups.includes(hash(1)); attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(f.state.receiptLookups.includes(hash(1)));
    const original = f.store.transactionJob(hash(1))!;
    now += REVEAL_TRANSIENT_TRANSACTION_TTL_MS + 30_001;
    f.state.receipts.delete(hash(1));
    const replacement = await f.object.revealTransaction(deployment, hash(1));
    assert.equal(replacement.status, 'pending');
    const current = f.store.transactionJob(hash(1))!;
    assert.notEqual(current.incarnation, original.incarnation);
    if (outcome === 'confirmed') pending.resolve(receipt(hash(1), 1000));
    else pending.reject(new Error('Old RPC failed'));
    await first;
    await f.settle();
    assert.deepEqual(f.store.transactionJob(hash(1)), current);
    assert.equal(f.store.frozen(ids(1)).length, 0);
    assert.equal(f.store.transientTransactionCount(), 1);
  } finally {
    pending.resolve(null);
    await first;
    await f.settle();
  }
});

test('paused complete token recoveries remain read-only transaction results', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
  const before = f.store.transactionJob(hash(1))!;
  assert.equal(before.requested_all, 0);
  assert.equal(before.revealed_all, 1);
  const paused = { ...deployment, state: 'paused' as const };
  assert.equal(await f.object.hasTransaction(paused, hash(1)), true);
  const response = await f.object.revealTransaction(paused, hash(1));
  await f.settle();
  assert.equal(response.status, 'revealed');
  assert.equal(response.artworks.length, 20);
  assert.deepEqual(f.store.transactionJob(hash(1)), before);
  assert.deepEqual(f.state.calls, []);
  assert.equal(f.published.size, 0);
  assert.equal(f.sql.exec('SELECT COUNT(*) AS count FROM transactions').toArray()[0].count, 1);
  assert.equal(f.sql.exec('SELECT COUNT(*) AS count FROM recovery_jobs').toArray()[0].count, 0);
});

test('active complete token recoveries still upgrade full transaction tracking without waiting for RPC', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  const pendingReceipt = Promise.withResolvers<ReturnType<typeof receipt> | null>();
  f.state.receipts.set(hash(1), pendingReceipt.promise);
  try {
    assert.equal(await f.object.hasTransaction(deployment, hash(1)), false);
    const response = await f.object.revealTransaction(deployment, hash(1));
    assert.equal(response.status, 'revealed');
    assert.equal(response.artworks.length, 20);
    assert.equal(f.store.transactionJob(hash(1))!.requested_all, 1);
    assert.equal(f.state.calls.filter(method => method === 'eth_getTransactionReceipt').length, 1);
  } finally {
    pendingReceipt.resolve(receipt(hash(1), 101));
    await f.settle();
  }
});

test('paused HTTP transaction reads allow complete frozen results and reject partial recovery', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  f.freeze(hash(2), 21, '111113', false);
  f.freeze(hash(3), 41, '111114');
  f.store.registerTransaction(hash(3), deployment.deploymentBlock);
  f.sql.exec('UPDATE transactions SET next_check_ms=? WHERE hash=?', Date.now() + 60_000, hash(3));
  f.database.exec(readFileSync('cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', 'utf8'));
  f.sql.exec(`INSERT INTO ethereum_reveal_deployments(deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,
    deployment_block,catalog_version,template_json,template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,activated_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,'paused',4,1,4,2,3)`, deployment.deploymentId, deployment.dropId, deployment.chainId,
    CONTRACT, deployment.metadataBaseUri, deployment.deploymentBlock, deployment.catalogVersion, deployment.templateJson, deployment.templateSha256);
  const readLimiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: EthereumEnvironment = {
    OPS_DB: d1Database(f.database), COMMERCE_DB: d1Database(f.database), ALCHEMY_MI_NOTE_API_KEY: '',
    ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
    ETHEREUM_111K_METADATA_BASE_URI: deployment.metadataBaseUri, ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545',
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: readLimiter, STAFF_AUTH_SESSION_RATE_LIMITER: readLimiter,
    PUBLIC_SHOP_RATE_LIMITER: readLimiter, ETHEREUM_REVEAL_READ_RATE_LIMITER: readLimiter,
    ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER: { limit: async () => assert.fail('Paused reads must not request admission') },
    ETHEREUM_REVEAL: { getByName: () => f.object } as unknown as Env['ETHEREUM_REVEAL'],
  };
  const request = (transactionHash: string) => handleEthereumRequest(new Request(`https://api.mons.shop${ETHEREUM_REVEAL_PATHS.transaction}`, {
    method: 'POST', headers: { Origin: 'https://vvv.so', 'X-Mons-CSRF': '1', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
    body: JSON.stringify({ chainId: deployment.chainId, contractAddress: CONTRACT, transactionHash }),
  }), env, ETHEREUM_REVEAL_PATHS.transaction);
  try {
    const before = f.store.transactionJob(hash(1));
    for (const transactionHash of [hash(1), hash(3)]) {
      const response = await request(transactionHash);
      assert.equal(response.status, 200);
      const value = await response.json() as { status: string; artworks: unknown[] };
      assert.equal(value.status, 'revealed');
      assert.equal(value.artworks.length, 20);
    }
    assert.equal((await request(hash(2))).status, 409);
    assert.deepEqual(f.store.transactionJob(hash(1)), before);
    assert.equal(f.store.transactionJob(hash(2))!.requested_all, 0);
    assert.equal(f.store.transactionJob(hash(3))!.requested_all, 1);
    assert.deepEqual(f.state.calls, []);
  } finally { await f.settle(); }
});

test('replacement recovery replays old split bounds before advancing to newer blocks', async t => {
  const f = fixture(t);
  f.store.registerTransaction(hash(1), 100);
  f.store.pendingTransaction(hash(1), ['111112'], 100, Date.now());
  f.store.replacementRanges(hash(1), [{ fromBlock: 301, toBlock: 500 }, { fromBlock: 100, toBlock: 300 }], 100);
  const replacement = receipt(hash(2), 600);
  f.state.receipts.set(hash(2), replacement);
  for (let index = 0; index < 2; index++) {
    await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000));
  }
  assert.deepEqual(f.state.ranges, [{ from: 301, to: 500 }, { from: 100, to: 300 }]);
  assert.equal(f.store.transactionJob(hash(1))!.from_block, 500);
  await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000));
  assert.deepEqual(f.state.ranges[2], { from: 436, to: 1000 });
  assert.equal(f.store.frozen(ids(1)).length, 20);
  assert.equal(f.store.frozen(['1'])[0].observation.transactionHash, hash(2));
});

test('newest-first replacement leaves smaller than the overlap retain their completed high-water mark', async t => {
  const f = fixture(t);
  f.store.registerTransaction(hash(1), 100);
  f.store.pendingTransaction(hash(1), ['111112'], 100, Date.now());
  const ranges = Array.from({ length: 51 }, (_, index) => ({ fromBlock: 100 + index * 8, toBlock: Math.min(500, 107 + index * 8) })).reverse();
  f.store.replacementRanges(hash(1), ranges, 100);
  for (let index = 0; index < ranges.length; index++) {
    await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000));
    assert.equal(f.store.transactionJob(hash(1))!.from_block, 500);
  }
  assert.deepEqual(f.state.ranges.at(-1), { from: 100, to: 107 });
  assert.equal(f.store.transactionJob(hash(1))!.replacement_ranges_json, '[]');
  await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000));
  assert.deepEqual(f.state.ranges.at(-1), { from: 436, to: 1000 });
});

for (const unavailable of ['missing', 'noncanonical'] as const) test(`${unavailable} replacement receipts recover after restart beyond the overlap without another log lookup`, async t => {
  const f = fixture(t);
  f.store.registerTransaction(hash(1), 100);
  f.store.pendingTransaction(hash(1), ['111112'], 100, Date.now());
  f.state.receipts.set(hash(2), receipt(hash(2), 200));
  if (unavailable === 'missing') f.state.missingReceipts.add(hash(2));
  else f.state.canonicalHashes.set(200, hash(9999));
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), false);
  assert.equal(f.store.transactionJob(hash(1))!.from_block, 1000);
  assert.equal(f.store.summary().frozen, 0);
  const restored = f.reopen();
  f.state.missingReceipts.clear();
  f.state.canonicalHashes.clear();
  f.state.head = 2000;
  f.state.logsUnavailable = true;
  assert.equal(await restored.findReplacement(deployment, restored.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), true);
  assert.equal(f.state.calls.filter(method => method === 'eth_getLogs').length, 1);
  assert.equal(restored.store.frozen(ids(1)).length, 20);
  assert.equal(restored.store.transactionJob(hash(1))!.dormant, 1);
  assert.equal(restored.store.transactionJob(hash(2))!.dormant, 0);
});

test('later unverified replacement hashes do not overwrite earlier candidates for the same crate', async t => {
  const f = fixture(t);
  f.store.registerTransaction(hash(1), 100);
  f.store.pendingTransaction(hash(1), ['111112'], 100, Date.now());
  const first = receipt(hash(2), 200);
  f.state.receipts.set(hash(2), first);
  f.state.missingReceipts.add(hash(2));
  await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000));
  f.state.receipts.delete(hash(2));
  f.state.head = 2000;
  f.state.receipts.set(hash(3), receipt(hash(3), 1500));
  f.state.missingReceipts.add(hash(3));
  await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000));
  assert.deepEqual(new Set(f.store.replacementCandidates(hash(1), ['111112']).map(candidate => candidate.transactionHash)), new Set([hash(2), hash(3)]));
  f.state.receipts.delete(hash(3));
  f.state.receipts.set(hash(2), first);
  f.state.missingReceipts.delete(hash(2));
  f.state.head = 3000;
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), true);
  assert.equal(f.store.frozen(['1'])[0].observation.transactionHash, hash(2));
});

test('fifteen verified replacement transactions retire the original without changing its scope and foreground reads can wake it', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const crates = Array.from({ length: 15 }, (_, index) => String(111112 + index));
  f.store.registerTransaction(hash(1), 100);
  f.store.pendingTransaction(hash(1), crates, 100, now);
  f.sql.exec('UPDATE transactions SET attempts=1,next_check_ms=0 WHERE hash=?', hash(1));
  crates.forEach((crateTokenId, index) => f.state.receipts.set(hash(index + 2), receipt(hash(index + 2), 200 + index,
    [{ crateTokenId, first: index * 20 + 1 }])));
  await f.internal.processTransaction(deployment, hash(1));
  const original = f.store.transactionJob(hash(1))!;
  assert.equal(original.dormant, 1);
  assert.equal(original.status, 'pending');
  assert.equal(original.requested_all, 1);
  assert.deepEqual(JSON.parse(original.crates_json), crates);
  assert.equal(f.state.peakReceipts, 4);
  assert.equal(f.store.summary().frozen, 300);
  assert.equal(f.store.summary().reserved, 0);
  const frozen = f.store.frozen(Array.from({ length: 300 }, (_, index) => String(index + 1)));
  now += 60_000;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.state.receiptLookups.filter(value => value === hash(1)).length, 1);
  assert.ok(f.store.dueTransactions(now + 86_400_000).every(job => job.hash !== hash(1)));
  await f.object.revealTransaction(deployment, hash(1));
  await f.settle();
  assert.equal(f.state.receiptLookups.filter(value => value === hash(1)).length, 2);
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 1);
  assert.deepEqual(f.store.frozen(frozen.map(value => value.tokenId)), frozen);
});

test('partial replacement coverage and historical frozen evidence cannot retire the original', async t => {
  const f = fixture(t);
  f.store.registerTransaction(hash(1), 100);
  f.store.pendingTransaction(hash(1), ['111112', '111113'], 100, Date.now());
  f.state.receipts.set(hash(2), receipt(hash(2), 200));
  f.freeze(hash(3), 21, '111113');
  f.store.rememberReplacementCandidates(hash(1), [{ transactionHash: hash(3), crateTokenIds: ['111113'] }]);
  f.store.recordReplacementCheck(hash(1), hash(3), ['111113'], 1);
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), false);
  assert.equal(f.state.receiptLookups.filter(value => value === hash(3)).length, 1);
  assert.equal(f.store.summary().frozen, 40);
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
  assert.deepEqual(JSON.parse(f.store.transactionJob(hash(1))!.crates_json), ['111112', '111113']);
  f.state.receipts.set(hash(3), receipt(hash(3), 201, [{ crateTokenId: '111113', first: 21 }]));
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), true);
});

test('partial token recovery retains the other crates of an already admitted unpack', async t => {
  const f = fixture(t);
  f.store.registerTransaction(hash(1), 100);
  f.store.pendingTransaction(hash(1), ['111112', '111113'], 100, Date.now());
  f.freeze(hash(1), 1, '111112', false);
  f.state.receipts.set(hash(2), receipt(hash(2), 200));
  f.state.receipts.set(hash(3), receipt(hash(3), 201, [{ crateTokenId: '111113', first: 21 }]));
  await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000));
  assert.deepEqual(JSON.parse(f.store.transactionJob(hash(1))!.crates_json), ['111112', '111113']);
  assert.equal(f.store.frozen(ids(21)).length, 20);
  assert.equal(f.store.frozen(['21'])[0].observation.transactionHash, hash(3));
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
});

test('wrapped unpack scopes above fifteen crates recover through independent durable chunks', async t => {
  const f = fixture(t);
  const crates = Array.from({ length: 16 }, (_, index) => ({ crateTokenId: String(111112 + index), first: index * 20 + 1 }));
  f.store.freeze(deployment, { transactionHash: hash(1), blockNumber: 101, blockHash: hash(101) },
    crates.map(crate => ({ crateTokenId: crate.crateTokenId, tokenIds: ids(crate.first) })), Date.now());
  f.state.receipts.set(hash(2), receipt(hash(2), 200, crates.map(crate => ({ ...crate, first: crate.first + 320 }))));
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), false);
  assert.equal(f.store.frozen(['321', '620']).length, 2);
  assert.equal(f.store.frozen(['621']).length, 0);
  const restored = f.reopen();
  assert.equal(await restored.findReplacement(deployment, restored.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), true);
  assert.equal(restored.store.frozen(['621', '640']).length, 2);
  assert.equal(restored.store.transactionJob(hash(1))!.dormant, 1);
  assert.equal(restored.store.transactionJob(hash(2))!.dormant, 0);
  assert.equal(f.state.ranges.length, 2);
});

test('successful remining recovers omitted admitted crates while preserving the current receipt response', async t => {
  const f = fixture(t);
  f.store.registerTransaction(hash(1), 100);
  f.store.freeze(deployment, { transactionHash: hash(1), blockNumber: 101, blockHash: hash(101) }, [
    { crateTokenId: '111112', tokenIds: ids(1) }, { crateTokenId: '111113', tokenIds: ids(21) },
  ], Date.now());
  const frozen = f.store.frozen([...ids(1), ...ids(21)]);
  f.state.receipts.set(hash(1), receipt(hash(1), 200, [{ crateTokenId: '111112', first: 61 }]));
  f.state.receipts.set(hash(2), receipt(hash(2), 199, [{ crateTokenId: '111113', first: 41 }]));
  f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
  await f.internal.processTransaction(deployment, hash(1));
  assert.equal(f.store.frozen(ids(41)).length, 20);
  assert.equal(f.store.frozen(['41'])[0].observation.transactionHash, hash(2));
  assert.deepEqual(f.store.frozen([...ids(1), ...ids(21)]), frozen);
  const response = f.store.transactionResponse(deployment, hash(1));
  assert.equal(response.status, 'revealed');
  assert.deepEqual(response.artworks.map(artwork => artwork.tokenId), ids(61));
  assert.deepEqual(response.observedBlock, { number: 200, hash: hash(200) });
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
  assert.equal(f.store.transactionJob(hash(2))!.dormant, 0);
  const generation = f.store.transactionJob(hash(1))!.tracking_generation;
  f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
  await f.internal.processTransaction(deployment, hash(1));
  assert.equal(f.store.transactionJob(hash(1))!.tracking_generation, generation);
  assert.equal(f.state.receiptLookups.filter(value => value === hash(2)).length, 1);
  assert.deepEqual(f.store.transactionResponse(deployment, hash(1)), response);
});

test('omitted scopes above fifteen crates continue across unchanged receipts and object restarts', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const crates = Array.from({ length: 32 }, (_, index) => ({ crateTokenId: String(111112 + index), first: index * 20 + 1 }));
  f.store.registerTransaction(hash(1), 100);
  f.store.freeze(deployment, { transactionHash: hash(1), blockNumber: 101, blockHash: hash(101) },
    crates.map(crate => ({ crateTokenId: crate.crateTokenId, tokenIds: ids(crate.first) })), now);
  f.state.receipts.set(hash(1), receipt(hash(1), 200, [{ crateTokenId: crates[0].crateTokenId, first: 1261 }]));
  f.state.receipts.set(hash(2), receipt(hash(2), 199, crates.slice(1).map((crate, index) => ({ ...crate, first: 641 + index * 20 }))));
  const replacementIds = Array.from({ length: 620 }, (_, index) => String(index + 641));
  const generation = f.store.transactionJob(hash(1))!.tracking_generation + 1;
  for (let pass = 0; pass < 3; pass++) {
    now += 15_000;
    f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
    const restored = f.reopen();
    await restored.processTransaction(deployment, hash(1));
    assert.equal(f.store.frozen(replacementIds).length, Math.min((pass + 1) * 300, 620));
    assert.equal(f.store.transactionJob(hash(1))!.tracking_generation, generation);
    assert.equal(f.store.transactionJob(hash(1))!.next_check_ms, now + (pass === 2 ? 86_400_000 : 15_000));
    assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
  }
  assert.equal(f.state.ranges.length, 3);
  assert.equal(f.state.receiptLookups.filter(value => value === hash(2)).length, 3);
  assert.deepEqual(f.store.transactionResponse(deployment, hash(1)).artworks.map(artwork => artwork.tokenId), ids(1261));
});

test('losing a successful receipt restores recovery for its own crates after omitted scope completes', async t => {
  const f = fixture(t);
  f.store.registerTransaction(hash(1), 100);
  f.store.freeze(deployment, { transactionHash: hash(1), blockNumber: 101, blockHash: hash(101) }, [
    { crateTokenId: '111112', tokenIds: ids(1) }, { crateTokenId: '111113', tokenIds: ids(21) },
  ], Date.now());
  f.state.receipts.set(hash(1), receipt(hash(1), 200, [{ crateTokenId: '111112', first: 61 }]));
  f.state.receipts.set(hash(2), receipt(hash(2), 199, [{ crateTokenId: '111113', first: 41 }]));
  f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
  await f.internal.processTransaction(deployment, hash(1));
  const response = f.store.transactionResponse(deployment, hash(1));
  f.state.receipts.delete(hash(1));
  f.sql.exec('UPDATE transactions SET next_check_ms=0,attempts=1 WHERE hash=?', hash(1));
  await f.internal.processTransaction(deployment, hash(1));
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
  f.state.head = 1001;
  f.state.receipts.set(hash(3), receipt(hash(3), 1001, [{ crateTokenId: '111112', first: 81 }]));
  f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
  await f.internal.processTransaction(deployment, hash(1));
  assert.equal(f.store.frozen(ids(81)).length, 20);
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 1);
  assert.equal(f.store.transactionJob(hash(3))!.dormant, 0);
  assert.deepEqual(f.store.transactionResponse(deployment, hash(1)), response);
});

test('failed receipt recovery retains its claim while replacement verification is blocked', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.receipts.set(hash(1), { ...receipt(hash(1), 300), status: '0x0', logs: [] });
  const replacement = Promise.withResolvers<ReturnType<typeof receipt> | null>();
  f.state.receipts.set(hash(2), replacement.promise);
  f.store.rememberReplacementCandidates(hash(1), [{ transactionHash: hash(2), crateTokenIds: ['111112'] }]);
  f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
  const checking = f.internal.processTransaction(deployment, hash(1));
  try {
    for (let attempt = 0; attempt < 100 && !f.state.receiptLookups.includes(hash(2)); attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(f.state.receiptLookups.includes(hash(2)));
    now += 16_000;
    f.state.receipts.set(hash(1), receipt(hash(1), 101));
    await f.internal.processTransaction(deployment, hash(1));
    assert.equal(f.state.receiptLookups.filter(value => value === hash(1)).length, 1);
    assert.ok(f.store.transactionJob(hash(1))!.lease_until_ms > now);
  } finally {
    replacement.resolve(null);
    await checking;
  }
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
});

for (const status of ['reverted', 'not_unpack'] as const) test(`a first ${status} receipt can reorganize into success without another foreground request`, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.state.receipts.set(hash(1), { ...receipt(hash(1), 1000), status: status === 'reverted' ? '0x0' : '0x1', logs: [] });
  const first = await f.object.revealTransaction(deployment, hash(1));
  await f.settle();
  assert.equal(first.status, status);
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
  assert.equal(f.store.summary().frozen, 0);
  f.state.receipts.delete(hash(1));
  now += 15_000;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.store.transactionJob(hash(1))!.status, 'pending');
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
  f.state.head = 1001;
  f.state.receipts.set(hash(1), receipt(hash(1), 1001));
  now += 60_000;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.store.frozen(ids(1)).length, 20);
  assert.equal(f.store.transactionResponse(deployment, hash(1)).status, 'revealed');
});

test('failed checks demote historical candidates so a newer canonical replacement cannot be starved', async t => {
  const f = fixture(t);
  f.store.registerTransaction(hash(1), 100);
  f.store.pendingTransaction(hash(1), ['111112'], 100, Date.now());
  for (let index = 0; index < 16; index++) {
    f.store.rememberReplacementCandidates(hash(1), [{ transactionHash: hash(index + 2), crateTokenIds: ['111112'] }]);
    f.store.recordReplacementCheck(hash(1), hash(index + 2), ['111112'], index + 1);
  }
  f.state.receipts.set(hash(100), receipt(hash(100), 200));
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), false);
  assert.equal(f.state.receiptLookups.length, 15);
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), true);
  assert.equal(f.store.frozen(['1'])[0].observation.transactionHash, hash(100));
});

test('a reorg cycle requires fresh canonical evidence before a replacement can retire against its original', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  const frozen = f.store.frozen(ids(1));
  f.state.receipts.set(hash(2), receipt(hash(2), 200));
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), true);
  f.state.receipts.delete(hash(2));
  f.state.receipts.set(hash(1), receipt(hash(1), 101));
  f.state.canonicalHashes.set(101, hash(9999));
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(2))!, AbortSignal.timeout(5000)), false);
  assert.equal(f.store.transactionJob(hash(2))!.dormant, 0);
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 1);
  f.state.canonicalHashes.clear();
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(2))!, AbortSignal.timeout(5000)), true);
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
  assert.equal(f.store.transactionJob(hash(2))!.dormant, 1);
  assert.deepEqual(f.store.frozen(ids(1)), frozen);
});

test('a previously revealed transaction re-mined without unpack events can recover and retire without changing its frozen proof', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  const response = f.store.transactionResponse(deployment, hash(1));
  f.state.receipts.set(hash(1), { ...receipt(hash(1), 300), logs: [] });
  f.state.receipts.set(hash(2), receipt(hash(2), 200));
  f.state.missingReceipts.add(hash(2));
  f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
  await f.internal.processTransaction(deployment, hash(1));
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 0);
  assert.deepEqual(f.store.transactionResponse(deployment, hash(1)), response);
  f.state.missingReceipts.clear();
  f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
  await f.internal.processTransaction(deployment, hash(1));
  assert.equal(f.store.transactionJob(hash(1))!.dormant, 1);
  assert.equal(f.store.transactionJob(hash(2))!.dormant, 0);
  assert.deepEqual(f.store.transactionResponse(deployment, hash(1)), response);
});

for (const requestedAll of [false, true]) test(`replacement retirement preserves ${requestedAll ? 'upgraded full' : 'selected partial'} recovery scope`, async t => {
  const f = fixture(t);
  f.freeze(hash(1), 1, '111112', false);
  if (requestedAll) f.store.registerTransaction(hash(1), 100);
  f.state.receipts.set(hash(2), receipt(hash(2), 200, [{ crateTokenId: '111112', first: 1 }, { crateTokenId: '111113', first: 21 }]));
  assert.equal(await f.internal.findReplacement(deployment, f.store.transactionJob(hash(1))!, AbortSignal.timeout(5000)), !requestedAll);
  assert.equal(f.store.transactionJob(hash(1))!.requested_all, requestedAll ? 1 : 0);
  assert.equal(f.store.transactionJob(hash(1))!.revealed_all, 0);
  assert.deepEqual(JSON.parse(f.store.transactionJob(hash(1))!.crates_json), ['111112']);
  assert.equal(f.store.frozen(ids(21)).length, 0);
});

test('a full transaction request made during partial verification reveals the complete old receipt immediately', async t => {
  const f = fixture(t);
  const complete = receipt(hash(1), 101, [{ crateTokenId: '111112', first: 1 }, { crateTokenId: '111113', first: 21 }]);
  const pendingReceipt = Promise.withResolvers<ReturnType<typeof receipt> | null>();
  f.state.receipts.set(hash(1), pendingReceipt.promise);
  f.freeze(hash(1), 1, '111112', false);
  f.sql.exec('UPDATE transactions SET next_check_ms=0 WHERE hash=?', hash(1));
  const checking = f.internal.processTransaction(deployment, hash(1));
  try {
    const during = await f.object.revealTransaction(deployment, hash(1));
    assert.equal(during.status, 'pending');
    assert.equal(f.store.transactionJob(hash(1))!.requested_all, 1);
    pendingReceipt.resolve(complete);
    await checking;
    const after = await f.object.revealTransaction(deployment, hash(1));
    assert.equal(after.status, 'revealed');
    assert.equal(after.artworks.length, 40);
    assert.equal(f.store.transactionJob(hash(1))!.revealed_all, 1);
  } finally {
    pendingReceipt.resolve(complete);
    await checking;
    await f.settle();
  }
});

test('publication drains successive batches while an unrelated receipt check is blocked', async t => {
  const f = fixture(t);
  const pendingReceipt = Promise.withResolvers<ReturnType<typeof receipt> | null>();
  f.state.receipts.set(hash(9), pendingReceipt.promise);
  f.freeze(hash(1));
  f.store.registerTransaction(hash(9), 100);
  let watchdogCompleted = false;
  const first = f.object.watchdog(deployment).then(() => { watchdogCompleted = true; });
  try {
    await f.firstBatch;
    await first;
    assert.equal(watchdogCompleted, true, 'Publication must finish without waiting for unrelated RPC.');
    assert.equal(f.published.size, 20);
    f.freeze(hash(2), 21, '111113');
    await f.object.watchdog(deployment);
    assert.equal(f.published.size, 40);
    assert.equal(f.state.calls.filter(method => method === 'eth_getTransactionReceipt').length, 1);
  } finally {
    pendingReceipt.resolve(null);
    await first;
    await f.settle();
  }
});

test('publication yields after 512 jobs and leaves a durable continuation', async t => {
  const f = fixture(t);
  for (let index = 0; index < 26; index++) f.freeze(hash(index + 1), index * 20 + 1, String(111112 + index));
  await f.object.watchdog(deployment);
  assert.equal(f.published.size, 512);
  assert.equal(f.sql.exec("SELECT COUNT(*) AS count FROM publication WHERE status='pending'").toArray()[0].count, 8);
  assert.ok(f.getAlarm() !== null);
  await f.object.watchdog(deployment);
  assert.equal(f.published.size, 520);
  await f.settle();
});

test('publication yields at its time budget and resumes the remaining batch', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const put = f.metadata.put.bind(f.metadata);
  t.mock.method(f.metadata, 'put', async (key: string, body: string) => {
    now += 1_000;
    return put(key, body);
  });
  await f.object.watchdog(deployment);
  assert.equal(f.published.size, 8);
  assert.ok(f.getAlarm() !== null && f.getAlarm()! <= now + 250);
  await f.object.watchdog(deployment);
  assert.equal(f.published.size, 16);
  await f.settle();
});

test('concurrent publication requests share one drain and never claim duplicate work', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const writes: string[] = [];
  const put = f.metadata.put.bind(f.metadata);
  t.mock.method(f.metadata, 'put', async (key: string, body: string) => {
    writes.push(key);
    if (writes.length === 8) entered.resolve();
    await release.promise;
    return put(key, body);
  });
  const first = f.object.watchdog(deployment);
  await entered.promise;
  const second = f.object.watchdog(deployment);
  assert.equal(writes.length, 8);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(writes.length, 20);
  assert.equal(new Set(writes).size, 20);
  await f.settle();
});

test('publication retries a failed write without delaying unrelated ready work', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  let now = Date.now(), failed = false;
  t.mock.method(Date, 'now', () => now);
  const put = f.metadata.put.bind(f.metadata);
  t.mock.method(f.metadata, 'put', async (key: string, body: string) => {
    if (key.endsWith('/1.json') && !failed) { failed = true; throw new Error('Temporary storage failure'); }
    return put(key, body);
  });
  await f.internal.runPublications(deployment);
  assert.equal(f.published.size, 19);
  const pending = f.sql.exec("SELECT status,next_check_ms,attempts FROM publication WHERE token_id='1'").toArray()[0];
  assert.deepEqual({ ...pending }, { status: 'pending', next_check_ms: now + 2_000, attempts: 1 });
  now += 2_000;
  await f.internal.runPublications(deployment);
  assert.equal(f.published.size, 20);
  const metadata = f.sql.exec("SELECT metadata_json FROM assignments WHERE token_id='1'").toArray()[0].metadata_json;
  assert.equal(f.published.get('111k-sepolia/1.json'), metadata);
  await f.settle();
});
