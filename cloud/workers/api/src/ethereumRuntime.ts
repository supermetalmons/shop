import { resolveEthereum111kConfig } from '../../../../shared/ethereum/config.js';
import type { Ethereum111kConfig } from '../../../../shared/ethereum/api.js';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.js';
import { EthereumApiError } from './ethereumError.js';
import { readBoundedResponseJson } from './boundedResponse.js';
import { rpcInteger } from './ethereumRpcValue.js';

export { rpcInteger } from './ethereumRpcValue.js';

const CONTRACT_READ_BATCH_SIZE = 4;
const CONTRACT_READ_CONCURRENCY = 2;

type EthereumBlockSnapshot = { blockNumber: number; blockHash: string };

export type EthereumEnvironment = Pick<Env,
  'OPS_DB' | 'COMMERCE_DB' | 'ALCHEMY_MI_NOTE_API_KEY' |
  'ETHEREUM_111K_CHAIN_ID' | 'ETHEREUM_111K_CONTRACT_ADDRESS' |
  'ETHEREUM_111K_DEPLOYMENT_BLOCK' |
  'ETHEREUM_111K_METADATA_BASE_URI' |
  'ETHEREUM_111K_RPC_URL' |
  'STAFF_AUTH_CHALLENGE_RATE_LIMITER' | 'STAFF_AUTH_SESSION_RATE_LIMITER' |
  'PUBLIC_SHOP_RATE_LIMITER'
> & Partial<Pick<Env, 'ETHEREUM_REVEAL' | 'ETHEREUM_REVEAL_READ_RATE_LIMITER' | 'ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER'>> &
  { ETHEREUM_111K_SIGNER_SECRET?: string };

export type EthereumContext = {
  env: EthereumEnvironment;
  config: Ethereum111kConfig;
  signal: AbortSignal;
  nowMs: number;
  fetch: typeof fetch;
  chainCheck?: Promise<void>;
};

export function ethereumConfig(env: EthereumEnvironment): Ethereum111kConfig {
  const localRpc = Number(env.ETHEREUM_111K_CHAIN_ID) === 31337
    ? localEthereumRpcUrl(env.ETHEREUM_111K_RPC_URL || 'http://127.0.0.1:8545') : undefined;
  return resolveEthereum111kConfig({
    chainId: Number(env.ETHEREUM_111K_CHAIN_ID || '11155111'),
    contractAddress: env.ETHEREUM_111K_CONTRACT_ADDRESS || null,
    metadataBaseUri: env.ETHEREUM_111K_METADATA_BASE_URI,
    deploymentBlock: Number(env.ETHEREUM_111K_DEPLOYMENT_BLOCK || '0'),
    ...(localRpc ? { walletRpcUrl: localRpc } : {}),
  });
}

function localEthereumRpcUrl(value: string): string {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash) {
    throw new EthereumApiError('unavailable', 'Local Ethereum RPC configuration is invalid.');
  }
  return url.toString();
}

export function requireEthereumContract(context: EthereumContext): string {
  if (!context.config.enabled || !context.config.contractAddress) {
    throw new EthereumApiError('failed-precondition', 'The Ethereum test collection has not been deployed yet.');
  }
  return context.config.contractAddress;
}

function ethereumRpcUrl(context: EthereumContext): string {
  if (context.config.chainId === 31337) {
    const configured = context.env.ETHEREUM_111K_RPC_URL;
    if (!configured) throw new EthereumApiError('unavailable', 'Local Ethereum RPC is not configured.');
    return localEthereumRpcUrl(configured);
  }
  const key = context.env.ALCHEMY_MI_NOTE_API_KEY?.trim();
  if (!key) throw new EthereumApiError('unavailable', 'Ethereum RPC is not configured.');
  return `https://eth-sepolia.g.alchemy.com/v2/${encodeURIComponent(key)}`;
}

async function rpcRequest(context: EthereumContext, payload: unknown): Promise<unknown> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]);
  const response = await context.fetch(ethereumRpcUrl(context), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await readBoundedResponseJson(response, {
    maxBytes: 3 * 1024 * 1024,
    contentType: 'require-json', signal,
    createError: () => new EthereumApiError('unavailable', 'Ethereum RPC returned an invalid response.'),
  });
  if (!response.ok) {
    throw new EthereumApiError('unavailable', 'Ethereum RPC is temporarily unavailable.');
  }
  return body;
}

export async function ethereumRpc(context: EthereumContext, method: string, params: unknown[]): Promise<unknown> {
  const chainCheck = method === 'eth_chainId' ? Promise.resolve() : checkEthereumChain(context);
  if (method !== 'eth_getTransactionReceipt') await chainCheck;
  const [, body] = await Promise.all([chainCheck, rpcRequest(context, { jsonrpc: '2.0', id: 1, method, params })]);
  if (!body || typeof body !== 'object' || !('result' in body) || 'error' in body) {
    throw new EthereumApiError('unavailable', 'Ethereum RPC is temporarily unavailable.');
  }
  return body.result;
}

export async function ethereumCallBatch(context: EthereumContext, calls: string[], blockReference = 'latest'): Promise<string[]> {
  if (!calls.length) return [];
  await checkEthereumChain(context);
  const to = requireEthereumContract(context);
  const values = new Array<string>(calls.length);
  const cancellation = new AbortController();
  const batchContext = { ...context, signal: AbortSignal.any([context.signal, cancellation.signal]) };
  let nextOffset = 0;
  await Promise.all(Array.from({ length: Math.min(CONTRACT_READ_CONCURRENCY, Math.ceil(calls.length / CONTRACT_READ_BATCH_SIZE)) }, async () => {
    try {
      while (nextOffset < calls.length) {
        batchContext.signal.throwIfAborted();
        const offset = nextOffset;
        nextOffset += CONTRACT_READ_BATCH_SIZE;
        const batch = calls.slice(offset, offset + CONTRACT_READ_BATCH_SIZE);
        const body = await rpcRequest(batchContext, batch.map((data, index) => ({ jsonrpc: '2.0', id: index + 1,
          method: 'eth_call', params: [{ to, data }, blockReference] })));
        if (!Array.isArray(body) || body.length !== batch.length) throw new EthereumApiError('unavailable', 'Ethereum RPC returned an incomplete response.');
        const results = new Map<number, string>();
        for (const value of body) {
          if (!value || typeof value !== 'object' || !Number.isInteger(value.id) || value.id < 1 || value.id > batch.length ||
            results.has(value.id) || 'error' in value || typeof value.result !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.result)) {
            throw new EthereumApiError('unavailable', 'Ethereum RPC returned an invalid response.');
          }
          results.set(value.id, value.result);
        }
        batch.forEach((_call, index) => { values[offset + index] = results.get(index + 1)!; });
      }
    } catch (error) {
      cancellation.abort(error);
      throw error;
    }
  }));
  context.signal.throwIfAborted();
  return values;
}

export async function ethereumBlockSnapshot(context: EthereumContext): Promise<EthereumBlockSnapshot> {
  const block = await ethereumRpc(context, 'eth_getBlockByNumber', ['latest', false]);
  if (!block || typeof block !== 'object' || !('number' in block) || !('hash' in block) ||
    typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
    throw new EthereumApiError('unavailable', 'Ethereum block data is unavailable.');
  }
  return { blockNumber: rpcInteger(block.number), blockHash: block.hash.toLowerCase() };
}

export async function verifyEthereumBlockSnapshot(context: EthereumContext, snapshot: EthereumBlockSnapshot): Promise<void> {
  const block = await ethereumRpc(context, 'eth_getBlockByNumber', [ethereumHexQuantity(snapshot.blockNumber), false]);
  if (!block || typeof block !== 'object' || !('hash' in block) || typeof block.hash !== 'string' ||
    block.hash.toLowerCase() !== snapshot.blockHash.toLowerCase()) {
    throw new EthereumApiError('unavailable', 'Ethereum changed while reading your items. Try again.');
  }
}

async function checkEthereumChain(context: EthereumContext): Promise<void> {
  context.chainCheck ??= (async () => {
    const chain = await ethereumRpc(context, 'eth_chainId', []);
    if (rpcInteger(chain) !== context.config.chainId) throw new EthereumApiError('unavailable', 'Ethereum RPC is connected to the wrong network.');
  })();
  return context.chainCheck;
}

export async function ethereumCall(context: EthereumContext, data: string, to = requireEthereumContract(context)): Promise<string> {
  const result = await ethereumRpc(context, 'eth_call', [{ to, data }, 'latest']);
  if (typeof result !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) {
    throw new EthereumApiError('unavailable', 'Ethereum contract returned an invalid response.');
  }
  return result;
}

export function ethereumAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) {
    throw new EthereumApiError('invalid-argument', 'Invalid Ethereum wallet.');
  }
  return value.toLowerCase();
}

export function ethereumTransactionHash(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new EthereumApiError('invalid-argument', 'Invalid Ethereum transaction hash.');
  }
  return value.toLowerCase();
}
