import {
  ETHEREUM_API_PATHS, ETHEREUM_SESSION_HEADER,
  type Ethereum111kConfig, type EthereumAuthChallenge, type EthereumClaimPrepareResponse,
  type EthereumConfirmationResponse, type EthereumDeliveryConfirmResponse, type EthereumDeliveryPrepareResponse, type EthereumInventoryItem,
  type EthereumInventoryResponse, type EthereumPreparedTransaction, type EthereumProfileResponse,
  type EthereumSaveAddressRequest, type EthereumSaveAddressResponse, type EthereumSession,
  type EthereumShipmentsResponse, type EthereumStats, type EthereumTransactionConfirmResponse,
  type EthereumDeliveryPrepareRequest, type EthereumDeliveryConfirmRequest,
  type EthereumClaimPrepareRequest, type EthereumClaimConfirmRequest,
} from '../../shared/ethereum/api';
import { ethereumAssetId, ETHEREUM_ITEM_KINDS, ETHEREUM_MAX_UNBOX_QUANTITY, ETHEREUM_MAX_INVENTORY_EXPECTED_IDS, ETHEREUM_INVENTORY_EXPECTED_REQUEST_SIZE, normalizeEthereumAddress, normalizeEthereumTokenId } from '../../shared/ethereum/protocol';
import { monsApiOrigin } from '../lib/monsApiOrigin';
import type { EthereumLog } from '../../shared/ethereum/abi';
import type { EthereumSubmission } from './state';
import { matchesEthereumOperationEvent } from './recovery';

export class EthereumApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null, readonly rejectedSessionToken: string | null = null) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never { throw new Error('The Ethereum service returned an invalid response.'); }
function amount(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value); }

async function request(path: string, options: { body?: unknown; session?: EthereumSession | null; signal?: AbortSignal } = {}): Promise<unknown> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await fetch(`${monsApiOrigin()}${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json', 'X-Mons-CSRF': '1' } : {}),
      ...(options.session ? { [ETHEREUM_SESSION_HEADER]: options.session.token } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    cache: 'no-store', signal,
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const detail = record(value) && record(value.error) ? value.error : value;
    const message = record(detail) && typeof detail.message === 'string' ? detail.message :
      response.status === 401 ? 'Your Ethereum session expired. Sign in again.' :
      response.status === 503 ? 'This Ethereum drop is not available yet.' : 'The Ethereum request failed. Please try again.';
    const code = record(detail) && record(detail.details) && detail.details.kind === 'transaction-reverted' ? 'transaction-reverted' :
      record(detail) && typeof detail.code === 'string' ? detail.code : null;
    throw new EthereumApiError(response.status, message, code, response.status === 401 ? options.session?.token ?? null : null);
  }
  return value;
}

function parseEthereumConfig(value: unknown): Ethereum111kConfig {
  if (!record(value) || value.dropId !== '111k_devnet' || typeof value.chainId !== 'number' || ![11155111, 31337].includes(value.chainId) ||
    typeof value.chainName !== 'string' || typeof value.enabled !== 'boolean' || value.testnet !== true ||
    (value.contractAddress !== null && !normalizeEthereumAddress(value.contractAddress)) || (value.enabled && value.contractAddress === null) ||
    typeof value.walletRpcUrl !== 'string' || typeof value.explorerUrl !== 'string' ||
    !amount(value.cratePriceWei) || !amount(value.warehousePriceWei) || !amount(value.deliveryFeeWei) ||
    !Number.isSafeInteger(value.maxMintQuantity) || Number(value.maxMintQuantity) < 1 || Number(value.maxMintQuantity) > 15 ||
    !Number.isSafeInteger(value.maxUnboxQuantity) || Number(value.maxUnboxQuantity) < 1 || Number(value.maxUnboxQuantity) > ETHEREUM_MAX_UNBOX_QUANTITY ||
    !Number.isSafeInteger(value.maxDeliveryItems) || Number(value.maxDeliveryItems) < 1 || Number(value.maxDeliveryItems) > 50 ||
    !Number.isSafeInteger(value.confirmationBlocks) || Number(value.confirmationBlocks) < 1) return invalid();
  const rpc = new URL(value.walletRpcUrl);
  if (rpc.protocol !== 'https:' && !(value.chainId === 31337 && rpc.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname))) return invalid();
  return { ...value, contractAddress: normalizeEthereumAddress(value.contractAddress) } as Ethereum111kConfig;
}

function parseEthereumInventoryItem(value: unknown, config: Ethereum111kConfig, owner: string): EthereumInventoryItem {
  if (!record(value) || value.chainId !== config.chainId || normalizeEthereumAddress(value.contractAddress) !== config.contractAddress ||
    normalizeEthereumAddress(value.owner) !== owner || typeof value.tokenId !== 'string' || normalizeEthereumTokenId(value.tokenId) !== value.tokenId ||
    !ETHEREUM_ITEM_KINDS.includes(value.kind as EthereumInventoryItem['kind']) || typeof value.name !== 'string' ||
    !Number.isSafeInteger(value.displayId) || Number(value.displayId) < 1 || typeof value.image !== 'string' ||
    !/^data:image\/svg\+xml(?:;base64)?,/.test(value.image)) return invalid();
  const id = ethereumAssetId(config.chainId, config.contractAddress!, value.tokenId as string);
  if (value.id !== id) return invalid();
  return value as EthereumInventoryItem;
}

function transaction(value: unknown): EthereumPreparedTransaction {
  if (!record(value) || !normalizeEthereumAddress(value.to) || typeof value.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.data) ||
    typeof value.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value.value) || !Number.isSafeInteger(value.chainId)) return invalid();
  return value as EthereumPreparedTransaction;
}

export const ethereumApi = {
  async config(signal?: AbortSignal) { return parseEthereumConfig(await request(ETHEREUM_API_PATHS.config, { signal })); },
  async stats(config: Ethereum111kConfig, owner: string | null, signal?: AbortSignal): Promise<EthereumStats> {
    const address = owner === null ? null : normalizeEthereumAddress(owner);
    if (owner !== null && (!address || /^0x0{40}$/.test(address))) return invalid();
    const value = await request(`${ETHEREUM_API_PATHS.stats}${address ? `?${new URLSearchParams({ owner: address })}` : ''}`, { signal });
    if (!record(value) || !['allocatedCrates', 'warehousesMinted', 'artworksMinted', 'remainingCrates', 'remainingWarehouses'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) ||
      value.chainId !== config.chainId || normalizeEthereumAddress(value.contractAddress) !== config.contractAddress ||
      (address === null ? value.owner !== null : normalizeEthereumAddress(value.owner) !== address) ||
      !amount(value.cratePriceWei) || !amount(value.warehousePriceWei) || !amount(value.discountCratePriceWei) ||
      typeof value.discountMerkleRoot !== 'string' || !/^0x[0-9a-f]{64}$/.test(value.discountMerkleRoot) ||
      !['discountAllowance', 'discountUsed'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 10) ||
      typeof value.saleActive !== 'boolean') return invalid();
    return value as EthereumStats;
  },
  async inventory(config: Ethereum111kConfig, owner: string, cursor: string | null, signal?: AbortSignal, expectedTokenIds: string[] = []): Promise<EthereumInventoryResponse> {
    const expected = cursor ? [] : [...new Set(expectedTokenIds)];
    if (expected.length > ETHEREUM_MAX_INVENTORY_EXPECTED_IDS) throw new Error('Too many expected Ethereum token IDs.');
    const batches: string[][] = [];
    for (let offset = 0; offset < expected.length; offset += ETHEREUM_INVENTORY_EXPECTED_REQUEST_SIZE) {
      batches.push(expected.slice(offset, offset + ETHEREUM_INVENTORY_EXPECTED_REQUEST_SIZE));
    }
    if (!batches.length) batches.push([]);
    const pages: EthereumInventoryResponse[] = [];
    for (let offset = 0; offset < batches.length; offset += 2) {
      signal?.throwIfAborted();
      pages.push(...await Promise.all(batches.slice(offset, offset + 2).map(async ids => {
        const params = new URLSearchParams({ owner });
        if (cursor) params.set('cursor', cursor);
        else if (ids.length) params.set('expectedTokenIds', ids.join(','));
        const value = await request(`${ETHEREUM_API_PATHS.inventory}?${params}`, { signal });
        if (!record(value) || !Array.isArray(value.items) || value.items.length > 500 ||
          (value.nextCursor !== null && typeof value.nextCursor !== 'string') || !Number.isSafeInteger(value.observedBlock)) return invalid();
        return { items: value.items.map(item => parseEthereumInventoryItem(item, config, owner)), nextCursor: value.nextCursor as string | null, observedBlock: Number(value.observedBlock) };
      })));
    }
    return {
      items: [...new Map(pages.flatMap(page => page.items).map(item => [item.id, item])).values()],
      nextCursor: pages[0].nextCursor,
      observedBlock: Math.min(...pages.map(page => page.observedBlock)),
    };
  },
  async challenge(address: string, config: Ethereum111kConfig, signal?: AbortSignal): Promise<EthereumAuthChallenge> {
    const value = await request(ETHEREUM_API_PATHS.authChallenge, { body: { dropId: config.dropId, address, chainId: config.chainId }, signal });
    if (!record(value) || typeof value.challengeId !== 'string' || typeof value.message !== 'string' || !Number.isSafeInteger(value.expiresAtMs)) return invalid();
    return value as EthereumAuthChallenge;
  },
  async verify(challengeId: string, signature: string, signal?: AbortSignal): Promise<EthereumSession> {
    const value = await request(ETHEREUM_API_PATHS.authVerify, { body: { challengeId, signature }, signal });
    if (!record(value) || typeof value.token !== 'string' || !normalizeEthereumAddress(value.address) ||
      !Number.isSafeInteger(value.chainId) || value.dropId !== '111k_devnet' || !Number.isSafeInteger(value.expiresAtMs)) return invalid();
    return value as EthereumSession;
  },
  logout(session: EthereumSession) { return request(ETHEREUM_API_PATHS.authLogout, { body: {}, session }); },
  async profile(session: EthereumSession, signal?: AbortSignal): Promise<EthereumProfileResponse> {
    const value = await request(ETHEREUM_API_PATHS.profile, { session, signal });
    if (!record(value) || normalizeEthereumAddress(value.wallet) !== session.address || !Array.isArray(value.addresses)) return invalid();
    return value as EthereumProfileResponse;
  },
  async saveAddress(body: EthereumSaveAddressRequest, session: EthereumSession): Promise<EthereumSaveAddressResponse> {
    const value = await request(ETHEREUM_API_PATHS.addresses, { body, session });
    if (!record(value) || !record(value.address) || typeof value.address.id !== 'string') return invalid();
    return value as EthereumSaveAddressResponse;
  },
  async shipments(session: EthereumSession, signal?: AbortSignal): Promise<EthereumShipmentsResponse> {
    const value = await request(ETHEREUM_API_PATHS.shipments, { session, signal });
    if (!record(value) || !Array.isArray(value.orders)) return invalid();
    return value as EthereumShipmentsResponse;
  },
  async prepareDelivery(tokenIds: string[], addressId: string, requestId: string, session: EthereumSession, signal?: AbortSignal): Promise<EthereumDeliveryPrepareResponse> {
    const value = await request(ETHEREUM_API_PATHS.deliveryPrepare, { body: { tokenIds, addressId, requestId } satisfies EthereumDeliveryPrepareRequest, session, signal });
    if (!record(value) || !Number.isSafeInteger(value.orderId) || !record(value.quote) || !Number.isSafeInteger(value.expiresAtMs)) return invalid();
    return { ...value, transaction: transaction(value.transaction) } as EthereumDeliveryPrepareResponse;
  },
  async prepareClaim(receiptId: string, code: string, session: EthereumSession, signal?: AbortSignal): Promise<EthereumClaimPrepareResponse> {
    const value = await request(ETHEREUM_API_PATHS.claimPrepare, { body: { receiptId, code } satisfies EthereumClaimPrepareRequest, session, signal });
    if (!record(value) || typeof value.claimId !== 'string' || value.receiptId !== receiptId || !Number.isSafeInteger(value.expiresAtMs)) return invalid();
    return { ...value, transaction: transaction(value.transaction) } as EthereumClaimPrepareResponse;
  },
  async confirmDelivery(orderId: number, transactionHash: string, session: EthereumSession): Promise<EthereumDeliveryConfirmResponse> {
    return await request(ETHEREUM_API_PATHS.deliveryConfirm, { body: { orderId, transactionHash } satisfies EthereumDeliveryConfirmRequest, session }) as EthereumDeliveryConfirmResponse;
  },
  async confirmClaim(claimId: string, transactionHash: string, session: EthereumSession): Promise<EthereumConfirmationResponse> {
    return await request(ETHEREUM_API_PATHS.claimConfirm, { body: { claimId, transactionHash } satisfies EthereumClaimConfirmRequest, session }) as EthereumConfirmationResponse;
  },
  async confirm(transactionHash: string, config: Ethereum111kConfig, owner: string, signal?: AbortSignal, operation?: EthereumSubmission): Promise<EthereumTransactionConfirmResponse> {
    const value = await request(ETHEREUM_API_PATHS.transactionsConfirm, { body: { transactionHash }, signal });
    if (!record(value) || !['pending', 'confirmed'].includes(String(value.status)) || !Number.isSafeInteger(value.confirmations) ||
      !Array.isArray(value.items) || !Array.isArray(value.burnedTokenIds) || !value.burnedTokenIds.every(id => typeof id === 'string' && normalizeEthereumTokenId(id) === id)) return invalid();
    if (value.status === 'confirmed' && operation && operation.action !== 'cancel') {
      if (!operation.intent) throw new Error('The saved transaction is missing its original request. Check your wallet before stopping tracking.');
      if (!Array.isArray(value.logs) || !value.logs.every((log): log is EthereumLog => record(log) &&
        normalizeEthereumAddress(log.address) === config.contractAddress && Array.isArray(log.topics) &&
        log.topics.every(topic => typeof topic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(topic)) &&
        typeof log.data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(log.data))) return invalid();
      const matches = value.logs.filter(log => matchesEthereumOperationEvent(operation, owner, config.contractAddress!, log)).length;
      if (matches !== 1) {
        if (Number(value.confirmations) < config.confirmationBlocks) {
          return { status: 'pending', confirmations: Number(value.confirmations), items: [], burnedTokenIds: [] };
        }
        if (matches > 1) throw new EthereumApiError(409, 'This transaction contains multiple matching operations. Check your wallet before stopping tracking.', 'operation-ambiguous');
        throw new EthereumApiError(409, 'The Ethereum operation did not succeed. Check your wallet before trying again.', 'operation-failed');
      }
    }
    return { status: value.status as 'pending' | 'confirmed', confirmations: Number(value.confirmations),
      items: value.items.map(item => parseEthereumInventoryItem(item, config, record(item) ? normalizeEthereumAddress(item.owner) ?? '' : '')).filter(item => item.owner === owner),
      burnedTokenIds: value.burnedTokenIds as string[] };
  },
};
