import { resolveEthereum111kConfig } from '../../../../shared/ethereum/config.js';
import type { Ethereum111kConfig } from '../../../../shared/ethereum/api.js';
import { decodeReturn, encodeCall } from '../../../../shared/ethereum/abi.js';
import { ETHEREUM_FUNCTIONS, ETHEREUM_MAX_RELICS, ethereumHexQuantity } from '../../../../shared/ethereum/protocol.js';
import { EthereumApiError } from './ethereumError.js';
import { rpcInteger } from './ethereumRpcValue.js';
import { mapWithConcurrency } from './mapWithConcurrency.js';
import { createEthereumProviderAttempt, ethereumProviderBudget, withEthereumProvider, type EthereumProviderAttempt, type EthereumProviderEnvironment } from './ethereumProvider.js';
import type { EthereumPublicReadCacheBinding, EthereumPublicReadCacheScope } from './ethereumPublicReadCache.js';
import type { ProviderBudgetClient, ProviderLane } from './ethereumProviderBudget.js';

export { rpcInteger } from './ethereumRpcValue.js';

const CONTRACT_READ_BATCH_SIZE = 4;
const CONTRACT_READ_CONCURRENCY = 2;
const PUBLIC_READ_PERMIT_QUANTUM = 100;

type EthereumBlockSnapshot = { blockNumber: number; blockHash: string };

export type EthereumEnvironment = Pick<Env,
  'OPS_DB' | 'COMMERCE_DB' | 'ALCHEMY_MI_NOTE_API_KEY' |
  'ETHEREUM_111K_CHAIN_ID' | 'ETHEREUM_111K_CONTRACT_ADDRESS' |
  'ETHEREUM_111K_DEPLOYMENT_BLOCK' |
  'ETHEREUM_111K_METADATA_BASE_URI' |
  'ETHEREUM_111K_RPC_URL' |
  'STAFF_AUTH_CHALLENGE_RATE_LIMITER' | 'STAFF_AUTH_SESSION_RATE_LIMITER' |
  'PUBLIC_SHOP_RATE_LIMITER'
> & EthereumProviderEnvironment & Partial<Pick<Env, 'ETHEREUM_REVEAL' | 'ETHEREUM_REVEAL_READ_RATE_LIMITER' | 'ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER' |
  'ETHEREUM_111K_DELIVERY_CONFIG_ID' | 'ETHEREUM_111K_REDEMPTION_SIGNING_ENABLED'>> &
  { ETHEREUM_111K_SIGNER_SECRET?: string; ETHEREUM_PUBLIC_READ_CACHE?: EthereumPublicReadCacheBinding;
    ETHEREUM_PUBLIC_READ_CACHE_ENABLED?: string };

export type EthereumReadContext = {
  env: Pick<EthereumEnvironment, 'ALCHEMY_MI_NOTE_API_KEY' | 'ETHEREUM_111K_RPC_URL'> & EthereumProviderEnvironment;
  config: Pick<Ethereum111kConfig, 'chainId' | 'contractAddress' | 'enabled'>;
  signal: AbortSignal;
  fetch: typeof fetch;
  chainCheck?: Promise<void>;
  relicInterfaceCheck?: Promise<boolean>;
  providerAttempt?: EthereumProviderAttempt;
  providerBudgetClient?: ProviderBudgetClient;
  providerLane?: ProviderLane;
  publicReadCacheScope?: EthereumPublicReadCacheScope;
  publicReadCacheExpiresAtMs?: number;
};

export type EthereumContext = EthereumReadContext & {
  env: EthereumEnvironment;
  config: Ethereum111kConfig;
  nowMs: number;
};

export type EthereumRequestContext = Pick<EthereumContext, 'env' | 'nowMs' | 'signal' | 'fetch'>;

export type EthereumCollectionReadContext = EthereumReadContext & EthereumRequestContext & {
  config: Pick<Ethereum111kConfig, 'chainId' | 'contractAddress' | 'enabled' | 'metadataBaseUri' | 'deploymentBlock'>;
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

export function localEthereumRpcUrl(value: string): string {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash) {
    throw new EthereumApiError('unavailable', 'Local Ethereum RPC configuration is invalid.');
  }
  return url.toString();
}

export function requireEthereumContract(context: EthereumReadContext): string {
  if (!context.config.enabled || !context.config.contractAddress) {
    throw new EthereumApiError('failed-precondition', 'The Ethereum collection has not been deployed yet.');
  }
  return context.config.contractAddress;
}

export async function ethereumRelicInterfaceAvailable(context: EthereumReadContext): Promise<boolean> {
  context.relicInterfaceCheck ??= (async () => {
    const [maximum, mask] = await ethereumCallBatch(context, [encodeCall('MAX_RELICS()', [], []),
      encodeCall(ETHEREUM_FUNCTIONS.relicClaimedMask, [], [])]);
    return maximum.length === 66 && mask.length === 66 &&
      decodeReturn(['uint256'], maximum)[0] === BigInt(ETHEREUM_MAX_RELICS) &&
      (decodeReturn(['uint256'], mask)[0] as bigint) < 1n << BigInt(ETHEREUM_MAX_RELICS);
  })();
  return context.relicInterfaceCheck;
}

async function rpcRequest(context: EthereumReadContext, payload: Parameters<EthereumProviderAttempt['request']>[0]): Promise<unknown> {
  if (context.config.chainId === 31337 && !context.env.ETHEREUM_111K_RPC_URL) {
    throw new EthereumApiError('unavailable', 'Local Ethereum RPC is not configured.');
  }
  context.providerAttempt ??= createEthereumProviderAttempt(context.env, context.config.chainId,
    context.config.chainId === 31337 ? 'local' : 'alchemy', context.signal,
    { lane: context.providerLane, fetch: context.fetch, budgetClient: context.providerBudgetClient ??= ethereumProviderBudget(
      context.env, context.config.chainId, (context.providerLane ?? 'public') === 'public' ? PUBLIC_READ_PERMIT_QUANTUM : undefined) });
  return context.providerAttempt.request(payload, context.signal);
}

export function withEthereumReadProvider<T, C extends EthereumReadContext>(context: C, operation: (selected: C) => Promise<T>): Promise<T> {
  if (context.providerAttempt) return operation(context);
  const budgetClient = context.providerBudgetClient ?? ethereumProviderBudget(context.env, context.config.chainId,
    (context.providerLane ?? 'public') === 'public' ? PUBLIC_READ_PERMIT_QUANTUM : undefined);
  return withEthereumProvider(context.env, context.config.chainId, context.signal, attempt => operation({ ...context,
    signal: attempt.signal, providerAttempt: attempt, providerBudgetClient: budgetClient, chainCheck: undefined, relicInterfaceCheck: undefined }),
  { lane: context.providerLane ?? 'public', fetch: context.fetch, budgetClient });
}

export type EthereumBlockReference = string | { blockHash: string; requireCanonical: true };

function ethereumBlockReference(value: EthereumBlockReference): EthereumBlockReference {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? { blockHash: value, requireCanonical: true } : value;
}

export async function ethereumRpc(context: EthereumReadContext, method: string, params: unknown[]): Promise<unknown> {
  const chainCheck = method === 'eth_chainId' ? Promise.resolve() : checkEthereumChain(context);
  if (method !== 'eth_getTransactionReceipt') await chainCheck;
  const [, body] = await Promise.all([chainCheck, rpcRequest(context, { jsonrpc: '2.0', id: 1, method, params })]);
  if (!body || typeof body !== 'object' || !('result' in body) || 'error' in body) {
    throw new EthereumApiError('unavailable', 'Ethereum RPC is temporarily unavailable.');
  }
  return body.result;
}

export async function ethereumCallBatch(context: EthereumReadContext, calls: string[], blockReference: EthereumBlockReference = 'latest'): Promise<string[]> {
  if (!calls.length) return [];
  await checkEthereumChain(context);
  const to = requireEthereumContract(context);
  const offsets = Array.from({ length: Math.ceil(calls.length / CONTRACT_READ_BATCH_SIZE) }, (_, index) => index * CONTRACT_READ_BATCH_SIZE);
  const values = await mapWithConcurrency(offsets, CONTRACT_READ_CONCURRENCY, async (offset, _index, signal) => {
    const batch = calls.slice(offset, offset + CONTRACT_READ_BATCH_SIZE);
    const body = await rpcRequest({ ...context, signal }, batch.map((data, index) => ({ jsonrpc: '2.0', id: index + 1,
      method: 'eth_call', params: [{ to, data }, ethereumBlockReference(blockReference)] })));
    if (!Array.isArray(body) || body.length !== batch.length) throw new EthereumApiError('unavailable', 'Ethereum RPC returned an incomplete response.');
    const results = new Map<number, string>();
    for (const value of body) {
      if (!value || typeof value !== 'object' || !Number.isInteger(value.id) || value.id < 1 || value.id > batch.length ||
        results.has(value.id) || 'error' in value || typeof value.result !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.result)) {
        throw new EthereumApiError('unavailable', 'Ethereum RPC returned an invalid response.');
      }
      results.set(value.id, value.result);
    }
    return batch.map((_call, index) => results.get(index + 1)!);
  }, { signal: context.signal, failureMode: 'fail-fast' });
  return values.flat();
}

export async function ethereumBlockSnapshot(context: EthereumReadContext): Promise<EthereumBlockSnapshot> {
  const block = await ethereumRpc(context, 'eth_getBlockByNumber', ['latest', false]);
  if (!block || typeof block !== 'object' || !('number' in block) || !('hash' in block) ||
    typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
    throw new EthereumApiError('unavailable', 'Ethereum block data is unavailable.');
  }
  return { blockNumber: rpcInteger(block.number), blockHash: block.hash.toLowerCase() };
}

export async function verifyEthereumBlockSnapshot(context: EthereumReadContext, snapshot: EthereumBlockSnapshot): Promise<void> {
  const block = await ethereumRpc(context, 'eth_getBlockByNumber', [ethereumHexQuantity(snapshot.blockNumber), false]);
  if (!block || typeof block !== 'object' || !('hash' in block) || typeof block.hash !== 'string' ||
    block.hash.toLowerCase() !== snapshot.blockHash.toLowerCase()) {
    throw new EthereumApiError('unavailable', 'Ethereum changed while reading your items. Try again.');
  }
}

async function checkEthereumChain(context: EthereumReadContext): Promise<void> {
  context.chainCheck ??= (async () => {
    const chain = await ethereumRpc(context, 'eth_chainId', []);
    if (rpcInteger(chain) !== context.config.chainId) throw new EthereumApiError('unavailable', 'Ethereum RPC is connected to the wrong network.');
  })();
  return context.chainCheck;
}

export async function ethereumCall(context: EthereumReadContext, data: string, to = requireEthereumContract(context)): Promise<string> {
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
