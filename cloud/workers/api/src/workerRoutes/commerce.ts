import { handleStripeCheckoutSession, STRIPE_CHECKOUT_SESSION_PATH } from '../stripeCheckout.js';
import { handleStripeWebhookRequest, STRIPE_WEBHOOK_PATH } from '../stripeWebhook.js';
import { IRL_CLAIM_PREPARE_PATH, handleIrlClaimPrepare } from '../irlClaim.js';
import { RECEIPT_TRANSFER_PREPARE_PATH, handleReceiptTransferPrepare } from '../receiptTransfer.js';
import { STRIPE_RECEIPT_CLAIM_PATH } from '../stripeReceiptClaimRequest.js';
import {
  handleStripeReceiptClaimWorkflowLegacy,
  handleStripeReceiptClaimWorkflowStart,
  handleStripeReceiptClaimWorkflowStatus,
} from '../stripeReceiptClaimWorkflowRoutes.js';
import {
  STRIPE_RECEIPT_CLAIM_START_PATH,
  STRIPE_RECEIPT_CLAIM_STATUS_PATH,
} from '../../../../../shared/stripeReceiptClaimWorkflow.js';
import { DELIVERY_PREPARE_PATH, handleDeliveryPrepare } from '../deliveryPrepare.js';
import {
  DELIVERY_RECEIPTS_ISSUE_PATH,
  DELIVERY_RECEIPTS_RECOVER_PATH,
  handleDeliveryReceiptRequest,
} from '../deliveryReceipts.js';
import { REVEAL_DUDES_PATH, handleRevealDudes } from '../revealDudes.js';
import { handlePreorderRequest, PREORDER_PATHS } from '../preorders.js';
import {
  type WorkerRouteContext,
  type WorkerRouteResult,
  type ExactWorkerRoute,
  profilePolicy,
  exactRoute,
  addMetrics,
} from './support.js';

async function dispatchStripeCheckout(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleStripeCheckoutSession(context.request, context.env, context.authContext, {
    defer: context.defer,
  });
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
    { defer: context.defer, log: context.dependencies.log },
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
  const result = await handleIrlClaimPrepare(context.request, context.env, context.authContext);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { irlClaimDropId: result.dropId } : {}),
    },
  };
}

async function dispatchStripeReceiptClaim(
  context: WorkerRouteContext,
  handler = handleStripeReceiptClaimWorkflowLegacy,
): Promise<WorkerRouteResult> {
  const result = await handler(
    context.request,
    context.env,
    context.authContext,
  );
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { stripeReceiptClaimDropId: result.dropId } : {}),
      ...(result.deliveryId === undefined ? {} : { stripeReceiptClaimDeliveryId: result.deliveryId }),
      ...(result.outcome ? { stripeReceiptClaimOutcome: result.outcome } : {}),
      ...(result.operationId ? { stripeReceiptClaimOperationId: result.operationId } : {}),
    },
  };
}

async function dispatchReceiptTransfer(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleReceiptTransferPrepare(context.request, context.env, context.authContext, {
    defer: context.defer,
  });
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
  const result = await handleDeliveryPrepare(context.request, context.env, context.authContext, {
    defer: context.defer,
  });
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
    context.authContext,
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
      ...(result.recoveryMode ? { deliveryRecoveryMode: result.recoveryMode } : {}),
    },
  };
}

async function dispatchReveal(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleRevealDudes(
    context.request,
    context.env,
    context.defer,
    context.authContext,
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

export const commerceRoutes: readonly ExactWorkerRoute[] = [
  ...PREORDER_PATHS.map((path) => exactRoute(path, Object.freeze({
    commerceMutation: path !== '/preorders/availability', cors: 'mi-note', profileOriginGate: true,
    staff: 'optional', unexpectedError: 'profile',
  }), async (context) => {
    const result = await handlePreorderRequest(context.request, context.env, context.authContext, {
      cache: context.dependencies.cache, log: context.dependencies.log, providerFetch: context.dependencies.providerFetch,
    }, context.defer);
    addMetrics(context.metrics, result);
    return {
      response: result.response,
      logFields: { profileAuthOutcome: result.authOutcome },
    };
  })),
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
    STRIPE_RECEIPT_CLAIM_START_PATH,
    profilePolicy({ commerceMutation: true }),
    (context) => dispatchStripeReceiptClaim(context, handleStripeReceiptClaimWorkflowStart),
  ),
  exactRoute(
    STRIPE_RECEIPT_CLAIM_STATUS_PATH,
    profilePolicy(),
    (context) => dispatchStripeReceiptClaim(context, handleStripeReceiptClaimWorkflowStatus),
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
    REVEAL_DUDES_PATH,
    profilePolicy({ commerceMutation: true }),
    dispatchReveal,
  ),
];
