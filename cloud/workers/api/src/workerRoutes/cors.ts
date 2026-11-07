import {
  applyProfileCors,
  handleProfileCorsPreflight,
} from '../profileReadSupport.js';
import { isAllowedStaffAuthOrigin } from '../staffWalletAuth.js';
import { CORS_HEADERS, handlePublicPreflight } from '../publicRouteSupport.js';
import { handleRpcPreflight } from '../rpcProxy.js';
import { applyEthereumCheckoutStatusCors } from '../ethereumCheckoutOrigin.js';
import { applyEthereumRevealCors } from '../ethereumReveal.js';
import { MI_NOTE_SESSION_HEADER } from '../../../../../shared/miNoteAuth.js';
import { ETHEREUM_SESSION_HEADER } from '../../../../../shared/ethereum/api.js';
import type { MatchedWorkerRoute, WorkerRouteCorsPolicy } from './support.js';

type CorsPolicy = Readonly<{
  preflight?: (request: Request, route: MatchedWorkerRoute) => Response | undefined;
  response?: (request: Request, response: Response) => Response;
}>;

function profileCorsPolicy(extraHeader?: string): CorsPolicy {
  const methods = extraHeader ? 'GET, POST, OPTIONS' : undefined;
  return {
    preflight: (request) => handleProfileCorsPreflight(request, undefined, methods, extraHeader),
    response: (request, response) => applyProfileCors(request, response, methods, extraHeader),
  };
}

function responseCorsPolicy(apply: NonNullable<CorsPolicy['response']>): CorsPolicy {
  return {
    preflight: (request) => apply(request, new Response(null, { status: 204 })),
    response: apply,
  };
}

const CORS_POLICIES: Readonly<Record<WorkerRouteCorsPolicy, CorsPolicy>> = {
  none: {},
  public: { preflight: (request, route) => handlePublicPreflight(request, route.publicMethods) },
  rpc: { preflight: handleRpcPreflight },
  profile: profileCorsPolicy(),
  'staff-auth': {
    preflight: (request) => handleProfileCorsPreflight(request, isAllowedStaffAuthOrigin),
    response: applyProfileCors,
  },
  'mi-note': profileCorsPolicy(MI_NOTE_SESSION_HEADER),
  ethereum: profileCorsPolicy(ETHEREUM_SESSION_HEADER),
  'ethereum-checkout-status': responseCorsPolicy(applyEthereumCheckoutStatusCors),
  'ethereum-reveal': responseCorsPolicy(applyEthereumRevealCors),
  'pack-status': {
    preflight: (_request, route) => route.packStatusDropId === null ? undefined : new Response(null, {
      status: 204,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', 'Timing-Allow-Origin': '*' },
    }),
  },
};

export function workerRoutePreflightResponse(
  route: MatchedWorkerRoute,
  request: Request,
): Response | undefined {
  return request.method === 'OPTIONS' ? CORS_POLICIES[route.cors].preflight?.(request, route) : undefined;
}

export function applyWorkerRouteCors(
  route: MatchedWorkerRoute,
  request: Request,
  response: Response,
  policyOverride?: WorkerRouteCorsPolicy,
): Response {
  return CORS_POLICIES[policyOverride ?? route.cors].response?.(request, response) ?? response;
}

export function applyWorkerRouteProfileErrorCors(
  route: MatchedWorkerRoute,
  request: Request,
  response: Response,
): Response {
  return (CORS_POLICIES[route.cors].response ?? applyProfileCors)(request, response);
}
