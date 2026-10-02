import { handleProfileReadRequest, PROFILE_READ_PATHS, type ProfileReadPath } from '../profileReads.js';
import {
  PROFILE_ADDRESSES_PATH,
  PROFILE_WRITE_PATHS,
  handleProfileWriteRequest,
  type ProfileWritePath,
} from '../profileWrites.js';
import {
  PROFILE_LIFECYCLE_PATHS,
  PROFILE_RECONCILE_PATH,
  handleProfileLifecycleRequest,
  type ProfileLifecyclePath,
} from '../profileLifecycle.js';
import { isStaffOnlyApiPath } from '../requestIdentity.js';
import {
  type WorkerRouteContext,
  type WorkerRouteResult,
  type ExactWorkerRoute,
  profilePolicy,
  exactRoute,
  addMetrics,
} from './support.js';

async function dispatchProfileLifecycle(
  context: WorkerRouteContext,
  path: ProfileLifecyclePath,
): Promise<WorkerRouteResult> {
  const result = await handleProfileLifecycleRequest(context.request, context.env, path, context.authContext, {
    defer: context.defer,
  });
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
  const result = await handleProfileReadRequest(context.request, context.env, path, context.authContext);
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
  const result = await handleProfileWriteRequest(context.request, context.env, path, context.authContext, {
    defer: context.defer,
  });
  addMetrics(context.metrics, result);
  return {
    response: result.response,
    logFields: { profileAuthOutcome: result.authOutcome },
  };
}

export const profileRoutes: readonly ExactWorkerRoute[] = [
  ...Array.from(PROFILE_LIFECYCLE_PATHS, (path) => exactRoute(
    path,
    profilePolicy({ commerceMutation: path === PROFILE_RECONCILE_PATH }),
    (context) => dispatchProfileLifecycle(context, path as ProfileLifecyclePath),
  )),
  ...Array.from(PROFILE_READ_PATHS, (path) => exactRoute(
    path,
    profilePolicy({ staff: 'optional' }),
    (context) => dispatchProfileRead(context, path),
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
