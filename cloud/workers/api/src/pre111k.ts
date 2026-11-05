import { z } from 'zod';
import { decodeReturn, encodeCall } from '../../../../shared/ethereum/abi.js';
import { ethereumSignerAddress, signDigest } from '../../../../shared/ethereum/crypto.js';
import {
  PRE111K_API_PATHS, PRE111K_AUTHORIZATION_TTL_SECONDS, PRE111K_MAX_RELICS,
  encodePre111kReservation, resolvePre111kConfig, resolvePre111kDeployment, type Pre111kAccessResponse, type Pre111kConfig,
  type Pre111kConfirmResponse, type Pre111kDeployment, type Pre111kNetwork, type Pre111kPrepareResponse, type Pre111kStatus,
} from '../../../../shared/ethereum/pre111k.js';
import { PRE111K_RESERVED_TOPIC, pre111kReservationDigest } from '../../../../shared/ethereum/pre111kCrypto.js';
import { ethereumHexQuantity } from '../../../../shared/ethereum/protocol.js';
import { ethereumRequestOrigin, limitEthereumRequest } from './ethereumAuth.js';
import { EthereumApiError, ethereumErrorResponse, readEthereumBody } from './ethereumError.js';
import {
  ethereumAddress, ethereumCallBatch, ethereumRpc, ethereumTransactionHash, rpcInteger,
  verifyEthereumBlockSnapshot, type EthereumReadContext,
} from './ethereumRuntime.js';
import { jsonResponse } from './httpResponse.js';
import { matchesSha256Hex, sha256Hex } from './sessionSecrets.js';

export type Pre111kEnvironment = Pick<Env,
  'ALCHEMY_MI_NOTE_API_KEY' | 'ETHEREUM_111K_RPC_URL' | 'PUBLIC_SHOP_RATE_LIMITER' | 'PREORDER_PREPARE_RATE_LIMITER' | 'PREORDER_PREPARE_IP_RATE_LIMITER' |
  'ETHEREUM_PRE111K_MAINNET_CONTRACT_ADDRESS' | 'ETHEREUM_PRE111K_MAINNET_DEPLOYMENT_BLOCK' | 'ETHEREUM_PRE111K_MAINNET_ENABLED' |
  'ETHEREUM_PRE111K_MAINNET_PRICE_WEI' | 'ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI' |
  'ETHEREUM_PRE111K_SEPOLIA_CONTRACT_ADDRESS' | 'ETHEREUM_PRE111K_SEPOLIA_DEPLOYMENT_BLOCK' | 'ETHEREUM_PRE111K_SEPOLIA_ENABLED'
> & Partial<Pick<Env, 'ETHEREUM_PRE111K_MAINNET_SIGNER_SECRET' | 'ETHEREUM_PRE111K_SEPOLIA_SIGNER_SECRET' | 'ETHEREUM_PRE111K_ACCESS_CODES'>>;

type DeploymentContext = EthereumReadContext & { config: Pre111kDeployment };
type Context = DeploymentContext & { env: Pre111kEnvironment; config: Pre111kConfig; nowMs: number };
type State = { blockNumber: number; blockHash: string; timestamp: number; totalReserved: number; reservedRelics: number; signer: string };
const networkSchema = z.enum(['mainnet', 'devnet']);
const requestSchema = z.object({ network: networkSchema, wallet: z.string() }).strict();
const accessSchema = z.object({ code: z.unknown().optional() }).strict();
const accessCodesSchema = z.array(z.string().trim().toUpperCase().min(1).max(64)).min(1).max(32);
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const HASH = /^0x[0-9a-fA-F]{64}$/;

function deploymentSettings(env: Pre111kEnvironment, network: Pre111kNetwork) {
  const mainnet = network === 'mainnet';
  return {
    contractAddress: mainnet ? env.ETHEREUM_PRE111K_MAINNET_CONTRACT_ADDRESS : env.ETHEREUM_PRE111K_SEPOLIA_CONTRACT_ADDRESS,
    deploymentBlock: mainnet ? env.ETHEREUM_PRE111K_MAINNET_DEPLOYMENT_BLOCK : env.ETHEREUM_PRE111K_SEPOLIA_DEPLOYMENT_BLOCK,
    enabled: (mainnet ? env.ETHEREUM_PRE111K_MAINNET_ENABLED : env.ETHEREUM_PRE111K_SEPOLIA_ENABLED) === 'true',
  };
}

function readContext(context: DeploymentContext): EthereumReadContext {
  return { ...context, config: { ...context.config, enabled: !!context.config.contractAddress } };
}

function configuredSigner(context: Context): { secret: string; address: string } | null {
  const secret = (context.config.network === 'mainnet'
    ? context.env.ETHEREUM_PRE111K_MAINNET_SIGNER_SECRET : context.env.ETHEREUM_PRE111K_SEPOLIA_SIGNER_SECRET)?.trim();
  if (!secret) return null;
  try { return { secret, address: ethereumSignerAddress(secret) }; } catch { return null; }
}

function unavailable(): never {
  throw new EthereumApiError('unavailable', 'Relic reservations are temporarily unavailable.');
}

async function requireAccessCode(env: Pre111kEnvironment, value: unknown): Promise<void> {
  let configured: unknown;
  try { configured = JSON.parse(env.ETHEREUM_PRE111K_ACCESS_CODES || ''); } catch { return unavailable(); }
  const codes = accessCodesSchema.safeParse(configured);
  if (!codes.success) return unavailable();
  if (typeof value !== 'string' || value.length > 64 || !value.trim()) {
    throw new EthereumApiError('unauthenticated', 'Enter a valid secret code.');
  }
  const code = value.trim().toUpperCase();
  const matches = await Promise.all(codes.data.map(async expected => matchesSha256Hex(code, await sha256Hex(expected))));
  if (!matches.some(Boolean)) throw new EthereumApiError('unauthenticated', 'Enter a valid secret code.');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}

function smallInteger(value: unknown, maximum: number): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(maximum)) return unavailable();
  return Number(value);
}

async function state(context: Context, wallet: string | null): Promise<State> {
  const read = readContext(context);
  const block = object(await ethereumRpc(read, 'eth_getBlockByNumber', ['latest', false]));
  const blockNumber = rpcInteger(block.number);
  const timestamp = rpcInteger(block.timestamp);
  if (typeof block.hash !== 'string' || !HASH.test(block.hash) || blockNumber < context.config.deploymentBlock) return unavailable();
  const snapshot = { blockNumber, blockHash: block.hash.toLowerCase() };
  const results = await ethereumCallBatch(read, [
    encodeCall('treasury()', [], []), encodeCall('MAX_RELICS()', [], []),
    encodeCall('MAX_AUTHORIZATION_LIFETIME()', [], []), encodeCall('quoteSigner()', [], []),
    encodeCall('totalReserved()', [], []), encodeCall('reservedRelics(address)', ['address'], [wallet || ZERO_ADDRESS]),
  ], ethereumHexQuantity(blockNumber));
  if (results.some(result => result.length !== 66)) return unavailable();
  const [treasury] = decodeReturn(['address'], results[0]);
  const [maximum] = decodeReturn(['uint256'], results[1]);
  const [lifetime] = decodeReturn(['uint256'], results[2]);
  const [signer] = decodeReturn(['address'], results[3]);
  const totalReserved = smallInteger(decodeReturn(['uint256'], results[4])[0], PRE111K_MAX_RELICS);
  const reservedRelics = smallInteger(decodeReturn(['uint256'], results[5])[0], totalReserved);
  if (treasury !== context.config.treasury || maximum !== BigInt(PRE111K_MAX_RELICS) ||
    lifetime !== BigInt(PRE111K_AUTHORIZATION_TTL_SECONDS) || typeof signer !== 'string' || signer === ZERO_ADDRESS) return unavailable();
  await verifyEthereumBlockSnapshot(read, snapshot);
  return { ...snapshot, timestamp, totalReserved, reservedRelics, signer };
}

async function status(context: Context, wallet: string | null): Promise<Pre111kStatus> {
  if (!context.config.contractAddress) return { config: context.config, wallet, totalReserved: null,
    reservedRelics: null, remainingRelics: null, observedBlock: null, blockHash: null };
  const current = await state(context, wallet);
  const signer = configuredSigner(context);
  return { config: { ...context.config, enabled: context.config.enabled && signer?.address === current.signer }, wallet,
    totalReserved: current.totalReserved, reservedRelics: wallet ? current.reservedRelics : null,
    remainingRelics: PRE111K_MAX_RELICS - current.totalReserved, observedBlock: current.blockNumber, blockHash: current.blockHash };
}

async function prepare(request: Request, context: Context, wallet: string, code: unknown): Promise<Pre111kPrepareResponse> {
  await limitEthereumRequest(request, context, 'pre111k:prepare', context.env.PREORDER_PREPARE_IP_RATE_LIMITER);
  const key = await sha256Hex(`pre111k:${context.config.network}:${wallet}`);
  if (!(await context.env.PREORDER_PREPARE_RATE_LIMITER.limit({ key })).success) {
    throw new EthereumApiError('resource-exhausted', 'Too many reservation requests. Try again later.');
  }
  await requireAccessCode(context.env, code);
  if (!context.config.enabled || !context.config.contractAddress) return unavailable();
  const signer = configuredSigner(context);
  if (!signer) return unavailable();
  const current = await state(context, wallet);
  if (signer.address !== current.signer) return unavailable();
  if (current.totalReserved >= PRE111K_MAX_RELICS) throw new EthereumApiError('failed-precondition', 'All relics have been reserved.');
  const now = Math.floor(context.nowMs / 1000);
  const deadline = Math.min(now, current.timestamp) + PRE111K_AUTHORIZATION_TTL_SECONDS;
  if (deadline <= now || deadline <= current.timestamp) return unavailable();
  const nonce = current.reservedRelics;
  const signature = signDigest(signer.secret, pre111kReservationDigest({ chainId: context.config.chainId,
    contractAddress: context.config.contractAddress, wallet, nonce, deadline, priceWei: context.config.priceWei }));
  context.signal.throwIfAborted();
  return { network: context.config.network, wallet, nonce, deadline, expiresAtMs: deadline * 1000, signature,
    transaction: { to: context.config.contractAddress, chainId: context.config.chainId,
      value: ethereumHexQuantity(BigInt(context.config.priceWei)), data: encodePre111kReservation(nonce, deadline, signature) } };
}

async function confirm(context: DeploymentContext, wallet: string, transactionHash: string): Promise<Pre111kConfirmResponse> {
  if (!context.config.contractAddress) return unavailable();
  const read = readContext(context);
  const pending = (confirmations = 0, reservationNonce: number | null = null): Pre111kConfirmResponse =>
    ({ status: 'pending', confirmations, transactionHash, reservationNonce });
  const raw = await ethereumRpc(read, 'eth_getTransactionReceipt', [transactionHash]);
  if (raw === null) return pending();
  const receipt = object(raw);
  if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== transactionHash ||
    typeof receipt.blockHash !== 'string' || !HASH.test(receipt.blockHash) ||
    (receipt.status !== '0x0' && receipt.status !== '0x1') ||
    !Array.isArray(receipt.logs)) return unavailable();
  const sender = ethereumAddress(receipt.from);
  const recipient = ethereumAddress(receipt.to);
  const blockNumber = rpcInteger(receipt.blockNumber);
  if (blockNumber < context.config.deploymentBlock) return unavailable();
  const [transactionRaw, headRaw, canonicalRaw] = await Promise.all([
    ethereumRpc(read, 'eth_getTransactionByHash', [transactionHash]), ethereumRpc(read, 'eth_blockNumber', []),
    ethereumRpc(read, 'eth_getBlockByNumber', [ethereumHexQuantity(blockNumber), false]),
  ]);
  const canonical = object(canonicalRaw);
  if (typeof canonical.hash !== 'string' || canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return pending();
  const transaction = object(transactionRaw);
  if (ethereumAddress(transaction.from) !== sender || ethereumAddress(transaction.to) !== recipient ||
    typeof transaction.hash !== 'string' || transaction.hash.toLowerCase() !== transactionHash ||
    typeof transaction.blockHash !== 'string' || transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    rpcInteger(transaction.blockNumber) !== blockNumber ||
    typeof transaction.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(transaction.value) ||
    transaction.chainId !== undefined && rpcInteger(transaction.chainId) !== context.config.chainId ||
    typeof transaction.input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.input)) {
    throw new EthereumApiError('invalid-argument', 'This transaction does not match a relic reservation.');
  }
  const direct = sender === wallet && recipient === context.config.contractAddress;
  let reservationNonce: number | null = null;
  if (direct) {
    try {
      const [nonce, deadline, signature] = decodeReturn(['uint256', 'uint256', 'bytes'], `0x${transaction.input.slice(10)}`);
      reservationNonce = smallInteger(nonce, PRE111K_MAX_RELICS - 1);
      const deadlineNumber = smallInteger(deadline, Number.MAX_SAFE_INTEGER);
      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
        encodePre111kReservation(reservationNonce, deadlineNumber, signature).toLowerCase() !== transaction.input.toLowerCase()) throw new Error();
    } catch { throw new EthereumApiError('invalid-argument', 'This transaction is not a relic reservation call.'); }
  } else if (receipt.status === '0x0') {
    throw new EthereumApiError('invalid-argument', 'This failed transaction does not identify the reservation wallet.');
  }
  const confirmations = Math.max(0, rpcInteger(headRaw) - blockNumber + 1);
  if (receipt.status === '0x1') {
    const logs = receipt.logs.map(object).filter(log => typeof log.address === 'string' &&
      log.address.toLowerCase() === context.config.contractAddress && Array.isArray(log.topics) &&
      typeof log.topics[0] === 'string' && log.topics[0].toLowerCase() === PRE111K_RESERVED_TOPIC);
    const matching: number[] = [];
    for (const log of logs) {
      if (!Array.isArray(log.topics) || log.topics.length !== 3 || log.topics.some(topic => typeof topic !== 'string' || !HASH.test(topic)) ||
        typeof log.data !== 'string' || !HASH.test(log.data) || log.removed === true ||
        typeof log.blockHash !== 'string' || log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
        typeof log.transactionHash !== 'string' || log.transactionHash.toLowerCase() !== transactionHash ||
        rpcInteger(log.blockNumber) !== blockNumber) return unavailable();
      const eventWallet = decodeReturn(['address'], String(log.topics[1]))[0];
      const eventNonce = smallInteger(decodeReturn(['uint256'], String(log.topics[2]))[0], PRE111K_MAX_RELICS - 1);
      const eventTotal = smallInteger(decodeReturn(['uint256'], log.data)[0], PRE111K_MAX_RELICS);
      if (eventTotal <= eventNonce) return unavailable();
      if (eventWallet === wallet) matching.push(eventNonce);
    }
    if (matching.length !== 1 || reservationNonce !== null && matching[0] !== reservationNonce) return unavailable();
    reservationNonce = matching[0];
  }
  await verifyEthereumBlockSnapshot(read, { blockNumber, blockHash: receipt.blockHash.toLowerCase() });
  if (confirmations < context.config.confirmationBlocks) return pending(confirmations, reservationNonce);
  return { status: receipt.status === '0x1' ? 'confirmed' : 'failed', confirmations, transactionHash, reservationNonce };
}

export async function handlePre111kRequest(request: Request, env: Pre111kEnvironment, path: string, dependencies: {
  nowMs?: () => number; fetch?: typeof fetch;
} = {}): Promise<Response> {
  try {
    if (!Object.values(PRE111K_API_PATHS).some(value => value === path)) throw new EthereumApiError('not-found', 'Unknown relic reservation request.');
    const expectedMethod = path === PRE111K_API_PATHS.status ? 'GET' : 'POST';
    if (request.method !== expectedMethod) return jsonResponse({ ok: false, error: { code: 'invalid-argument', message: 'Method not allowed.' } }, 405,
      { headers: { Allow: `${expectedMethod}, OPTIONS` } });
    ethereumRequestOrigin(request);
    if (expectedMethod === 'POST' && request.headers.get('X-Mons-CSRF') !== '1') throw new EthereumApiError('permission-denied', 'Invalid reservation request.');
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    if (path === PRE111K_API_PATHS.access) {
      await limitEthereumRequest(request, { signal }, 'pre111k:access', env.PREORDER_PREPARE_IP_RATE_LIMITER);
      const body = await readEthereumBody(request, signal, accessSchema);
      await requireAccessCode(env, body.code);
      signal.throwIfAborted();
      return jsonResponse({ ok: true } satisfies Pre111kAccessResponse, 200);
    }
    let network: Pre111kNetwork;
    let wallet: string | null;
    let hash: string | null = null;
    let code: unknown;
    if (path === PRE111K_API_PATHS.status) {
      const params = new URL(request.url).searchParams;
      if (params.getAll('network').length !== 1 || params.getAll('wallet').length > 1 || [...params.keys()].some(key => !['network', 'wallet'].includes(key))) {
        throw new EthereumApiError('invalid-argument', 'Invalid reservation status request.');
      }
      const parsed = networkSchema.safeParse(params.get('network'));
      if (!parsed.success) throw new EthereumApiError('invalid-argument', 'Invalid reservation network.');
      network = parsed.data;
      wallet = params.has('wallet') ? ethereumAddress(params.get('wallet')) : null;
    } else if (path === PRE111K_API_PATHS.prepare) {
      const body = await readEthereumBody(request, signal, requestSchema.extend(accessSchema.shape));
      network = body.network;
      wallet = ethereumAddress(body.wallet);
      code = body.code;
    } else {
      const body = await readEthereumBody(request, signal, requestSchema.extend({ transactionHash: z.string() }).strict());
      network = body.network;
      wallet = ethereumAddress(body.wallet);
      hash = ethereumTransactionHash(body.transactionHash);
    }
    const runtime = { env, signal, fetch: dependencies.fetch || ((input, init) => fetch(input, init)) } satisfies Omit<EthereumReadContext, 'config'>;
    const settings = deploymentSettings(env, network);
    if (path !== PRE111K_API_PATHS.prepare) await limitEthereumRequest(request, runtime, path, env.PUBLIC_SHOP_RATE_LIMITER);
    if (path === PRE111K_API_PATHS.confirm) {
      const config = resolvePre111kDeployment(network, settings);
      return jsonResponse(await confirm({ ...runtime, config }, wallet!, hash!), 200);
    }
    const priceWei = network === 'mainnet' ? env.ETHEREUM_PRE111K_MAINNET_PRICE_WEI : env.ETHEREUM_PRE111K_SEPOLIA_PRICE_WEI;
    const context: Context = { ...runtime, config: resolvePre111kConfig(network, { ...settings, priceWei }), nowMs: (dependencies.nowMs || Date.now)() };
    const result = path === PRE111K_API_PATHS.status ? await status(context, wallet) : await prepare(request, context, wallet!, code);
    return jsonResponse(result, 200, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    if (!(error instanceof EthereumApiError)) console.error({ event: 'pre111k_request_failed', path,
      errorName: error instanceof Error ? error.name : 'UnknownError' });
    return ethereumErrorResponse(error);
  }
}
