import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeReturn, encodeAbi, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.ts';
import { ethereumHexQuantity, ETHEREUM_FUNCTIONS } from '../../../../shared/ethereum/protocol.ts';
import { EthereumRevealThrottleError, inspectRevealTransaction, recoverRevealCrates, recoverRevealTokens, verifyRevealDeployment } from '../src/ethereumRevealChain.ts';

const CONTRACT = `0x${'11'.repeat(20)}`;
const WALLET = `0x${'22'.repeat(20)}`;
const OTHER = `0x${'33'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const HASH = `0x${'aa'.repeat(32)}`;
const BLOCK_HASH = `0x${'bb'.repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${'cc'.repeat(32)}`;
const DEPLOYMENT = { chainId: 11155111, contractAddress: CONTRACT, deploymentBlock: 100 };
const ENV = { ALCHEMY_MI_NOTE_API_KEY: 'test-only', ETHEREUM_111K_RPC_URL: 'http://127.0.0.1:8545' };
const signal = () => AbortSignal.timeout(10_000);
const word = (value: bigint | number | string) => encodeAbi(['uint256'], [value]);
const address = (value: string) => encodeAbi(['address'], [value]);

function log(topics: string[], data = '0x', index = 0) {
  return { address: CONTRACT, topics, data, blockNumber: '0x1f4', blockHash: BLOCK_HASH,
    transactionHash: HASH, logIndex: ethereumHexQuantity(index), removed: false };
}

function crateLogs(crate = 111112, first = 1, count = crate === 116666 ? 31 : 20, startIndex = 0) {
  return [
    log([ETHEREUM_EVENT_TOPICS.Transfer, address(WALLET), address(ZERO), word(crate)], '0x', startIndex),
    ...Array.from({ length: count }, (_, index) => log([ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(WALLET), word(first + index)], '0x', startIndex + index + 1)),
    log([ETHEREUM_EVENT_TOPICS.CrateUnboxed, word(crate), address(WALLET)], encodeAbi(['uint256', 'uint256'], [first, count]), startIndex + count + 1),
  ];
}

function fixture() {
  const state = {
    chain: 11155111, head: 500, canonical: BLOCK_HASH, minted: 40,
    baseUri: 'https://cdn.mons.shop/111k-sepolia/', code: '0x60006000', createdAt: 100,
    receipt: { transactionHash: HASH, blockNumber: '0x1f4', blockHash: BLOCK_HASH,
      status: '0x1', from: WALLET, to: CONTRACT, logs: crateLogs() } as Record<string, unknown> | null,
    transaction: null as Record<string, unknown> | null,
    logs: [] as ReturnType<typeof log>[],
    logError: null as null | { code: number; message: string },
    owners: new Map<string, string>(),
    calls: [] as Array<{ method: string; params: unknown[] }>,
    urls: [] as string[],
    afterCall: null as null | ((method: string, params: unknown[]) => void),
  };
  const providerFetch: typeof fetch = async (input, init) => {
    state.urls.push(String(input));
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    state.calls.push({ method, params });
    let result: unknown;
    if (method === 'eth_chainId') result = ethereumHexQuantity(state.chain);
    else if (method === 'eth_getTransactionReceipt') result = state.receipt;
    else if (method === 'eth_getTransactionByHash') result = state.transaction;
    else if (method === 'eth_blockNumber') result = ethereumHexQuantity(state.head);
    else if (method === 'eth_getCode') result = BigInt((params[1] as { blockHash: string }).blockHash) < BigInt(state.createdAt) ? '0x' : state.code;
    else if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'latest' ? state.head : Number(BigInt(String(params[0])));
      result = { number: ethereumHexQuantity(number), hash: number < 500 ? word(number) : state.canonical };
    }
    else if (method === 'eth_getLogs') {
      if (state.logError) return Response.json({ jsonrpc: '2.0', id, error: state.logError });
      result = state.logs;
    } else if (method === 'eth_call') {
      const request = params[0] as { data: string };
      if (request.data.slice(0, 10) === encodeCall('baseURI()', [], [])) {
        result = encodeAbi(['string'], [state.baseUri]);
      } else if (request.data.slice(0, 10) === encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, [], [])) {
        const [ids] = decodeReturn(['uint256[]'], `0x${request.data.slice(10)}`) as [bigint[]];
        result = encodeAbi(['(uint8,uint256,address)[]'], [ids.map(id => [2, id - 111111n, state.owners.get(String(id)) || WALLET])]);
      } else {
        result = encodeAbi(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256'],
          [1, 0, state.minted, 1, 1, true, word(0), 1, 1, 0]);
      }
    } else throw new Error(`Unexpected method ${method}`);
    state.afterCall?.(method, params);
    return Response.json({ jsonrpc: '2.0', id, result });
  };
  return { state, providerFetch };
}

test('reveal verifies canonical inclusion and every mint and burn at one confirmation', async () => {
  const { state, providerFetch } = fixture();
  const result = await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch);
  assert.equal(result.status, 'confirmed');
  if (result.status !== 'confirmed') assert.fail();
  assert.equal(result.confirmations, 1);
  assert.deepEqual(result.observation, { transactionHash: HASH, blockNumber: 500, blockHash: BLOCK_HASH });
  assert.deepEqual(result.crates, [{ crateTokenId: '111112', tokenIds: Array.from({ length: 20 }, (_, index) => String(index + 1)) }]);
  assert.ok(state.urls.every(url => url === 'https://eth-sepolia.g.alchemy.com/v2/test-only'));
});

for (const response of [
  { label: 'HTTP seconds', status: 429, body: 'not json', retryAfter: '600', expected: 600_000 },
  { label: 'HTTP date', status: 429, body: 'not json', retryAfter: new Date(1_005_000).toUTCString(), expected: 5_000 },
  { label: 'HTTP invalid header', status: 429, body: 'not json', retryAfter: 'invalid', expected: 2_000 },
  { label: 'RPC code', status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'throttled' } }), retryAfter: '3', expected: 3_000 },
  { label: 'RPC quota', status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'compute units exceeded' } }), retryAfter: '', expected: 2_000 },
]) test(`provider throttling preserves ${response.label} backoff without revealing artwork`, async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const providerFetch: typeof fetch = async () => new Response(response.body, {
    status: response.status, headers: { 'Content-Type': 'application/json', 'Retry-After': response.retryAfter },
  });
  await assert.rejects(inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), error =>
    error instanceof EthereumRevealThrottleError && error.retryAfterMs === response.expected);
});

test('log RPC throttling is not mistaken for a splittable block range', async () => {
  const { state, providerFetch } = fixture();
  state.logError = { code: -32005, message: 'Rate limit exceeded' };
  await assert.rejects(recoverRevealTokens(ENV, DEPLOYMENT, ['1'], { fromBlock: 100 }, signal(), providerFetch),
    error => error instanceof EthereumRevealThrottleError);
  await assert.rejects(recoverRevealCrates(ENV, DEPLOYMENT, ['111112'], { fromBlock: 100 }, signal(), providerFetch),
    error => error instanceof EthereumRevealThrottleError);
});

test('reveal supports wrapped transactions, multiple calls, and the 31-item final crate', async () => {
  const { state, providerFetch } = fixture();
  state.receipt = { ...state.receipt, to: OTHER, from: OTHER,
    logs: [...crateLogs(), ...crateLogs(116666, 21, 31, 22)] };
  const result = await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch);
  assert.equal(result.status, 'confirmed');
  if (result.status !== 'confirmed') assert.fail();
  assert.deepEqual(result.crates.map(crate => crate.tokenIds.length), [20, 31]);
});

test('reveal distinguishes reverted, unrelated, and noncanonical receipts without allocations', async () => {
  for (const [change, expected] of [
    [{ status: '0x0' }, 'reverted'],
    [{ logs: [] }, 'not_unpack'],
    [{ blockHash: OTHER_BLOCK_HASH }, 'pending'],
  ] as const) {
    const { state, providerFetch } = fixture();
    state.receipt = { ...state.receipt, ...change };
    assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), expected === 'pending'
      ? { status: expected, seen: true } : { status: expected, source: 'receipt', confirmations: 1,
        observation: { transactionHash: HASH, blockNumber: 500, blockHash: BLOCK_HASH } });
  }
  const { state, providerFetch } = fixture();
  state.chain = 1;
  await assert.rejects(inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), /verification is temporarily unavailable/);
});

test('reveal rejects incomplete, conflicting, foreign, or malformed mint evidence', async () => {
  const changes: Array<(logs: ReturnType<typeof log>[]) => ReturnType<typeof log>[]> = [
    logs => logs.slice(1),
    logs => logs.filter((_, index) => index !== 3),
    logs => logs.map((entry, index) => index === 3 ? { ...entry, address: OTHER } : entry),
    logs => logs.map((entry, index) => index === 3 ? { ...entry, topics: [ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(OTHER), word(3)] } : entry),
    logs => logs.map((entry, index) => index === 3 ? { ...entry, blockHash: OTHER_BLOCK_HASH } : entry),
    logs => logs.map((entry, index) => index === 3 ? { ...entry, transactionHash: OTHER_BLOCK_HASH } : entry),
    logs => logs.map((entry, index) => index === 3 ? { ...entry, removed: true } : entry),
    logs => logs.map((entry, index) => index === 3 ? { ...entry, logIndex: '0x2' } : entry),
    logs => [...logs, { ...logs[3], logIndex: '0x30' }],
    logs => [...logs, log([ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(WALLET), word(100)], '0x', 31)],
    logs => [...logs, { ...logs.at(-1)!, logIndex: '0x40' }],
    () => crateLogs(111112, 111111),
    () => crateLogs(116666, 1, 20),
  ];
  for (const change of changes) {
    const { state, providerFetch } = fixture();
    state.receipt = { ...state.receipt, logs: change(crateLogs()) };
    await assert.rejects(inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), /verification is temporarily unavailable/);
  }
});

test('pending allocation accepts only validated direct unbox calldata and current ownership', async () => {
  const { state, providerFetch } = fixture();
  state.receipt = null;
  state.transaction = { hash: HASH, from: WALLET, to: CONTRACT, value: '0x0', blockNumber: null,
    input: encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [[111112, 116666]]) };
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch),
    { status: 'pending', seen: true, crates: ['111112', '116666'], fromBlock: 500 });
  state.owners.set('111112', OTHER);
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), { status: 'pending', seen: true, fromBlock: 500 });
  state.owners.clear();
  state.transaction.input = encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, ['uint256[]'], [[111112, 111112]]);
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), { status: 'not_unpack', source: 'input' });
  state.transaction.to = OTHER;
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), { status: 'pending', seen: true });
  state.transaction = null;
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), { status: 'pending', seen: false });
});

test('pending allocations are withheld when the ownership snapshot reorganizes', async () => {
  const { state, providerFetch } = fixture();
  state.receipt = null;
  state.transaction = { hash: HASH, from: WALLET, to: CONTRACT, value: '0x0', blockNumber: null,
    input: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111112]) };
  state.afterCall = method => { if (method === 'eth_call') state.canonical = OTHER_BLOCK_HASH; };
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), { status: 'pending', seen: true });
});

test('failed canonical receipts include their observation and confirmation depth', async () => {
  for (const status of ['0x0', '0x1']) {
    const { state, providerFetch } = fixture();
    state.head = 563;
    state.receipt = { ...state.receipt, status, logs: [] };
    const value = await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch);
    assert.deepEqual(value, { status: status === '0x0' ? 'reverted' : 'not_unpack', source: 'receipt', confirmations: 64,
      observation: { transactionHash: HASH, blockNumber: 500, blockHash: BLOCK_HASH } });
  }
});

test('pending inspection distinguishes incompatible inputs from incomplete ABI data', async () => {
  const { state, providerFetch } = fixture();
  state.receipt = null;
  state.transaction = { hash: HASH, from: WALLET, to: CONTRACT, value: '0x0', blockNumber: null,
    input: encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, [], []) };
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), { status: 'pending', seen: true });
  state.transaction.input = `${encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111112])}abcd`;
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch),
    { status: 'pending', seen: true, crates: ['111112'], fromBlock: 500 });
  state.transaction.input = encodeCall('baseURI()', [], []);
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch), { status: 'not_unpack', source: 'input' });
});

test('pending wrapped and contract-creation hashes report chain presence without allocating crates', async () => {
  for (const to of [OTHER, null]) {
    const { state, providerFetch } = fixture();
    state.receipt = null;
    state.transaction = { hash: HASH, from: WALLET, to, value: '0x0', blockNumber: null, input: '0x1234', chainId: '0xaa36a7' };
    let seen = 0;
    const result = await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch, () => { seen++; });
    assert.deepEqual(result, { status: 'pending', seen: true });
    assert.equal(seen, 1);
    assert.ok(!state.calls.some(call => call.method === 'eth_call' || call.method === 'eth_getBlockByNumber'));
  }
});

test('unseen hashes and invalid chain identities never record transaction presence', async () => {
  const missing = fixture();
  missing.state.receipt = null;
  let seen = 0;
  const onSeen = () => { seen++; };
  assert.deepEqual(await inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), missing.providerFetch, onSeen),
    { status: 'pending', seen: false });
  for (const change of [{ hash: OTHER_BLOCK_HASH }, { from: 'invalid' }, { to: 'invalid' }, { chainId: '0x1' }]) {
    const { state, providerFetch } = fixture();
    state.receipt = null;
    state.transaction = { hash: HASH, from: WALLET, to: OTHER, value: '0x0', blockNumber: null, input: '0x1234', ...change };
    await assert.rejects(inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch, onSeen));
  }
  for (const change of [{ transactionHash: OTHER_BLOCK_HASH }, { blockNumber: null }, { status: 'invalid' }]) {
    const { state, providerFetch } = fixture();
    state.receipt = { ...state.receipt, ...change };
    await assert.rejects(inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch, onSeen));
  }
  const wrongChain = fixture();
  wrongChain.state.chain = 1;
  await assert.rejects(inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), wrongChain.providerFetch, onSeen));
  assert.equal(seen, 0);
});

test('pending presence is persisted before malformed calldata or ownership verification can fail', async () => {
  for (const malformed of [false, true]) {
    const { state, providerFetch } = fixture();
    state.receipt = null;
    state.transaction = { hash: HASH, from: WALLET, to: CONTRACT, value: '0x0', blockNumber: null,
      input: malformed ? '0xzz' : encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, ['uint256'], [111112]) };
    let seen = 0;
    const failingFetch: typeof fetch = async (input, init) => {
      const { method } = JSON.parse(String(init?.body));
      if (method === 'eth_call') {
        assert.equal(seen, 1);
        return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Ownership lookup unavailable' } });
      }
      return providerFetch(input, init);
    };
    await assert.rejects(inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), failingFetch, async () => { seen++; }));
    assert.equal(seen, 1);
  }
});

test('receipt presence is awaited before canonical checks even for failed or unrelated receipts', async () => {
  for (const outcome of ['unpack', 'reverted', 'not_unpack'] as const) {
    const { state, providerFetch } = fixture();
    state.receipt = { ...state.receipt, status: outcome === 'reverted' ? '0x0' : '0x1',
      logs: outcome === 'unpack' ? crateLogs() : [] };
    const entered = Promise.withResolvers<void>(), persisted = Promise.withResolvers<void>();
    let seen = 0;
    const failingFetch: typeof fetch = async (input, init) => {
      const { method } = JSON.parse(String(init?.body));
      if (method === 'eth_blockNumber' || method === 'eth_getBlockByNumber') {
        assert.equal(seen, 1);
        return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Canonical block unavailable' } });
      }
      return providerFetch(input, init);
    };
    const inspecting = inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), failingFetch, async () => {
      entered.resolve();
      await persisted.promise;
      seen++;
    });
    await entered.promise;
    try {
      assert.deepEqual(state.calls.map(call => call.method).sort(), ['eth_chainId', 'eth_getTransactionReceipt']);
      persisted.resolve();
      await assert.rejects(inspecting);
      assert.equal(seen, 1);
    } finally { persisted.resolve(); await inspecting.catch(() => undefined); }
  }
});

test('receipt presence alone never authorizes reveal when canonical or unpack evidence is invalid', async () => {
  for (const noncanonical of [false, true]) {
    const { state, providerFetch } = fixture();
    let seen = 0;
    if (noncanonical) state.canonical = OTHER_BLOCK_HASH;
    else state.receipt = { ...state.receipt, logs: crateLogs().slice(1) };
    const inspecting = inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch, () => { seen++; });
    if (noncanonical) assert.deepEqual(await inspecting, { status: 'pending', seen: true });
    else await assert.rejects(inspecting);
    assert.equal(seen, 1);
  }
});

test('a presence persistence failure stops inspection before further RPC', async () => {
  const { state, providerFetch } = fixture();
  const failure = new Error('Presence storage unavailable');
  await assert.rejects(inspectRevealTransaction(ENV, DEPLOYMENT, HASH, signal(), providerFetch, async () => { throw failure; }), error => error === failure);
  assert.deepEqual(state.calls.map(call => call.method).sort(), ['eth_chainId', 'eth_getTransactionReceipt']);
});

test('recovery uses indexed mint provenance and does not classify partially searched minted tokens as unminted', async () => {
  const { state, providerFetch } = fixture();
  state.logs = crateLogs().slice(1, 3);
  const result = await recoverRevealTokens(ENV, DEPLOYMENT, ['1', '2', '40'], { fromBlock: 400 }, signal(), providerFetch);
  assert.equal(result.mintedThrough, 40);
  assert.deepEqual(result.provenance, [{ transactionHash: HASH, blockNumber: 500, blockHash: BLOCK_HASH, tokenIds: ['1', '2'] }]);
  assert.deepEqual(result.scannedRange, { fromBlock: 400, toBlock: 500 });
  const query = state.calls.find(call => call.method === 'eth_getLogs')!.params[0] as { topics: unknown[] };
  assert.deepEqual(query.topics, [ETHEREUM_EVENT_TOPICS.Transfer, word(0), null, [word(1), word(2), word(40)]]);
});

test('recovery proves unminted IDs from the canonical sequential mint counter without log scans', async () => {
  const { state, providerFetch } = fixture();
  const result = await recoverRevealTokens(ENV, DEPLOYMENT, ['41', '100'], { fromBlock: 100 }, signal(), providerFetch);
  assert.equal(result.mintedThrough, 40);
  assert.deepEqual(result.provenance, []);
  assert.equal(result.scannedRange, null);
  assert.ok(!state.calls.some(call => call.method === 'eth_getLogs'));
});

test('recovery persists split work for provider range limits and retries service failures', async () => {
  const { state, providerFetch } = fixture();
  state.logError = { code: -32602, message: 'This block range exceeds the allowed block range.' };
  const result = await recoverRevealTokens(ENV, DEPLOYMENT, ['1'], { fromBlock: 100 }, signal(), providerFetch);
  assert.equal(result.scannedRange, null);
  assert.deepEqual(result.remainingRanges, [{ fromBlock: 301, toBlock: 500 }, { fromBlock: 100, toBlock: 300 }]);
  state.logError = { code: -32005, message: 'Rate limit exceeded.' };
  await assert.rejects(recoverRevealTokens(ENV, DEPLOYMENT, ['1'], { fromBlock: 100 }, signal(), providerFetch),
    error => error instanceof EthereumRevealThrottleError);
});

test('recovery rejects wrong token, contract, range, duplicate, and noncanonical evidence', async () => {
  const valid = crateLogs()[1];
  for (const logs of [
    [{ ...valid, address: OTHER }],
    [{ ...valid, blockNumber: '0x20' }],
    [{ ...valid, topics: [ETHEREUM_EVENT_TOPICS.Transfer, address(ZERO), address(WALLET), word(2)] }],
    [valid, valid],
  ]) {
    const { state, providerFetch } = fixture();
    state.logs = logs;
    await assert.rejects(recoverRevealTokens(ENV, DEPLOYMENT, ['1'], { fromBlock: 100 }, signal(), providerFetch));
  }
  const { state, providerFetch } = fixture();
  state.logs = [valid];
  state.afterCall = method => { if (method === 'eth_getLogs') state.canonical = OTHER_BLOCK_HASH; };
  await assert.rejects(recoverRevealTokens(ENV, DEPLOYMENT, ['1'], { fromBlock: 100 }, signal(), providerFetch));
});

test('crate recovery discovers replacement transactions through indexed CrateUnboxed logs', async () => {
  const { state, providerFetch } = fixture();
  state.logs = [crateLogs().at(-1)!];
  const result = await recoverRevealCrates(ENV, DEPLOYMENT, ['111112'], { fromBlock: 490 }, signal(), providerFetch);
  assert.deepEqual(result.provenance, [{ transactionHash: HASH, blockNumber: 500, blockHash: BLOCK_HASH, crateTokenIds: ['111112'] }]);
  assert.deepEqual(result.scannedRange, { fromBlock: 490, toBlock: 500 });
  const query = state.calls.find(call => call.method === 'eth_getLogs')!.params[0] as { topics: unknown[] };
  assert.deepEqual(query.topics, [ETHEREUM_EVENT_TOPICS.CrateUnboxed, [word(111112)]]);
});

test('mainnet and local reveal verification route to their own RPC and validate chain identity', async () => {
  const { state, providerFetch } = fixture();
  state.chain = 1;
  await inspectRevealTransaction(ENV, { ...DEPLOYMENT, chainId: 1 }, HASH, signal(), providerFetch);
  assert.ok(state.urls.every(url => url.startsWith('https://eth-mainnet.g.alchemy.com/')));
  state.urls.length = 0;
  state.chain = 31337;
  await inspectRevealTransaction(ENV, { ...DEPLOYMENT, chainId: 31337 }, HASH, signal(), providerFetch);
  assert.ok(state.urls.every(url => url === 'http://127.0.0.1:8545/'));
});

test('deployment verification requires deployed code, matching chain, and exact canonical base URI', async () => {
  const { state, providerFetch } = fixture();
  const deployment = { ...DEPLOYMENT, metadataBaseUri: state.baseUri };
  await verifyRevealDeployment(ENV, deployment, signal(), providerFetch);
  state.baseUri = 'https://cdn.mons.shop/111k-sepolia/another-deployment/';
  await assert.rejects(verifyRevealDeployment(ENV, deployment, signal(), providerFetch), /does not match/);
  state.baseUri = deployment.metadataBaseUri;
  state.code = '0x';
  await assert.rejects(verifyRevealDeployment(ENV, deployment, signal(), providerFetch));
  state.code = '0x60006000';
  state.chain = 1;
  await assert.rejects(verifyRevealDeployment(ENV, deployment, signal(), providerFetch));
});

test('deployment verification proves creation at the configured canonical block', async () => {
  const { state, providerFetch } = fixture();
  const deployment = { ...DEPLOYMENT, metadataBaseUri: state.baseUri };
  await verifyRevealDeployment(ENV, deployment, signal(), providerFetch);
  assert.deepEqual(state.calls.filter(call => call.method === 'eth_getCode').map(call => call.params[1]), [
    { blockHash: BLOCK_HASH, requireCanonical: true },
    { blockHash: word(100), requireCanonical: true },
    { blockHash: word(99), requireCanonical: true },
  ]);
  for (const deploymentBlock of [0, 99, 101, 50_000_000]) {
    await assert.rejects(verifyRevealDeployment(ENV, { ...deployment, deploymentBlock }, signal(), providerFetch), /deployment block/);
  }
  state.createdAt = 1;
  await verifyRevealDeployment(ENV, { ...deployment, deploymentBlock: 1 }, signal(), providerFetch);
});

for (const number of [99, 100, 500]) {
  test(`deployment verification rejects a reorg of checked block ${number}`, async () => {
    const { state, providerFetch } = fixture();
    let codeRead = false;
    const reorganizingFetch: typeof fetch = async (input, init) => {
      const { method, params } = JSON.parse(String(init?.body));
      const response = await providerFetch(input, init);
      if (method === 'eth_getCode') codeRead = true;
      if (codeRead && method === 'eth_getBlockByNumber' && params[0] === ethereumHexQuantity(number)) {
        const body = await response.json() as { result: { hash: string } };
        body.result.hash = OTHER_BLOCK_HASH;
        return Response.json(body);
      }
      return response;
    };
    await assert.rejects(verifyRevealDeployment(ENV, { ...DEPLOYMENT, metadataBaseUri: state.baseUri }, signal(), reorganizingFetch), /unavailable/);
  });
}
