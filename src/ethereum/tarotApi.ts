import { encodeTarotClaim, TAROT_API_PATHS, TAROT_CHAIN_ID, TAROT_MAX_CARDS, tarotReceiptTokenId,
  type TarotConfig, type TarotConfirmRequest, type TarotConfirmResponse, type TarotPrepareRequest,
  type TarotPrepareResponse, type TarotRequest, type TarotStatus } from '../../shared/ethereum/tarot';
import { normalizeEthereumAddress } from '../../shared/ethereum/protocol';
import { ethereumRetryAfterMs } from './retryAfter';

export class TarotApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAt: number | null = null) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
function invalid(): never { throw new Error('Couldn’t verify this Tarot claim. Please reload and try again.'); }

function parseConfig(value: unknown): TarotConfig {
  if (!record(value) || value.testnet !== true || value.chainId !== TAROT_CHAIN_ID || value.maxCards !== TAROT_MAX_CARDS ||
    typeof value.enabled !== 'boolean' || typeof value.chainName !== 'string' || !integer(value.deploymentBlock) ||
    value.confirmationBlocks !== 3 || typeof value.walletRpcUrl !== 'string' ||
    typeof value.explorerUrl !== 'string') return invalid();
  const address = normalizeEthereumAddress(value.contractAddress);
  if (value.contractAddress !== null && (!address || /^0x0{40}$/.test(address)) || value.enabled && !address) return invalid();
  for (const url of [value.walletRpcUrl, value.explorerUrl]) {
    try { if (new URL(url).protocol !== 'https:') return invalid(); } catch { return invalid(); }
  }
  return { ...value, contractAddress: address } as TarotConfig;
}

async function post(path: string, body: TarotRequest, signal?: AbortSignal): Promise<unknown> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await fetch(`/api${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Mons-CSRF': '1' },
    body: JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    signal: requestSignal,
  });
  const value: unknown = await response.json().catch(error => {
    signal?.throwIfAborted();
    if (response.ok) {
      requestSignal.throwIfAborted();
      if (error instanceof TypeError || error instanceof DOMException) throw error;
    }
    return null;
  });
  if (!response.ok) {
    const detail = record(value) && record(value.error) ? value.error : null;
    const delay = ethereumRetryAfterMs(response.headers.get('Retry-After'),
      detail && record(detail.details) ? detail.details.retryAfterMs : undefined);
    const message = response.status === 429 ? 'Too many attempts. Please wait a minute and try again.' :
      response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 ?
        'This Tarot claim link is invalid.' : response.status === 409 ? 'This card’s claim changed. Please try again.' :
          'Couldn’t load this Tarot claim. Please try again.';
    throw new TarotApiError(message, response.status, delay === null ? null : Date.now() + delay);
  }
  return value;
}

function matchesCard(value: Record<string, unknown>, request: TarotRequest): boolean {
  return value.tokenId === request.tokenId && value.receiptTokenId === tarotReceiptTokenId(request.tokenId);
}

export const tarotApi = {
  async status(request: TarotRequest, signal?: AbortSignal): Promise<TarotStatus> {
    const value = await post(TAROT_API_PATHS.status, request, signal);
    if (!record(value) || !matchesCard(value, request) || typeof value.claimed !== 'boolean' ||
      !integer(value.observedBlock) || !integer(value.observedTimestamp) || !hash(value.blockHash)) return invalid();
    return { ...value, config: parseConfig(value.config) } as TarotStatus;
  },
  async prepare(request: TarotPrepareRequest, config: TarotConfig, signal?: AbortSignal): Promise<TarotPrepareResponse> {
    const value = await post(TAROT_API_PATHS.prepare, request, signal);
    if (!record(value) || !matchesCard(value, request) || normalizeEthereumAddress(value.wallet) !== normalizeEthereumAddress(request.wallet) ||
      !integer(value.deadline) || !integer(value.expiresAtMs) || value.expiresAtMs !== value.deadline * 1000 || value.expiresAtMs <= Date.now() ||
      typeof value.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(value.signature) || !record(value.transaction)) return invalid();
    const transaction = value.transaction;
    if (transaction.chainId !== TAROT_CHAIN_ID || normalizeEthereumAddress(transaction.to) !== config.contractAddress ||
      transaction.value !== '0x0' || transaction.data !== encodeTarotClaim(request.tokenId, value.deadline, value.signature)) return invalid();
    return value as TarotPrepareResponse;
  },
  async confirm(request: TarotConfirmRequest, signal?: AbortSignal): Promise<TarotConfirmResponse> {
    const value = await post(TAROT_API_PATHS.confirm, request, signal);
    if (!record(value) || !matchesCard(value, request) || value.transactionHash !== request.transactionHash ||
      !['pending', 'confirmed', 'failed'].includes(String(value.status)) || !integer(value.confirmations) ||
      !(value.blockNumber === null && value.blockHash === null || integer(value.blockNumber) && value.blockNumber > 0 && hash(value.blockHash)) ||
      value.status !== 'pending' && (value.confirmations < 3 || value.blockNumber === null)) return invalid();
    return value as TarotConfirmResponse;
  },
};
