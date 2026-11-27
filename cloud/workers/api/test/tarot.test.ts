import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ethereumSignerAddress, recoverEthereumAddress } from '../../../../shared/ethereum/crypto.ts';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.ts';
import { TAROT_API_PATHS, TAROT_CHAIN_ID, encodeTarotClaim, encodeTarotClaimTo, tarotCodeHashInput, tarotReceiptTokenId, tarotChainId,
  type TarotBackendClaim, type TarotPrepareResponse, type TarotStatus } from '../../../../shared/ethereum/tarot.ts';
import { TAROT_CLAIMED_TOPIC, tarotClaimDigest } from '../../../../shared/ethereum/tarotCrypto.ts';
import { handleTarotRequest, type TarotEnvironment } from '../src/tarot.ts';
import { tarotRoutes } from '../src/tarotRoutes.ts';
import { d1Database } from './commerceD1Harness.ts';
import type { TarotClaimInput, TarotClaimScope } from '../src/tarotClaimRelayer.ts';
import { TarotClaimRejected, type TarotClaimFailure } from '../src/tarotClaimRejection.ts';
import { TarotClaimRelayerStore, type TarotClaimSql } from '../src/tarotClaimRelayerStore.ts';

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
const BATCH_ID = '44444444-4444-4444-8444-444444444444';
type RpcRequest = { id: number; method: string; params: unknown[] };

function fixture(t: TestContext, testnet = true) {
  const chainId = tarotChainId(testnet);
  const scopedCredentials = { ...credentials, testnet };
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync('cloud/workers/api/ops-migrations/0014_tarot_claim_codes.sql', 'utf8'));
  db.exec(readFileSync('cloud/workers/api/ops-migrations/0017_dmx_sepolia_retirement.sql', 'utf8'));
  for (const tokenId of [1, 777]) db.prepare('INSERT INTO tarot_claim_codes VALUES (?, ?, ?, ?, ?, NULL)')
    .run(TAROT_CHAIN_ID, CONTRACT, tokenId, createHash('sha256').update(tarotCodeHashInput({ chainId: TAROT_CHAIN_ID,
      contractAddress: CONTRACT, tokenId, code: CODE })).digest('hex'), NOW);
  if (!testnet) {
    for (const name of ['0015_dmx_mainnet_claim_staging.sql', '0016_dmx_mainnet_bound_claim_codes.sql']) {
      db.exec(readFileSync(`cloud/workers/api/ops-migrations/${name}`, 'utf8'));
    }
    db.prepare(`INSERT INTO dmx_mainnet_claim_batches
      (batch_id,chain_id,collection_key,status,contract_address,credential_count,credential_set_sha256,created_at_ms,verified_at_ms,bound_at_ms)
      VALUES (?,1,'dmx-mainnet-v1','bound',?,777,?,?,?,?)`).run(BATCH_ID, CONTRACT, 'a'.repeat(64), NOW, NOW, NOW);
    for (const tokenId of [1, 777]) db.prepare(`INSERT INTO dmx_mainnet_bound_claim_codes
      (batch_id,chain_id,contract_address,token_id,code_hash,created_at_ms,revoked_at_ms) VALUES (?,1,?,?,?,?,NULL)`)
      .run(BATCH_ID, CONTRACT, tokenId, createHash('sha256').update(tarotCodeHashInput({ chainId: 1,
        contractAddress: CONTRACT, tokenId, code: CODE })).digest('hex'), NOW);
  }
  const calls: RpcRequest[] = [];
  const blockNumbers = new Map<string, number>();
  const limitKeys = { access: [] as string[], prepare: [] as string[], confirm: [] as string[] };
  const limiter = (kind: keyof typeof limitKeys): RateLimit => ({ limit: async ({ key }) => { limitKeys[kind].push(key); return { success: true }; } });
  let dbReads = 0;
  const env: TarotEnvironment = {
    OPS_DB: d1Database(db, () => { dbReads++; }), ALCHEMY_MI_NOTE_API_KEY: 'test', ETHEREUM_111K_RPC_URL: '',
    ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK: '1',
    ETHEREUM_TAROT_SEPOLIA_ENABLED: 'true', ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET: KEY,
    ...(!testnet ? { ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_TAROT_MAINNET_DEPLOYMENT_BLOCK: '1',
      ETHEREUM_TAROT_MAINNET_ENABLED: 'true', ETHEREUM_TAROT_MAINNET_SIGNER_SECRET: KEY } : {}),
    TAROT_ACCESS_IP_RATE_LIMITER: limiter('access'), TAROT_PREPARE_RATE_LIMITER: limiter('prepare'), TAROT_CONFIRM_IP_RATE_LIMITER: limiter('confirm'),
  };
  const state = { chainId: Number(chainId), blockNumber: 100, canonicalHash: BLOCK_HASH, timestamp: NOW / 1000,
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
  const call = async (path: string, body: unknown = scopedCredentials, headers: Record<string, string> = {}, method = 'POST') => {
    const request = new Request(`https://api.mons.shop${path}`, { method,
      headers: { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', 'X-Mons-CSRF': '1', ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    const response = await handleTarotRequest(request, env, path, { nowMs: () => NOW, fetch: providerFetch });
    return { response, body: await response.json() as Record<string, unknown> };
  };
  const prepared = async (tokenId = 1) => {
    const response = await call(TAROT_API_PATHS.prepare, { ...scopedCredentials, tokenId, wallet: WALLET });
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
      chainId: ethereumHexQuantity(chainId), value: '0x0', input: quote.transaction.data };
    return quote;
  };
  const confirm = () => call(TAROT_API_PATHS.confirm, { ...scopedCredentials, wallet: WALLET, transactionHash: HASH });
  return { env, state, calls, db, call, prepared, mined, confirm, blockHash, limitKeys,
    credentials: scopedCredentials, dbReads: () => dbReads };
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

test('retired Sepolia scopes reject retained credentials before RPC or signing', async t => {
  const f = fixture(t);
  const retained = f.db.prepare('SELECT * FROM tarot_claim_codes ORDER BY token_id').all();
  f.db.prepare('INSERT INTO dmx_retired_sepolia_deployments VALUES (?, ?, ?, ?)').run(TAROT_CHAIN_ID, CONTRACT, OTHER, NOW);
  for (const [path, body] of [
    [TAROT_API_PATHS.status, credentials],
    [TAROT_API_PATHS.prepare, { ...credentials, wallet: WALLET }],
    [TAROT_API_PATHS.confirm, { ...credentials, wallet: WALLET, transactionHash: HASH }],
  ] as const) {
    const result = await f.call(path, body);
    assert.equal(result.response.status, 503);
    assert.equal((result.body.error as { code: string }).code, 'unavailable');
    assert.equal(result.body.signature, undefined);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.limitKeys.prepare.length, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM tarot_claim_codes ORDER BY token_id').all(), retained);
});

test('Sepolia retirement does not block another contract or the same address on mainnet', async t => {
  for (const testnet of [true, false]) {
    const f = fixture(t, testnet);
    f.db.prepare('INSERT INTO dmx_retired_sepolia_deployments VALUES (?, ?, ?, ?)')
      .run(TAROT_CHAIN_ID, testnet ? OTHER : CONTRACT, testnet ? CONTRACT : OTHER, NOW);
    const result = await f.call(TAROT_API_PATHS.status);
    assert.equal(result.response.status, 200);
    assert.equal((result.body as unknown as TarotStatus).config.enabled, true);
    assert.equal((await f.prepared()).transaction.chainId, tarotChainId(testnet));
  }
});

test('Tarot rejects malformed networks, extra fields and malformed requests before database or RPC work', async t => {
  const f = fixture(t);
  for (const body of [{ ...credentials, testnet: 'false' }, { ...credentials, testnet: null }, { ...credentials, tokenId: 0 },
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

test('unconfigured mainnet requests stay unavailable without rejecting credentials or falling back to Sepolia', async t => {
  const f = fixture(t);
  for (const body of [{ tokenId: 1, code: CODE }, { ...credentials, testnet: false }]) {
    for (const path of [TAROT_API_PATHS.status, TAROT_API_PATHS.prepare]) {
      const response = await f.call(path, path === TAROT_API_PATHS.prepare ? { ...body, wallet: WALLET } : body);
      assert.equal(response.response.status, 503);
      assert.equal((response.body.error as { code: string }).code, 'unavailable');
    }
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.dbReads(), 0);
});

test('mainnet defaults and explicit false use the bound mainnet credentials and signer', async t => {
  const f = fixture(t, false);
  f.env.ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET = `0x${'55'.repeat(32)}`;
  const response = await f.call(TAROT_API_PATHS.status, { tokenId: 1, code: CODE });
  assert.equal(response.response.status, 200);
  const config = (response.body as unknown as TarotStatus).config;
  assert.equal(config.testnet, false);
  assert.equal(config.chainId, 1);
  assert.equal(config.enabled, true);
  assert.equal(config.explorerUrl, 'https://etherscan.io');
  for (const tokenId of [1, 777]) {
    const quote = await f.prepared(tokenId);
    assert.equal(quote.transaction.chainId, 1);
    assert.equal(quote.transaction.to, CONTRACT);
    assert.equal(recoverEthereumAddress(tarotClaimDigest({ chainId: 1, contractAddress: CONTRACT,
      wallet: WALLET, tokenId, deadline: quote.deadline }), quote.signature), SIGNER);
    assert.notEqual(recoverEthereumAddress(tarotClaimDigest({ chainId: TAROT_CHAIN_ID, contractAddress: CONTRACT,
      wallet: WALLET, tokenId, deadline: quote.deadline }), quote.signature), SIGNER);
  }
});

test('mainnet retains credentials while the staged batch is unbound or points at another deployment', async t => {
  const f = fixture(t, false);
  f.db.prepare("UPDATE dmx_mainnet_claim_batches SET status='staged',contract_address=NULL,bound_at_ms=NULL").run();
  for (const path of [TAROT_API_PATHS.status, TAROT_API_PATHS.prepare]) {
    const response = await f.call(path, path === TAROT_API_PATHS.prepare ? { ...f.credentials, wallet: WALLET } : f.credentials);
    assert.equal(response.response.status, 503);
    assert.equal((response.body.error as { code: string }).code, 'unavailable');
  }
  f.db.prepare("UPDATE dmx_mainnet_claim_batches SET status='bound',contract_address=?,bound_at_ms=?").run(OTHER, NOW);
  assert.equal((await f.call(TAROT_API_PATHS.status)).response.status, 503);
  assert.equal(f.calls.length, 0);
});

test('mainnet does not accept staging or Sepolia hashes, revoked credentials, or a missing mainnet signer', async t => {
  const f = fixture(t, false);
  const request = { ...f.credentials, wallet: WALLET };
  delete f.env.ETHEREUM_TAROT_MAINNET_SIGNER_SECRET;
  assert.equal((await f.call(TAROT_API_PATHS.prepare, request)).response.status, 503);
  f.env.ETHEREUM_TAROT_MAINNET_SIGNER_SECRET = KEY;
  for (const codeHash of [createHash('sha256').update(tarotCodeHashInput({ chainId: TAROT_CHAIN_ID,
    contractAddress: CONTRACT, tokenId: 1, code: CODE })).digest('hex'),
    createHash('sha256').update(`mons:dmx:mainnet-staging:v1:1:${BATCH_ID}:1:${CODE}`).digest('hex')]) {
    f.db.prepare('UPDATE dmx_mainnet_bound_claim_codes SET code_hash=? WHERE token_id=1').run(codeHash);
    assert.equal((await f.call(TAROT_API_PATHS.prepare, request)).response.status, 401);
  }
  const valid = createHash('sha256').update(tarotCodeHashInput({ chainId: 1,
    contractAddress: CONTRACT, tokenId: 1, code: CODE })).digest('hex');
  f.db.prepare('UPDATE dmx_mainnet_bound_claim_codes SET code_hash=?,revoked_at_ms=? WHERE token_id=1').run(valid, NOW);
  assert.equal((await f.call(TAROT_API_PATHS.status)).response.status, 401);
});

test('mainnet confirms its own chain and keeps recovery readable while disabled or paused', async t => {
  const f = fixture(t, false);
  await f.mined();
  f.state.claimed = 1;
  f.state.mintingPaused = 1;
  f.env.ETHEREUM_TAROT_MAINNET_ENABLED = 'false';
  delete f.env.ETHEREUM_TAROT_MAINNET_SIGNER_SECRET;
  const status = await f.call(TAROT_API_PATHS.status);
  assert.equal(status.response.status, 200);
  assert.equal(status.body.claimed, true);
  assert.equal((status.body.config as TarotStatus['config']).enabled, false);
  assert.equal((await f.confirm()).body.status, 'confirmed');
  f.state.chainId = TAROT_CHAIN_ID;
  assert.equal((await f.confirm()).response.status, 503);
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

test('Tarot confirms direct and relayed claimTo transactions and identifies failed direct claims', async t => {
  for (const testnet of [false, true]) {
    const f = fixture(t, testnet);
    const quote = await f.mined();
    const input = encodeTarotClaimTo(WALLET, 1, quote.deadline, quote.signature);
    f.state.transaction!.input = `0x${input.slice(2).toUpperCase()}`;
    const direct = await f.confirm();
    assert.equal(direct.response.status, 200);
    assert.equal(direct.body.status, 'confirmed');
    f.state.receipt!.from = OTHER;
    f.state.transaction!.from = OTHER;
    assert.equal((await f.confirm()).body.status, 'confirmed');
    f.state.receipt!.status = '0x0';
    f.state.receipt!.logs = [];
    assert.equal((await f.confirm()).response.status, 400);
    f.state.receipt!.from = WALLET;
    f.state.transaction!.from = WALLET;
    const failed = await f.confirm();
    assert.equal(failed.response.status, 200);
    assert.equal(failed.body.status, 'failed');
    assert.equal(failed.body.confirmations, 3);
  }
});

test('Tarot rejects mismatched, malformed and paid direct claimTo transactions', async t => {
  const f = fixture(t, false);
  const quote = await f.mined();
  const input = encodeTarotClaimTo(WALLET, 1, quote.deadline, quote.signature);
  const malformed = [
    encodeTarotClaimTo(OTHER, 1, quote.deadline, quote.signature),
    encodeTarotClaimTo(WALLET, 2, quote.deadline, quote.signature),
    encodeTarotClaimTo(WALLET, 1, quote.deadline, `0x${'11'.repeat(64)}`),
    encodeCall('claimTo(address,uint256,uint256,bytes)', ['address', 'uint256', 'uint256', 'bytes'],
      [WALLET, 1, BigInt(Number.MAX_SAFE_INTEGER) + 1n, quote.signature]),
    `0xdeadbeef${input.slice(10)}`, input.slice(0, -2), `${input}00`,
    `${input.slice(0, 10)}01${input.slice(12)}`,
  ];
  for (const receiptStatus of ['0x1', '0x0']) {
    f.state.receipt!.status = receiptStatus;
    if (receiptStatus === '0x0') f.state.receipt!.logs = [];
    for (const data of malformed) {
      f.state.transaction!.input = data;
      const result = await f.confirm();
      assert.equal(result.response.status, 400);
      assert.equal((result.body.error as { code: string }).code, 'invalid-argument');
    }
    f.state.transaction!.input = input;
    f.state.transaction!.value = '0x1';
    assert.equal((await f.confirm()).response.status, 400);
    f.state.transaction!.value = '0x0';
  }
  f.state.receipt!.status = '0x1';
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
  assert.equal(tarotRoutes.length, 4);
  assert.equal(tarotRoutes.find(route => route.path === TAROT_API_PATHS.prepare)?.commerceMutation, true);
  assert.equal(tarotRoutes.find(route => route.path === TAROT_API_PATHS.claim)?.commerceMutation, true);
  assert.ok(tarotRoutes.every(route => route.profileOriginGate && route.staff === 'skip'));
});

function sponsoredFixture(f: ReturnType<typeof fixture>) {
  const submitted: TarotClaimInput[] = [];
  const reads: Array<TarotClaimScope & { requestId?: string }> = [];
  const attempts = new Map<string, TarotBackendClaim>();
  const rejections = new Map<string, TarotClaimFailure>();
  let latest: TarotBackendClaim | null = null;
  f.env.ETHEREUM_TAROT_MAINNET_SPONSORSHIP_ENABLED = 'true';
  f.env.ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED = 'true';
  f.env.TAROT_CLAIM_RELAYER = { getByName(name) {
    assert.equal(name, `tarot-claims:${tarotChainId(f.credentials.testnet)}`);
    return {
      async status(scope) { reads.push(scope); return scope.requestId ? attempts.get(scope.requestId) ?? null : latest; },
      async claim(input) {
        const rejection = rejections.get(input.requestId);
        if (rejection) return { rejection };
        submitted.push(input);
        latest = { requestId: input.requestId, recipient: input.recipient, state: 'pending', transactionHash: HASH };
        attempts.set(input.requestId, latest);
        return latest;
      },
      async reject(input) {
        const prior = attempts.get(input.requestId);
        if (prior) return prior;
        const rejection = rejections.get(input.requestId);
        if (rejection) return { rejection };
        if (latest && latest.state !== 'failed') return latest;
        rejections.set(input.requestId, input.failure);
        return { rejection: input.failure };
      },
    };
  } };
  const request = { ...f.credentials, recipient: WALLET, requestId: '55555555-5555-4555-8555-555555555555' };
  return { submitted, reads, attempts, request, setLatest(value: TarotBackendClaim | null) { latest = value; } };
}

for (const testnet of [true, false]) test(`sponsored Tarot ${testnet ? 'Sepolia' : 'mainnet'} claims are authenticated and recover through status`, async t => {
  const f = fixture(t, testnet);
  const backend = sponsoredFixture(f);
  const result = await f.call(TAROT_API_PATHS.claim, backend.request);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.backendClaim, { requestId: backend.request.requestId, recipient: WALLET, state: 'pending', transactionHash: HASH });
  assert.equal(backend.submitted.length, 1);
  assert.deepEqual(backend.submitted[0], { chainId: tarotChainId(testnet), contractAddress: CONTRACT, tokenId: 1,
    recipient: WALLET, requestId: backend.request.requestId,
    codeHash: createHash('sha256').update(tarotCodeHashInput({ chainId: tarotChainId(testnet), contractAddress: CONTRACT, tokenId: 1, code: CODE })).digest('hex') });
  assert.ok(!JSON.stringify(backend.submitted).includes(CODE));
  const refreshed = await f.call(TAROT_API_PATHS.status);
  assert.deepEqual(refreshed.body.backendClaim, result.body.backendClaim);
  assert.equal(refreshed.body.claimed, false);
  assert.equal((await f.call(TAROT_API_PATHS.prepare, { ...f.credentials, wallet: WALLET })).response.status, 409);
  f.state.claimed = 1;
  assert.equal((await f.call(TAROT_API_PATHS.status)).body.claimed, true);
});

test('sponsored retries reuse the original attempt before resolving a changed recipient', async t => {
  const f = fixture(t);
  const backend = sponsoredFixture(f);
  const first = await f.call(TAROT_API_PATHS.claim, backend.request);
  for (const requestId of [backend.request.requestId, '66666666-6666-4666-8666-666666666666']) {
    const replay = await f.call(TAROT_API_PATHS.claim, { ...backend.request, requestId, recipient: 'changed.eth' });
    assert.deepEqual(replay.body, first.body);
  }
  assert.equal(backend.submitted.length, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.limitKeys.prepare.length, 1);
  backend.setLatest(null);
  backend.attempts.set(backend.request.requestId, { requestId: backend.request.requestId,
    recipient: WALLET, state: 'failed', transactionHash: null, error: 'Insufficient funding.' });
  const replay = await f.call(TAROT_API_PATHS.claim, backend.request);
  assert.equal((replay.body.backendClaim as TarotBackendClaim).state, 'failed');
  assert.equal(backend.submitted.length, 1);
});

test('invalid sponsored credentials cannot read stored recipients or start resolution', async t => {
  const f = fixture(t);
  const backend = sponsoredFixture(f);
  for (const path of [TAROT_API_PATHS.claim, TAROT_API_PATHS.status]) {
    const request = path === TAROT_API_PATHS.claim ? backend.request : f.credentials;
    assert.equal((await f.call(path, { ...request, code: BAD_CODE })).response.status, 401);
  }
  f.db.prepare('UPDATE tarot_claim_codes SET revoked_at_ms = created_at_ms').run();
  assert.equal((await f.call(TAROT_API_PATHS.claim, backend.request)).response.status, 401);
  assert.equal(backend.reads.length, 0);
  assert.equal(backend.submitted.length, 0);
  assert.equal(f.calls.length, 0);
});

test('recipient validation and disabled sponsorship cannot dispatch claims', async t => {
  const f = fixture(t);
  const backend = sponsoredFixture(f);
  for (const [index, recipient] of ['0x1234', `0x${'0'.repeat(40)}`, 'invalid'].entries()) {
    const result = await f.call(TAROT_API_PATHS.claim, { ...backend.request, recipient,
      requestId: `66666666-6666-4666-8666-${String(index).padStart(12, '0')}` });
    assert.equal(result.response.status, 400);
    assert.deepEqual((result.body.error as { details: unknown }).details, { field: 'recipient', claimAccepted: false });
  }
  f.env.ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED = 'false';
  assert.equal((await f.call(TAROT_API_PATHS.claim, backend.request)).response.status, 503);
  assert.equal(backend.submitted.length, 0);
  const stored: TarotBackendClaim = { requestId: backend.request.requestId, recipient: WALLET, state: 'pending', transactionHash: HASH };
  backend.setLatest(stored);
  assert.deepEqual((await f.call(TAROT_API_PATHS.status)).body.backendClaim, stored);
  assert.deepEqual((await f.call(TAROT_API_PATHS.claim, backend.request)).body.backendClaim, stored);
});

function durableAdmissionFixture(f: ReturnType<typeof fixture>) {
  const sql: TarotClaimSql = { exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>) {
    const statement = f.db.prepare(query);
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows as T[] };
  } };
  const atomic = <T>(action: () => T): T => {
    f.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); f.db.exec('COMMIT'); return result; }
    catch (error) { f.db.exec('ROLLBACK'); throw error; }
  };
  const store = new TarotClaimRelayerStore(sql, atomic);
  const present = (value: ReturnType<typeof store.admit>): TarotBackendClaim => ({
    requestId: value.requestId, recipient: value.recipient, state: value.state, transactionHash: value.signed?.transactionHash ?? null,
    finalized: value.finalized, revision: value.revision,
  });
  f.env.ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED = 'true';
  f.env.TAROT_CLAIM_RELAYER = { getByName() { return {
    async status(scope) { const value = store.status(scope); return value ? present(value) : null; },
    async claim(input) {
      try { return present(store.admit(input, NOW)); }
      catch (error) { if (error instanceof TarotClaimRejected) return { rejection: error.rejection }; throw error; }
    },
    async reject(input) { const value = store.reject(input, NOW); return 'rejection' in value ? value : present(value); },
  }; } };
  const request = { ...f.credentials, recipient: 'example.eth', requestId: '55555555-5555-4555-8555-555555555555' };
  const call = async (providerFetch: typeof fetch, body = request) => {
    const response = await handleTarotRequest(new Request(`https://api.mons.shop${TAROT_API_PATHS.claim}`, {
      method: 'POST', headers: { Origin: 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1',
        'Content-Type': 'application/json', 'X-Mons-CSRF': '1' }, body: JSON.stringify(body),
    }), f.env, TAROT_API_PATHS.claim, { nowMs: () => NOW, fetch: providerFetch });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const resolve: typeof fetch = async (_url, init) => {
    const rpc = JSON.parse(String(init?.body)) as RpcRequest;
    return Response.json({ id: rpc.id, jsonrpc: '2.0', result: rpc.method === 'eth_chainId' ? '0x1'
      : encodeAbi(['bytes', 'address'], [encodeAbi(['bytes'], [WALLET]), WALLET]) });
  };
  return { store, request, call, resolve };
}

test('a concurrent accepted claim wins over a later ENS preflight failure for the same request', async t => {
  const f = fixture(t);
  const backend = durableAdmissionFixture(f);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = backend.call(async () => {
    started.resolve(); await release.promise; throw new Error('Temporary ENS transport failure.');
  });
  await started.promise;
  const accepted = await backend.call(backend.resolve);
  assert.equal(accepted.status, 200);
  assert.equal((accepted.body.backendClaim as TarotBackendClaim).state, 'submitting');
  release.resolve();
  assert.deepEqual(await first, accepted);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claim_rejections').get()?.count, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claim_attempts').get()?.count, 1);
});

test('a concurrent durable rejection prevents late ENS admission and replays without reserving a nonce', async t => {
  const f = fixture(t);
  const backend = durableAdmissionFixture(f);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delayed = backend.call(async (url, init) => {
    started.resolve(); await release.promise; return backend.resolve(url, init);
  });
  await started.promise;
  const rejected = await backend.call(async () => { throw new Error('Temporary ENS transport failure.'); });
  assert.equal(rejected.status, 503);
  assert.deepEqual((rejected.body.error as { details: unknown }).details, { claimAccepted: false });
  release.resolve();
  assert.deepEqual(await delayed, rejected);
  assert.deepEqual(await backend.call(backend.resolve, { ...backend.request, recipient: WALLET }), rejected);
  assert.deepEqual(await backend.call(backend.resolve, { ...backend.request, recipient: 'invalid' }), rejected);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claim_rejections').get()?.count, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claim_attempts').get()?.count, 0);
  assert.equal(backend.store.account(), null);
  assert.equal(backend.store.outstandingFeeWei(), '0');
  assert.equal((await backend.call(backend.resolve, { ...backend.request, recipient: WALLET,
    requestId: '66666666-6666-4666-8666-666666666666' })).status, 200);
});

test('definitive claim rejection requires the durable relayer to be available', async t => {
  const f = fixture(t);
  const backend = durableAdmissionFixture(f);
  delete f.env.TAROT_CLAIM_RELAYER;
  const missing = await backend.call(backend.resolve);
  assert.equal(missing.status, 503);
  assert.equal((missing.body.error as { details?: unknown }).details, undefined);
  f.env.TAROT_CLAIM_RELAYER = { getByName() { return {
    async status() { return null; }, async claim() { throw new Error('Unavailable'); },
    async reject() { throw new Error('Unavailable'); },
  }; } };
  const unavailable = await backend.call(backend.resolve, { ...backend.request, recipient: 'invalid' });
  assert.equal(unavailable.status, 503);
  assert.equal((unavailable.body.error as { details?: unknown }).details, undefined);
});

test('authenticated request-specific status returns the historical attempt instead of a newer retry', async t => {
  const f = fixture(t);
  const backend = sponsoredFixture(f);
  const historical: TarotBackendClaim = { requestId: backend.request.requestId, recipient: WALLET,
    state: 'failed', transactionHash: HASH };
  const current: TarotBackendClaim = { requestId: '66666666-6666-4666-8666-666666666666', recipient: OTHER,
    state: 'pending', transactionHash: `0x${'cc'.repeat(32)}` };
  backend.attempts.set(historical.requestId, historical);
  backend.setLatest(current);
  assert.deepEqual((await f.call(TAROT_API_PATHS.status, { ...f.credentials, requestId: historical.requestId })).body.backendClaim, historical);
  assert.deepEqual((await f.call(TAROT_API_PATHS.status)).body.backendClaim, current);
  assert.equal((await f.call(TAROT_API_PATHS.status, { ...f.credentials, requestId: '77777777-7777-4777-8777-777777777777' })).body.backendClaim, null);
  assert.equal((await f.call(TAROT_API_PATHS.status, { ...f.credentials, requestId: 'not-a-uuid' })).response.status, 400);
  const readsBefore = backend.reads.length;
  assert.equal((await f.call(TAROT_API_PATHS.status, { ...f.credentials, requestId: historical.requestId, code: BAD_CODE })).response.status, 401);
  assert.equal(backend.reads.length, readsBefore);
});

test('a signed failure blocks alternate claim paths until finality', async t => {
  const f = fixture(t);
  const backend = sponsoredFixture(f);
  for (const finalized of [undefined, false]) {
    const stored: TarotBackendClaim = { requestId: backend.request.requestId, recipient: WALLET,
      state: 'failed', transactionHash: HASH, ...(finalized === undefined ? {} : { finalized }) };
    backend.setLatest(stored);
    assert.equal((await f.call(TAROT_API_PATHS.prepare, { ...f.credentials, wallet: WALLET })).response.status, 409);
    const response = await f.call(TAROT_API_PATHS.claim, { ...backend.request,
      requestId: '66666666-6666-4666-8666-666666666666', recipient: 'invalid' });
    assert.deepEqual(response.body.backendClaim, stored);
  }
  assert.equal(backend.submitted.length, 0);
  assert.equal(f.calls.length, 0);
});

test('a finalized paid failure rejects new sponsorship but allows a wallet-funded retry', async t => {
  const f = fixture(t);
  const backend = durableAdmissionFixture(f);
  await backend.call(backend.resolve);
  const scope: TarotClaimScope = { chainId: TAROT_CHAIN_ID, contractAddress: CONTRACT, tokenId: 1 };
  const attempt = backend.store.status(scope)!;
  backend.store.pinAccount(TAROT_CHAIN_ID, OTHER);
  backend.store.persistSigned(attempt.id, { rawTransaction: '0x0201', transactionHash: HASH, nonce: '0',
    authorizationDeadline: Math.floor(NOW / 1000) + 600, maximumFeeWei: '1000', relayerAddress: OTHER }, NOW);
  backend.store.observe(attempt.id, { status: 'failed', blockNumber: 98, blockHash: BLOCK_HASH, finalized: true }, NOW);
  const next = { ...backend.request, requestId: '66666666-6666-4666-8666-666666666666', recipient: WALLET };
  const rejected = await backend.call(backend.resolve, next);
  assert.equal(rejected.status, 409);
  assert.deepEqual((rejected.body.error as { details: unknown }).details, { kind: 'sponsorship-limit', claimAccepted: false });
  assert.deepEqual(await backend.call(backend.resolve, { ...next, recipient: OTHER }), rejected);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM claim_attempts').get()?.count, 1);
  assert.equal((await f.call(TAROT_API_PATHS.prepare, { ...f.credentials, wallet: WALLET })).response.status, 200);
});
