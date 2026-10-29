import { ethereumAuth, ethereumRequestOrigin, limitEthereumRequest } from './ethereumAuth.js';
import { ethereumCommerce } from './ethereumCommerce.js';
import { ethereumErrorResponse, EthereumApiError } from './ethereumError.js';
import { ethereumConfig, type EthereumEnvironment, type EthereumContext } from './ethereumRuntime.js';
import { jsonResponse } from './httpResponse.js';
import { ethereumCheckout } from './ethereumCheckout.js';
import { isAllowedEthereumCheckoutStatusOrigin } from './ethereumCheckoutOrigin.js';
import { ethereumRouteDefinition } from './ethereumRouteDefinitions.js';

function unregisteredPathHandler(path: string) {
  if (path.startsWith('/ethereum/111k/checkout/')) return ethereumCheckout;
  if (path.startsWith('/ethereum/auth/')) return ethereumAuth;
  return ethereumCommerce;
}

export async function handleEthereumRequest(request: Request, env: EthereumEnvironment, path: string, dependencies: {
  nowMs?: () => number; fetch?: typeof fetch;
} = {}): Promise<Response> {
  try {
    const route = ethereumRouteDefinition(path);
    const methods: readonly string[] = route?.methods || ['POST'];
    if (!methods.includes(request.method)) return jsonResponse({ ok: false, error: { code: 'invalid-argument', message: 'Method not allowed.' } }, 405,
      { headers: { Allow: [...methods, 'OPTIONS'].join(', ') } });
    ethereumRequestOrigin(request, route?.originPolicy === 'checkout-status' || route?.originPolicy === 'reveal'
      ? isAllowedEthereumCheckoutStatusOrigin : undefined);
    if (request.method === 'POST' && request.headers.get('X-Mons-CSRF') !== '1') {
      throw new EthereumApiError('permission-denied', 'Invalid Ethereum request.');
    }
    const context: EthereumContext = { env, config: ethereumConfig(env), nowMs: (dependencies.nowMs || Date.now)(),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]), fetch: dependencies.fetch || ((input, init) => fetch(input, init)) };
    if (route?.publicRateLimit) await limitEthereumRequest(request, context, path, env.PUBLIC_SHOP_RATE_LIMITER);
    const handler = route?.handler || unregisteredPathHandler(path);
    const result = await handler(request, context, path);
    return jsonResponse(result, 200);
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    if (!(error instanceof EthereumApiError)) console.error({ event: 'ethereum_request_failed', path,
      errorName: error instanceof Error ? error.name : 'UnknownError' });
    return ethereumErrorResponse(error);
  }
}
