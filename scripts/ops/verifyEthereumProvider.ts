import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { encodeCall } from '../../shared/ethereum/abi.ts';
import { decode111kStats } from '../../shared/ethereum/stats.ts';
import { readBoundedResponseJson } from '../../cloud/workers/api/src/boundedResponse.ts';
import { rpcInteger, validEthereumRpcResponse, type EthereumRpcEnvelope } from '../../cloud/workers/api/src/ethereumRpcValue.ts';

type RpcRequest = { jsonrpc: '2.0'; id: number; method: string; params: unknown[] };
type Check = { name: string; passed: boolean; durationMs: number };

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function missingBlockError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { code, message } = value as { code?: unknown; message?: unknown };
  return (code === -32000 || code === -32001) && typeof message === 'string' &&
    /^(?:unknown block|block not found|header not found)(?:[.:]?\s*0x[0-9a-f]{64})?[.!]?$/i.test(message.trim());
}

export async function verifyQuickNodeProvider(options: { contract: string; transactionHash: string; deploymentBlock: number;
  endpoint: string; fetch?: typeof fetch }): Promise<{ provider: 'quicknode'; chainId: 1; observedBlock: number; passed: boolean; checks: Check[] }> {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.quiknode.pro') || endpoint.username || endpoint.password || endpoint.hash ||
    !/^0x[0-9a-fA-F]{40}$/.test(options.contract) || !/^0x[0-9a-fA-F]{64}$/.test(options.transactionHash) ||
    !Number.isSafeInteger(options.deploymentBlock) || options.deploymentBlock < 1) throw new Error('Invalid provider verification configuration.');
  let nextId = 0;
  const checks: Check[] = [];
  const request = (method: string, params: unknown[]): RpcRequest => ({ jsonrpc: '2.0', id: ++nextId, method, params });
  async function send(payload: RpcRequest | RpcRequest[]): Promise<EthereumRpcEnvelope | EthereumRpcEnvelope[]> {
    const signal = AbortSignal.timeout(10_000);
    const response = await (options.fetch ?? fetch)(endpoint, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
    if (!response.ok) throw new Error('Provider request failed.');
    const body = await readBoundedResponseJson(response, { maxBytes: 3 * 1024 * 1024, contentType: 'require-json', signal,
      createError: () => new Error('Provider response failed validation.') });
    if (!validEthereumRpcResponse(payload, body)) throw new Error('Provider response failed validation.');
    return body;
  }
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const payload = request(method, params);
    const result = await send(payload);
    if (Array.isArray(result) || !('result' in result)) throw new Error('Provider result failed validation.');
    return result.result;
  }
  async function check(name: string, operation: () => Promise<boolean>): Promise<void> {
    const start = performance.now();
    let passed = false;
    try { passed = await operation(); } catch {}
    checks.push({ name, passed, durationMs: Math.round(performance.now() - start) });
  }
  await check('ethereum-mainnet-chain-id', async () => await rpc('eth_chainId', []) === '0x1');
  const head = await rpc('eth_getBlockByNumber', ['latest', false]) as { number: string; hash: string };
  if (!head || !validHash(head.hash)) throw new Error('Invalid provider block.');
  const observedBlock = rpcInteger(head.number);
  const canonical = { blockHash: head.hash, requireCanonical: true };
  const data = encodeCall('stats(address)', ['address'], ['0x0000000000000000000000000000000000000000']);
  let pinned: unknown;
  await check('pinned-contract-statistics', async () => {
    pinned = await rpc('eth_call', [{ to: options.contract, data }, head.number]);
    return decode111kStats(pinned) !== null;
  });
  await check('eip1898-canonical-state', async () => await rpc('eth_call', [{ to: options.contract, data }, canonical]) === pinned);
  await check('eip1898-contract-code', async () => {
    const code = await rpc('eth_getCode', [options.contract, canonical]);
    return typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code);
  });
  await check('eip1898-missing-block-rejected', async () => {
    const payload = request('eth_call', [{ to: options.contract, data }, { blockHash: `0x${'f'.repeat(64)}`, requireCanonical: true }]);
    const result = await send(payload);
    return !Array.isArray(result) && 'error' in result && missingBlockError(result.error);
  });
  await check('canonical-batch', async () => {
    const payload = [request('eth_call', [{ to: options.contract, data }, canonical]), request('eth_chainId', [])];
    const results = await send(payload);
    return Array.isArray(results) && results.length === 2 &&
      results.find(result => result.id === payload[0].id)?.result === pinned &&
      results.find(result => result.id === payload[1].id)?.result === '0x1';
  });
  await check('historical-block', async () => {
    const block = await rpc('eth_getBlockByNumber', [`0x${options.deploymentBlock.toString(16)}`, false]) as { number?: string; hash?: string };
    return !!block?.number && Number(BigInt(block.number)) === options.deploymentBlock && typeof block.hash === 'string';
  });
  await check('canonical-transaction-receipt', async () => {
    const receipt = await rpc('eth_getTransactionReceipt', [options.transactionHash]) as { transactionHash?: string; blockHash?: string; blockNumber?: string };
    if (!validHash(receipt?.transactionHash) || !validHash(receipt?.blockHash) ||
      receipt.transactionHash.toLowerCase() !== options.transactionHash.toLowerCase()) return false;
    const number = rpcInteger(receipt.blockNumber);
    if (number > observedBlock) return false;
    const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) as { number?: string; hash?: string };
    return validHash(block?.hash) && rpcInteger(block.number) === number && block.hash.toLowerCase() === receipt.blockHash.toLowerCase();
  });
  await check('bounded-logs', async () => Array.isArray(await rpc('eth_getLogs', [{ address: options.contract,
    fromBlock: `0x${Math.max(0, observedBlock - 4).toString(16)}`, toBlock: head.number }])));
  await check('head-still-canonical', async () => (await rpc('eth_getBlockByNumber', [head.number, false]) as { hash?: string })?.hash === head.hash);
  return { provider: 'quicknode', chainId: 1, observedBlock, passed: checks.every(value => value.passed), checks };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const { values } = parseArgs({ options: { contract: { type: 'string' }, transaction: { type: 'string' }, 'deployment-block': { type: 'string' } } });
    const result = await verifyQuickNodeProvider({ contract: values.contract ?? '', transactionHash: values.transaction ?? '',
      deploymentBlock: Number(values['deployment-block']), endpoint: process.env.QUICKNODE_ETHEREUM_MAINNET_RPC_URL ?? '' });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch { console.error('Provider verification failed. Check local credentials, arguments and connectivity.'); process.exitCode = 1; }
}
