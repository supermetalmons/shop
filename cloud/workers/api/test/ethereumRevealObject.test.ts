import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { decodeReturn, encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import type { EthereumRevealResult, EthereumRevealTokensResponse, EthereumRevealTransactionResponse } from '../../../../shared/ethereum/reveal.ts';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.ts';
import type { EthereumRevealStore, RevealSql, RevealReceiptClaim, RevealScanClaim } from '../src/ethereumRevealStore.ts';
import type { RevealVerificationResult, RevealVerificationScope, RevealVerificationWork } from '../src/ethereumRevealVerification.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import type { EthereumEnvironment } from '../src/ethereumRuntime.ts';
import { loadCloudflareWorkersModule } from './cloudflareWorkersTestLoader.ts';
import { d1Database } from './commerceD1Harness.ts';

const { EthereumRevealObject } = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealObject.ts'));
const { EthereumRevealVerifierObject } = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealVerifierObject.ts'));
const { EthereumRevealPublisherObject } = await loadCloudflareWorkersModule(() => import('../src/ethereumRevealPublisherObject.ts'));
const hash = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const CONTRACT = `0x${'11'.repeat(20)}`;
const OWNER = `0x${'22'.repeat(20)}`;
const WRAPPER = `0x${'33'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const ids = (first: number, count = 20) => Array.from({ length: count }, (_, index) => String(first + index));
const templateJson = JSON.stringify({ name: '{{tokenId}}', description: '', image: 'https://wip.lil.org/111k/artwork_placeholder.png', attributes: [] });
const deployment: EthereumRevealDeployment = {
  deploymentId: 'test-local', dropId: '111k_devnet', chainId: 31337, contractAddress: CONTRACT,
  metadataBaseUri: 'https://cdn.mons.shop/111k-sepolia/', deploymentBlock: 100, catalogVersion: '111k-v1',
  templateJson, templateSha256: createHash('sha256').update(templateJson).digest('hex'), state: 'active', revision: 3,
  createdAtMs: 1, updatedAtMs: 3, provisionedAtMs: 2, activatedAtMs: 3, lastError: null,
};

type Crate = { crateTokenId: string; first: number; count?: number };
function receipt(transactionHash: string, blockNumber: number, crates: Crate[] = [{ crateTokenId: '111112', first: 1 }]) {
  const word = (value: string | number) => encodeAbi(['uint256'], [value]);
  const address = (value: string) => encodeAbi(['address'], [value]);
  let index = 0;
  const log = (topics: string[], data: string) => ({ address: CONTRACT, topics, data,
    blockNumber: `0x${blockNumber.toString(16)}`, blockHash: hash(blockNumber), transactionHash, logIndex: `0x${(index++).toString(16)}` });
  return { transactionHash, blockNumber: `0x${blockNumber.toString(16)}`, blockHash: hash(blockNumber), status: '0x1',
    logs: crates.flatMap(crate => {
      const count = crate.count ?? (crate.crateTokenId === '116666' ? 31 : 20);
      return [
        log([ETHEREUM_EVENT_TOPICS.Transfer, address(OWNER), address(ZERO), word(crate.crateTokenId)], '0x'),
        ...ids(crate.first, count).map(tokenId => log([ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(OWNER), word(tokenId)], '0x')),
        log([ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(crate.crateTokenId), address(OWNER)], encodeAbi(['uint256', 'uint256'], [crate.first, count])),
      ];
    }),
  };
}

type Receipt = ReturnType<typeof receipt>;
type InternalObject = {
  store: EthereumRevealStore;
  revealTransaction(deployment: EthereumRevealDeployment, hash: string, admit?: boolean, deadlineMs?: number): Promise<EthereumRevealResult<EthereumRevealTransactionResponse>>;
  revealTokens(deployment: EthereumRevealDeployment, ids: string[], admit?: boolean, deadlineMs?: number): Promise<EthereumRevealResult<EthereumRevealTokensResponse>>;
  watchdog(deployment: EthereumRevealDeployment): Promise<void>;
  alarm(): Promise<void>;
  processReceipt(deployment: EthereumRevealDeployment, claim: RevealReceiptClaim): Promise<void>;
  processScan(deployment: EthereumRevealDeployment, claim: RevealScanClaim): Promise<void>;
  withinBudget(work: Promise<unknown>, deadline: number): Promise<boolean>;
  validateReceiptWork(scope: RevealVerificationScope, work: RevealVerificationWork): Promise<boolean>;
  recordReceiptPresence(scope: RevealVerificationScope, work: RevealVerificationWork): Promise<boolean>;
  runPublications(deployment: EthereumRevealDeployment): Promise<void>;
  receipts: Map<string, { active: boolean; promise: Promise<void> }>;
  scans: Map<string, { claim: RevealScanClaim; promise: Promise<void> }>;
};

function value<T>(result: EthereumRevealResult<T>): T {
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}

async function abortable<T>(work: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

function fixture(t: TestContext) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON');
  database.exec(readFileSync('cloud/workers/api/ops-migrations/0009_ethereum_reveal_deployments.sql', 'utf8'));
  database.prepare(`INSERT INTO ethereum_reveal_deployments(deployment_id,drop_id,chain_id,contract_address,metadata_base_uri,
    deployment_block,catalog_version,template_json,template_sha256,state,revision,created_at_ms,updated_at_ms,provisioned_at_ms,activated_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,'active',3,1,3,2,3)`).run(deployment.deploymentId, deployment.dropId, deployment.chainId, CONTRACT,
    deployment.metadataBaseUri, deployment.deploymentBlock, deployment.catalogVersion, templateJson, deployment.templateSha256);
  const sql: RevealSql = { exec(query, ...bindings) {
    const statement = database.prepare(query);
    const parameters = bindings.map(entry => entry instanceof ArrayBuffer ? new Uint8Array(entry) : entry);
    const rows = statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []);
    return { toArray: () => rows as never[] };
  } };
  let alarm: number | null = null;
  const tasks = new Set<Promise<unknown>>();
  const published = new Map<string, string>();
  const firstBatch = Promise.withResolvers<void>();
  const media = { reads: 0, writes: 0 };
  const metadata = {
    async get(key: string) {
      media.reads++;
      const body = published.get(key);
      return body === undefined ? null : { size: Buffer.byteLength(body), text: async () => body,
        etag: createHash('sha256').update(body).digest('hex') };
    },
    async put(key: string, body: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const previous = published.get(key);
      if (options?.onlyIf?.etagDoesNotMatch === '*' && previous !== undefined) return null;
      if (options?.onlyIf?.etagMatches && (previous === undefined ||
        createHash('sha256').update(previous).digest('hex') !== options.onlyIf.etagMatches)) return null;
      media.writes++;
      published.set(key, body);
      if (published.size >= 8) firstBatch.resolve();
      return {};
    },
  };
  const context = {
    storage: { sql, transactionSync<T>(action: () => T) {
      database.exec('BEGIN');
      try { const result = action(); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    }, getAlarm: async () => alarm, setAlarm: async (next: number) => { alarm = next; } },
    waitUntil(promise: Promise<unknown>) {
      tasks.add(promise);
      void promise.finally(() => tasks.delete(promise)).catch(() => undefined);
    },
  };
  let current: InternalObject;
  const verifiers = new Map<string, InstanceType<typeof EthereumRevealVerifierObject>>();
  let publisher: InstanceType<typeof EthereumRevealPublisherObject>;
  const env = { ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545',
    ALCHEMY_MI_NOTE_API_KEY: '', ETHEREUM_REVEAL_METADATA: metadata, OPS_DB: d1Database(database),
    ETHEREUM_REVEAL: { getByName: () => current },
    ETHEREUM_REVEAL_PUBLISHER: { getByName: () => publisher },
    ETHEREUM_REVEAL_VERIFIER: { getByName(name: string) {
      let verifier = verifiers.get(name);
      if (!verifier) {
        verifier = new EthereumRevealVerifierObject(context as unknown as DurableObjectState, env as unknown as Env);
        verifiers.set(name, verifier);
      }
      return verifier;
    } },
  };
  publisher = new EthereumRevealPublisherObject(context as unknown as DurableObjectState, env as unknown as Env);
  const make = () => {
    current = new EthereumRevealObject(context as unknown as DurableObjectState, env as unknown as Env) as unknown as InternalObject;
    return current;
  };
  const object = make();
  object.store.configure(deployment);
  while (!object.store.initializeChunk()) {}
  while (!object.store.migrationReady()) object.store.migrateChunk(Date.now(), 128);
  const state = { head: 1000, minted: 0, receipts: new Map<string, Receipt | Promise<Receipt | null>>(),
    transactions: new Map<string, Record<string, unknown>>(), failedReceipts: new Set<string>(),
    failedMethods: new Set<string>(), canonicalHashes: new Map<number, string>(), logsUnavailable: false,
    calls: [] as string[], receiptLookups: [] as string[], runningReceipts: 0, peakReceipts: 0,
    scans: [] as Array<{ kind: 'crate' | 'tokens'; from: number; to: number; ids: string[] }>,
    logGate: null as Promise<void> | null, runningScans: 0, peakScans: 0,
  };
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init?.body));
    state.calls.push(method);
    if (state.failedMethods.has(method)) throw new Error('RPC unavailable');
    let result: unknown;
    if (method === 'eth_chainId') result = '0x7a69';
    else if (method === 'eth_blockNumber') result = `0x${state.head.toString(16)}`;
    else if (method === 'eth_getTransactionReceipt') {
      state.receiptLookups.push(params[0]);
      if (state.failedReceipts.has(params[0])) throw new Error('Receipt unavailable');
      state.runningReceipts++;
      state.peakReceipts = Math.max(state.peakReceipts, state.runningReceipts);
      try { result = await abortable(Promise.resolve(state.receipts.get(params[0]) ?? null), init?.signal); }
      finally { state.runningReceipts--; }
    } else if (method === 'eth_getTransactionByHash') result = state.transactions.get(params[0]) ?? null;
    else if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'latest' ? state.head : Number(BigInt(params[0]));
      result = { number: `0x${number.toString(16)}`, hash: state.canonicalHashes.get(number) ?? hash(number) };
    } else if (method === 'eth_getCode') result = params[1].blockHash === hash(99) ? '0x' : '0x60006000';
    else if (method === 'eth_call') {
      const data = String(params[0].data);
      if (data.slice(0, 10) === encodeCall('baseURI()', [], [])) result = encodeAbi(['string'], [deployment.metadataBaseUri]);
      else if (data.slice(0, 10) === encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, [], [])) {
        const [tokenIds] = decodeReturn(['uint256[]'], `0x${data.slice(10)}`) as [bigint[]];
        result = encodeAbi(['(uint8,uint256,address)[]'], [tokenIds.map(tokenId => [2, tokenId - 111111n, OWNER])]);
      } else result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256'],
        [1, 0, state.minted, 1, 1, true, `0x${'00'.repeat(32)}`, 1, 1, 0]);
    } else if (method === 'eth_getLogs') {
      if (state.logsUnavailable) throw new Error('Logs unavailable');
      const filter = params[0];
      const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
      const kind = filter.topics[0] === ETHEREUM_EVENT_TOPICS.CrateUnboxed ? 'crate' : 'tokens';
      const requested = filter.topics[kind === 'crate' ? 1 : 3] as string[];
      state.scans.push({ kind, from, to, ids: requested.map(entry => String(BigInt(entry))) });
      state.runningScans++;
      state.peakScans = Math.max(state.peakScans, state.runningScans);
      try {
        if (state.logGate) await abortable(state.logGate, init?.signal);
        result = [...state.receipts.values()].filter((entry): entry is Receipt => !(entry instanceof Promise)).flatMap(entry => entry.logs)
          .filter(entry => Number(BigInt(entry.blockNumber)) >= from && Number(BigInt(entry.blockNumber)) <= to &&
            filter.topics.every((topic: string | string[] | null, index: number) => topic === null ||
              (Array.isArray(topic) ? topic.includes(entry.topics[index]) : topic === entry.topics[index])));
      } finally { state.runningScans--; }
    } else throw new Error(`Unexpected RPC method ${method}`);
    return Response.json({ jsonrpc: '2.0', id, result });
  });
  const pending = (transactionHash: string, crates = ['111112'], wrapped = false) => {
    state.transactions.set(transactionHash, { hash: transactionHash, chainId: '0x7a69', from: OWNER,
      to: wrapped ? WRAPPER : CONTRACT, value: '0x0', blockNumber: null,
      input: crates.length === 1 ? encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], crates)
        : encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [crates]) });
  };
  const settle = async () => {
    for (let attempt = 0; tasks.size && attempt < 500; attempt++) await Promise.allSettled([...tasks]);
    assert.equal(tasks.size, 0, 'Background work must yield with a durable retry instead of spinning.');
  };
  t.after(async () => { await settle(); database.close(); });
  const freeze = (transactionHash: string, first = 1, crateTokenId = '111112', all = true) => object.store.freeze(deployment,
    { transactionHash, blockNumber: 101, blockHash: hash(101) }, [{ crateTokenId, tokenIds: ids(first) }], Date.now(), all);
  return { object, store: object.store, database, sql, state, published, metadata, media, firstBatch: firstBatch.promise,
    pending, freeze, settle, reopen: make, getAlarm: () => alarm,
    verifier: (transactionHash: string) => env.ETHEREUM_REVEAL_VERIFIER.getByName(`${deployment.chainId}:${CONTRACT}:${transactionHash}`),
    rows: (query: string) => database.prepare(query).all() };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected work did not start.');
}

function shortInlineWait(t: TestContext): void {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) =>
    original(callback, milliseconds !== undefined && milliseconds > 500 && milliseconds <= 2000 ? 25 : milliseconds, ...args));
}

function transactionRoute(f: ReturnType<typeof fixture>, admissionAllowed = true) {
  let admissions = 0;
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: EthereumEnvironment = {
    OPS_DB: d1Database(f.database), COMMERCE_DB: d1Database(f.database), ALCHEMY_MI_NOTE_API_KEY: '',
    ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_111K_DEPLOYMENT_BLOCK: '100',
    ETHEREUM_111K_METADATA_BASE_URI: deployment.metadataBaseUri, ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545',
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
    ETHEREUM_REVEAL_READ_RATE_LIMITER: limiter,
    ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER: { limit: async () => { admissions++; return { success: admissionAllowed }; } },
    ETHEREUM_REVEAL: { getByName: () => f.object } as unknown as Env['ETHEREUM_REVEAL'],
  };
  return { admissions: () => admissions, request: (transactionHash: string) => handleEthereumRequest(new Request(
    'https://api.mons.shop/ethereum/111k/reveal/transaction', {
      method: 'POST', headers: { Origin: 'https://vvv.so', 'X-Mons-CSRF': '1', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
      body: JSON.stringify({ chainId: deployment.chainId, contractAddress: CONTRACT, transactionHash }),
    }), env, '/ethereum/111k/reveal/transaction') };
}

test('new transaction and token work require admission without chain or storage publication reads', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.object.revealTransaction(deployment, hash(1)), { kind: 'admission' });
  assert.deepEqual(await f.object.revealTokens(deployment, ['1']), { kind: 'admission' });
  assert.deepEqual(f.state.calls, []);
  assert.equal(f.media.reads, 0);
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM receipt_work')[0].count, 0);
});

test('complete frozen snapshots bypass chain, publication and admission even while paused', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  const before = f.store.transactionResponse(deployment, hash(1));
  const paused = { ...deployment, state: 'paused' as const };
  assert.deepEqual(value(await f.object.revealTransaction(paused, hash(1))), before);
  assert.deepEqual(value(await f.object.revealTokens(paused, ['1', '2'])).artworks.map(artwork => artwork.tokenId), ['1', '2']);
  assert.deepEqual(f.state.calls, []);
  assert.deepEqual(f.media, { reads: 0, writes: 0 });
  assert.equal(f.getAlarm(), null);
});

test('owned pending crates reserve privately and one hundred duplicate hashes share one crate job', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  for (let index = 1; index <= 100; index++) {
    f.pending(hash(index));
    const response = value(await f.object.revealTransaction(deployment, hash(index), true));
    assert.equal(response.status, 'pending');
    assert.deepEqual(response.artworks, []);
  }
  await f.settle();
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM crate_recovery_jobs')[0].count, 1);
  assert.equal(f.store.summary().reserved, 20);
  assert.equal(f.store.summary().frozen, 0);
  assert.equal(f.published.size, 0);
  now += 60_000;
  f.state.transactions.clear();
  f.state.receipts.set(hash(100), receipt(hash(100), 1001));
  f.state.head = 1001;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.store.frozen(ids(1)).length, 20);
  assert.equal(value(await f.object.revealTransaction(deployment, hash(100))).status, 'revealed');
});

test('a blocked receipt yields a bounded pending response with durable continuation and per-hash deduplication', async t => {
  shortInlineWait(t);
  const f = fixture(t);
  const blocked = Promise.withResolvers<Receipt | null>();
  f.state.receipts.set(hash(1), blocked.promise);
  const requests = Array.from({ length: 12 }, () => f.object.revealTransaction(deployment, hash(1), true));
  try {
    const responses = await Promise.all(requests);
    assert.ok(responses.every(response => value(response).status === 'pending'));
    assert.equal(f.state.receiptLookups.filter(entry => entry === hash(1)).length, 1);
    assert.equal(f.object.receipts.size, 1);
    assert.equal(f.store.knownTransaction(hash(1)), true);
    assert.ok(f.getAlarm() !== null);
  } finally { blocked.resolve(receipt(hash(1), 1000)); await f.settle(); }
  assert.equal(value(await f.object.revealTransaction(deployment, hash(1))).status, 'revealed');
  assert.equal(f.published.size, 20);
});

test('observed wrapped pending transactions survive later absence, age and restart until a receipt resolves them', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.pending(hash(1), ['111112'], true);
  assert.equal(value(await f.object.revealTransaction(deployment, hash(1), true)).status, 'pending');
  await f.settle();
  f.state.transactions.clear();
  now += 48 * 3_600_000;
  const restored = f.reopen();
  await restored.watchdog(deployment);
  await f.settle();
  assert.equal(restored.store.knownTransaction(hash(1)), true);
  f.state.receipts.set(hash(1), receipt(hash(1), 1001));
  f.state.head = 1001;
  now += 3_600_001;
  await restored.watchdog(deployment);
  await f.settle();
  assert.equal(value(await restored.revealTransaction(deployment, hash(1))).status, 'revealed');
  assert.equal(restored.store.frozen(ids(1)).length, 20);
});

test('transaction presence persists before a later inspection failure', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.pending(hash(1));
  f.state.failedMethods.add('eth_call');
  assert.equal(value(await f.object.revealTransaction(deployment, hash(1), true)).status, 'pending');
  await f.settle();
  f.state.failedMethods.clear();
  f.state.transactions.clear();
  now += 48 * 3_600_000;
  const restored = f.reopen();
  await restored.watchdog(deployment);
  await f.settle();
  assert.equal(restored.store.knownTransaction(hash(1)), true);
  assert.equal(restored.store.summary().frozen, 0);
});

test('unknown expiry requires a fresh completed absence check and never treats provider errors as absence', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  assert.equal(value(await f.object.revealTransaction(deployment, hash(1), true)).status, 'pending');
  await f.settle();
  now += 15 * 60_000 + 1;
  f.state.failedReceipts.add(hash(1));
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.store.knownTransaction(hash(1)), true);
  const before = f.state.calls.filter(method => method === 'eth_getTransactionByHash').length;
  f.state.failedReceipts.clear();
  now += 3_600_001;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.store.knownTransaction(hash(1)), false);
  assert.ok(f.state.calls.filter(method => method === 'eth_getTransactionByHash').length > before);
});

for (const status of ['0x0', '0x1']) test(`recent ${status === '0x0' ? 'reverted' : 'unrelated'} receipts keep recovery through a first-confirmation reorg`, async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.state.receipts.set(hash(1), { ...receipt(hash(1), 1000), status, logs: [] });
  value(await f.object.revealTransaction(deployment, hash(1), true));
  await f.settle();
  f.state.receipts.delete(hash(1));
  now += 60_000;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.store.knownTransaction(hash(1)), true);
  f.state.receipts.set(hash(1), receipt(hash(1), 1001));
  f.state.head = 1001;
  now += 3_600_001;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.store.frozen(ids(1)).length, 20);
});

test('full opaque capacity rejects nonpersisted work while verified crates and cached results continue', async t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  for (let index = 1; index <= 10_000; index++) assert.equal(f.store.admitTransaction(hash(index), 100, now), 'accepted');
  f.sql.exec('UPDATE receipt_work SET next_check_ms=?', now + 86_400_000);
  assert.equal(f.store.opaqueCount(), 10_000);
  assert.deepEqual(await f.object.revealTransaction(deployment, hash(20_000), true), { kind: 'capacity' });
  assert.equal(f.store.knownTransaction(hash(20_000)), false);
  f.state.receipts.set(hash(20_001), receipt(hash(20_001), 1000));
  const confirmed = value(await f.object.revealTransaction(deployment, hash(20_001), true));
  assert.equal(confirmed.status, 'revealed');
  assert.equal(confirmed.artworks.length, 20);
  await f.settle();
  assert.equal(f.store.opaqueCount(), 10_000);
  const rpc = f.state.calls.length;
  assert.deepEqual(value(await f.object.revealTransaction(deployment, hash(20_001))), confirmed);
  assert.equal(f.state.calls.length, rpc);
  assert.equal(value(await f.object.revealTransaction(deployment, hash(1))).status, 'pending');
  await f.settle();
  assert.equal(f.store.opaqueCount(), 10_000);
});

test('receipt work reserves sixteen background lanes and limits concurrent hashes to sixty-four', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const holds = new Map<number, ReturnType<typeof Promise.withResolvers<Receipt | null>>>();
  for (let index = 1; index <= 100; index++) {
    const held = Promise.withResolvers<Receipt | null>();
    holds.set(index, held);
    f.state.receipts.set(hash(index), held.promise);
    f.store.admitTransaction(hash(index), 100, index <= 20 ? now - 60_000 : now);
  }
  try {
    await f.object.watchdog(deployment);
    await waitFor(() => f.state.runningReceipts === 64);
    assert.equal([...f.object.receipts.values()].filter(work => work.active).length, 48);
    assert.equal([...f.object.receipts.values()].filter(work => !work.active).length, 16);
    assert.ok(f.state.receiptLookups.includes(hash(1)) || f.state.receiptLookups.includes(hash(2)));
    assert.equal(f.state.peakReceipts, 64);
    for (let pass = 0; pass < 3; pass++) await f.object.watchdog(deployment);
    assert.equal(f.state.receiptLookups.length, 64);
  } finally { for (const held of holds.values()) held.resolve(null); await f.settle(); }
  assert.ok(f.state.peakReceipts <= 64);
});

test('an initially queued hash returns its revealed artwork within the original request', async t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const holds = Array.from({ length: 64 }, () => Promise.withResolvers<Receipt | null>());
  for (const [index, held] of holds.entries()) {
    f.state.receipts.set(hash(index + 1), held.promise);
    f.store.admitTransaction(hash(index + 1), 100, now);
  }
  f.state.receipts.set(hash(65), receipt(hash(65), 1000));
  let returned = false;
  try {
    await f.object.watchdog(deployment);
    await waitFor(() => f.state.runningReceipts === 64);
    const response = f.object.revealTransaction(deployment, hash(65), true).then(result => { returned = true; return value(result); });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(returned, false);
    holds[0].resolve(null);
    const result = await response;
    assert.equal(result.status, 'revealed');
    assert.equal(result.artworks.length, 20);
    assert.ok(f.state.peakReceipts <= 64);
  } finally { for (const held of holds) held.resolve(null); await f.settle(); }
});

test('coordinator restart counts delegated inspections still running against its durable ceiling', async t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const holds = Array.from({ length: 100 }, () => Promise.withResolvers<Receipt | null>());
  for (const [index, held] of holds.entries()) {
    f.state.receipts.set(hash(index + 1), held.promise);
    f.store.admitTransaction(hash(index + 1), 100, now);
  }
  try {
    await f.object.watchdog(deployment);
    await waitFor(() => f.state.runningReceipts === 64);
    const restored = f.reopen();
    await restored.watchdog(deployment);
    assert.equal(restored.receipts.size, 0);
    assert.equal(f.state.receiptLookups.length, 64);
    assert.equal(restored.store.dispatchState(now).inFlight, 64);
  } finally { for (const held of holds) held.resolve(null); await f.settle(); }
  assert.ok(f.state.peakReceipts <= 64);
});

test('a stalled verifier RPC times out locally and cannot strand or later overwrite its retry', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) =>
    original(callback, milliseconds === 20_000 ? 20 : milliseconds, ...args));
  const f = fixture(t);
  const late = Promise.withResolvers<RevealVerificationResult>();
  const inspect = t.mock.method(f.verifier(hash(1)), 'inspect', () => late.promise);
  assert.equal(value(await f.object.revealTransaction(deployment, hash(1), true)).status, 'pending');
  await f.settle();
  assert.equal(f.object.receipts.size, 0);
  assert.equal(f.store.dispatchState(now).inFlight, 0);
  assert.equal(f.store.knownTransaction(hash(1)), true);
  inspect.mock.restore();
  now += 2_001;
  f.state.receipts.set(hash(1), receipt(hash(1), 1000));
  const result = value(await f.object.revealTransaction(deployment, hash(1)));
  assert.equal(result.status, 'revealed');
  const before = f.store.frozen(ids(1));
  late.resolve({ kind: 'inspected', inspection: { status: 'confirmed',
    observation: { transactionHash: hash(1), blockNumber: 1001, blockHash: hash(1001) }, confirmations: 1,
    crates: [{ crateTokenId: '111113', tokenIds: ids(21) }] } });
  await f.settle();
  assert.deepEqual(f.store.frozen(ids(1)), before);
  assert.deepEqual(f.store.frozen(ids(21)), []);
});

test('a stalled presence callback cannot outlive the verifier deadline or authorize disclosure', async t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) =>
    original(callback, milliseconds === 20_000 ? 20 : milliseconds, ...args));
  const f = fixture(t);
  f.state.receipts.set(hash(1), receipt(hash(1), 1000));
  const callback = Promise.withResolvers<boolean>();
  t.mock.method(f.object, 'recordReceiptPresence', () => callback.promise);
  assert.equal(value(await f.object.revealTransaction(deployment, hash(1), true)).status, 'pending');
  await f.settle();
  assert.equal(f.object.receipts.size, 0);
  assert.equal(f.store.summary().frozen, 0);
  assert.equal(f.published.size, 0);
  assert.equal(f.state.calls.includes('eth_blockNumber'), false);
  callback.resolve(true);
  await f.settle();
  assert.equal(f.store.summary().frozen, 0);
});

test('verifier throttling pauses dispatch without losing watches or delaying frozen reads and publication', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(10));
  const provider = globalThis.fetch;
  const throttle = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    if (method === 'eth_getTransactionReceipt') return new Response('throttled', { status: 429, headers: { 'Retry-After': '5' } });
    return provider(input, init);
  });
  const pending = value(await f.object.revealTransaction(deployment, hash(1), true));
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.artworks, []);
  await f.settle();
  assert.equal(f.store.dispatchState(now).limit, 32);
  assert.equal(f.store.dispatchState(now).pauseUntilMs, now + 5_000);
  assert.equal(f.store.knownTransaction(hash(1)), true);
  assert.equal(f.published.size, 20);
  const calls = throttle.mock.callCount();
  assert.equal(value(await f.object.revealTransaction(deployment, hash(10))).status, 'revealed');
  now += 4_999;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(throttle.mock.callCount(), calls);
  throttle.mock.restore();
  f.state.receipts.set(hash(1), receipt(hash(1), 1000, [{ crateTokenId: '111113', first: 21 }]));
  now++;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(value(await f.object.revealTransaction(deployment, hash(1))).status, 'revealed');
});

test('a failed inspection cancels its remaining provider requests before releasing its concurrency slot', async t => {
  const f = fixture(t);
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const { method } = JSON.parse(String(init?.body));
    if (method === 'eth_chainId') return new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      const abort = () => { cancelled = true; reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    assert.equal(method, 'eth_getTransactionReceipt');
    return new Response('throttled', { status: 429, headers: { 'Retry-After': '2' } });
  });
  const response = value(await f.object.revealTransaction(deployment, hash(1), true));
  await f.settle();
  assert.equal(response.status, 'pending');
  assert.deepEqual(response.artworks, []);
  assert.equal(cancelled, true);
  assert.equal(f.store.dispatchState(Date.now()).inFlight, 0);
});

test('active and background scans advance independently of four blocked receipt checks', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const holds = Array.from({ length: 4 }, () => Promise.withResolvers<Receipt | null>());
  for (let index = 0; index < holds.length; index++) {
    f.state.receipts.set(hash(index + 1), holds[index].promise);
    f.store.admitTransaction(hash(index + 1), 100, index === 0 ? now - 60_000 : now);
  }
  f.store.admitTokens(ids(1, 200), 100, now);
  f.store.admitTokens(ids(201, 100), 100, now - 60_000);
  f.state.minted = 300;
  const logs = Promise.withResolvers<void>();
  f.state.logGate = logs.promise;
  try {
    await f.object.watchdog(deployment);
    await waitFor(() => f.state.runningReceipts === 4 && f.state.runningScans === 2);
    assert.equal([...f.object.scans.values()].filter(work => work.claim.active).length, 1);
    assert.equal([...f.object.scans.values()].filter(work => !work.claim.active).length, 1);
    assert.ok(f.state.scans.every(scan => scan.ids.length <= 100));
    assert.equal(f.state.peakScans, 2);
  } finally { logs.resolve(); for (const hold of holds) hold.resolve(null); await f.settle(); }
  assert.ok(f.state.peakReceipts <= 4);
  assert.ok(f.state.peakScans <= 2);
});

for (const kind of ['tokens', 'crate'] as const) test(`${kind} API polling cannot restart failed discovery before its retry deadline`, async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.state.logsUnavailable = true;
  f.state.minted = 1;
  if (kind === 'crate') f.pending(hash(1));
  const request = (admit = false) => kind === 'tokens'
    ? f.object.revealTokens(deployment, ['1'], admit) : f.object.revealTransaction(deployment, hash(1), admit);
  assert.equal((await request(true)).kind, 'ready');
  await f.settle();
  const scans = () => f.state.calls.filter(method => method === 'eth_getLogs').length;
  assert.equal(scans(), 1);
  const completedAt = now;
  for (const elapsed of [1, 300, 1_999]) {
    now = completedAt + elapsed;
    assert.equal((await request()).kind, 'ready');
    await f.settle();
    assert.equal(scans(), 1);
  }
  now = completedAt + 2_000;
  assert.equal((await request()).kind, 'ready');
  await f.settle();
  assert.equal(scans(), 2);
  assert.equal(f.store.summary().frozen, 0);
});

test('token requests partition provider scans and return exact unminted results without creating crate jobs', async t => {
  const f = fixture(t);
  const claims: RevealScanClaim[] = [];
  const claim = f.store.claimScan.bind(f.store);
  t.mock.method(f.store, 'claimScan', (...args: Parameters<typeof claim>) => {
    const result = claim(...args);
    if (result?.kind === 'tokens') claims.push(result);
    return result;
  });
  const tokenIds = ids(1, 500);
  const result = value(await f.object.revealTokens(deployment, tokenIds, true));
  await f.settle();
  const healed = value(await f.object.revealTokens(deployment, tokenIds));
  assert.ok(result.artworks.length === 0);
  assert.deepEqual(healed.unresolved, tokenIds.map(tokenId => ({ tokenId, status: 'unminted' })));
  assert.equal(healed.retryAfterMs, 0);
  assert.equal(claims.length, 5);
  assert.ok(claims.every(entry => entry.tokenIds.length <= 100));
  assert.equal(new Set(claims.flatMap(entry => entry.tokenIds)).size, 500);
  assert.equal(f.state.scans.length, 0);
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM crate_recovery_jobs')[0].count, 0);
});

test('partial token healing returns frozen results immediately while durable missing-token work continues', async t => {
  shortInlineWait(t);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.minted = 40;
  f.state.receipts.set(hash(2), receipt(hash(2), 1000, [{ crateTokenId: '111113', first: 21 }]));
  const logs = Promise.withResolvers<void>();
  f.state.logGate = logs.promise;
  try {
    const response = value(await f.object.revealTokens(deployment, ['1', '21'], true));
    assert.deepEqual(response.artworks.map(artwork => artwork.tokenId), ['1']);
    assert.deepEqual(response.unresolved, [{ tokenId: '21', status: 'recovering' }]);
    assert.ok(f.getAlarm() !== null);
  } finally { logs.resolve(); await f.settle(); }
  assert.deepEqual(value(await f.object.revealTokens(deployment, ['1', '21'])).artworks.map(artwork => artwork.tokenId), ['1', '21']);
});

test('mixed polling at and beyond negative-cache expiry returns freshly verified unminted results', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1), 241);
  f.state.minted = 260;
  const frozen = f.store.frozen(['260']);
  const first = value(await f.object.revealTokens(deployment, ['260', '111111'], true));
  assert.deepEqual(first.artworks, frozen);
  assert.deepEqual(first.unresolved, [{ tokenId: '111111', status: 'recovering' }]);
  await f.settle();
  for (const interval of [2_000, 2_000, 10_000, 2_000]) {
    now += interval;
    assert.deepEqual(await f.object.revealTokens(deployment, ['260', '111111']), { kind: 'admission' });
    const calls = f.state.calls.length;
    const response = value(await f.object.revealTokens(deployment, ['260', '111111'], true));
    assert.deepEqual(response.artworks, frozen);
    assert.deepEqual(response.unresolved, [{ tokenId: '111111', status: 'unminted' }]);
    assert.equal(response.retryAfterMs, 0);
    assert.equal(f.state.calls.slice(calls).filter(method => method === 'eth_call').length, 1);
    await f.settle();
    assert.equal(f.rows('SELECT COUNT(*) AS count FROM recovery_jobs')[0].count, 0);
    assert.equal(f.rows('SELECT COUNT(*) AS count FROM receipt_token_interest')[0].count, 0);
  }
  const calls = f.state.calls.length;
  t.mock.method(f.object, 'withinBudget', async () => assert.fail('Fresh negative results must not wait'));
  assert.equal(value(await f.object.revealTokens(deployment, ['260', '111111'])).unresolved[0].status, 'unminted');
  assert.equal(f.state.calls.length, calls);
});

test('expired mixed negative results recheck later mints instead of returning stale unminted status', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.minted = 20;
  assert.equal(value(await f.object.revealTokens(deployment, ['21'], true)).unresolved[0].status, 'unminted');
  await f.settle();
  const frozen = f.store.frozen(['1']);
  now += 2_000;
  f.state.minted = 60;
  f.state.receipts.set(hash(2), receipt(hash(2), 1000, [{ crateTokenId: '111113', first: 21 }, { crateTokenId: '111114', first: 41 }]));
  const response = value(await f.object.revealTokens(deployment, ['1', '21'], true));
  assert.deepEqual(response.artworks.map(artwork => artwork.tokenId), ['1', '21']);
  assert.deepEqual(response.artworks[0], frozen[0]);
  assert.deepEqual(response.unresolved, []);
  assert.deepEqual(f.store.frozen(ids(41)), []);
});

for (const includeUnknown of [false, true]) test(`concurrent mixed refresh joins admitted work${includeUnknown ? ' without waiting for a new token' : ''}`, async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.minted = 20;
  await f.object.revealTokens(deployment, ['21'], true);
  await f.settle();
  now += 2_000;
  const held = Promise.withResolvers<void>(), unknown = Promise.withResolvers<void>();
  const provider = globalThis.fetch;
  let statsCalls = 0, completed = false;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    if (JSON.parse(String(args[1]?.body)).method === 'eth_call') {
      await abortable(++statsCalls === 1 ? held.promise : unknown.promise, args[1]?.signal);
    }
    return provider(...args);
  });
  const first = f.object.revealTokens(deployment, ['1', '21'], true);
  try {
    await waitFor(() => statsCalls === 1);
    const second = f.object.revealTokens(deployment, includeUnknown ? ['1', '21', '22'] : ['1', '21'], true).then(result => {
      completed = true;
      return value(result);
    });
    if (includeUnknown) await waitFor(() => statsCalls === 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(completed, false);
    held.resolve();
    await waitFor(() => completed);
    const response = await second;
    assert.deepEqual(response.artworks.map(artwork => artwork.tokenId), ['1']);
    assert.deepEqual(response.unresolved, [{ tokenId: '21', status: 'unminted' },
      ...(includeUnknown ? [{ tokenId: '22', status: 'recovering' }] : [])]);
    assert.equal(response.retryAfterMs, includeUnknown ? 2_000 : 0);
    assert.deepEqual(value(await first).unresolved, [{ tokenId: '21', status: 'unminted' }]);
    assert.equal(statsCalls, includeUnknown ? 2 : 1);
  } finally { held.resolve(); unknown.resolve(); await f.settle(); }
});

test('queued mixed negative refresh waits for occupied scan slots within its deadline', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.minted = 20;
  await f.object.revealTokens(deployment, ['21'], true);
  await f.settle();
  for (let cycle = 0; cycle < 2; cycle++) {
    now += 2_000;
    const held = Promise.withResolvers<void>();
    const provider = globalThis.fetch;
    let statsCalls = 0, completed = false;
    const mock = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
      if (JSON.parse(String(args[1]?.body)).method === 'eth_call' && ++statsCalls <= 2) {
        await abortable(held.promise, args[1]?.signal);
      }
      return provider(...args);
    });
    const unrelated = [f.object.revealTokens(deployment, [String(200 + cycle * 2)], true),
      f.object.revealTokens(deployment, [String(201 + cycle * 2)], true)];
    try {
      await waitFor(() => statsCalls === 2);
      const response = f.object.revealTokens(deployment, ['1', '21'], true, now + 2_000).then(result => {
        completed = true;
        return value(result);
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(completed, false);
      held.resolve();
      const result = await response;
      assert.deepEqual(result.artworks.map(artwork => artwork.tokenId), ['1']);
      assert.deepEqual(result.unresolved, [{ tokenId: '21', status: 'unminted' }]);
      assert.equal(result.retryAfterMs, 0);
      assert.equal(statsCalls, 3);
    } finally { held.resolve(); await Promise.all(unrelated); await f.settle(); mock.mock.restore(); }
  }
});

test('queued mixed negative refresh keeps its original deadline and continues durably', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.minted = 20;
  await f.object.revealTokens(deployment, ['21'], true);
  await f.settle();
  now += 2_000;
  const held = Promise.withResolvers<void>();
  const provider = globalThis.fetch;
  let statsCalls = 0;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    if (JSON.parse(String(args[1]?.body)).method === 'eth_call' && ++statsCalls <= 2) {
      await abortable(held.promise, args[1]?.signal);
    }
    return provider(...args);
  });
  const unrelated = [f.object.revealTokens(deployment, ['200'], true), f.object.revealTokens(deployment, ['201'], true)];
  try {
    await waitFor(() => statsCalls === 2);
    const waits: number[] = [];
    const withinBudget = f.object.withinBudget.bind(f.object);
    t.mock.method(f.object, 'withinBudget', (work: Promise<unknown>, deadline: number) => {
      waits.push(deadline);
      return withinBudget(work, deadline);
    });
    const response = value(await f.object.revealTokens(deployment, ['1', '21'], true, now + 20));
    assert.deepEqual(response.unresolved, [{ tokenId: '21', status: 'recovering' }]);
    assert.equal(response.retryAfterMs, 2_000);
    assert.ok(waits.length && waits.every(deadline => deadline === now + 20));
    assert.ok(f.getAlarm() !== null);
    assert.equal(f.rows("SELECT COUNT(*) AS count FROM token_recovery WHERE token_id='21' AND job_id IS NOT NULL")[0].count, 1);
  } finally { held.resolve(); await Promise.all(unrelated); await f.settle(); }
  const response = value(await f.object.revealTokens(deployment, ['1', '21']));
  assert.deepEqual(response.unresolved, [{ tokenId: '21', status: 'unminted' }]);
  assert.equal(response.retryAfterMs, 0);
});

test('a slow mixed negative refresh honors its original deadline and continues durably', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.minted = 20;
  assert.equal(value(await f.object.revealTokens(deployment, ['21'], true)).unresolved[0].status, 'unminted');
  await f.settle();
  now += 2_000;
  const held = Promise.withResolvers<void>();
  const provider = globalThis.fetch;
  const mock = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    if (JSON.parse(String(args[1]?.body)).method === 'eth_call') await abortable(held.promise, args[1]?.signal);
    return provider(...args);
  });
  const waits: number[] = [];
  const withinBudget = f.object.withinBudget.bind(f.object);
  t.mock.method(f.object, 'withinBudget', (work: Promise<unknown>, deadline: number) => {
    waits.push(deadline);
    return withinBudget(work, deadline);
  });
  try {
    const response = value(await f.object.revealTokens(deployment, ['1', '21'], true, now + 20));
    assert.deepEqual(response.artworks.map(artwork => artwork.tokenId), ['1']);
    assert.deepEqual(response.unresolved, [{ tokenId: '21', status: 'recovering' }]);
    assert.ok(waits.length && waits.every(deadline => deadline === now + 20));
    assert.ok(f.getAlarm() !== null);
    assert.equal(f.rows('SELECT COUNT(*) AS count FROM recovery_jobs')[0].count, 1);
  } finally { held.resolve(); mock.mock.restore(); await f.settle(); }
  const response = value(await f.object.revealTokens(deployment, ['1', '21']));
  assert.deepEqual(response.unresolved, [{ tokenId: '21', status: 'unminted' }]);
  assert.equal(response.retryAfterMs, 0);
});

test('failed mixed negative refreshes stay recovering until a successful canonical check', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.minted = 20;
  assert.equal(value(await f.object.revealTokens(deployment, ['21'], true)).unresolved[0].status, 'unminted');
  await f.settle();
  now += 2_000;
  f.state.failedMethods.add('eth_call');
  const failed = value(await f.object.revealTokens(deployment, ['1', '21'], true));
  assert.deepEqual(failed.unresolved, [{ tokenId: '21', status: 'recovering' }]);
  assert.equal(failed.retryAfterMs, 2_000);
  assert.equal(f.store.frozen(['21']).length, 0);
  f.state.failedMethods.clear();
  now += 2_001;
  await f.object.revealTokens(deployment, ['1', '21']);
  await f.settle();
  assert.equal(value(await f.object.revealTokens(deployment, ['1', '21'])).unresolved[0].status, 'unminted');
});

test('mixed negative refresh still requires admission and paused deployments serve only fresh negatives', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.minted = 20;
  await f.object.revealTokens(deployment, ['21'], true);
  await f.settle();
  const paused = { ...deployment, state: 'paused' as const };
  const calls = f.state.calls.length;
  assert.equal(value(await f.object.revealTokens(paused, ['1', '21'])).unresolved[0].status, 'unminted');
  now += 2_000;
  assert.deepEqual(await f.object.revealTokens(paused, ['1', '21']), { kind: 'admission' });
  await assert.rejects(f.object.revealTokens(paused, ['1', '21'], true), /paused/);
  assert.equal(f.state.calls.length, calls);
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM recovery_jobs')[0].count, 0);
});

test('mixed refresh waits for every expired negative batch without stopping at existing artwork', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.state.minted = 20;
  const negatives = ids(21, 201);
  await f.object.revealTokens(deployment, negatives, true);
  await f.settle();
  now += 2_000;
  let statsCalls = 0, completed = false;
  const held = Promise.withResolvers<void>();
  const provider = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    if (JSON.parse(String(args[1]?.body)).method === 'eth_call' && ++statsCalls === 3) {
      await abortable(held.promise, args[1]?.signal);
    }
    return provider(...args);
  });
  const response = f.object.revealTokens(deployment, ['1', ...negatives], true).then(result => {
    completed = true;
    return value(result);
  });
  try {
    await waitFor(() => statsCalls === 3);
    assert.equal(completed, false);
    const settled = f.store.tokensResponse(deployment, negatives).unresolved.filter(item => item.status === 'unminted').length;
    assert.ok(settled > 0 && settled < negatives.length);
  } finally { held.resolve(); }
  const result = await response;
  assert.deepEqual(result.artworks.map(artwork => artwork.tokenId), ['1']);
  assert.ok(result.unresolved.every(item => item.status === 'unminted'));
  assert.equal(result.retryAfterMs, 0);
});

test('token recovery reveals only its crate until an explicit full bundled transaction request', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.state.minted = 40;
  f.state.receipts.set(hash(1), receipt(hash(1), 1000, [{ crateTokenId: '111112', first: 1 }, { crateTokenId: '111113', first: 21 }]));
  value(await f.object.revealTokens(deployment, ['1'], true));
  await f.settle();
  assert.equal(f.store.frozen(ids(1)).length, 20);
  assert.equal(f.store.frozen(ids(21)).length, 0);
  assert.deepEqual(await f.object.revealTransaction(deployment, hash(1)), { kind: 'admission' });
  now += 2001;
  const response = value(await f.object.revealTransaction(deployment, hash(1), true));
  await f.settle();
  assert.equal(response.status, 'revealed');
  assert.equal(response.artworks.length, 40);
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM crate_recovery_jobs')[0].count, 2);
});

test('a wrapped receipt above fifteen crates yields a complete response with one globally deduplicated inspection', async t => {
  const f = fixture(t);
  const crates = Array.from({ length: 16 }, (_, index) => ({ crateTokenId: String(111112 + index), first: 20 * index + 1 }));
  f.state.receipts.set(hash(1), receipt(hash(1), 1000, crates));
  const response = value(await f.object.revealTransaction(deployment, hash(1), true));
  await f.settle();
  assert.equal(response.status, 'revealed');
  assert.equal(response.artworks.length, 320);
  assert.equal(new Set(response.artworks.map(artwork => artwork.image)).size, 320);
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM crate_recovery_jobs')[0].count, 16);
  assert.equal(f.state.receiptLookups.filter(entry => entry === hash(1)).length, 1);
});

test('a stale receipt completion cannot overwrite a later claim or its frozen result', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.store.admitTransaction(hash(1), 100, now);
  const oldClaim = f.store.claimReceipt(now, 'active', hash(1))!;
  assert.ok(oldClaim);
  const pending = Promise.withResolvers<Receipt | null>();
  f.state.receipts.set(hash(1), pending.promise);
  const stale = f.object.processReceipt(deployment, oldClaim);
  await waitFor(() => f.state.receiptLookups.length === 1);
  now += 30_001;
  f.store.admitTransaction(hash(1), 100, now);
  const freshClaim = f.store.claimReceipt(now, 'active', hash(1))!;
  assert.ok(freshClaim);
  assert.notEqual(freshClaim.claimId, oldClaim.claimId);
  const observed = { transactionHash: hash(1), blockNumber: 1000, blockHash: hash(1000) };
  f.store.completeReceipt(deployment, freshClaim, { status: 'confirmed', observation: observed,
    crates: [{ crateTokenId: '111112', tokenIds: ids(1) }], confirmations: 1 }, now);
  const expected = f.store.transactionResponse(deployment, hash(1));
  pending.resolve(null);
  await stale;
  assert.deepEqual(f.store.transactionResponse(deployment, hash(1)), expected);
  assert.equal(f.store.frozen(ids(1)).length, 20);
});

test('a stale scan cannot restore recovering state after a newer canonical receipt', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.store.acceptVerified(deployment, hash(1), { status: 'pending', seen: true, crates: ['111112'], fromBlock: 1000 }, now, now);
  const claim = f.store.claimScan(now, 'active')!;
  assert.ok(claim);
  const logs = Promise.withResolvers<void>();
  f.state.logGate = logs.promise;
  const scan = f.object.processScan(deployment, claim);
  await waitFor(() => f.state.runningScans === 1);
  f.freeze(hash(2));
  const expected = f.rows('SELECT * FROM crate_recovery_jobs');
  logs.resolve();
  await scan;
  assert.deepEqual(f.rows('SELECT * FROM crate_recovery_jobs'), expected);
  assert.equal(f.store.frozen(ids(1)).length, 20);
});

test('stable crate recovery retains late candidates through chained reorgs and restart with unavailable logs', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  for (const index of [1, 4]) {
    f.pending(hash(index));
    value(await f.object.revealTransaction(deployment, hash(index), true));
  }
  await f.settle();
  f.state.transactions.clear();
  for (const [index, first] of [[2, 1], [3, 21]] as const) {
    f.state.receipts.clear();
    f.state.head = 1000 + index;
    f.state.receipts.set(hash(index), receipt(hash(index), f.state.head, [{ crateTokenId: '111112', first }]));
    now += 60_000;
    await f.object.watchdog(deployment);
    await f.settle();
    now += 60_000;
    await f.object.watchdog(deployment);
    await f.settle();
    assert.equal(f.store.frozen(ids(first)).length, 20);
  }
  const frozen = f.store.frozen(ids(1, 40));
  f.state.receipts.clear();
  f.state.head = 1004;
  f.state.receipts.set(hash(4), receipt(hash(4), 1004, [{ crateTokenId: '111112', first: 41 }]));
  f.state.logsUnavailable = true;
  const restored = f.reopen();
  for (let attempt = 0; attempt < 6 && restored.store.frozen(ids(41)).length === 0; attempt++) {
    now += 3_600_001;
    await restored.watchdog(deployment);
    await f.settle();
  }
  assert.deepEqual(restored.store.frozen(ids(1, 40)), frozen);
  assert.equal(restored.store.frozen(ids(41)).length, 20);
  assert.equal(value(await restored.revealTransaction(deployment, hash(4))).status, 'revealed');
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM crate_recovery_jobs')[0].count, 1);
});

test('publication drains while unrelated receipts and scans remain blocked', async t => {
  const f = fixture(t);
  const blocked = Promise.withResolvers<Receipt | null>(), logs = Promise.withResolvers<void>();
  f.state.receipts.set(hash(9), blocked.promise);
  f.state.logGate = logs.promise;
  f.state.minted = 40;
  f.store.admitTransaction(hash(9), 100, Date.now());
  f.store.admitTokens(['21'], 100, Date.now());
  f.freeze(hash(1));
  try {
    await f.object.watchdog(deployment);
    await f.firstBatch;
    assert.equal(f.published.size, 20);
    await waitFor(() => f.state.runningReceipts > 0 && f.state.runningScans > 0);
    f.freeze(hash(2), 21, '111113');
    await f.object.watchdog(deployment);
    assert.equal(f.published.size, 40);
  } finally { blocked.resolve(null); logs.resolve(); await f.settle(); }
});

test('publication continues while every receipt verification slot is stalled', async t => {
  const f = fixture(t);
  const holds = Array.from({ length: 64 }, () => Promise.withResolvers<Receipt | null>());
  for (const [index, held] of holds.entries()) {
    f.state.receipts.set(hash(index + 1), held.promise);
    f.store.admitTransaction(hash(index + 1), 100, Date.now());
  }
  f.freeze(hash(500));
  try {
    await f.object.watchdog(deployment);
    assert.equal(f.state.runningReceipts, 64);
    assert.equal(f.published.size, 20);
    assert.equal(f.rows("SELECT COUNT(*) AS count FROM publication WHERE status='published'")[0].count, 20);
    assert.equal(f.store.summary().frozen, 20);
  } finally { for (const held of holds) held.resolve(null); await f.settle(); }
});

test('publication yields after 512 jobs with a durable continuation', async t => {
  const f = fixture(t);
  for (let index = 0; index < 26; index++) f.freeze(hash(index + 1), index * 20 + 1, String(111112 + index));
  await f.object.runPublications(deployment);
  assert.equal(f.published.size, 512);
  assert.equal(f.rows("SELECT COUNT(*) AS count FROM publication WHERE status='pending'")[0].count, 8);
  assert.ok(f.getAlarm() !== null);
  await f.object.runPublications(deployment);
  assert.equal(f.published.size, 520);
});

test('publication yields at its time budget and resumes the remaining batch', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const put = f.metadata.put.bind(f.metadata);
  t.mock.method(f.metadata, 'put', async (...args: Parameters<typeof put>) => { now += 1000; return put(...args); });
  await f.object.runPublications(deployment);
  assert.equal(f.published.size, 8);
  await f.object.runPublications(deployment);
  assert.equal(f.published.size, 16);
});

test('concurrent publication callers share one drain without duplicate writes', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const writes: string[] = [];
  const put = f.metadata.put.bind(f.metadata);
  t.mock.method(f.metadata, 'put', async (...args: Parameters<typeof put>) => {
    writes.push(args[0]);
    if (writes.length === 8) entered.resolve();
    await release.promise;
    return put(...args);
  });
  const first = f.object.runPublications(deployment);
  await entered.promise;
  const second = f.object.runPublications(deployment);
  try { assert.equal(writes.length, 8); }
  finally { release.resolve(); await Promise.all([first, second]); }
  assert.equal(writes.length, 20);
  assert.equal(new Set(writes).size, 20);
});

test('publication retries temporary failures and preserves frozen bytes', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  let failed = false;
  const put = f.metadata.put.bind(f.metadata);
  t.mock.method(f.metadata, 'put', async (...args: Parameters<typeof put>) => {
    if (args[0].endsWith('/1.json') && !failed) { failed = true; throw new Error('Temporary storage failure'); }
    return put(...args);
  });
  const frozen = f.store.frozen(ids(1));
  await f.object.runPublications(deployment);
  assert.equal(f.published.size, 19);
  now += 2000;
  await f.object.runPublications(deployment);
  assert.equal(f.published.size, 20);
  assert.deepEqual(f.store.frozen(ids(1)), frozen);
  assert.equal(f.published.get('111k-sepolia/1.json'), f.rows("SELECT metadata_json FROM assignments WHERE token_id='1'")[0].metadata_json);
});

test('publication quarantines conflicts and accepts already frozen bytes without rewriting them', async t => {
  const f = fixture(t);
  f.freeze(hash(1));
  const frozen = f.store.frozen(ids(1));
  f.published.set('111k-sepolia/1.json', '{"image":"https://example.invalid/different.webp"}\n');
  f.published.set('111k-sepolia/2.json', String(f.rows("SELECT metadata_json FROM assignments WHERE token_id='2'")[0].metadata_json));
  await f.object.runPublications(deployment);
  assert.equal(f.rows("SELECT status FROM publication WHERE token_id='1'")[0].status, 'conflict');
  assert.equal(f.rows("SELECT status FROM publication WHERE token_id='2'")[0].status, 'published');
  assert.equal(f.media.writes, 18);
  assert.match(f.published.get('111k-sepolia/1.json')!, /different.webp/);
  assert.deepEqual(f.store.frozen(ids(1)), frozen);
});

test('crate discovery persists adaptive split ranges and resumes them across restart', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.store.acceptVerified(deployment, hash(1), { status: 'pending', seen: true, crates: ['111112'], fromBlock: 100 }, now, now);
  const queries: Array<{ from: number; to: number }> = [];
  let failAfterSplit = true;
  const provider = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    if (method === 'eth_getLogs') {
      const range = { from: Number(BigInt(params[0].fromBlock)), to: Number(BigInt(params[0].toBlock)) };
      queries.push(range);
      if (range.to - range.from > 500) return Response.json({ jsonrpc: '2.0', id: 1,
        error: { code: -32602, message: 'This block range exceeds the allowed block range.' } });
      if (failAfterSplit) throw new Error('Temporary log outage');
    }
    return provider(url, init);
  });
  await f.object.watchdog(deployment);
  await f.settle();
  assert.ok(f.rows('SELECT ranges_json FROM crate_recovery_jobs').some(row => row.ranges_json !== '[]'));
  assert.equal(f.store.summary().frozen, 0);
  f.state.receipts.set(hash(2), receipt(hash(2), 900));
  failAfterSplit = false;
  now += 3_600_001;
  const restored = f.reopen();
  await restored.watchdog(deployment);
  await f.settle();
  assert.equal(restored.store.frozen(ids(1)).length, 20);
  assert.ok(queries.some(range => range.from <= 900 && range.to >= 900 && range.to - range.from <= 500));
  assert.ok(restored.store.frozen(ids(1)).every(artwork => artwork.observation.transactionHash === hash(2)));
});

test('incomplete receipt evidence stays private and does not block another crate from revealing', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const malformed = receipt(hash(1), 1000);
  malformed.logs.splice(2, 1);
  f.state.receipts.set(hash(1), malformed);
  f.state.receipts.set(hash(2), receipt(hash(2), 1000, [{ crateTokenId: '111113', first: 21 }]));
  const responses = await Promise.all([1, 2].map(index => f.object.revealTransaction(deployment, hash(index), true)));
  await f.settle();
  assert.equal(value(responses[0]).status, 'pending');
  assert.deepEqual(value(responses[0]).artworks, []);
  assert.equal(f.store.frozen(ids(1)).length, 0);
  assert.equal(value(responses[1]).status, 'revealed');
  assert.equal(f.store.frozen(ids(21)).length, 20);
  f.state.receipts.set(hash(1), receipt(hash(1), 1000));
  now += 60_000;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.store.frozen(ids(1)).length, 20);
});

test('alarm processing reloads deployment state and continues already admitted recovery while paused', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.pending(hash(1), ['111112'], true);
  value(await f.object.revealTransaction(deployment, hash(1), true));
  await f.settle();
  f.database.prepare("UPDATE ethereum_reveal_deployments SET state='paused',revision=revision+1").run();
  const paused = { ...deployment, state: 'paused' as const, revision: 4 };
  assert.deepEqual(await f.object.revealTransaction(paused, hash(2)), { kind: 'admission' });
  f.state.transactions.clear();
  f.state.receipts.set(hash(1), receipt(hash(1), 1001));
  f.state.head = 1001;
  now += 60_000;
  await f.reopen().alarm();
  await f.settle();
  assert.equal(f.store.frozen(ids(1)).length, 20);
  assert.equal(f.published.size, 20);
  const calls = f.state.calls.length;
  assert.equal(value(await f.object.revealTransaction(paused, hash(1))).status, 'revealed');
  assert.equal(f.state.calls.length, calls);
});

for (const previouslyScoped of [true, false]) test(`late owned-pending evidence ${previouslyScoped ? 'with a captured crate generation' : 'from an initially unscoped hash'} preserves a newer confirmation`, async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.pending(hash(1));
  f.state.logsUnavailable = true;
  if (previouslyScoped) {
    assert.equal(value(await f.object.revealTransaction(deployment, hash(1), true)).status, 'pending');
    await f.settle();
    assert.equal(f.store.summary().reserved, 20);
    now += 2_000;
  }
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const provider = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    const response = await provider(url, init);
    if (method === 'eth_getBlockByNumber' && params[0] === '0x3e8') {
      entered.resolve();
      await abortable(release.promise, init?.signal);
    }
    return response;
  });
  const pending = f.object.revealTransaction(deployment, hash(1), true);
  try {
    await entered.promise;
    now += 100;
    f.state.head = 1001;
    f.state.receipts.set(hash(2), receipt(hash(2), 1001));
    assert.equal(value(await f.object.revealTransaction(deployment, hash(2), true)).status, 'revealed');
    const job = f.rows("SELECT * FROM crate_recovery_jobs WHERE crate_token_id='111112'");
    const frozen = f.rows('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id');
    assert.equal(job[0].mode, 'observed');
    assert.equal(job[0].observed_hash, hash(2));
    assert.equal(f.store.summary().reserved, 0);
    now += 100;
    release.resolve();
    assert.equal(value(await pending).status, 'pending');
    await f.settle();
    assert.deepEqual(f.rows("SELECT * FROM crate_recovery_jobs WHERE crate_token_id='111112'"), job);
    assert.deepEqual(f.rows('SELECT * FROM assignments WHERE token_id IS NOT NULL ORDER BY token_id'), frozen);
    assert.equal(f.store.summary().reserved, 0);
    assert.ok(JSON.parse(f.store.transactionJob(hash(1))!.crates_json).includes('111112'));
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM crate_candidates WHERE crate_token_id=? AND hash=?')
      .get('111112', hash(1))!.count, 1);
  } finally { release.resolve(); await pending; await f.settle(); }
});

test('an authorized foreground retry after unknown expiry acknowledges a fresh durable watch without a second inline inspection', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const transactionHash = hash(1);
  assert.equal(value(await f.object.revealTransaction(deployment, transactionHash, true)).status, 'pending');
  await f.settle();
  const original = f.rows(`SELECT created_at_ms FROM receipt_work WHERE hash='${transactionHash}'`)[0];
  now += 15 * 60_000 + 1;
  const calls = f.state.receiptLookups.length;
  const response = value(await f.object.revealTransaction(deployment, transactionHash, true));
  await f.settle();
  assert.equal(response.status, 'pending');
  assert.deepEqual(response.artworks, []);
  assert.equal(response.retryAfterMs, 2000);
  assert.equal(f.state.receiptLookups.length - calls, 1);
  assert.equal(f.store.knownTransaction(transactionHash), true);
  const renewed = f.rows(`SELECT created_at_ms,opaque,observed FROM receipt_work WHERE hash='${transactionHash}'`)[0];
  assert.ok(renewed);
  assert.equal(renewed.created_at_ms, now);
  assert.ok(Number(renewed.created_at_ms) > Number(original.created_at_ms));
  assert.equal(renewed.opaque, 1);
  assert.equal(renewed.observed, 0);
  assert.ok(f.getAlarm() !== null);
  assert.ok(f.store.nextWake(now) !== null);
  const restored = f.reopen();
  f.state.receipts.set(transactionHash, receipt(transactionHash, 1001));
  f.state.head = 1001;
  now += 2001;
  await restored.watchdog(deployment);
  await f.settle();
  assert.equal(value(await restored.revealTransaction(deployment, transactionHash)).status, 'revealed');
  assert.equal(restored.store.frozen(ids(1)).length, 20);
  assert.equal(f.published.size, 20);
});

test('a foreground expiry race returns HTTP capacity after admission when another request takes the released slot', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const transactionHash = hash(1), competitor = hash(20_001);
  assert.equal(value(await f.object.revealTransaction(deployment, transactionHash, true)).status, 'pending');
  await f.settle();
  for (let index = 2; index <= 10_000; index++) assert.equal(f.store.admitTransaction(hash(index), 100, now), 'accepted');
  f.sql.exec('UPDATE receipt_work SET next_check_ms=? WHERE hash!=?', now + 86_400_000, transactionHash);
  assert.equal(f.store.opaqueCount(), 10_000);
  const complete = f.store.completeReceipt.bind(f.store);
  let filled = false;
  t.mock.method(f.store, 'completeReceipt', (...args: Parameters<typeof complete>) => {
    const result = complete(...args);
    if (args[1].hash === transactionHash && !f.store.knownTransaction(transactionHash)) {
      assert.equal(f.store.opaqueCount(), 9999);
      assert.equal(f.store.admitTransaction(competitor, 100, now), 'accepted');
      f.sql.exec('UPDATE receipt_work SET next_check_ms=? WHERE hash=?', now + 86_400_000, competitor);
      filled = true;
    }
    return result;
  });
  now += 15 * 60_000 + 1;
  const calls = f.state.receiptLookups.length;
  const route = transactionRoute(f);
  const response = await route.request(transactionHash);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(route.admissions(), 1);
  await f.settle();
  assert.equal(filled, true);
  assert.equal(f.state.receiptLookups.length - calls, 2);
  assert.equal(f.store.opaqueCount(), 10_000);
  assert.equal(f.store.knownTransaction(competitor), true);
  assert.equal(f.store.knownTransaction(transactionHash), false);
  assert.equal(f.rows(`SELECT COUNT(*) AS count FROM receipt_work WHERE hash='${transactionHash}'`)[0].count, 0);
});

for (const admissionAllowed of [true, false]) test(`foreground expiry ${admissionAllowed ? 'readmits durable work after' : 'honors denial from'} the route admission limiter`, async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const transactionHash = hash(1);
  value(await f.object.revealTransaction(deployment, transactionHash, true));
  await f.settle();
  const calls: Array<{ admit: boolean; deadlineMs: number | undefined }> = [];
  const reveal = f.object.revealTransaction.bind(f.object);
  t.mock.method(f.object, 'revealTransaction', (...args: Parameters<typeof reveal>) => {
    calls.push({ admit: args[2] ?? false, deadlineMs: args[3] });
    return reveal(...args);
  });
  now += 15 * 60_000 + 1;
  const route = transactionRoute(f, admissionAllowed);
  const response = await route.request(transactionHash);
  await f.settle();
  assert.equal(route.admissions(), 1);
  assert.equal(response.status, admissionAllowed ? 200 : 429);
  assert.deepEqual(calls.map(call => call.admit), admissionAllowed ? [false, true] : [false]);
  assert.ok(calls.every(call => call.deadlineMs === now + 2000));
  assert.equal(f.store.knownTransaction(transactionHash), admissionAllowed);
  if (admissionAllowed) {
    const body = await response.json() as EthereumRevealTransactionResponse;
    assert.equal(body.status, 'pending');
    assert.deepEqual(body.artworks, []);
    assert.equal(f.rows(`SELECT created_at_ms FROM receipt_work WHERE hash='${transactionHash}'`)[0].created_at_ms, now);
    assert.ok(f.getAlarm() !== null);
  } else assert.equal(f.rows(`SELECT COUNT(*) AS count FROM receipt_work WHERE hash='${transactionHash}'`)[0].count, 0);
});

test('paused routes continue an existing unknown watch but refuse a fresh watch after its expiry', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const transactionHash = hash(1);
  value(await f.object.revealTransaction(deployment, transactionHash, true));
  await f.settle();
  const createdAt = f.rows(`SELECT created_at_ms FROM receipt_work WHERE hash='${transactionHash}'`)[0].created_at_ms;
  f.database.exec("UPDATE ethereum_reveal_deployments SET state='paused',revision=revision+1");
  const route = transactionRoute(f);
  now += 2001;
  const continuing = await route.request(transactionHash);
  await f.settle();
  assert.equal(continuing.status, 200);
  assert.equal((await continuing.json() as EthereumRevealTransactionResponse).status, 'pending');
  assert.equal(f.rows(`SELECT created_at_ms FROM receipt_work WHERE hash='${transactionHash}'`)[0].created_at_ms, createdAt);
  assert.equal(route.admissions(), 0);
  now += 15 * 60_000;
  const expired = await route.request(transactionHash);
  await f.settle();
  assert.equal(expired.status, 409);
  assert.equal(route.admissions(), 0);
  assert.equal(f.store.knownTransaction(transactionHash), false);
  assert.equal(f.rows(`SELECT COUNT(*) AS count FROM receipt_work WHERE hash='${transactionHash}'`)[0].count, 0);
  assert.equal((await route.request(hash(2))).status, 409);
});

test('an internal deadline cannot extend the Object inline wait beyond two seconds', async t => {
  const f = fixture(t);
  const blocked = Promise.withResolvers<Receipt | null>();
  f.state.receipts.set(hash(1), blocked.promise);
  const waits: number[] = [];
  const withinBudget = f.object.withinBudget.bind(f.object);
  t.mock.method(f.object, 'withinBudget', (work: Promise<unknown>, deadline: number) => {
    waits.push(deadline - Date.now());
    return withinBudget(work, Math.min(deadline, Date.now() + 10));
  });
  try {
    const response = value(await f.object.revealTransaction(deployment, hash(1), true, Date.now() + 60_000));
    assert.equal(response.status, 'pending');
    assert.ok(waits.length > 0);
    assert.ok(waits.every(milliseconds => milliseconds <= 2000));
    assert.equal(f.store.knownTransaction(hash(1)), true);
    assert.equal(f.object.receipts.size, 1);
  } finally { blocked.resolve(null); await f.settle(); }
});

test('a late canonical scan recovers its replacement after an older receipt settles', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t), original = hash(1), replacement = hash(2);
  f.pending(original);
  value(await f.object.revealTransaction(deployment, original, true));
  await f.settle();
  now += 2_000;
  f.state.head = 1063;
  f.state.receipts.set(original, receipt(original, 1000));
  const oldCanonical = Promise.withResolvers<void>(), releaseOld = Promise.withResolvers<void>();
  const scanEntered = Promise.withResolvers<void>(), releaseScan = Promise.withResolvers<void>();
  let blockOld = true, blockScan = false;
  const provider = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    if (blockOld && method === 'eth_getBlockByNumber' && params[0] === '0x3e8') {
      const response = await provider(url, init);
      blockOld = false;
      oldCanonical.resolve();
      await abortable(releaseOld.promise, init?.signal);
      return response;
    }
    if (blockScan && method === 'eth_getLogs') {
      scanEntered.resolve();
      await abortable(releaseScan.promise, init?.signal);
    }
    return provider(url, init);
  });
  const receiptClaim = f.store.claimReceipt(now, 'active', original);
  assert.ok(receiptClaim);
  const receiptRun = f.object.processReceipt(deployment, receiptClaim);
  await oldCanonical.promise;
  f.state.head = 1001;
  f.state.receipts.delete(original);
  f.state.receipts.set(replacement, receipt(replacement, 1001, [{ crateTokenId: '111112', first: 21 }]));
  f.state.canonicalHashes.set(1000, hash(9000));
  blockScan = true;
  const scanClaim = f.store.claimScan(now, 'active');
  assert.ok(scanClaim);
  const scanRun = f.object.processScan(deployment, scanClaim);
  await scanEntered.promise;
  releaseOld.resolve();
  await receiptRun;
  const frozen = f.store.frozen(ids(1));
  releaseScan.resolve();
  await scanRun;
  await f.object.watchdog(deployment);
  await f.settle();
  assert.equal(f.store.frozen(ids(21)).length, 20);
  assert.deepEqual(f.store.frozen(ids(1)), frozen);
  assert.equal(f.rows('SELECT observed_hash FROM crate_recovery_jobs')[0].observed_hash, replacement);
});

test('verified pending overflow promptly recovers a crate with an obsolete daily watcher', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  f.freeze(hash(1));
  f.store.admitTransaction(hash(1), 100, now);
  const claim = f.store.claimReceipt(now, 'active', hash(1));
  assert.ok(claim);
  f.store.completeReceipt(deployment, claim, { status: 'confirmed',
    observation: { transactionHash: hash(1), blockNumber: 101, blockHash: hash(101) },
    crates: [{ crateTokenId: '111112', tokenIds: ids(1) }], confirmations: 64 }, now);
  const frozen = f.store.frozen(ids(1));
  for (let index = 100; index < 10100; index++) f.store.admitTransaction(hash(index), 100, now);
  f.sql.exec('UPDATE receipt_work SET next_check_ms=? WHERE opaque=1', now + 86_400_000);
  now += 100;
  f.pending(hash(20_000));
  f.state.canonicalHashes.set(101, hash(999999));
  assert.equal(value(await f.object.revealTransaction(deployment, hash(20_000), true)).status, 'pending');
  await f.settle();
  assert.ok(Number(f.store.nextWake(now)) <= now + 2_000);
  assert.equal(f.rows('SELECT mode FROM crate_recovery_jobs')[0].mode, 'recovering');
  f.state.receipts.set(hash(20_000), receipt(hash(20_000), 102, [{ crateTokenId: '111112', first: 21 }]));
  now += 2_000;
  await f.reopen().watchdog(deployment);
  await f.settle();
  assert.equal(f.store.frozen(ids(21)).length, 20);
  assert.deepEqual(f.store.frozen(ids(1)), frozen);
});

test('direct non-unpack input resolves its watch while matching opaque wrapper input stays watched', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t);
  const direct = hash(1), wrapped = hash(2);
  f.pending(direct);
  f.pending(wrapped, ['111112'], true);
  for (const transactionHash of [direct, wrapped]) f.state.transactions.get(transactionHash)!.input = encodeCall('baseURI()', [], []);
  const rejected = value(await f.object.revealTransaction(deployment, direct, true));
  await f.settle();
  assert.equal(rejected.status, 'not_unpack');
  assert.deepEqual(rejected.artworks, []);
  assert.equal(f.store.opaqueCount(), 0);
  const pending = value(await f.object.revealTransaction(deployment, wrapped, true));
  await f.settle();
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.artworks, []);
  assert.equal(f.store.opaqueCount(), 1);
  assert.equal(f.store.summary().reserved, 0);
  assert.equal(f.store.summary().frozen, 0);
  const directLookups = f.state.receiptLookups.filter(entry => entry === direct).length;
  f.state.transactions.clear();
  now += 48 * 3_600_000;
  const restored = f.reopen();
  await restored.watchdog(deployment);
  await f.settle();
  assert.deepEqual(value(await restored.revealTransaction(deployment, direct)), rejected);
  assert.equal(f.state.receiptLookups.filter(entry => entry === direct).length, directLookups);
  assert.equal(restored.store.opaqueCount(), 1);
  assert.deepEqual(f.rows('SELECT hash,observed,opaque,resolved FROM receipt_work ORDER BY hash').map(row => ({ ...row })), [
    { hash: direct, observed: 1, opaque: 0, resolved: 1 },
    { hash: wrapped, observed: 1, opaque: 1, resolved: 0 },
  ]);
});

test('a reorg that makes a requested token unminted leaves no recurring receipt poller', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t), transactionHash = hash(1);
  f.state.minted = 40;
  f.state.receipts.set(transactionHash, receipt(transactionHash, 1000, [{ crateTokenId: '111112', first: 21 }]));
  f.state.failedReceipts.add(transactionHash);
  const initial = value(await f.object.revealTokens(deployment, ['21'], true));
  await f.settle();
  assert.deepEqual(initial.unresolved, [{ tokenId: '21', status: 'recovering' }]);
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM receipt_token_interest')[0].count, 1);
  f.state.failedReceipts.clear();
  f.state.head = 1001;
  f.state.minted = 20;
  f.state.canonicalHashes.set(1000, hash(9000));
  f.state.receipts.set(transactionHash, receipt(transactionHash, 1001));
  now += 2_000;
  const closed = value(await f.object.revealTokens(deployment, ['21'], true));
  await f.settle();
  assert.deepEqual(closed.unresolved, [{ tokenId: '21', status: 'unminted' }]);
  assert.deepEqual(closed.artworks, []);
  assert.equal(closed.retryAfterMs, 0);
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM recovery_jobs')[0].count, 0);
  assert.equal(f.rows('SELECT COUNT(*) AS count FROM receipt_token_interest')[0].count, 0);
  const lookups = f.state.receiptLookups.length;
  now += 86_400_000;
  const restored = f.reopen();
  for (let attempt = 0; attempt < 3; attempt++) {
    await restored.watchdog(deployment);
    await f.settle();
    now += 300_000;
  }
  assert.equal(f.state.receiptLookups.length, lookups);
  assert.equal(restored.store.summary().frozen, 0);
  assert.deepEqual(restored.store.tokensResponse(deployment, ['21']).unresolved, [{ tokenId: '21', status: 'unminted' }]);
});
