import { ETHEREUM_SESSION_HEADER } from '../../../../shared/ethereum/api.js';
import { isAllowedEthereumCheckoutStatusOrigin } from './ethereumCheckoutOrigin.js';
import { EthereumApiError, ethereumErrorResponse } from './ethereumError.js';
import { applyProfileCors, isAllowedProfileOrigin } from './profileReadSupport.js';

function publicCors(request: Request, response: Response, method: 'GET' | 'POST'): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return response;
  if (isAllowedProfileOrigin(origin)) return applyProfileCors(request, response, 'GET, POST, OPTIONS', ETHEREUM_SESSION_HEADER);
  if (!isAllowedEthereumCheckoutStatusOrigin(origin)) {
    return ethereumErrorResponse(new EthereumApiError('permission-denied', 'Origin is not allowed.'));
  }
  for (const [key, value] of Object.entries({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': `${method}, OPTIONS`,
    'Access-Control-Allow-Headers': `Accept, Content-Type${method === 'POST' ? ', X-Mons-CSRF' : ''}`,
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  })) response.headers.set(key, value);
  return response;
}

export function applyEthereumPublicReadCors(request: Request, response: Response): Response { return publicCors(request, response, 'GET'); }
export function applyEthereumPublicConfirmCors(request: Request, response: Response): Response { return publicCors(request, response, 'POST'); }
