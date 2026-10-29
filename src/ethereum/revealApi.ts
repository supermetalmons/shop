import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import { normalizeEthereumAddress, normalizeEthereumTokenId } from '../../shared/ethereum/protocol';
import {
  ETHEREUM_REVEAL_MAX_TOKEN_IDS, ETHEREUM_REVEAL_PATHS,
  type EthereumRevealedArtwork, type EthereumRevealTokensRequest, type EthereumRevealTokensResponse,
  type EthereumRevealTransactionRequest, type EthereumRevealTransactionResponse,
} from '../../shared/ethereum/reveal';
import { hasValidEthereumMedia, isEthereumMediaUrl } from './artworkMedia';
import { EthereumApiError } from './api';
import { requestEthereumJson } from './request';

type RevealConfig = Pick<Ethereum111kConfig, 'chainId' | 'contractAddress'>;
const hashPattern = /^0x[0-9a-f]{64}$/;

export class EthereumRevealApiError extends EthereumApiError {
  constructor(status: number, message: string, readonly retryAfterMs: number | null) { super(status, message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never { throw new Error('The artwork service returned an invalid response.'); }

function tokenId(value: unknown): value is string {
  return typeof value === 'string' && normalizeEthereumTokenId(value) === value && BigInt(value) <= 111111n;
}

function parseArtwork(value: unknown): EthereumRevealedArtwork {
  if (!record(value) || !tokenId(value.tokenId) || typeof value.crateTokenId !== 'string' ||
    normalizeEthereumTokenId(value.crateTokenId) !== value.crateTokenId ||
    BigInt(value.crateTokenId) < 111112n || BigInt(value.crateTokenId) > 116666n ||
    !['egg', 'painting', 'video'].includes(String(value.category)) || typeof value.name !== 'string' ||
    value.description !== undefined && typeof value.description !== 'string' ||
    !hasValidEthereumMedia(value) || !isEthereumMediaUrl(value.image) || value.aspectRatio === undefined ||
    (value.category === 'video' ? !isEthereumMediaUrl(value.animation_url) : value.animation_url !== undefined) ||
    !record(value.observation) || typeof value.observation.transactionHash !== 'string' ||
    !hashPattern.test(value.observation.transactionHash) || typeof value.observation.blockHash !== 'string' ||
    !hashPattern.test(value.observation.blockHash) || !Number.isSafeInteger(value.observation.blockNumber) ||
    Number(value.observation.blockNumber) < 0 ||
    value.attributes !== undefined && (!Array.isArray(value.attributes) || !value.attributes.every(attribute =>
      record(attribute) && typeof attribute.trait_type === 'string' &&
      (typeof attribute.value === 'string' || typeof attribute.value === 'number' && Number.isFinite(attribute.value))))) return invalid();
  return value as EthereumRevealedArtwork;
}

async function request(path: string, config: RevealConfig,
  body: Pick<EthereumRevealTransactionRequest, 'transactionHash'> | Pick<EthereumRevealTokensRequest, 'tokenIds'>,
  signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!config.contractAddress) throw new Error('This Ethereum collection is not configured.');
  const payload: EthereumRevealTransactionRequest | EthereumRevealTokensRequest = {
    chainId: config.chainId, contractAddress: config.contractAddress, ...body,
  };
  const { response, value } = await requestEthereumJson(path, { body: payload, signal });
  if (!response.ok) {
    const detail = record(value) && record(value.error) ? value.error : value;
    const retry = response.headers.get('Retry-After');
    const retryAfterMs = retry === null ? NaN : /^\d+(?:\.\d+)?$/.test(retry)
      ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
    throw new EthereumRevealApiError(response.status, record(detail) && typeof detail.message === 'string' ? detail.message :
      'Artworks are temporarily unavailable. We will keep checking.', Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null);
  }
  if (!record(value) || value.chainId !== config.chainId || normalizeEthereumAddress(value.contractAddress) !== config.contractAddress ||
    typeof value.deploymentId !== 'string' || !value.deploymentId || typeof value.dropId !== 'string' || !value.dropId ||
    !Number.isSafeInteger(value.retryAfterMs) || Number(value.retryAfterMs) < 0 || !Array.isArray(value.artworks)) return invalid();
  return value;
}

function artworks(value: Record<string, unknown>): EthereumRevealedArtwork[] {
  const items = (value.artworks as unknown[]).map(parseArtwork);
  if (new Set(items.map(item => item.tokenId)).size !== items.length) return invalid();
  return items;
}

export const ethereumRevealApi = {
  async transaction(config: RevealConfig, transactionHash: string, signal?: AbortSignal): Promise<EthereumRevealTransactionResponse> {
    const hash = transactionHash.toLowerCase();
    if (!hashPattern.test(hash)) throw new Error('Invalid Ethereum transaction hash.');
    const value = await request(ETHEREUM_REVEAL_PATHS.transaction, config, { transactionHash: hash }, signal);
    if (!['pending', 'revealed', 'reverted', 'not_unpack'].includes(String(value.status))) return invalid();
    const items = artworks(value);
    if (value.status !== 'revealed' && items.length || value.status === 'revealed' && !items.length) return invalid();
    if (value.observedBlock !== undefined && (!record(value.observedBlock) ||
      !Number.isSafeInteger(value.observedBlock.number) || Number(value.observedBlock.number) < 0 ||
      typeof value.observedBlock.hash !== 'string' || !hashPattern.test(value.observedBlock.hash))) return invalid();
    return { ...value, artworks: items } as EthereumRevealTransactionResponse;
  },
  async tokens(config: RevealConfig, tokenIds: readonly string[], signal?: AbortSignal): Promise<EthereumRevealTokensResponse> {
    const ids = [...new Set(tokenIds)];
    if (!ids.length || ids.length > ETHEREUM_REVEAL_MAX_TOKEN_IDS || !ids.every(tokenId)) throw new Error('Invalid artwork token IDs.');
    const value = await request(ETHEREUM_REVEAL_PATHS.tokens, config, { tokenIds: ids }, signal);
    const items = artworks(value);
    if (!Array.isArray(value.unresolved) || !value.unresolved.every(item => record(item) && tokenId(item.tokenId) &&
      (item.status === 'recovering' || item.status === 'unminted'))) return invalid();
    const returnedIds = [...items.map(item => item.tokenId), ...value.unresolved.map(item => item.tokenId as string)];
    if (returnedIds.length !== ids.length || new Set(returnedIds).size !== ids.length || returnedIds.some(id => !ids.includes(id))) return invalid();
    return { ...value, artworks: items } as EthereumRevealTokensResponse;
  },
};
