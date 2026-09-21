import {
  ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
  ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
  ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
  ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
  createAdminIrlRedeemFinalizeOperationId,
  isAdminIrlRedeemFinalizeOperationId,
  type AdminIrlRedeemFinalizeOperationId,
  type AdminIrlRedeemFinalizePendingResponse,
  type AdminIrlRedeemFinalizeRecovery,
} from '../../../../shared/contracts.js';
import {
  loadAdminIrlRedeemFinalizeWorkflowResult,
  readAdminIrlRedeemFinalizeRequest,
  resolveAdminIrlRedeemFinalizeStaffWallet,
  type AdminIrlRedeemFinalizeWorkflowReservation,
} from './adminIrlRedeemFinalize.js';
import {
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeWorkflowError,
  type AdminIrlRedeemFinalizeErrorCode,
  type AdminIrlRedeemFinalizeWorkflowOutput,
} from './adminIrlRedeemFinalizeWorkflowState.js';
import {
  loadAdminIrlRedeemFinalizeWorkflowOperation,
} from './adminIrlRedeemFinalizeWorkflowStore.js';
import {
  inspectAndReconcileAdminIrlRedeemFinalizeWorkflow,
  loadAdminIrlRedeemFinalizeDurableState,
  projectAdminIrlRedeemFinalizeStatusDecision,
  reconcileAdminIrlRedeemFinalizeInspection,
  type AdminIrlRedeemFinalizeLoadOperation,
  type AdminIrlRedeemFinalizeWorkflowReconciliation,
} from './adminIrlRedeemFinalizeWorkflowRecovery.js';
import {
  createRequestDeadline,
  isRequestCancellationError,
  raceWithSignal,
  readBoundedRequestJson,
} from './boundedRequest.js';
import {
  EnsureRunningError,
  ensureAdminIrlRedeemFinalizeWorkflowRunning,
  type AdminIrlRedeemFinalizeWorkflowStartDependencies,
} from './adminIrlRedeemFinalizeWorkflowStart.js';
import { CommerceRepositoryError } from './commerceRepository.js';
import { isRecord } from './dataAccess.js';
import {
  type RequestAuthContext,
  RequestIdentityError,
  isStaffRequestIdentity,
  verifyRequestIdentity,
} from './requestIdentity.js';
import { httpStatusForApiErrorCode, jsonResponse } from './httpResponse.js';

export { ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH };

const STATUS_MAX_BYTES = 256;
const EMPTY_METRICS = Object.freeze({ upstreamCalls: 0, providerDurationMs: 0 });
const TIMING_RESPONSE_HEADERS = Object.freeze({ 'Timing-Allow-Origin': '*' });

type LoadOperation = AdminIrlRedeemFinalizeLoadOperation;

type AdminIrlRedeemFinalizeWorkflowStartRouteDependencies = AdminIrlRedeemFinalizeWorkflowStartDependencies & Readonly<{
  createDeadline: typeof createRequestDeadline;
}>;

type AdminIrlRedeemFinalizeWorkflowStatusDependencies = Readonly<{
  createDeadline: typeof createRequestDeadline;
  loadOperation: LoadOperation;
}>;

const defaultStatusDependencies: AdminIrlRedeemFinalizeWorkflowStatusDependencies = {
  createDeadline: createRequestDeadline,
  loadOperation: loadAdminIrlRedeemFinalizeWorkflowOperation,
};

type RouteError = Readonly<{
  code: AdminIrlRedeemFinalizeErrorCode;
  message: string;
  recovery?: AdminIrlRedeemFinalizeRecovery;
}>;

export type AdminIrlRedeemFinalizeWorkflowRouteResult = Readonly<{
  response: Response;
  metrics: Readonly<{ upstreamCalls: number; providerDurationMs: number }>;
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  operationId?: string;
  dropId?: string;
  targetKind?: 'pack' | 'card_receipt';
  deliveryId?: number;
  outcome: string;
}>;

function failureResponse(error: RouteError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
    },
  }, httpStatusForApiErrorCode(error.code, 502), { headers: TIMING_RESPONSE_HEADERS });
}

function pendingResponse(operationId: AdminIrlRedeemFinalizeOperationId): Response {
  const body: AdminIrlRedeemFinalizePendingResponse = {
    accepted: true,
    operationId,
    status: 'pending',
    retryAfterMs: ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
  };
  return jsonResponse(body, 202, {
    headers: { ...TIMING_RESPONSE_HEADERS, 'Retry-After': '2' },
  });
}

function routeResult(
  response: Response,
  outcome: string,
  options: Partial<Omit<AdminIrlRedeemFinalizeWorkflowRouteResult, 'response' | 'metrics' | 'authOutcome' | 'outcome'>> &
    Readonly<{ authOutcome?: AdminIrlRedeemFinalizeWorkflowRouteResult['authOutcome'] }> = {},
): AdminIrlRedeemFinalizeWorkflowRouteResult {
  return {
    response,
    metrics: EMPTY_METRICS,
    authOutcome: options.authOutcome || 'accepted',
    outcome,
    ...(options.operationId ? { operationId: options.operationId } : {}),
    ...(options.dropId ? { dropId: options.dropId } : {}),
    ...(options.targetKind ? { targetKind: options.targetKind } : {}),
    ...(options.deliveryId === undefined ? {} : { deliveryId: options.deliveryId }),
  };
}

function authOutcomeForCode(
  code: AdminIrlRedeemFinalizeErrorCode,
): AdminIrlRedeemFinalizeWorkflowRouteResult['authOutcome'] {
  return ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted']
    .includes(code) ? 'rejected' : 'provider-failure';
}

function projectFailure(
  operationId: AdminIrlRedeemFinalizeOperationId,
  error: RouteError,
): AdminIrlRedeemFinalizeWorkflowRouteResult {
  return routeResult(failureResponse(error), error.code, {
    operationId,
    authOutcome: authOutcomeForCode(error.code),
  });
}

function workflowUnavailableError(): AdminIrlRedeemFinalizeError {
  return new AdminIrlRedeemFinalizeError(
    'unavailable',
    'Admin IRL redeem Workflow is temporarily unavailable.',
  );
}

async function projectPersistedCompletion(
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  reference: Extract<AdminIrlRedeemFinalizeWorkflowOutput, { ok: true }>['result'] | undefined,
  signal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeWorkflowRouteResult> {
  if (signal.aborted) throw signal.reason;
  const result = await raceWithSignal(loadAdminIrlRedeemFinalizeWorkflowResult({
    env,
    operationId,
    ...(reference ? { reference } : {}),
  }), signal);
  return routeResult(jsonResponse(result, 200, { headers: TIMING_RESPONSE_HEADERS }), 'succeeded', {
    operationId,
    dropId: result.dropId,
    targetKind: result.cards.length ? 'card_receipt' : 'pack',
    ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
  });
}

function recoveryErrorForReconciliation(
  reconciliation: AdminIrlRedeemFinalizeWorkflowReconciliation,
): RouteError {
  const failure = reconciliation.durable.state === 'failed'
    ? reconciliation.durable.failure
    : reconciliation.durable.state === 'manual-recovery'
      ? reconciliation.durable.failure
      : reconciliation.observation.state === 'retryable-failure'
        ? reconciliation.observation.error
        : workflowUnavailableError();
  return {
    code: failure.code,
    message: failure.message,
    recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
  };
}

async function projectReconciliation(
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  reconciliation: AdminIrlRedeemFinalizeWorkflowReconciliation,
  signal: AbortSignal,
  pendingDropId?: string,
): Promise<AdminIrlRedeemFinalizeWorkflowRouteResult> {
  if (reconciliation.decision === 'pending') {
    return routeResult(pendingResponse(operationId), 'pending', {
      operationId,
      ...(pendingDropId ? { dropId: pendingDropId } : {}),
    });
  }
  if (reconciliation.decision === 'not-found') {
    return projectFailure(operationId, {
      code: 'not-found',
      message: 'Admin IRL redeem Workflow operation not found.',
    });
  }
  if (reconciliation.decision === 'ensure-running') {
    return projectFailure(operationId, recoveryErrorForReconciliation(reconciliation));
  }
  if (reconciliation.decision === 'complete') {
    const reference = reconciliation.observation.state === 'succeeded'
      ? reconciliation.observation.output.result
      : undefined;
    return projectPersistedCompletion(env, operationId, reference, signal);
  }
  if (reconciliation.decision === 'terminal') {
    if (reconciliation.durable.state === 'manual-recovery') {
      return projectFailure(operationId, reconciliation.durable.failure);
    }
    if (reconciliation.durable.state === 'failed' && !reconciliation.durable.failure.retryable) {
      return projectFailure(operationId, reconciliation.durable.failure);
    }
    if (reconciliation.observation.state === 'retryable-failure') {
      return projectFailure(operationId, reconciliation.observation.error);
    }
    if (
      reconciliation.observation.state === 'terminal-failure' &&
      reconciliation.observation.error
    ) {
      return projectFailure(operationId, reconciliation.observation.error);
    }
    if (reconciliation.observation.state === 'terminated') {
      return projectFailure(operationId, {
        code: 'aborted',
        message: 'Admin IRL redeem Workflow operation was terminated.',
      });
    }
    if (
      reconciliation.durable.state === 'active-confirmed' &&
      reconciliation.observation.state === 'missing'
    ) {
      return projectFailure(operationId, {
        code: 'aborted',
        message: 'Admin IRL redeem Workflow operation is no longer available.',
      });
    }
    return projectFailure(operationId, {
      code: 'internal',
      message: 'Admin IRL redeem finalization failed unexpectedly.',
    });
  }
  return projectFailure(operationId, recoveryErrorForReconciliation(reconciliation));
}

function identityError(error: RequestIdentityError): AdminIrlRedeemFinalizeError {
  if (error.kind === 'invalid-token') {
    return new AdminIrlRedeemFinalizeError('unauthenticated', 'Authentication is required.');
  }
  if (error.kind === 'provider-timeout') {
    return new AdminIrlRedeemFinalizeError('deadline-exceeded', 'Authentication timed out.');
  }
  return new AdminIrlRedeemFinalizeError('unavailable', 'Authentication is temporarily unavailable.');
}

function methodNotAllowed(): AdminIrlRedeemFinalizeWorkflowRouteResult {
  return routeResult(
    jsonResponse(
      { ok: false, error: { code: 'invalid-argument', message: 'Method not allowed.' } },
      405,
      { headers: { ...TIMING_RESPONSE_HEADERS, Allow: 'POST, OPTIONS' } },
    ),
    'method-not-allowed',
    { authOutcome: 'rejected' },
  );
}

function completedReservationResult(
  operationId: AdminIrlRedeemFinalizeOperationId,
  reservation: Extract<AdminIrlRedeemFinalizeWorkflowReservation, { status: 'complete' }>,
): AdminIrlRedeemFinalizeWorkflowRouteResult {
  const result = reservation.result;
  return routeResult(jsonResponse(result, 200, { headers: TIMING_RESPONSE_HEADERS }), 'succeeded', {
    operationId,
    dropId: result.dropId,
    targetKind: result.cards.length ? 'card_receipt' : 'pack',
    ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
  });
}

export async function handleAdminIrlRedeemFinalizeWorkflowStart(
  request: Request,
  env: Env,
  authContext: RequestAuthContext = {},
  overrides: Partial<AdminIrlRedeemFinalizeWorkflowStartRouteDependencies> = {},
): Promise<AdminIrlRedeemFinalizeWorkflowRouteResult> {
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    return methodNotAllowed();
  }
  const { createDeadline = createRequestDeadline, ...startDependencies } = overrides;
  const deadline = createDeadline(request, {
    timeoutMs: ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
    timeoutMessage: 'Admin IRL redeem Workflow request timed out',
  });
  let operationId: AdminIrlRedeemFinalizeOperationId | undefined;
  try {
    const body = await readAdminIrlRedeemFinalizeRequest(request, deadline.signal);
    const identity = await verifyRequestIdentity(request, env.OPS_DB, deadline.signal, Date.now(), authContext);
    if (!isStaffRequestIdentity(identity)) {
      throw new AdminIrlRedeemFinalizeError('unauthenticated', 'Staff wallet authentication is required.');
    }
    const staffWallet = resolveAdminIrlRedeemFinalizeStaffWallet(identity);
    const computed = await createAdminIrlRedeemFinalizeOperationId([
      body.dropId,
      body.requestId,
      body.transferSignature,
      staffWallet,
    ]);
    if (!isAdminIrlRedeemFinalizeOperationId(computed)) {
      throw new AdminIrlRedeemFinalizeError('internal', 'Admin IRL redeem finalization failed unexpectedly.');
    }
    operationId = computed;
    const result = await ensureAdminIrlRedeemFinalizeWorkflowRunning({
      body,
      staffWallet,
      operationId,
      env,
      signal: deadline.signal,
      clientCancellation: {
        signal: request.signal,
        isCancellationError: (error) => isRequestCancellationError(request, error),
      },
    }, startDependencies);
    if (result.status === 'complete') return completedReservationResult(operationId, result);
    if (result.status === 'pending') {
      return routeResult(pendingResponse(operationId), 'pending', {
        operationId,
        dropId: body.dropId,
      });
    }
    return await projectReconciliation(env, operationId, result.reconciliation, deadline.signal, body.dropId);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    const normalized = deadline.timedOut()
      ? new AdminIrlRedeemFinalizeError('deadline-exceeded', 'Admin IRL redeem finalization timed out.')
      : error instanceof RequestIdentityError
        ? identityError(error)
        : error instanceof AdminIrlRedeemFinalizeError
          ? error
          : new AdminIrlRedeemFinalizeError(
              adminIrlRedeemFinalizeWorkflowError(error).code,
              adminIrlRedeemFinalizeWorkflowError(error).message,
            );
    const recovery = error instanceof EnsureRunningError ||
        (error instanceof CommerceRepositoryError && error.code === 'unavailable') ||
        deadline.timedOut() ||
        (error instanceof RequestIdentityError && error.kind !== 'invalid-token')
      ? ADMIN_IRL_REDEEM_FINALIZE_RECOVERY
      : undefined;
    return routeResult(failureResponse({
      code: normalized.code,
      message: normalized.message,
      ...(recovery ? { recovery } : {}),
    }), normalized.code, {
      ...(operationId ? { operationId } : {}),
      authOutcome: authOutcomeForCode(normalized.code),
    });
  } finally {
    deadline.dispose();
  }
}

async function readStatusOperationId(
  request: Request,
  signal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeOperationId> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: STATUS_MAX_BYTES,
    signal,
    createError: () => new AdminIrlRedeemFinalizeError(
      'invalid-argument',
      'Invalid Admin IRL redeem Workflow status request.',
    ),
  });
  if (
    !isRecord(value) || Object.keys(value).length !== 1 ||
    !isAdminIrlRedeemFinalizeOperationId(value.operationId)
  ) {
    throw new AdminIrlRedeemFinalizeError(
      'invalid-argument',
      'Invalid Admin IRL redeem Workflow status request.',
    );
  }
  return value.operationId;
}

export async function handleAdminIrlRedeemFinalizeWorkflowStatus(
  request: Request,
  env: Env,
  authContext: RequestAuthContext = {},
  overrides: Partial<AdminIrlRedeemFinalizeWorkflowStatusDependencies> = {},
): Promise<AdminIrlRedeemFinalizeWorkflowRouteResult> {
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    return methodNotAllowed();
  }
  const dependencies = { ...defaultStatusDependencies, ...overrides };
  const deadline = dependencies.createDeadline(request, {
    timeoutMs: ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
    timeoutMessage: 'Admin IRL redeem Workflow status request timed out',
  });
  let operationId: AdminIrlRedeemFinalizeOperationId | undefined;
  try {
    operationId = await readStatusOperationId(request, deadline.signal);
    const identity = await verifyRequestIdentity(request, env.OPS_DB, deadline.signal, Date.now(), authContext);
    if (!isStaffRequestIdentity(identity)) {
      throw new AdminIrlRedeemFinalizeError('unauthenticated', 'Staff wallet authentication is required.');
    }
    resolveAdminIrlRedeemFinalizeStaffWallet(identity);
    const durable = await loadAdminIrlRedeemFinalizeDurableState(
      env,
      operationId,
      dependencies.loadOperation,
      deadline.signal,
    );
    let reconciliation = durable.state === 'absent' || durable.state === 'complete' ||
        durable.state === 'effect-pending' || durable.state === 'restart-claim-pending' ||
        durable.state === 'restart-dispatch-pending' ||
        (durable.state === 'failed' && !durable.failure.retryable)
      ? reconcileAdminIrlRedeemFinalizeInspection(durable, { state: 'missing' })
      : await inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
          env,
          operationId,
          durable,
          dependencies.loadOperation,
          deadline.signal,
        );
    reconciliation = {
      ...reconciliation,
      decision: projectAdminIrlRedeemFinalizeStatusDecision(reconciliation),
    };
    return await projectReconciliation(env, operationId, reconciliation, deadline.signal);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    if (operationId && (
      deadline.timedOut() ||
      (error instanceof CommerceRepositoryError && error.code === 'unavailable') ||
      (error instanceof RequestIdentityError && error.kind !== 'invalid-token')
    )) {
      return routeResult(pendingResponse(operationId), 'pending-unavailable', {
        operationId,
        authOutcome: 'provider-failure',
      });
    }
    const normalized = deadline.timedOut()
      ? new AdminIrlRedeemFinalizeError(
          'deadline-exceeded',
          'Admin IRL redeem Workflow status request timed out.',
        )
      : error instanceof RequestIdentityError
        ? identityError(error)
        : error instanceof AdminIrlRedeemFinalizeError
          ? error
          : new AdminIrlRedeemFinalizeError(
              adminIrlRedeemFinalizeWorkflowError(error).code,
            adminIrlRedeemFinalizeWorkflowError(error).message,
          );
    const recovery = deadline.timedOut() ||
        (error instanceof RequestIdentityError && error.kind !== 'invalid-token')
      ? ADMIN_IRL_REDEEM_FINALIZE_RECOVERY
      : undefined;
    return routeResult(failureResponse({
      code: normalized.code,
      message: normalized.message,
      ...(recovery ? { recovery } : {}),
    }), normalized.code, {
      ...(operationId ? { operationId } : {}),
      authOutcome: authOutcomeForCode(normalized.code),
    });
  } finally {
    deadline.dispose();
  }
}
