import { isAllowedProfileOrigin } from './profileReadSupport.js';
import { EthereumApiError, ethereumErrorResponse } from './ethereumError.js';

export function isAllowedEthereumCheckoutStatusOrigin(origin: string): boolean {
  return origin === 'https://vvv.so' || isAllowedProfileOrigin(origin);
}

export function applyEthereumCheckoutStatusCors(request: Request, response: Response): Response {
  const origin = request.headers.get('Origin');
  if (!origin) return response;
  if (!isAllowedEthereumCheckoutStatusOrigin(origin)) {
    return ethereumErrorResponse(new EthereumApiError('permission-denied', 'Origin is not allowed.'));
  }
  for (const [key, value] of Object.entries({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  })) response.headers.set(key, value);
  return response;
}
