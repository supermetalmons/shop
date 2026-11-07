import { handleRpcInternalError, handleRpcMethodNotAllowed, handleRpcPreflight } from './rpcProxy.js';
import { isProfileRequestOriginAllowed } from './profileReadSupport.js';
import {
  STRIPE_RECEIPT_CLAIM_START_PATH,
  STRIPE_RECEIPT_CLAIM_STATUS_PATH,
} from '../../../../shared/stripeReceiptClaimWorkflow.js';
import { ADMIN_IRL_REDEEM_FINALIZE_PATH } from './adminIrlRedeemFinalize.js';
import { ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH } from './adminIrlRedeemFinalizeWorkflowRoutes.js';
import {
  ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
  STRIPE_CHECKOUT_RETRY_HEADER,
  STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
} from '../../../../shared/contracts.js';
import { isStaffOnlyApiPath } from './requestIdentity.js';
import {
  handlePublicMethodNotAllowed,
  handlePublicPreflight,
  publicJsonResponse,
  type WorkerRequestMetrics,
} from './publicRouteSupport.js';
import { applyPublicCors, publicRequestOrigin } from './publicRequestPolicy.js';
import { jsonResponse as sharedJsonResponse } from './httpResponse.js';
import {
  type WorkerRouteResult,
  type MatchedWorkerRoute,
  type ExactWorkerRoute,
  INTERNAL_POLICY,
  profilePolicy,
} from './workerRoutes/support.js';
import { authRoutes } from './workerRoutes/auth.js';
import { shopRoutes, packStatusRoute } from './workerRoutes/shop.js';
import { commerceRoutes } from './workerRoutes/commerce.js';
import { profileRoutes } from './workerRoutes/profile.js';
import { staffRoutes } from './workerRoutes/staff.js';
import { ethereumRoutes } from './ethereumRoutes.js';
import { pre111kRoutes } from './pre111kRoutes.js';
import { applyWorkerRouteCors, applyWorkerRouteProfileErrorCors } from './workerRoutes/cors.js';

export type { MatchedWorkerRoute, WorkerRouteResult } from './workerRoutes/support.js';
export { applyWorkerRouteCors, workerRoutePreflightResponse } from './workerRoutes/cors.js';

async function dispatchNotFound(): Promise<WorkerRouteResult> {
  return { response: publicJsonResponse({ ok: false, error: 'not-found' }, 404) };
}

const EXACT_ROUTE_ENTRIES: readonly ExactWorkerRoute[] = [
  ...authRoutes,
  ...shopRoutes,
  ...commerceRoutes,
  ...profileRoutes,
  ...staffRoutes,
  ...ethereumRoutes,
  ...pre111kRoutes,
];

function compileExactRoutes(entries: readonly ExactWorkerRoute[]): ReadonlyMap<string, MatchedWorkerRoute> {
  const routes = new Map<string, MatchedWorkerRoute>();
  for (const { path, ...route } of entries) {
    if (routes.has(path)) throw new Error(`Duplicate Worker route: ${path}`);
    routes.set(path, Object.freeze(route));
  }
  return routes;
}

const EXACT_ROUTES = compileExactRoutes(EXACT_ROUTE_ENTRIES);

function staffNamespaceFallback(pathname: string): MatchedWorkerRoute | undefined {
  if (!isStaffOnlyApiPath(pathname)) return undefined;
  return Object.freeze({
    ...profilePolicy({ profileOriginGate: false, staff: 'required' }),
    cors: 'none',
    logRoute: 'not-found',
    dispatch: dispatchNotFound,
  });
}

const NOT_FOUND_ROUTE: MatchedWorkerRoute = Object.freeze({
  ...INTERNAL_POLICY,
  logRoute: 'not-found',
  dispatch: dispatchNotFound,
});

function resolveWorkerRoute(pathname: string): MatchedWorkerRoute {
  return EXACT_ROUTES.get(pathname) ||
    packStatusRoute(pathname) ||
    staffNamespaceFallback(pathname) ||
    NOT_FOUND_ROUTE;
}

export const workerRouteRegistry = Object.freeze({
  exactPaths: Object.freeze(EXACT_ROUTE_ENTRIES.map((entry) => entry.path)),
  resolve: resolveWorkerRoute,
});

export function workerRouteBaseLogFields(
  route: MatchedWorkerRoute,
  metrics: WorkerRequestMetrics,
): Record<string, unknown> {
  return route.baseLogFields?.(metrics) || {};
}

export function strictPublicOriginDeniedResponse(
  route: MatchedWorkerRoute,
  request: Request,
): Response | undefined {
  if (route.cors !== 'public' && route.cors !== 'rpc') return undefined;
  if (publicRequestOrigin(request)) return undefined;
  if (route.cors === 'rpc') {
    return request.method === 'OPTIONS'
      ? handleRpcPreflight(request)
      : handleRpcMethodNotAllowed(request);
  }
  return request.method === 'OPTIONS'
    ? handlePublicPreflight(request, route.publicMethods)
    : handlePublicMethodNotAllowed(request, route.publicMethods);
}

export function workerRouteOriginDeniedResponse(
  route: MatchedWorkerRoute,
  request: Request,
): Response | undefined {
  if (!route.profileOriginGate || isProfileRequestOriginAllowed(request)) return undefined;
  return applyWorkerRouteCors(route, request, new Response(null), 'profile');
}

export function unexpectedWorkerRouteResponse(
  route: MatchedWorkerRoute,
  request: Request,
): Response {
  if (route.unexpectedError === 'rpc') return handleRpcInternalError(request);
  if (route.unexpectedError === 'public') {
    if (route.cors === 'pack-status') {
      return publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 503);
    }
    const response = sharedJsonResponse({ ok: false, error: 'provider-unavailable' }, 503, {
      headers: { Vary: 'Origin' },
    });
    const origin = publicRequestOrigin(request);
    return origin ? applyPublicCors(response, origin, route.publicMethods ?? 'POST, OPTIONS') : response;
  }
  if (route.unexpectedError === 'stripe-webhook') {
    return sharedJsonResponse({
      received: true,
      error: 'Stripe webhook processing failed',
    }, 500);
  }
  if (route.unexpectedError === 'profile') {
    const response = route.cors === 'ethereum-reveal'
      ? sharedJsonResponse({ ok: false, error: { code: 'unavailable', message: 'Reveal is temporarily unavailable.' } }, 503)
      : route.cors === 'ethereum-checkout-status'
        ? sharedJsonResponse({ ok: false, error: { code: 'unavailable', message: 'Service is temporarily unavailable.' } }, 503)
        : publicJsonResponse({
          ok: false,
          error: {
            code: 'unavailable',
            message: 'Service is temporarily unavailable.',
            ...(isAdminIrlRedeemFinalizeRoute(route.logRoute)
              ? { recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY }
              : {}),
          },
        }, 503, receiptClaimRetryHeaders(route.logRoute));
    return applyWorkerRouteProfileErrorCors(route, request, response);
  }
  return sharedJsonResponse({ ok: false, error: 'internal' }, 500);
}

export function receiptClaimRetryHeaders(pathname: string): Record<string, string> {
  return pathname === STRIPE_RECEIPT_CLAIM_START_PATH || pathname === STRIPE_RECEIPT_CLAIM_STATUS_PATH
    ? { [STRIPE_CHECKOUT_RETRY_HEADER]: STRIPE_CHECKOUT_RETRY_SAME_OPERATION }
    : {};
}

export function isAdminIrlRedeemFinalizeRoute(pathname: string): boolean {
  return pathname === ADMIN_IRL_REDEEM_FINALIZE_PATH ||
    pathname === ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH;
}
