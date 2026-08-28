import {
  handleRpcInternalError,
  handleRpcMethodNotAllowed,
  handleRpcPost,
  handleRpcPreflight,
} from './rpcProxy.js';
import {
  handleNotificationEnqueue,
  NOTIFICATION_ENQUEUE_PATH,
} from './notificationEnqueue.js';
import {
  handleStripeCheckoutSession,
  STRIPE_CHECKOUT_SESSION_PATH,
} from './stripeCheckout.js';
import {
  handleStripeWebhookRequest,
  STRIPE_WEBHOOK_PATH,
} from './stripeWebhook.js';
import {
  applyProfileCors,
  handleProfileCorsPreflight,
  handleProfileReadRequest,
  isProfileRequestOriginAllowed,
  PROFILE_READ_PATHS,
  type ProfileReadPath,
} from './profileReads.js';
import {
  PROFILE_ADDRESSES_PATH,
  PROFILE_WRITE_PATHS,
  handleProfileWriteRequest,
  type ProfileWritePath,
} from './profileWrites.js';
import {
  PROFILE_LIFECYCLE_PATHS,
  PROFILE_RECONCILE_PATH,
  handleProfileLifecycleRequest,
  type ProfileLifecyclePath,
} from './profileLifecycle.js';
import {
  IRL_CLAIM_PREPARE_PATH,
  handleIrlClaimPrepare,
} from './irlClaim.js';
import {
  RECEIPT_TRANSFER_PREPARE_PATH,
  handleReceiptTransferPrepare,
} from './receiptTransfer.js';
import {
  STRIPE_RECEIPT_CLAIM_PATH,
  handleStripeReceiptClaim,
} from './stripeReceiptClaim.js';
import {
  DELIVERY_PREPARE_PATH,
  handleDeliveryPrepare,
} from './deliveryPrepare.js';
import {
  DELIVERY_RECEIPTS_ISSUE_PATH,
  DELIVERY_RECEIPTS_RECOVER_PATH,
  handleDeliveryReceiptRequest,
} from './deliveryReceipts.js';
import {
  ADMIN_IRL_REDEEM_PREPARE_PATH,
  handleAdminIrlRedeemPrepare,
} from './adminIrlRedeemPrepare.js';
import {
  ADMIN_IRL_REDEEM_FINALIZE_PATH,
  handleAdminIrlRedeemFinalize,
} from './adminIrlRedeemFinalize.js';
import {
  REVEAL_DUDES_PATH,
  handleRevealDudes,
} from './revealDudes.js';
import {
  STAFF_AUTH_PATHS,
  handleStaffAuthRequest,
  isAllowedStaffAuthOrigin,
  type StaffAuthPath,
} from './staffWalletAuth.js';
import {
  ANONYMOUS_AUTH_PATHS,
  handleAnonymousAuthRequest,
} from './anonymousAuth.js';
import { isStaffOnlyApiPath } from './requestIdentity.js';
import {
  CORS_HEADERS,
  handleNotificationSubscription,
  handlePackStatus,
  handlePost,
  handlePublicMethodNotAllowed,
  handlePublicPreflight,
  jsonResponse,
  packStatusDropIdFromPathname,
  type WorkerDependencies,
  type WorkerRequestMetrics,
} from './workerPublicRoutes.js';
import {
  applyPublicCors,
  publicRequestOrigin,
} from './publicRequestPolicy.js';
import type { DeferredWork } from './deferredWork.js';

type WorkerRouteCorsPolicy =
  | 'none'
  | 'public'
  | 'rpc'
  | 'profile'
  | 'staff-auth'
  | 'pack-status';

type WorkerRouteStaffPolicy = 'skip' | 'optional' | 'required';

type WorkerRouteUnexpectedErrorPolicy =
  | 'internal'
  | 'public'
  | 'rpc'
  | 'profile'
  | 'stripe-webhook';

type WorkerRoutePolicy = Readonly<{
  commerceMutation: boolean;
  cors: WorkerRouteCorsPolicy;
  profileOriginGate: boolean;
  staff: WorkerRouteStaffPolicy;
  unexpectedError: WorkerRouteUnexpectedErrorPolicy;
}>;

type WorkerRouteContext = {
  defer: DeferredWork;
  dependencies: WorkerDependencies;
  env: Env;
  metrics: WorkerRequestMetrics;
  request: Request;
};

export type WorkerRouteResult = {
  response: Response;
  logFields?: Record<string, unknown>;
};

export type MatchedWorkerRoute = WorkerRoutePolicy & Readonly<{
  baseLogFields?: (metrics: WorkerRequestMetrics) => Record<string, unknown>;
  dispatch: (context: WorkerRouteContext) => Promise<WorkerRouteResult>;
  logRoute: string;
  packStatusDropId?: string | null;
}>;

type ExactWorkerRoute = MatchedWorkerRoute & Readonly<{ path: string }>;

const INTERNAL_POLICY: WorkerRoutePolicy = Object.freeze({
  commerceMutation: false,
  cors: 'none',
  profileOriginGate: false,
  staff: 'optional',
  unexpectedError: 'internal',
});

function profilePolicy(args: {
  commerceMutation?: boolean;
  profileOriginGate?: boolean;
  staff?: WorkerRouteStaffPolicy;
  cors?: 'profile' | 'staff-auth';
} = {}): WorkerRoutePolicy {
  return Object.freeze({
    commerceMutation: args.commerceMutation === true,
    cors: args.cors || 'profile',
    profileOriginGate: args.profileOriginGate !== false,
    staff: args.staff || 'optional',
    unexpectedError: 'profile',
  });
}

function exactRoute(
  path: string,
  policy: WorkerRoutePolicy,
  dispatch: MatchedWorkerRoute['dispatch'],
  logRoute = path,
  baseLogFields?: MatchedWorkerRoute['baseLogFields'],
): ExactWorkerRoute {
  return Object.freeze({ ...policy, baseLogFields, dispatch, logRoute, path });
}

function addMetrics(
  metrics: WorkerRequestMetrics,
  result: { metrics: { providerDurationMs: number; upstreamCalls: number } },
): void {
  metrics.providerDurationMs += result.metrics.providerDurationMs;
  metrics.upstreamCalls += result.metrics.upstreamCalls;
}

async function dispatchHealth(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  return {
    response: context.request.method === 'GET'
      ? jsonResponse({ ok: true }, 200)
      : jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET' }),
  };
}

async function dispatchAnonymousAuth(
  context: WorkerRouteContext,
  path: string,
): Promise<WorkerRouteResult> {
  return { response: await handleAnonymousAuthRequest(context.request, context.env, path) };
}

async function dispatchStaffAuth(
  context: WorkerRouteContext,
  path: StaffAuthPath,
): Promise<WorkerRouteResult> {
  return { response: await handleStaffAuthRequest(context.request, context.env, path) };
}

async function dispatchNotificationEnqueue(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  return {
    response: await handleNotificationEnqueue(
      context.request,
      context.env,
      { log: context.dependencies.log },
    ),
  };
}

async function dispatchStripeCheckout(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleStripeCheckoutSession(context.request, context.env);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { checkoutDropId: result.dropId } : {}),
      ...(result.mode ? { checkoutMode: result.mode } : {}),
    },
  };
}

async function dispatchStripeWebhook(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleStripeWebhookRequest(
    context.request,
    context.env,
    { log: context.dependencies.log },
  );
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      ...(result.eventId ? { webhookEventId: result.eventId } : {}),
      ...(result.eventType ? { webhookEventType: result.eventType } : {}),
      ...(result.outcome ? { webhookOutcome: result.outcome } : {}),
    },
  };
}

async function dispatchIrlClaim(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleIrlClaimPrepare(context.request, context.env);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { irlClaimDropId: result.dropId } : {}),
    },
  };
}

async function dispatchStripeReceiptClaim(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleStripeReceiptClaim(
    context.request,
    context.env,
    context.defer,
  );
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { stripeReceiptClaimDropId: result.dropId } : {}),
      ...(result.deliveryId === undefined ? {} : { stripeReceiptClaimDeliveryId: result.deliveryId }),
      ...(result.outcome ? { stripeReceiptClaimOutcome: result.outcome } : {}),
    },
  };
}

async function dispatchReceiptTransfer(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleReceiptTransferPrepare(context.request, context.env);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { receiptTransferDropId: result.dropId } : {}),
    },
  };
}

async function dispatchDeliveryPrepare(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleDeliveryPrepare(context.request, context.env);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { deliveryPrepareDropId: result.dropId } : {}),
    },
  };
}

async function dispatchDeliveryReceipt(
  context: WorkerRouteContext,
  path: typeof DELIVERY_RECEIPTS_ISSUE_PATH | typeof DELIVERY_RECEIPTS_RECOVER_PATH,
): Promise<WorkerRouteResult> {
  const result = await handleDeliveryReceiptRequest(
    context.request,
    context.env,
    path,
    context.defer,
  );
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { deliveryReceiptDropId: result.dropId } : {}),
      ...(result.deliveryId === undefined ? {} : { deliveryReceiptDeliveryId: result.deliveryId }),
      ...(result.verification ? { deliveryReceiptVerification: result.verification } : {}),
      ...(result.attempted === undefined ? {} : { deliveryRecoveryAttempted: result.attempted }),
      ...(result.recovered === undefined ? {} : { deliveryRecoveryRecovered: result.recovered }),
    },
  };
}

async function dispatchAdminIrlRedeemPrepare(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleAdminIrlRedeemPrepare(context.request, context.env);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { adminIrlRedeemPrepareDropId: result.dropId } : {}),
      ...(result.targetKind ? { adminIrlRedeemPrepareTargetKind: result.targetKind } : {}),
      ...(result.itemCount === undefined ? {} : { adminIrlRedeemPrepareItemCount: result.itemCount }),
    },
  };
}

async function dispatchAdminIrlRedeemFinalize(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleAdminIrlRedeemFinalize(
    context.request,
    context.env,
    context.defer,
  );
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { adminIrlRedeemFinalizeDropId: result.dropId } : {}),
      ...(result.targetKind ? { adminIrlRedeemFinalizeTargetKind: result.targetKind } : {}),
      ...(result.deliveryId === undefined ? {} : { adminIrlRedeemFinalizeDeliveryId: result.deliveryId }),
      ...(result.outcome ? { adminIrlRedeemFinalizeOutcome: result.outcome } : {}),
    },
  };
}

async function dispatchReveal(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleRevealDudes(
    context.request,
    context.env,
    context.defer,
  );
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { revealDropId: result.dropId } : {}),
      ...(result.boxAssetId ? { revealBoxAssetId: result.boxAssetId } : {}),
      ...(result.assignmentOutcome ? { revealAssignmentOutcome: result.assignmentOutcome } : {}),
      ...(result.transactionOutcome ? { revealTransactionOutcome: result.transactionOutcome } : {}),
    },
  };
}

async function dispatchProfileLifecycle(
  context: WorkerRouteContext,
  path: ProfileLifecyclePath,
): Promise<WorkerRouteResult> {
  const result = await handleProfileLifecycleRequest(context.request, context.env, path);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.mergedStripeDeliveryOrders === undefined
        ? {}
        : { mergedStripeDeliveryOrders: result.mergedStripeDeliveryOrders }),
    },
  };
}

async function dispatchProfileRead(
  context: WorkerRouteContext,
  path: ProfileReadPath,
): Promise<WorkerRouteResult> {
  const result = await handleProfileReadRequest(context.request, context.env, path);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.profileStateSections ? { profileStateSections: result.profileStateSections } : {}),
    },
  };
}

async function dispatchProfileWrite(
  context: WorkerRouteContext,
  path: ProfileWritePath,
): Promise<WorkerRouteResult> {
  const result = await handleProfileWriteRequest(context.request, context.env, path);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: { profileAuthOutcome: result.authOutcome },
  };
}

async function dispatchRpc(
  context: WorkerRouteContext,
  cluster: 'mainnet-beta' | 'devnet',
): Promise<WorkerRouteResult> {
  if (context.request.method !== 'POST') {
    return { response: handleRpcMethodNotAllowed(context.request) };
  }
  const result = await handleRpcPost(
    context.request,
    context.env,
    cluster,
    context.dependencies,
    context.metrics,
  );
  return {
    response: result.response,
    logFields: result.rpcMethod ? { rpcMethod: result.rpcMethod } : undefined,
  };
}

async function dispatchNotificationSubscription(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  return {
    response: context.request.method === 'POST'
      ? await handleNotificationSubscription(
          context.request,
          context.env,
          context.dependencies,
          context.metrics,
        )
      : handlePublicMethodNotAllowed(context.request),
  };
}

async function dispatchShopPost(
  context: WorkerRouteContext,
  path: '/inventory' | '/pending-open-boxes',
): Promise<WorkerRouteResult> {
  if (context.request.method !== 'POST') {
    return { response: handlePublicMethodNotAllowed(context.request) };
  }
  const result = await handlePost(
    context.request,
    context.env,
    path,
    context.dependencies,
    context.metrics,
  );
  return {
    response: result.response,
    logFields: {
      includeDevnet: result.includeDevnet,
    },
  };
}

async function dispatchNotFound(): Promise<WorkerRouteResult> {
  return { response: jsonResponse({ ok: false, error: 'not-found' }, 404) };
}

const EXACT_ROUTE_ENTRIES: readonly ExactWorkerRoute[] = [
  exactRoute('/health', INTERNAL_POLICY, dispatchHealth),
  exactRoute(NOTIFICATION_ENQUEUE_PATH, INTERNAL_POLICY, dispatchNotificationEnqueue),
  exactRoute(
    STRIPE_CHECKOUT_SESSION_PATH,
    profilePolicy({ commerceMutation: true }),
    dispatchStripeCheckout,
  ),
  exactRoute(
    STRIPE_WEBHOOK_PATH,
    Object.freeze({
      commerceMutation: true,
      cors: 'none',
      profileOriginGate: false,
      staff: 'optional',
      unexpectedError: 'stripe-webhook',
    }),
    dispatchStripeWebhook,
  ),
  exactRoute(
    IRL_CLAIM_PREPARE_PATH,
    profilePolicy({ commerceMutation: true }),
    dispatchIrlClaim,
  ),
  exactRoute(
    STRIPE_RECEIPT_CLAIM_PATH,
    profilePolicy({ commerceMutation: true }),
    dispatchStripeReceiptClaim,
  ),
  exactRoute(
    RECEIPT_TRANSFER_PREPARE_PATH,
    profilePolicy({ commerceMutation: true }),
    dispatchReceiptTransfer,
  ),
  exactRoute(
    DELIVERY_PREPARE_PATH,
    profilePolicy({ commerceMutation: true }),
    dispatchDeliveryPrepare,
  ),
  exactRoute(
    DELIVERY_RECEIPTS_ISSUE_PATH,
    profilePolicy({ commerceMutation: true }),
    (context) => dispatchDeliveryReceipt(context, DELIVERY_RECEIPTS_ISSUE_PATH),
  ),
  exactRoute(
    DELIVERY_RECEIPTS_RECOVER_PATH,
    profilePolicy({ commerceMutation: true }),
    (context) => dispatchDeliveryReceipt(context, DELIVERY_RECEIPTS_RECOVER_PATH),
  ),
  exactRoute(
    ADMIN_IRL_REDEEM_PREPARE_PATH,
    profilePolicy({ commerceMutation: true, staff: 'required' }),
    dispatchAdminIrlRedeemPrepare,
  ),
  exactRoute(
    ADMIN_IRL_REDEEM_FINALIZE_PATH,
    profilePolicy({ commerceMutation: true, staff: 'required' }),
    dispatchAdminIrlRedeemFinalize,
  ),
  exactRoute(
    REVEAL_DUDES_PATH,
    profilePolicy({ commerceMutation: true }),
    dispatchReveal,
  ),
  exactRoute(
    '/inventory',
    Object.freeze({
      commerceMutation: false,
      cors: 'public',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'public',
    }),
    (context) => dispatchShopPost(context, '/inventory'),
    '/inventory',
    (metrics) => ({
      expectedAssetIds: metrics.expectedAssetIds,
      expectedAssetRecoveryFailures: metrics.expectedAssetRecoveryFailures,
      expectedAssetResolved: metrics.expectedAssetResolved,
    }),
  ),
  exactRoute(
    '/pending-open-boxes',
    Object.freeze({
      commerceMutation: false,
      cors: 'public',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'public',
    }),
    (context) => dispatchShopPost(context, '/pending-open-boxes'),
  ),
  exactRoute(
    '/notifications/subscribe',
    Object.freeze({
      commerceMutation: false,
      cors: 'public',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'public',
    }),
    dispatchNotificationSubscription,
  ),
  exactRoute(
    '/rpc/mainnet-beta',
    Object.freeze({
      commerceMutation: false,
      cors: 'rpc',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'rpc',
    }),
    (context) => dispatchRpc(context, 'mainnet-beta'),
  ),
  exactRoute(
    '/rpc/devnet',
    Object.freeze({
      commerceMutation: false,
      cors: 'rpc',
      profileOriginGate: false,
      staff: 'skip',
      unexpectedError: 'rpc',
    }),
    (context) => dispatchRpc(context, 'devnet'),
  ),
  ...Array.from(ANONYMOUS_AUTH_PATHS, (path) => exactRoute(
    path,
    profilePolicy({ profileOriginGate: false }),
    (context) => dispatchAnonymousAuth(context, path),
  )),
  ...Array.from(STAFF_AUTH_PATHS, (path) => exactRoute(
    path,
    profilePolicy({ cors: 'staff-auth', profileOriginGate: false, staff: 'skip' }),
    (context) => dispatchStaffAuth(context, path as StaffAuthPath),
  )),
  ...Array.from(PROFILE_LIFECYCLE_PATHS, (path) => exactRoute(
    path,
    profilePolicy({ commerceMutation: path === PROFILE_RECONCILE_PATH }),
    (context) => dispatchProfileLifecycle(context, path as ProfileLifecyclePath),
  )),
  ...Array.from(PROFILE_READ_PATHS, (path) => exactRoute(
    path,
    profilePolicy({ staff: isStaffOnlyApiPath(path) ? 'required' : 'optional' }),
    (context) => dispatchProfileRead(context, path as ProfileReadPath),
  )),
  ...Array.from(PROFILE_WRITE_PATHS, (path) => exactRoute(
    path,
    profilePolicy({
      commerceMutation: path !== PROFILE_ADDRESSES_PATH,
      staff: isStaffOnlyApiPath(path) ? 'required' : 'optional',
    }),
    (context) => dispatchProfileWrite(context, path as ProfileWritePath),
  )),
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

function packStatusRoute(pathname: string): MatchedWorkerRoute | undefined {
  const dropId = packStatusDropIdFromPathname(pathname);
  if (dropId === undefined) return undefined;
  return Object.freeze({
    commerceMutation: false,
    cors: 'pack-status',
    profileOriginGate: false,
    staff: 'optional',
    unexpectedError: 'public',
    logRoute: '/pack-status/:dropId',
    packStatusDropId: dropId,
    baseLogFields: () => dropId ? { dropId } : {},
    async dispatch(context) {
      if (dropId === null) {
        return { response: jsonResponse({ ok: false, error: 'invalid-request' }, 400) };
      }
      if (context.request.method !== 'GET') {
        return {
          response: jsonResponse(
            { ok: false, error: 'method-not-allowed' },
            405,
            { Allow: 'GET, OPTIONS' },
          ),
        };
      }
      const result = await handlePackStatus(
        dropId,
        context.env,
        context.dependencies,
        context.defer,
      );
      return {
        response: result.response,
        logFields: {
          ...(result.cacheStatus ? { providerCacheStatus: result.cacheStatus } : {}),
        },
      };
    },
  });
}

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
    ? handlePublicPreflight(request)
    : handlePublicMethodNotAllowed(request);
}

export function workerRoutePreflightResponse(
  route: MatchedWorkerRoute,
  request: Request,
): Response | undefined {
  if (request.method !== 'OPTIONS') return undefined;
  if (route.cors === 'profile') return handleProfileCorsPreflight(request);
  if (route.cors === 'staff-auth') {
    return handleProfileCorsPreflight(request, isAllowedStaffAuthOrigin);
  }
  if (route.cors === 'public') return handlePublicPreflight(request);
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
  return route.cors === 'profile' || route.cors === 'staff-auth'
    ? applyProfileCors(request, response)
    : response;
}

function internalJsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function unexpectedWorkerRouteResponse(
  route: MatchedWorkerRoute,
  request: Request,
): Response {
  if (route.unexpectedError === 'rpc') return handleRpcInternalError(request);
  if (route.unexpectedError === 'public') {
    if (route.cors === 'pack-status') {
      return jsonResponse({ ok: false, error: 'provider-unavailable' }, 503);
    }
    const response = new Response(JSON.stringify({ ok: false, error: 'provider-unavailable' }), {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        Vary: 'Origin',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    const origin = publicRequestOrigin(request);
    return origin ? applyPublicCors(response, origin, 'POST, OPTIONS') : response;
  }
  if (route.unexpectedError === 'stripe-webhook') {
    return internalJsonResponse({
      received: true,
      error: 'Stripe webhook processing failed',
    }, 500);
  }
  if (route.unexpectedError === 'profile') {
    return applyProfileCors(request, jsonResponse({
      ok: false,
      error: { code: 'unavailable', message: 'Service is temporarily unavailable.' },
    }, 503));
  }
  return internalJsonResponse({ ok: false, error: 'internal' }, 500);
}
