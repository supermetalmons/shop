import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ethereumSignerAddress, recoverEthereumAddress, signDigest } from '../../../../shared/ethereum/crypto.ts';
import {
  PRE111K_API_PATHS, PRE111K_MAX_RELICS, PRE111K_TREASURY, encodePre111kReservation, isPre111kPriceWei, resolvePre111kConfig,
  type Pre111kConfirmResponse, type Pre111kNetwork, type Pre111kPrepareResponse, type Pre111kStatus,
} from '../../../../shared/ethereum/pre111k.ts';
import { PRE111K_RESERVED_TOPIC, pre111kReservationDigest } from '../../../../shared/ethereum/pre111kCrypto.ts';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.ts';
import { handlePre111kRequest, type Pre111kEnvironment } from '../src/pre111k.ts';
import { pre111kRoutes } from '../src/pre111kRoutes.ts';

const NOW = 2_000_000_000_000;
const CONTRACT = `0x${'11'.repeat(20)}`;
const WALLET = `0x${'22'.repeat(20)}`;
const OTHER = `0x${'33'.repeat(20)}`;
const KEY = `0x${'44'.repeat(32)}`;
const SIGNER = ethereumSignerAddress(KEY);
const HASH = `0x${'aa'.repeat(32)}`;
const BLOCK_HASH = `0x${'bb'.repeat(32)}`;
const ACCESS_CODE = 'TESTACCESS';
const SECOND_ACCESS_CODE = 'OTHERACCESS';
const prices = { mainnet: '2300000000000000000', devnet: '2300000000000000' };

type RpcRequest = { id: number; method: string; params: unknown[] };
function fixture(network: Pre111kNetwork = 'devnet') {
  const config = resolvePre111kConfig(network, { contractAddress: CONTRACT, enabled: true, deploymentBlock: 1, priceWei: prices[network] });
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  const env: Pre111kEnvironment = {
    ALCHEMY_MI_NOTE_API_KEY: 'test', ETHEREUM_111K_RPC_URL: '', PUBLIC_SHOP_RATE_LIMITER: limiter,
    PREORDER_PREPARE_RATE_LIMITER: limiter, PREORDER_PREPARE_IP_RATE_LIMITER: limiter,
    ETHEREUM_PRE111K_ACCESS_CODES: JSON.stringify([ACCESS_CODE, SECOND_ACCESS_CODE]),
    ETHEREUM_PRE111K_MAINNET_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_PRE111K_MAINNET_DEPLOYMENT_BLOCK: '1', ETHEREUM_PRE111K_MAINNET_ENABLED: 'true',
    ETHEREUM_PRE111K_SEPOLIA_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_PRE111K_SEPOLIA_DEPLOYMENT_BLOCK: '1', ETHEREUM_PRE111K_SEPOLIA_ENABLED: 'true',
    ETHEREUM_PRE111K_MAINNET_PRICE_WEI: prices.mainnet, ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI: prices.devnet,
    ETHEREUM_PRE111K_MAINNET_SIGNER_SECRET: KEY, ETHEREUM_PRE111K_SEPOLIA_SIGNER_SECRET: KEY,
  };
  const state = {
    chainId: config.chainId, blockNumber: 100, canonicalHash: BLOCK_HASH, timestamp: NOW / 1000,
    total: 4, reserved: 2, treasury: PRE111K_TREASURY, maximum: PRE111K_MAX_RELICS, signer: String(SIGNER),
    lifetime: 600, receipt: null as Record<string, unknown> | null, transaction: null as Record<string, unknown> | null,
    calls: [] as RpcRequest[], urls: [] as string[], afterCall: null as (() => void) | null,
  };
  function result(payload: RpcRequest): unknown {
    state.calls.push(payload);
    if (payload.method === 'eth_chainId') return ethereumHexQuantity(state.chainId);
    if (payload.method === 'eth_blockNumber') return ethereumHexQuantity(state.blockNumber);
    if (payload.method === 'eth_getBlockByNumber') return { hash: state.canonicalHash,
      number: payload.params[0] === 'latest' ? ethereumHexQuantity(state.blockNumber) : payload.params[0], timestamp: ethereumHexQuantity(state.timestamp) };
    if (payload.method === 'eth_getTransactionReceipt') return state.receipt;
    if (payload.method === 'eth_getTransactionByHash') return state.transaction;
    assert.equal(payload.method, 'eth_call');
    const transaction = payload.params[0] as { to: string; data: string };
    assert.equal(transaction.to, CONTRACT);
    const signature = (name: string) => encodeCall(`${name}()`, [], []);
    const values: Record<string, [string, unknown]> = {
      [signature('treasury')]: ['address', state.treasury],
      [signature('MAX_RELICS')]: ['uint256', state.maximum], [signature('MAX_AUTHORIZATION_LIFETIME')]: ['uint256', state.lifetime],
      [signature('quoteSigner')]: ['address', state.signer], [signature('totalReserved')]: ['uint256', state.total],
      [encodeCall('reservedRelics(address)', ['address'], [WALLET])]: ['uint256', state.reserved],
      [encodeCall('reservedRelics(address)', ['address'], [ZERO_ADDRESS])]: ['uint256', 0],
    };
    const value = values[transaction.data];
    assert.ok(value, 'Unexpected reservation contract read');
    const encoded = encodeAbi([value[0]], [value[1]]);
    state.afterCall?.();
    return encoded;
  }
  const providerFetch: typeof fetch = async (input, init) => {
    state.urls.push(String(input));
    const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
    const respond = (payload: RpcRequest) => ({ jsonrpc: '2.0', id: payload.id, result: result(payload) });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(respond) : respond(body)), { headers: { 'Content-Type': 'application/json' } });
  };
  async function call(path: string, body?: unknown, options: { origin?: string; csrf?: string; method?: string } = {}) {
    const request = new Request(`https://api.mons.shop${path}`, {
      method: options.method || (body === undefined ? 'GET' : 'POST'),
      headers: { Origin: options.origin || 'https://mons.shop', 'CF-Connecting-IP': '192.0.2.1',
        'Content-Type': 'application/json', 'X-Mons-CSRF': options.csrf ?? '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await handlePre111kRequest(request, env, path.split('?')[0], { nowMs: () => NOW, fetch: providerFetch });
    return { response, body: await response.json() as Record<string, unknown> };
  }
  async function prepared() {
    const result = await call(PRE111K_API_PATHS.prepare, { network, wallet: WALLET, code: ACCESS_CODE });
    assert.equal(result.response.status, 200);
    return result.body as unknown as Pre111kPrepareResponse;
  }
  async function mined(status = '0x1') {
    const quote = await prepared();
    state.transaction = { hash: HASH, from: WALLET, to: CONTRACT, input: quote.transaction.data, value: quote.transaction.value,
      chainId: ethereumHexQuantity(config.chainId), blockNumber: '0x62', blockHash: BLOCK_HASH };
    state.receipt = { transactionHash: HASH, from: WALLET, to: CONTRACT, blockNumber: '0x62', blockHash: BLOCK_HASH, status,
      logs: status === '0x1' ? [{ address: CONTRACT, blockNumber: '0x62', blockHash: BLOCK_HASH, transactionHash: HASH,
        topics: [PRE111K_RESERVED_TOPIC, encodeAbi(['address'], [WALLET]), encodeAbi(['uint256'], [quote.nonce])],
        data: encodeAbi(['uint256'], [state.total + 1]), logIndex: '0x0' }] : [] };
    return quote;
  }
  const confirm = () => call(PRE111K_API_PATHS.confirm, { network, wallet: WALLET, transactionHash: HASH });
  return { env, config, state, call, prepared, mined, confirm };
}

test('pre111k digest and calldata match the Solidity fixture', () => {
  const fixture = JSON.parse(readFileSync('onchain/ethereum/fixtures/pre111k.json', 'utf8'));
  const digest = pre111kReservationDigest({ ...fixture, contractAddress: fixture.verifyingContract });
  assert.equal(digest, fixture.digest);
  assert.equal(signDigest(fixture.testPrivateKey, digest), fixture.signature);
  assert.equal(recoverEthereumAddress(digest, fixture.signature), fixture.signer.toLowerCase());
  assert.equal(encodePre111kReservation(fixture.nonce, fixture.deadline, fixture.signature), fixture.calldata);
});

test('pre111k verifies either access code without a wallet, signer, deployment, or RPC', async () => {
  const f = fixture();
  f.env.ETHEREUM_PRE111K_MAINNET_CONTRACT_ADDRESS = '';
  f.env.ETHEREUM_PRE111K_SEPOLIA_CONTRACT_ADDRESS = '';
  delete f.env.ETHEREUM_PRE111K_MAINNET_SIGNER_SECRET;
  delete f.env.ETHEREUM_PRE111K_SEPOLIA_SIGNER_SECRET;
  for (const code of [ACCESS_CODE, SECOND_ACCESS_CODE, ` ${ACCESS_CODE.toLowerCase()} `]) {
    const result = await f.call(PRE111K_API_PATHS.access, { code });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(result.body, { ok: true });
  }
  assert.equal(f.state.calls.length, 0);
});

test('pre111k rejects missing and invalid codes before chain reads or authorization', async () => {
  for (const network of ['mainnet', 'devnet'] as const) {
    const f = fixture(network);
    for (const code of [undefined, null, '', ' ', 'WRONGCODE', 123, [ACCESS_CODE], {}, 'A'.repeat(65)]) {
      for (const path of [PRE111K_API_PATHS.access, PRE111K_API_PATHS.prepare]) {
        const result = await f.call(path, path === PRE111K_API_PATHS.access ? { code } : { network, wallet: WALLET, code });
        assert.equal(result.response.status, 401);
        assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
        assert.deepEqual(result.body, { ok: false, error: { code: 'unauthenticated', message: 'Enter a valid secret code.' } });
      }
    }
    assert.equal(f.state.calls.length, 0);
    for (const code of [ACCESS_CODE, ` ${SECOND_ACCESS_CODE.toLowerCase()} `]) {
      const result = await f.call(PRE111K_API_PATHS.prepare, { network, wallet: WALLET, code });
      assert.equal(result.response.status, 200);
      assert.equal(typeof result.body.signature, 'string');
    }
  }
});

test('pre111k accepts 64-character access codes at the input and configuration boundary', async () => {
  const f = fixture();
  const code = 'A'.repeat(64);
  f.env.ETHEREUM_PRE111K_ACCESS_CODES = JSON.stringify([code]);
  assert.equal((await f.call(PRE111K_API_PATHS.access, { code })).response.status, 200);
  assert.equal((await f.call(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: WALLET, code })).response.status, 200);
  assert.equal((await f.call(PRE111K_API_PATHS.access, { code: `${code}A` })).response.status, 401);
});

test('pre111k fails closed for missing or malformed access configuration', async () => {
  for (const configured of [undefined, '', 'invalid', 'null', '{}', '[]', '[""]', '[" "]', '[123]',
    JSON.stringify([ACCESS_CODE, null]), JSON.stringify(['A'.repeat(65)]), JSON.stringify(['ß'.repeat(64)]),
    JSON.stringify(Array(33).fill(ACCESS_CODE))]) {
    const f = fixture();
    f.env.ETHEREUM_PRE111K_ACCESS_CODES = configured;
    for (const path of [PRE111K_API_PATHS.access, PRE111K_API_PATHS.prepare]) {
      const result = await f.call(path, path === PRE111K_API_PATHS.access ? { code: ACCESS_CODE }
        : { network: 'devnet', wallet: WALLET, code: ACCESS_CODE });
      assert.equal(result.response.status, 503);
      assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(result.body, { ok: false, error: { code: 'unavailable', message: 'Relic reservations are temporarily unavailable.' } });
    }
    assert.equal(f.state.calls.length, 0);
  }
});

test('pre111k access enforces origin, CSRF, method, strict body, and rate limits', async () => {
  const f = fixture();
  assert.equal((await f.call(PRE111K_API_PATHS.access, { code: ACCESS_CODE }, { origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await f.call(PRE111K_API_PATHS.access, { code: ACCESS_CODE }, { csrf: '' })).response.status, 403);
  const method = await f.call(PRE111K_API_PATHS.access);
  assert.equal(method.response.status, 405);
  assert.equal(method.response.headers.get('Allow'), 'POST, OPTIONS');
  assert.equal(method.response.headers.get('Cache-Control'), 'no-store');
  for (const body of [null, [], { code: ACCESS_CODE, wallet: WALLET }, { code: ACCESS_CODE, network: 'devnet' }]) {
    const invalid = await f.call(PRE111K_API_PATHS.access, body);
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.response.headers.get('Cache-Control'), 'no-store');
  }
  f.env.PREORDER_PREPARE_IP_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const limited = await f.call(PRE111K_API_PATHS.access, { code: ACCESS_CODE });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get('Retry-After'), '60');
  assert.equal(limited.response.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.state.calls.length, 0);
});

test('pre111k limiters run before access configuration checks and chain reads', async () => {
  for (const binding of ['PREORDER_PREPARE_RATE_LIMITER', 'PREORDER_PREPARE_IP_RATE_LIMITER'] as const) {
    const f = fixture();
    f.env.ETHEREUM_PRE111K_ACCESS_CODES = 'invalid';
    f.env[binding] = { limit: async () => ({ success: false }) };
    assert.equal((await f.call(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: WALLET, code: ACCESS_CODE })).response.status, 429);
    if (binding === 'PREORDER_PREPARE_IP_RATE_LIMITER') {
      assert.equal((await f.call(PRE111K_API_PATHS.access, { code: ACCESS_CODE })).response.status, 429);
      assert.equal((await f.call(PRE111K_API_PATHS.access, { extra: true })).response.status, 429);
    }
    assert.equal(f.state.calls.length, 0);
  }
});

test('pre111k status and existing reservation confirmation do not require access configuration', async () => {
  const f = fixture();
  await f.mined();
  delete f.env.ETHEREUM_PRE111K_ACCESS_CODES;
  assert.equal((await f.call(`${PRE111K_API_PATHS.status}?network=devnet&wallet=${WALLET}`)).response.status, 200);
  const result = await f.confirm();
  assert.equal(result.response.status, 200);
  assert.equal(result.body.status, 'confirmed');
});

for (const network of ['mainnet', 'devnet'] as const) {
  test(`pre111k ${network} status and prepare use exact deployment, price, wallet count, and signature`, async () => {
    const f = fixture(network);
    const result = await f.call(`${PRE111K_API_PATHS.status}?network=${network}&wallet=${WALLET}`);
    assert.equal(result.response.status, 200);
    const status = result.body as unknown as Pre111kStatus;
    assert.equal(status.config.enabled, true);
    assert.equal(status.config.chainId, f.config.chainId);
    assert.equal(status.config.priceWei, prices[network]);
    assert.equal(status.totalReserved, 4);
    assert.equal(status.reservedRelics, 2);
    assert.equal(status.remainingRelics, 13);
    const quote = await f.prepared();
    assert.equal(quote.transaction.value, ethereumHexQuantity(BigInt(f.config.priceWei)));
    assert.equal(quote.deadline, NOW / 1000 + 600);
    assert.equal(quote.expiresAtMs, quote.deadline * 1000);
    assert.equal(quote.nonce, 2);
    assert.equal(recoverEthereumAddress(pre111kReservationDigest({ chainId: f.config.chainId, contractAddress: CONTRACT,
      wallet: WALLET, nonce: quote.nonce, deadline: quote.deadline, priceWei: prices[network] }), quote.signature), SIGNER);
    assert.equal(quote.transaction.data, encodePre111kReservation(quote.nonce, quote.deadline, quote.signature));
    assert.ok(f.state.urls.every(url => url.startsWith(network === 'mainnet' ? 'https://eth-mainnet.' : 'https://eth-sepolia.')));
  });
}

test('pre111k status works without a wallet or signer and stays unavailable before deployment', async () => {
  const f = fixture();
  delete f.env.ETHEREUM_PRE111K_SEPOLIA_SIGNER_SECRET;
  const result = await f.call(`${PRE111K_API_PATHS.status}?network=devnet`);
  assert.equal(result.response.status, 200);
  assert.equal((result.body.config as Pre111kStatus['config']).enabled, false);
  assert.equal(result.body.reservedRelics, null);
  f.env.ETHEREUM_PRE111K_SEPOLIA_CONTRACT_ADDRESS = '';
  f.state.calls.length = 0;
  const empty = await f.call(`${PRE111K_API_PATHS.status}?network=devnet&wallet=${WALLET}`);
  assert.equal(empty.response.status, 200);
  assert.equal(empty.body.totalReserved, null);
  assert.equal(empty.body.reservedRelics, null);
  assert.equal(f.state.calls.length, 0);
});

test('pre111k rejects invalid networks, arbitrary contracts, prices, quantity, origin, method, and missing CSRF', async () => {
  const f = fixture();
  for (const body of [{ network: 'local', wallet: WALLET }, { network: 'devnet', wallet: WALLET, contractAddress: OTHER },
    { network: 'devnet', wallet: WALLET, code: ACCESS_CODE, priceWei: '0' },
    { network: 'devnet', wallet: WALLET, quantity: 2 }, { network: 'devnet', wallet: ZERO_ADDRESS }]) {
    assert.equal((await f.call(PRE111K_API_PATHS.prepare, body)).response.status, 400);
  }
  assert.equal((await f.call(`${PRE111K_API_PATHS.status}?network=devnet&network=mainnet`)).response.status, 400);
  assert.equal((await f.call(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: WALLET, code: ACCESS_CODE }, { origin: 'https://evil.example' })).response.status, 403);
  assert.equal((await f.call(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: WALLET, code: ACCESS_CODE }, { csrf: '' })).response.status, 403);
  assert.equal((await f.call(PRE111K_API_PATHS.prepare)).response.status, 405);
});
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

test('pre111k refuses disabled, missing signer, mismatched immutable values, stale chain, and sold out', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.env.ETHEREUM_PRE111K_SEPOLIA_ENABLED = 'false'; },
    (f: ReturnType<typeof fixture>) => { delete f.env.ETHEREUM_PRE111K_SEPOLIA_SIGNER_SECRET; },
    (f: ReturnType<typeof fixture>) => { f.state.signer = OTHER; },
    (f: ReturnType<typeof fixture>) => { f.state.treasury = OTHER; },
    (f: ReturnType<typeof fixture>) => { f.state.maximum = 18; },
    (f: ReturnType<typeof fixture>) => { f.state.lifetime = 601; },
    (f: ReturnType<typeof fixture>) => { f.state.chainId = 1; },
    (f: ReturnType<typeof fixture>) => { f.state.timestamp -= 600; },
    (f: ReturnType<typeof fixture>) => { f.state.timestamp += 600; },
    (f: ReturnType<typeof fixture>) => { f.state.reserved = 5; },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal((await f.call(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: WALLET, code: ACCESS_CODE })).response.status, 503);
  }
  const f = fixture();
  f.state.total = PRE111K_MAX_RELICS;
  assert.equal((await f.call(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: WALLET, code: ACCESS_CODE })).response.status, 409);
});

test('pre111k rejects reorged reads, applies both prepare limiters, and signs one nonce for duplicate prepares', async () => {
  const f = fixture();
  f.state.afterCall = () => { f.state.canonicalHash = HASH; };
  assert.equal((await f.call(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: WALLET, code: ACCESS_CODE })).response.status, 503);
  for (const binding of ['PREORDER_PREPARE_RATE_LIMITER', 'PREORDER_PREPARE_IP_RATE_LIMITER'] as const) {
    const limited = fixture();
    limited.env[binding] = { limit: async () => ({ success: false }) };
    const result = await limited.call(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: WALLET, code: ACCESS_CODE });
    assert.equal(result.response.status, 429);
    assert.equal(result.response.headers.get('Retry-After'), '60');
  }
  const duplicate = fixture();
  const quotes = await Promise.all([duplicate.prepared(), duplicate.prepared()]);
  assert.equal(quotes[0].nonce, quotes[1].nonce);
  assert.equal(quotes[0].signature, quotes[1].signature);
});

test('pre111k confirms canonical reservations after three blocks and supports disabled sales', async () => {
  const f = fixture();
  assert.equal((await f.confirm()).body.status, 'pending');
  await f.mined();
  f.state.blockNumber = 99;
  assert.equal((await f.confirm()).body.status, 'pending');
  f.state.blockNumber = 100;
  f.env.ETHEREUM_PRE111K_SEPOLIA_ENABLED = 'false';
  const result = await f.confirm();
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { status: 'confirmed', confirmations: 3, transactionHash: HASH, reservationNonce: 2 });
  f.state.canonicalHash = HASH;
  assert.equal((await f.confirm()).body.status, 'pending');
});

test('pre111k only accepts canonical uint256 decimal strings as quote prices', () => {
  const maximum = ((1n << 256n) - 1n).toString();
  for (const value of ['0', '1', maximum]) assert.equal(isPre111kPriceWei(value), true);
  for (const value of [undefined, null, '', ' ', '-1', '01', '1.5', '1e18', '0x1', 0, (1n << 256n).toString()]) {
    assert.equal(isPre111kPriceWei(value), false);
  }
});

test('pre111k confirms mined reservations while a missing or malformed price blocks status and new quotes', async () => {
  for (const value of [undefined, '', '-1', '1.5', '01', (1n << 256n).toString()]) {
    const f = fixture();
    const quote = await f.mined();
    f.state.calls.length = 0;
    if (value === undefined) Reflect.deleteProperty(f.env, 'ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI');
    else f.env.ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI = value;
    const status = await f.call(`${PRE111K_API_PATHS.status}?network=devnet`);
    const prepare = await f.call(PRE111K_API_PATHS.prepare, { network: 'devnet', wallet: WALLET, code: ACCESS_CODE });
    assert.equal(status.response.status, 503);
    assert.equal(prepare.response.status, 503);
    assert.equal(f.state.calls.length, 0);
    const confirmation = await f.confirm();
    assert.equal(confirmation.response.status, 200);
    assert.deepEqual(confirmation.body, { status: 'confirmed', confirmations: 3, transactionHash: HASH, reservationNonce: quote.nonce });
  }
});

test('pre111k reprices only new quotes, including explicitly free reservations', async () => {
  const f = fixture();
  const first = await f.mined();
  f.env.ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI = '0';
  const free = await f.prepared();
  assert.equal(free.nonce, first.nonce);
  assert.equal(free.deadline, first.deadline);
  assert.equal(free.transaction.value, '0x0');
  assert.notEqual(free.signature, first.signature);
  assert.equal(recoverEthereumAddress(pre111kReservationDigest({ chainId: f.config.chainId, contractAddress: CONTRACT,
    wallet: WALLET, nonce: free.nonce, deadline: free.deadline, priceWei: '0' }), free.signature), SIGNER);
  const status = await f.call(`${PRE111K_API_PATHS.status}?network=devnet`);
  assert.equal((status.body.config as Pre111kStatus['config']).priceWei, '0');
  assert.equal((await f.confirm()).body.status, 'confirmed');
});

test('pre111k recognizes reverted reservation transactions only after confirmation', async () => {
  const f = fixture();
  await f.mined('0x0');
  f.state.blockNumber = 98;
  assert.equal((await f.confirm()).body.status, 'pending');
  f.state.blockNumber = 100;
  assert.equal((await f.confirm()).body.status, 'failed');
});

test('pre111k rejects malformed receipt status without declaring a reservation failed', async () => {
  const f = fixture();
  await f.mined();
  for (const status of [['0x1'], ['0x0'], 1, 0, true, null, undefined, {}, '0x2']) {
    f.state.receipt!.status = status;
    const result = await f.confirm();
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.body, { ok: false, error: {
      code: 'unavailable', message: 'Relic reservations are temporarily unavailable.',
    } });
  }
  f.state.receipt!.status = '0x1';
  assert.equal((await f.confirm()).body.status, 'confirmed');
});

test('pre111k confirms a smart wallet reservation from its canonical contract event', async () => {
  const f = fixture();
  await f.mined();
  f.state.receipt!.from = OTHER;
  f.state.receipt!.to = WALLET;
  f.state.transaction!.from = OTHER;
  f.state.transaction!.to = WALLET;
  f.state.transaction!.input = '0x1234';
  f.state.transaction!.value = '0x0';
  assert.equal((await f.confirm()).body.status, 'confirmed');
  f.state.receipt!.logs = [];
  assert.notEqual((await f.confirm()).response.status, 200);
});

test('pre111k refuses unrelated transactions and forged reservation log identity', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.state.receipt!.from = OTHER; },
    (f: ReturnType<typeof fixture>) => { f.state.receipt!.to = OTHER; },
    (f: ReturnType<typeof fixture>) => { f.state.transaction!.to = OTHER; },
    (f: ReturnType<typeof fixture>) => { f.state.transaction!.value = 'invalid'; },
    (f: ReturnType<typeof fixture>) => { f.state.transaction!.input = '0x'; },
    (f: ReturnType<typeof fixture>) => { f.state.transaction!.chainId = '0x1'; },
    (f: ReturnType<typeof fixture>) => { f.state.receipt!.logs = []; },
    (f: ReturnType<typeof fixture>) => { (f.state.receipt!.logs as Array<{ address: string }>)[0].address = OTHER; },
    (f: ReturnType<typeof fixture>) => { (f.state.receipt!.logs as Array<{ topics: string[] }>)[0].topics[1] = encodeAbi(['address'], [OTHER]); },
    (f: ReturnType<typeof fixture>) => { (f.state.receipt!.logs as Array<{ topics: string[] }>)[0].topics[2] = encodeAbi(['uint256'], [1]); },
  ]) {
    const f = fixture();
    await f.mined();
    mutate(f);
    const result = await f.confirm();
    assert.notEqual(result.response.status, 200);
    assert.notEqual((result.body as unknown as Pre111kConfirmResponse).status, 'confirmed');
  }
});

test('pre111k prepare route participates in commerce maintenance while reads and confirmation remain available', () => {
  assert.equal(pre111kRoutes.find(route => route.path === PRE111K_API_PATHS.prepare)?.commerceMutation, true);
  assert.equal(pre111kRoutes.find(route => route.path === PRE111K_API_PATHS.access)?.commerceMutation, false);
  assert.equal(pre111kRoutes.find(route => route.path === PRE111K_API_PATHS.status)?.commerceMutation, false);
  assert.equal(pre111kRoutes.find(route => route.path === PRE111K_API_PATHS.confirm)?.commerceMutation, false);
});
