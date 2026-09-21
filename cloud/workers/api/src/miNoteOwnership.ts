import miNoteCollections from '../../../../mi_note_eth.json';
import {
  MI_NOTE_CONTRACT_ADDRESS,
  MI_NOTE_MODERN_CONTRACT_ADDRESSES,
  MAX_MI_NOTE_TOKEN_IDS,
  normalizeMiNoteAddress,
  type MiNoteContractAddress,
} from '../../../../shared/miNoteCards.js';
import { raceWithSignal } from './boundedRequest.js';
import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import type { WorkerDependencies, WorkerRequestMetrics } from './publicRouteSupport.js';

const MAX_PAGE_BYTES = 256 * 1024;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const MAX_UINT256 = (1n << 256n) - 1n;
const ORIGINAL_COLLECTION = miNoteCollections.find((collection) => collection.contractAddress === MI_NOTE_CONTRACT_ADDRESS)!;
const ORIGINAL_ID_SET = new Set(ORIGINAL_COLLECTION.tokens.map((token) => token.id));

type ProviderContext = {
  providerFetch: WorkerDependencies['providerFetch'];
  metrics: WorkerRequestMetrics;
  signal: AbortSignal;
};

export function miNoteProviderFailure(): Error {
  return new Error('Mi note ownership provider unavailable');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uint256(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 78 || value.trim() !== value || !/^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value)) {
    throw miNoteProviderFailure();
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw miNoteProviderFailure();
  return parsed;
}

function sorted(ids: Set<string>): string[] {
  return [...ids].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
}

export async function miNoteResponseWithSignal<T extends Response | undefined>(
  operation: Promise<T>, signal: AbortSignal,
): Promise<T> {
  return raceWithSignal(operation.then(async (response) => {
    if (response && signal.aborted) {
      await cancelResponseBody(response);
      throw signal.reason;
    }
    return response;
  }), signal);
}

async function providerJson(url: URL, init: RequestInit, context: ProviderContext): Promise<unknown> {
  if (context.signal.aborted) throw context.signal.reason;
  const startedAt = performance.now();
  context.metrics.upstreamCalls += 1;
  try {
    const response = await miNoteResponseWithSignal(context.providerFetch(url, {
      ...init, redirect: 'manual', signal: context.signal,
    }), context.signal);
    if (!response.ok) {
      await cancelResponseBody(response);
      throw miNoteProviderFailure();
    }
    return await readBoundedResponseJson(response, {
      maxBytes: MAX_PAGE_BYTES, contentType: 'require-json', signal: context.signal,
      createError: miNoteProviderFailure,
    });
  } finally {
    context.metrics.providerDurationMs += performance.now() - startedAt;
  }
}

function nextCursor(value: unknown, seen: Set<string>): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || seen.has(value)) {
    throw miNoteProviderFailure();
  }
  seen.add(value);
  return value;
}

export async function fetchAlchemyMiNotes(
  address: string, apiKey: string, context: ProviderContext,
): Promise<Map<MiNoteContractAddress, string[]>> {
  if (!apiKey) throw miNoteProviderFailure();
  const tokenIds = new Map<MiNoteContractAddress, Set<string>>(MI_NOTE_MODERN_CONTRACT_ADDRESSES.map((contract) => [contract, new Set()]));
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${encodeURIComponent(apiKey)}/getNFTsForOwner`);
    url.searchParams.set('owner', address);
    for (const contract of MI_NOTE_MODERN_CONTRACT_ADDRESSES) url.searchParams.append('contractAddresses[]', contract);
    url.searchParams.set('withMetadata', 'false');
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    if (cursor) url.searchParams.set('pageKey', cursor);
    const body = await providerJson(url, { method: 'GET', headers: { Accept: 'application/json' } }, context);
    if (!isRecord(body) || !Array.isArray(body.ownedNfts) || body.ownedNfts.length > PAGE_SIZE) throw miNoteProviderFailure();
    for (const nft of body.ownedNfts) {
      if (!isRecord(nft)) throw miNoteProviderFailure();
      const contract = normalizeMiNoteAddress(nft.contractAddress);
      const ids = contract ? tokenIds.get(contract as MiNoteContractAddress) : undefined;
      if (!ids) throw miNoteProviderFailure();
      const id = uint256(nft.tokenId).toString();
      const balance = uint256(nft.balance);
      if (balance > 0n && !ids.has(id)) {
        ids.add(id);
        if (++total > MAX_MI_NOTE_TOKEN_IDS) throw miNoteProviderFailure();
      }
    }
    cursor = nextCursor(body.pageKey, cursors);
    if (!cursor) return new Map([...tokenIds].map(([contract, ids]) => [contract, sorted(ids)]));
  }
  throw miNoteProviderFailure();
}

export async function fetchOpenSeaMiNotes(
  address: string, apiKey: string, context: ProviderContext,
): Promise<string[]> {
  if (!apiKey) throw miNoteProviderFailure();
  const slug = ORIGINAL_COLLECTION.openseaSlug;
  const tokenIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`https://api.opensea.io/api/v2/chain/ethereum/account/${address}/nfts`);
    url.searchParams.set('collection', slug);
    url.searchParams.set('include_auto_hidden', 'true');
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (cursor) url.searchParams.set('next', cursor);
    const body = await providerJson(url, {
      method: 'GET', headers: { Accept: 'application/json', 'x-api-key': apiKey },
    }, context);
    if (!isRecord(body) || !Array.isArray(body.nfts) || body.nfts.length > PAGE_SIZE) throw miNoteProviderFailure();
    for (const nft of body.nfts) {
      if (!isRecord(nft) || normalizeMiNoteAddress(nft.contract) !== MI_NOTE_CONTRACT_ADDRESS || nft.collection !== slug || nft.token_standard !== 'erc1155') {
        throw miNoteProviderFailure();
      }
      const id = uint256(nft.identifier).toString();
      if (!ORIGINAL_ID_SET.has(id)) continue;
      tokenIds.add(id);
      if (tokenIds.size > MAX_MI_NOTE_TOKEN_IDS) throw miNoteProviderFailure();
    }
    cursor = nextCursor(body.next, cursors);
    if (!cursor) return sorted(tokenIds);
  }
  throw miNoteProviderFailure();
}
