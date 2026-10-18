import { resolveEthereum111kConfig } from '../../../../shared/ethereum/config.js';
import type { Ethereum111kConfig } from '../../../../shared/ethereum/api.js';
import { EthereumApiError } from './ethereumError.js';
import { readBoundedResponseJson } from './boundedResponse.js';

export type EthereumEnvironment = Pick<Env,
  'OPS_DB' | 'COMMERCE_DB' | 'ALCHEMY_MI_NOTE_API_KEY' |
  'ETHEREUM_111K_CHAIN_ID' | 'ETHEREUM_111K_CONTRACT_ADDRESS' |
  'ETHEREUM_111K_RENDERER_ADDRESS' | 'ETHEREUM_111K_DEPLOYMENT_BLOCK' |
  'ETHEREUM_111K_RPC_URL' |
  'STAFF_AUTH_CHALLENGE_RATE_LIMITER' | 'STAFF_AUTH_SESSION_RATE_LIMITER' |
  'PUBLIC_SHOP_RATE_LIMITER'
> & { ETHEREUM_111K_SIGNER_SECRET?: string };

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
    rendererAddress: env.ETHEREUM_111K_RENDERER_ADDRESS || null,
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

export async function ethereumCallBatch(context: EthereumContext, calls: string[]): Promise<string[]> {
  if (!calls.length) return [];
  if (calls.length > 150) throw new EthereumApiError('invalid-argument', 'Too many contract reads.');
  await checkEthereumChain(context);
  const to = requireEthereumContract(context);
  const body = await rpcRequest(context, calls.map((data, index) => ({ jsonrpc: '2.0', id: index + 1,
    method: 'eth_call', params: [{ to, data }, 'latest'] })));
  if (!Array.isArray(body) || body.length !== calls.length) throw new EthereumApiError('unavailable', 'Ethereum RPC returned an incomplete response.');
  const results = new Map<number, string>();
  for (const value of body) {
    if (!value || typeof value !== 'object' || !Number.isInteger(value.id) || value.id < 1 || value.id > calls.length ||
      results.has(value.id) || typeof value.result !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.result)) {
      throw new EthereumApiError('unavailable', 'Ethereum RPC returned an invalid response.');
    }
    results.set(value.id, value.result);
  }
  return calls.map((_call, index) => results.get(index + 1)!);
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

export function rpcInteger(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new EthereumApiError('unavailable', 'Invalid Ethereum block number.');
  }
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) throw new EthereumApiError('unavailable', 'Invalid Ethereum number.');
  return number;
}
