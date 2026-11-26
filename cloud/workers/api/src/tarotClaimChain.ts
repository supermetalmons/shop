import { isIP } from 'node:net';
import { createPublicClient, custom, getAddress, isAddress, keccak256, parseTransaction, recoverTransactionAddress,
  RpcRequestError, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { decodeReturn } from '../../../../shared/ethereum/abi.js';
import { recoverEthereumAddress } from '../../../../shared/ethereum/crypto.js';
import { encodeTarotClaimTo } from '../../../../shared/ethereum/tarot.js';
import { tarotClaimDigest } from '../../../../shared/ethereum/tarotCrypto.js';
import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import { EthereumApiError } from './ethereumError.js';
import { createEthereumProviderAttempt, RpcProviderError, type EthereumProviderEnvironment } from './ethereumProvider.js';
import { ethereumRpc } from './ethereumRuntime.js';
import { confirmTarotClaim, createTarotAuthorization, requireTarotCodeHash, tarotConfig, tarotSigner, tarotState,
  type TarotContext, type TarotEnvironment } from './tarotClaimSupport.js';
import type { TarotClaimAttempt, TarotClaimChain, TarotClaimInput, TarotClaimScope, TarotSignedClaim } from './tarotClaimRelayer.js';

export type TarotRelayerEnvironment = TarotEnvironment & Partial<Pick<Env,
  'ETHEREUM_TAROT_MAINNET_RELAYER_SECRET' | 'ETHEREUM_TAROT_SEPOLIA_RELAYER_SECRET' |
  'ETHEREUM_TAROT_MAINNET_MAX_CLAIM_FEE_WEI' | 'ETHEREUM_TAROT_SEPOLIA_MAX_CLAIM_FEE_WEI' |
  'ETHEREUM_TAROT_MAINNET_SPONSORSHIP_ENABLED' | 'ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED'>>;

type Dependencies = { fetch?: typeof fetch; nowMs?: () => number };
type SignedAttempt = TarotClaimAttempt & { signed: TarotSignedClaim };
const DEFAULT_MAXIMUM_FEE_WEI = 1_500_000_000_000_000n;
const MINIMUM_TIP_WEI = 100_000_000n;
const MAXIMUM_TIP_WEI = 2_000_000_000n;
const MAXIMUM_GAS = 600_000n;

function unavailable(message = 'Backend claiming is temporarily unavailable.'): never {
  throw new EthereumApiError('unavailable', message);
}

function recipientError(message: string): never {
  throw new EthereumApiError('invalid-argument', message, { field: 'recipient' });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return unavailable();
  return BigInt(value);
}

function decimal(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return unavailable();
  return BigInt(value);
}

function address(value: string): string {
  if (!isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) return recipientError('Enter a valid Ethereum address or ENS name.');
  const plain = value.slice(2);
  if (plain !== plain.toLowerCase() && plain !== plain.toUpperCase() && getAddress(value) !== value) {
    return recipientError('This address has an invalid checksum.');
  }
  return value.toLowerCase();
}

async function providerRpc(env: EthereumProviderEnvironment, chainId: number, method: string, params: unknown[],
  signal: AbortSignal, providerFetch: typeof fetch): Promise<unknown> {
  const attempt = createEthereumProviderAttempt(env, chainId, 'alchemy', signal, { fetch: providerFetch, lane: 'background',
    allowTransactionSubmission: method === 'eth_sendRawTransaction' });
  try {
    const body = object(await attempt.request({ jsonrpc: '2.0', id: 1, method, params }));
    if ('error' in body) {
      const error = object(body.error);
      if (typeof error.code !== 'number' || typeof error.message !== 'string') return unavailable();
      throw new RpcRequestError({ body: { method, params }, error: { code: error.code, message: error.message, data: error.data }, url: 'Ethereum RPC' });
    }
    if (!('result' in body)) return unavailable();
    return body.result;
  } finally {
    attempt.cancel();
    await attempt.drain();
  }
}

export async function resolveTarotRecipient(env: EthereumProviderEnvironment, input: string, signal: AbortSignal,
  dependencies: Pick<Dependencies, 'fetch'> = {}): Promise<string> {
  const value = input.trim();
  if (!value || value.length > 255) return recipientError('Enter a valid Ethereum address or ENS name.');
  if (/^0x/i.test(value)) return address(value);
  let name: string;
  try { name = normalize(value); } catch { return recipientError('Enter a valid Ethereum address or ENS name.'); }
  if (!name.includes('.')) return recipientError('Enter a valid Ethereum address or ENS name.');
  const providerFetch = dependencies.fetch ?? fetch;
  const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  let gatewayRequests = 0;
  const client = createPublicClient({ chain: mainnet, cacheTime: 0,
    transport: custom({ request: async ({ method, params }) => {
      if (method !== 'eth_call') return unavailable();
      return providerRpc(env, 1, method, Array.isArray(params) ? params : [], lookupSignal, providerFetch);
    } }, { retryCount: 0 }),
    ccipRead: { request: async ({ data, sender, urls }) => {
      for (const template of urls.slice(0, 4)) {
        lookupSignal.throwIfAborted();
        if (++gatewayRequests > 8) return unavailable('Couldn’t resolve this ENS name. Please try again.');
        try {
          const url = new URL(template.replaceAll('{sender}', sender).replaceAll('{data}', data));
          if (url.protocol !== 'https:' || url.username || url.password || isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
            !url.hostname.includes('.') || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) continue;
          const get = template.includes('{data}');
          const response = await providerFetch(url, { method: get ? 'GET' : 'POST', redirect: 'error',
            headers: { Accept: 'application/json', ...(!get ? { 'Content-Type': 'application/json' } : {}) },
            ...(!get ? { body: JSON.stringify({ data, sender }) } : {}), signal: lookupSignal });
          if (!response.ok) { await cancelResponseBody(response); continue; }
          const result = object(await readBoundedResponseJson(response, { maxBytes: 128 * 1024, contentType: 'require-json',
            signal: lookupSignal, createError: () => new Error('Invalid ENS response.') }));
          if (typeof result.data === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(result.data)) return result.data as Hex;
        } catch { lookupSignal.throwIfAborted(); }
      }
      return unavailable('Couldn’t resolve this ENS name. Please try again.');
    } },
  });
  let resolved: string | null;
  try {
    if (quantity(await providerRpc(env, 1, 'eth_chainId', [], lookupSignal, providerFetch)) !== 1n) return unavailable();
    resolved = await client.getEnsAddress({ name, coinType: 60n });
  } catch {
    signal.throwIfAborted();
    return unavailable('Couldn’t resolve this ENS name. Please try again.');
  }
  if (!resolved || /^0x0{40}$/i.test(resolved)) return recipientError('This ENS name has no Ethereum address.');
  return address(resolved);
}

function relayerAccount(env: TarotRelayerEnvironment, chainId: number) {
  const secret = (chainId === 1 ? env.ETHEREUM_TAROT_MAINNET_RELAYER_SECRET : env.ETHEREUM_TAROT_SEPOLIA_RELAYER_SECRET)?.trim();
  if (!secret || !/^(?:0x)?[0-9a-f]{64}$/i.test(secret)) return unavailable();
  try { return privateKeyToAccount(`0x${secret.replace(/^0x/, '')}`); } catch { return unavailable(); }
}

function maximumFee(env: TarotRelayerEnvironment, chainId: number): bigint {
  const configured = chainId === 1 ? env.ETHEREUM_TAROT_MAINNET_MAX_CLAIM_FEE_WEI : env.ETHEREUM_TAROT_SEPOLIA_MAX_CLAIM_FEE_WEI;
  const maximum = configured === undefined ? DEFAULT_MAXIMUM_FEE_WEI : decimal(configured);
  if (maximum <= 0n) return unavailable();
  return maximum;
}

function requireSponsorship(env: TarotRelayerEnvironment, chainId: number): void {
  if ((chainId === 1 ? env.ETHEREUM_TAROT_MAINNET_SPONSORSHIP_ENABLED : env.ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED) !== 'true') {
    return unavailable();
  }
}

async function signedData(attempt: SignedAttempt): Promise<{ data: Hex; authorizationSigner: string }> {
  const signed = attempt.signed;
  if (!/^0x02(?:[0-9a-f]{2})+$/i.test(signed.rawTransaction) ||
    keccak256(signed.rawTransaction as Hex) !== signed.transactionHash) return unavailable();
  const serializedTransaction = signed.rawTransaction as `0x02${string}`;
  const transaction = parseTransaction(serializedTransaction);
  if (transaction.type !== 'eip1559' || transaction.chainId !== attempt.chainId ||
    transaction.to?.toLowerCase() !== attempt.contractAddress || (transaction.value ?? 0n) !== 0n ||
    transaction.nonce !== Number(decimal(signed.nonce)) || !transaction.data ||
    !transaction.gas || !transaction.maxFeePerGas || transaction.gas * transaction.maxFeePerGas !== decimal(signed.maximumFeeWei) ||
    (await recoverTransactionAddress({ serializedTransaction })).toLowerCase() !== signed.relayerAddress) return unavailable();
  try {
    const [recipient, tokenId, deadline, signature] = decodeReturn(['address', 'uint256', 'uint256', 'bytes'], `0x${transaction.data.slice(10)}`);
    if (recipient !== attempt.recipient || tokenId !== BigInt(attempt.tokenId) || deadline !== BigInt(signed.authorizationDeadline) ||
      typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature) ||
      encodeTarotClaimTo(attempt.recipient, attempt.tokenId, signed.authorizationDeadline, signature) !== transaction.data) return unavailable();
    const authorizationSigner = recoverEthereumAddress(tarotClaimDigest({ chainId: attempt.chainId,
      contractAddress: attempt.contractAddress, wallet: attempt.recipient, tokenId: attempt.tokenId,
      deadline: signed.authorizationDeadline }), signature);
    if (!authorizationSigner) return unavailable();
    return { data: transaction.data, authorizationSigner };
  } catch { return unavailable(); }
}

export function createTarotClaimChain(env: TarotRelayerEnvironment, dependencies: Dependencies = {}): TarotClaimChain {
  const providerFetch = dependencies.fetch ?? fetch;
  const now = dependencies.nowMs ?? Date.now;
  const context = (scope: TarotClaimScope, observing = false): TarotContext => {
    const config = tarotConfig(env, scope.chainId === 11155111);
    if (!observing && (config.contractAddress !== scope.contractAddress || !config.enabled)) {
      throw new EthereumApiError('failed-precondition', 'This Tarot drop is no longer available.');
    }
    return { env, config: observing ? { ...config, contractAddress: scope.contractAddress, enabled: true, deploymentBlock: 0 } : config,
      nowMs: now(), signal: AbortSignal.timeout(30_000), fetch: providerFetch, providerLane: 'background' };
  };
  const validate = async (input: TarotClaimInput): Promise<void> => {
    requireSponsorship(env, input.chainId);
    const read = context(input);
    await requireTarotCodeHash(read, input.tokenId, input.codeHash);
    if (relayerAccount(env, input.chainId).address.toLowerCase() === tarotSigner(read)?.address) {
      throw new EthereumApiError('failed-precondition', 'Backend claiming is temporarily unavailable.', { kind: 'relayer-configuration' });
    }
    const state = await tarotState(read, input.tokenId);
    if (state.claimed) throw new EthereumApiError('failed-precondition', 'This card has already been claimed.');
    if (state.mintingPaused || tarotSigner(read)?.address !== state.signer) return unavailable();
  };
  return {
    relayerAddress: chainId => relayerAccount(env, chainId).address.toLowerCase(),
    validate,
    async nonce(scope) {
      const read = context(scope);
      const sender = relayerAccount(env, scope.chainId).address.toLowerCase();
      const [latest, pending] = await Promise.all(['latest', 'pending'].map(tag => ethereumRpc(read, 'eth_getTransactionCount', [sender, tag])));
      return { latest: quantity(latest).toString(), pending: quantity(pending).toString() };
    },
    async prepare(input, nonce, outstandingFeeWei) {
      requireSponsorship(env, input.chainId);
      const read = context(input);
      const recipient = address(input.recipient);
      const account = relayerAccount(env, input.chainId);
      await requireTarotCodeHash(read, input.tokenId, input.codeHash);
      if (account.address.toLowerCase() === tarotSigner(read)?.address) {
        throw new EthereumApiError('failed-precondition', 'Backend claiming is temporarily unavailable.', { kind: 'relayer-configuration' });
      }
      const authorization = await createTarotAuthorization(read, input.tokenId, recipient);
      const data = encodeTarotClaimTo(recipient, input.tokenId, authorization.deadline, authorization.signature) as Hex;
      const transaction = { from: account.address, to: input.contractAddress, value: '0x0', data };
      const [estimate, historyValue, balance] = await Promise.all([
        ethereumRpc(read, 'eth_estimateGas', [transaction]),
        ethereumRpc(read, 'eth_feeHistory', ['0x5', 'latest', [50]]),
        ethereumRpc(read, 'eth_getBalance', [account.address, 'latest']),
      ]);
      const gas = (quantity(estimate) * 120n + 99n) / 100n;
      if (gas <= 0n || gas > MAXIMUM_GAS) throw new EthereumApiError('failed-precondition', 'This recipient cannot receive the card within the gas limit.');
      const history = object(historyValue);
      if (!Array.isArray(history.baseFeePerGas) || history.baseFeePerGas.length < 2 ||
        !Array.isArray(history.reward) || !history.reward.length || history.reward.length > 5 ||
        history.baseFeePerGas.length !== history.reward.length + 1) return unavailable();
      const rewards = history.reward.map(row => {
        if (!Array.isArray(row) || row.length !== 1) return unavailable();
        return quantity(row[0]);
      }).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      const median = rewards[Math.floor(rewards.length / 2)];
      const maxPriorityFeePerGas = median < MINIMUM_TIP_WEI ? MINIMUM_TIP_WEI : median > MAXIMUM_TIP_WEI ? MAXIMUM_TIP_WEI : median;
      const maxFeePerGas = quantity(history.baseFeePerGas.at(-2)) * 2n + maxPriorityFeePerGas;
      const maximumFeeWei = gas * maxFeePerGas;
      if (maximumFeeWei > maximumFee(env, input.chainId)) {
        throw new EthereumApiError('failed-precondition', 'Network fees are too high. Please try again later.');
      }
      if (quantity(balance) < decimal(outstandingFeeWei) + maximumFeeWei) return unavailable('Backend claiming is temporarily unavailable. Please try again later.');
      const nonceValue = decimal(nonce);
      if (nonceValue > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable();
      read.signal.throwIfAborted();
      if (authorization.deadline <= Math.floor(now() / 1000)) return unavailable();
      const rawTransaction = await account.signTransaction({ type: 'eip1559', chainId: input.chainId, nonce: Number(nonceValue),
        to: input.contractAddress as Hex, data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas });
      return { rawTransaction, transactionHash: keccak256(rawTransaction), nonce,
        authorizationDeadline: authorization.deadline, maximumFeeWei: maximumFeeWei.toString(), relayerAddress: account.address.toLowerCase() };
    },
    async inspect(attempt) {
      const { data } = await signedData(attempt);
      const result = await confirmTarotClaim(context(attempt, true), attempt.tokenId, attempt.recipient,
        attempt.signed.transactionHash, { sender: attempt.signed.relayerAddress, data });
      return result.status;
    },
    async broadcast(attempt) {
      requireSponsorship(env, attempt.chainId);
      const read = context(attempt);
      const expirationError = new EthereumApiError('failed-precondition', 'This claim authorization has expired.');
      if (attempt.signed.authorizationDeadline <= Math.floor(now() / 1000)) {
        throw expirationError;
      }
      await requireTarotCodeHash(read, attempt.tokenId, attempt.codeHash);
      const { authorizationSigner } = await signedData(attempt);
      if (relayerAccount(env, attempt.chainId).address.toLowerCase() !== attempt.signed.relayerAddress) return unavailable();
      const current = await tarotState(read, attempt.tokenId);
      if (authorizationSigner !== current.signer) {
        throw new EthereumApiError('failed-precondition', 'This claim authorization is no longer valid.');
      }
      if (current.mintingPaused || tarotSigner(read)?.address !== current.signer) return unavailable();
      const requireUnexpired = () => {
        read.signal.throwIfAborted();
        if (attempt.signed.authorizationDeadline <= Math.max(Math.floor(now() / 1000), current.timestamp)) {
          throw expirationError;
        }
      };
      requireUnexpired();
      try {
        const result = await providerRpc(env, attempt.chainId, 'eth_sendRawTransaction', [attempt.signed.rawTransaction], read.signal,
          (url, init) => { requireUnexpired(); return providerFetch(url, init); });
        if (typeof result !== 'string' || result.toLowerCase() !== attempt.signed.transactionHash) return unavailable();
      } catch (error) {
        if (error instanceof RpcProviderError && error.cause === expirationError) throw expirationError;
        if (error instanceof RpcRequestError && /\balready known\b|\bknown transaction\b/i.test(error.details ?? '')) return;
        throw error;
      }
    },
  };
}
