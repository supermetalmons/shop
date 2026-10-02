import {
  handleStripeChargebackBackfill,
  STRIPE_CHARGEBACK_BACKFILL_PATH,
} from '../stripeChargebackBackfill.js';
import { handleStaffReadRequest, STAFF_READ_PATHS, type StaffReadPath } from '../staffReads.js';
import { ADMIN_IRL_REDEEM_PREPARE_PATH, handleAdminIrlRedeemPrepare } from '../adminIrlRedeemPrepare.js';
import { ADMIN_IRL_REDEEM_FINALIZE_PATH } from '../adminIrlRedeemFinalize.js';
import {
  ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
  handleAdminIrlRedeemFinalizeWorkflowStart,
  handleAdminIrlRedeemFinalizeWorkflowStatus,
} from '../adminIrlRedeemFinalizeWorkflowRoutes.js';
import {
  type WorkerRouteContext,
  type WorkerRouteResult,
  type ExactWorkerRoute,
  profilePolicy,
  exactRoute,
  addMetrics,
} from './support.js';

async function dispatchStripeChargebackBackfill(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleStripeChargebackBackfill(context.request, context.env, context.authContext, {
    defer: context.defer,
  });
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.mode ? { stripeChargebackMode: result.mode } : {}),
      ...(result.write === undefined ? {} : { stripeChargebackWrite: result.write }),
      ...(result.failures === undefined ? {} : { stripeChargebackFailures: result.failures }),
    },
  };
}

async function dispatchAdminIrlRedeemPrepare(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleAdminIrlRedeemPrepare(context.request, context.env, context.authContext, {
    defer: context.defer,
  });
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
  const result = await handleAdminIrlRedeemFinalizeWorkflowStart(
    context.request,
    context.env,
    context.authContext,
  );
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { adminIrlRedeemFinalizeDropId: result.dropId } : {}),
      ...(result.targetKind ? { adminIrlRedeemFinalizeTargetKind: result.targetKind } : {}),
      ...(result.deliveryId === undefined ? {} : { adminIrlRedeemFinalizeDeliveryId: result.deliveryId }),
      ...(result.operationId ? { adminIrlRedeemFinalizeOperationId: result.operationId } : {}),
      ...(result.outcome ? { adminIrlRedeemFinalizeOutcome: result.outcome } : {}),
    },
  };
}

async function dispatchAdminIrlRedeemFinalizeStatus(context: WorkerRouteContext): Promise<WorkerRouteResult> {
  const result = await handleAdminIrlRedeemFinalizeWorkflowStatus(
    context.request,
    context.env,
    context.authContext,
  );
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: {
      profileAuthOutcome: result.authOutcome,
      ...(result.dropId ? { adminIrlRedeemFinalizeDropId: result.dropId } : {}),
      ...(result.targetKind ? { adminIrlRedeemFinalizeTargetKind: result.targetKind } : {}),
      ...(result.deliveryId === undefined ? {} : { adminIrlRedeemFinalizeDeliveryId: result.deliveryId }),
      ...(result.operationId ? { adminIrlRedeemFinalizeOperationId: result.operationId } : {}),
      ...(result.outcome ? { adminIrlRedeemFinalizeOutcome: result.outcome } : {}),
    },
  };
}

async function dispatchStaffRead(
  context: WorkerRouteContext,
  path: StaffReadPath,
): Promise<WorkerRouteResult> {
  const result = await handleStaffReadRequest(context.request, context.env, path, context.authContext);
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: { profileAuthOutcome: result.authOutcome },
  };
}

export const staffRoutes: readonly ExactWorkerRoute[] = [
  exactRoute(
    STRIPE_CHARGEBACK_BACKFILL_PATH,
    profilePolicy({ commerceMutation: true, staff: 'required' }),
    dispatchStripeChargebackBackfill,
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
    ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
    profilePolicy({ staff: 'required' }),
    dispatchAdminIrlRedeemFinalizeStatus,
  ),
  ...Array.from(STAFF_READ_PATHS, (path) => exactRoute(
    path,
    profilePolicy({ staff: 'required' }),
    (context) => dispatchStaffRead(context, path),
  )),
];
