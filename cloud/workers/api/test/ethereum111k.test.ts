import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { encodeAbi, decodeReturn, ETHEREUM_EVENT_TOPICS, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ETHEREUM_API_PATHS as paths, ETHEREUM_SESSION_HEADER, type EthereumAuthChallenge,
  type EthereumSession, type EthereumDeliveryPrepareResponse, type EthereumClaimPrepareResponse } from '../../../../shared/ethereum/api.ts';
import { deliveryDigest, crateClaimDigest, ethereumReceiptIdsHash, ethereumSignerAddress, personalMessageHash, recoverEthereumAddress, signDigest } from '../../../../shared/ethereum/crypto.ts';
import { crateArtworkIds, ethereumHexQuantity } from '../../../../shared/ethereum/protocol.ts';
import { handleEthereumRequest } from '../src/ethereumHandler.ts';
import { reconcileEthereum111k } from '../src/ethereumReconciliation.ts';
import type { EthereumEnvironment } from '../src/ethereumRuntime.ts';
import type { EthereumLog, EthereumReceipt } from '../src/ethereumRead.ts';
import { D1CommerceRepository, commerceKeys } from '../src/commerceRepository.ts';
import { planReadyToShipNotifications } from '../src/readyToShipNotifications.ts';
import { requireShipStationEnabled } from '../src/shipstation/common.ts';
import { createCommerceD1Harness, d1Database } from './commerceD1Harness.ts';

const NOW = 2_000_000_000_000;
const ORIGIN = 'https://mons.shop';
const CONTRACT = '0x1111111111111111111111111111111111111111';
const OTHER_CONTRACT = '0x9999999999999999999999999999999999999999';
const RENDERER = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';
const WALLET_KEY = `0x${'11'.repeat(32)}`;
const OTHER_KEY = `0x${'22'.repeat(32)}`;
const SIGNER_KEY = `0x${'0'.repeat(59)}a11ce`;
const WALLET = ethereumSignerAddress(WALLET_KEY);
const OTHER_WALLET = ethereumSignerAddress(OTHER_KEY);
const SIGNER = ethereumSignerAddress(SIGNER_KEY);
const ADDRESS_ID = 'ABCDEFGHIJKLMNOPQRST';
const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const HASH = `0x${'aa'.repeat(32)}`;
const CLAIM_HASH = `0x${'bb'.repeat(32)}`;
const blockHash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
const functionSelector = (signature: string) => encodeCall(signature, [], []).slice(0, 10);
const topicNumber = (value: number | string) => encodeAbi(['uint256'], [value]);
const topicAddress = (value: string) => encodeAbi(['address'], [value]);
const readPaths = new Set<string>([paths.config, paths.stats, paths.inventory, paths.metadata, paths.profile, paths.shipments]);
type Rpc = { id: number; method: string; params: unknown[] };
type Item = { kind: number; displayId: number; owner: string };

function fixture() {
  const ops = new DatabaseSync(':memory:');
  ops.exec(readFileSync('cloud/workers/api/ops-migrations/0008_ethereum_profiles.sql', 'utf8'));
  const failures = { quoteWrite: false, publishWrite: false, deliveryRetirementAck: false, claimRetirementAck: false };
  const databaseCalls = { requests: 0, statements: 0, limit: Infinity, claimReads: 0, claimInserts: 0 };
  const commerce = createCommerceD1Harness({ observeCall: (operation) => {
    databaseCalls.requests++;
    databaseCalls.statements += operation.method === 'batch' ? operation.statements.length : 1;
    if (databaseCalls.statements > databaseCalls.limit) throw new Error('D1 invocation query limit exceeded');
    const queries = operation.method === 'batch' ? operation.statements.map((statement) => statement.sql) : [operation.sql];
    databaseCalls.claimReads += queries.filter((sql) => /SELECT \* FROM ethereum_crate_claims/.test(sql)).length;
    databaseCalls.claimInserts += queries.filter((sql) => /INSERT OR IGNORE INTO ethereum_crate_claims/.test(sql)).length;
    if (failures.quoteWrite && operation.method === 'run' && operation.sql.includes('INSERT OR IGNORE INTO ethereum_delivery_quotes')) {
      throw new Error('Injected quote persistence failure');
    }
    if (failures.publishWrite && operation.method === 'batch' && operation.statements.some(statement => statement.sql.includes('INSERT INTO commerce_documents'))) {
      throw new Error('Injected order publication failure');
    }
    if (failures.deliveryRetirementAck && operation.method === 'run' && operation.sql.includes('UPDATE ethereum_delivery_quotes SET transaction_hash = NULL')) {
      throw new Error('Injected delivery retirement acknowledgement failure');
    }
    if (failures.claimRetirementAck && operation.method === 'run' && operation.sql.includes('UPDATE ethereum_crate_claims SET transaction_hash = NULL')) {
      throw new Error('Injected claim retirement acknowledgement failure');
    }
  } });
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: EthereumEnvironment = {
    OPS_DB: d1Database(ops), COMMERCE_DB: commerce.db, ALCHEMY_MI_NOTE_API_KEY: 'test-alchemy-key',
    ETHEREUM_111K_CHAIN_ID: '31337', ETHEREUM_111K_CONTRACT_ADDRESS: CONTRACT,
    ETHEREUM_111K_RENDERER_ADDRESS: RENDERER, ETHEREUM_111K_DEPLOYMENT_BLOCK: '2',
    ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545', ETHEREUM_111K_SIGNER_SECRET: SIGNER_KEY,
    STAFF_AUTH_CHALLENGE_RATE_LIMITER: limiter, STAFF_AUTH_SESSION_RATE_LIMITER: limiter, PUBLIC_SHOP_RATE_LIMITER: limiter,
  };
  const state = {
    now: NOW, head: 102, blockTimestamp: null as number | null, rpcChainId: null as number | null,
    expectedSigner: SIGNER, contractCode: new Set<string>(), magic: '0x1626ba7e',
    tokens: new Map<string, Item>([['111112', { kind: 2, displayId: 1, owner: WALLET }],
      ['111113', { kind: 2, displayId: 2, owner: WALLET }], ['7', { kind: 1, displayId: 821, owner: WALLET }]]),
    receipts: new Map<string, EthereumReceipt>(), canonical: new Map<number, string>(),
    logs: [] as EthereumLog[], calls: [] as Rpc[], urls: [] as string[], usedOrders: new Set<number>(),
    alchemyNfts: [] as Record<string, unknown>[], alchemyCursor: null as string | null,
    afterRpc: null as ((payload: Rpc, result: unknown) => Promise<void>) | null,
  };
  const responseFor = async (payload: Rpc): Promise<unknown> => {
    state.calls.push(payload);
    const params = payload.params;
    if (payload.method === 'eth_chainId') return ethereumHexQuantity(state.rpcChainId ?? Number(env.ETHEREUM_111K_CHAIN_ID));
    if (payload.method === 'eth_getCode') return state.contractCode.has(String(params[0])) ? '0x60006000' : '0x';
    if (payload.method === 'eth_blockNumber') return ethereumHexQuantity(state.head);
    if (payload.method === 'eth_getBlockByNumber') {
      const number = params[0] === 'latest' ? state.head : Number(BigInt(String(params[0])));
      return { number: ethereumHexQuantity(number), hash: state.canonical.get(number) || blockHash(number),
        timestamp: ethereumHexQuantity(state.blockTimestamp ?? Math.floor(state.now / 1000)) };
    }
    if (payload.method === 'eth_getTransactionReceipt') return state.receipts.get(String(params[0])) || null;
    if (payload.method === 'eth_getLogs') {
      const filter = params[0] as { topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
      const firstTopic = filter.topics?.[0];
      return state.logs.filter(log => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock) &&
        (Array.isArray(firstTopic) ? firstTopic.includes(log.topics[0]) : !firstTopic || log.topics[0] === firstTopic));
    }
    if (payload.method === 'eth_call') {
      const call = params[0] as { to: string; data: string };
      const selector = call.data.slice(0, 10);
      const argumentsHex = `0x${call.data.slice(10)}`;
      if (selector === functionSelector('quoteSigner()')) return encodeAbi(['address'], [state.expectedSigner]);
      if (selector === functionSelector('usedDeliveryOrders(uint256)')) {
        const orderId = Number(decodeReturn(['uint256'], argumentsHex)[0]);
        const canonical = [...state.receipts.values()].some((receipt) => receipt.status === '0x1' &&
          receipt.blockHash === (state.canonical.get(Number(BigInt(receipt.blockNumber))) || blockHash(Number(BigInt(receipt.blockNumber)))) &&
          receipt.logs.some((log) => log.topics[0] === ETHEREUM_EVENT_TOPICS.DeliveryRedeemed && Number(BigInt(log.topics[1])) === orderId));
        return encodeAbi(['bool'], [state.usedOrders.has(orderId) || canonical]);
      }
      if (selector === functionSelector('usedClaims(bytes32)')) {
        const claimId = String(decodeReturn(['bytes32'], argumentsHex)[0]);
        const used = [...state.receipts.values()].some((receipt) => receipt.status === '0x1' &&
          receipt.blockHash === (state.canonical.get(Number(BigInt(receipt.blockNumber))) || blockHash(Number(BigInt(receipt.blockNumber)))) &&
          receipt.logs.some((log) => log.topics[0] === ETHEREUM_EVENT_TOPICS.CrateReceiptClaimed && log.topics[1] === claimId));
        return encodeAbi(['bool'], [used]);
      }
      if (selector === functionSelector('getTokenInfo(uint256)')) {
        const id = String(decodeReturn(['uint256'], argumentsHex)[0]);
        const item = state.tokens.get(id);
        return encodeAbi(['uint8', 'uint256', 'address'], item ? [item.kind, item.displayId, item.owner] : [0, 0, ZERO]);
      }
      if (selector === functionSelector('previewTokenURI(uint8,uint256)')) {
        const [kind, id] = decodeReturn(['uint8', 'uint256'], argumentsHex);
        const name = `Kind ${kind} #${id}`;
        const image = `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${name}</text></svg>`).toString('base64')}`;
        return encodeAbi(['string'], [`data:application/json;base64,${Buffer.from(JSON.stringify({ name, image })).toString('base64')}`]);
      }
      if (selector === functionSelector('isValidSignature(bytes32,bytes)')) return encodeAbi(['bytes4'], [state.magic]);
      if (selector === functionSelector('stats()')) return encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool'],
        [25, 2, 20, '100000000000000', '1100000000000000', true]);
    }
    throw new Error(`Unexpected mocked RPC: ${payload.method}`);
  };
  const providerFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    state.urls.push(url);
    if (url.includes('/getNFTsForOwner')) return Response.json({ ownedNfts: state.alchemyNfts,
      ...(state.alchemyCursor ? { pageKey: state.alchemyCursor } : {}) });
    const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
    const handle = async (entry: Rpc) => {
      const result = await responseFor(entry);
      await state.afterRpc?.(entry, result);
      return { jsonrpc: '2.0', id: entry.id, result };
    };
    const body = Array.isArray(payload) ? (await Promise.all(payload.map(handle))).reverse() : await handle(payload);
    return Response.json(body);
  };
  async function request<T = Record<string, unknown>>(pathWithQuery: string, body?: unknown, session?: string,
    options: { origin?: string; method?: string; csrf?: boolean; headers?: Record<string, string> } = {}) {
    const path = pathWithQuery.split('?')[0];
    const method = options.method || (readPaths.has(path) || path === paths.addresses && body === undefined ? 'GET' : 'POST');
    const request = new Request(`${ORIGIN}${pathWithQuery}`, { method, headers: {
      Origin: options.origin || ORIGIN, 'CF-Connecting-IP': '127.0.0.1', 'Content-Type': 'application/json',
      ...(options.csrf !== false ? { 'X-Mons-CSRF': '1' } : {}),
      ...(session ? { [ETHEREUM_SESSION_HEADER]: session } : {}), ...options.headers,
    }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
    const response = await handleEthereumRequest(request, env, path, { nowMs: () => state.now, fetch: providerFetch });
    return { response, body: await response.json() as T };
  }
  async function challenge(wallet = WALLET) {
    const result = await request<EthereumAuthChallenge>(paths.authChallenge, { dropId: '111k_devnet', address: wallet, chainId: Number(env.ETHEREUM_111K_CHAIN_ID) });
    assert.equal(result.response.status, 200);
    return result.body;
  }
  async function session(key = WALLET_KEY) {
    const proof = await challenge(ethereumSignerAddress(key));
    const result = await request<EthereumSession>(paths.authVerify, { challengeId: proof.challengeId,
      signature: signDigest(key, personalMessageHash(proof.message)) });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  async function saveAddress(token: string, id = ADDRESS_ID) {
    const result = await request(paths.addresses, { id, encrypted: 'encrypted-test-address', country: 'United States',
      hint: 'Test recipient, US', email: 'test@example.com' }, token);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return id;
  }
  async function prepared(tokenIds = ['111112'], requestId = REQUEST_ID) {
    const authentication = await session();
    await saveAddress(authentication.token);
    const result = await request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare,
      { tokenIds, addressId: ADDRESS_ID, requestId }, authentication.token);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return { authentication, prepared: result.body };
  }
  function setReceipt(hash: string, logs: EthereumLog[], block = 100) {
    state.receipts.set(hash, { transactionHash: hash, blockNumber: ethereumHexQuantity(block), blockHash: blockHash(block),
      status: '0x1', from: WALLET, to: CONTRACT, logs });
  }
  function deliveryLog(prepared: EthereumDeliveryPrepareResponse, ids = ['111112'], receipts = ['2000001'], hash = HASH): EthereumLog {
    return { address: CONTRACT, topics: [ETHEREUM_EVENT_TOPICS.DeliveryRedeemed,
      topicNumber(prepared.orderId), topicAddress(prepared.quote.wallet)],
    data: encodeAbi(['uint256', 'uint256[]', 'uint256[]'], [prepared.quote.fee, ids, receipts]),
    blockNumber: '0x64', blockHash: blockHash(100), transactionHash: hash, logIndex: '0x0' };
  }
  function claimLog(prepared: EthereumClaimPrepareResponse, ids = crateArtworkIds(1).map(id => String(1_000_000 + id)), hash = CLAIM_HASH): EthereumLog {
    return { address: CONTRACT, topics: [ETHEREUM_EVENT_TOPICS.CrateReceiptClaimed,
      prepared.claimId, topicAddress(WALLET), topicNumber(prepared.receiptId)],
    data: encodeAbi(['uint256[]'], [ids]), blockNumber: '0x64', blockHash: blockHash(100), transactionHash: hash, logIndex: '0x0' };
  }
  function quoteRow(orderId: number) { return commerce.database.prepare('SELECT * FROM ethereum_delivery_quotes WHERE order_id = ?').get(orderId)!; }
  function claimRow(receipt = '2000001') { return commerce.database.prepare('SELECT * FROM ethereum_crate_claims WHERE receipt_id = ?').get(receipt)!; }
  function order(orderId: number): Record<string, unknown> | null {
    const row = commerce.database.prepare("SELECT document_json FROM commerce_documents WHERE document_kind = 'delivery_order' AND drop_id = '111k_devnet' AND document_id = ?").get(String(orderId));
    return row ? JSON.parse(String(row.document_json)) : null;
  }
  async function confirmed() {
    const ready = await prepared();
    const log = deliveryLog(ready.prepared);
    setReceipt(HASH, [log]);
    state.logs = [log];
    state.tokens.delete('111112');
    state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
    const result = await request(paths.deliveryConfirm, { orderId: ready.prepared.orderId, transactionHash: HASH }, ready.authentication.token);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, 'confirmed');
    return ready;
  }
  return { env, ops, commerce, failures, databaseCalls, state, providerFetch, request, challenge, session, saveAddress, prepared,
    setReceipt, deliveryLog, claimLog, quoteRow, claimRow, order, confirmed,
    close: () => { ops.close(); commerce.database.close(); } };
}

function pauseRpc(f: ReturnType<typeof fixture>, matches: (payload: Rpc) => boolean) {
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  f.state.afterRpc = async (payload) => {
    if (!matches(payload)) return;
    f.state.afterRpc = null;
    reached();
    await released;
  };
  return { paused, resume };
}

function pauseCommerceBatch(f: ReturnType<typeof fixture>, matches: () => boolean) {
  const database = f.env.COMMERCE_DB;
  let resume!: () => void;
  let reached!: () => void;
  let waiting = true;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  const batch = async <T,>(statements: D1PreparedStatement[]) => {
    const result = await database.batch<T>(statements);
    if (waiting && matches()) {
      waiting = false;
      reached();
      await released;
    }
    return result;
  };
  f.env.COMMERCE_DB = new Proxy(database, { get(target, property, receiver) {
    return property === 'batch' ? batch : Reflect.get(target, property, receiver);
  } });
  return { paused, resume };
}

function pauseCommerceWrite(f: ReturnType<typeof fixture>, matches: () => boolean) {
  const database = f.env.COMMERCE_DB;
  let resume!: () => void;
  let reached!: () => void;
  let waiting = true;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { resume = resolve; });
  const batch = async <T,>(statements: D1PreparedStatement[]) => {
    if (waiting && matches() && statements.some((statement) =>
      (statement as unknown as { sql: string }).sql.includes('INSERT INTO commerce_documents'))) {
      waiting = false;
      reached();
      await released;
    }
    return database.batch<T>(statements);
  };
  f.env.COMMERCE_DB = new Proxy(database, { get(target, property, receiver) {
    return property === 'batch' ? batch : Reflect.get(target, property, receiver);
  } });
  return { paused, resume };
}

function orphanCrateDelivery(f: ReturnType<typeof fixture>) {
  f.state.receipts.delete(HASH);
  f.state.receipts.delete(CLAIM_HASH);
  f.state.logs = [];
  f.state.tokens.delete('2000001');
  f.state.tokens.set('111112', { kind: 2, displayId: 1, owner: WALLET });
}

async function confirmedCrateClaim(f: ReturnType<typeof fixture>) {
  const delivery = await f.confirmed();
  const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
    { receiptId: '2000001', code: f.claimRow().code }, delivery.authentication.token);
  assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
  const log = { ...f.claimLog(prepared.body), blockNumber: '0xc8', blockHash: blockHash(200) };
  f.setReceipt(CLAIM_HASH, [log], 200);
  f.state.logs.push(log);
  f.state.head = 202;
  const confirmed = await f.request(paths.claimConfirm,
    { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, delivery.authentication.token);
  assert.equal(confirmed.body.status, 'confirmed', JSON.stringify(confirmed.body));
  return { ...delivery, claim: prepared.body, log };
}

async function replaceCrateDelivery(f: ReturnType<typeof fixture>) {
  const next = await f.prepared(['111112'], '10000000-0000-4000-8000-000000000002');
  const hash = `0x${'cc'.repeat(32)}`;
  const log = f.deliveryLog(next.prepared, ['111112'], ['2000001'], hash);
  f.setReceipt(hash, [log]);
  f.state.logs = [log];
  f.state.tokens.delete('111112');
  f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
  const confirmed = await f.request(paths.deliveryConfirm,
    { orderId: next.prepared.orderId, transactionHash: hash }, next.authentication.token);
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.status, 'confirmed');
  return next;
}

for (const cancellation of ['deadline', 'client'] as const) {
  test(`111k incomplete request bodies stop on ${cancellation} cancellation`, { timeout: 1000 }, async (t) => {
    const f = fixture();
    const deadline = new AbortController();
    const client = new AbortController();
    t.after(() => client.abort());
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      assert.equal(milliseconds, 45_000);
      return deadline.signal;
    });
    const reason = new DOMException('Request cancelled', cancellation === 'deadline' ? 'TimeoutError' : 'AbortError');
    let cancelReason: unknown;
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"dropId":')); },
      pull() { reading(); },
      cancel(reason) { cancelReason = reason; },
    }, { highWaterMark: 0 });
    const request = new Request(`${ORIGIN}${paths.authChallenge}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' },
      body, signal: client.signal, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    try {
      const pending = handleEthereumRequest(request, f.env, paths.authChallenge);
      await started;
      (cancellation === 'deadline' ? deadline : client).abort(reason);
      if (cancellation === 'deadline') {
        const response = await pending;
        assert.equal(response.status, 503);
        assert.equal((await response.json() as { error: { code: string } }).error.code, 'unavailable');
        assert.equal(client.signal.aborted, false);
      } else {
        await assert.rejects(pending, (error: unknown) => error === reason);
      }
      assert.equal(cancelReason, reason);
      assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_challenges').get()!.n, 0);
      assert.equal(f.databaseCalls.requests, 0);
    } finally { f.close(); }
  });
}

test('111k EOA auth is one-use, chain/origin scoped, expires, and keeps shipping addresses isolated', async () => {
  const f = fixture();
  try {
    const proof = await f.challenge();
    assert.equal(proof.message.split('\n')[1], '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
    const input = { challengeId: proof.challengeId, signature: signDigest(WALLET_KEY, personalMessageHash(proof.message)) };
    const raced = await Promise.all([f.request<EthereumSession>(paths.authVerify, input), f.request<EthereumSession>(paths.authVerify, input)]);
    assert.deepEqual(raced.map(result => result.response.status).sort(), [200, 409]);
    const session = raced.find(result => result.response.status === 200)!.body;
    assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_sessions').get()!.n, 1);
    assert.equal((await f.request(paths.profile, undefined, session.token)).body.wallet, WALLET);
    assert.equal((await f.request(paths.profile, undefined, session.token, { origin: 'https://www.mons.shop' })).response.status, 401);
    f.env.ETHEREUM_111K_CHAIN_ID = '11155111';
    assert.equal((await f.request(paths.profile, undefined, session.token)).response.status, 401);
    f.env.ETHEREUM_111K_CHAIN_ID = '31337';
    await f.saveAddress(session.token);
    const other = await f.session(OTHER_KEY);
    assert.deepEqual((await f.request(paths.addresses, undefined, other.token)).body.addresses, []);
    const altered = await f.request(paths.addresses, { id: ADDRESS_ID, encrypted: 'changed', country: 'US', hint: 'Changed' }, session.token);
    assert.equal(altered.response.status, 409);
    const saved = (await f.request(paths.addresses, undefined, session.token)).body.addresses as Record<string, unknown>[];
    assert.equal(saved[0].encrypted, 'encrypted-test-address');
    f.state.now = session.expiresAtMs;
    assert.equal((await f.request(paths.profile, undefined, session.token)).response.status, 401);
  } finally { f.close(); }
});

test('disabled collections clean up expired Ethereum auth without accessing the chain', async () => {
  const f = fixture();
  try {
    f.env.ETHEREUM_111K_CONTRACT_ADDRESS = '';
    const session = await f.session();
    f.state.now = session.expiresAtMs;
    f.state.calls.length = 0;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_challenges').get()!.n, 0);
    assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_sessions').get()!.n, 0);
    assert.deepEqual(f.state.calls, []);
  } finally { f.close(); }
});

test('111k auth accepts ERC-1271 only for a deployed wallet returning its magic value', async () => {
  const f = fixture();
  try {
    const smartWallet = '0x4444444444444444444444444444444444444444';
    const proof = await f.challenge(smartWallet);
    const body = { challengeId: proof.challengeId, signature: '0x1234' };
    assert.equal((await f.request(paths.authVerify, body)).response.status, 401);
    f.state.contractCode.add(smartWallet);
    f.state.magic = '0xffffffff';
    assert.equal((await f.request(paths.authVerify, body)).response.status, 401);
    f.state.magic = '0x1626ba7e';
    const accepted = await f.request<EthereumSession>(paths.authVerify, body);
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.address, smartWallet);
    const checked = f.state.calls.filter(call => call.method === 'eth_call').at(-1)!;
    const call = checked.params[0] as { to: string; data: string };
    assert.equal(call.to, smartWallet);
    assert.deepEqual(decodeReturn(['bytes32', 'bytes'], `0x${call.data.slice(10)}`), [personalMessageHash(proof.message), '0x1234']);
  } finally { f.close(); }
});

test('111k auth and mutations reject missing CSRF, wrong origin, wrong chain, and rate exhaustion', async () => {
  const f = fixture();
  try {
    const body = { dropId: '111k_devnet', address: WALLET, chainId: 31337 };
    assert.equal((await f.request(paths.authChallenge, body, undefined, { csrf: false })).response.status, 403);
    assert.equal((await f.request(paths.authChallenge, body, undefined, { origin: 'https://evil.example' })).response.status, 403);
    assert.equal((await f.request(paths.authChallenge, { ...body, chainId: 1 })).response.status, 400);
    assert.equal((await f.request(paths.authChallenge, undefined, undefined, { method: 'GET' })).response.status, 405);
    f.env.STAFF_AUTH_CHALLENGE_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const denied = await f.request(paths.authChallenge, body);
    assert.equal(denied.response.status, 429);
    assert.equal(denied.response.headers.get('Retry-After'), '60');
    assert.equal(f.ops.prepare('SELECT COUNT(*) AS n FROM ethereum_auth_challenges').get()!.n, 0);
  } finally { f.close(); }
});

test('delivery preparation persists one immutable selection before returning a verifiable quote, including retries', async () => {
  const f = fixture();
  try {
    const session = await f.session();
    await f.saveAddress(session.token);
    const input = { tokenIds: ['111112', '7'], addressId: ADDRESS_ID, requestId: REQUEST_ID };
    const results = await Promise.all([f.request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare, input, session.token),
      f.request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare, input, session.token)]);
    assert.ok(results.every(result => result.response.status === 200), JSON.stringify(results.map(result => result.body)));
    assert.equal(results[0].body.orderId, results[1].body.orderId);
    assert.equal(results[0].body.signature, results[1].body.signature);
    const prepared = results[0].body;
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 1);
    const stored = f.quoteRow(prepared.orderId);
    assert.equal(stored.token_ids_json, JSON.stringify(input.tokenIds));
    assert.equal(JSON.parse(String(stored.address_json)).encrypted, 'encrypted-test-address');
    assert.equal(prepared.quote.receiptIdsHash, ethereumReceiptIdsHash(['2000001', '1000821']));
    assert.deepEqual(decodeReturn(['uint256[]', '(uint256,address,uint256,uint256,bytes32)', 'bytes'], `0x${prepared.transaction.data.slice(10)}`),
      [[111112n, 7n], [BigInt(prepared.orderId), WALLET, BigInt(prepared.quote.fee), BigInt(prepared.quote.deadline), prepared.quote.receiptIdsHash], prepared.signature]);
    assert.equal(recoverEthereumAddress(deliveryDigest({ ...prepared.quote, chainId: 31337, contractAddress: CONTRACT, tokenIds: input.tokenIds }), prepared.signature), SIGNER);
    assert.equal((await f.request(paths.deliveryPrepare, { ...input, tokenIds: ['111112'] }, session.token)).response.status, 409);
    f.state.now = prepared.expiresAtMs + 1000;
    const refreshed = await f.request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare, input, session.token);
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.body.orderId, prepared.orderId);
    assert.ok(refreshed.body.quote.deadline > prepared.quote.deadline);
    assert.notEqual(refreshed.body.signature, prepared.signature);
  } finally { f.close(); }
});

test('delivery retries reject changed artwork identities and require a fresh request bound to canonical receipts', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.prepared(['7']);
    const originalItems = f.quoteRow(prepared.orderId).items_json;
    f.state.tokens.get('7')!.displayId = 822;
    const input = { tokenIds: ['7'], addressId: ADDRESS_ID, requestId: REQUEST_ID };
    const rejected = await f.request(paths.deliveryPrepare, input, authentication.token);
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.signature, undefined);
    assert.equal(f.quoteRow(prepared.orderId).items_json, originalItems);
    const refreshed = await f.request<EthereumDeliveryPrepareResponse>(paths.deliveryPrepare,
      { ...input, requestId: '10000000-0000-4000-8000-000000000002' }, authentication.token);
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
    assert.notEqual(refreshed.body.orderId, prepared.orderId);
    assert.equal(refreshed.body.quote.receiptIdsHash, ethereumReceiptIdsHash(['1000822']));
    assert.notEqual(refreshed.body.quote.receiptIdsHash, prepared.quote.receiptIdsHash);
  } finally { f.close(); }
});

test('delivery preparation rejects unsafe selections and refuses to return a signature after persistence failure', async () => {
  const f = fixture();
  try {
    const session = await f.session();
    await f.saveAddress(session.token);
    f.state.tokens.set('116667', { kind: 3, displayId: 1, owner: WALLET });
    f.state.tokens.set('1000001', { kind: 4, displayId: 1, owner: WALLET });
    f.state.tokens.set('111114', { kind: 2, displayId: 3, owner: OTHER_WALLET });
    for (const tokenIds of [[], ['111112', '111112'], ['116667'], ['1000001'], ['111114'], ['9999999']]) {
      const result = await f.request(paths.deliveryPrepare, { tokenIds, addressId: ADDRESS_ID, requestId: crypto.randomUUID() }, session.token);
      assert.ok([400, 403].includes(result.response.status), JSON.stringify(result.body));
    }
    f.failures.quoteWrite = true;
    const failed = await f.request(paths.deliveryPrepare, { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: REQUEST_ID }, session.token);
    assert.equal(failed.response.status, 503);
    assert.equal(failed.body.signature, undefined);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 0);
    f.failures.quoteWrite = false;
    f.state.expectedSigner = OTHER_WALLET;
    assert.equal((await f.request(paths.deliveryPrepare, { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: REQUEST_ID }, session.token)).response.status, 503);
  } finally { f.close(); }
});

test('delivery and crate claim authorization deadlines stay within the contract window when the latest block lags by 12 seconds', async () => {
  const f = fixture();
  try {
    const now = Math.floor(f.state.now / 1000);
    const chainTime = now - 12;
    f.state.blockTimestamp = chainTime;
    const { authentication, prepared } = await f.confirmed();
    assert.equal(prepared.quote.deadline, chainTime + 600);
    assert.equal(prepared.expiresAtMs, (chainTime + 600) * 1000);
    assert.ok(prepared.quote.deadline > now);
    assert.ok(prepared.quote.deadline <= chainTime + 600);
    const claim = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: String(f.claimRow().code) }, authentication.token);
    assert.equal(claim.response.status, 200, JSON.stringify(claim.body));
    assert.equal(claim.body.deadline, chainTime + 600);
    assert.equal(claim.body.expiresAtMs, (chainTime + 600) * 1000);
    assert.ok(claim.body.deadline > now);
    assert.ok(claim.body.deadline <= chainTime + 600);
  } finally { f.close(); }
});

test('stale chain timestamps fail closed before delivery or crate claim signatures are returned', async () => {
  const f = fixture();
  try {
    const { authentication } = await f.confirmed();
    const code = String(f.claimRow().code);
    f.state.blockTimestamp = Math.floor(f.state.now / 1000) - 601;
    const delivery = await f.request(paths.deliveryPrepare, { tokenIds: ['111113'], addressId: ADDRESS_ID,
      requestId: '10000000-0000-4000-8000-000000000002' }, authentication.token);
    assert.equal(delivery.response.status, 503, JSON.stringify(delivery.body));
    assert.equal(delivery.body.signature, undefined);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 1);
    const claim = await f.request(paths.claimPrepare, { receiptId: '2000001', code }, authentication.token);
    assert.equal(claim.response.status, 503, JSON.stringify(claim.body));
    assert.equal(claim.body.signature, undefined);
    assert.equal(f.claimRow().status, 'available');
    assert.equal(f.claimRow().code, code);
  } finally { f.close(); }
});

test('delivery confirmation requires the exact contract event and three canonical confirmations before publishing', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.prepared();
    const confirm = () => f.request(paths.deliveryConfirm, { orderId: prepared.orderId, transactionHash: HASH }, authentication.token);
    const log = f.deliveryLog(prepared);
    f.setReceipt(HASH, [{ ...log, address: OTHER_CONTRACT }]);
    assert.equal((await confirm()).response.status, 403);
    assert.equal(f.quoteRow(prepared.orderId).transaction_hash, null);
    f.setReceipt(HASH, [f.deliveryLog(prepared, ['111113'])]);
    assert.equal((await confirm()).response.status, 403);
    f.setReceipt(HASH, [log]);
    f.state.canonical.set(100, blockHash(999));
    assert.deepEqual((await confirm()).body, { status: 'pending', confirmations: 0, orderId: prepared.orderId });
    f.state.canonical.delete(100);
    f.state.head = 100;
    assert.equal((await confirm()).body.status, 'pending');
    assert.equal(f.order(prepared.orderId), null);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_crate_claims').get()!.n, 0);
    f.state.head = 102;
    assert.equal((await confirm()).body.status, 'confirmed');
    const order = f.order(prepared.orderId)!;
    assert.equal(order.status, 'ready_to_ship');
    assert.equal(order.testnet, true);
    assert.equal(order.source, 'ethereum');
    assert.equal(order.owner, WALLET);
    const code = String(f.claimRow().code);
    assert.match(code, /^[A-F0-9]{12}$/);
    assert.equal((await confirm()).body.status, 'confirmed');
    assert.equal(f.claimRow().code, code);
    assert.equal(f.commerce.database.prepare("SELECT COUNT(*) AS n FROM commerce_documents WHERE document_kind = 'delivery_order'").get()!.n, 1);
  } finally { f.close(); }
});

test('an orphaned failed receipt stays pending until its transaction is observed in the canonical chain', async () => {
  const f = fixture();
  try {
    f.setReceipt(HASH, []);
    f.state.receipts.get(HASH)!.status = '0x0';
    f.state.canonical.set(100, blockHash(999));
    const orphaned = await f.request(paths.transactionsConfirm, { transactionHash: HASH });
    assert.equal(orphaned.response.status, 200, JSON.stringify(orphaned.body));
    assert.equal(orphaned.body.status, 'pending');
    assert.equal(orphaned.body.confirmations, 0);
    f.state.canonical.delete(100);
    const reverted = await f.request(paths.transactionsConfirm, { transactionHash: HASH });
    assert.equal(reverted.response.status, 409);
    assert.equal((reverted.body.error as { details?: { kind?: string } }).details?.kind, 'transaction-reverted');
  } finally { f.close(); }
});

test('confirmed deliveries recover a failed publication through durable reconciliation without regenerating codes', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.prepared();
    const log = f.deliveryLog(prepared);
    f.setReceipt(HASH, [log]);
    f.state.logs = [log];
    f.failures.publishWrite = true;
    const failed = await f.request(paths.deliveryConfirm, { orderId: prepared.orderId, transactionHash: HASH }, authentication.token);
    assert.equal(failed.response.status, 503);
    assert.equal(f.quoteRow(prepared.orderId).status, 'confirmed');
    assert.equal(f.quoteRow(prepared.orderId).published_at_ms, null);
    const code = f.claimRow().code;
    f.failures.publishWrite = false;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.claimRow().code, code);
    assert.equal(f.quoteRow(prepared.orderId).published_at_ms, NOW);
  } finally { f.close(); }
});

test('large crate orders reconcile within each invocation budget and reuse existing claim identities', async () => {
  const f = fixture();
  try {
    f.state.head = 80;
    const orders: { orderId: number; hash: string; tokenIds: string[] }[] = [];
    for (let index = 0; index < 10; index++) {
      const ids = Array.from({ length: 50 }, (_, offset) => 1 + index * 50 + offset);
      const tokenIds = ids.map((id) => String(111111 + id));
      ids.forEach((id, offset) => f.state.tokens.set(tokenIds[offset], { kind: 2, displayId: id, owner: WALLET }));
      const { prepared } = await f.prepared(tokenIds, crypto.randomUUID());
      const hash = blockHash(50_000 + index);
      const block = 100 + index;
      const log = { ...f.deliveryLog(prepared, tokenIds, ids.map((id) => String(2_000_000 + id)), hash),
        blockNumber: ethereumHexQuantity(block), blockHash: blockHash(block) };
      f.setReceipt(hash, [log], block);
      f.state.logs.push(log);
      orders.push({ orderId: prepared.orderId, hash, tokenIds });
    }
    f.state.head = 112;
    f.databaseCalls.limit = 1000;
    let published = 0;
    let limited = false;
    for (let attempt = 0; attempt < 10 && published < orders.length; attempt++) {
      f.databaseCalls.requests = 0;
      f.databaseCalls.statements = 0;
      const result = await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.ok(f.databaseCalls.statements <= 400, `Reconciliation used ${f.databaseCalls.statements} queries`);
      limited ||= result.hasMore === true;
      const next = orders.filter((order) => f.order(order.orderId)?.status === 'ready_to_ship').length;
      assert.ok(next > published, 'Each invocation must publish another order');
      published = next;
      f.state.now++;
    }
    assert.equal(published, orders.length);
    assert.equal(limited, true);
    const originalClaims = f.commerce.database.prepare('SELECT receipt_id, code, claim_id FROM ethereum_crate_claims ORDER BY receipt_id').all();
    assert.equal(originalClaims.length, 500);
    const session = await f.session();
    f.databaseCalls.limit = Infinity;
    Object.assign(f.databaseCalls, { requests: 0, statements: 0, claimReads: 0, claimInserts: 0 });
    const confirmed = await f.request(paths.deliveryConfirm, { orderId: orders[0].orderId, transactionHash: orders[0].hash }, session.token);
    assert.equal(confirmed.body.status, 'confirmed');
    assert.equal(f.databaseCalls.claimInserts, 0);
    assert.ok(f.databaseCalls.claimReads <= 2, 'Existing crate claims must be read together');
    assert.ok(f.databaseCalls.requests < 20);
    assert.deepEqual(f.commerce.database.prepare('SELECT receipt_id, code, claim_id FROM ethereum_crate_claims ORDER BY receipt_id').all(), originalClaims);
  } finally { f.close(); }
});

test('repeated confirmation preserves fulfillment progress and reconciles orphaned deliveries back to processing', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.confirmed();
    const repository = new D1CommerceRepository(f.env.COMMERCE_DB);
    await repository.run(NOW, async transaction => { await transaction.update(commerceKeys.deliveryOrder('111k_devnet', String(prepared.orderId)), { status: 'shipped' }); });
    const result = await f.request(paths.deliveryConfirm, { orderId: prepared.orderId, transactionHash: HASH }, authentication.token);
    assert.equal(result.response.status, 200);
    assert.equal(f.order(prepared.orderId)!.status, 'shipped');
    f.state.receipts.delete(HASH);
    f.state.logs = [];
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(prepared.orderId).status, 'prepared');
    assert.equal(f.order(prepared.orderId)!.status, 'processing');
  } finally { f.close(); }
});

for (const kind of ['delivery', 'claim'] as const) {
  test(`untouched orphaned ${kind} backlogs remain eligible after the recent-block window`, async () => {
    const f = fixture();
    try {
      const { prepared } = await f.prepared(['7']);
      const source = f.quoteRow(prepared.orderId);
      const insertDelivery = f.commerce.database.prepare(`INSERT INTO ethereum_delivery_quotes
        (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json,
          items_json, fee_wei, deadline, status, transaction_hash, block_number, block_hash, published_at_ms,
          verified_at_block, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)`);
      const insertClaim = f.commerce.database.prepare(`INSERT INTO ethereum_crate_claims
        (chain_id, contract_address, receipt_id, crate_id, order_id, code_hash, code, claim_id, status,
          transaction_hash, block_number, block_hash, verified_at_block, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, 100, ?, 102, ?)`);
      const repository = new D1CommerceRepository(f.env.COMMERCE_DB);
      for (let index = 0; index < 61; index++) {
        const orderId = 10_000 + index;
        const hash = `0x${(index + 1).toString(16).padStart(64, '0')}`;
        const code = `CODE${index}`;
        insertDelivery.run(31337, CONTRACT, orderId, crypto.randomUUID(), WALLET, ADDRESS_ID, source.address_json,
          source.token_ids_json, source.items_json, source.fee_wei, source.deadline, hash,
          kind === 'delivery' ? 100 : 10, blockHash(kind === 'delivery' ? 100 : 10), NOW,
          kind === 'delivery' ? 102 : 100, NOW, NOW);
        if (kind === 'claim') {
          insertClaim.run(31337, CONTRACT, String(2_000_001 + index), index + 1,
            orderId, hash, code, hash, hash, blockHash(100), NOW);
          f.state.tokens.set(String(2_000_001 + index), { kind: 5, displayId: index + 1, owner: WALLET });
        }
        await repository.run(NOW, async (unit) => {
          await unit.create(commerceKeys.deliveryOrder('111k_devnet', String(orderId)), {
            source: 'ethereum', owner: WALLET, contractAddress: CONTRACT, status: 'ready_to_ship',
            irlClaims: kind === 'claim' ? [{ code, boxId: index + 1, status: 'claimed' }] : [],
          });
        });
      }
      const table = kind === 'delivery' ? 'ethereum_delivery_quotes' : 'ethereum_crate_claims';
      const status = kind === 'delivery' ? 'confirmed' : 'claimed';
      let remaining = 61;
      for (let attempt = 0; attempt < 10 && remaining; attempt++) {
        f.state.head = 127 + attempt * 25;
        f.state.now += 300_000;
        f.databaseCalls.statements = 0;
        await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
        const next = Number(f.commerce.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = ?`).get(status)!.n);
        assert.ok(next < remaining, 'Unfinished recovery must keep advancing after the reorg window');
        assert.ok(f.databaseCalls.statements <= 400);
        remaining = next;
      }
      assert.equal(remaining, 0);
      for (let index = 0; index < 61; index++) {
        const order = f.order(10_000 + index)!;
        if (kind === 'delivery') assert.equal(order.status, 'processing');
        else assert.equal((order.irlClaims as Record<string, unknown>[])[0].status, 'available');
      }
    } finally { f.close(); }
  });
}

test('a re-mined delivery loses fulfillment readiness until it regains three confirmations', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    const moved = { ...f.deliveryLog(first.prepared), blockNumber: '0x67', blockHash: blockHash(103) };
    f.setReceipt(HASH, [moved], 103);
    f.state.logs = [moved];
    f.state.head = 103;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'pending');
    assert.equal(f.quoteRow(first.prepared.orderId).published_at_ms, null);
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.deepEqual(f.claimRow(), claim);
    f.state.head = 105;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
  } finally { f.close(); }
});

test('a re-mined claim projects pending until three confirmations and recovers a failed projection', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const originalClaim = f.claimRow();
    const moved = { ...first.log, blockNumber: '0xcb', blockHash: blockHash(203) };
    f.state.canonical.set(200, blockHash(10_200));
    f.setReceipt(CLAIM_HASH, [moved], 203);
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH).concat(moved);
    f.state.head = 203;
    f.failures.publishWrite = true;
    await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
      { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
    assert.equal(f.claimRow().status, 'pending');
    assert.equal(f.claimRow().verified_at_block, null);
    f.failures.publishWrite = false;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'pending');
    assert.equal(f.claimRow().code, originalClaim.code);
    assert.equal(f.claimRow().claim_id, originalClaim.claim_id);
    f.state.head = 205;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().status, 'claimed');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('a pending claim projection cannot overwrite a concurrent reconfirmation', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const moved = { ...first.log, blockNumber: '0xcb', blockHash: blockHash(203) };
    f.state.canonical.set(200, blockHash(10_200));
    f.setReceipt(CLAIM_HASH, [moved], 203);
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH).concat(moved);
    f.state.head = 203;
    const barrier = pauseCommerceWrite(f, () => f.claimRow().status === 'pending');
    const pending = f.request(paths.claimConfirm, { claimId: first.claim.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    await barrier.paused;
    f.state.head = 205;
    const confirmed = await f.request(paths.claimConfirm, { claimId: first.claim.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    assert.equal(confirmed.body.status, 'confirmed');
    const canonical = f.claimRow();
    barrier.resume();
    assert.equal((await pending).response.status, 503);
    assert.deepEqual(f.claimRow(), canonical);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('a failed pending-delivery projection is retried and preserves the original claim identity', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    const moved = { ...f.deliveryLog(first.prepared), blockNumber: '0x67', blockHash: blockHash(103) };
    f.setReceipt(HASH, [moved], 103);
    f.state.logs = [moved];
    f.state.head = 103;
    f.failures.publishWrite = true;
    await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
      { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'pending');
    assert.equal(f.quoteRow(first.prepared.orderId).published_at_ms, null);
    assert.equal(f.quoteRow(first.prepared.orderId).verified_at_block, null);
    f.failures.publishWrite = false;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.deepEqual(f.claimRow(), claim);
    f.state.head = 200;
    f.failures.publishWrite = true;
    await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
      { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
    assert.equal(f.quoteRow(first.prepared.orderId).verified_at_block, null);
    f.failures.publishWrite = false;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.quoteRow(first.prepared.orderId).verified_at_block, 200);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
  } finally { f.close(); }
});

test('an old claimed receipt stays eligible until its failed projection is acknowledged', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    f.state.head = 300;
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, first.authentication.token);
    assert.equal(prepared.response.status, 200);
    const log = { ...f.claimLog(prepared.body), blockNumber: '0xc8', blockHash: blockHash(200) };
    f.setReceipt(CLAIM_HASH, [log], 200);
    f.failures.publishWrite = true;
    const failed = await f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    assert.equal(failed.response.status, 503);
    assert.equal(f.claimRow().status, 'claimed');
    assert.equal(f.claimRow().verified_at_block, null);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    f.commerce.database.prepare(`INSERT INTO ethereum_reconciliation_cursor (chain_id, contract_address, next_block)
      VALUES (?, ?, 301)`).run(31337, CONTRACT);
    f.failures.publishWrite = false;
    f.state.head = 400;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().verified_at_block, 400);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('retirement cannot commit over a canonical reconfirmation that leaves the order unchanged', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    orphanCrateDelivery(f);
    f.state.head = 164;
    const barrier = pauseCommerceWrite(f, () => f.quoteRow(first.prepared.orderId).status === 'prepared');
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    const moved = { ...f.deliveryLog(first.prepared), blockNumber: '0x65', blockHash: blockHash(101) };
    f.setReceipt(HASH, [moved], 101);
    f.state.logs = [moved];
    const reconfirmed = await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token);
    assert.equal(reconfirmed.body.status, 'confirmed');
    barrier.resume();
    const result = await reconciliation;
    assert.ok(result.deferred > 0);
    assert.equal(result.failed, 0);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'confirmed');
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
    f.state.head = 189;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
  } finally { f.close(); }
});

for (const failure of ['publishWrite', 'deliveryRetirementAck'] as const) {
  test(`delivery retirement survives ${failure} and retries beyond the recent-block window`, async () => {
    const f = fixture();
    try {
      const first = await f.confirmed();
      const originalClaim = f.claimRow();
      orphanCrateDelivery(f);
      f.failures[failure] = true;
      await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
        { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
      const retired = f.quoteRow(first.prepared.orderId);
      assert.equal(retired.status, 'prepared');
      assert.equal(retired.transaction_hash, HASH);
      assert.equal(retired.block_hash, blockHash(100));
      assert.equal(retired.block_number, 100);
      assert.equal(retired.published_at_ms, null);
      assert.equal(f.order(first.prepared.orderId)!.status, failure === 'publishWrite' ? 'ready_to_ship' : 'processing');
      f.failures[failure] = false;
      f.state.head = 300;
      f.state.now += 2_400_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, null);
      assert.equal(f.quoteRow(first.prepared.orderId).block_hash, null);
      assert.equal(f.quoteRow(first.prepared.orderId).block_number, null);
      assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
      assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
      assert.deepEqual(f.claimRow(), originalClaim);
    } finally { f.close(); }
  });
}

for (const failure of ['publishWrite', 'claimRetirementAck'] as const) {
  test(`claim retirement survives ${failure} and retries beyond the recent-block window`, async () => {
    const f = fixture();
    try {
      const first = await confirmedCrateClaim(f);
      const originalClaim = f.claimRow();
      f.state.receipts.delete(CLAIM_HASH);
      f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
      f.failures[failure] = true;
      await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000),
        { fetch: f.providerFetch, nowMs: () => f.state.now }), /Injected/);
      assert.equal(f.claimRow().status, 'available');
      assert.equal(f.claimRow().transaction_hash, CLAIM_HASH);
      assert.equal(f.claimRow().block_hash, blockHash(200));
      assert.equal(f.claimRow().block_number, 200);
      assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status,
        failure === 'publishWrite' ? 'claimed' : 'available');
      f.failures[failure] = false;
      f.state.head = 400;
      f.state.now += 2_400_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      const claim = f.claimRow();
      assert.equal(claim.status, 'available');
      assert.equal(claim.transaction_hash, null);
      assert.equal(claim.block_hash, null);
      assert.equal(claim.block_number, null);
      assert.equal(claim.claim_id, originalClaim.claim_id);
      assert.equal(claim.code, originalClaim.code);
      assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    } finally { f.close(); }
  });
}

test('a delivery retirement acknowledgement cannot clear a concurrent canonical reconfirmation', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    orphanCrateDelivery(f);
    const barrier = pauseCommerceBatch(f, () => f.order(first.prepared.orderId)?.status === 'processing');
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, HASH);
    f.setReceipt(HASH, [f.deliveryLog(first.prepared)]);
    const reconfirmed = await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token);
    assert.equal(reconfirmed.body.status, 'confirmed');
    const canonical = f.quoteRow(first.prepared.orderId);
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.quoteRow(first.prepared.orderId), canonical);
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, originalClaim.code);
  } finally { f.close(); }
});

test('a claim retirement acknowledgement cannot clear a concurrent canonical reconfirmation', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    f.state.receipts.delete(CLAIM_HASH);
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    const barrier = pauseCommerceBatch(f, () =>
      (f.order(first.prepared.orderId)?.irlClaims as Record<string, unknown>[])[0].status === 'available');
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    assert.equal(f.claimRow().transaction_hash, CLAIM_HASH);
    f.setReceipt(CLAIM_HASH, [first.log], 200);
    const reconfirmed = await f.request(paths.claimConfirm,
      { claimId: first.claim.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    assert.equal(reconfirmed.body.status, 'confirmed');
    const canonical = f.claimRow();
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.claimRow(), canonical);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('replacement delivery retries a failed old-order retirement without losing claim identity fences', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    orphanCrateDelivery(f);
    const next = await f.prepared(['111112'], '10000000-0000-4000-8000-000000000002');
    const hash = `0x${'cc'.repeat(32)}`;
    const log = f.deliveryLog(next.prepared, ['111112'], ['2000001'], hash);
    f.setReceipt(hash, [log]);
    f.state.logs = [log];
    f.failures.publishWrite = true;
    const failed = await f.request(paths.deliveryConfirm,
      { orderId: next.prepared.orderId, transactionHash: hash }, next.authentication.token);
    assert.equal(failed.response.status, 503);
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, HASH);
    assert.deepEqual(f.claimRow(), originalClaim);
    assert.equal(f.order(next.prepared.orderId), null);
    f.failures.publishWrite = false;
    f.state.head = 300;
    f.state.now += 2_400_000;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, null);
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.equal(f.order(next.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.claimRow().order_id, next.prepared.orderId);
    assert.notEqual(f.claimRow().claim_id, originalClaim.claim_id);
    assert.notEqual(f.claimRow().code, originalClaim.code);
  } finally { f.close(); }
});

for (const status of ['0x0', '0x1']) test(`a re-mined delivery with outer status ${status} and no delivery event is retired without blocking discovery`, async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    f.state.canonical.set(100, blockHash(10_100));
    orphanCrateDelivery(f);
    f.state.now = first.prepared.expiresAtMs + 1000;
    f.setReceipt(HASH, [], 101);
    Object.assign(f.state.receipts.get(HASH)!, { status, to: WALLET, from: OTHER_WALLET });
    const second = await f.prepared(['111113'], '10000000-0000-4000-8000-000000000002');
    const secondHash = `0x${'cc'.repeat(32)}`;
    const secondLog = { ...f.deliveryLog(second.prepared, ['111113'], ['2000002'], secondHash),
      blockNumber: '0x67', blockHash: blockHash(103) };
    f.setReceipt(secondHash, [secondLog], 103);
    f.state.head = 105;
    f.state.logs = [secondLog];
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'prepared');
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, null);
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.deepEqual(f.claimRow(), originalClaim);
    assert.equal(f.quoteRow(second.prepared.orderId).status, 'confirmed');
    assert.equal(f.order(second.prepared.orderId)!.status, 'ready_to_ship');
    const secondOrder = f.order(second.prepared.orderId);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.deepEqual(f.order(second.prepared.orderId), secondOrder);
  } finally { f.close(); }
});

test('a re-mined successful wrapper without its claim event restores the code and still discovers other orders', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const originalClaim = f.claimRow();
    f.state.canonical.set(200, blockHash(10_200));
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: OTHER_WALLET });
    f.setReceipt(CLAIM_HASH, [], 201);
    Object.assign(f.state.receipts.get(CLAIM_HASH)!, { to: WALLET, from: OTHER_WALLET });
    const second = await f.prepared(['111113'], '10000000-0000-4000-8000-000000000002');
    const secondHash = `0x${'cc'.repeat(32)}`;
    const secondLog = { ...f.deliveryLog(second.prepared, ['111113'], ['2000002'], secondHash),
      blockNumber: '0xcb', blockHash: blockHash(203) };
    f.setReceipt(secondHash, [secondLog], 203);
    f.state.logs.push(secondLog);
    f.state.head = 205;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().status, 'available');
    assert.equal(f.claimRow().transaction_hash, null);
    assert.equal(f.claimRow().code, originalClaim.code);
    assert.equal(f.claimRow().claim_id, originalClaim.claim_id);
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    assert.equal(f.order(second.prepared.orderId)!.status, 'ready_to_ship');
    const claim = f.claimRow();
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.deepEqual(f.claimRow(), claim);
  } finally { f.close(); }
});

test('a missing delivery event preserves an order completed through another canonical transaction', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const originalClaim = f.claimRow();
    const replacementHash = `0x${'cc'.repeat(32)}`;
    const replacementLog = { ...f.deliveryLog(first.prepared, ['111112'], ['2000001'], replacementHash),
      blockNumber: '0x67', blockHash: blockHash(103) };
    f.state.canonical.set(100, blockHash(10_100));
    f.setReceipt(HASH, [], 101);
    f.setReceipt(replacementHash, [replacementLog], 103);
    f.state.head = 105;
    f.state.logs = [];
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, HASH);
    assert.deepEqual(f.claimRow(), originalClaim);
    f.state.logs = [replacementLog];
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(first.prepared.orderId).transaction_hash, replacementHash);
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.deepEqual(f.claimRow(), originalClaim);
  } finally { f.close(); }
});

for (const changedClaimId of [false, true]) test(`a missing claim event preserves a canonical replacement with ${changedClaimId ? 'another' : 'the same'} claim ID`, async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const originalClaim = f.claimRow();
    const replacementHash = `0x${'cc'.repeat(32)}`;
    const claimId = changedClaimId ? `0x${'dd'.repeat(32)}` : first.claim.claimId;
    const replacementLog = { ...f.claimLog({ ...first.claim, claimId }, undefined, replacementHash),
      blockNumber: '0xcb', blockHash: blockHash(203) };
    f.state.canonical.set(200, blockHash(10_200));
    f.setReceipt(CLAIM_HASH, [], 201);
    f.setReceipt(replacementHash, [replacementLog], 203);
    f.state.tokens.delete('2000001');
    f.state.head = 205;
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.deepEqual({ ...f.claimRow() }, { ...originalClaim, updated_at_ms: Math.max(Number(originalClaim.updated_at_ms) + 1, f.state.now) });
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
    f.state.logs.push(replacementLog);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().transaction_hash, replacementHash);
    assert.equal(f.claimRow().claim_id, claimId);
    assert.equal(f.claimRow().code, originalClaim.code);
    assert.equal(f.claimRow().status, 'claimed');
  } finally { f.close(); }
});

for (const oldReceipt of ['missing', 'reverted'] as const) {
  for (const changedClaimId of [false, true]) {
    test(`${oldReceipt} claim receipts preserve ${changedClaimId ? 'another' : 'the same'} canonical claim ID while discovery catches up`, async () => {
      const f = fixture();
      try {
        const first = await confirmedCrateClaim(f);
        const originalLog = { ...first.log, blockNumber: '0x1388', blockHash: blockHash(5000) };
        f.setReceipt(CLAIM_HASH, [originalLog], 5000);
        f.state.head = 5002;
        assert.equal((await f.request(paths.claimConfirm,
          { claimId: first.claim.claimId, transactionHash: CLAIM_HASH }, first.authentication.token)).body.status, 'confirmed');
        const original = f.claimRow();
        f.state.canonical.set(5000, blockHash(15_000));
        f.state.receipts.delete(CLAIM_HASH);
        if (oldReceipt === 'reverted') {
          f.setReceipt(CLAIM_HASH, [], 5001);
          f.state.receipts.get(CLAIM_HASH)!.status = '0x0';
        }
        const replacementHash = blockHash(50_000);
        const claimId = changedClaimId ? blockHash(60_000) : first.claim.claimId;
        const replacementLog = { ...f.claimLog({ ...first.claim, claimId }, undefined, replacementHash),
          blockNumber: '0x138b', blockHash: blockHash(5003) };
        f.setReceipt(replacementHash, [replacementLog], 5003);
        f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH).concat(replacementLog);
        f.state.tokens.delete('2000001');
        f.state.head = 5005;
        for (let pass = 0; pass < 3; pass++) {
          await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
          assert.equal(f.claimRow().status, 'claimed');
          assert.equal(f.claimRow().code, original.code);
          assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
          if (pass < 2) assert.equal(f.claimRow().transaction_hash, CLAIM_HASH);
        }
        assert.equal(f.claimRow().transaction_hash, replacementHash);
        assert.equal(f.claimRow().claim_id, claimId);
      } finally { f.close(); }
    });
  }
}

test('deferred deliveries rotate so later orphaned orders can be retired', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const original = f.quoteRow(first.prepared.orderId);
    f.commerce.database.prepare('DELETE FROM ethereum_crate_claims').run();
    f.commerce.database.prepare('DELETE FROM ethereum_delivery_quotes').run();
    f.state.receipts.clear();
    f.state.logs = [];
    for (let index = 0; index < 21; index++) {
      const row = { ...original, order_id: 10_000 + index, request_id: crypto.randomUUID(),
        transaction_hash: blockHash(50_000 + index), created_at_ms: NOW - 2000, published_at_ms: NOW - 1000,
        updated_at_ms: NOW - 1000 + index };
      f.commerce.database.prepare(`INSERT INTO ethereum_delivery_quotes (${Object.keys(row).join(',')})
        VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      if (index < 20) f.state.usedOrders.add(row.order_id);
      await new D1CommerceRepository(f.env.COMMERCE_DB).run(NOW, async (unit) => {
        await unit.create(commerceKeys.deliveryOrder('111k_devnet', String(row.order_id)), {
          source: 'ethereum', owner: WALLET, contractAddress: CONTRACT, status: 'ready_to_ship', irlClaims: [],
        });
      });
    }
    const deferred = f.quoteRow(10_000);
    for (let attempt = 0; attempt < 4; attempt++) {
      f.state.head = 205 + attempt * 25;
      f.state.now += 300_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.order(10_000)!.status, 'ready_to_ship');
    }
    const { updated_at_ms, ...unchanged } = f.quoteRow(10_000);
    assert.deepEqual(unchanged, Object.fromEntries(Object.entries(deferred).filter(([key]) => key !== 'updated_at_ms')));
    assert.ok(Number(updated_at_ms) > Number(deferred.updated_at_ms));
    assert.equal(f.quoteRow(10_020).transaction_hash, null);
    assert.equal(f.order(10_020)!.status, 'processing');
  } finally { f.close(); }
});

test('deferred delivery rotation cannot overwrite a concurrent canonical confirmation', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    f.state.receipts.delete(HASH);
    f.state.logs = [];
    f.state.usedOrders.add(first.prepared.orderId);
    const barrier = pauseRpc(f, (rpc) => rpc.method === 'eth_call' &&
      String((rpc.params[0] as { data: string }).data).startsWith(functionSelector('usedDeliveryOrders(uint256)')));
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    const replacementHash = blockHash(50_000);
    const replacementLog = f.deliveryLog(first.prepared, ['111112'], ['2000001'], replacementHash);
    f.setReceipt(replacementHash, [replacementLog]);
    const confirmed = await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: replacementHash }, first.authentication.token);
    assert.equal(confirmed.body.status, 'confirmed');
    const canonical = f.quoteRow(first.prepared.orderId);
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.quoteRow(first.prepared.orderId), canonical);
  } finally { f.close(); }
});

test('deferred claims rotate so newer orphaned claims can recover', async () => {
  const f = fixture();
  try {
    const current = await confirmedCrateClaim(f);
    const originalClaim = f.claimRow();
    const oldOrderId = current.prepared.orderId === 2147483647 ? 1 : current.prepared.orderId + 1;
    const oldParent = { ...f.quoteRow(current.prepared.orderId), order_id: oldOrderId,
      request_id: crypto.randomUUID(), transaction_hash: `0x${'dd'.repeat(32)}`,
      block_number: 180, block_hash: blockHash(180), verified_at_block: 192,
      created_at_ms: NOW - 2000, published_at_ms: NOW - 1000, updated_at_ms: NOW - 1000,
      token_ids_json: JSON.stringify(Array.from({ length: 20 }, (_, i) => String(111113 + i))),
      items_json: JSON.stringify(Array.from({ length: 20 }, (_, i) =>
        ({ tokenId: String(111113 + i), kind: 'crate', displayId: i + 2, owner: WALLET }))),
    };
    f.commerce.database.prepare(`INSERT INTO ethereum_delivery_quotes (${Object.keys(oldParent).join(',')})
      VALUES (${Object.keys(oldParent).map(() => '?').join(',')})`).run(...Object.values(oldParent));
    await new D1CommerceRepository(f.env.COMMERCE_DB).run(NOW, async (unit) => {
      await unit.create(commerceKeys.deliveryOrder('111k_devnet', String(oldOrderId)), {
        source: 'ethereum', owner: WALLET, contractAddress: CONTRACT, status: 'ready_to_ship',
        irlClaims: Array.from({ length: 20 }, (_, i) => ({ boxId: i + 2, code: `CODE${i + 2}`, status: 'claimed' })),
      });
    });
    const wrapperHash = `0x${'cc'.repeat(32)}`;
    f.setReceipt(wrapperHash, [], 201);
    const insertClaim = f.commerce.database.prepare(`INSERT INTO ethereum_crate_claims
      (chain_id, contract_address, receipt_id, crate_id, order_id, code_hash, code, claim_id, status,
       transaction_hash, block_number, block_hash, verified_at_block, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, 190, ?, 192, ?)`);
    for (let i = 2; i <= 21; i++) insertClaim.run(31337, CONTRACT, String(2_000_000 + i), i, oldOrderId,
      `codehash${i}`, `CODE${i}`, `0x${i.toString(16).padStart(64, '0')}`, wrapperHash, blockHash(190), NOW - 1000);
    const deferred = f.claimRow('2000002');
    f.state.receipts.delete(CLAIM_HASH);
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
    f.commerce.database.prepare('INSERT INTO ethereum_reconciliation_cursor VALUES (?, ?, ?)').run(31337, CONTRACT, 203);
    for (let attempt = 0; attempt < 3; attempt++) {
      f.state.head = 205 + attempt * 25;
      f.state.now += 300_000;
      f.state.calls.length = 0;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      if (!attempt) {
        assert.equal(f.claimRow().status, 'claimed');
        assert.deepEqual({ ...f.claimRow('2000002') }, { ...deferred, updated_at_ms: f.state.now });
      } else {
        assert.equal(f.claimRow().status, 'available');
        assert.equal(f.claimRow().transaction_hash, null);
        assert.equal(f.claimRow().code, originalClaim.code);
        assert.equal(f.claimRow().claim_id, originalClaim.claim_id);
        if (attempt === 1) assert.ok(f.state.calls.some((rpc) => rpc.method === 'eth_getTransactionReceipt' && rpc.params[0] === CLAIM_HASH));
      }
    }
    assert.equal(f.order(oldOrderId)!.status, 'processing');
    assert.equal((f.order(current.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    const ready = await f.request(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, current.authentication.token);
    assert.equal(ready.response.status, 200, JSON.stringify(ready.body));
  } finally { f.close(); }
});

test('deferred queue rotation cannot overwrite a concurrent canonical claim confirmation', async () => {
  const f = fixture();
  try {
    const first = await confirmedCrateClaim(f);
    const replacementHash = `0x${'cc'.repeat(32)}`;
    const replacementLog = { ...f.claimLog(first.claim, undefined, replacementHash),
      blockNumber: '0xcb', blockHash: blockHash(203) };
    f.state.canonical.set(200, blockHash(10_200));
    f.setReceipt(CLAIM_HASH, [], 201);
    f.setReceipt(replacementHash, [replacementLog], 203);
    f.state.tokens.delete('2000001');
    f.state.head = 205;
    f.state.logs = f.state.logs.filter((log) => log.transactionHash !== CLAIM_HASH);
    const barrier = pauseRpc(f, (rpc) => rpc.method === 'eth_call' &&
      String((rpc.params[0] as { data: string }).data).startsWith(functionSelector('getTokenInfo(uint256)')));
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    const confirmed = await f.request(paths.claimConfirm,
      { claimId: first.claim.claimId, transactionHash: replacementHash }, first.authentication.token);
    assert.equal(confirmed.body.status, 'confirmed');
    const canonical = f.claimRow();
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.claimRow(), canonical);
  } finally { f.close(); }
});

test('one failed receipt does not block later records or discovery and is counted once', async () => {
  const f = fixture();
  try {
    await f.confirmed();
    const second = await f.prepared(['111113'], '10000000-0000-4000-8000-000000000002');
    const secondHash = `0x${'cc'.repeat(32)}`;
    const secondLog = { ...f.deliveryLog(second.prepared, ['111113'], ['2000002'], secondHash),
      blockNumber: '0x67', blockHash: blockHash(103) };
    f.setReceipt(secondHash, [secondLog], 103);
    f.state.head = 103;
    assert.equal((await f.request(paths.deliveryConfirm, { orderId: second.prepared.orderId, transactionHash: secondHash }, second.authentication.token)).body.status, 'pending');
    const third = await f.prepared(['7'], '10000000-0000-4000-8000-000000000003');
    const thirdHash = `0x${'dd'.repeat(32)}`;
    const thirdLog = { ...f.deliveryLog(third.prepared, ['7'], ['1000821'], thirdHash),
      blockNumber: '0x69', blockHash: blockHash(105) };
    f.setReceipt(thirdHash, [thirdLog], 105);
    f.state.head = 107;
    f.state.logs.push(secondLog, thirdLog);
    const failure = new Error('One receipt is unavailable');
    f.state.afterRpc = async (rpc) => { if (rpc.method === 'eth_getTransactionReceipt' && rpc.params[0] === HASH) throw failure; };
    let failed = 0;
    await assert.rejects(reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), {
      fetch: f.providerFetch, nowMs: () => f.state.now, onResult: (result) => { failed = result.failed; },
    }), (error: unknown) => error === failure);
    assert.equal(failed, 1);
    assert.equal(f.order(second.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.order(third.prepared.orderId)!.status, 'ready_to_ship');
    f.state.afterRpc = null;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
  } finally { f.close(); }
});

test('receipt reconciliation propagates cancellation without starting discovery', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const original = f.quoteRow(first.prepared.orderId);
    const controller = new AbortController();
    const reason = new Error('Reconciliation cancelled');
    f.state.calls.length = 0;
    f.state.afterRpc = async (rpc) => { if (rpc.method === 'eth_getTransactionReceipt') controller.abort(reason); };
    await assert.rejects(reconcileEthereum111k(f.env, controller.signal,
      { fetch: f.providerFetch, nowMs: () => f.state.now }), (error: unknown) => error === reason);
    assert.deepEqual(f.quoteRow(first.prepared.orderId), original);
    assert.equal(f.state.calls.some((rpc) => rpc.method === 'eth_getLogs'), false);
  } finally { f.close(); }
});

test('a new canonical crate delivery retires orphaned claims before cron and invalidates the old code', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const oldClaim = f.claimRow();
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const claim = f.claimRow();
    assert.equal(claim.order_id, next.prepared.orderId);
    assert.notEqual(claim.code, oldClaim.code);
    assert.notEqual(claim.claim_id, oldClaim.claim_id);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'prepared');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
    assert.equal(f.order(first.prepared.orderId)!.status, 'processing');
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code: oldClaim.code }, next.authentication.token)).response.status, 400);
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code: claim.code }, next.authentication.token)).response.status, 200);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(next.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.claimRow().code, claim.code);
  } finally { f.close(); }
});

test('re-mined canonical deliveries retain claim identities through same-order retirement', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.confirmed();
    const oldCode = f.claimRow().code;
    const movedLog = { ...f.deliveryLog(prepared), blockNumber: '0x65', blockHash: blockHash(101) };
    f.setReceipt(HASH, [movedLog], 101);
    f.state.logs = [movedLog];
    f.state.head = 103;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().code, oldCode);
    assert.equal(f.quoteRow(prepared.orderId).block_hash, blockHash(101));
    orphanCrateDelivery(f);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().code, oldCode);
    f.setReceipt(HASH, [movedLog], 101);
    f.state.logs = [movedLog];
    f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    const claim = f.claimRow();
    assert.equal(claim.code, oldCode);
    assert.equal((f.order(prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code: claim.code }, authentication.token)).response.status, 200);
  } finally { f.close(); }
});

test('a delayed retirement projection cannot erase a reconfirmed order or its claim code', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    orphanCrateDelivery(f);
    const barrier = pauseCommerceBatch(f, () => f.quoteRow(first.prepared.orderId).status === 'prepared');
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    f.setReceipt(HASH, [f.deliveryLog(first.prepared)]);
    assert.equal((await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token)).body.status, 'confirmed');
    barrier.resume();
    await reconciliation;
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
    assert.equal((f.order(first.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].code, claim.code);
  } finally { f.close(); }
});

test('stale claim projection cannot mark a new canonical order claim as claimed', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, first.authentication.token);
    f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body)]);
    const barrier = pauseCommerceBatch(f, () => f.claimRow().status === 'claimed');
    const stale = f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    await barrier.paused;
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const claim = f.claimRow();
    barrier.resume();
    await stale;
    assert.deepEqual(f.claimRow(), claim);
    assert.equal((f.order(next.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    assert.deepEqual(f.order(first.prepared.orderId)!.irlClaims, []);
  } finally { f.close(); }
});

test('canonical replay of an old claim authorization updates the current receipt identity and skips completed replay', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, first.authentication.token);
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const code = f.claimRow().code;
    assert.notEqual(f.claimRow().claim_id, prepared.body.claimId);
    const log = f.claimLog(prepared.body);
    f.setReceipt(CLAIM_HASH, [log]);
    f.state.logs.push(log);
    assert.equal((await f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, next.authentication.token)).body.status, 'confirmed');
    assert.equal(f.claimRow().claim_id, prepared.body.claimId);
    assert.equal(f.claimRow().code, code);
    assert.equal((f.order(next.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
    f.state.head = 200;
    f.state.calls.length = 0;
    let recentReceiptReads = 0;
    f.state.afterRpc = async rpc => {
      if (rpc.method === 'eth_getLogs') recentReceiptReads = f.state.calls.filter(call => call.method === 'eth_getTransactionReceipt').length;
    };
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(recentReceiptReads, 2);
    f.state.afterRpc = null;
    f.state.calls.length = 0;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.state.calls.filter((call) => call.method === 'eth_getTransactionReceipt').length, 0);
    const repository = new D1CommerceRepository(f.env.COMMERCE_DB);
    await repository.run(NOW, async (unit) => {
      const key = commerceKeys.deliveryOrder('111k_devnet', String(next.prepared.orderId));
      const order = await unit.get(key);
      await unit.update(key, { irlClaims: (order!.data.irlClaims as Record<string, string>[]).map((claim) => ({ ...claim, status: 'available' })) });
    });
    f.commerce.database.prepare('DELETE FROM ethereum_reconciliation_cursor').run();
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.state.calls.filter((call) => call.method === 'eth_getTransactionReceipt').length, 1);
    assert.equal((f.order(next.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
  } finally { f.close(); }
});

test('a stale delivery confirmation cannot recreate claims after a replacement order wins', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const barrier = pauseRpc(f, (payload) => payload.method === 'eth_getBlockByNumber' && payload.params[0] === '0x64');
    const stale = f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token);
    await barrier.paused;
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const claim = f.claimRow();
    barrier.resume();
    assert.equal((await stale).body.status, 'pending');
    assert.deepEqual(f.claimRow(), claim);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'prepared');
    assert.equal(f.order(next.prepared.orderId)!.status, 'ready_to_ship');
  } finally { f.close(); }
});

test('a stale claim confirmation cannot mutate the replacement receipt claim', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, first.authentication.token);
    f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body)]);
    const barrier = pauseRpc(f, (payload) => payload.method === 'eth_getBlockByNumber' && payload.params[0] === '0x64');
    const stale = f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, first.authentication.token);
    await barrier.paused;
    orphanCrateDelivery(f);
    const next = await replaceCrateDelivery(f);
    const claim = f.claimRow();
    barrier.resume();
    assert.equal((await stale).body.status, 'pending');
    assert.deepEqual(f.claimRow(), claim);
    assert.equal((f.order(next.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
  } finally { f.close(); }
});

test('stale orphan detection cannot delete a same-millisecond canonical reconfirmation', async () => {
  const f = fixture();
  try {
    const first = await f.confirmed();
    const claim = f.claimRow();
    orphanCrateDelivery(f);
    const barrier = pauseRpc(f, (payload) => payload.method === 'eth_call' &&
      (payload.params[0] as { data: string }).data.startsWith(functionSelector('usedDeliveryOrders(uint256)')));
    const reconciliation = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    await barrier.paused;
    f.setReceipt(HASH, [f.deliveryLog(first.prepared)]);
    assert.equal((await f.request(paths.deliveryConfirm,
      { orderId: first.prepared.orderId, transactionHash: HASH }, first.authentication.token)).body.status, 'confirmed');
    barrier.resume();
    await reconciliation;
    assert.deepEqual(f.claimRow(), claim);
    assert.equal(f.quoteRow(first.prepared.orderId).status, 'confirmed');
    assert.equal(f.order(first.prepared.orderId)!.status, 'ready_to_ship');
  } finally { f.close(); }
});

test('crowded event windows split and resume a hot block without replaying completed confirmations', async () => {
  const f = fixture();
  try {
    const { prepared } = await f.prepared(['7']);
    const source = f.quoteRow(prepared.orderId);
    f.state.head = 2200;
    const insert = f.commerce.database.prepare(`INSERT INTO ethereum_delivery_quotes
      (chain_id, contract_address, order_id, request_id, wallet, address_id, address_json, token_ids_json,
        items_json, fee_wei, deadline, status, transaction_hash, block_number, block_hash, published_at_ms,
        verified_at_block, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < 1001; index++) {
      const orderId = index + 10_000;
      const tokenId = String(index + 1);
      const hash = `0x${(index + 1).toString(16).padStart(64, '0')}`;
      const completed = index < 955;
      const moved = index === 955;
      const log = { ...f.deliveryLog({ ...prepared, orderId }, [tokenId], [String(1_000_001 + index)], hash),
        logIndex: ethereumHexQuantity(index) };
      f.state.logs.push(log);
      f.setReceipt(hash, [log]);
      insert.run(31337, CONTRACT, orderId, crypto.randomUUID(), WALLET, ADDRESS_ID, source.address_json,
        JSON.stringify([tokenId]), JSON.stringify([{ tokenId, kind: 'artwork', displayId: index + 1, owner: WALLET }]),
        source.fee_wei, source.deadline, completed || moved ? 'confirmed' : 'prepared',
        completed || moved ? hash : null, completed || moved ? 100 : null, moved ? blockHash(999) : completed ? blockHash(100) : null,
        completed || moved ? NOW : null, completed || moved ? 2200 : null, NOW, NOW);
    }
    let remaining = 46;
    for (let attempt = 0; attempt < 5 && remaining; attempt++) {
      const completedHashes = new Set(f.commerce.database.prepare(`SELECT transaction_hash FROM ethereum_delivery_quotes
        WHERE order_id BETWEEN 10000 AND 11000 AND status = 'confirmed' AND block_hash = ? AND published_at_ms IS NOT NULL`)
        .all(blockHash(100)).map((row) => row.transaction_hash));
      f.state.calls.length = 0;
      f.databaseCalls.statements = 0;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      const reads = f.state.calls.filter((call) => call.method === 'eth_getTransactionReceipt');
      assert.ok(reads.every((call) => !completedHashes.has(String(call.params[0]))));
      assert.ok(f.databaseCalls.statements <= 400);
      const next = Number(f.commerce.database.prepare(`SELECT COUNT(*) AS n FROM ethereum_delivery_quotes
        WHERE order_id BETWEEN 10000 AND 11000 AND (status != 'confirmed' OR block_hash != ? OR published_at_ms IS NULL)`)
        .get(blockHash(100))!.n);
      assert.ok(next < remaining, 'The hot block must resume without replaying completed confirmations');
      remaining = next;
      if (remaining) assert.ok(Number(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block) <= 100);
      if (!attempt) assert.ok(f.state.calls.filter((call) => call.method === 'eth_getLogs').length > 1);
    }
    assert.equal(remaining, 0);
    assert.equal(f.quoteRow(10_955).block_hash, blockHash(100));
    assert.ok(Number(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block) > 100);
    assert.equal(f.commerce.database.prepare("SELECT COUNT(*) AS n FROM ethereum_delivery_quotes WHERE order_id BETWEEN 10000 AND 11000 AND status = 'confirmed'").get()!.n, 1001);
  } finally { f.close(); }
});

for (const depth of [20, 64]) {
  test(`event discovery recovers a previously unobserved delivery after a ${depth}-block reorg`, async () => {
    const f = fixture();
    try {
      f.state.head = 80;
      const { prepared } = await f.prepared();
      f.state.head = 100 + depth;
      f.state.now += (f.state.head - 80) * 12_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, f.state.head + 1);
      assert.equal(f.quoteRow(prepared.orderId).transaction_hash, null);
      assert.equal(f.order(prepared.orderId), null);
      const log = { ...f.deliveryLog(prepared), blockHash: blockHash(10_100) };
      f.setReceipt(HASH, [log]);
      f.state.receipts.get(HASH)!.blockHash = log.blockHash;
      f.state.canonical.set(100, log.blockHash);
      f.state.logs = [log];
      f.state.tokens.delete('111112');
      f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.quoteRow(prepared.orderId).status, 'confirmed');
      assert.equal(f.quoteRow(prepared.orderId).transaction_hash, HASH);
      assert.equal(f.quoteRow(prepared.orderId).block_hash, log.blockHash);
      const order = f.order(prepared.orderId)!;
      assert.equal(order.status, 'ready_to_ship');
      const claim = f.claimRow();
      assert.equal((order.irlClaims as Record<string, unknown>[])[0].code, claim.code);
      f.state.head++;
      f.state.now += 12_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.deepEqual(f.order(prepared.orderId), order);
      assert.equal(f.claimRow().code, claim.code);
      assert.equal(f.claimRow().claim_id, claim.claim_id);
      assert.equal(f.commerce.database.prepare("SELECT COUNT(*) AS n FROM commerce_documents WHERE document_kind = 'delivery_order'").get()!.n, 1);
    } finally { f.close(); }
  });

  test(`event discovery recovers a previously unobserved claim after a ${depth}-block reorg`, async () => {
    const f = fixture();
    try {
      f.state.head = 80;
      const { authentication, prepared } = await f.prepared();
      const deliveryLog = { ...f.deliveryLog(prepared), blockNumber: '0x5a', blockHash: blockHash(90) };
      f.setReceipt(HASH, [deliveryLog], 90);
      f.state.logs = [deliveryLog];
      f.state.tokens.delete('111112');
      f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
      f.state.head = 92;
      f.state.now += 12 * 12_000;
      assert.equal((await f.request(paths.deliveryConfirm,
        { orderId: prepared.orderId, transactionHash: HASH }, authentication.token)).body.status, 'confirmed');
      const claim = f.claimRow();
      const authorization = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
        { receiptId: '2000001', code: claim.code }, authentication.token);
      assert.equal(authorization.response.status, 200, JSON.stringify(authorization.body));
      f.state.head = 100 + depth;
      f.state.now += (f.state.head - 92) * 12_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, f.state.head + 1);
      assert.equal(f.claimRow().transaction_hash, null);
      assert.equal(f.claimRow().status, 'available');
      const log = { ...f.claimLog(authorization.body), blockHash: blockHash(10_100) };
      f.setReceipt(CLAIM_HASH, [log]);
      f.state.receipts.get(CLAIM_HASH)!.blockHash = log.blockHash;
      f.state.canonical.set(100, log.blockHash);
      f.state.logs.push(log);
      f.state.tokens.delete('2000001');
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.claimRow().status, 'claimed');
      assert.equal(f.claimRow().transaction_hash, CLAIM_HASH);
      assert.equal(f.claimRow().block_hash, log.blockHash);
      const order = f.order(prepared.orderId)!;
      assert.equal((order.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
      f.state.head++;
      f.state.now += 12_000;
      await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.deepEqual(f.order(prepared.orderId), order);
      assert.equal(f.claimRow().code, claim.code);
      assert.equal(f.claimRow().claim_id, claim.claim_id);
      assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_crate_claims').get()!.n, 1);
    } finally { f.close(); }
  });
}

test('event discovery retains its cursor when a receipt has not been durably confirmed', async () => {
  const f = fixture();
  try {
    const { prepared } = await f.prepared();
    const log = f.deliveryLog(prepared);
    f.state.logs = [log];
    f.state.head = 2000;
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.quoteRow(prepared.orderId).transaction_hash, null);
    assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, 100);
    f.setReceipt(HASH, [log]);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.order(prepared.orderId)!.status, 'ready_to_ship');
    assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, 2001);
  } finally { f.close(); }
});

test('physical claim authorization needs the exact receipt, code and owner and survives failed or reorged submissions', async () => {
  const f = fixture();
  try {
    const { authentication, prepared: delivery } = await f.confirmed();
    const code = String(f.claimRow().code);
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code: 'wrong' }, authentication.token)).response.status, 400);
    const other = await f.session(OTHER_KEY);
    assert.equal((await f.request(paths.claimPrepare, { receiptId: '2000001', code }, other.token)).response.status, 403);
    const input = { receiptId: '2000001', code: `${code.slice(0, 6)}-${code.slice(6)}`.toLowerCase() };
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare, input, authentication.token);
    assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
    assert.equal(f.claimRow().status, 'available');
    assert.equal(recoverEthereumAddress(crateClaimDigest({ chainId: 31337, contractAddress: CONTRACT, wallet: WALLET,
      receiptId: prepared.body.receiptId, claimId: prepared.body.claimId, deadline: prepared.body.deadline }), prepared.body.signature), SIGNER);
    const confirmInput = { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH };
    assert.equal((await f.request(paths.claimConfirm, confirmInput, authentication.token)).body.status, 'pending');
    const log = f.claimLog(prepared.body);
    f.setReceipt(CLAIM_HASH, [log]);
    f.state.head = 100;
    assert.equal((await f.request(paths.claimConfirm, confirmInput, authentication.token)).body.status, 'pending');
    assert.equal(f.claimRow().status, 'pending');
    f.state.head = 102;
    assert.equal((await f.request(paths.claimConfirm, confirmInput, authentication.token)).body.status, 'confirmed');
    assert.equal(f.claimRow().status, 'claimed');
    assert.equal((f.order(delivery.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'claimed');
    f.state.receipts.delete(CLAIM_HASH);
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    assert.equal(f.claimRow().status, 'available');
    assert.equal((f.order(delivery.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    const retry = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare, input, authentication.token);
    assert.equal(retry.response.status, 200);
    assert.equal(retry.body.claimId, prepared.body.claimId);
    assert.equal(f.claimRow().code, code);
  } finally { f.close(); }
});

test('local inventory paginates current holdings after burned and transferred tokens, including histories over 150 tokens', async () => {
  for (const [burned, transferred, owned] of [[30, 0, 10], [151, 5, 35]]) {
    const f = fixture();
    try {
      f.state.tokens.clear();
      for (let id = 1; id <= burned + transferred + owned; id++) {
        f.state.logs.push({ address: CONTRACT, topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          topicAddress(ZERO), topicAddress(WALLET), topicNumber(id),
        ], data: '0x', blockNumber: '0x64', blockHash: blockHash(100), transactionHash: HASH, logIndex: ethereumHexQuantity(id) });
        if (id > burned) f.state.tokens.set(String(id), { kind: 1, displayId: id,
          owner: id <= burned + transferred ? OTHER_WALLET : WALLET });
      }
      const expected = Array.from({ length: owned }, (_, index) => String(burned + transferred + index + 1));
      type Page = { items: { tokenId: string; owner: string }[]; nextCursor: string | null };
      const first = await f.request<Page>(`${paths.inventory}?owner=${WALLET}`);
      assert.equal(first.response.status, 200, JSON.stringify(first.body));
      assert.deepEqual(first.body.items.map(item => item.tokenId), expected.slice(0, 30));
      assert.ok(first.body.items.every(item => item.owner === WALLET));
      assert.equal(first.body.nextCursor, owned > 30 ? '30' : null);
      if (first.body.nextCursor) {
        const next = await f.request<Page>(`${paths.inventory}?owner=${WALLET}&cursor=${first.body.nextCursor}`);
        assert.equal(next.response.status, 200, JSON.stringify(next.body));
        assert.deepEqual(next.body.items.map(item => item.tokenId), expected.slice(30));
        assert.equal(next.body.nextCursor, null);
      }
    } finally { f.close(); }
  }
});

test('Sepolia inventory is contract scoped and verifies current ownership, including recent IDs and delayed indexers', async () => {
  const f = fixture();
  try {
    f.env.ETHEREUM_111K_CHAIN_ID = '11155111';
    f.state.alchemyNfts = [{ tokenId: '111112', contract: { address: CONTRACT } }, { tokenId: '111113', contract: { address: CONTRACT } }];
    f.state.tokens.get('111113')!.owner = OTHER_WALLET;
    const result = await f.request<{ items: { tokenId: string; owner: string; contractAddress: string }[] }>(
      `${paths.inventory}?owner=${WALLET}&expectedTokenIds=7`);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.items.map(item => item.tokenId), ['111112', '7']);
    assert.ok(result.body.items.every(item => item.owner === WALLET && item.contractAddress === CONTRACT));
    const url = new URL(f.state.urls.find(value => value.includes('/getNFTsForOwner'))!);
    assert.equal(url.searchParams.get('contractAddresses[]'), CONTRACT);
    assert.equal(url.searchParams.get('owner'), WALLET);
    f.state.alchemyNfts = [{ tokenId: '111112', contract: { address: OTHER_CONTRACT } }];
    assert.equal((await f.request(`${paths.inventory}?owner=${WALLET}`)).response.status, 503);
    f.state.alchemyNfts = [];
    f.state.alchemyCursor = 'same';
    assert.equal((await f.request(`${paths.inventory}?owner=${WALLET}&cursor=same`)).response.status, 503);
  } finally { f.close(); }
});

test('RPC network mismatches fail closed before contract reads or authorization preparation', async () => {
  const f = fixture();
  try {
    const session = await f.session();
    await f.saveAddress(session.token);
    f.state.rpcChainId = 1;
    const stats = await f.request(paths.stats);
    assert.equal(stats.response.status, 503);
    assert.deepEqual(f.state.calls.map(call => call.method), ['eth_chainId']);
    const prepared = await f.request(paths.deliveryPrepare,
      { tokenIds: ['111112'], addressId: ADDRESS_ID, requestId: REQUEST_ID }, session.token);
    assert.equal(prepared.response.status, 503);
    assert.equal(prepared.body.signature, undefined);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM ethereum_delivery_quotes').get()!.n, 0);
  } finally { f.close(); }
});

test('parallel receipt reads cannot confirm a delivery from the wrong network', async () => {
  const f = fixture();
  try {
    const { authentication, prepared } = await f.prepared();
    const original = f.quoteRow(prepared.orderId);
    f.setReceipt(HASH, [f.deliveryLog(prepared)]);
    f.state.rpcChainId = 1;
    f.state.calls.length = 0;
    const result = await f.request(paths.deliveryConfirm,
      { orderId: prepared.orderId, transactionHash: HASH }, authentication.token);
    assert.equal(result.response.status, 503);
    assert.deepEqual(f.state.calls.map(call => call.method).sort(), ['eth_chainId', 'eth_getTransactionReceipt']);
    assert.deepEqual(f.quoteRow(prepared.orderId), original);
    assert.equal(f.order(prepared.orderId), null);
  } finally { f.close(); }
});

test('physical crate 5555 requires all 31 receipt identities and never exposes its code in customer shipment summaries', async () => {
  const f = fixture();
  try {
    f.state.tokens.set('116666', { kind: 2, displayId: 5555, owner: WALLET });
    const { authentication, prepared: delivery } = await f.prepared(['116666']);
    f.setReceipt(HASH, [f.deliveryLog(delivery, ['116666'], ['2005555'])]);
    const confirmed = await f.request(paths.deliveryConfirm,
      { orderId: delivery.orderId, transactionHash: HASH }, authentication.token);
    assert.equal(confirmed.response.status, 200);
    f.state.tokens.set('2005555', { kind: 5, displayId: 5555, owner: WALLET });
    const code = String(f.claimRow('2005555').code);
    const shipments = await f.request(paths.shipments, undefined, authentication.token);
    assert.equal(shipments.response.status, 200);
    assert.ok(!JSON.stringify(shipments.body).includes(code));
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2005555', code }, authentication.token);
    assert.equal(prepared.response.status, 200);
    const receiptIds = crateArtworkIds(5555).map(id => String(1_000_000 + id));
    assert.equal(receiptIds.length, 31);
    const input = { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH };
    f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body, receiptIds.slice(0, 20))]);
    assert.equal((await f.request(paths.claimConfirm, input, authentication.token)).response.status, 403);
    assert.equal(f.claimRow('2005555').status, 'available');
    f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body, receiptIds)]);
    assert.equal((await f.request(paths.claimConfirm, input, authentication.token)).body.status, 'confirmed');
    assert.equal(f.claimRow('2005555').status, 'claimed');
    assert.deepEqual((f.order(delivery.orderId)!.irlClaims as Record<string, unknown>[])[0].dudeIds, crateArtworkIds(5555));
  } finally { f.close(); }
});

test('Ethereum test deliveries cannot create paid shipping labels or buyer and shipper email jobs', async () => {
  const f = fixture();
  try {
    const { prepared } = await f.confirmed();
    const order = f.order(prepared.orderId)!;
    assert.throws(() => requireShipStationEnabled('111k_devnet'), /disabled/i);
    assert.doesNotThrow(() => requireShipStationEnabled('card_nft_2'));
    assert.deepEqual(planReadyToShipNotifications({ before: { status: 'processing' }, after: order,
      deliveryId: prepared.orderId, dropId: '111k_devnet', nowMs: NOW }), []);
    assert.equal(f.commerce.database.prepare('SELECT COUNT(*) AS n FROM commerce_notification_outbox').get()!.n, 0);
  } finally { f.close(); }
});

async function orphanClaimWithRecentDeliveries(f: ReturnType<typeof fixture>, count: number) {
  const claimed = await confirmedCrateClaim(f);
  f.state.receipts.delete(CLAIM_HASH);
  f.state.canonical.set(200, blockHash(10200));
  f.state.logs = f.state.logs.filter(log => log.transactionHash !== CLAIM_HASH);
  f.state.head = 203;
  f.commerce.database.prepare('UPDATE ethereum_delivery_quotes SET verified_at_block = 1000').run();
  f.state.tokens.set('2000001', { kind: 5, displayId: 1, owner: WALLET });
  const deliveries: string[] = [];
  for (let index = 0; index < count; index++) {
    const tokenId = String(500 + index);
    f.state.tokens.set(tokenId, { kind: 1, displayId: 500 + index, owner: WALLET });
    const delivery = await f.prepared([tokenId], crypto.randomUUID());
    const hash = blockHash(50000 + index);
    const log = { ...f.deliveryLog(delivery.prepared, [tokenId], [String(1000500 + index)], hash),
      blockNumber: '0xc9', blockHash: blockHash(201), logIndex: ethereumHexQuantity(index + 1) };
    f.setReceipt(hash, [log], 201);
    f.state.logs.push(log);
    assert.equal((await f.request(paths.deliveryConfirm,
      { orderId: delivery.prepared.orderId, transactionHash: hash }, delivery.authentication.token)).body.status, 'confirmed');
    deliveries.push(hash);
  }
  return { claimed, deliveries };
}

test('slow delivery backlogs leave time for orphaned claims and event discovery', async context => {
  const f = fixture();
  try {
    const { claimed, deliveries } = await orphanClaimWithRecentDeliveries(f, 6);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    f.state.afterRpc = async rpc => {
      if (rpc.method === 'eth_getTransactionReceipt' && deliveries.includes(String(rpc.params[0]))) context.mock.timers.tick(8000);
    };
    for (let run = 0; run < 3; run++) {
      f.state.calls.length = 0;
      f.databaseCalls.statements = 0;
      const result = await reconcileEthereum111k(f.env, new AbortController().signal, { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(f.claimRow().status, 'available');
      assert.equal((f.order(claimed.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
      assert.equal(result.failed, 0);
      assert.ok(f.state.calls.some(rpc => rpc.method === 'eth_getLogs'));
      assert.ok(f.databaseCalls.statements <= 400);
      f.state.now += 300000;
      f.state.head += 25;
    }
    assert.equal((await f.request(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, claimed.authentication.token)).response.status, 200);
  } finally { f.close(); }
});

for (const oldReceipt of ['missing', 'reverted', 'noncanonical'] as const) test(`both recent phases finish with ${oldReceipt} claim receipts when each RPC takes eight seconds`, async context => {
  const f = fixture();
  const parent = new AbortController();
  try {
    const { claimed } = await orphanClaimWithRecentDeliveries(f, 1);
    if (oldReceipt === 'reverted') {
      f.setReceipt(CLAIM_HASH, [], 201);
      f.state.receipts.get(CLAIM_HASH)!.status = '0x0';
    } else if (oldReceipt === 'noncanonical') {
      f.setReceipt(CLAIM_HASH, [claimed.log], 200);
    }
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const slowFetch: typeof fetch = async (input, init) => {
      const signal = init?.signal;
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 8000);
        const abort = () => { clearTimeout(timer); reject(signal?.reason); };
        signal?.addEventListener('abort', abort, { once: true });
      });
      return f.providerFetch(input, init);
    };
    let settled = false;
    const completion = reconcileEthereum111k(f.env, parent.signal, { fetch: slowFetch, nowMs: () => f.state.now })
      .then(result => ({ result }), error => ({ error })).finally(() => { settled = true; });
    for (let step = 0; step < 7 && !settled; step++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      context.mock.timers.tick(8000);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!settled) parent.abort(new Error('Reconciliation exceeded the scheduled deadline'));
    const outcome = await completion;
    if ('error' in outcome) throw outcome.error;
    assert.equal(outcome.result.failed, 0);
    assert.equal(outcome.result.deferred, 0);
    assert.equal(outcome.result.stopReason, undefined);
    assert.equal(f.claimRow().status, 'available');
    assert.equal((f.order(claimed.prepared.orderId)!.irlClaims as Record<string, unknown>[])[0].status, 'available');
    assert.ok(f.state.calls.some(rpc => rpc.method === 'eth_getLogs'));
    assert.equal((await f.request(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, claimed.authentication.token)).response.status, 200);
  } finally { parent.abort(); f.close(); }
});

test('recent delivery and claim reconciliation reuse their verified receipts', async () => {
  const f = fixture();
  try {
    const delivery = await f.confirmed();
    const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
      { receiptId: '2000001', code: f.claimRow().code }, delivery.authentication.token);
    assert.equal(prepared.response.status, 200);
    const log = f.claimLog(prepared.body);
    f.setReceipt(CLAIM_HASH, [log]);
    f.state.logs.push(log);
    assert.equal((await f.request(paths.claimConfirm,
      { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH }, delivery.authentication.token)).body.status, 'confirmed');
    f.state.calls.length = 0;
    let recentCalls: typeof f.state.calls = [];
    f.state.afterRpc = async rpc => {
      if (rpc.method === 'eth_getLogs') recentCalls = [...f.state.calls];
    };
    await reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
    for (const hash of [HASH, CLAIM_HASH]) {
      assert.equal(recentCalls.filter(call => call.method === 'eth_getTransactionReceipt' && call.params[0] === hash).length, 1);
    }
    assert.equal(recentCalls.filter(call => call.method === 'eth_blockNumber').length, 3);
    assert.equal(recentCalls.filter(call => call.method === 'eth_getBlockByNumber').length, 2);
    assert.equal(f.quoteRow(delivery.prepared.orderId).verified_at_block, f.state.head);
    assert.equal(f.claimRow().verified_at_block, f.state.head);
  } finally { f.close(); }
});

for (const slowMethod of ['eth_blockNumber', 'eth_getTransactionReceipt']) {
  test(`recent reconciliation timing out during ${slowMethod} leaves discovery active`, async (context) => {
    const f = fixture();
    try {
      await f.confirmed();
      const next = await f.prepared(['7'], '10000000-0000-4000-8000-000000000002');
      const nextHash = `0x${'cc'.repeat(32)}`;
      const log = { ...f.deliveryLog(next.prepared, ['7'], ['1000821'], nextHash), logIndex: '0x1' };
      f.setReceipt(nextHash, [log]);
      f.state.logs.push(log);
      const parent = new AbortController();
      context.mock.timers.enable({ apis: ['setTimeout'] });
      f.state.afterRpc = async (rpc) => {
        if (rpc.method !== slowMethod) return;
        f.state.afterRpc = null;
        context.mock.timers.tick(30_000);
      };
      f.state.calls.length = 0;
      const result = await reconcileEthereum111k(f.env, parent.signal, { fetch: f.providerFetch, nowMs: () => f.state.now });
      assert.equal(parent.signal.aborted, false);
      assert.equal(result.stopReason, 'time-limit');
      assert.equal(result.hasMore, true);
      assert.equal(result.failed, 0);
      assert.equal(result.deferred, 1);
      assert.equal(f.state.calls.filter(call => call.method === 'eth_getLogs').length, 1);
      assert.equal(f.order(next.prepared.orderId)!.status, 'ready_to_ship');
      assert.equal(f.commerce.database.prepare('SELECT next_block FROM ethereum_reconciliation_cursor').get()!.next_block, f.state.head + 1);
    } finally { f.close(); }
  });
}

for (const kind of ['delivery', 'claim']) {
  test(`reused ${kind} receipts cannot overwrite a newer canonical confirmation`, async () => {
    const f = fixture();
    try {
      const delivery = await f.confirmed();
      let path: string = paths.deliveryConfirm;
      let input: { transactionHash: string; orderId?: number; claimId?: string } = {
        orderId: delivery.prepared.orderId, transactionHash: HASH,
      };
      if (kind === 'claim') {
        const prepared = await f.request<EthereumClaimPrepareResponse>(paths.claimPrepare,
          { receiptId: '2000001', code: f.claimRow().code }, delivery.authentication.token);
        assert.equal(prepared.response.status, 200);
        f.setReceipt(CLAIM_HASH, [f.claimLog(prepared.body)]);
        path = paths.claimConfirm;
        input = { claimId: prepared.body.claimId, transactionHash: CLAIM_HASH };
        assert.equal((await f.request(path, input, delivery.authentication.token)).body.status, 'confirmed');
        f.commerce.database.prepare('UPDATE ethereum_delivery_quotes SET verified_at_block = 1000').run();
      }
      const barrier = pauseRpc(f, rpc => rpc.method === 'eth_getBlockByNumber' && rpc.params[0] === '0x64');
      const pending = reconcileEthereum111k(f.env, AbortSignal.timeout(10_000), { fetch: f.providerFetch, nowMs: () => f.state.now });
      await barrier.paused;
      const log = { ...f.state.receipts.get(input.transactionHash)!.logs[0], blockNumber: '0x65', blockHash: blockHash(101) };
      f.setReceipt(input.transactionHash, [log], 101);
      f.state.canonical.set(100, blockHash(999));
      f.state.head = 103;
      f.state.logs = [];
      assert.equal((await f.request(path, input, delivery.authentication.token)).body.status, 'confirmed');
      const current = kind === 'delivery' ? f.quoteRow(delivery.prepared.orderId) : f.claimRow();
      barrier.resume();
      await pending;
      assert.deepEqual(kind === 'delivery' ? f.quoteRow(delivery.prepared.orderId) : f.claimRow(), current);
    } finally { f.close(); }
  });
}
