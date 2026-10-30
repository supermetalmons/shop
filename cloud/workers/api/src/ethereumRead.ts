import { encodeCall, decodeReturn } from '../../../../shared/ethereum/abi.js';
import type { EthereumInventoryItem, EthereumItemKind, EthereumMetadata } from '../../../../shared/ethereum/protocol.js';
import { isEthereumMetadataImage } from '../../../../shared/ethereum/metadataImage.js';
import { ethereumTokenMetadataUri } from '../../../../shared/ethereum/metadataUri.js';
import {
  ETHEREUM_FUNCTIONS, ETHEREUM_INVENTORY_EXPECTED_REQUEST_SIZE, ETHEREUM_ITEM_KINDS, ETHEREUM_MAX_RELIQUARIES, ETHEREUM_CRATES_PER_RELIQUARY,
  ETHEREUM_MAX_TOKEN_INFO_BATCH_SIZE, ethereumAssetId, ethereumHexQuantity, ethereumItemKind,
  ethereumItemDisplayIdMaximum, ethereumMetadataTokenId, normalizeEthereumTokenId,
} from '../../../../shared/ethereum/protocol.js';
import { cancelResponseBody, readBoundedResponseJson } from './boundedResponse.js';
import { EthereumApiError } from './ethereumError.js';
import { ethereum111kWritesAllowed } from './ethereumControl.js';
import {
  ethereumAddress, ethereumBlockSnapshot, ethereumCall, ethereumCallBatch, ethereumRpc, requireEthereumContract, rpcInteger,
  verifyEthereumBlockSnapshot,
  type EthereumContext,
} from './ethereumRuntime.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PAGE_SIZE = 30;

export type EthereumTokenInfo = { tokenId: string; kind: EthereumItemKind; displayId: number; owner: string };
export type EthereumLog = { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string;
  transactionHash: string; logIndex: string; removed?: boolean };
export type EthereumReceipt = { transactionHash: string; blockNumber: string; blockHash: string; status: string;
  from: string; to: string | null; logs: EthereumLog[] };

export function parseEthereumLog(value: unknown): EthereumLog {
  if (!value || typeof value !== 'object') throw new EthereumApiError('unavailable', 'Invalid Ethereum log.');
  const row = value as Record<string, unknown>;
  if (typeof row.address !== 'string' || !Array.isArray(row.topics) || !row.topics.every((topic) => typeof topic === 'string' && /^0x[0-9a-fA-F]{64}$/.test(topic)) ||
    typeof row.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(row.data) || typeof row.blockNumber !== 'string' ||
    typeof row.blockHash !== 'string' || typeof row.transactionHash !== 'string' || typeof row.logIndex !== 'string') {
    throw new EthereumApiError('unavailable', 'Invalid Ethereum log.');
  }
  return row as EthereumLog;
}

export async function ethereumReceipt(context: EthereumContext, hash: string, allowReverted = false): Promise<{ receipt: EthereumReceipt | null; confirmations: number }> {
  const raw = await ethereumRpc(context, 'eth_getTransactionReceipt', [hash]);
  if (raw === null) return { receipt: null, confirmations: 0 };
  if (!raw || typeof raw !== 'object') throw new EthereumApiError('unavailable', 'Invalid Ethereum transaction receipt.');
  const row = raw as Record<string, unknown>;
  if (row.transactionHash !== hash || typeof row.blockNumber !== 'string' || typeof row.blockHash !== 'string' ||
    (row.status !== '0x0' && row.status !== '0x1') || typeof row.from !== 'string' || !Array.isArray(row.logs)) {
    throw new EthereumApiError('unavailable', 'Invalid Ethereum transaction receipt.');
  }
  const block = rpcInteger(row.blockNumber);
  const [headRaw, canonicalRaw] = await Promise.all([
    ethereumRpc(context, 'eth_blockNumber', []), ethereumRpc(context, 'eth_getBlockByNumber', [row.blockNumber, false]),
  ]);
  const canonical = canonicalRaw && typeof canonicalRaw === 'object' ? canonicalRaw as Record<string, unknown> : null;
  if (!canonical || canonical.hash !== row.blockHash) return { receipt: null, confirmations: 0 };
  if (row.status !== '0x1' && !allowReverted) throw new EthereumApiError('failed-precondition', 'The Ethereum transaction reverted.', { kind: 'transaction-reverted' });
  const logs = row.logs.map(parseEthereumLog);
  return { receipt: { ...row, logs } as EthereumReceipt, confirmations: Math.max(0, rpcInteger(headRaw) - block + 1) };
}

function parseMetadata(value: unknown): EthereumMetadata {
  if (!value || typeof value !== 'object' || !('name' in value) || !('image' in value) ||
    typeof value.name !== 'string' || !isEthereumMetadataImage(value.image)) {
    throw new EthereumApiError('unavailable', 'Invalid Ethereum metadata.');
  }
  return { name: value.name, image: value.image,
    ...('category' in value && (value.category === 'egg' || value.category === 'painting' || value.category === 'video')
      ? { category: value.category } : {}),
    ...('revealStatus' in value && (value.revealStatus === 'unrevealed' || value.revealStatus === 'revealed')
      ? { revealStatus: value.revealStatus } : {}),
    ...('animation_url' in value && typeof value.animation_url === 'string' && /^https:\/\//i.test(value.animation_url) &&
      isEthereumMetadataImage(value.animation_url) ? { animation_url: value.animation_url } : {}),
    ...('aspectRatio' in value && value.aspectRatio && typeof value.aspectRatio === 'object' &&
      'width' in value.aspectRatio && 'height' in value.aspectRatio &&
      typeof value.aspectRatio.width === 'number' && Number.isFinite(value.aspectRatio.width) && value.aspectRatio.width > 0 &&
      typeof value.aspectRatio.height === 'number' && Number.isFinite(value.aspectRatio.height) && value.aspectRatio.height > 0
      ? { aspectRatio: { width: value.aspectRatio.width, height: value.aspectRatio.height } } : {}),
    ...('description' in value && typeof value.description === 'string' ? { description: value.description } : {}),
    ...('attributes' in value && Array.isArray(value.attributes) ? { attributes: value.attributes } : {}) };
}

async function readMetadata(context: EthereumContext, tokenId: string): Promise<EthereumMetadata> {
  const uri = ethereumTokenMetadataUri(context.config, tokenId);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await context.fetch(uri, {
      headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'manual', signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new EthereumApiError('unavailable', 'Ethereum metadata is temporarily unavailable.');
  }
  if (response.status !== 200) {
    await cancelResponseBody(response);
    throw new EthereumApiError('unavailable', 'Ethereum metadata is temporarily unavailable.');
  }
  return parseMetadata(await readBoundedResponseJson(response, { maxBytes: 128 * 1024, contentType: 'require-json', signal,
    createError: () => new EthereumApiError('unavailable', 'Invalid Ethereum metadata.') }));
}

async function ethereumMetadata(context: EthereumContext, kind: EthereumItemKind, displayId: number): Promise<EthereumMetadata> {
  return readMetadata(context, ethereumMetadataTokenId(kind, displayId));
}

function readChunks<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

export async function ethereumTokenInfos(context: EthereumContext, ids: string[], blockReference = 'latest'): Promise<EthereumTokenInfo[]> {
  const batches = readChunks(ids, ETHEREUM_MAX_TOKEN_INFO_BATCH_SIZE);
  const values = await ethereumCallBatch(context, batches.map((batch) => encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, ['uint256[]'], [batch])), blockReference);
  return values.flatMap((value, index) => {
    const [rows] = decodeReturn(['(uint8,uint256,address)[]'], value);
    if (!Array.isArray(rows) || rows.length !== batches[index].length) throw new EthereumApiError('unavailable', 'Ethereum token information is incomplete.');
    return rows.flatMap(([rawKind, rawDisplayId, rawOwner], itemIndex) => {
      if (rawKind === 0n && rawDisplayId === 0n && rawOwner === ZERO_ADDRESS) return [];
      const kind = ethereumItemKind(Number(rawKind));
      const displayId = Number(rawDisplayId);
      if (!kind || rawOwner === ZERO_ADDRESS || !Number.isSafeInteger(displayId) || displayId < 1 ||
        displayId > ethereumItemDisplayIdMaximum(kind)) {
        throw new EthereumApiError('unavailable', 'Invalid Ethereum token information.');
      }
      return [{ tokenId: batches[index][itemIndex], kind, displayId, owner: ethereumAddress(rawOwner) }];
    });
  });
}

export async function ethereumInventoryItems(context: EthereumContext, infos: EthereumTokenInfo[]): Promise<EthereumInventoryItem[]> {
  const contractAddress = requireEthereumContract(context);
  for (const info of infos) {
    if (ethereumMetadataTokenId(info.kind, info.displayId) !== info.tokenId) {
      throw new EthereumApiError('unavailable', 'Invalid Ethereum token information.');
    }
  }
  const items = new Array<EthereumInventoryItem>(infos.length);
  const cancellation = new AbortController();
  const metadataContext = { ...context, signal: AbortSignal.any([context.signal, cancellation.signal]) };
  const pending = new Map<string, Promise<EthereumMetadata>>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(infos.length, 8) }, async () => {
    try {
      while (next < infos.length) {
        metadataContext.signal.throwIfAborted();
        const index = next++;
        const info = infos[index];
        let metadata = pending.get(info.tokenId);
        if (!metadata) {
          metadata = readMetadata(metadataContext, info.tokenId);
          pending.set(info.tokenId, metadata);
        }
        items[index] = { ...info, ...await metadata, id: ethereumAssetId(context.config.chainId, contractAddress, info.tokenId),
          chainId: context.config.chainId, contractAddress };
      }
    } catch (error) {
      cancellation.abort(error);
      throw error;
    }
  }));
  context.signal.throwIfAborted();
  return items;
}

async function alchemyOwnerIds(context: EthereumContext, wallet: string, cursor: string | null): Promise<{ ids: string[]; nextCursor: string | null }> {
  const key = context.env.ALCHEMY_MI_NOTE_API_KEY?.trim();
  if (!key) throw new EthereumApiError('unavailable', 'Ethereum inventory is unavailable.');
  const url = new URL(`https://eth-sepolia.g.alchemy.com/nft/v3/${encodeURIComponent(key)}/getNFTsForOwner`);
  url.searchParams.set('owner', wallet);
  url.searchParams.set('contractAddresses[]', requireEthereumContract(context));
  url.searchParams.set('withMetadata', 'false');
  url.searchParams.set('pageSize', String(PAGE_SIZE));
  if (cursor) url.searchParams.set('pageKey', cursor);
  const response = await context.fetch(url, { signal: context.signal, redirect: 'manual' });
  const body = await readBoundedResponseJson(response, { maxBytes: 512 * 1024, contentType: 'require-json', signal: context.signal,
    createError: () => new EthereumApiError('unavailable', 'Ethereum inventory is unavailable.') });
  if (!response.ok || !body || typeof body !== 'object' || !('ownedNfts' in body) || !Array.isArray(body.ownedNfts) || body.ownedNfts.length > PAGE_SIZE) {
    throw new EthereumApiError('unavailable', 'Ethereum inventory is unavailable.');
  }
  const record = body as Record<string, unknown>;
  const ids = body.ownedNfts.map((value: Record<string, unknown>) => {
    const id = normalizeEthereumTokenId(value.tokenId);
    const address = typeof value.contractAddress === 'string' ? value.contractAddress : (value.contract as Record<string, unknown> | undefined)?.address;
    if (!id || ethereumAddress(address) !== context.config.contractAddress) throw new EthereumApiError('unavailable', 'Invalid Ethereum inventory response.');
    return id;
  });
  const nextCursor = typeof record.pageKey === 'string' && record.pageKey.length <= 4096 ? record.pageKey : null;
  if (nextCursor && nextCursor === cursor) throw new EthereumApiError('unavailable', 'Invalid inventory pagination.');
  return { ids, nextCursor };
}

async function localOwnerInfos(context: EthereumContext, wallet: string, head: number, blockHash: string): Promise<EthereumTokenInfo[]> {
  if (head - context.config.deploymentBlock > 50_000) throw new EthereumApiError('resource-exhausted', 'Reset the local test chain to refresh its inventory.');
  const topic = `0x${wallet.slice(2).padStart(64, '0')}`;
  const ids = new Set<string>();
  for (let start = context.config.deploymentBlock; start <= head; start += 2_000) {
    const result = await ethereumRpc(context, 'eth_getLogs', [{ address: requireEthereumContract(context),
      fromBlock: ethereumHexQuantity(start), toBlock: ethereumHexQuantity(Math.min(head, start + 1999)), topics: [TRANSFER_TOPIC, null, topic] }]);
    if (!Array.isArray(result)) throw new EthereumApiError('unavailable', 'Invalid Ethereum inventory logs.');
    for (const raw of result) {
      const log = parseEthereumLog(raw);
      if (log.topics.length === 4) ids.add(BigInt(log.topics[3]).toString());
    }
  }
  const candidates = [...ids].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  const infos = await ethereumTokenInfos(context, candidates, blockHash);
  return infos.filter(info => info.owner === wallet);
}

export async function ethereumPublicRead(request: Request, context: EthereumContext, path: string): Promise<unknown> {
  if (path.endsWith('/config')) return {
    ...context.config,
    enabled: context.config.enabled && await ethereum111kWritesAllowed(context.env.COMMERCE_DB, context.config, context.signal),
  };
  requireEthereumContract(context);
  const url = new URL(request.url);
  if (path.endsWith('/stats')) {
    const owner = url.searchParams.has('owner') ? ethereumAddress(url.searchParams.get('owner')) : null;
    const values = decodeReturn(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      await ethereumCall(context, encodeCall(ETHEREUM_FUNCTIONS.stats, ['address'], [owner ?? `0x${'0'.repeat(40)}`])),
    );
    const allocatedCrates = Number(values[0]);
    return { chainId: context.config.chainId, contractAddress: requireEthereumContract(context), owner,
      allocatedCrates, warehousesMinted: Number(values[1]), artworksMinted: Number(values[2]),
      cratePriceWei: String(values[3]), warehousePriceWei: String(values[4]), saleActive: values[5],
      remainingCrates: 5555 - allocatedCrates, remainingWarehouses: Math.floor((5555 - allocatedCrates) / 11),
      discountMerkleRoot: values[6], discountCratePriceWei: String(values[7]),
      discountAllowance: Number(values[8]), discountUsed: Number(values[9]),
      reliquariesMinted: Number(values[10]), reliquaryPriceWei: String(values[11]),
      remainingReliquaries: Math.min(ETHEREUM_MAX_RELIQUARIES - Number(values[10]), Math.floor((5555 - allocatedCrates) / ETHEREUM_CRATES_PER_RELIQUARY)) };
  }
  if (path.endsWith('/metadata')) {
    const kind = url.searchParams.get('kind') as EthereumItemKind;
    const displayId = Number(url.searchParams.get('displayId'));
    if (!ETHEREUM_ITEM_KINDS.includes(kind) || !Number.isInteger(displayId) || displayId < 1 ||
      displayId > ethereumItemDisplayIdMaximum(kind)) {
      throw new EthereumApiError('invalid-argument', 'Invalid item metadata request.');
    }
    return ethereumMetadata(context, kind, displayId);
  }
  const wallet = ethereumAddress(url.searchParams.get('owner'));
  const cursor = url.searchParams.get('cursor');
  if (cursor && cursor.length > 4096) throw new EthereumApiError('invalid-argument', 'Invalid inventory cursor.');
  const expected = url.searchParams.get('expectedTokenIds');
  const extraIds = expected && !cursor ? expected.split(',').map(normalizeEthereumTokenId) : [];
  if (extraIds.length > ETHEREUM_INVENTORY_EXPECTED_REQUEST_SIZE || extraIds.some((id) => !id)) throw new EthereumApiError('invalid-argument', 'Invalid recent token IDs.');
  const snapshot = await ethereumBlockSnapshot(context);
  const blockReference = snapshot.blockHash;
  const recentIds = [...new Set(extraIds.filter((id): id is string => id !== null))];
  let infos: EthereumTokenInfo[];
  let nextCursor: string | null;
  if (context.config.chainId === 31337) {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new EthereumApiError('invalid-argument', 'Invalid inventory cursor.');
    const owned = await localOwnerInfos(context, wallet, snapshot.blockNumber, blockReference);
    const ownedIds = new Set(owned.map(info => info.tokenId));
    const recovered = await ethereumTokenInfos(context, recentIds.filter(id => !ownedIds.has(id)), blockReference);
    const recent = new Set(recentIds);
    const page = owned.slice(offset, offset + PAGE_SIZE);
    infos = [...new Map([...page, ...owned.filter((info) => recent.has(info.tokenId)), ...recovered].map((info) => [info.tokenId, info])).values()];
    nextCursor = offset + PAGE_SIZE < owned.length ? String(offset + PAGE_SIZE) : null;
  } else {
    const page = await alchemyOwnerIds(context, wallet, cursor);
    infos = await ethereumTokenInfos(context, [...new Set([...page.ids, ...recentIds])], blockReference);
    nextCursor = page.nextCursor;
  }
  const items = await ethereumInventoryItems(context, infos.filter((info) => info.owner === wallet));
  await verifyEthereumBlockSnapshot(context, snapshot);
  return { items, nextCursor, observedBlock: snapshot.blockNumber };
}

export function transferTokenIds(receipt: EthereumReceipt, contract: string): { minted: string[]; burned: string[] } {
  const minted: string[] = [], burned: string[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 4 || log.removed) continue;
    const id = BigInt(log.topics[3]).toString();
    if (BigInt(log.topics[1]) === 0n) minted.push(id);
    if (BigInt(log.topics[2]) === 0n) burned.push(id);
  }
  return { minted, burned };
}
