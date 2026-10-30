import { decodeEventLogs, decodeReturn, encodeCall, ETHEREUM_EVENT_TOPICS } from '../../../../shared/ethereum/abi.js';
import { ethereumHexQuantity, ETHEREUM_FUNCTIONS, ETHEREUM_MAX_UNBOX_QUANTITY } from '../../../../shared/ethereum/protocol.js';
import type { EthereumRevealObservation } from '../../../../shared/ethereum/reveal.js';
import type { EthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { readBoundedResponseJson } from './boundedResponse.js';
import { EthereumApiError } from './ethereumError.js';
import { rpcInteger } from './ethereumRpcValue.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const FIRST_CRATE = 111_112;
const LAST_CRATE = 116_666;
const MAX_ARTWORKS = 111_111;
const STATS_TYPES = ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bytes32', 'uint256', 'uint256', 'uint256'];

type RevealChainEnvironment = { ALCHEMY_MI_NOTE_API_KEY?: string; ETHEREUM_111K_RPC_URL?: string };
type RevealChainDeployment = Pick<EthereumRevealDeployment, 'chainId' | 'contractAddress' | 'deploymentBlock'>;
type ChainLog = { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string;
  transactionHash: string; logIndex: string; removed?: boolean };
type ChainBlock = { number: number; hash: string };
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export type EthereumRevealCrate = { crateTokenId: string; tokenIds: string[] };
export type EthereumRevealTransactionInspection =
  | { status: 'pending'; seen: boolean; crates?: string[]; fromBlock?: number }
  | { status: 'confirmed'; observation: EthereumRevealObservation; crates: EthereumRevealCrate[]; confirmations: number }
  | { status: 'reverted' | 'not_unpack'; source: 'receipt'; observation: EthereumRevealObservation; confirmations: number }
  | { status: 'not_unpack'; source: 'input' };
export type EthereumRevealSearchRange = { fromBlock: number; toBlock: number };
export type EthereumRevealTokenRecovery = {
  provenance: Array<EthereumRevealObservation & { tokenIds: string[] }>;
  scannedRange: EthereumRevealSearchRange | null;
  remainingRanges: EthereumRevealSearchRange[];
  mintedThrough: number;
  observedBlock: ChainBlock;
};
export type EthereumRevealCrateRecovery = Omit<EthereumRevealTokenRecovery, 'mintedThrough' | 'provenance'> & {
  provenance: Array<EthereumRevealObservation & { crateTokenIds: string[] }>;
};

class RevealRangeTooLarge extends Error {}

function unavailable(): EthereumApiError {
  return new EthereumApiError('unavailable', 'Ethereum reveal verification is temporarily unavailable.');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

function normalizedHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw unavailable();
  return value.toLowerCase();
}

function rpcUrl(env: RevealChainEnvironment, deployment: RevealChainDeployment): string {
  if (deployment.chainId === 31337) {
    let url: URL;
    try { url = new URL(env.ETHEREUM_111K_RPC_URL || ''); } catch { throw unavailable(); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash) throw unavailable();
    return url.href;
  }
  const host = deployment.chainId === 1 ? 'eth-mainnet' : deployment.chainId === 11155111 ? 'eth-sepolia' : null;
  const key = env.ALCHEMY_MI_NOTE_API_KEY?.trim();
  if (!host || !key) throw unavailable();
  return `https://${host}.g.alchemy.com/v2/${encodeURIComponent(key)}`;
}

function createRpc(env: RevealChainEnvironment, deployment: RevealChainDeployment, signal: AbortSignal, providerFetch: typeof fetch): Rpc {
  const url = rpcUrl(env, deployment);
  return async (method, params) => {
    const timeout = AbortSignal.timeout(10_000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    try {
      const response = await providerFetch(url, { method: 'POST', redirect: 'manual', signal: requestSignal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const body = record(await readBoundedResponseJson(response, { maxBytes: 3 * 1024 * 1024,
        signal: requestSignal, contentType: 'require-json',
        createError: failure => method === 'eth_getLogs' && failure === 'too-large' ? new RevealRangeTooLarge() : unavailable() }));
      if (method === 'eth_getLogs' && body.error && typeof body.error === 'object') {
        const error = record(body.error);
        if (typeof error.message === 'string' && !/rate|quota|credits|compute units/i.test(error.message) &&
          /block range|too many (?:logs|results)|response size|query.*(?:limit|timeout)|limit exceeded/i.test(error.message)) {
          throw new RevealRangeTooLarge();
        }
      }
      if (!response.ok || body.id !== 1 || body.jsonrpc !== '2.0' || !('result' in body) || 'error' in body) throw unavailable();
      return body.result;
    } catch (error) {
      signal.throwIfAborted();
      if (method === 'eth_getLogs' && timeout.aborted) throw new RevealRangeTooLarge();
      throw error instanceof EthereumApiError || error instanceof RevealRangeTooLarge ? error : unavailable();
    }
  };
}

function parseBlock(value: unknown): ChainBlock {
  const row = record(value);
  return { number: rpcInteger(row.number), hash: normalizedHash(row.hash) };
}

async function verifyChain(rpc: Rpc, deployment: RevealChainDeployment): Promise<void> {
  if (rpcInteger(await rpc('eth_chainId', [])) !== deployment.chainId) throw unavailable();
}

export async function verifyRevealDeployment(env: RevealChainEnvironment,
  deployment: RevealChainDeployment & Pick<EthereumRevealDeployment, 'metadataBaseUri'>,
  signal: AbortSignal, providerFetch: typeof fetch = fetch): Promise<void> {
  const rpc = createRpc(env, deployment, signal, providerFetch);
  await verifyChain(rpc, deployment);
  const block = parseBlock(await rpc('eth_getBlockByNumber', ['latest', false]));
  if (!Number.isSafeInteger(deployment.deploymentBlock) || deployment.deploymentBlock < 1 || deployment.deploymentBlock > block.number) {
    throw new EthereumApiError('failed-precondition', 'The collection deployment block must be a mined block after genesis.');
  }
  const [created, previous] = await Promise.all([deployment.deploymentBlock, deployment.deploymentBlock - 1]
    .map(async number => {
      const value = parseBlock(await rpc('eth_getBlockByNumber', [ethereumHexQuantity(number), false]));
      if (value.number !== number) throw unavailable();
      return value;
    }));
  const reference = { blockHash: block.hash, requireCanonical: true };
  const [code, data, createdCode, previousCode] = await Promise.all([
    rpc('eth_getCode', [deployment.contractAddress, reference]),
    rpc('eth_call', [{ to: deployment.contractAddress, data: encodeCall('baseURI()', [], []) }, reference]),
    rpc('eth_getCode', [deployment.contractAddress, { blockHash: created.hash, requireCanonical: true }]),
    rpc('eth_getCode', [deployment.contractAddress, { blockHash: previous.hash, requireCanonical: true }]),
  ]);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || typeof data !== 'string' || !BYTES.test(data) ||
    typeof createdCode !== 'string' || !BYTES.test(createdCode) || typeof previousCode !== 'string' || !BYTES.test(previousCode)) throw unavailable();
  if (createdCode === '0x' || previousCode !== '0x') {
    throw new EthereumApiError('failed-precondition', 'The collection was not created at its configured deployment block.');
  }
  const [uri] = decodeReturn(['string'], data);
  if (uri !== deployment.metadataBaseUri) throw new EthereumApiError('failed-precondition', 'The collection metadata URL does not match its reveal deployment.');
  await Promise.all([block, created, previous].map(async expected => {
    const canonical = parseBlock(await rpc('eth_getBlockByNumber', [ethereumHexQuantity(expected.number), false]));
    if (canonical.number !== expected.number || canonical.hash !== expected.hash) throw unavailable();
  }));
}

function parseLog(value: unknown): ChainLog {
  const row = record(value);
  if (typeof row.address !== 'string' || !ADDRESS.test(row.address) || !Array.isArray(row.topics) ||
    row.topics.length > 4 || !row.topics.every(topic => typeof topic === 'string' && HASH.test(topic)) ||
    typeof row.data !== 'string' || !BYTES.test(row.data) ||
    row.removed !== undefined && typeof row.removed !== 'boolean') throw unavailable();
  const blockNumber = ethereumHexQuantity(rpcInteger(row.blockNumber));
  const logIndex = ethereumHexQuantity(rpcInteger(row.logIndex));
  return { address: row.address.toLowerCase(), topics: row.topics.map(topic => topic.toLowerCase()), data: row.data.toLowerCase(),
    blockNumber, logIndex, blockHash: normalizedHash(row.blockHash), transactionHash: normalizedHash(row.transactionHash),
    ...(typeof row.removed === 'boolean' ? { removed: row.removed } : {}) };
}

function pendingCrateIds(input: string): string[] | null {
  const selector = input.slice(0, 10);
  let ids: bigint[];
  if (selector === encodeCall(ETHEREUM_FUNCTIONS.unboxCrate, [], [])) {
    if (input.length < 74) throw new Error('Incomplete pending calldata.');
    ids = decodeReturn(['uint256'], `0x${input.slice(10, 74)}`) as bigint[];
  } else if (selector === encodeCall(ETHEREUM_FUNCTIONS.unboxCrates, [], [])) {
    [ids] = decodeReturn(['uint256[]'], `0x${input.slice(10, 10 + Math.floor((input.length - 10) / 64) * 64)}`) as [bigint[]];
  } else return null;
  if (!ids.length || ids.length > ETHEREUM_MAX_UNBOX_QUANTITY || new Set(ids).size !== ids.length ||
    ids.some(id => id < BigInt(FIRST_CRATE) || id > BigInt(LAST_CRATE))) return null;
  return ids.map(String);
}

async function inspectPending(rpc: Rpc, deployment: RevealChainDeployment, hash: string,
  onSeen?: () => void | Promise<void>): Promise<EthereumRevealTransactionInspection> {
  const raw = await rpc('eth_getTransactionByHash', [hash]);
  if (raw === null) return { status: 'pending', seen: false };
  const row = record(raw);
  if (normalizedHash(row.hash) !== hash || typeof row.from !== 'string' || !ADDRESS.test(row.from) ||
    typeof row.to !== 'string' && row.to !== null || typeof row.to === 'string' && !ADDRESS.test(row.to) ||
    row.chainId !== undefined && rpcInteger(row.chainId) !== deployment.chainId) throw unavailable();
  await onSeen?.();
  if (typeof row.to !== 'string' || row.to.toLowerCase() !== deployment.contractAddress) return { status: 'pending', seen: true };
  const input = row.input ?? row.data;
  if (typeof input !== 'string' || !BYTES.test(input) || typeof row.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(row.value)) throw unavailable();
  let ids: string[] | null;
  try { ids = pendingCrateIds(input.toLowerCase()); } catch { return { status: 'pending', seen: true }; }
  if (!ids || BigInt(row.value) !== 0n) return { status: 'not_unpack', source: 'input' };
  if (row.blockNumber !== null && row.blockNumber !== undefined) return { status: 'pending', seen: true };
  const block = parseBlock(await rpc('eth_getBlockByNumber', ['latest', false]));
  const result = await rpc('eth_call', [{ to: deployment.contractAddress,
    data: encodeCall(ETHEREUM_FUNCTIONS.tokenInfos, ['uint256[]'], [ids]) }, { blockHash: block.hash, requireCanonical: true }]);
  if (typeof result !== 'string' || !BYTES.test(result)) throw unavailable();
  const [infos] = decodeReturn(['(uint8,uint256,address)[]'], result) as [[bigint, bigint, string][]];
  if (infos.length !== ids.length) throw unavailable();
  const owned = infos.every(([kind, displayId, owner], index) => kind === 2n &&
    displayId === BigInt(ids![index]) - 111_111n && owner === String(row.from).toLowerCase() && owner !== ZERO);
  if (!owned) return { status: 'pending', seen: true, fromBlock: block.number };
  const canonical = parseBlock(await rpc('eth_getBlockByNumber', [ethereumHexQuantity(block.number), false]));
  if (canonical.hash !== block.hash) return { status: 'pending', seen: true };
  return { status: 'pending', seen: true, crates: ids, fromBlock: block.number };
}

function confirmedCrates(logs: ChainLog[], deployment: RevealChainDeployment, observation: EthereumRevealObservation): EthereumRevealCrate[] {
  const relevant = logs.filter(log => log.address === deployment.contractAddress);
  const indices = new Set<number>();
  for (const log of relevant) {
    const index = rpcInteger(log.logIndex);
    if (log.removed || log.transactionHash !== observation.transactionHash || log.blockHash !== observation.blockHash ||
      rpcInteger(log.blockNumber) !== observation.blockNumber || indices.has(index)) throw unavailable();
    indices.add(index);
  }
  const events = decodeEventLogs(relevant, deployment.contractAddress);
  const unboxes = events.filter(event => event.name === 'CrateUnboxed');
  if (!unboxes.length) return [];
  const transfers = events.filter(event => event.name === 'Transfer');
  const mints = new Map<string, typeof transfers[number]>();
  const burns = new Map<string, typeof transfers[number]>();
  for (const event of transfers) {
    if (event.from === ZERO) {
      if (mints.has(event.tokenId)) throw unavailable();
      mints.set(event.tokenId, event);
    }
    if (event.to === ZERO) {
      if (burns.has(event.tokenId)) throw unavailable();
      burns.set(event.tokenId, event);
    }
  }
  const crates = new Set<string>();
  const artworks = new Set<string>();
  const result = unboxes.sort((left, right) => rpcInteger(left.log.logIndex) - rpcInteger(right.log.logIndex)).map(event => {
    const crateId = Number(event.crateTokenId);
    const count = crateId === LAST_CRATE ? 31 : 20;
    if (crateId < FIRST_CRATE || crateId > LAST_CRATE || event.count !== count || event.owner === ZERO ||
      event.firstArtToken < 1 || event.firstArtToken + count - 1 > MAX_ARTWORKS || crates.has(event.crateTokenId)) throw unavailable();
    crates.add(event.crateTokenId);
    const burn = burns.get(event.crateTokenId);
    const eventIndex = rpcInteger(event.log.logIndex);
    if (!burn || burn.from !== event.owner || rpcInteger(burn.log.logIndex) >= eventIndex) throw unavailable();
    const tokenIds = Array.from({ length: count }, (_, index) => String(event.firstArtToken + index));
    for (const id of tokenIds) {
      const mint = mints.get(id);
      if (!mint || mint.to !== event.owner || artworks.has(id) || rpcInteger(mint.log.logIndex) >= eventIndex ||
        rpcInteger(mint.log.logIndex) <= rpcInteger(burn.log.logIndex)) throw unavailable();
      artworks.add(id);
    }
    return { crateTokenId: event.crateTokenId, tokenIds };
  });
  for (const [id] of mints) {
    if (BigInt(id) >= 1n && BigInt(id) <= BigInt(MAX_ARTWORKS) && !artworks.has(id)) throw unavailable();
  }
  return result;
}

export async function inspectRevealTransaction(env: RevealChainEnvironment, deployment: RevealChainDeployment,
  transactionHash: string, signal: AbortSignal, providerFetch: typeof fetch = fetch,
  onSeen?: () => void | Promise<void>): Promise<EthereumRevealTransactionInspection> {
  const hash = normalizedHash(transactionHash);
  const rpc = createRpc(env, deployment, signal, providerFetch);
  const [, raw] = await Promise.all([verifyChain(rpc, deployment), rpc('eth_getTransactionReceipt', [hash])]);
  if (raw === null) return inspectPending(rpc, deployment, hash, onSeen);
  const row = record(raw);
  if (normalizedHash(row.transactionHash) !== hash || !Array.isArray(row.logs) ||
    row.status !== '0x0' && row.status !== '0x1') throw unavailable();
  const observation = { transactionHash: hash, blockNumber: rpcInteger(row.blockNumber), blockHash: normalizedHash(row.blockHash) };
  await onSeen?.();
  const [headRaw, canonicalRaw] = await Promise.all([rpc('eth_blockNumber', []), rpc('eth_getBlockByNumber', [ethereumHexQuantity(observation.blockNumber), false])]);
  if (canonicalRaw === null) return { status: 'pending', seen: true };
  const canonical = parseBlock(canonicalRaw);
  const head = rpcInteger(headRaw);
  if (canonical.hash !== observation.blockHash || canonical.number !== observation.blockNumber || head < observation.blockNumber) return { status: 'pending', seen: true };
  const evidence = { source: 'receipt' as const, observation, confirmations: head - observation.blockNumber + 1 };
  if (observation.blockNumber < deployment.deploymentBlock) return { status: 'not_unpack', ...evidence };
  if (row.status === '0x0') return { status: 'reverted', ...evidence };
  let crates: EthereumRevealCrate[];
  try { crates = confirmedCrates(row.logs.map(parseLog), deployment, observation); } catch { throw unavailable(); }
  if (!crates.length) return { status: 'not_unpack', ...evidence };
  return { status: 'confirmed', observation, crates, confirmations: head - observation.blockNumber + 1 };
}

export async function recoverRevealTokens(env: RevealChainEnvironment, deployment: RevealChainDeployment, tokenIds: string[],
  range: { fromBlock: number; toBlock?: number }, signal: AbortSignal, providerFetch: typeof fetch = fetch): Promise<EthereumRevealTokenRecovery> {
  if (!tokenIds.length || tokenIds.length > 100 || tokenIds.some(id => !/^[1-9][0-9]*$/.test(id) || BigInt(id) > BigInt(MAX_ARTWORKS)) ||
    new Set(tokenIds).size !== tokenIds.length || !Number.isSafeInteger(range.fromBlock) || range.fromBlock < deployment.deploymentBlock ||
    range.toBlock !== undefined && (!Number.isSafeInteger(range.toBlock) || range.toBlock < range.fromBlock)) {
    throw new EthereumApiError('invalid-argument', 'Invalid Ethereum reveal search.');
  }
  const rpc = createRpc(env, deployment, signal, providerFetch);
  await verifyChain(rpc, deployment);
  const observedBlock = parseBlock(await rpc('eth_getBlockByNumber', ['latest', false]));
  const stats = await rpc('eth_call', [{ to: deployment.contractAddress,
    data: encodeCall(ETHEREUM_FUNCTIONS.stats, ['address'], [ZERO]) }, { blockHash: observedBlock.hash, requireCanonical: true }]);
  if (typeof stats !== 'string' || !BYTES.test(stats)) throw unavailable();
  const mintedThrough = Number(decodeReturn(STATS_TYPES, stats)[2]);
  if (!Number.isSafeInteger(mintedThrough) || mintedThrough < 0 || mintedThrough > MAX_ARTWORKS) throw unavailable();
  const candidates = tokenIds.filter(id => Number(id) <= mintedThrough);
  const result: EthereumRevealTokenRecovery = { provenance: [], scannedRange: null, remainingRanges: [], mintedThrough, observedBlock };
  const toBlock = Math.min(range.toBlock ?? observedBlock.number, observedBlock.number);
  if (candidates.length && range.fromBlock <= toBlock) {
    let raw: unknown;
    try {
      raw = await rpc('eth_getLogs', [{ address: deployment.contractAddress,
        fromBlock: ethereumHexQuantity(range.fromBlock), toBlock: ethereumHexQuantity(toBlock),
        topics: [ETHEREUM_EVENT_TOPICS.Transfer, `0x${'0'.repeat(64)}`, null, candidates.map(id => ethereumHexQuantity(id).slice(2).padStart(64, '0')).map(id => `0x${id}`)] }]);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RevealRangeTooLarge) || range.fromBlock === toBlock) throw unavailable();
      const middle = Math.floor((range.fromBlock + toBlock) / 2);
      result.remainingRanges = [{ fromBlock: middle + 1, toBlock }, { fromBlock: range.fromBlock, toBlock: middle }];
    }
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length > candidates.length) throw unavailable();
      const expected = new Set(candidates);
      const seen = new Set<string>();
      const transactions = new Map<string, EthereumRevealObservation & { tokenIds: string[] }>();
      for (const value of raw) {
        const log = parseLog(value);
        const blockNumber = rpcInteger(log.blockNumber);
        if (log.address !== deployment.contractAddress || log.removed || log.topics.length !== 4 || log.data !== '0x' ||
          log.topics[0] !== ETHEREUM_EVENT_TOPICS.Transfer || BigInt(log.topics[1]) !== 0n ||
          BigInt(log.topics[2]) === 0n || blockNumber < range.fromBlock || blockNumber > toBlock) throw unavailable();
        const tokenId = String(BigInt(log.topics[3]));
        if (!expected.has(tokenId) || seen.has(tokenId)) throw unavailable();
        seen.add(tokenId);
        let transaction = transactions.get(log.transactionHash);
        if (transaction && (transaction.blockNumber !== blockNumber || transaction.blockHash !== log.blockHash)) throw unavailable();
        if (!transaction) {
          transaction = { transactionHash: log.transactionHash, blockNumber, blockHash: log.blockHash, tokenIds: [] };
          transactions.set(log.transactionHash, transaction);
        }
        transaction.tokenIds.push(tokenId);
      }
      result.provenance = [...transactions.values()];
      result.scannedRange = { fromBlock: range.fromBlock, toBlock };
    }
  }
  const canonical = parseBlock(await rpc('eth_getBlockByNumber', [ethereumHexQuantity(observedBlock.number), false]));
  if (canonical.hash !== observedBlock.hash) throw unavailable();
  return result;
}

export async function recoverRevealCrates(env: RevealChainEnvironment, deployment: RevealChainDeployment, crateTokenIds: string[],
  range: { fromBlock: number; toBlock?: number }, signal: AbortSignal, providerFetch: typeof fetch = fetch): Promise<EthereumRevealCrateRecovery> {
  if (!crateTokenIds.length || crateTokenIds.length > ETHEREUM_MAX_UNBOX_QUANTITY ||
    crateTokenIds.some(id => !/^[1-9][0-9]*$/.test(id) || BigInt(id) < BigInt(FIRST_CRATE) || BigInt(id) > BigInt(LAST_CRATE)) ||
    new Set(crateTokenIds).size !== crateTokenIds.length || !Number.isSafeInteger(range.fromBlock) || range.fromBlock < deployment.deploymentBlock ||
    range.toBlock !== undefined && (!Number.isSafeInteger(range.toBlock) || range.toBlock < range.fromBlock)) {
    throw new EthereumApiError('invalid-argument', 'Invalid Ethereum crate search.');
  }
  const rpc = createRpc(env, deployment, signal, providerFetch);
  await verifyChain(rpc, deployment);
  const observedBlock = parseBlock(await rpc('eth_getBlockByNumber', ['latest', false]));
  const result: EthereumRevealCrateRecovery = { provenance: [], scannedRange: null, remainingRanges: [], observedBlock };
  const toBlock = Math.min(range.toBlock ?? observedBlock.number, observedBlock.number);
  if (range.fromBlock <= toBlock) {
    let raw: unknown;
    try {
      raw = await rpc('eth_getLogs', [{ address: deployment.contractAddress,
        fromBlock: ethereumHexQuantity(range.fromBlock), toBlock: ethereumHexQuantity(toBlock),
        topics: [ETHEREUM_EVENT_TOPICS.CrateUnboxed, crateTokenIds.map(id => `0x${BigInt(id).toString(16).padStart(64, '0')}`)] }]);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RevealRangeTooLarge) || range.fromBlock === toBlock) throw unavailable();
      const middle = Math.floor((range.fromBlock + toBlock) / 2);
      result.remainingRanges = [{ fromBlock: middle + 1, toBlock }, { fromBlock: range.fromBlock, toBlock: middle }];
    }
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length > crateTokenIds.length) throw unavailable();
      const expected = new Set(crateTokenIds);
      const seen = new Set<string>();
      const transactions = new Map<string, EthereumRevealObservation & { crateTokenIds: string[] }>();
      for (const value of raw) {
        const log = parseLog(value);
        const blockNumber = rpcInteger(log.blockNumber);
        if (log.address !== deployment.contractAddress || log.removed || blockNumber < range.fromBlock || blockNumber > toBlock ||
          log.topics[0] !== ETHEREUM_EVENT_TOPICS.CrateUnboxed) throw unavailable();
        const [event] = decodeEventLogs([log], deployment.contractAddress);
        if (event?.name !== 'CrateUnboxed' || !expected.has(event.crateTokenId) || seen.has(event.crateTokenId) ||
          event.owner === ZERO || event.count !== (Number(event.crateTokenId) === LAST_CRATE ? 31 : 20) ||
          event.firstArtToken < 1 || event.firstArtToken + event.count - 1 > MAX_ARTWORKS) throw unavailable();
        seen.add(event.crateTokenId);
        let transaction = transactions.get(log.transactionHash);
        if (transaction && (transaction.blockNumber !== blockNumber || transaction.blockHash !== log.blockHash)) throw unavailable();
        if (!transaction) {
          transaction = { transactionHash: log.transactionHash, blockNumber, blockHash: log.blockHash, crateTokenIds: [] };
          transactions.set(log.transactionHash, transaction);
        }
        transaction.crateTokenIds.push(event.crateTokenId);
      }
      result.provenance = [...transactions.values()];
      result.scannedRange = { fromBlock: range.fromBlock, toBlock };
    }
  }
  const canonical = parseBlock(await rpc('eth_getBlockByNumber', [ethereumHexQuantity(observedBlock.number), false]));
  if (canonical.hash !== observedBlock.hash) throw unavailable();
  return result;
}
