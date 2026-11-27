import { encodeTarotClaim, TAROT_API_PATHS, TAROT_MAX_CARDS, tarotChainId, tarotReceiptTokenId,
  type TarotBackendClaim, type TarotClaimRequest, type TarotClaimResponse,
  type TarotConfig, type TarotConfirmRequest, type TarotConfirmResponse, type TarotPrepareRequest,
  type TarotPrepareResponse, type TarotRequest, type TarotStatus, type TarotStatusRequest } from '../../shared/ethereum/tarot';
import { normalizeEthereumAddress } from '../../shared/ethereum/protocol';
import { ethereumRetryAfterMs } from './retryAfter';

export class TarotApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAt: number | null = null,
    readonly credentialRejected = false, readonly field: 'recipient' | null = null,
    readonly claimAccepted?: false, readonly sponsorshipExhausted = false) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
function invalid(): never { throw new Error('Couldn’t verify this Tarot claim. Please reload and try again.'); }

function parseConfig(value: unknown, request: TarotRequest): TarotConfig {
  if (!record(value) || typeof value.testnet !== 'boolean' || value.testnet !== request.testnet ||
    value.chainId !== tarotChainId(request.testnet) || value.maxCards !== TAROT_MAX_CARDS ||
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

function parseBackendClaim(value: unknown): TarotBackendClaim {
  if (!record(value) || typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.requestId) ||
    !['submitting', 'pending', 'confirmed', 'failed', 'recovery-required'].includes(String(value.state)) ||
    !normalizeEthereumAddress(value.recipient) || /^0x0{40}$/i.test(String(value.recipient)) ||
    value.transactionHash !== null && !hash(value.transactionHash) ||
    value.error !== undefined && typeof value.error !== 'string' ||
    value.revision !== undefined && !integer(value.revision) ||
    value.finalized !== undefined && typeof value.finalized !== 'boolean' ||
    (value.state === 'pending' || value.state === 'confirmed') && !hash(value.transactionHash)) return invalid();
  return { ...value, recipient: normalizeEthereumAddress(value.recipient)!,
    transactionHash: typeof value.transactionHash === 'string' ? value.transactionHash.toLowerCase() : null } as TarotBackendClaim;
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
    const recipientError = path === TAROT_API_PATHS.claim && response.status === 400 && detail?.code === 'invalid-argument' &&
      record(detail.details) && detail.details.field === 'recipient';
    const claimRejected = path === TAROT_API_PATHS.claim && detail && record(detail.details) && detail.details.claimAccepted === false;
    const sponsorshipExhausted = Boolean(claimRejected && response.status === 409 && detail?.code === 'failed-precondition' &&
      record(detail.details) && detail.details.kind === 'sponsorship-limit');
    const message = (recipientError || claimRejected && response.status !== 401 && response.status !== 403) && typeof detail?.message === 'string' ? detail.message :
      response.status === 429 ? 'Too many attempts. Please wait a minute and try again.' :
      response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404 ?
        'This Tarot claim link is invalid.' : response.status === 409 ? 'This card’s claim changed. Please try again.' :
          'Couldn’t load this Tarot claim. Please try again.';
    throw new TarotApiError(message, response.status, delay === null ? null : Date.now() + delay,
      response.status === 401 && detail?.code === 'unauthenticated', recipientError ? 'recipient' : null,
      claimRejected ? false : undefined, sponsorshipExhausted);
  }
  return value;
}

function matchesCard(value: Record<string, unknown>, request: TarotRequest): boolean {
  return value.tokenId === request.tokenId && value.receiptTokenId === tarotReceiptTokenId(request.tokenId);
}

export const tarotApi = {
  async status(request: TarotStatusRequest, signal?: AbortSignal): Promise<TarotStatus> {
    const value = await post(TAROT_API_PATHS.status, request, signal);
    if (!record(value) || !matchesCard(value, request) || typeof value.claimed !== 'boolean' ||
      !integer(value.observedBlock) || !integer(value.observedTimestamp) || !hash(value.blockHash)) return invalid();
    const backendClaim = value.backendClaim == null ? value.backendClaim : parseBackendClaim(value.backendClaim);
    if (request.requestId && backendClaim && backendClaim.requestId !== request.requestId) return invalid();
    return { ...value, config: parseConfig(value.config, request),
      ...(backendClaim !== undefined ? { backendClaim } : {}) } as TarotStatus;
  },
  async claim(request: TarotClaimRequest, signal?: AbortSignal): Promise<TarotClaimResponse> {
    const value = await post(TAROT_API_PATHS.claim, request, signal);
    if (!record(value) || !matchesCard(value, request)) return invalid();
    return { tokenId: request.tokenId, receiptTokenId: tarotReceiptTokenId(request.tokenId), backendClaim: parseBackendClaim(value.backendClaim) };
  },
  async prepare(request: TarotPrepareRequest, config: TarotConfig, signal?: AbortSignal): Promise<TarotPrepareResponse> {
    const expected = parseConfig(config, request);
    const value = await post(TAROT_API_PATHS.prepare, request, signal);
    if (!record(value) || !matchesCard(value, request) || normalizeEthereumAddress(value.wallet) !== normalizeEthereumAddress(request.wallet) ||
      !integer(value.deadline) || !integer(value.expiresAtMs) || value.expiresAtMs !== value.deadline * 1000 || value.expiresAtMs <= Date.now() ||
      typeof value.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(value.signature) || !record(value.transaction)) return invalid();
    const transaction = value.transaction;
    if (transaction.chainId !== expected.chainId || normalizeEthereumAddress(transaction.to) !== expected.contractAddress ||
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
