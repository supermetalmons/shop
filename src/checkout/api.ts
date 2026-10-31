import type { EthereumSession } from '../../shared/ethereum/api';
import {
  ETHEREUM_CHECKOUT_ID, ETHEREUM_CHECKOUT_PATHS, checkoutReturnUrl, normalizeCheckoutCallback, normalizeCheckoutTokenIds,
  type EthereumCheckoutCreateRequest, type EthereumCheckoutPrepareRequest, type EthereumCheckoutPrepareResponse,
  type EthereumCheckoutState, type EthereumCheckoutStatusResponse, type EthereumCheckoutSubmissionRequest,
  type EthereumCheckoutSubmissionResponse,
} from '../../shared/ethereum/checkout';
import { isEthereumDeliveryKind, normalizeEthereumAddress } from '../../shared/ethereum/protocol';
import { EthereumApiError, parseEthereumConfig, parseEthereumInventoryItem } from '../ethereum/api';
import { requestEthereumJson, type EthereumRequestOptions } from '../ethereum/request';

const STATES: readonly EthereumCheckoutState[] = ['ready', 'prepared', 'submitting', 'pending', 'success', 'failed'];
const HASH = /^0x[0-9a-fA-F]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const invalid = (): never => { throw new Error('The checkout service returned an invalid response.'); };

export class CheckoutApiError extends EthereumApiError {
  constructor(status: number, message: string, readonly blockingCheckoutId: string | null,
    code: string | null = null, rejectedSessionToken: string | null = null) {
    super(status, message, code, rejectedSessionToken);
  }
}

function returnUrl(value: unknown, checkout: Omit<EthereumCheckoutStatusResponse, 'returnUrl'>): string {
  const result = checkout.status === 'success' || checkout.status === 'failed' ? checkout.status :
    checkout.status === 'pending' || checkout.status === 'submitting' ? 'pending' : 'canceled';
  const origin = window.location.origin;
  if (value === undefined) return checkoutReturnUrl({ callbackUrl: new URL('/111k_devnet', origin).href,
    checkoutId: checkout.checkoutId, result, chainId: checkout.chainId, transactionHash: checkout.transactionHash });
  if (typeof value !== 'string' || value.length > 8192) return invalid();
  const url = new URL(value);
  const allowed = new Set(['checkout_id', 'result', 'chain_id', 'tx_hash', 'state']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return invalid();
  }
  if (url.searchParams.get('checkout_id') !== checkout.checkoutId || url.searchParams.get('result') !== result ||
    url.searchParams.get('chain_id') !== String(checkout.chainId) ||
    (url.searchParams.get('tx_hash') ?? null) !== checkout.transactionHash) return invalid();
  const base = new URL(url);
  base.search = '';
  normalizeCheckoutCallback(base.href, origin);
  return url.href;
}

function parseCheckoutStatus(value: unknown, expectedId?: string): EthereumCheckoutStatusResponse {
  if (!record(value) || typeof value.checkoutId !== 'string' || !ETHEREUM_CHECKOUT_ID.test(value.checkoutId) ||
    expectedId !== undefined && value.checkoutId !== expectedId || value.dropId !== '111k_devnet' ||
    !STATES.includes(value.status as EthereumCheckoutState) || !Array.isArray(value.items) || !Array.isArray(value.unavailableTokenIds) ||
    !Number.isSafeInteger(value.confirmations) || Number(value.confirmations) < 0 ||
    !Number.isSafeInteger(value.requiredConfirmations) || Number(value.requiredConfirmations) < 1 ||
    value.orderId !== null && (!Number.isSafeInteger(value.orderId) || Number(value.orderId) < 1) ||
    value.quoteExpiresAtMs !== null && (!Number.isSafeInteger(value.quoteExpiresAtMs) || Number(value.quoteExpiresAtMs) < 1) ||
    value.transactionHash !== null && (typeof value.transactionHash !== 'string' || !HASH.test(value.transactionHash)) ||
    value.wallet !== null && !normalizeEthereumAddress(value.wallet)) return invalid();
  const config = parseEthereumConfig(value.config);
  if (config.dropId !== value.dropId || config.chainId !== value.chainId || config.contractAddress !== value.contractAddress ||
    config.confirmationBlocks !== value.requiredConfirmations) return invalid();
  const tokenIds = normalizeCheckoutTokenIds(value.tokenIds);
  const ids = new Set(tokenIds);
  const items = value.items.map(item => {
    if (!record(item) || !normalizeEthereumAddress(item.owner)) return invalid();
    const parsed = parseEthereumInventoryItem(item, config, normalizeEthereumAddress(item.owner)!);
    if (!ids.has(parsed.tokenId) || !isEthereumDeliveryKind(parsed.kind)) return invalid();
    return parsed;
  });
  if (new Set(items.map(item => item.tokenId)).size !== items.length || value.unavailableTokenIds.some(id => typeof id !== 'string' || !ids.has(id)) ||
    new Set(value.unavailableTokenIds).size !== value.unavailableTokenIds.length) return invalid();
  if (value.attempt !== null && (!record(value.attempt) || typeof value.attempt.attemptId !== 'string' || !ETHEREUM_CHECKOUT_ID.test(value.attempt.attemptId) ||
    !['started', 'submitted', 'rejected', 'failed'].includes(String(value.attempt.status)) ||
    value.attempt.transactionHash !== null && (typeof value.attempt.transactionHash !== 'string' || !HASH.test(value.attempt.transactionHash)))) return invalid();
  const checkout = { ...value, config, tokenIds, items } as EthereumCheckoutStatusResponse;
  return { ...checkout, returnUrl: returnUrl(value.returnUrl, checkout) };
}

async function request(path: string, options: EthereumRequestOptions = {}): Promise<unknown> {
  const { response, value } = await requestEthereumJson(path, options);
  if (!response.ok) {
    const error = record(value) && record(value.error) ? value.error : value;
    const blockingId = record(error) && record(error.details) ? error.details.blockingCheckoutId : null;
    throw new CheckoutApiError(response.status, record(error) && typeof error.message === 'string' ? error.message : 'Couldn’t update checkout. Please try again.',
      typeof blockingId === 'string' && ETHEREUM_CHECKOUT_ID.test(blockingId) ? blockingId : null,
      record(error) && typeof error.code === 'string' ? error.code : null, response.status === 401 ? options.session?.token ?? null : null);
  }
  return value;
}

export const checkoutApi = {
  async create(body: EthereumCheckoutCreateRequest, signal?: AbortSignal): Promise<EthereumCheckoutStatusResponse> {
    return parseCheckoutStatus(await request(ETHEREUM_CHECKOUT_PATHS.create, { body, signal }));
  },
  async status(checkoutId: string, signal?: AbortSignal): Promise<EthereumCheckoutStatusResponse> {
    return parseCheckoutStatus(await request(`${ETHEREUM_CHECKOUT_PATHS.status}?${new URLSearchParams({ checkoutId })}`, { signal }), checkoutId);
  },
  async refresh(checkoutId: string, signal?: AbortSignal): Promise<EthereumCheckoutStatusResponse> {
    return parseCheckoutStatus(await request(ETHEREUM_CHECKOUT_PATHS.refresh, { body: { checkoutId }, signal }), checkoutId);
  },
  async prepare(body: EthereumCheckoutPrepareRequest, session: EthereumSession, signal?: AbortSignal): Promise<EthereumCheckoutPrepareResponse> {
    const value = await request(ETHEREUM_CHECKOUT_PATHS.prepare, { body, session, signal });
    if (!record(value) || !record(value.quote) || !record(value.transaction) || typeof value.signature !== 'string' ||
      typeof value.quote.receiptIdsHash !== 'string' || typeof value.quote.fee !== 'string' ||
      typeof value.transaction.data !== 'string' || typeof value.transaction.value !== 'string') return invalid();
    return value as EthereumCheckoutPrepareResponse;
  },
  async submission(body: EthereumCheckoutSubmissionRequest, session: EthereumSession): Promise<EthereumCheckoutSubmissionResponse> {
    const value = await request(ETHEREUM_CHECKOUT_PATHS.submission, { body, session });
    if (!record(value) || typeof value.canSend !== 'boolean') return invalid();
    return { checkout: parseCheckoutStatus(value.checkout, body.checkoutId), canSend: value.canSend };
  },
};
