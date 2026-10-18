import { encodeCall, decodeReturn } from '../../../../shared/ethereum/abi.js';
import type { EthereumInventoryItem, EthereumItemKind, EthereumMetadata } from '../../../../shared/ethereum/protocol.js';
import {
  ETHEREUM_ITEM_KINDS, ethereumAssetId, ethereumHexQuantity, ethereumItemKind,
  ethereumItemKindNumber, normalizeEthereumTokenId,
} from '../../../../shared/ethereum/protocol.js';
import { readBoundedResponseJson } from './boundedResponse.js';
import { EthereumApiError } from './ethereumError.js';
import {
  ethereumAddress, ethereumCall, ethereumCallBatch, ethereumRpc, requireEthereumContract, rpcInteger,
  type EthereumContext,
} from './ethereumRuntime.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PAGE_SIZE = 30;
const LOCAL_TOKEN_INFO_BATCH_SIZE = 150;

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

export async function ethereumReceipt(context: EthereumContext, hash: string): Promise<{ receipt: EthereumReceipt | null; confirmations: number }> {
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
  if (row.status !== '0x1') throw new EthereumApiError('failed-precondition', 'The Ethereum transaction reverted.', { kind: 'transaction-reverted' });
  const logs = row.logs.map(parseEthereumLog);
  return { receipt: { ...row, logs } as EthereumReceipt, confirmations: Math.max(0, rpcInteger(headRaw) - block + 1) };
}

function parseMetadata(uri: unknown): EthereumMetadata {
  if (typeof uri !== 'string' || uri.length > 128 * 1024 || !uri.startsWith('data:application/json;base64,')) {
    throw new EthereumApiError('unavailable', 'Invalid onchain metadata.');
  }
  try {
    const value = JSON.parse(atob(uri.slice('data:application/json;base64,'.length)));
    if (typeof value.name !== 'string' || typeof value.image !== 'string' ||
      !value.image.startsWith('data:image/svg+xml;base64,')) throw new Error('Invalid SVG');
    return { name: value.name, image: value.image,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(Array.isArray(value.attributes) ? { attributes: value.attributes } : {}) };
  } catch { throw new EthereumApiError('unavailable', 'Invalid onchain metadata.'); }
}

async function ethereumMetadata(context: EthereumContext, kind: EthereumItemKind, displayId: number): Promise<EthereumMetadata> {
  const value = await ethereumCall(context, encodeCall('previewTokenURI(uint8,uint256)', ['uint8', 'uint256'], [ethereumItemKindNumber(kind), displayId]));
  return parseMetadata(decodeReturn(['string'], value)[0]);
}

export async function ethereumTokenInfos(context: EthereumContext, ids: string[]): Promise<EthereumTokenInfo[]> {
  const values = await ethereumCallBatch(context, ids.map((id) => encodeCall('getTokenInfo(uint256)', ['uint256'], [id])));
  return values.flatMap((value, index) => {
    const [rawKind, rawDisplayId, rawOwner] = decodeReturn(['uint8', 'uint256', 'address'], value);
    const kind = ethereumItemKind(Number(rawKind));
    const displayId = Number(rawDisplayId);
    if (!kind || rawOwner === ZERO_ADDRESS) return [];
    if (!Number.isSafeInteger(displayId) || displayId < 1) throw new EthereumApiError('unavailable', 'Invalid item number.');
    return [{ tokenId: ids[index], kind, displayId, owner: ethereumAddress(rawOwner) }];
  });
}

export async function ethereumInventoryItems(context: EthereumContext, infos: EthereumTokenInfo[]): Promise<EthereumInventoryItem[]> {
  const values = await ethereumCallBatch(context, infos.map((info) => encodeCall('previewTokenURI(uint8,uint256)', ['uint8', 'uint256'], [ethereumItemKindNumber(info.kind), info.displayId])));
  const contractAddress = requireEthereumContract(context);
  return values.map((value, index) => ({ ...infos[index], ...parseMetadata(decodeReturn(['string'], value)[0]),
    id: ethereumAssetId(context.config.chainId, contractAddress, infos[index].tokenId),
    chainId: context.config.chainId, contractAddress }));
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

async function localOwnerIds(context: EthereumContext, wallet: string): Promise<string[]> {
  const head = rpcInteger(await ethereumRpc(context, 'eth_blockNumber', []));
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
  const owned: string[] = [];
  for (let offset = 0; offset < candidates.length; offset += LOCAL_TOKEN_INFO_BATCH_SIZE) {
    const infos = await ethereumTokenInfos(context, candidates.slice(offset, offset + LOCAL_TOKEN_INFO_BATCH_SIZE));
    owned.push(...infos.filter(info => info.owner === wallet).map(info => info.tokenId));
  }
  return owned;
}

export async function ethereumPublicRead(request: Request, context: EthereumContext, path: string): Promise<unknown> {
  if (path.endsWith('/config')) return context.config;
  requireEthereumContract(context);
  const url = new URL(request.url);
  if (path.endsWith('/stats')) {
    const values = decodeReturn(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool'], await ethereumCall(context, encodeCall('stats()', [], [])));
    const allocatedCrates = Number(values[0]);
    return { allocatedCrates, warehousesMinted: Number(values[1]), artworksMinted: Number(values[2]),
      cratePriceWei: String(values[3]), warehousePriceWei: String(values[4]), saleActive: values[5],
      remainingCrates: 5555 - allocatedCrates, remainingWarehouses: Math.floor((5555 - allocatedCrates) / 11) };
  }
  if (path.endsWith('/metadata')) {
    const kind = url.searchParams.get('kind') as EthereumItemKind;
    const displayId = Number(url.searchParams.get('displayId'));
    const maximum = kind === 'warehouse' ? 505 : kind === 'crate' || kind === 'crate_receipt' ? 5555 : 111111;
    if (!ETHEREUM_ITEM_KINDS.includes(kind) || !Number.isInteger(displayId) || displayId < 1 || displayId > maximum) {
      throw new EthereumApiError('invalid-argument', 'Invalid item metadata request.');
    }
    return ethereumMetadata(context, kind, displayId);
  }
  const wallet = ethereumAddress(url.searchParams.get('owner'));
  const cursor = url.searchParams.get('cursor');
  if (cursor && cursor.length > 4096) throw new EthereumApiError('invalid-argument', 'Invalid inventory cursor.');
  const expected = url.searchParams.get('expectedTokenIds');
  const extraIds = expected && !cursor ? expected.split(',').map(normalizeEthereumTokenId) : [];
  if (extraIds.length > 100 || extraIds.some((id) => !id)) throw new EthereumApiError('invalid-argument', 'Invalid recent token IDs.');
  let page: { ids: string[]; nextCursor: string | null };
  if (context.config.chainId === 31337) {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new EthereumApiError('invalid-argument', 'Invalid inventory cursor.');
    const ids = await localOwnerIds(context, wallet);
    page = { ids: ids.slice(offset, offset + PAGE_SIZE), nextCursor: offset + PAGE_SIZE < ids.length ? String(offset + PAGE_SIZE) : null };
  } else page = await alchemyOwnerIds(context, wallet, cursor);
  const infos = await ethereumTokenInfos(context, [...new Set([...page.ids, ...extraIds.filter((id): id is string => id !== null)])]);
  const items = await ethereumInventoryItems(context, infos.filter((info) => info.owner === wallet));
  return { items, nextCursor: page.nextCursor, observedBlock: rpcInteger(await ethereumRpc(context, 'eth_blockNumber', [])) };
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
