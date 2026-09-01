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
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeWorkflowError,
  claimAdminIrlRedeemFinalizeWorkflowEffect,
  dispatchAdminIrlRedeemFinalizeWorkflowRestart,
  loadAdminIrlRedeemFinalizeWorkflowOperation,
  loadAdminIrlRedeemFinalizeWorkflowResult,
  readAdminIrlRedeemFinalizeRequest,
  retractAdminIrlRedeemFinalizeWorkflowRestartDispatch,
  reserveAdminIrlRedeemFinalizeWorkflow,
  resolveAdminIrlRedeemFinalizeStaffWallet,
  type AdminIrlRedeemFinalizeErrorCode,
  type AdminIrlRedeemFinalizeWorkflowOutput,
} from './adminIrlRedeemFinalize.js';
import {
  inspectAdminIrlRedeemFinalizeWorkflow,
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
import { CommerceRepositoryError } from './commerceRepository.js';
import { isRecord } from './dataAccess.js';
import {
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

type AdminIrlRedeemFinalizeWorkflowStartDependencies = Readonly<{
  claimEffect: typeof claimAdminIrlRedeemFinalizeWorkflowEffect;
  createDeadline: typeof createRequestDeadline;
  dispatchRestart: typeof dispatchAdminIrlRedeemFinalizeWorkflowRestart;
  loadOperation: LoadOperation;
  retractRestart: typeof retractAdminIrlRedeemFinalizeWorkflowRestartDispatch;
  reserveWorkflow: typeof reserveAdminIrlRedeemFinalizeWorkflow;
}>;

type AdminIrlRedeemFinalizeWorkflowStatusDependencies = Readonly<{
  createDeadline: typeof createRequestDeadline;
  loadOperation: LoadOperation;
}>;

const defaultStartDependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies = {
  claimEffect: claimAdminIrlRedeemFinalizeWorkflowEffect,
  createDeadline: createRequestDeadline,
  dispatchRestart: dispatchAdminIrlRedeemFinalizeWorkflowRestart,
  loadOperation: loadAdminIrlRedeemFinalizeWorkflowOperation,
  retractRestart: retractAdminIrlRedeemFinalizeWorkflowRestartDispatch,
  reserveWorkflow: reserveAdminIrlRedeemFinalizeWorkflow,
};

const defaultStatusDependencies: AdminIrlRedeemFinalizeWorkflowStatusDependencies = {
  createDeadline: createRequestDeadline,
  loadOperation: loadAdminIrlRedeemFinalizeWorkflowOperation,
};

type RouteError = Readonly<{
  code: AdminIrlRedeemFinalizeErrorCode;
  message: string;
  recovery?: AdminIrlRedeemFinalizeRecovery;
}>;

class EnsureRunningError extends AdminIrlRedeemFinalizeError {}

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

function ensureRunningError(error: unknown): EnsureRunningError {
  if (error instanceof AdminIrlRedeemFinalizeError) {
    return new EnsureRunningError(error.code, error.message, error.details);
  }
  const normalized = adminIrlRedeemFinalizeWorkflowError(error);
  return new EnsureRunningError(normalized.code, normalized.message);
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

function projectStartReconciliation(
  reconciliation: AdminIrlRedeemFinalizeWorkflowReconciliation,
): AdminIrlRedeemFinalizeWorkflowReconciliation {
  return ['create', 'restart'].includes(reconciliation.decision)
    ? { ...reconciliation, decision: 'ensure-running' }
    : reconciliation;
}

function preserveRequestedEffect(
  reconciliation: AdminIrlRedeemFinalizeWorkflowReconciliation,
  requestedEffect: 'create' | 'restart' | undefined,
): AdminIrlRedeemFinalizeWorkflowReconciliation {
  return requestedEffect !== undefined && reconciliation.decision === 'pending' &&
      reconciliation.durable.state === 'active-confirmed' &&
      reconciliation.observation.state === 'unavailable'
    ? { ...reconciliation, decision: 'ensure-running' }
    : reconciliation;
}

function isRestartableObservation(
  observation: AdminIrlRedeemFinalizeWorkflowReconciliation['observation'],
): observation is Extract<AdminIrlRedeemFinalizeWorkflowReconciliation['observation'], { instance: WorkflowInstance }> {
  return observation.state === 'retryable-failure' || observation.state === 'terminal-failure' ||
    observation.state === 'terminated' || observation.state === 'invalid';
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
  reservation: Extract<Awaited<ReturnType<typeof reserveAdminIrlRedeemFinalizeWorkflow>>, { status: 'complete' }>,
): AdminIrlRedeemFinalizeWorkflowRouteResult {
  const result = reservation.result;
  return routeResult(jsonResponse(result, 200, { headers: TIMING_RESPONSE_HEADERS }), 'succeeded', {
    operationId,
    dropId: result.dropId,
    targetKind: result.cards.length ? 'card_receipt' : 'pack',
    ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
  });
}

async function reloadStartReconciliation(
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  dependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies,
  signal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeWorkflowReconciliation> {
  const durable = await loadAdminIrlRedeemFinalizeDurableState(
    env,
    operationId,
    dependencies.loadOperation,
    signal,
  );
  if (
    durable.state === 'absent' || durable.state === 'complete' ||
    durable.state === 'effect-pending' || durable.state === 'restart-claim-pending' ||
    durable.state === 'restart-dispatch-pending' ||
    (durable.state === 'failed' && !durable.failure.retryable)
  ) return reconcileAdminIrlRedeemFinalizeInspection(durable, { state: 'missing' });
  return inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
    env,
    operationId,
    durable,
    dependencies.loadOperation,
    signal,
  );
}

async function reconcileAfterFenceError(
  request: Request,
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  dependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies,
  signal: AbortSignal,
  effectError: unknown,
): Promise<AdminIrlRedeemFinalizeWorkflowReconciliation> {
  try {
    return await reloadStartReconciliation(env, operationId, dependencies, signal);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    throw ensureRunningError(effectError);
  }
}

export async function handleAdminIrlRedeemFinalizeWorkflowStart(
  request: Request,
  env: Env,
  overrides: Partial<AdminIrlRedeemFinalizeWorkflowStartDependencies> = {},
): Promise<AdminIrlRedeemFinalizeWorkflowRouteResult> {
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    return methodNotAllowed();
  }
  const dependencies = { ...defaultStartDependencies, ...overrides };
  const deadline = dependencies.createDeadline(request, {
    timeoutMs: ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
    timeoutMessage: 'Admin IRL redeem Workflow request timed out',
  });
  let operationId: AdminIrlRedeemFinalizeOperationId | undefined;
  try {
    const body = await readAdminIrlRedeemFinalizeRequest(request, deadline.signal);
    const identity = await verifyRequestIdentity(request, env.OPS_DB, deadline.signal, Date.now());
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
    let requestedEffect: 'create' | 'restart' | undefined;
    let durable = await loadAdminIrlRedeemFinalizeDurableState(
      env,
      operationId,
      dependencies.loadOperation,
      deadline.signal,
    );
    if (
      durable.state === 'complete' || durable.state === 'effect-pending' ||
      durable.state === 'restart-claim-pending' ||
      durable.state === 'restart-dispatch-pending' ||
      (durable.state === 'failed' && !durable.failure.retryable)
    ) {
      return await projectReconciliation(
        env,
        operationId,
        reconcileAdminIrlRedeemFinalizeInspection(durable, { state: 'missing' }),
        deadline.signal,
        body.dropId,
      );
    }
    if (durable.state !== 'absent') {
      const initial = await inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
        env,
        operationId,
        durable,
        dependencies.loadOperation,
        deadline.signal,
      );
      if (['complete', 'terminal', 'pending'].includes(initial.decision)) {
        return await projectReconciliation(env, operationId, initial, deadline.signal, body.dropId);
      }
      if (initial.decision === 'ensure-running' && initial.observation.state !== 'missing') {
        return await projectReconciliation(env, operationId, initial, deadline.signal, body.dropId);
      }
      requestedEffect = initial.decision === 'create' || initial.decision === 'restart'
        ? initial.decision
        : undefined;
      durable = initial.durable;
    }
    const reservation = await dependencies.reserveWorkflow({
      body,
      env,
      operationId,
      signal: deadline.signal,
      staffWallet,
    });
    if (reservation.status === 'complete') {
      return completedReservationResult(operationId, reservation);
    }
    durable = await loadAdminIrlRedeemFinalizeDurableState(
      env,
      operationId,
      dependencies.loadOperation,
      deadline.signal,
    );
    let ready = await inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
      env,
      operationId,
      durable,
      dependencies.loadOperation,
      deadline.signal,
    );
    ready = preserveRequestedEffect(ready, requestedEffect);
    if (ready.decision !== 'create' && ready.decision !== 'restart') {
      return await projectReconciliation(env, operationId, ready, deadline.signal, body.dropId);
    }
    if (ready.decision === 'restart') {
      ready = await inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
        env,
        operationId,
        ready.durable,
        dependencies.loadOperation,
        deadline.signal,
        true,
      );
      ready = preserveRequestedEffect(ready, requestedEffect);
      if (ready.decision !== 'restart') {
        return await projectReconciliation(env, operationId, ready, deadline.signal, body.dropId);
      }
    }
    if (ready.durable.state === 'absent') {
      throw new AdminIrlRedeemFinalizeError('internal', 'Admin IRL redeem finalization failed unexpectedly.');
    }
    const expectedRevision = ready.durable.revision;
    const effectKind = ready.decision;
    const restartClaimId = effectKind === 'restart' ? crypto.randomUUID() : undefined;
    let claim: Awaited<ReturnType<typeof dependencies.claimEffect>>;
    try {
      claim = effectKind === 'create'
        ? await dependencies.claimEffect({
            env,
            expectedRevision,
            kind: 'create',
            operationId,
            signal: deadline.signal,
          })
        : await dependencies.claimEffect({
            claimId: restartClaimId || '',
            env,
            expectedRevision,
            kind: 'restart',
            operationId,
            signal: deadline.signal,
          });
    } catch (error) {
      if (isRequestCancellationError(request, error)) throw error;
      if (restartClaimId !== undefined) {
        try {
          claim = await dependencies.claimEffect({
            claimId: restartClaimId,
            env,
            expectedRevision,
            kind: 'restart',
            operationId,
            signal: deadline.signal,
          });
        } catch (retryError) {
          if (isRequestCancellationError(request, retryError)) throw retryError;
          const reconciled = await reconcileAfterFenceError(
            request,
            env,
            operationId,
            dependencies,
            deadline.signal,
            retryError,
          );
          return await projectReconciliation(
            env,
            operationId,
            projectStartReconciliation(reconciled),
            deadline.signal,
            body.dropId,
          );
        }
      } else {
        const reconciled = await reconcileAfterFenceError(
          request,
          env,
          operationId,
          dependencies,
          deadline.signal,
          error,
        );
        return await projectReconciliation(
          env,
          operationId,
          projectStartReconciliation(reconciled),
          deadline.signal,
          body.dropId,
        );
      }
    }
    if (claim.status === 'busy') {
      return routeResult(pendingResponse(operationId), 'pending', {
        operationId,
        dropId: body.dropId,
      });
    }
    if (claim.status === 'changed') {
      const changed = await reloadStartReconciliation(
        env,
        operationId,
        dependencies,
        deadline.signal,
      );
      return await projectReconciliation(
        env,
        operationId,
        projectStartReconciliation(changed),
        deadline.signal,
        body.dropId,
      );
    }
    if (effectKind === 'create') {
      try {
        await raceWithSignal(env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW.createBatch([{
          id: operationId,
          params: reservation.payload,
        }]), deadline.signal);
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason;
        if (deadline.signal.aborted) throw deadline.signal.reason;
      }
      if (request.signal.aborted) throw request.signal.reason;
      if (deadline.signal.aborted) throw deadline.signal.reason;
      return routeResult(pendingResponse(operationId), 'pending', {
        operationId,
        dropId: body.dropId,
      });
    }
    if (!restartClaimId) {
      throw new AdminIrlRedeemFinalizeError('internal', 'Admin IRL redeem finalization failed unexpectedly.');
    }
    const claimedObservation = await inspectAdminIrlRedeemFinalizeWorkflow(
      env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
      operationId,
      deadline.signal,
    );
    if (!isRestartableObservation(claimedObservation)) {
      if (request.signal.aborted) throw request.signal.reason;
      if (deadline.signal.aborted) throw deadline.signal.reason;
      return routeResult(pendingResponse(operationId), 'pending', {
        operationId,
        dropId: body.dropId,
      });
    }
    let dispatchConfirmed = false;
    let dispatch: Awaited<ReturnType<typeof dependencies.dispatchRestart>> | undefined;
    try {
      dispatch = await dependencies.dispatchRestart({
        claimId: restartClaimId,
        env,
        operationId,
        signal: deadline.signal,
      });
    } catch (error) {
      if (isRequestCancellationError(request, error)) throw error;
      try {
        dispatch = await dependencies.dispatchRestart({
          claimId: restartClaimId,
          env,
          operationId,
          signal: deadline.signal,
        });
      } catch (retryError) {
        if (isRequestCancellationError(request, retryError)) throw retryError;
        const reconciled = await reconcileAfterFenceError(
          request,
          env,
          operationId,
          dependencies,
          deadline.signal,
          retryError,
        );
        if (
          (reconciled.durable.state === 'restart-dispatch-pending' ||
            reconciled.durable.state === 'restart-dispatched') &&
          reconciled.durable.claimId === restartClaimId
        ) {
          dispatchConfirmed = true;
        } else {
          return await projectReconciliation(
            env,
            operationId,
            projectStartReconciliation(reconciled),
            deadline.signal,
            body.dropId,
          );
        }
      }
    }
    if (dispatch?.status === 'dispatched') {
      dispatchConfirmed = true;
    } else if (dispatch?.status === 'changed') {
      const changed = await reloadStartReconciliation(
        env,
        operationId,
        dependencies,
        deadline.signal,
      );
      if (
        (changed.durable.state === 'restart-dispatch-pending' ||
          changed.durable.state === 'restart-dispatched') &&
        changed.durable.claimId === restartClaimId
      ) {
        dispatchConfirmed = true;
      } else {
        return await projectReconciliation(
          env,
          operationId,
          projectStartReconciliation(changed),
          deadline.signal,
          body.dropId,
        );
      }
    }
    if (!dispatchConfirmed) {
      throw new AdminIrlRedeemFinalizeError('internal', 'Admin IRL redeem finalization failed unexpectedly.');
    }
    const dispatchedObservation = await inspectAdminIrlRedeemFinalizeWorkflow(
      env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
      operationId,
      deadline.signal,
    );
    if (!isRestartableObservation(dispatchedObservation)) {
      if (request.signal.aborted) throw request.signal.reason;
      if (deadline.signal.aborted) throw deadline.signal.reason;
      let retract: Awaited<ReturnType<typeof dependencies.retractRestart>> | undefined;
      let retractError: unknown;
      let retractFailed = false;
      try {
        retract = await dependencies.retractRestart({
          claimId: restartClaimId,
          env,
          operationId,
          signal: deadline.signal,
        });
      } catch (error) {
        if (isRequestCancellationError(request, error)) throw error;
        try {
          retract = await dependencies.retractRestart({
            claimId: restartClaimId,
            env,
            operationId,
            signal: deadline.signal,
          });
        } catch (retryError) {
          if (isRequestCancellationError(request, retryError)) throw retryError;
          retractFailed = true;
          retractError = retryError;
        }
      }
      if (retract?.status === 'retracted') {
        return routeResult(pendingResponse(operationId), 'pending', {
          operationId,
          dropId: body.dropId,
        });
      }
      const reconciled = retractFailed
        ? await reconcileAfterFenceError(
            request,
            env,
            operationId,
            dependencies,
            deadline.signal,
            retractError,
          )
        : await reloadStartReconciliation(
            env,
            operationId,
            dependencies,
            deadline.signal,
          );
      if (
        (reconciled.durable.state === 'restart-claim-pending' ||
          reconciled.durable.state === 'restart-claim-expired') &&
        reconciled.durable.claimId === restartClaimId
      ) {
        return routeResult(pendingResponse(operationId), 'pending', {
          operationId,
          dropId: body.dropId,
        });
      }
      return await projectReconciliation(
        env,
        operationId,
        projectStartReconciliation(reconciled),
        deadline.signal,
        body.dropId,
      );
    }
    try {
      await raceWithSignal(dispatchedObservation.instance.restart(), deadline.signal);
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (deadline.signal.aborted) throw deadline.signal.reason;
    }
    if (request.signal.aborted) throw request.signal.reason;
    if (deadline.signal.aborted) throw deadline.signal.reason;
    return routeResult(pendingResponse(operationId), 'pending', {
      operationId,
      dropId: body.dropId,
    });
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
    const identity = await verifyRequestIdentity(request, env.OPS_DB, deadline.signal, Date.now());
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
