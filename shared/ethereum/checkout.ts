import type { Ethereum111kConfig, EthereumDeliveryPrepareResponse, EthereumInventoryItem } from './api.ts';
import { ETHEREUM_111K_DROP_ID, ETHEREUM_MAX_DELIVERY_ITEMS, normalizeEthereumTokenId } from './protocol.ts';

export const ETHEREUM_CHECKOUT_PATHS = {
  create: '/ethereum/111k/checkout/create',
  status: '/ethereum/111k/checkout/status',
  prepare: '/ethereum/111k/checkout/prepare',
  submission: '/ethereum/111k/checkout/submission',
  refresh: '/ethereum/111k/checkout/refresh',
} as const;

export const ETHEREUM_CHECKOUT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type EthereumCheckoutState = 'ready' | 'prepared' | 'submitting' | 'pending' | 'success' | 'failed';
export type EthereumCheckoutResult = 'canceled' | 'pending' | 'success' | 'failed';

export type EthereumCheckoutCreateRequest = {
  requestId: string;
  dropId: typeof ETHEREUM_111K_DROP_ID;
  tokenIds: string[];
  callbackUrl?: string;
  state?: string;
};

export type EthereumCheckoutAttempt = {
  attemptId: string;
  status: 'started' | 'submitted' | 'rejected' | 'failed';
  transactionHash: string | null;
};

export type EthereumCheckoutStatusResponse = {
  checkoutId: string;
  dropId: typeof ETHEREUM_111K_DROP_ID;
  chainId: number;
  contractAddress: string;
  config: Ethereum111kConfig;
  tokenIds: string[];
  items: EthereumInventoryItem[];
  unavailableTokenIds: string[];
  wallet: string | null;
  status: EthereumCheckoutState;
  orderId: number | null;
  transactionHash: string | null;
  confirmations: number;
  requiredConfirmations: number;
  quoteExpiresAtMs: number | null;
  attempt: EthereumCheckoutAttempt | null;
  returnUrl?: string;
};

export type EthereumCheckoutPrepareRequest = { checkoutId: string; addressId?: string };
export type EthereumCheckoutPrepareResponse = EthereumDeliveryPrepareResponse;
export type EthereumCheckoutSubmissionRequest = {
  checkoutId: string;
  attemptId: string;
} & (
  | { action: 'start'; quoteDeadline: number }
  | { action: 'reject' }
  | { action: 'report' | 'recover'; transactionHash: string }
);
export type EthereumCheckoutSubmissionResponse = { checkout: EthereumCheckoutStatusResponse; canSend: boolean };

export function normalizeCheckoutTokenIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > ETHEREUM_MAX_DELIVERY_ITEMS) {
    throw new Error(`Choose between 1 and ${ETHEREUM_MAX_DELIVERY_ITEMS} artworks or crates.`);
  }
  const ids = value.map(id => typeof id === 'string' && /^[1-9][0-9]*$/.test(id) ? normalizeEthereumTokenId(id) : null);
  if (ids.some(id => id === null) || new Set(ids).size !== ids.length) {
    throw new Error('Choose distinct onchain token IDs.');
  }
  return (ids as string[]).sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
}

export function normalizeCheckoutCallback(value: unknown, origin: string): string {
  let source: URL;
  try { source = new URL(origin); } catch { throw new Error('Invalid checkout origin.'); }
  const local = ['localhost', '127.0.0.1'].includes(source.hostname) && ['http:', 'https:'].includes(source.protocol);
  const hosted = source.protocol === 'https:' && (['mons.shop', 'www.mons.shop'].includes(source.hostname) ||
    /^(candidate|[0-9a-f]{8})-mons-shop\.lil-org\.workers\.dev$/.test(source.hostname));
  if (source.origin !== origin || source.username || source.password || (!local && !hosted)) throw new Error('Invalid checkout origin.');
  const raw = value === undefined || value === '' ? '/111k_devnet' : value;
  if (typeof raw !== 'string' || raw.length > 2048 || raw !== raw.trim()) throw new Error('Invalid checkout return URL.');
  if (raw.startsWith('/') && raw !== '/111k_devnet') throw new Error('This checkout return URL is not allowed.');
  let url: URL;
  try { url = new URL(raw, origin); } catch { throw new Error('Invalid checkout return URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('This checkout return URL is not allowed.');
  const internal = url.origin === origin && url.pathname === '/111k_devnet';
  const production = url.href === 'https://mons.shop/111k_devnet';
  const partner = url.href === 'https://vvv.so/callback';
  if (!internal && !production && !partner) throw new Error('This checkout return URL is not allowed.');
  return url.href;
}

export function normalizeCheckoutState(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid checkout return state.');
  }
  return value;
}

export function parseCheckoutEntry(search: string, origin: string): Omit<EthereumCheckoutCreateRequest, 'requestId'> {
  const params = new URLSearchParams(search);
  const allowed = new Set(['drop', 'ids', 'callback_url', 'state']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error('Invalid checkout link.');
  }
  if (params.get('drop') !== ETHEREUM_111K_DROP_ID) throw new Error('Checkout is only available for the 111K test drop.');
  const tokenIds = normalizeCheckoutTokenIds((params.get('ids') || '').split(','));
  const callbackUrl = normalizeCheckoutCallback(params.get('callback_url') ?? undefined, origin);
  const state = normalizeCheckoutState(params.get('state') ?? undefined);
  return { dropId: ETHEREUM_111K_DROP_ID, tokenIds, callbackUrl, ...(state === undefined ? {} : { state }) };
}

export function checkoutEntryUrl(tokenIds: string[]): string {
  const params = new URLSearchParams({ drop: ETHEREUM_111K_DROP_ID, ids: normalizeCheckoutTokenIds(tokenIds).join(',') });
  return `/checkout?${params}`;
}

export function checkoutReturnUrl(args: {
  callbackUrl: string;
  state?: string | null;
  checkoutId: string;
  result: EthereumCheckoutResult;
  chainId: number;
  transactionHash?: string | null;
}): string {
  const url = new URL(args.callbackUrl);
  url.searchParams.set('checkout_id', args.checkoutId);
  url.searchParams.set('result', args.result);
  url.searchParams.set('chain_id', String(args.chainId));
  if (args.state) url.searchParams.set('state', args.state);
  if (args.transactionHash) url.searchParams.set('tx_hash', args.transactionHash);
  return url.href;
}
