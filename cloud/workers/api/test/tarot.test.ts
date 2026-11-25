import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ethereumSignerAddress, recoverEthereumAddress } from '../../../../shared/ethereum/crypto.ts';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.ts';
import { TAROT_API_PATHS, TAROT_CHAIN_ID, encodeTarotClaim, tarotCodeHashInput, tarotReceiptTokenId,
  type TarotPrepareResponse, type TarotStatus } from '../../../../shared/ethereum/tarot.ts';
import { TAROT_CLAIMED_TOPIC, tarotClaimDigest } from '../../../../shared/ethereum/tarotCrypto.ts';
import { handleTarotRequest, type TarotEnvironment } from '../src/tarot.ts';
import { tarotRoutes } from '../src/tarotRoutes.ts';
import { d1Database } from './commerceD1Harness.ts';

const NOW = 2_000_000_000_000;
const CONTRACT = `0x${'11'.repeat(20)}`;
const WALLET = `0x${'22'.repeat(20)}`;
const OTHER = `0x${'33'.repeat(20)}`;
const KEY = `0x${'44'.repeat(32)}`;
const SIGNER = ethereumSignerAddress(KEY);
const HASH = `0x${'aa'.repeat(32)}`;
const BLOCK_HASH = `0x${'bb'.repeat(32)}`;
const CODE = '11111111-1111-4111-8111-111111111111';
const BAD_CODE = '22222222-2222-4222-8222-222222222222';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const credentials = { tokenId: 1, testnet: true, code: CODE };
type RpcRequest = { id: number; method: string; params: unknown[] };

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync('cloud/workers/api/ops-migrations/0014_tarot_claim_codes.sql', 'utf8'));
  for (const tokenId of [1, 777]) db.prepare('INSERT INTO tarot_claim_codes VALUES (?, ?, ?, ?, ?, NULL)')
    .run(TAROT_CHAIN_ID, CONTRACT, tokenId, createHash('sha256').update(tarotCodeHashInput({ chainId: TAROT_CHAIN_ID,
      contractAddress: CONTRACT, tokenId, code: CODE })).digest('hex'), NOW);
  const calls: RpcRequest[] = [];
  const blockNumbers = new Map<string, number>();
  const limitKeys = { access: [] as string[], prepare: [] as string[], confirm: [] as string[] };
  const limiter = (kind: keyof typeof limitKeys): RateLimit => ({ limit: async ({ key }) => { limitKeys[kind].push(key); return { success: true }; } });
  let dbReads = 0;
  const env: TarotEnvironment = {
    OPS_DB: d1Database(db, () => { dbReads++; }), ALCHEMY_MI_NOTE_API_KEY: 'test', ETHEREUM_111K_RPC_URL: '',
    ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK: '1',
    ETHEREUM_TAROT_SEPOLIA_ENABLED: 'true', ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET: KEY,
    TAROT_ACCESS_IP_RATE_LIMITER: limiter('access'), TAROT_PREPARE_RATE_LIMITER: limiter('prepare'), TAROT_CONFIRM_IP_RATE_LIMITER: limiter('confirm'),
  };
  const state = { chainId: Number(TAROT_CHAIN_ID), blockNumber: 100, canonicalHash: BLOCK_HASH, timestamp: NOW / 1000,
    claimed: 0, initial: 777, maximum: 999_999, offset: 999_999, lifetime: 600, mintingPaused: 0, signer: String(SIGNER),
    callHash: null as string | null,
    claimBlock: 0,
    receipt: null as Record<string, unknown> | null, transaction: null as Record<string, unknown> | null,
    afterCall: null as (() => void) | null };
  const blockHash = (number: number, fork = state.canonicalHash) => `0x${createHash('sha256').update(`${fork}:${number}`).digest('hex')}`;
  const result = (payload: RpcRequest): unknown => {
    calls.push(payload);
    if (payload.method === 'eth_chainId') return ethereumHexQuantity(state.chainId);
    if (payload.method === 'eth_blockNumber') return ethereumHexQuantity(state.blockNumber);
    if (payload.method === 'eth_getBlockByNumber') {
      const number = payload.params[0] === 'latest' ? ethereumHexQuantity(state.blockNumber) : payload.params[0];
      const hash = blockHash(Number(number));
      blockNumbers.set(hash, Number(number));
      return { hash, number, timestamp: ethereumHexQuantity(state.timestamp) };
    }
    if (payload.method === 'eth_getTransactionReceipt') return state.receipt;
    if (payload.method === 'eth_getTransactionByHash') return state.transaction;
    assert.equal(payload.method, 'eth_call');
    const transaction = payload.params[0] as { to: string; data: string };
    assert.equal(transaction.to, CONTRACT);
    const reference = payload.params[1] as string | { blockHash: string; requireCanonical: boolean };
    const blockNumber = typeof reference === 'string' ? Number(reference) : blockNumbers.get(reference.blockHash)!;
    const signature = (name: string) => encodeCall(`${name}()`, [], []);
    const values: Record<string, [string, unknown]> = {
      [signature('INITIAL_CARDS')]: ['uint256', state.initial], [signature('mintingPaused')]: ['uint256', state.mintingPaused],
      [signature('MAX_CARDS')]: ['uint256', state.maximum], [signature('RECEIPT_OFFSET')]: ['uint256', state.offset],
      [signature('MAX_AUTHORIZATION_LIFETIME')]: ['uint256', state.lifetime], [signature('quoteSigner')]: ['address', state.signer],
      [encodeCall('claimed(uint256)', ['uint256'], [1])]: ['uint256', blockNumber >= state.claimBlock ? state.claimed : 0],
      [encodeCall('claimed(uint256)', ['uint256'], [777])]: ['uint256', blockNumber >= state.claimBlock ? state.claimed : 0],
    };
    const value = values[transaction.data];
    assert.ok(value, 'Unexpected Tarot contract read');
    const encoded = encodeAbi([value[0]], [value[1]]);
    state.afterCall?.();
    return encoded;
  };
  const providerFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
    const respond = (payload: RpcRequest) => {
      const reference = payload.params[1] as { blockHash?: string; requireCanonical?: boolean } | undefined;
      if (payload.method === 'eth_call' && reference?.requireCanonical &&
        reference.blockHash !== blockHash(blockNumbers.get(reference.blockHash ?? '')!, state.callHash ?? state.canonicalHash)) {
        return { jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: 'Block is not canonical.' } };
      }
      return { jsonrpc: '2.0', id: payload.id, result: result(payload) };
    };
    return Response.json(Array.isArray(body) ? body.map(respond) : respond(body));
  };
  const call = async (path: string, body: unknown = credentials, headers: Record<string, string> = {}, method = 'POST') => {
    const request = new Request(`https://api.mons.shop${path}`, { method,
      headers: { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1', ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    const response = await handleTarotRequest(request, env, path, { nowMs: () => NOW, fetch: providerFetch });
    return { response, body: await response.json() as Record<string, unknown> };
  };
  const prepared = async (tokenId = 1) => {
    const response = await call(TAROT_API_PATHS.prepare, { ...credentials, tokenId, wallet: WALLET });
    assert.equal(response.response.status, 200, JSON.stringify(response.body));
    return response.body as unknown as TarotPrepareResponse;
  };
  const mined = async () => {
    const quote = await prepared();
    const topics = [TAROT_CLAIMED_TOPIC, encodeAbi(['address'], [WALLET]), encodeAbi(['uint256'], [1]), encodeAbi(['uint256'], [tarotReceiptTokenId(1)])];
    const log = (topics: string[]) => ({ address: CONTRACT, topics, data: '0x', removed: false, blockNumber: '0x62',
      blockHash: blockHash(98), transactionHash: HASH });
    state.receipt = { transactionHash: HASH, blockHash: blockHash(98), blockNumber: '0x62', from: WALLET, to: CONTRACT, status: '0x1',
      logs: [log(topics), ...[1, tarotReceiptTokenId(1)].map(id => log([TRANSFER, encodeAbi(['uint256'], [0]), encodeAbi(['address'], [WALLET]), encodeAbi(['uint256'], [id])]))] };
    state.transaction = { hash: HASH, blockHash: blockHash(98), blockNumber: '0x62', from: WALLET, to: CONTRACT,
      chainId: ethereumHexQuantity(TAROT_CHAIN_ID), value: '0x0', input: quote.transaction.data };
    return quote;
  };
  const confirm = () => call(TAROT_API_PATHS.confirm, { ...credentials, wallet: WALLET, transactionHash: HASH });
  return { env, state, calls, db, call, prepared, mined, confirm, blockHash, limitKeys, dbReads: () => dbReads };
}

test('Tarot signs a free atomic claim scoped to the token, wallet, chain and contract without consuming its code', async t => {
  const f = fixture(t);
  for (const tokenId of [1, 777]) {
    const quotes = await Promise.all([f.prepared(tokenId), f.prepared(tokenId)]);
    for (const quote of quotes) {
      assert.equal(quote.receiptTokenId, tarotReceiptTokenId(tokenId));
      assert.equal(quote.deadline, NOW / 1000 + 600);
      assert.equal(quote.transaction.value, '0x0');
      assert.equal(quote.transaction.chainId, TAROT_CHAIN_ID);
      assert.equal(quote.transaction.to, CONTRACT);
      assert.equal(quote.transaction.data, encodeTarotClaim(tokenId, quote.deadline, quote.signature));
      assert.equal(recoverEthereumAddress(tarotClaimDigest({ chainId: TAROT_CHAIN_ID, contractAddress: CONTRACT,
        wallet: WALLET, tokenId, deadline: quote.deadline }), quote.signature), SIGNER);
      assert.notEqual(recoverEthereumAddress(tarotClaimDigest({ chainId: TAROT_CHAIN_ID, contractAddress: CONTRACT,
        wallet: OTHER, tokenId, deadline: quote.deadline }), quote.signature), SIGNER);
      assert.ok(!JSON.stringify(quote).includes(CODE));
    }
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM tarot_claim_codes WHERE revoked_at_ms IS NULL').get()?.count, 2);
  assert.equal(f.limitKeys.prepare[0], f.limitKeys.prepare[1]);
  assert.notEqual(f.limitKeys.prepare[0], f.limitKeys.prepare[2]);
});

test('Tarot checks secret credentials before RPC and revalidates claimed links', async t => {
  const f = fixture(t);
  for (const body of [{ ...credentials, code: BAD_CODE }, { ...credentials, tokenId: 2 }]) {
    assert.equal((await f.call(TAROT_API_PATHS.status, body)).response.status, 401);
    assert.equal((await f.call(TAROT_API_PATHS.prepare, { ...body, wallet: WALLET })).response.status, 401);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.limitKeys.prepare.length, 0);
  f.state.claimed = 1;
  const response = await f.call(TAROT_API_PATHS.status);
  assert.equal(response.response.status, 200);
  assert.equal((response.body as unknown as TarotStatus).claimed, true);
  assert.equal((await f.call(TAROT_API_PATHS.prepare, { ...credentials, wallet: WALLET })).response.status, 409);
  f.db.prepare('UPDATE tarot_claim_codes SET revoked_at_ms = ? WHERE token_id = 1').run(NOW);
  assert.equal((await f.call(TAROT_API_PATHS.status)).response.status, 401);
});

test('Tarot rejects mainnet, extra fields and malformed requests before database or RPC work', async t => {
  const f = fixture(t);
  for (const body of [{ ...credentials, testnet: false }, { tokenId: 1, code: CODE }, { ...credentials, tokenId: 0 },
    { ...credentials, tokenId: 778 }, { ...credentials, tokenId: '1' }, { ...credentials, code: 'basel' },
    { ...credentials, chainId: 1 }, { ...credentials, code: `${CODE} ` }]) {
    assert.equal((await f.call(TAROT_API_PATHS.status, body)).response.status, 400);
  }
  assert.equal((await f.call(TAROT_API_PATHS.status, credentials, {}, 'GET')).response.status, 405);
  assert.equal((await f.call(TAROT_API_PATHS.status, credentials, { Origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await f.call(TAROT_API_PATHS.status, credentials, { 'X-Mons-CSRF': '' })).response.status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(f.dbReads(), 0);
});

test('Tarot status waits for three confirmations while preparation sees the latest claim', async t => {
  const f = fixture(t);
  f.state.claimed = 1;
  f.state.claimBlock = 100;
  let response = await f.call(TAROT_API_PATHS.status);
  assert.equal(response.body.claimed, false);
  assert.equal(response.body.observedBlock, 98);
  assert.equal(response.body.observedTimestamp, NOW / 1000);
  assert.equal((await f.call(TAROT_API_PATHS.prepare, { ...credentials, wallet: WALLET })).response.status, 409);
  f.state.blockNumber = 102;
  response = await f.call(TAROT_API_PATHS.status);
  assert.equal(response.body.claimed, true);
  assert.equal(response.body.observedBlock, 100);
  f.env.ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK = '101';
  assert.equal((await f.call(TAROT_API_PATHS.status)).response.status, 503);
});

test('Tarot rejects status and signing reads from another fork even when header hashes agree', async t => {
  const f = fixture(t);
  f.state.callHash = HASH;
  f.state.claimed = 1;
  assert.equal((await f.call(TAROT_API_PATHS.status)).response.status, 503);
  f.state.claimed = 0;
  assert.equal((await f.call(TAROT_API_PATHS.prepare, { ...credentials, wallet: WALLET })).response.status, 503);
});

test('Tarot rate limits access and preparation together, separates confirmation, and fails closed', async t => {
  const f = fixture(t);
  await f.call(TAROT_API_PATHS.status);
  await f.prepared();
  await f.confirm();
  assert.equal(f.limitKeys.access[0], f.limitKeys.access[1]);
  assert.equal(f.limitKeys.confirm.length, 1);
  f.env.TAROT_ACCESS_IP_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const calls = f.calls.length;
  const reads = f.dbReads();
  const denied = await f.call(TAROT_API_PATHS.status);
  assert.equal(denied.response.status, 429);
  assert.equal(denied.response.headers.get('Retry-After'), '60');
  assert.equal(f.calls.length, calls);
  assert.equal(f.dbReads(), reads);
  assert.equal((await f.call(TAROT_API_PATHS.status, credentials, { 'CF-Connecting-IP': '' })).response.status, 503);
  f.env.TAROT_ACCESS_IP_RATE_LIMITER = { limit: async () => ({ success: true }) };
  f.env.TAROT_PREPARE_RATE_LIMITER = { limit: async () => ({ success: false }) };
  assert.equal((await f.call(TAROT_API_PATHS.prepare, { ...credentials, wallet: WALLET })).response.status, 429);
  assert.equal(f.calls.length, calls);
});

test('Tarot rejects missing or malformed trusted IPs without a localhost-origin fallback', async t => {
  const f = fixture(t);
  for (const ip of ['', 'unknown', '256.1.2.3', '192.0.2.1:443', '192.0.2.1, 192.0.2.2', '[2001:db8::1]', '2001:db8:::1']) {
    for (const Origin of ['https://mons.shop', 'http://localhost:3000']) {
      assert.equal((await f.call(TAROT_API_PATHS.status, credentials, { Origin, 'CF-Connecting-IP': ip })).response.status, 503);
    }
  }
  assert.equal(f.limitKeys.access.length, 0);
  assert.equal(f.dbReads(), 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call(TAROT_API_PATHS.status, credentials, { 'CF-Connecting-IP': '2001:db8::1' })).response.status, 200);
  f.env.TAROT_ACCESS_IP_RATE_LIMITER = { limit: async () => { throw new Error('Unavailable limiter'); } };
  const reads = f.dbReads();
  assert.equal((await f.call(TAROT_API_PATHS.status)).response.status, 503);
  assert.equal(f.dbReads(), reads);
});

test('Tarot fails closed on unavailable admission, signer mismatch and invalid contract or chain state', async t => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.env.ETHEREUM_TAROT_SEPOLIA_ENABLED = 'false'; },
    (f: ReturnType<typeof fixture>) => { f.env.ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET = ''; },
    (f: ReturnType<typeof fixture>) => { f.state.signer = OTHER; },
    (f: ReturnType<typeof fixture>) => { f.state.chainId = 1; },
    (f: ReturnType<typeof fixture>) => { f.state.maximum = 777; },
    (f: ReturnType<typeof fixture>) => { f.state.initial = 778; },
    (f: ReturnType<typeof fixture>) => { f.state.mintingPaused = 1; },
    (f: ReturnType<typeof fixture>) => { f.state.mintingPaused = 2; },
    (f: ReturnType<typeof fixture>) => { f.state.offset = 778; },
    (f: ReturnType<typeof fixture>) => { f.state.lifetime = 601; },
    (f: ReturnType<typeof fixture>) => { f.state.claimed = 2; },
    (f: ReturnType<typeof fixture>) => { f.state.timestamp -= 601; },
    (f: ReturnType<typeof fixture>) => { f.state.afterCall = () => { f.state.canonicalHash = HASH; }; },
  ]) {
    const f = fixture(t);
    change(f);
    const response = await f.call(TAROT_API_PATHS.prepare, { ...credentials, wallet: WALLET });
    assert.equal(response.response.status, 503);
  }
});

test('Tarot confirms only the matching card and receipt after three canonical confirmations, including while paused', async t => {
  const f = fixture(t);
  const unavailable = (await f.confirm()).body;
  assert.equal(unavailable.status, 'pending');
  assert.equal(unavailable.blockNumber, null);
  assert.equal(unavailable.blockHash, null);
  await f.mined();
  f.env.ETHEREUM_TAROT_SEPOLIA_ENABLED = 'false';
  f.env.ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET = '';
  let response = await f.confirm();
  assert.equal(response.response.status, 200);
  assert.equal(response.body.status, 'confirmed');
  assert.equal(response.body.confirmations, 3);
  assert.equal(response.body.blockNumber, 98);
  assert.equal(response.body.blockHash, f.blockHash(98));
  assert.equal(response.body.receiptTokenId, tarotReceiptTokenId(1));
  assert.equal(response.response.headers.get('Cache-Control'), 'no-store');
  f.state.blockNumber = 99;
  const pending = (await f.confirm()).body;
  assert.equal(pending.status, 'pending');
  assert.equal(pending.blockNumber, 98);
  assert.equal(pending.blockHash, f.blockHash(98));
  f.state.blockNumber = 100;
  f.state.canonicalHash = HASH;
  response = await f.confirm();
  assert.equal(response.body.status, 'pending');
  assert.equal(response.body.confirmations, 0);
  assert.equal(response.body.blockNumber, null);
  assert.equal(response.body.blockHash, null);
});

test('DMX minting pause disables initial claims while preserving status and confirmation recovery', async t => {
  const f = fixture(t);
  await f.mined();
  f.state.mintingPaused = 1;
  f.state.claimed = 1;
  const response = await f.call(TAROT_API_PATHS.status);
  assert.equal(response.response.status, 200);
  assert.equal(response.body.claimed, true);
  assert.equal((response.body.config as TarotStatus['config']).enabled, false);
  f.state.claimed = 0;
  assert.equal((await f.call(TAROT_API_PATHS.prepare, { ...credentials, wallet: WALLET })).response.status, 503);
  assert.equal((await f.confirm()).body.status, 'confirmed');
});

test('Tarot rejects forged, unrelated and partial mint confirmations', async t => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.state.receipt!.logs = []; },
    f => { (f.state.receipt!.logs as unknown[]).pop(); },
    f => { (f.state.receipt!.logs as unknown[]).push((f.state.receipt!.logs as unknown[])[0]); },
    f => { (f.state.receipt!.logs as Record<string, unknown>[])[0].removed = true; },
    f => { (f.state.receipt!.logs as Record<string, unknown>[])[0].blockHash = HASH; },
    f => { f.state.transaction!.input = encodeTarotClaim(2, NOW / 1000 + 600, `0x${'11'.repeat(65)}`); },
    f => { f.state.transaction!.chainId = '0x1'; },
    f => { f.state.transaction!.value = '0x1'; },
    f => { (f.state.receipt!.logs as { topics: string[] }[])[1].topics[2] = encodeAbi(['address'], [OTHER]); },
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    await f.mined();
    mutate(f);
    assert.ok((await f.confirm()).response.status >= 400);
  }
});

test('Tarot recognizes failed claims without consuming credentials and supports successful contract-wallet claims', async t => {
  const f = fixture(t);
  await f.mined();
  f.state.receipt!.status = '0x0';
  f.state.receipt!.logs = [];
  const failed = (await f.confirm()).body;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.blockNumber, 98);
  assert.equal(failed.blockHash, f.blockHash(98));
  await f.prepared();
  await f.mined();
  f.state.receipt!.from = OTHER;
  f.state.receipt!.to = WALLET;
  f.state.transaction!.from = OTHER;
  f.state.transaction!.to = WALLET;
  f.state.transaction!.input = '0x1234';
  assert.equal((await f.confirm()).body.status, 'confirmed');
  f.state.receipt!.status = '0x0';
  assert.equal((await f.confirm()).response.status, 400);
});

test('Tarot credentials are constrained, deployment scoped and contain no plaintext fields', t => {
  const f = fixture(t);
  assert.deepEqual(f.db.prepare('PRAGMA table_info(tarot_claim_codes)').all().map(row => row.name),
    ['chain_id', 'contract_address', 'token_id', 'code_hash', 'created_at_ms', 'revoked_at_ms']);
  for (const [chain, contract, token, hash, created, revoked] of [
    [1, CONTRACT, 2, 'a'.repeat(64), NOW, null], [TAROT_CHAIN_ID, CONTRACT, 778, 'a'.repeat(64), NOW, null],
    [TAROT_CHAIN_ID, CONTRACT, 2, CODE, NOW, null], [TAROT_CHAIN_ID, CONTRACT, 2, 'a'.repeat(64), NOW, NOW - 1],
  ]) assert.throws(() => f.db.prepare('INSERT INTO tarot_claim_codes VALUES (?, ?, ?, ?, ?, ?)')
    .run(chain!, contract!, token!, hash!, created!, revoked ?? null));
  assert.equal(tarotRoutes.length, 3);
  assert.equal(tarotRoutes.find(route => route.path === TAROT_API_PATHS.prepare)?.commerceMutation, true);
  assert.ok(tarotRoutes.every(route => route.profileOriginGate && route.staff === 'skip'));
});
