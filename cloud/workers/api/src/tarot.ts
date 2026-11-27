import { isIP } from 'node:net';
import { z } from 'zod';
import {
  TAROT_API_PATHS, TAROT_MAX_CARDS, tarotReceiptTokenId,
  type TarotBackendClaim, type TarotClaimRequest, type TarotClaimResponse, type TarotStatus,
} from '../../../../shared/ethereum/tarot.js';
import { ethereumRequestOrigin } from './ethereumAuth.js';
import { EthereumApiError, ethereumErrorResponse, readEthereumBody } from './ethereumError.js';
import { ethereumProviderApiError, RpcProviderError } from './ethereumProvider.js';
import { ProviderBudgetUnavailable } from './ethereumProviderBudget.js';
import { ethereumAddress, ethereumTransactionHash } from './ethereumRuntime.js';
import { jsonResponse } from './httpResponse.js';
import { sha256Hex } from './sessionSecrets.js';
import {
  confirmTarotClaim, createTarotAuthorization, requireTarotCode, tarotConfig, tarotSigner, tarotState,
  type TarotContext, type TarotEnvironment,
} from './tarotClaimSupport.js';
import { resolveTarotRecipient } from './tarotClaimChain.js';
import { tarotClaimRelayerName } from './tarotClaimRelayer.js';
import type { TarotClaimRejection } from './tarotClaimRejection.js';

export type { TarotEnvironment } from './tarotClaimSupport.js';

const requestSchema = z.object({
  tokenId: z.number().int().min(1).max(TAROT_MAX_CARDS), testnet: z.boolean().default(false),
  code: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
}).strict();

async function limitTarotRequest(request: Request, signal: AbortSignal, operation: 'access' | 'confirm', limiter: RateLimit): Promise<void> {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !isIP(ip)) throw new EthereumApiError('unavailable', 'Tarot Cards are temporarily unavailable.');
  const key = await sha256Hex(`tarot:${operation}:${ip.toLowerCase()}`);
  if (!(await limiter.limit({ key })).success) throw new EthereumApiError('resource-exhausted', 'Too many requests. Try again later.');
  signal.throwIfAborted();
}

function relayer(context: TarotContext) {
  return context.env.TAROT_CLAIM_RELAYER?.getByName(tarotClaimRelayerName(context.config.chainId));
}

function scope(context: TarotContext, tokenId: number) {
  return { chainId: context.config.testnet ? 11155111 as const : 1 as const,
    contractAddress: context.config.contractAddress!, tokenId };
}

function activeClaim(claim: TarotBackendClaim | null | undefined): boolean {
  return !!claim && (claim.state !== 'failed' || claim.transactionHash !== null && claim.finalized !== true);
}

async function status(context: TarotContext, tokenId: number, requestId?: string): Promise<TarotStatus> {
  const [current, backendClaim] = await Promise.all([
    tarotState(context, tokenId, true), relayer(context)?.status({ ...scope(context, tokenId), ...(requestId ? { requestId } : {}) }) ?? null,
  ]);
  const signer = tarotSigner(context);
  return { config: { ...context.config, enabled: context.config.enabled && !current.mintingPaused && signer?.address === current.signer },
    tokenId, receiptTokenId: tarotReceiptTokenId(tokenId), claimed: current.claimed,
    observedBlock: current.blockNumber, observedTimestamp: current.timestamp, blockHash: current.blockHash,
    ...(context.env.TAROT_CLAIM_RELAYER ? { backendClaim } : {}) };
}

async function prepare(context: TarotContext, tokenId: number, wallet: string) {
  const key = await sha256Hex(`tarot:prepare:${context.config.chainId}:${context.config.contractAddress}:${tokenId}:${wallet}`);
  if (!(await context.env.TAROT_PREPARE_RATE_LIMITER.limit({ key })).success) {
    throw new EthereumApiError('resource-exhausted', 'Too many requests. Try again later.');
  }
  if (activeClaim(await relayer(context)?.status(scope(context, tokenId)))) {
    throw new EthereumApiError('failed-precondition', 'This card already has a backend claim.');
  }
  return createTarotAuthorization(context, tokenId, wallet);
}

async function claim(context: TarotContext, request: TarotClaimRequest, codeHash: string): Promise<TarotClaimResponse> {
  const sender = relayer(context);
  if (!sender) throw new EthereumApiError('unavailable', 'Backend claiming is temporarily unavailable.');
  const input = scope(context, request.tokenId);
  const prior = await sender.status({ ...input, requestId: request.requestId });
  const current = prior ?? await sender.status(input);
  const result = (outcome: TarotBackendClaim | TarotClaimRejection): TarotClaimResponse => {
    if ('rejection' in outcome) {
      const failure = outcome.rejection;
      throw new EthereumApiError(failure.code, failure.message, {
        ...(failure.details && typeof failure.details === 'object' ? failure.details : {}), claimAccepted: false,
      });
    }
    return { tokenId: request.tokenId, receiptTokenId: tarotReceiptTokenId(request.tokenId), backendClaim: outcome };
  };
  if (prior || activeClaim(current)) return result((prior ?? current)!);
  let recipient: string;
  try {
    const enabled = context.config.testnet ? context.env.ETHEREUM_TAROT_SEPOLIA_SPONSORSHIP_ENABLED
      : context.env.ETHEREUM_TAROT_MAINNET_SPONSORSHIP_ENABLED;
    if (enabled !== 'true' || !context.config.enabled) {
      throw new EthereumApiError('unavailable', 'Backend claiming is temporarily unavailable.');
    }
    const key = await sha256Hex(`tarot:sponsored:${input.chainId}:${input.contractAddress}:${input.tokenId}`);
    if (!(await context.env.TAROT_PREPARE_RATE_LIMITER.limit({ key })).success) {
      throw new EthereumApiError('resource-exhausted', 'Too many requests. Try again later.');
    }
    recipient = await resolveTarotRecipient(context.env, request.recipient, context.signal, { fetch: context.fetch });
    context.signal.throwIfAborted();
  } catch (error) {
    const failure = error instanceof EthereumApiError ? error : ethereumProviderApiError(error);
    return result(await sender.reject({ ...input, requestId: request.requestId, codeHash,
      failure: { code: failure.code, message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) } }));
  }
  return result(await sender.claim({ ...input, requestId: request.requestId, recipient, codeHash }));
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
    const schema = path === TAROT_API_PATHS.status ? requestSchema.extend({ requestId: z.uuidv4().optional() }).strict() : confirmation
      ? requestSchema.extend({ wallet: z.string(), transactionHash: z.string() }).strict()
      : path === TAROT_API_PATHS.claim ? requestSchema.extend({
        recipient: z.string().trim().min(1).max(255), requestId: z.uuidv4(),
      }).strict() : requestSchema.extend({ wallet: z.string() }).strict();
    const body = await readEthereumBody<z.infer<typeof schema>>(request, signal, schema);
    const wallet = 'wallet' in body ? ethereumAddress(body.wallet) : null;
    const config = tarotConfig(env, body.testnet);
    const context: TarotContext = { env, config, signal, nowMs: (dependencies.nowMs || Date.now)(),
      fetch: dependencies.fetch || ((input, init) => fetch(input, init)) };
    const codeHash = await requireTarotCode(context, body.tokenId, body.code);
    const response = path === TAROT_API_PATHS.status ? await status(context, body.tokenId,
      'requestId' in body ? body.requestId : undefined) : confirmation
      ? await confirmTarotClaim(context, body.tokenId, wallet!, ethereumTransactionHash('transactionHash' in body ? body.transactionHash : undefined))
      : 'recipient' in body && typeof body.recipient === 'string' && 'requestId' in body && typeof body.requestId === 'string'
        ? await claim(context, { ...body, recipient: body.recipient, requestId: body.requestId }, codeHash)
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
