import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyQuickNodeProvider } from '../scripts/ops/verifyEthereumProvider.ts';
import { encodeAbi } from '../shared/ethereum/abi.ts';

const contract = `0x${'1'.repeat(40)}`;
const transactionHash = `0x${'2'.repeat(64)}`;
const blockHash = `0x${'3'.repeat(64)}`;
const statsTypes = ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256',
  'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'];
const statsValues = [0, 0, 0, 100, 1000, true, `0x${'0'.repeat(64)}`, 50, 3, 0, 0, 0, 1000, 0, 0];
const pinned = encodeAbi(statsTypes, statsValues);
type RpcResponse = { jsonrpc?: string; id: number; result?: unknown; error?: unknown };
type RpcRequest = { id: number; method: string; params: unknown[] };

function provider(ignoresMissingBlock: boolean,
  transform: (response: RpcResponse | RpcResponse[], request: RpcRequest | RpcRequest[]) => unknown = response => response): typeof fetch {
  return async (_input, init) => {
    const value = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
    const handle = (request: RpcRequest) => {
      const { method, params, id } = request;
      let result: unknown;
      if (method === 'eth_chainId') result = '0x1';
      else if (method === 'eth_getBlockByNumber') result = { number: params[0] === 'latest' ? '0x64' : params[0], hash: blockHash };
      else if (method === 'eth_call') {
        if (!ignoresMissingBlock && (params[1] as { blockHash?: string })?.blockHash === `0x${'f'.repeat(64)}`) {
          return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Unknown block' } };
        }
        result = pinned;
      } else if (method === 'eth_getCode') result = '0x1234';
      else if (method === 'eth_getTransactionReceipt') result = { transactionHash, blockHash, blockNumber: '0x32' };
      else if (method === 'eth_getLogs') result = [];
      else throw new Error('Unexpected probe');
      return { jsonrpc: '2.0', id, result };
    };
    return Response.json(transform(Array.isArray(value) ? value.map(handle).reverse() : handle(value), value));
  };
}

test('provider verification checks canonical snapshots and accepts unordered batch results', async () => {
  const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
    endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false) });
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 10);
  assert.equal(report.observedBlock, 100);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

for (const words of [12, 14, 15]) test(`provider verification accepts supported ${words}-word statistics`, async () => {
  const statistics = encodeAbi(statsTypes.slice(0, words), statsValues.slice(0, words));
  const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
    endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, response => {
      const replace = (value: RpcResponse) => value.result === pinned ? { ...value, result: statistics } : value;
      return Array.isArray(response) ? response.map(replace) : replace(response);
    }) });
  assert.equal(report.passed, true);
});

for (const [name, statistics] of [
  ['two words', `0x${'0'.repeat(128)}`],
  ['unsupported thirteen words', encodeAbi(statsTypes.slice(0, 13), statsValues.slice(0, 13))],
  ['malformed hexadecimal', pinned.replace(/.$/, 'g')],
  ['null', null],
] as const) test(`provider verification rejects undecodable statistics: ${name}`, async () => {
  const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
    endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, response => {
      const replace = (value: RpcResponse) => value.result === pinned ? { ...value, result: statistics } : value;
      return Array.isArray(response) ? response.map(replace) : replace(response);
    }) });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find(check => check.name === 'pinned-contract-statistics')?.passed, false);
});

for (const code of ['this is not bytecode', '0x1', '0xzz', '0x', null, 1234]) {
  test(`provider verification rejects malformed contract bytecode: ${JSON.stringify(code)}`, async () => {
    const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
      endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, (response, request) =>
        !Array.isArray(response) && !Array.isArray(request) && request.method === 'eth_getCode'
          ? { ...response, result: code } : response) });
    assert.equal(report.passed, false);
    assert.deepEqual(report.checks.filter(check => !check.passed).map(check => check.name), ['eip1898-contract-code']);
  });
}

test('provider verification accepts nonempty bytecode including zero and uppercase bytes', async () => {
  for (const code of ['0x00', '0xABcd']) {
    const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
      endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, (response, request) =>
        !Array.isArray(response) && !Array.isArray(request) && request.method === 'eth_getCode'
          ? { ...response, result: code } : response) });
    assert.equal(report.passed, true);
  }
});

test('provider verification rejects an endpoint that substitutes latest for unknown canonical blocks', async () => {
  const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
    endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(true) });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.filter(check => !check.passed).map(check => check.name), ['eip1898-missing-block-rejected']);
});

for (const error of [
  { code: -32000, message: 'header not found' },
  { code: -32001, message: 'Block not found' },
  { code: -32000, message: `Unknown block: 0x${'f'.repeat(64)}` },
]) test(`provider verification recognizes missing-block evidence: ${error.message}`, async () => {
  const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
    endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, response =>
      !Array.isArray(response) && 'error' in response ? { ...response, error } : response) });
  assert.equal(report.passed, true);
});

for (const error of [
  { code: 429, message: 'Rate limit exceeded' },
  { code: 429, message: 'Unknown block' },
  { code: -32005, message: 'Limit exceeded' },
  { code: -32000, message: 'Quota exceeded' },
  { code: -32000, message: 'Provider unavailable' },
  { code: -32000, message: 'Unknown block query timed out' },
  { code: -32602, message: 'Invalid params' },
  { code: -32602, message: 'Unknown block' },
  { code: -32601, message: 'Method not found' },
  { code: 3, message: 'execution reverted' },
  { code: -32000, message: null },
  { code: '-32000', message: 'Unknown block' },
  null,
]) test(`provider verification rejects unrelated missing-block probe failure: ${JSON.stringify(error)}`, async () => {
  const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
    endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, response =>
      !Array.isArray(response) && 'error' in response ? { ...response, error } : response) });
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.filter(check => !check.passed).map(check => check.name), ['eip1898-missing-block-rejected']);
});

const validReceipt = { transactionHash, blockHash, blockNumber: '0x32' };
const invalidReceipts: Array<{ name: string; receipt: unknown; block?: unknown }> = [
  { name: 'absent receipt and block hashes', receipt: { ...validReceipt, blockHash: undefined }, block: { number: '0x32' } },
  { name: 'matching malformed hashes', receipt: { ...validReceipt, blockHash: 'invalid' }, block: { number: '0x32', hash: 'invalid' } },
  { name: 'different canonical hash', receipt: validReceipt, block: { number: '0x32', hash: `0x${'4'.repeat(64)}` } },
  { name: 'wrong canonical block number', receipt: validReceipt, block: { number: '0x33', hash: blockHash } },
  { name: 'absent canonical block number', receipt: validReceipt, block: { hash: blockHash } },
  { name: 'malformed receipt block number', receipt: { ...validReceipt, blockNumber: '50' } },
  { name: 'receipt ahead of the observed head', receipt: { ...validReceipt, blockNumber: '0x65' } },
  { name: 'wrong transaction hash', receipt: { ...validReceipt, transactionHash: `0x${'4'.repeat(64)}` } },
  { name: 'absent receipt', receipt: null },
];

for (const { name, receipt, block } of invalidReceipts) test(`provider verification rejects ${name}`, async () => {
  const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
    endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, (response, request) => {
      if (Array.isArray(request) || Array.isArray(response)) return response;
      if (request.method === 'eth_getTransactionReceipt') return { ...response, result: receipt };
      if (block !== undefined && request.method === 'eth_getBlockByNumber' && request.params[0] === '0x32') return { ...response, result: block };
      return response;
    }) });
  assert.equal(report.passed, false);
  assert.equal(report.checks.find(check => check.name === 'canonical-transaction-receipt')?.passed, false);
});

test('provider verification compares valid canonical receipt hashes without case sensitivity', async () => {
  const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
    endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, (response, request) => {
      if (Array.isArray(request) || Array.isArray(response)) return response;
      if (request.method === 'eth_getTransactionReceipt') return { ...response, result: { ...validReceipt, blockHash: `0x${'A'.repeat(64)}` } };
      if (request.method === 'eth_getBlockByNumber' && request.params[0] === '0x32') return { ...response, result: { number: '0x32', hash: `0x${'a'.repeat(64)}` } };
      return response;
    }) });
  assert.equal(report.passed, true);
});

for (const version of [undefined, '1.0']) {
  test(`provider verification rejects a single response with ${version === undefined ? 'missing' : 'incorrect'} JSON-RPC version`, async () => {
    const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
      endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, response =>
        !Array.isArray(response) && response.result === '0x1' ? { ...response, jsonrpc: version } : response) });
    assert.equal(report.passed, false);
    assert.deepEqual(report.checks.filter(check => !check.passed).map(check => check.name), ['ethereum-mainnet-chain-id']);
  });
}

const invalidBatches: Array<[string, (responses: RpcResponse[]) => unknown]> = [
  ['missing JSON-RPC version', responses => [{ ...responses[0], jsonrpc: undefined }, responses[1]]],
  ['incorrect JSON-RPC version', responses => [{ ...responses[0], jsonrpc: '1.0' }, responses[1]]],
  ['duplicate IDs', responses => [responses[0], { ...responses[1], id: responses[0].id }]],
  ['unknown ID', responses => [{ ...responses[0], id: 1000 }, responses[1]]],
  ['missing ID', responses => responses.slice(1)],
  ['result and error', responses => [{ ...responses[0], error: { code: -32000, message: 'Failed' } }, responses[1]]],
  ['neither result nor error', responses => [{ jsonrpc: '2.0', id: responses[0].id }, responses[1]]],
  ['single envelope', responses => responses[0]],
];

for (const [name, transform] of invalidBatches) {
  test(`provider verification rejects a batch with ${name}`, async () => {
    const report = await verifyQuickNodeProvider({ contract, transactionHash, deploymentBlock: 50,
      endpoint: 'https://fixture.quiknode.pro/secret/', fetch: provider(false, response =>
        Array.isArray(response) ? transform(response) : response) });
    assert.equal(report.passed, false);
    assert.deepEqual(report.checks.filter(check => !check.passed).map(check => check.name), ['canonical-batch']);
  });
}
