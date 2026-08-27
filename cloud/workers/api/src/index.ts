import {
  handleRpcPost,
  handleRpcPreflight,
  handleRpcMethodNotAllowed,
} from './rpcProxy.js';
import {
  handleNotificationEnqueue,
  NOTIFICATION_ENQUEUE_PATH,
} from './notificationEnqueue.js';
import {
  STRIPE_CHECKOUT_SESSION_PATH,
  handleStripeCheckoutSession,
} from './stripeCheckout.js';
import {
  STRIPE_WEBHOOK_PATH,
  handleStripeWebhookRequest,
} from './stripeWebhook.js';
import {
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  applyProfileCors,
  handleProfileCorsPreflight,
  handleProfileReadRequest,
  isProfileRequestOriginAllowed,
  PROFILE_READ_PATHS,
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
  type ProfileReadPath,
} from './profileReads.js';
import {
  FULFILLMENT_ORDER_ADDRESS_PATH,
  FULFILLMENT_ORDER_STATUS_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
  FULFILLMENT_SHIPSTATION_RATES_PATH,
  FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
  PROFILE_ADDRESSES_PATH,
  PROFILE_WRITE_PATHS,
  handleProfileWriteRequest,
  type ProfileWritePath,
} from './profileWrites.js';
import {
  PROFILE_LIFECYCLE_PATHS,
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
  isStaffSessionAuthorization,
  verifyStaffSession,
  type StaffAuthPath,
} from './staffWalletAuth.js';
import {
  ANONYMOUS_AUTH_PATHS,
  handleAnonymousAuthRequest,
} from './anonymousAuth.js';
import {
  internalStaffAuthorization,
  isInternalStaffAuthorization,
  isStaffOnlyApiPath,
} from './requestIdentity.js';
import { loadCommerceAuthorityControl } from './commerceRepository.js';
import {
  SCHEDULED_RECONCILIATION_TIMEOUT_MS,
  runScheduledReconciliations,
} from './workerScheduled.js';
import { processBackgroundJobBatch } from './workerBackgroundJobs.js';
import {
  CORS_HEADERS,
  defaultDependencies,
  handleNotificationSubscription,
  handlePackStatus,
  handlePost,
  jsonResponse,
  packStatusDropIdFromPathname,
  type WorkerDependencies,
  type WorkerRequestMetrics,
} from './workerPublicRoutes.js';

export { runScheduledReconciliations } from './workerScheduled.js';
export {
  processBackgroundJobBatch,
  processStripeFulfillmentMessage,
} from './workerBackgroundJobs.js';
export { sleepWithAbort } from './workerPublicRoutes.js';
export type { ProviderFetch } from './workerPublicRoutes.js';

const COMMERCE_MUTATION_PATHS = new Set([
  STRIPE_CHECKOUT_SESSION_PATH,
  STRIPE_WEBHOOK_PATH,
  IRL_CLAIM_PREPARE_PATH,
  STRIPE_RECEIPT_CLAIM_PATH,
  RECEIPT_TRANSFER_PREPARE_PATH,
  DELIVERY_PREPARE_PATH,
  DELIVERY_RECEIPTS_ISSUE_PATH,
  DELIVERY_RECEIPTS_RECOVER_PATH,
  ADMIN_IRL_REDEEM_PREPARE_PATH,
  ADMIN_IRL_REDEEM_FINALIZE_PATH,
  REVEAL_DUDES_PATH,
  '/profile/reconcile',
  ...Array.from(PROFILE_WRITE_PATHS).filter((path) => path !== PROFILE_ADDRESSES_PATH),
]);
const KNOWN_LOG_ROUTES = new Set([
  '/health',
  NOTIFICATION_ENQUEUE_PATH,
  STRIPE_CHECKOUT_SESSION_PATH,
  STRIPE_WEBHOOK_PATH,
  '/inventory',
  '/notifications/subscribe',
  '/pack-status/:dropId',
  '/pending-open-boxes',
  '/rpc/mainnet-beta',
  '/rpc/devnet',
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
  PROFILE_ADDRESSES_PATH,
  FULFILLMENT_ORDER_ADDRESS_PATH,
  FULFILLMENT_ORDER_STATUS_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
  FULFILLMENT_SHIPSTATION_RATES_PATH,
  FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
  '/auth/solana',
  '/profile/reconcile',
  ...ANONYMOUS_AUTH_PATHS,
  IRL_CLAIM_PREPARE_PATH,
  STRIPE_RECEIPT_CLAIM_PATH,
  RECEIPT_TRANSFER_PREPARE_PATH,
  DELIVERY_PREPARE_PATH,
  DELIVERY_RECEIPTS_ISSUE_PATH,
  DELIVERY_RECEIPTS_RECOVER_PATH,
  ADMIN_IRL_REDEEM_PREPARE_PATH,
  ADMIN_IRL_REDEEM_FINALIZE_PATH,
  REVEAL_DUDES_PATH,
  ...STAFF_AUTH_PATHS,
]);

export async function handleRequest(
  request: Request,
  env: Env,
  dependencyOverrides: Partial<WorkerDependencies> = {},
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const startedAt = performance.now();
  const metrics: WorkerRequestMetrics = {
    upstreamCalls: 0,
    providerDurationMs: 0,
    expectedAssetIds: 0,
    expectedAssetRecoveryFailures: 0,
    expectedAssetResolved: 0,
  };
  const pathname = new URL(request.url).pathname;
  let staffAuthenticated = false;
  if (!STAFF_AUTH_PATHS.has(pathname)) {
    const authorization = request.headers.get('Authorization');
    if (isStaffSessionAuthorization(authorization)) {
      try {
        const staffSession = await verifyStaffSession(authorization, env.OPS_DB);
        staffAuthenticated = true;
        const headers = new Headers(request.headers);
        headers.set('Authorization', internalStaffAuthorization(staffSession.wallet));
        request = new Request(request, { headers });
      } catch {
        console.log({ event: 'staff_auth_request_rejected', route: pathname });
        return applyProfileCors(request, jsonResponse({
          ok: false,
          error: { code: 'unauthenticated', message: 'Authentication is required.' },
        }, 401));
      }
    } else if (isInternalStaffAuthorization(authorization)) {
      const headers = new Headers(request.headers);
      headers.delete('Authorization');
      request = new Request(request, { headers });
    }
  }
  if (request.method !== 'OPTIONS' && isStaffOnlyApiPath(pathname) && !staffAuthenticated) {
    const durationMs = Math.round(performance.now() - startedAt);
    dependencies.log({
      event: 'shop_api_request',
      route: KNOWN_LOG_ROUTES.has(pathname) ? pathname : 'not-found',
      method: request.method,
      status: 401,
      durationMs,
      providerDurationMs: 0,
      upstreamCalls: 0,
      includeDevnet: false,
      profileAuthOutcome: 'rejected',
    });
    return applyProfileCors(request, jsonResponse({
      ok: false,
      error: { code: 'unauthenticated', message: 'Staff wallet authentication is required.' },
    }, 401));
  }
  if (request.method === 'POST' && COMMERCE_MUTATION_PATHS.has(pathname)) {
    const authority = await loadCommerceAuthorityControl(env.COMMERCE_DB);
    if (authority.state === 'paused') {
      return applyProfileCors(request, jsonResponse({
        ok: false,
        error: 'commerce-maintenance',
      }, 503, { 'Retry-After': '60' }));
    }
  }
  const packStatusDropId = packStatusDropIdFromPathname(pathname);
  const isPackStatusRoute = packStatusDropId !== undefined;
  let includeDevnet = false;
  let providerCacheStatus: string | undefined;
  let profileAuthOutcome: string | undefined;
  let profileStateSections: { profile: string; shipments: string } | undefined;
  let mergedStripeDeliveryOrders: number | undefined;
  let rpcMethod: string | undefined;
  let checkoutDropId: string | undefined;
  let checkoutMode: string | undefined;
  let irlClaimDropId: string | undefined;
  let stripeReceiptClaimDropId: string | undefined;
  let stripeReceiptClaimDeliveryId: number | undefined;
  let stripeReceiptClaimOutcome: string | undefined;
  let receiptTransferDropId: string | undefined;
  let deliveryPrepareDropId: string | undefined;
  let deliveryReceiptDropId: string | undefined;
  let deliveryReceiptDeliveryId: number | undefined;
  let deliveryReceiptVerification: string | undefined;
  let deliveryRecoveryAttempted: number | undefined;
  let deliveryRecoveryRecovered: number | undefined;
  let adminIrlRedeemPrepareDropId: string | undefined;
  let adminIrlRedeemPrepareTargetKind: string | undefined;
  let adminIrlRedeemPrepareItemCount: number | undefined;
  let adminIrlRedeemFinalizeDropId: string | undefined;
  let adminIrlRedeemFinalizeTargetKind: string | undefined;
  let adminIrlRedeemFinalizeDeliveryId: number | undefined;
  let adminIrlRedeemFinalizeOutcome: string | undefined;
  let revealDropId: string | undefined;
  let revealBoxAssetId: string | undefined;
  let revealAssignmentOutcome: string | undefined;
  let revealTransactionOutcome: string | undefined;
  let webhookEventId: string | undefined;
  let webhookEventType: string | undefined;
  let webhookOutcome: string | undefined;
  let response: Response;
  const rpcCluster = pathname === '/rpc/mainnet-beta'
    ? 'mainnet-beta'
    : pathname === '/rpc/devnet' ? 'devnet' : null;
  const profilePath = PROFILE_READ_PATHS.has(pathname) ? pathname as ProfileReadPath : null;
  const profileWritePath = PROFILE_WRITE_PATHS.has(pathname) ? pathname as ProfileWritePath : null;
  const profileLifecyclePath = PROFILE_LIFECYCLE_PATHS.has(pathname) ? pathname as ProfileLifecyclePath : null;
  if (request.method === 'OPTIONS' && ANONYMOUS_AUTH_PATHS.has(pathname)) {
    response = handleProfileCorsPreflight(request);
  } else if (request.method === 'OPTIONS' && STAFF_AUTH_PATHS.has(pathname)) {
    response = handleProfileCorsPreflight(request, isAllowedStaffAuthOrigin);
  } else if (request.method === 'OPTIONS' && (
    profilePath ||
    profileWritePath ||
    profileLifecyclePath ||
    pathname === STRIPE_CHECKOUT_SESSION_PATH ||
    pathname === IRL_CLAIM_PREPARE_PATH ||
    pathname === STRIPE_RECEIPT_CLAIM_PATH ||
    pathname === RECEIPT_TRANSFER_PREPARE_PATH ||
    pathname === DELIVERY_PREPARE_PATH ||
    pathname === DELIVERY_RECEIPTS_ISSUE_PATH ||
    pathname === DELIVERY_RECEIPTS_RECOVER_PATH ||
    pathname === ADMIN_IRL_REDEEM_PREPARE_PATH ||
    pathname === ADMIN_IRL_REDEEM_FINALIZE_PATH ||
    pathname === REVEAL_DUDES_PATH
  )) {
    response = handleProfileCorsPreflight(request);
  } else if (request.method === 'OPTIONS' && rpcCluster) {
    response = handleRpcPreflight(request);
  } else if (request.method === 'OPTIONS' && (
    pathname === '/inventory' ||
    pathname === '/notifications/subscribe' ||
    pathname === '/pending-open-boxes' ||
    (isPackStatusRoute && packStatusDropId !== null)
  )) {
    response = new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', 'Timing-Allow-Origin': '*' } });
  } else if (isPackStatusRoute) {
    if (packStatusDropId === null) {
      response = jsonResponse({ ok: false, error: 'invalid-request' }, 400);
    } else if (request.method !== 'GET') {
      response = jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET, OPTIONS' });
    } else {
      const result = await handlePackStatus(packStatusDropId, env, dependencies, waitUntil);
      response = result.response;
      providerCacheStatus = result.cacheStatus;
    }
  } else if (pathname === '/health') {
    response = request.method === 'GET'
      ? jsonResponse({ ok: true }, 200)
      : jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'GET' });
  } else if (ANONYMOUS_AUTH_PATHS.has(pathname)) {
    response = applyProfileCors(
      request,
      await handleAnonymousAuthRequest(request, env, pathname),
    );
  } else if (STAFF_AUTH_PATHS.has(pathname)) {
    response = applyProfileCors(
      request,
      await handleStaffAuthRequest(request, env, pathname as StaffAuthPath),
    );
  } else if (pathname === NOTIFICATION_ENQUEUE_PATH) {
    response = await handleNotificationEnqueue(request, env, { log: dependencies.log });
  } else if (pathname === STRIPE_CHECKOUT_SESSION_PATH) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleStripeCheckoutSession(request, env);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      checkoutDropId = result.dropId;
      checkoutMode = result.mode;
      response = applyProfileCors(request, result.response);
    }
  } else if (pathname === STRIPE_WEBHOOK_PATH) {
    const result = await handleStripeWebhookRequest(request, env, { log: dependencies.log });
    metrics.upstreamCalls += result.metrics.upstreamCalls;
    metrics.providerDurationMs += result.metrics.providerDurationMs;
    webhookEventId = result.eventId;
    webhookEventType = result.eventType;
    webhookOutcome = result.outcome;
    response = result.response;
  } else if (pathname === IRL_CLAIM_PREPARE_PATH) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleIrlClaimPrepare(request, env);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      irlClaimDropId = result.dropId;
      response = applyProfileCors(request, result.response);
    }
  } else if (pathname === STRIPE_RECEIPT_CLAIM_PATH) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleStripeReceiptClaim(
        request,
        env,
        (promise) => {
          if (waitUntil) waitUntil(promise);
          else void promise;
        },
      );
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      stripeReceiptClaimDropId = result.dropId;
      stripeReceiptClaimDeliveryId = result.deliveryId;
      stripeReceiptClaimOutcome = result.outcome;
      response = applyProfileCors(request, result.response);
    }
  } else if (pathname === RECEIPT_TRANSFER_PREPARE_PATH) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleReceiptTransferPrepare(request, env);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      receiptTransferDropId = result.dropId;
      response = applyProfileCors(request, result.response);
    }
  } else if (pathname === DELIVERY_PREPARE_PATH) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleDeliveryPrepare(request, env);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      deliveryPrepareDropId = result.dropId;
      response = applyProfileCors(request, result.response);
    }
  } else if (pathname === DELIVERY_RECEIPTS_ISSUE_PATH || pathname === DELIVERY_RECEIPTS_RECOVER_PATH) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleDeliveryReceiptRequest(
        request,
        env,
        pathname,
        (promise) => {
          if (waitUntil) waitUntil(promise);
          else void promise;
        },
      );
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      deliveryReceiptDropId = result.dropId;
      deliveryReceiptDeliveryId = result.deliveryId;
      deliveryReceiptVerification = result.verification;
      deliveryRecoveryAttempted = result.attempted;
      deliveryRecoveryRecovered = result.recovered;
      response = applyProfileCors(request, result.response);
    }
  } else if (pathname === ADMIN_IRL_REDEEM_PREPARE_PATH) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleAdminIrlRedeemPrepare(request, env);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      adminIrlRedeemPrepareDropId = result.dropId;
      adminIrlRedeemPrepareTargetKind = result.targetKind;
      adminIrlRedeemPrepareItemCount = result.itemCount;
      response = applyProfileCors(request, result.response);
    }
  } else if (pathname === ADMIN_IRL_REDEEM_FINALIZE_PATH) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleAdminIrlRedeemFinalize(
        request,
        env,
        (promise) => {
          if (waitUntil) waitUntil(promise);
          else void promise;
        },
      );
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      adminIrlRedeemFinalizeDropId = result.dropId;
      adminIrlRedeemFinalizeTargetKind = result.targetKind;
      adminIrlRedeemFinalizeDeliveryId = result.deliveryId;
      adminIrlRedeemFinalizeOutcome = result.outcome;
      response = applyProfileCors(request, result.response);
    }
  } else if (pathname === REVEAL_DUDES_PATH) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleRevealDudes(request, env, {}, waitUntil);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      revealDropId = result.dropId;
      revealBoxAssetId = result.boxAssetId;
      revealAssignmentOutcome = result.assignmentOutcome;
      revealTransactionOutcome = result.transactionOutcome;
      response = applyProfileCors(request, result.response);
    }
  } else if (profileLifecyclePath) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleProfileLifecycleRequest(request, env, profileLifecyclePath);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      mergedStripeDeliveryOrders = result.mergedStripeDeliveryOrders;
      response = applyProfileCors(request, result.response);
    }
  } else if (profilePath) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleProfileReadRequest(request, env, profilePath);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      profileStateSections = result.profileStateSections;
      response = applyProfileCors(request, result.response);
    }
  } else if (profileWritePath) {
    if (!isProfileRequestOriginAllowed(request)) {
      response = applyProfileCors(request, new Response(null));
    } else {
      const result = await handleProfileWriteRequest(request, env, profileWritePath);
      metrics.upstreamCalls += result.metrics.upstreamCalls;
      metrics.providerDurationMs += result.metrics.providerDurationMs;
      profileAuthOutcome = result.authOutcome;
      response = applyProfileCors(request, result.response);
    }
  } else if (rpcCluster) {
    if (request.method !== 'POST') {
      response = handleRpcMethodNotAllowed(request);
    } else {
      const result = await handleRpcPost(
        request,
        env,
        rpcCluster,
        dependencies,
        metrics,
      );
      response = result.response;
      rpcMethod = result.rpcMethod;
    }
  } else if (pathname === '/notifications/subscribe') {
    response = request.method === 'POST'
      ? await handleNotificationSubscription(request, env, dependencies, metrics)
      : jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'POST, OPTIONS' });
  } else if (pathname === '/inventory' || pathname === '/pending-open-boxes') {
    if (request.method !== 'POST') {
      response = jsonResponse({ ok: false, error: 'method-not-allowed' }, 405, { Allow: 'POST, OPTIONS' });
    } else {
      const result = await handlePost(request, env, pathname, dependencies, metrics);
      response = result.response;
      includeDevnet = result.includeDevnet;
    }
  } else {
    response = jsonResponse({ ok: false, error: 'not-found' }, 404);
  }
  const totalDurationMs = performance.now() - startedAt;
  response.headers.set('Server-Timing', `total;dur=${totalDurationMs.toFixed(1)}, provider;dur=${metrics.providerDurationMs.toFixed(1)}`);
  const logRoute = isPackStatusRoute ? '/pack-status/:dropId' : KNOWN_LOG_ROUTES.has(pathname) ? pathname : 'not-found';
  dependencies.log({
    event: 'shop_api_request',
    route: logRoute,
    method: request.method,
    status: response.status,
    durationMs: Math.round(totalDurationMs),
    providerDurationMs: Math.round(metrics.providerDurationMs),
    upstreamCalls: metrics.upstreamCalls,
    includeDevnet,
    ...(packStatusDropId ? { dropId: packStatusDropId } : {}),
    ...(providerCacheStatus ? { providerCacheStatus } : {}),
    ...(pathname === '/inventory' ? {
      expectedAssetIds: metrics.expectedAssetIds,
      expectedAssetRecoveryFailures: metrics.expectedAssetRecoveryFailures,
      expectedAssetResolved: metrics.expectedAssetResolved,
    } : {}),
    ...(rpcMethod ? { rpcMethod } : {}),
    ...(checkoutDropId ? { checkoutDropId } : {}),
    ...(checkoutMode ? { checkoutMode } : {}),
    ...(irlClaimDropId ? { irlClaimDropId } : {}),
    ...(stripeReceiptClaimDropId ? { stripeReceiptClaimDropId } : {}),
    ...(stripeReceiptClaimDeliveryId === undefined ? {} : { stripeReceiptClaimDeliveryId }),
    ...(stripeReceiptClaimOutcome ? { stripeReceiptClaimOutcome } : {}),
    ...(receiptTransferDropId ? { receiptTransferDropId } : {}),
    ...(deliveryPrepareDropId ? { deliveryPrepareDropId } : {}),
    ...(deliveryReceiptDropId ? { deliveryReceiptDropId } : {}),
    ...(deliveryReceiptDeliveryId === undefined ? {} : { deliveryReceiptDeliveryId }),
    ...(deliveryReceiptVerification ? { deliveryReceiptVerification } : {}),
    ...(deliveryRecoveryAttempted === undefined ? {} : { deliveryRecoveryAttempted }),
    ...(deliveryRecoveryRecovered === undefined ? {} : { deliveryRecoveryRecovered }),
    ...(adminIrlRedeemPrepareDropId ? { adminIrlRedeemPrepareDropId } : {}),
    ...(adminIrlRedeemPrepareTargetKind ? { adminIrlRedeemPrepareTargetKind } : {}),
    ...(adminIrlRedeemPrepareItemCount === undefined ? {} : { adminIrlRedeemPrepareItemCount }),
    ...(adminIrlRedeemFinalizeDropId ? { adminIrlRedeemFinalizeDropId } : {}),
    ...(adminIrlRedeemFinalizeTargetKind ? { adminIrlRedeemFinalizeTargetKind } : {}),
    ...(adminIrlRedeemFinalizeDeliveryId === undefined ? {} : { adminIrlRedeemFinalizeDeliveryId }),
    ...(adminIrlRedeemFinalizeOutcome ? { adminIrlRedeemFinalizeOutcome } : {}),
    ...(revealDropId ? { revealDropId } : {}),
    ...(revealBoxAssetId ? { revealBoxAssetId } : {}),
    ...(revealAssignmentOutcome ? { revealAssignmentOutcome } : {}),
    ...(revealTransactionOutcome ? { revealTransactionOutcome } : {}),
    ...(webhookEventId ? { webhookEventId } : {}),
    ...(webhookEventType ? { webhookEventType } : {}),
    ...(webhookOutcome ? { webhookOutcome } : {}),
    ...(profileAuthOutcome ? { profileAuthOutcome } : {}),
    ...(profileStateSections ? { profileStateSections } : {}),
    ...(mergedStripeDeliveryOrders === undefined ? {} : { mergedStripeDeliveryOrders }),
  });
  return response;
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, {}, (promise) => ctx.waitUntil(promise));
  },
  queue(batch, env) {
    return processBackgroundJobBatch(batch, env);
  },
  async scheduled(_controller, env) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Scheduled reconciliation timed out', 'TimeoutError')),
      SCHEDULED_RECONCILIATION_TIMEOUT_MS,
    );
    try {
      await runScheduledReconciliations(env, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  },
} satisfies ExportedHandler<Env, unknown>;
