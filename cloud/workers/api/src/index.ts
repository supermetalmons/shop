import { applyProfileCors } from './profileReads.js';
import {
  isStaffSessionAuthorization,
  StaffAuthError,
  verifyStaffSession,
} from './staffWalletAuth.js';
import {
  internalStaffAuthorization,
  isInternalStaffAuthorization,
} from './requestIdentity.js';
import { loadCommerceAuthorityControl } from './commerceRepository.js';
import {
  SCHEDULED_RECONCILIATION_TIMEOUT_MS,
  runScheduledReconciliations,
} from './workerScheduled.js';
import { processBackgroundJobBatch } from './workerBackgroundJobs.js';
import {
  defaultDependencies,
  jsonResponse,
  type WorkerDependencies,
  type WorkerRequestMetrics,
} from './workerPublicRoutes.js';
import {
  applyWorkerRouteCors,
  strictPublicOriginDeniedResponse,
  unexpectedWorkerRouteResponse,
  workerRouteBaseLogFields,
  workerRouteRegistry,
  workerRouteOriginDeniedResponse,
  workerRoutePreflightResponse,
  type MatchedWorkerRoute,
  type WorkerRouteResult,
} from './workerRoutes.js';
import { registerDeferredWork, type DeferredWork } from './deferredWork.js';
import {
  isRequestCancellationError,
  raceWithSignal,
} from './boundedRequest.js';

export { runScheduledReconciliations } from './workerScheduled.js';
export {
  processBackgroundJobBatch,
  processStripeFulfillmentMessage,
} from './workerBackgroundJobs.js';
export { sleepWithAbort } from './workerPublicRoutes.js';
export type { ProviderFetch } from './workerPublicRoutes.js';

type RequestExecution = {
  defer: DeferredWork;
  dependencies: WorkerDependencies;
  metrics: WorkerRequestMetrics;
  pathname: string;
  route: MatchedWorkerRoute;
  startedAt: number;
  terminalLog: (entry: Record<string, unknown>) => void;
};

function reportError(entry: Record<string, unknown>): void {
  try {
    console.error(entry);
  } catch {}
}

function reportInfo(entry: Record<string, unknown>): void {
  try {
    console.log(entry);
  } catch {}
}

function boundaryErrorSummary(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: 'UnknownError' };
  if (error.name !== 'DeferredWorkRegistrationError' || !(error.cause instanceof Error)) {
    return { name: error.name };
  }
  return {
    name: error.name,
    cause: { name: error.cause.name, message: error.cause.message },
  };
}

function cancelledRequestResult(
  logFields: Record<string, unknown> = {},
): WorkerRouteResult {
  return {
    response: new Response(null, {
      status: 499,
      headers: { 'Cache-Control': 'no-store' },
    }),
    logFields: { ...logFields, requestCancelled: true },
  };
}

function trackCancelledDispatch(
  request: Request,
  execution: RequestExecution,
  dispatch: Promise<WorkerRouteResult>,
): void {
  const tracked = dispatch.then(
    () => undefined,
    (error) => {
      if (isRequestCancellationError(request, error)) return;
      reportError({
        event: 'shop_api_cancelled_dispatch_failed',
        route: execution.route.logRoute,
        error: boundaryErrorSummary(error),
      });
    },
  );
  try {
    registerDeferredWork(execution.defer, tracked);
  } catch (error) {
    reportError({
      event: 'shop_api_cancelled_dispatch_registration_failed',
      route: execution.route.logRoute,
      error: boundaryErrorSummary(error),
    });
  }
}

function requestExecution(
  request: Request,
  defer: DeferredWork,
  dependencyOverrides: Partial<WorkerDependencies>,
): RequestExecution {
  const terminalLog = dependencyOverrides.log || defaultDependencies.log;
  const pathname = new URL(request.url).pathname;
  return {
    defer,
    dependencies: {
      ...defaultDependencies,
      ...dependencyOverrides,
      log: (entry) => {
        try {
          terminalLog(entry);
        } catch (error) {
          reportError({
            event: 'shop_api_route_log_failed',
            loggedEvent: typeof entry.event === 'string' ? entry.event : 'unknown',
            error: error instanceof Error ? { name: error.name } : { name: 'UnknownError' },
          });
        }
      },
    },
    metrics: {
      upstreamCalls: 0,
      providerDurationMs: 0,
      expectedAssetIds: 0,
      expectedAssetRecoveryFailures: 0,
      expectedAssetResolved: 0,
    },
    pathname,
    route: workerRouteRegistry.resolve(pathname),
    startedAt: performance.now(),
    terminalLog,
  };
}

function finalizeRequest(
  request: Request,
  execution: RequestExecution,
  response: Response,
  logFields: Record<string, unknown> = {},
): Response {
  const totalDurationMs = performance.now() - execution.startedAt;
  try {
    response.headers.set(
      'Server-Timing',
      `total;dur=${totalDurationMs.toFixed(1)}, provider;dur=${execution.metrics.providerDurationMs.toFixed(1)}`,
    );
  } catch {
    response = new Response(response.body, response);
    response.headers.set(
      'Server-Timing',
      `total;dur=${totalDurationMs.toFixed(1)}, provider;dur=${execution.metrics.providerDurationMs.toFixed(1)}`,
    );
  }
  try {
    execution.terminalLog({
      event: 'shop_api_request',
      route: execution.route.logRoute,
      method: request.method,
      status: response.status,
      durationMs: Math.round(totalDurationMs),
      providerDurationMs: Math.round(execution.metrics.providerDurationMs),
      upstreamCalls: execution.metrics.upstreamCalls,
      includeDevnet: false,
      ...logFields,
    });
  } catch (error) {
    reportError({
      event: 'shop_api_request_log_failed',
      route: execution.route.logRoute,
      error: error instanceof Error ? { name: error.name } : { name: 'UnknownError' },
    });
  }
  return response;
}

async function dispatchRequest(
  request: Request,
  env: Env,
  execution: RequestExecution,
): Promise<WorkerRouteResult> {
  const { defer, dependencies, metrics, pathname, route } = execution;
  if (request.signal.aborted) throw request.signal.reason;
  const strictOriginDenied = strictPublicOriginDeniedResponse(route, request);
  if (strictOriginDenied) return { response: strictOriginDenied };

  let staffAuthenticated = false;
  if (route.staff !== 'skip') {
    const authorization = request.headers.get('Authorization');
    if (isStaffSessionAuthorization(authorization)) {
      try {
        const staffSession = await raceWithSignal(
          verifyStaffSession(authorization, env.OPS_DB),
          request.signal,
        );
        staffAuthenticated = true;
        const headers = new Headers(request.headers);
        headers.set('Authorization', internalStaffAuthorization(staffSession.wallet));
        const authenticatedRequest = new Request(request, { headers });
        request = authenticatedRequest;
      } catch (error) {
        if (request.signal.aborted && error === request.signal.reason) throw error;
        if (error instanceof StaffAuthError && error.code === 'unauthenticated') {
          reportInfo({ event: 'staff_auth_request_rejected', route: pathname });
          return {
            response: applyProfileCors(request, jsonResponse({
              ok: false,
              error: { code: 'unauthenticated', message: 'Authentication is required.' },
            }, 401)),
            logFields: { profileAuthOutcome: 'rejected' },
          };
        }
        reportError({
          event: 'staff_auth_request_unavailable',
          route: pathname,
          error: error instanceof Error ? { name: error.name } : { name: 'UnknownError' },
        });
        return {
          response: applyProfileCors(request, jsonResponse({
            ok: false,
            error: {
              code: 'unavailable',
              message: 'Staff authentication is temporarily unavailable.',
            },
          }, 503)),
          logFields: { profileAuthOutcome: 'provider-failure' },
        };
      }
    } else if (isInternalStaffAuthorization(authorization)) {
      const headers = new Headers(request.headers);
      headers.delete('Authorization');
      const internalRequest = new Request(request, { headers });
      request = internalRequest;
    }
  }

  if (request.method !== 'OPTIONS' && route.staff === 'required' && !staffAuthenticated) {
    return {
      response: applyProfileCors(request, jsonResponse({
        ok: false,
        error: { code: 'unauthenticated', message: 'Staff wallet authentication is required.' },
      }, 401)),
      logFields: { profileAuthOutcome: 'rejected' },
    };
  }

  if (request.method === 'POST' && route.commerceMutation) {
    const authority = await raceWithSignal(
      loadCommerceAuthorityControl(env.COMMERCE_DB),
      request.signal,
    );
    if (authority.state === 'paused') {
      return {
        response: applyProfileCors(request, jsonResponse({
          ok: false,
          error: 'commerce-maintenance',
        }, 503, { 'Retry-After': '60' })),
      };
    }
  }

  const preflight = workerRoutePreflightResponse(route, request);
  if (preflight) {
    return { response: preflight, logFields: workerRouteBaseLogFields(route, metrics) };
  }

  const originDenied = workerRouteOriginDeniedResponse(route, request);
  if (originDenied) {
    return { response: originDenied, logFields: workerRouteBaseLogFields(route, metrics) };
  }

  const result = await route.dispatch({
    defer,
    dependencies,
    env,
    metrics,
    request,
  });
  return {
    ...result,
    logFields: { ...workerRouteBaseLogFields(route, metrics), ...result.logFields },
    response: applyWorkerRouteCors(route, request, result.response),
  };
}

export async function handleRequest(
  request: Request,
  env: Env,
  defer: DeferredWork,
  dependencyOverrides: Partial<WorkerDependencies> = {},
): Promise<Response> {
  const execution = requestExecution(request, defer, dependencyOverrides);
  const dispatch = dispatchRequest(request, env, execution);
  let dispatchTracked = false;
  const onAbort = () => {
    if (dispatchTracked) return;
    dispatchTracked = true;
    trackCancelledDispatch(request, execution, dispatch);
  };
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  let result: WorkerRouteResult;
  try {
    result = await raceWithSignal(dispatch, request.signal);
  } catch (error) {
    if (isRequestCancellationError(request, error)) {
      result = cancelledRequestResult();
    } else {
      reportError({
        event: 'shop_api_unhandled_error',
        route: execution.route.logRoute,
        error: boundaryErrorSummary(error),
      });
      result = { response: unexpectedWorkerRouteResponse(execution.route, request) };
    }
  } finally {
    request.signal.removeEventListener('abort', onAbort);
  }
  return finalizeRequest(request, execution, result.response, result.logFields);
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, (promise) => ctx.waitUntil(promise));
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
