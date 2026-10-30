import { z } from 'zod';
import { ETHEREUM_REVEAL_MAX_TOKEN_IDS, ETHEREUM_REVEAL_PATHS, type EthereumRevealResult } from '../../../../shared/ethereum/reveal.js';
import { readEthereumRevealDeployment } from '../../../../shared/ethereum/revealDeployment.js';
import { normalizeEthereumAddress, normalizeEthereumTokenId } from '../../../../shared/ethereum/protocol.js';
import { limitEthereumRequest } from './ethereumAuth.js';
import { isAllowedEthereumCheckoutStatusOrigin } from './ethereumCheckoutOrigin.js';
import { EthereumApiError, ethereumErrorResponse, readEthereumBody } from './ethereumError.js';
import type { EthereumContext } from './ethereumRuntime.js';

const scope = {
  chainId: z.number().int().refine(value => [1, 11155111, 31337].includes(value)),
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/.test(value)),
};
const transactionSchema = z.object({ ...scope, transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict();
const tokensSchema = z.object({ ...scope, tokenIds: z.array(z.string().max(78)).min(1).max(ETHEREUM_REVEAL_MAX_TOKEN_IDS) }).strict();

export async function ethereumReveal(request: Request, context: EthereumContext, path: string): Promise<unknown> {
  const deadlineMs = Date.now() + 2_000;
  const transaction = path === ETHEREUM_REVEAL_PATHS.transaction;
  if (!transaction && path !== ETHEREUM_REVEAL_PATHS.tokens) throw new EthereumApiError('not-found', 'Reveal method not found.');
  await limitEthereumRequest(request, context, 'reveal-read',
    context.env.ETHEREUM_REVEAL_READ_RATE_LIMITER || context.env.PUBLIC_SHOP_RATE_LIMITER, isAllowedEthereumCheckoutStatusOrigin);
  const body = transaction
    ? await readEthereumBody(request, context.signal, transactionSchema)
    : await readEthereumBody(request, context.signal, tokensSchema);
  const normalized = 'tokenIds' in body ? body.tokenIds.map(normalizeEthereumTokenId) : [];
  if (normalized.some(id => !id || BigInt(id) > 111_111n)) throw new EthereumApiError('invalid-argument', 'Only artwork token IDs can be revealed.');
  const ids = [...new Set(normalized as string[])];
  const contractAddress = normalizeEthereumAddress(body.contractAddress)!;
  const deployment = await readEthereumRevealDeployment(context.env.OPS_DB, { chainId: body.chainId, contractAddress });
  if (!deployment) throw new EthereumApiError('not-found', 'Reveal is not configured for this collection.');
  const namespace = context.env.ETHEREUM_REVEAL;
  if (!namespace) throw new EthereumApiError('unavailable', 'Reveal is temporarily unavailable.');
  const object = namespace.getByName(`${deployment.chainId}:${deployment.contractAddress}`);
  const admission = async () => limitEthereumRequest(request, context, 'reveal-admission',
    context.env.ETHEREUM_REVEAL_ADMISSION_RATE_LIMITER || context.env.PUBLIC_SHOP_RATE_LIMITER, isAllowedEthereumCheckoutStatusOrigin);
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch {
      throw new EthereumApiError('unavailable', 'Reveal is temporarily unavailable.');
    }
  };
  const resolve = async <T>(operation: (admit: boolean) => Promise<EthereumRevealResult<T>>): Promise<T> => {
    let result = await call(() => operation(false));
    if (result.kind === 'admission') {
      if (deployment.state !== 'active') throw new EthereumApiError('failed-precondition', 'Reveal is not active for this collection.');
      await admission();
      result = await call(() => operation(true));
    }
    if (result.kind === 'capacity') throw new EthereumApiError('resource-exhausted', 'Artwork recovery capacity is full. Try again later.');
    if (result.kind !== 'ready') throw new EthereumApiError('unavailable', 'Reveal is temporarily unavailable.');
    return result.value;
  };
  if ('transactionHash' in body) {
    const hash = body.transactionHash.toLowerCase();
    return resolve(admit => object.revealTransaction(deployment, hash, admit, deadlineMs));
  }
  return resolve(admit => object.revealTokens(deployment, ids, admit, deadlineMs));
}

export function applyEthereumRevealCors(request: Request, response: Response): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return response;
  if (!isAllowedEthereumCheckoutStatusOrigin(origin)) {
    return ethereumErrorResponse(new EthereumApiError('permission-denied', 'Origin is not allowed.'));
  }
  for (const [key, value] of Object.entries({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, X-Mons-CSRF',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  })) response.headers.set(key, value);
  return response;
}
