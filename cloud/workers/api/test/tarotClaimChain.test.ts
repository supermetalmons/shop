import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { encodeErrorResult, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { decodeReturn, encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.ts';
import { ethereumSignerAddress, recoverEthereumAddress } from '../../../../shared/ethereum/crypto.ts';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.ts';
import { TAROT_CLAIMED_TOPIC, tarotClaimDigest } from '../../../../shared/ethereum/tarotCrypto.ts';
import { tarotCodeHashInput } from '../../../../shared/ethereum/tarot.ts';
import { createTarotClaimChain, resolveTarotRecipient, type TarotRelayerEnvironment } from '../src/tarotClaimChain.ts';
import { EthereumApiError } from '../src/ethereumError.ts';
import type { TarotClaimInput, TarotSignedAttempt, TarotSignedClaim } from '../src/tarotClaimRelayer.ts';
import { d1Database } from './commerceD1Harness.ts';

const NOW = 2_000_000_000_000;
const CONTRACT = `0x${'11'.repeat(20)}`;
const RECIPIENT = `0x${'22'.repeat(20)}`;
const SIGNER_KEY = `0x${'33'.repeat(32)}`;
const RELAYER_KEY = `0x${'44'.repeat(32)}`;
const SIGNER = ethereumSignerAddress(SIGNER_KEY);
const RELAYER = ethereumSignerAddress(RELAYER_KEY);
const BLOCK = `0x${'bb'.repeat(32)}`;
const CODE = '11111111-1111-4111-8111-111111111111';
const CHAIN = 11155111;
const codeHash = createHash('sha256').update(tarotCodeHashInput({ chainId: CHAIN, contractAddress: CONTRACT, tokenId: 1, code: CODE })).digest('hex');
const input: TarotClaimInput = { chainId: CHAIN, contractAddress: CONTRACT, tokenId: 1,
  recipient: RECIPIENT, requestId: '22222222-2222-4222-8222-222222222222', codeHash };
type Rpc = { jsonrpc: string; id: number; method: string; params: unknown[] };

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of ['0014_tarot_claim_codes.sql', '0017_dmx_sepolia_retirement.sql']) {
    db.exec(readFileSync(`cloud/workers/api/ops-migrations/${name}`, 'utf8'));
  }
  db.prepare('INSERT INTO tarot_claim_codes VALUES (?, ?, ?, ?, ?, NULL)').run(CHAIN, CONTRACT, 1, codeHash, NOW);
  const limiter = { limit: async () => ({ success: true }) };
  const env: TarotRelayerEnvironment = {
    OPS_DB: d1Database(db), ALCHEMY_MI_NOTE_API_KEY: 'test', ETHEREUM_111K_RPC_URL: '',
    ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS: CONTRACT, ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK: '1',
    ETHEREUM_TAROT_SEPOLIA_ENABLED: 'true', ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET: SIGNER_KEY,
    ETHEREUM_TAROT_SEPOLIA_RELAYER_SECRET: RELAYER_KEY, ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED: 'true',
    TAROT_ACCESS_IP_RATE_LIMITER: limiter, TAROT_PREPARE_RATE_LIMITER: limiter, TAROT_CONFIRM_IP_RATE_LIMITER: limiter,
  };
  const calls: Rpc[] = [];
  let onRpc: ((rpc: Rpc) => void) | null = null;
  const state = { now: NOW, gas: 130_000n, baseFee: 1_000_000_000n, reward: 100_000_000n, balance: 1_000_000_000_000_000_000n,
    claimed: false, paused: false, signer: SIGNER, blockNumber: 102, chainId: CHAIN, latestNonce: 4n, pendingNonce: 5n,
    blockTimestamp: null as number | null,
    sendError: null as { code: number; message: string } | null,
    sendResult: null as string | null, receipt: null as Record<string, unknown> | null,
    transaction: null as Record<string, unknown> | null, canonicalHash: BLOCK };
  const result = (rpc: Rpc): unknown => {
    if (rpc.method === 'eth_chainId') return ethereumHexQuantity(state.chainId);
    if (rpc.method === 'eth_getBlockByNumber') return { number: ethereumHexQuantity(rpc.params[0] === 'latest' ? state.blockNumber : Number(rpc.params[0])),
      hash: state.canonicalHash, timestamp: ethereumHexQuantity(state.blockTimestamp ?? Math.floor(state.now / 1000)) };
    if (rpc.method === 'eth_blockNumber') return ethereumHexQuantity(state.blockNumber);
    if (rpc.method === 'eth_estimateGas') return ethereumHexQuantity(state.gas);
    if (rpc.method === 'eth_feeHistory') return { baseFeePerGas: Array(6).fill(ethereumHexQuantity(state.baseFee)),
      reward: Array.from({ length: 5 }, () => [ethereumHexQuantity(state.reward)]) };
    if (rpc.method === 'eth_getBalance') return ethereumHexQuantity(state.balance);
    if (rpc.method === 'eth_getTransactionCount') return ethereumHexQuantity(rpc.params[1] === 'pending' ? state.pendingNonce : state.latestNonce);
    if (rpc.method === 'eth_getTransactionReceipt') return state.receipt;
    if (rpc.method === 'eth_getTransactionByHash') return state.transaction;
    if (rpc.method === 'eth_sendRawTransaction') return state.sendResult ?? keccak256(rpc.params[0] as Hex);
    assert.equal(rpc.method, 'eth_call');
    const transaction = rpc.params[0] as { to: string; data: string };
    assert.equal(transaction.to, CONTRACT);
    const reads: Record<string, [string, unknown]> = {
      [encodeCall('MAX_CARDS()', [], [])]: ['uint256', 999_999],
      [encodeCall('INITIAL_CARDS()', [], [])]: ['uint256', 777],
      [encodeCall('RECEIPT_OFFSET()', [], [])]: ['uint256', 999_999],
      [encodeCall('MAX_AUTHORIZATION_LIFETIME()', [], [])]: ['uint256', 600],
      [encodeCall('quoteSigner()', [], [])]: ['address', state.signer],
      [encodeCall('claimed(uint256)', ['uint256'], [1])]: ['uint256', Number(state.claimed)],
      [encodeCall('mintingPaused()', [], [])]: ['uint256', Number(state.paused)],
    };
    const read = reads[transaction.data];
    assert.ok(read, `Unexpected calldata ${transaction.data}`);
    return encodeAbi([read[0]], [read[1]]);
  };
  const providerFetch: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as Rpc | Rpc[];
    const respond = (rpc: Rpc) => {
      onRpc?.(rpc);
      calls.push(rpc);
      return { id: rpc.id, jsonrpc: '2.0', ...(rpc.method === 'eth_sendRawTransaction' && state.sendError ? { error: state.sendError } : { result: result(rpc) }) };
    };
    return Response.json(Array.isArray(payload) ? payload.map(respond) : respond(payload));
  };
  const chain = createTarotClaimChain(env, { fetch: providerFetch, nowMs: () => state.now });
  const attempt = (signed: TarotSignedClaim): TarotSignedAttempt => ({ ...input, id: 1, state: 'pending', createdAtMs: NOW,
    updatedAtMs: NOW, lastBroadcastAtMs: NOW, lastCheckedAtMs: null, broadcastAccepted: false, error: null, signed });
  return { db, env, state, calls, chain, attempt, beforeRpc: (value: ((rpc: Rpc) => void) | null) => { onRpc = value; } };
}

test('sponsored claim signs the exact recipient-bound claimTo with an exclusive relayer and estimated bounded fees', async t => {
  const f = fixture(t);
  await f.chain.validate(input);
  assert.equal(f.chain.relayerAddress(CHAIN), RELAYER);
  assert.deepEqual(await f.chain.nonce(input), { latest: '4', pending: '5' });
  const signed = await f.chain.prepare(input, '5', '0');
  const raw = signed.rawTransaction as `0x02${string}`;
  const parsed = parseTransaction(raw);
  assert.equal(parsed.to, CONTRACT);
  assert.equal(parsed.chainId, CHAIN);
  assert.equal(parsed.nonce, 5);
  assert.equal(parsed.gas, 156_000n);
  assert.equal(parsed.maxFeePerGas, 2_100_000_000n);
  assert.equal(parsed.maxPriorityFeePerGas, 100_000_000n);
  assert.equal(signed.maximumFeeWei, '327600000000000');
  assert.equal(signed.transactionHash, keccak256(raw));
  assert.equal((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(), RELAYER);
  const [recipient, tokenId, deadline, signature] = decodeReturn(['address', 'uint256', 'uint256', 'bytes'], `0x${parsed.data!.slice(10)}`);
  assert.equal(recipient, RECIPIENT);
  assert.equal(tokenId, 1n);
  assert.equal(deadline, BigInt(NOW / 1000 + 600));
  assert.equal(recoverEthereumAddress(tarotClaimDigest({ chainId: CHAIN, contractAddress: CONTRACT,
    tokenId: 1, wallet: RECIPIENT, deadline: deadline as bigint }), String(signature)), SIGNER);
  assert.equal(f.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
});

test('fee ceiling, gas ceiling and outstanding fee commitments prevent signing', async t => {
  const f = fixture(t);
  f.state.baseFee = 10_000_000_000n;
  await assert.rejects(f.chain.prepare(input, '5', '0'), /fees are too high/);
  f.state.baseFee = 1_000_000_000n;
  f.state.gas = 500_000n;
  const boundary = await f.chain.prepare(input, '5', '0');
  assert.equal(parseTransaction(boundary.rawTransaction as `0x02${string}`).gas, 600_000n);
  f.state.gas = 500_001n;
  await assert.rejects(f.chain.prepare(input, '5', '0'), /gas limit/);
  f.state.gas = 130_000n;
  f.state.balance = 400_000_000_000_000n;
  await assert.rejects(f.chain.prepare(input, '5', '100000000000000'), /temporarily unavailable/);
  f.env.ETHEREUM_TAROT_SEPOLIA_MAX_CLAIM_FEE_WEI = '1';
  await assert.rejects(f.chain.prepare(input, '5', '0'), /fees are too high/);
  assert.equal(f.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
});

test('the observed live Sepolia claim estimate retains twenty percent headroom within the unchanged fee ceiling', async t => {
  const f = fixture(t);
  f.state.gas = 485_395n;
  const signed = await f.chain.prepare(input, '5', '0');
  const parsed = parseTransaction(signed.rawTransaction as `0x02${string}`);
  assert.equal(parsed.gas, 582_474n);
  assert.equal(signed.maximumFeeWei, '1223195400000000');
  assert.ok(BigInt(signed.maximumFeeWei) <= 1_500_000_000_000_000n);
  f.state.baseFee = 2_000_000_000n;
  await assert.rejects(f.chain.prepare(input, '5', '0'), /fees are too high/);
  assert.equal(f.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
});

test('the authorization signer cannot also fund sponsored transactions', async t => {
  const f = fixture(t);
  f.env.ETHEREUM_TAROT_SEPOLIA_RELAYER_SECRET = SIGNER_KEY;
  const configurationFailure = (error: unknown) => error instanceof EthereumApiError && error.code === 'failed-precondition' &&
    typeof error.details === 'object' && error.details !== null && 'kind' in error.details && error.details.kind === 'relayer-configuration';
  await assert.rejects(f.chain.validate(input), configurationFailure);
  await assert.rejects(f.chain.prepare(input, '5', '0'), configurationFailure);
  assert.equal(f.calls.length, 0);
});

test('replays send precisely the persisted transaction and accept an already-known response', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  await f.chain.broadcast(f.attempt(signed));
  f.state.sendError = { code: -32000, message: 'already known' };
  await f.chain.broadcast(f.attempt(signed));
  const broadcasts = f.calls.filter(call => call.method === 'eth_sendRawTransaction');
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(broadcasts.map(call => call.params), [[signed.rawTransaction], [signed.rawTransaction]]);
  f.state.sendError = null;
  f.state.sendResult = `0x${'ab'.repeat(32)}`;
  await assert.rejects(f.chain.broadcast(f.attempt(signed)), /unavailable/);
});

test('disabled sponsorship is retryable and resuming sends the saved transaction', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  const callsBeforePause = f.calls.length;
  f.env.ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED = 'false';
  const unavailable = (error: unknown) => error instanceof EthereumApiError && error.code === 'unavailable';
  await assert.rejects(f.chain.validate(input), unavailable);
  await assert.rejects(f.chain.prepare(input, '5', '0'), unavailable);
  await assert.rejects(f.chain.broadcast(f.attempt(signed)), unavailable);
  assert.equal(f.calls.length, callsBeforePause);
  f.env.ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED = 'true';
  await f.chain.broadcast(f.attempt(signed));
  assert.deepEqual(f.calls.filter(call => call.method === 'eth_sendRawTransaction').map(call => call.params), [[signed.rawTransaction]]);
});

test('broadcast rejects saved authorizations revoked by quote signer rotation while inspection continues', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  const attempt = f.attempt(signed);
  const nextSignerKey = `0x${'55'.repeat(32)}`;
  f.env.ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET = nextSignerKey;
  f.state.signer = ethereumSignerAddress(nextSignerKey);
  await assert.rejects(f.chain.broadcast(attempt), (error: unknown) => error instanceof EthereumApiError &&
    error.code === 'failed-precondition' && /authorization is no longer valid/.test(error.message));
  assert.equal(f.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
  assert.equal(await f.chain.inspect(attempt), 'pending');
});

test('broadcast refuses revoked credentials, expired signatures and tampered transactions', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  const attempt = f.attempt(signed);
  f.db.prepare('UPDATE tarot_claim_codes SET revoked_at_ms = ?').run(NOW);
  await assert.rejects(f.chain.broadcast(attempt), /link is invalid/);
  f.db.prepare('UPDATE tarot_claim_codes SET revoked_at_ms = NULL').run();
  f.state.now = (signed.authorizationDeadline + 1) * 1000;
  await assert.rejects(f.chain.broadcast(attempt), /expired/);
  f.state.now = NOW;
  await assert.rejects(f.chain.broadcast(f.attempt({ ...signed, transactionHash: `0x${'ab'.repeat(32)}` })), /unavailable/);
  await assert.rejects(f.chain.broadcast({ ...attempt, recipient: `0x${'55'.repeat(20)}` }), /unavailable/);
  await assert.rejects(f.chain.broadcast(f.attempt({ ...signed, authorizationDeadline: signed.authorizationDeadline + 1 })), /unavailable/);
  await assert.rejects(f.chain.broadcast(f.attempt({ ...signed, maximumFeeWei: '1' })), /unavailable/);
  assert.equal(f.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
});

test('broadcast can replay an already-included claim while it awaits three confirmations', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  f.state.claimed = true;
  await f.chain.broadcast(f.attempt(signed));
  assert.equal(f.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 1);
});

test('broadcast rejects an authorization that expires during preflight even when the observed block is older', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  f.state.now = (signed.authorizationDeadline - 1) * 1000;
  f.state.blockTimestamp = signed.authorizationDeadline - 1;
  f.beforeRpc(rpc => { if (rpc.method === 'eth_call') f.state.now = signed.authorizationDeadline * 1000; });
  await assert.rejects(f.chain.broadcast(f.attempt(signed)), (error: unknown) => error instanceof EthereumApiError &&
    error.code === 'failed-precondition' && /expired/.test(error.message));
  assert.equal(f.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
});

test('broadcast rejects an authorization expired at the observed chain timestamp while the local clock is behind', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  f.state.now = (signed.authorizationDeadline - 1) * 1000;
  f.state.blockTimestamp = signed.authorizationDeadline;
  await assert.rejects(f.chain.broadcast(f.attempt(signed)), (error: unknown) => error instanceof EthereumApiError &&
    error.code === 'failed-precondition' && /expired/.test(error.message));
  assert.equal(f.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
});

test('broadcast rejects expiry while awaiting provider capacity without sending the saved transaction', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  f.state.now = (signed.authorizationDeadline - 1) * 1000;
  let submissionGrant = false;
  f.env.ETHEREUM_PROVIDER_CONTROL_ENABLED = 'true';
  f.env.ETHEREUM_PROVIDER_BUDGET = { getByName: () => ({
    grant: async request => {
      if (request.minimum === 40) {
        submissionGrant = true;
        f.state.now = signed.authorizationDeadline * 1000;
      }
      const now = Date.now();
      return { granted: request.wanted, issuedAtMs: now, expiresAtMs: now + 1000, retryAfterMs: 0 };
    },
    reportThrottle: async () => {},
  }) };
  await assert.rejects(f.chain.broadcast(f.attempt(signed)), (error: unknown) => error instanceof EthereumApiError &&
    error.code === 'failed-precondition' && /expired/.test(error.message));
  assert.equal(submissionGrant, true);
  assert.equal(f.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
});

test('inspection verifies reverted relayer calls and canonical confirmations without requiring current keys', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  const attempt = f.attempt(signed);
  const data = parseTransaction(signed.rawTransaction as `0x02${string}`).data;
  f.state.receipt = { transactionHash: signed.transactionHash, from: RELAYER, to: CONTRACT,
    blockNumber: '0x64', blockHash: BLOCK, status: '0x0', logs: [] };
  f.state.transaction = { hash: signed.transactionHash, from: RELAYER, to: CONTRACT, value: '0x0',
    blockNumber: '0x64', blockHash: BLOCK, chainId: ethereumHexQuantity(CHAIN), input: data };
  delete f.env.ETHEREUM_TAROT_SEPOLIA_RELAYER_SECRET;
  f.env.ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED = 'false';
  assert.equal(await f.chain.inspect(attempt), 'failed');
  f.state.blockNumber = 101;
  assert.equal(await f.chain.inspect(attempt), 'pending');
  f.state.blockNumber = 102;
  f.state.canonicalHash = `0x${'ab'.repeat(32)}`;
  assert.equal(await f.chain.inspect(attempt), 'pending');
  f.state.canonicalHash = BLOCK;
  f.state.transaction.input = '0x1234';
  await assert.rejects(f.chain.inspect(attempt), /does not match the backend claim/);
});

test('a relayed claim confirms only when both recipient mints are present and the network matches', async t => {
  const f = fixture(t);
  const signed = await f.chain.prepare(input, '5', '0');
  const attempt = f.attempt(signed);
  const data = parseTransaction(signed.rawTransaction as `0x02${string}`).data;
  const word = (value: number | string) => encodeAbi([typeof value === 'number' ? 'uint256' : 'address'], [value]);
  const log = (topics: string[]) => ({ address: CONTRACT, transactionHash: signed.transactionHash, blockNumber: '0x64',
    blockHash: BLOCK, removed: false, data: '0x', topics });
  const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const logs = [log([TAROT_CLAIMED_TOPIC, word(RECIPIENT), word(1), word(1_000_000)]),
    ...[1, 1_000_000].map(token => log([transfer, word(0), word(RECIPIENT), word(token)]))];
  f.state.receipt = { transactionHash: signed.transactionHash, from: RELAYER, to: CONTRACT,
    blockNumber: '0x64', blockHash: BLOCK, status: '0x1', logs };
  f.state.transaction = { hash: signed.transactionHash, from: RELAYER, to: CONTRACT, value: '0x0',
    blockNumber: '0x64', blockHash: BLOCK, chainId: ethereumHexQuantity(CHAIN), input: data };
  assert.equal(await f.chain.inspect(attempt), 'confirmed');
  f.state.receipt.logs = logs.slice(0, 2);
  await assert.rejects(f.chain.inspect(attempt), /card and receipt claim/i);
  f.state.chainId = 1;
  await assert.rejects(f.chain.prepare(input, '6', '0'), /wrong network/);
});

test('recipient addresses are trimmed and validated before any provider request', async () => {
  const noFetch: typeof fetch = async () => { assert.fail('Address parsing must not fetch.'); };
  const signal = new AbortController().signal;
  assert.equal(await resolveTarotRecipient({}, ` ${RECIPIENT} `, signal, { fetch: noFetch }), RECIPIENT);
  assert.equal(await resolveTarotRecipient({}, '0x52908400098527886E0F7030069857D2E4169EE7', signal, { fetch: noFetch }),
    '0x52908400098527886e0f7030069857d2e4169ee7');
  for (const value of ['', '0x0000000000000000000000000000000000000000', '0x52908400098527886e0F7030069857D2E4169EE7',
    '0xabc', 'not-a-name', 'bad name.eth']) {
    await assert.rejects(resolveTarotRecipient({}, value, signal, { fetch: noFetch }), (error: unknown) =>
      error instanceof EthereumApiError && error.code === 'invalid-argument' &&
      typeof error.details === 'object' && error.details !== null && 'field' in error.details && error.details.field === 'recipient');
  }
});

test('ENS resolves normalized names through mainnet and reports missing records separately from transport failures', async () => {
  const calls: { url: string; rpc: Rpc }[] = [];
  let absent = false;
  let unavailable = false;
  const providerFetch: typeof fetch = async (url, init) => {
    if (unavailable) throw new Error('Provider unavailable');
    const rpc = JSON.parse(String(init?.body)) as Rpc;
    calls.push({ url: String(url), rpc });
    return Response.json({ id: rpc.id, jsonrpc: '2.0', result: rpc.method === 'eth_chainId' ? '0x1'
      : encodeAbi(['bytes', 'address'], [encodeAbi(['bytes'], [absent ? '0x' : RECIPIENT]), RECIPIENT]) });
  };
  const env = { ALCHEMY_MI_NOTE_API_KEY: 'test' };
  const signal = new AbortController().signal;
  assert.equal(await resolveTarotRecipient(env, 'Example.ETH', signal, { fetch: providerFetch }), RECIPIENT);
  assert.equal(await resolveTarotRecipient(env, 'example.eth', signal, { fetch: providerFetch }), RECIPIENT);
  assert.ok(calls.every(call => new URL(call.url).hostname === 'eth-mainnet.g.alchemy.com'));
  const lookups = calls.filter(call => call.rpc.method === 'eth_call');
  assert.deepEqual(lookups[0].rpc.params, lookups[1].rpc.params);
  absent = true;
  await assert.rejects(resolveTarotRecipient(env, 'missing.eth', signal, { fetch: providerFetch }), /no Ethereum address/);
  unavailable = true;
  await assert.rejects(resolveTarotRecipient(env, 'example.eth', signal, { fetch: providerFetch }), error =>
    error instanceof EthereumApiError && error.code === 'unavailable');
});

test('ENS supports bounded HTTPS CCIP reads and rejects private gateway targets', async () => {
  const resolver = mainnet.contracts.ensUniversalResolver.address;
  let gateway = 'https://ens.example.com/{sender}/{data}';
  let gatewayCalls = 0;
  const offchainLookup = [{ type: 'error', name: 'OffchainLookup', inputs: [
    { name: 'sender', type: 'address' }, { name: 'urls', type: 'string[]' }, { name: 'callData', type: 'bytes' },
    { name: 'callbackFunction', type: 'bytes4' }, { name: 'extraData', type: 'bytes' },
  ] }] as const;
  const providerFetch: typeof fetch = async (url, init) => {
    if (new URL(String(url)).hostname === 'ens.example.com') {
      gatewayCalls++;
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      return Response.json({ data: '0x1234' });
    }
    assert.equal(new URL(String(url)).hostname, 'eth-mainnet.g.alchemy.com');
    const rpc = JSON.parse(String(init?.body)) as Rpc;
    const transaction = rpc.params[0] as { data?: string } | undefined;
    if (rpc.method === 'eth_call' && !transaction?.data?.startsWith('0x11223344')) {
      return Response.json({ id: rpc.id, jsonrpc: '2.0', error: { code: 3, message: 'execution reverted',
        data: encodeErrorResult({ abi: offchainLookup, errorName: 'OffchainLookup',
          args: [resolver, [gateway], '0xabcd', '0x11223344', '0x'] }) } });
    }
    return Response.json({ id: rpc.id, jsonrpc: '2.0', result: rpc.method === 'eth_chainId' ? '0x1'
      : encodeAbi(['bytes', 'address'], [encodeAbi(['bytes'], [RECIPIENT]), RECIPIENT]) });
  };
  const env = { ALCHEMY_MI_NOTE_API_KEY: 'test' };
  const signal = new AbortController().signal;
  assert.equal(await resolveTarotRecipient(env, 'example.eth', signal, { fetch: providerFetch }), RECIPIENT);
  assert.equal(gatewayCalls, 1);
  gateway = 'https://127.0.0.1/{data}';
  await assert.rejects(resolveTarotRecipient(env, 'example.eth', signal, { fetch: providerFetch }), /resolve this ENS name/);
  assert.equal(gatewayCalls, 1);
});
