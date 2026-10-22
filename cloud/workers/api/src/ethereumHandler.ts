import { ETHEREUM_API_PATHS } from '../../../../shared/ethereum/api.js';
import { ETHEREUM_CHECKOUT_PATHS } from '../../../../shared/ethereum/checkout.js';
import { ethereumAuth, ethereumRequestOrigin, limitEthereumRequest } from './ethereumAuth.js';
import { ethereumCommerce } from './ethereumCommerce.js';
import { ethereumErrorResponse, EthereumApiError } from './ethereumError.js';
import { ethereumProfile } from './ethereumProfile.js';
import { ethereumPublicRead } from './ethereumRead.js';
import { ethereumConfig, type EthereumEnvironment, type EthereumContext } from './ethereumRuntime.js';
import { jsonResponse } from './httpResponse.js';
import { ethereumCheckout } from './ethereumCheckout.js';
import { isAllowedEthereumCheckoutStatusOrigin } from './ethereumCheckoutOrigin.js';

export const ethereumReadPaths = new Set<string>([ETHEREUM_API_PATHS.config, ETHEREUM_API_PATHS.stats,
  ETHEREUM_API_PATHS.inventory, ETHEREUM_API_PATHS.metadata, ETHEREUM_API_PATHS.profile,
  ETHEREUM_API_PATHS.shipments, ETHEREUM_API_PATHS.addresses, ETHEREUM_CHECKOUT_PATHS.status]);
const publicPaths = new Set<string>([ETHEREUM_API_PATHS.config, ETHEREUM_API_PATHS.stats,
  ETHEREUM_API_PATHS.inventory, ETHEREUM_API_PATHS.metadata, ETHEREUM_API_PATHS.transactionsConfirm]);

export async function handleEthereumRequest(request: Request, env: EthereumEnvironment, path: string, dependencies: {
  nowMs?: () => number; fetch?: typeof fetch;
} = {}): Promise<Response> {
  try {
    const methodAllowed = request.method === (ethereumReadPaths.has(path) ? 'GET' : 'POST') ||
      path === ETHEREUM_API_PATHS.addresses && request.method === 'POST';
    if (!methodAllowed) return jsonResponse({ ok: false, error: { code: 'invalid-argument', message: 'Method not allowed.' } }, 405,
      { headers: { Allow: path === ETHEREUM_API_PATHS.addresses ? 'GET, POST, OPTIONS' : ethereumReadPaths.has(path) ? 'GET, OPTIONS' : 'POST, OPTIONS' } });
    ethereumRequestOrigin(request, path === ETHEREUM_CHECKOUT_PATHS.status ? isAllowedEthereumCheckoutStatusOrigin : undefined);
    if (request.method === 'POST' && request.headers.get('X-Mons-CSRF') !== '1') {
      throw new EthereumApiError('permission-denied', 'Invalid Ethereum request.');
    }
    const context: EthereumContext = { env, config: ethereumConfig(env), nowMs: (dependencies.nowMs || Date.now)(),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]), fetch: dependencies.fetch || ((input, init) => fetch(input, init)) };
    if (publicPaths.has(path)) await limitEthereumRequest(request, context, path, env.PUBLIC_SHOP_RATE_LIMITER);
    let result: unknown;
    if (path.startsWith('/ethereum/111k/checkout/')) result = await ethereumCheckout(request, context, path);
    else if (path.startsWith('/ethereum/auth/')) result = await ethereumAuth(request, context, path);
    else if (path === ETHEREUM_API_PATHS.profile || path === ETHEREUM_API_PATHS.addresses || path === ETHEREUM_API_PATHS.shipments) {
      result = await ethereumProfile(request, context, path);
    } else if (ethereumReadPaths.has(path)) result = await ethereumPublicRead(request, context, path);
    else result = await ethereumCommerce(request, context, path);
    return jsonResponse(result, 200);
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    if (!(error instanceof EthereumApiError)) console.error({ event: 'ethereum_request_failed', path,
      errorName: error instanceof Error ? error.name : 'UnknownError' });
    return ethereumErrorResponse(error);
  }
}
