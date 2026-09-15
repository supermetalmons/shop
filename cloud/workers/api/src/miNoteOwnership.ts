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
import type { WorkerDependencies, WorkerRequestMetrics } from './workerPublicRoutes.js';

const MAX_PAGE_BYTES = 256 * 1024;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const MAX_UINT256 = (1n << 256n) - 1n;
const ORIGINAL_IDS = miNoteCollections.find((collection) => collection.contractAddress === MI_NOTE_CONTRACT_ADDRESS)!.tokens.map((token) => token.id);
const ORIGINAL_ID_SET = new Set(ORIGINAL_IDS);
const COLLECTION_SLUGS = new Map(miNoteCollections.map((collection) => [collection.contractAddress, collection.openseaSlug]));

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

function abiWord(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

export async function fetchOriginalMiNotes(
  address: string, apiKey: string, context: ProviderContext,
): Promise<string[]> {
  if (!apiKey) throw miNoteProviderFailure();
  const size = ORIGINAL_IDS.length;
  const owners = abiWord(BigInt(size)) + address.slice(2).padStart(64, '0').repeat(size);
  const ids = abiWord(BigInt(size)) + ORIGINAL_IDS.map((id) => abiWord(BigInt(id))).join('');
  const data = '0x4e1273f4' + abiWord(64n) + abiWord(BigInt(64 + owners.length / 2)) + owners + ids;
  const id = 'mi-note-original';
  const body = await providerJson(new URL(`https://eth-mainnet.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`), {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: MI_NOTE_CONTRACT_ADDRESS, data }, 'latest'] }),
  }, context);
  if (!isRecord(body) || body.jsonrpc !== '2.0' || body.id !== id || Object.hasOwn(body, 'error') || typeof body.result !== 'string') {
    throw miNoteProviderFailure();
  }
  const result = body.result;
  if (result.trim() !== result || !/^0x[0-9a-fA-F]+$/.test(result) || result.length !== 2 + (size + 2) * 64 ||
      BigInt('0x' + result.slice(2, 66)) !== 32n || BigInt('0x' + result.slice(66, 130)) !== BigInt(size)) {
    throw miNoteProviderFailure();
  }
  return ORIGINAL_IDS.filter((_id, index) => BigInt('0x' + result.slice(130 + index * 64, 194 + index * 64)) > 0n);
}

export async function fetchOpenSeaMiNotes(
  address: string, contract: MiNoteContractAddress, apiKey: string, context: ProviderContext,
): Promise<string[]> {
  if (!apiKey) throw miNoteProviderFailure();
  const slug = COLLECTION_SLUGS.get(contract)!;
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
      if (!isRecord(nft) || normalizeMiNoteAddress(nft.contract) !== contract || nft.collection !== slug || nft.token_standard !== 'erc1155') {
        throw miNoteProviderFailure();
      }
      const id = uint256(nft.identifier).toString();
      if (contract === MI_NOTE_CONTRACT_ADDRESS && !ORIGINAL_ID_SET.has(id)) continue;
      tokenIds.add(id);
      if (tokenIds.size > MAX_MI_NOTE_TOKEN_IDS) throw miNoteProviderFailure();
    }
    cursor = nextCursor(body.next, cursors);
    if (!cursor) return sorted(tokenIds);
  }
  throw miNoteProviderFailure();
}
