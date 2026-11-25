import { isIP } from 'node:net';
import { z } from 'zod';
import { decodeReturn, encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.js';
import { ethereumSignerAddress, signDigest } from '../../../../shared/ethereum/crypto.js';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.js';
import { DMX_MAX_CARDS } from '../../../../shared/ethereum/dmx.js';
import {
  TAROT_API_PATHS, TAROT_AUTHORIZATION_TTL_SECONDS, TAROT_MAX_CARDS, TAROT_RECEIPT_OFFSET,
  encodeTarotClaim, resolveTarotConfig, tarotCodeHashInput, tarotReceiptTokenId,
  type TarotConfig, type TarotConfirmResponse, type TarotPrepareResponse, type TarotStatus,
} from '../../../../shared/ethereum/tarot.js';
import { TAROT_CLAIMED_TOPIC, tarotClaimDigest } from '../../../../shared/ethereum/tarotCrypto.js';
import { ethereumRequestOrigin } from './ethereumAuth.js';
import { EthereumApiError, ethereumErrorResponse, readEthereumBody } from './ethereumError.js';
import { ethereumProviderApiError, RpcProviderError, type EthereumProviderEnvironment } from './ethereumProvider.js';
import { ProviderBudgetUnavailable } from './ethereumProviderBudget.js';
import {
  ethereumAddress, ethereumCallBatch, ethereumRpc, ethereumTransactionHash, rpcInteger,
  verifyEthereumBlockSnapshot, type EthereumReadContext,
} from './ethereumRuntime.js';
import { jsonResponse } from './httpResponse.js';
import { matchesSha256Hex, sha256Hex } from './sessionSecrets.js';

export type TarotEnvironment = Pick<Env,
  'OPS_DB' | 'ALCHEMY_MI_NOTE_API_KEY' | 'ETHEREUM_111K_RPC_URL' |
  'ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS' | 'ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK' | 'ETHEREUM_TAROT_SEPOLIA_ENABLED' |
  'TAROT_ACCESS_IP_RATE_LIMITER' | 'TAROT_PREPARE_RATE_LIMITER' | 'TAROT_CONFIRM_IP_RATE_LIMITER'
> & EthereumProviderEnvironment & Partial<Pick<Env, 'ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET'>>;

type Context = EthereumReadContext & { env: TarotEnvironment; config: TarotConfig; nowMs: number };
type State = { blockNumber: number; blockHash: string; timestamp: number; signer: string; claimed: boolean; mintingPaused: boolean };
type CodeRow = { code_hash: string; revoked_at_ms: number | null };
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const requestSchema = z.object({
  tokenId: z.number().int().min(1).max(TAROT_MAX_CARDS), testnet: z.literal(true),
  code: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
}).strict();

function unavailable(): never {
  throw new EthereumApiError('unavailable', 'Tarot Cards are temporarily unavailable.');
}

async function limitTarotRequest(request: Request, signal: AbortSignal, operation: 'access' | 'confirm', limiter: RateLimit): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !isIP(ip)) return unavailable();
  const key = await sha256Hex(`tarot:${operation}:${ip.toLowerCase()}`);
  if (!(await limiter.limit({ key })).success) throw new EthereumApiError('resource-exhausted', 'Too many requests. Try again later.');
  signal.throwIfAborted();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}

function readContext(context: Context): EthereumReadContext {
  return { ...context, config: { ...context.config, enabled: !!context.config.contractAddress } };
}

function configuredSigner(context: Context): { secret: string; address: string } | null {
  const secret = context.env.ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET?.trim();
  if (!secret) return null;
  try { return { secret, address: ethereumSignerAddress(secret) }; } catch { return null; }
}

async function requireCode(context: Context, tokenId: number, code: string): Promise<void> {
  const contractAddress = context.config.contractAddress;
  if (!contractAddress) return unavailable();
  const row = await context.env.OPS_DB.prepare(`SELECT code_hash, revoked_at_ms FROM tarot_claim_codes
    WHERE chain_id = ? AND contract_address = ? AND token_id = ?`)
    .bind(context.config.chainId, contractAddress, tokenId).first<CodeRow>();
  const matches = await matchesSha256Hex(tarotCodeHashInput({ chainId: context.config.chainId, contractAddress, tokenId, code }),
    row?.code_hash ?? '0'.repeat(64));
  if (!row || row.revoked_at_ms !== null || !matches) {
    throw new EthereumApiError('unauthenticated', 'This Tarot Cards link is invalid.');
  }
  context.signal.throwIfAborted();
}

async function state(context: Context, tokenId: number, confirmed = false): Promise<State> {
  const read = readContext(context);
  const head = object(await ethereumRpc(read, 'eth_getBlockByNumber', ['latest', false]));
  const target = rpcInteger(head.number) - (confirmed ? context.config.confirmationBlocks - 1 : 0);
  if (target < context.config.deploymentBlock) return unavailable();
  const block = confirmed ? object(await ethereumRpc(read, 'eth_getBlockByNumber', [ethereumHexQuantity(target), false])) : head;
  const blockNumber = rpcInteger(block.number);
  const timestamp = rpcInteger(block.timestamp);
  if (typeof block.hash !== 'string' || !HASH.test(block.hash) || blockNumber !== target) return unavailable();
  const snapshot = { blockNumber, blockHash: block.hash.toLowerCase() };
  const results = await ethereumCallBatch(read, [
    encodeCall('MAX_CARDS()', [], []), encodeCall('RECEIPT_OFFSET()', [], []),
    encodeCall('MAX_AUTHORIZATION_LIFETIME()', [], []), encodeCall('quoteSigner()', [], []),
    encodeCall('claimed(uint256)', ['uint256'], [tokenId]),
    encodeCall('INITIAL_CARDS()', [], []), encodeCall('mintingPaused()', [], []),
  ], snapshot.blockHash);
  if (results.some(result => result.length !== 66)) return unavailable();
  const [maximum] = decodeReturn(['uint256'], results[0]);
  const [offset] = decodeReturn(['uint256'], results[1]);
  const [lifetime] = decodeReturn(['uint256'], results[2]);
  const [signer] = decodeReturn(['address'], results[3]);
  const [claimed] = decodeReturn(['uint256'], results[4]);
  const [initial] = decodeReturn(['uint256'], results[5]);
  const [mintingPaused] = decodeReturn(['uint256'], results[6]);
  if (maximum !== BigInt(DMX_MAX_CARDS) || initial !== BigInt(TAROT_MAX_CARDS) || offset !== BigInt(TAROT_RECEIPT_OFFSET) ||
    lifetime !== BigInt(TAROT_AUTHORIZATION_TTL_SECONDS) || typeof signer !== 'string' || signer === ZERO_ADDRESS ||
    (claimed !== 0n && claimed !== 1n) || (mintingPaused !== 0n && mintingPaused !== 1n)) return unavailable();
  await verifyEthereumBlockSnapshot(read, snapshot);
  return { ...snapshot, timestamp, signer, claimed: claimed === 1n, mintingPaused: mintingPaused === 1n };
}

async function status(context: Context, tokenId: number): Promise<TarotStatus> {
  const current = await state(context, tokenId, true);
  const signer = configuredSigner(context);
  return { config: { ...context.config, enabled: context.config.enabled && !current.mintingPaused && signer?.address === current.signer },
    tokenId, receiptTokenId: tarotReceiptTokenId(tokenId), claimed: current.claimed,
    observedBlock: current.blockNumber, observedTimestamp: current.timestamp, blockHash: current.blockHash };
}

async function prepare(context: Context, tokenId: number, wallet: string): Promise<TarotPrepareResponse> {
  const key = await sha256Hex(`tarot:prepare:${context.config.chainId}:${context.config.contractAddress}:${tokenId}:${wallet}`);
  if (!(await context.env.TAROT_PREPARE_RATE_LIMITER.limit({ key })).success) {
    throw new EthereumApiError('resource-exhausted', 'Too many requests. Try again later.');
  }
  if (!context.config.enabled || !context.config.contractAddress) return unavailable();
  const signer = configuredSigner(context);
  if (!signer) return unavailable();
  const current = await state(context, tokenId);
  if (signer.address !== current.signer || current.mintingPaused) return unavailable();
  if (current.claimed) throw new EthereumApiError('failed-precondition', 'This Tarot Card has already been claimed.');
  const now = Math.floor(context.nowMs / 1000);
  const deadline = Math.min(now, current.timestamp) + TAROT_AUTHORIZATION_TTL_SECONDS;
  if (deadline <= now || deadline <= current.timestamp) return unavailable();
  const signature = signDigest(signer.secret, tarotClaimDigest({ chainId: context.config.chainId,
    contractAddress: context.config.contractAddress, wallet, tokenId, deadline }));
  context.signal.throwIfAborted();
  return { tokenId, receiptTokenId: tarotReceiptTokenId(tokenId), wallet, deadline, expiresAtMs: deadline * 1000, signature,
    transaction: { to: context.config.contractAddress, chainId: context.config.chainId,
      value: '0x0', data: encodeTarotClaim(tokenId, deadline, signature) } };
}

function requireClaimInput(input: unknown, tokenId: number): void {
  try {
    if (typeof input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input)) throw new Error();
    const [card, deadline, signature] = decodeReturn(['uint256', 'uint256', 'bytes'], `0x${input.slice(10)}`);
    if (card !== BigInt(tokenId) || typeof deadline !== 'bigint' || deadline < 0n || deadline > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
      encodeTarotClaim(tokenId, Number(deadline), signature).toLowerCase() !== input.toLowerCase()) throw new Error();
  } catch { throw new EthereumApiError('invalid-argument', 'This transaction does not match the Tarot Card.'); }
}

function requireClaimLogs(context: Context, logs: unknown[], wallet: string, tokenId: number,
  transactionHash: string, blockNumber: number, blockHash: string): void {
  const expectedWallet = encodeAbi(['address'], [wallet]);
  const expectedCard = encodeAbi(['uint256'], [tokenId]);
  const expectedReceipt = encodeAbi(['uint256'], [tarotReceiptTokenId(tokenId)]);
  let claims = 0;
  const mints: string[] = [];
  for (const value of logs) {
    const log = object(value);
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== context.config.contractAddress) continue;
    if (!Array.isArray(log.topics) || !log.topics.length || log.topics.some(topic => typeof topic !== 'string' || !HASH.test(topic))) return unavailable();
    const topics = (log.topics as string[]).map(topic => topic.toLowerCase());
    if (topics[0] !== TAROT_CLAIMED_TOPIC && topics[0] !== TRANSFER_TOPIC) continue;
    if (topics.length !== 4 || log.data !== '0x' || log.removed === true ||
      typeof log.blockHash !== 'string' || log.blockHash.toLowerCase() !== blockHash ||
      typeof log.transactionHash !== 'string' || log.transactionHash.toLowerCase() !== transactionHash ||
      rpcInteger(log.blockNumber) !== blockNumber) return unavailable();
    if (topics[0] === TAROT_CLAIMED_TOPIC && topics[1] === expectedWallet && topics[2] === expectedCard && topics[3] === expectedReceipt) claims++;
    if (topics[0] === TRANSFER_TOPIC && topics[1] === ZERO_WORD && topics[2] === expectedWallet &&
      (topics[3] === expectedCard || topics[3] === expectedReceipt)) mints.push(topics[3]);
  }
  if (claims !== 1 || mints.length !== 2 || !mints.includes(expectedCard) || !mints.includes(expectedReceipt)) {
    throw new EthereumApiError('invalid-argument', 'This transaction does not contain the Tarot Card and receipt claim.');
  }
}

async function confirm(context: Context, tokenId: number, wallet: string, transactionHash: string): Promise<TarotConfirmResponse> {
  const read = readContext(context);
  const result = (status: TarotConfirmResponse['status'], confirmations = 0,
    block: { blockNumber: number; blockHash: string } | null = null): TarotConfirmResponse =>
    ({ status, confirmations, transactionHash, tokenId, receiptTokenId: tarotReceiptTokenId(tokenId),
      blockNumber: block?.blockNumber ?? null, blockHash: block?.blockHash ?? null });
  const raw = await ethereumRpc(read, 'eth_getTransactionReceipt', [transactionHash]);
  if (raw === null) return result('pending');
  const receipt = object(raw);
  if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== transactionHash ||
    typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash) || !Array.isArray(receipt.logs) ||
    (receipt.status !== '0x0' && receipt.status !== '0x1')) return unavailable();
  const sender = ethereumAddress(receipt.from);
  const recipient = ethereumAddress(receipt.to);
  const blockNumber = rpcInteger(receipt.blockNumber);
  const blockHash = receipt.blockHash.toLowerCase();
  if (blockNumber < context.config.deploymentBlock) return unavailable();
  const [transactionRaw, headRaw, canonicalRaw] = await Promise.all([
    ethereumRpc(read, 'eth_getTransactionByHash', [transactionHash]), ethereumRpc(read, 'eth_blockNumber', []),
    ethereumRpc(read, 'eth_getBlockByNumber', [ethereumHexQuantity(blockNumber), false]),
  ]);
  const canonical = object(canonicalRaw);
  if (typeof canonical.hash !== 'string' || canonical.hash.toLowerCase() !== blockHash) return result('pending');
  const transaction = object(transactionRaw);
  if (ethereumAddress(transaction.from) !== sender || ethereumAddress(transaction.to) !== recipient ||
    typeof transaction.hash !== 'string' || transaction.hash.toLowerCase() !== transactionHash ||
    typeof transaction.blockHash !== 'string' || transaction.blockHash.toLowerCase() !== blockHash ||
    rpcInteger(transaction.blockNumber) !== blockNumber ||
    transaction.chainId !== undefined && rpcInteger(transaction.chainId) !== context.config.chainId) return unavailable();
  const direct = sender === wallet && recipient === context.config.contractAddress;
  if (direct) {
    requireClaimInput(transaction.input, tokenId);
    if (rpcInteger(transaction.value) !== 0) throw new EthereumApiError('invalid-argument', 'Tarot Card claims must be free.');
  } else if (receipt.status === '0x0') {
    throw new EthereumApiError('invalid-argument', 'This failed transaction does not identify the Tarot Card claim.');
  }
  if (receipt.status === '0x1') requireClaimLogs(context, receipt.logs, wallet, tokenId, transactionHash, blockNumber, blockHash);
  await verifyEthereumBlockSnapshot(read, { blockNumber, blockHash });
  const confirmations = Math.max(0, rpcInteger(headRaw) - blockNumber + 1);
  return result(confirmations < context.config.confirmationBlocks ? 'pending' : receipt.status === '0x1' ? 'confirmed' : 'failed',
    confirmations, { blockNumber, blockHash });
}

export async function handleTarotRequest(request: Request, env: TarotEnvironment, path: string, dependencies: {
  nowMs?: () => number; fetch?: typeof fetch;
} = {}): Promise<Response> {
  try {
    if (!Object.values(TAROT_API_PATHS).some(value => value === path)) throw new EthereumApiError('not-found', 'Unknown Tarot Cards request.');
    if (request.method !== 'POST') return jsonResponse({ ok: false, error: { code: 'invalid-argument', message: 'Method not allowed.' } }, 405,
      { headers: { Allow: 'POST, OPTIONS' } });
    ethereumRequestOrigin(request);
    if (request.headers.get('X-Mons-CSRF') !== '1') throw new EthereumApiError('permission-denied', 'Invalid Tarot Cards request.');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const confirmation = path === TAROT_API_PATHS.confirm;
    await limitTarotRequest(request, signal, confirmation ? 'confirm' : 'access',
      confirmation ? env.TAROT_CONFIRM_IP_RATE_LIMITER : env.TAROT_ACCESS_IP_RATE_LIMITER);
    const schema = path === TAROT_API_PATHS.status ? requestSchema : confirmation
      ? requestSchema.extend({ wallet: z.string(), transactionHash: z.string() }).strict()
      : requestSchema.extend({ wallet: z.string() }).strict();
    const body = await readEthereumBody(request, signal, schema);
    const wallet = 'wallet' in body ? ethereumAddress(body.wallet) : null;
    const config = resolveTarotConfig({ contractAddress: env.ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS,
      deploymentBlock: env.ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK, enabled: env.ETHEREUM_TAROT_SEPOLIA_ENABLED === 'true' });
    const context: Context = { env, config, signal, nowMs: (dependencies.nowMs || Date.now)(),
      fetch: dependencies.fetch || ((input, init) => fetch(input, init)) };
    await requireCode(context, body.tokenId, body.code);
    const response = path === TAROT_API_PATHS.status ? await status(context, body.tokenId) : confirmation
      ? await confirm(context, body.tokenId, wallet!, ethereumTransactionHash('transactionHash' in body ? body.transactionHash : undefined))
      : await prepare(context, body.tokenId, wallet!);
    return jsonResponse(response, 200);
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    if (error instanceof RpcProviderError || error instanceof ProviderBudgetUnavailable) return ethereumErrorResponse(ethereumProviderApiError(error));
    if (!(error instanceof EthereumApiError)) console.error({ event: 'tarot_request_failed', path,
      errorName: error instanceof Error ? error.name : 'UnknownError' });
    return ethereumErrorResponse(error);
  }
}
