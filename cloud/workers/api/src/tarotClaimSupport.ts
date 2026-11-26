import { decodeReturn, encodeAbi, encodeCall } from '../../../../shared/ethereum/abi.js';
import { ethereumSignerAddress, signDigest } from '../../../../shared/ethereum/crypto.js';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.js';
import { DMX_MAX_CARDS } from '../../../../shared/ethereum/dmx.js';
import {
  TAROT_AUTHORIZATION_TTL_SECONDS, TAROT_MAX_CARDS, TAROT_RECEIPT_OFFSET,
  encodeTarotClaim, encodeTarotClaimTo, resolveTarotConfig, tarotCodeHashInput, tarotReceiptTokenId,
  type TarotConfig, type TarotConfirmResponse, type TarotPrepareResponse,
} from '../../../../shared/ethereum/tarot.js';
import { TAROT_CLAIMED_TOPIC, tarotClaimDigest } from '../../../../shared/ethereum/tarotCrypto.js';
import { EthereumApiError } from './ethereumError.js';
import type { EthereumProviderEnvironment } from './ethereumProvider.js';
import {
  ethereumAddress, ethereumCallBatch, ethereumRpc, rpcInteger,
  verifyEthereumBlockSnapshot, type EthereumReadContext,
} from './ethereumRuntime.js';
import { matchesSha256Hex } from './sessionSecrets.js';
import type { TarotClaimRelayerNamespace } from './tarotClaimRelayer.js';

export type TarotEnvironment = Pick<Env,
  'OPS_DB' | 'ALCHEMY_MI_NOTE_API_KEY' | 'ETHEREUM_111K_RPC_URL' |
  'ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS' | 'ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK' | 'ETHEREUM_TAROT_SEPOLIA_ENABLED' |
  'TAROT_ACCESS_IP_RATE_LIMITER' | 'TAROT_PREPARE_RATE_LIMITER' | 'TAROT_CONFIRM_IP_RATE_LIMITER'
> & EthereumProviderEnvironment & Partial<Pick<Env, 'ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET' |
  'ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS' | 'ETHEREUM_TAROT_MAINNET_DEPLOYMENT_BLOCK' | 'ETHEREUM_TAROT_MAINNET_ENABLED' |
  'ETHEREUM_TAROT_MAINNET_SIGNER_SECRET' | 'ETHEREUM_TAROT_MAINNET_RELAYER_SECRET' | 'ETHEREUM_TAROT_SEPOLIA_RELAYER_SECRET' |
  'ETHEREUM_TAROT_MAINNET_SPONSORSHIP_ENABLED' | 'ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED' |
  'ETHEREUM_TAROT_MAINNET_MAX_CLAIM_FEE_WEI' | 'ETHEREUM_TAROT_SEPOLIA_MAX_CLAIM_FEE_WEI'>> &
  { TAROT_CLAIM_RELAYER?: TarotClaimRelayerNamespace };

export type TarotContext = EthereumReadContext & { env: TarotEnvironment; config: TarotConfig; nowMs: number };
type State = { blockNumber: number; blockHash: string; timestamp: number; signer: string; claimed: boolean; mintingPaused: boolean };
type CodeRow = { code_hash: string; revoked_at_ms: number | null };
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO_WORD = `0x${'0'.repeat(64)}`;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function unavailable(): never {
  throw new EthereumApiError('unavailable', 'Tarot Cards are temporarily unavailable.');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}

function readContext(context: TarotContext): EthereumReadContext {
  return { ...context, config: { ...context.config, enabled: !!context.config.contractAddress } };
}

export function tarotSigner(context: TarotContext): { secret: string; address: string } | null {
  const secret = (context.config.testnet
    ? context.env.ETHEREUM_TAROT_SEPOLIA_SIGNER_SECRET : context.env.ETHEREUM_TAROT_MAINNET_SIGNER_SECRET)?.trim();
  if (!secret) return null;
  try { return { secret, address: ethereumSignerAddress(secret) }; } catch { return null; }
}

async function codeRow(context: TarotContext, tokenId: number): Promise<CodeRow | null> {
  const contractAddress = context.config.contractAddress;
  if (!contractAddress) return unavailable();
  let row: CodeRow | null;
  if (context.config.testnet) {
    const retired = await context.env.OPS_DB.prepare(`SELECT 1 FROM dmx_retired_sepolia_deployments
      WHERE chain_id = ? AND contract_address = ?`)
      .bind(context.config.chainId, contractAddress).first();
    if (retired) return unavailable();
    row = await context.env.OPS_DB.prepare(`SELECT code_hash, revoked_at_ms FROM tarot_claim_codes
      WHERE chain_id = ? AND contract_address = ? AND token_id = ?`)
      .bind(context.config.chainId, contractAddress, tokenId).first<CodeRow>();
  } else {
    const batch = await context.env.OPS_DB.prepare(`SELECT batch_id,chain_id,status,contract_address,credential_count,
      verified_at_ms,bound_at_ms FROM dmx_mainnet_claim_batches WHERE collection_key = ?`)
      .bind('dmx-mainnet-v1').first<Record<string, unknown>>();
    if (!batch || batch.chain_id !== 1 || batch.status !== 'bound' || batch.contract_address !== contractAddress ||
      batch.credential_count !== TAROT_MAX_CARDS || typeof batch.batch_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(batch.batch_id) ||
      !Number.isSafeInteger(batch.verified_at_ms) || Number(batch.verified_at_ms) < 0 ||
      !Number.isSafeInteger(batch.bound_at_ms) || Number(batch.bound_at_ms) < Number(batch.verified_at_ms)) return unavailable();
    row = await context.env.OPS_DB.prepare(`SELECT code_hash, revoked_at_ms FROM dmx_mainnet_bound_claim_codes
      WHERE batch_id = ? AND chain_id = ? AND contract_address = ? AND token_id = ?`)
      .bind(batch.batch_id, context.config.chainId, contractAddress, tokenId).first<CodeRow>();
  }
  return row;
}

export async function requireTarotCode(context: TarotContext, tokenId: number, code: string): Promise<string> {
  const row = await codeRow(context, tokenId);
  const matches = await matchesSha256Hex(tarotCodeHashInput({ chainId: context.config.chainId,
    contractAddress: context.config.contractAddress!, tokenId, code }), row?.code_hash ?? '0'.repeat(64));
  if (!row || row.revoked_at_ms !== null || !matches) {
    throw new EthereumApiError('unauthenticated', 'This Tarot Cards link is invalid.');
  }
  context.signal.throwIfAborted();
  return row.code_hash;
}

export async function requireTarotCodeHash(context: TarotContext, tokenId: number, codeHash: string): Promise<void> {
  const row = await codeRow(context, tokenId);
  if (!row || row.revoked_at_ms !== null || !/^[0-9a-f]{64}$/.test(codeHash) || row.code_hash !== codeHash) {
    throw new EthereumApiError('unauthenticated', 'This Tarot Cards link is invalid.');
  }
  context.signal.throwIfAborted();
}

export async function tarotState(context: TarotContext, tokenId: number, confirmed = false): Promise<State> {
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

export async function createTarotAuthorization(context: TarotContext, tokenId: number, wallet: string): Promise<TarotPrepareResponse> {
  if (!context.config.enabled || !context.config.contractAddress) return unavailable();
  const signer = tarotSigner(context);
  if (!signer) return unavailable();
  const current = await tarotState(context, tokenId);
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

function requireClaimInput(input: unknown, tokenId: number, wallet: string): void {
  try {
    if (typeof input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input)) throw new Error();
    const claimTo = input.slice(0, 10).toLowerCase() === encodeCall('claimTo(address,uint256,uint256,bytes)', [], []);
    const args = decodeReturn(claimTo ? ['address', 'uint256', 'uint256', 'bytes'] : ['uint256', 'uint256', 'bytes'],
      `0x${input.slice(10)}`);
    if (claimTo && args.shift() !== wallet) throw new Error();
    const [card, deadline, signature] = args;
    if (card !== BigInt(tokenId) || typeof deadline !== 'bigint' || deadline < 0n || deadline > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error();
    const canonical = claimTo ? encodeTarotClaimTo(wallet, tokenId, Number(deadline), signature)
      : encodeTarotClaim(tokenId, Number(deadline), signature);
    if (canonical.toLowerCase() !== input.toLowerCase()) throw new Error();
  } catch { throw new EthereumApiError('invalid-argument', 'This transaction does not match the Tarot Card.'); }
}

function requireClaimLogs(context: TarotContext, logs: unknown[], wallet: string, tokenId: number,
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

export async function confirmTarotClaim(context: TarotContext, tokenId: number, wallet: string, transactionHash: string,
  expectedRelayer?: { sender: string; data: string }): Promise<TarotConfirmResponse> {
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
  const relayed = expectedRelayer !== undefined && sender === expectedRelayer.sender &&
    recipient === context.config.contractAddress && transaction.input === expectedRelayer.data;
  if (expectedRelayer && !relayed) {
    throw new EthereumApiError('invalid-argument', 'This transaction does not match the backend claim.');
  }
  const direct = (sender === wallet || relayed) && recipient === context.config.contractAddress;
  if (direct) {
    requireClaimInput(transaction.input, tokenId, wallet);
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

export function tarotConfig(env: TarotEnvironment, testnet: boolean): TarotConfig {
  return resolveTarotConfig({ testnet,
    contractAddress: testnet ? env.ETHEREUM_TAROT_SEPOLIA_CONTRACT_ADDRESS : env.ETHEREUM_TAROT_MAINNET_CONTRACT_ADDRESS,
    deploymentBlock: testnet ? env.ETHEREUM_TAROT_SEPOLIA_DEPLOYMENT_BLOCK : env.ETHEREUM_TAROT_MAINNET_DEPLOYMENT_BLOCK,
    enabled: (testnet ? env.ETHEREUM_TAROT_SEPOLIA_ENABLED : env.ETHEREUM_TAROT_MAINNET_ENABLED) === 'true' });
}
