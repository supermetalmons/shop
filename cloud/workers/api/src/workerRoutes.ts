import { handleRpcInternalError, handleRpcMethodNotAllowed, handleRpcPreflight } from './rpcProxy.js';
import {
  applyProfileCors,
  handleProfileCorsPreflight,
  isProfileRequestOriginAllowed,
} from './profileReadSupport.js';
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
import { isAllowedStaffAuthOrigin } from './staffWalletAuth.js';
import { isStaffOnlyApiPath } from './requestIdentity.js';
import {
  CORS_HEADERS,
  handlePublicMethodNotAllowed,
  handlePublicPreflight,
  publicJsonResponse,
  type WorkerRequestMetrics,
} from './publicRouteSupport.js';
import { applyPublicCors, publicRequestOrigin } from './publicRequestPolicy.js';
import { jsonResponse as sharedJsonResponse } from './httpResponse.js';
import { MI_NOTE_SESSION_HEADER } from '../../../../shared/miNoteAuth.js';
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

export type { MatchedWorkerRoute, WorkerRouteResult } from './workerRoutes/support.js';

async function dispatchNotFound(): Promise<WorkerRouteResult> {
  return { response: publicJsonResponse({ ok: false, error: 'not-found' }, 404) };
}

const EXACT_ROUTE_ENTRIES: readonly ExactWorkerRoute[] = [
  ...authRoutes,
  ...shopRoutes,
  ...commerceRoutes,
  ...profileRoutes,
  ...staffRoutes,
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

export function workerRoutePreflightResponse(
  route: MatchedWorkerRoute,
  request: Request,
): Response | undefined {
  if (request.method !== 'OPTIONS') return undefined;
  if (route.cors === 'mi-note') return handleProfileCorsPreflight(request, undefined, 'GET, POST, OPTIONS', MI_NOTE_SESSION_HEADER);
  if (route.cors === 'profile') return handleProfileCorsPreflight(request);
  if (route.cors === 'staff-auth') {
    return handleProfileCorsPreflight(request, isAllowedStaffAuthOrigin);
  }
  if (route.cors === 'public') return handlePublicPreflight(request, route.publicMethods);
  if (route.cors === 'rpc') return handleRpcPreflight(request);
  if (route.cors === 'pack-status' && route.packStatusDropId !== null) {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        'Cache-Control': 'no-store',
        'Timing-Allow-Origin': '*',
      },
    });
  }
  return undefined;
}

export function workerRouteOriginDeniedResponse(
  route: MatchedWorkerRoute,
  request: Request,
): Response | undefined {
  if (!route.profileOriginGate || isProfileRequestOriginAllowed(request)) return undefined;
  return applyProfileCors(request, new Response(null));
}

export function applyWorkerRouteCors(
  route: MatchedWorkerRoute,
  request: Request,
  response: Response,
): Response {
  if (route.cors === 'mi-note') return applyProfileCors(request, response, 'GET, POST, OPTIONS', MI_NOTE_SESSION_HEADER);
  return route.cors === 'profile' || route.cors === 'staff-auth'
    ? applyProfileCors(request, response)
    : response;
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
    return applyProfileCors(request, publicJsonResponse({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Service is temporarily unavailable.',
        ...(isAdminIrlRedeemFinalizeRoute(route.logRoute)
          ? { recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY }
          : {}),
      },
    }, 503, receiptClaimRetryHeaders(route.logRoute)),
    route.cors === 'mi-note' ? 'GET, POST, OPTIONS' : undefined,
    route.cors === 'mi-note' ? MI_NOTE_SESSION_HEADER : undefined);
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
