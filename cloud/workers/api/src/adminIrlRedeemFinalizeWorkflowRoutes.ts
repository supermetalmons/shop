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
  cleanupAdminIrlRedeemFinalizeWorkflow,
  confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation,
  loadAdminIrlRedeemFinalizeWorkflowOperation,
  loadAdminIrlRedeemFinalizeWorkflowResult,
  readAdminIrlRedeemFinalizeRequest,
  reserveAdminIrlRedeemFinalizeWorkflow,
  resolveAdminIrlRedeemFinalizeStaffWallet,
  type AdminIrlRedeemFinalizeErrorCode,
  type AdminIrlRedeemFinalizeWorkflowOutput,
  type AdminIrlRedeemFinalizeWorkflowPayload,
} from './adminIrlRedeemFinalize.js';
import {
  inspectAdminIrlRedeemFinalizeWorkflow,
  inspectAndReconcileAdminIrlRedeemFinalizeWorkflow,
  isAdminIrlRedeemFinalizeWorkflowResourceError,
  loadAdminIrlRedeemFinalizeDurableState,
  projectAdminIrlRedeemFinalizeStatusDecision,
  reconcileAdminIrlRedeemFinalizeInspection,
  type AdminIrlRedeemFinalizeDurableState,
  type AdminIrlRedeemFinalizeLoadOperation,
  type AdminIrlRedeemFinalizeWorkflowReconciliation,
} from './adminIrlRedeemFinalizeWorkflowRecovery.js';
import {
  createRequestDeadline,
  createTimedAbortScope,
  isRequestCancellationError,
  raceWithSignal,
  readBoundedRequestJson,
  type TimedAbortScope,
} from './boundedRequest.js';
import { CommerceRepositoryError } from './commerceRepository.js';
import { isRecord } from './dataAccess.js';
import {
  RequestIdentityError,
  isStaffRequestIdentity,
  verifyRequestIdentity,
} from './requestIdentity.js';

export { ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH };

const STATUS_MAX_BYTES = 256;
const CREATE_FAILURE_RECOVERY_TIMEOUT_MS = 10_000;
const EMPTY_METRICS = Object.freeze({ upstreamCalls: 0, providerDurationMs: 0 });

type LoadOperation = AdminIrlRedeemFinalizeLoadOperation;

type AdminIrlRedeemFinalizeWorkflowStartDependencies = Readonly<{
  confirmInstanceCreation: typeof confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation;
  createDeadline: typeof createRequestDeadline;
  createRecoveryScope: () => TimedAbortScope;
  loadOperation: LoadOperation;
  reserveWorkflow: typeof reserveAdminIrlRedeemFinalizeWorkflow;
}>;

type AdminIrlRedeemFinalizeWorkflowStatusDependencies = Readonly<{
  createDeadline: typeof createRequestDeadline;
  loadOperation: LoadOperation;
}>;

const defaultStartDependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies = {
  confirmInstanceCreation: confirmAdminIrlRedeemFinalizeWorkflowInstanceCreation,
  createDeadline: createRequestDeadline,
  createRecoveryScope: () => createTimedAbortScope(new AbortController().signal, {
    timeoutMs: CREATE_FAILURE_RECOVERY_TIMEOUT_MS,
    timeoutMessage: 'Admin IRL redeem Workflow create recovery timed out',
  }),
  loadOperation: loadAdminIrlRedeemFinalizeWorkflowOperation,
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

function statusForCode(code: AdminIrlRedeemFinalizeErrorCode): number {
  if (code === 'invalid-argument') return 400;
  if (code === 'unauthenticated') return 401;
  if (code === 'permission-denied') return 403;
  if (code === 'not-found') return 404;
  if (code === 'aborted' || code === 'failed-precondition') return 409;
  if (code === 'resource-exhausted') return 429;
  if (code === 'deadline-exceeded') return 504;
  if (code === 'unavailable') return 502;
  return 500;
}

function jsonResponse(value: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Timing-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function failureResponse(error: RouteError): Response {
  return jsonResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
    },
  }, statusForCode(error.code));
}

function pendingResponse(operationId: AdminIrlRedeemFinalizeOperationId): Response {
  const body: AdminIrlRedeemFinalizePendingResponse = {
    accepted: true,
    operationId,
    status: 'pending',
    retryAfterMs: ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
  };
  return jsonResponse(body, 202, { 'Retry-After': '2' });
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
  return routeResult(jsonResponse(result, 200), 'succeeded', {
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
    if (reconciliation.durable.state === 'failed' && !reconciliation.durable.failure.retryable) {
      return projectFailure(operationId, reconciliation.durable.failure);
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

async function confirmObservedWorkflowInstance(
  request: Request,
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  reconciliation: AdminIrlRedeemFinalizeWorkflowReconciliation,
  dependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies,
  signal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeWorkflowReconciliation> {
  try {
    await confirmCreatedWorkflowInstance(
      request,
      env,
      operationId,
      dependencies,
      signal,
    );
    const durable = await loadAdminIrlRedeemFinalizeDurableState(
      env,
      operationId,
      dependencies.loadOperation,
      signal,
    );
    return reconcileAdminIrlRedeemFinalizeInspection(durable, reconciliation.observation);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    throw ensureRunningError(error);
  }
}

async function confirmCreatedWorkflowInstance(
  request: Request,
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  dependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies,
  deadlineSignal: AbortSignal,
): Promise<void> {
  const recovery = dependencies.createRecoveryScope();
  let confirmationError: unknown;
  try {
    await dependencies.confirmInstanceCreation({
      env,
      operationId,
      signal: recovery.signal,
    });
  } catch (error) {
    confirmationError = error;
  } finally {
    recovery.dispose();
  }
  if (request.signal.aborted) throw request.signal.reason;
  if (deadlineSignal.aborted) throw deadlineSignal.reason;
  if (confirmationError !== undefined) throw ensureRunningError(confirmationError);
}

async function reconcileAfterCreateEffect(
  request: Request,
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  payload: AdminIrlRedeemFinalizeWorkflowPayload,
  effectError: unknown,
  dependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies,
  deadlineSignal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeWorkflowReconciliation> {
  if (effectError === undefined) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Admin IRL redeem finalization failed unexpectedly.');
  }
  const recovery = dependencies.createRecoveryScope();
  try {
    const observation = await inspectAdminIrlRedeemFinalizeWorkflow(
      env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
      operationId,
      recovery.signal,
    );
    if (
      observation.state === 'missing' &&
      isAdminIrlRedeemFinalizeWorkflowResourceError(effectError)
    ) {
      const projected = adminIrlRedeemFinalizeWorkflowError(effectError);
      await cleanupAdminIrlRedeemFinalizeWorkflow({
        env,
        error: projected,
        operationId,
        payload,
        signal: recovery.signal,
      });
    }
    if (observation.state !== 'missing' && observation.state !== 'unavailable') {
      await dependencies.confirmInstanceCreation({
        env,
        operationId,
        signal: recovery.signal,
      });
    }
    const latest = await loadAdminIrlRedeemFinalizeDurableState(
      env,
      operationId,
      dependencies.loadOperation,
      recovery.signal,
    );
    if (request.signal.aborted) throw request.signal.reason;
    if (deadlineSignal.aborted) throw ensureRunningError(effectError);
    return reconcileAdminIrlRedeemFinalizeInspection(latest, observation);
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    throw error instanceof EnsureRunningError ? error : ensureRunningError(error);
  } finally {
    recovery.dispose();
  }
}

async function reconcileAfterRestartEffect(
  request: Request,
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  durable: AdminIrlRedeemFinalizeDurableState,
  instance: WorkflowInstance,
  loadOperation: LoadOperation,
  signal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeWorkflowReconciliation> {
  let effectError: unknown;
  try {
    await raceWithSignal(instance.restart(), signal);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    effectError = error;
  }
  try {
    const reconciliation = await inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
      env,
      operationId,
      durable,
      loadOperation,
      signal,
      true,
    );
    if (request.signal.aborted) throw request.signal.reason;
    return reconciliation;
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    throw ensureRunningError(effectError === undefined ? error : effectError);
  }
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
      { Allow: 'POST, OPTIONS' },
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
  return routeResult(jsonResponse(result, 200), 'succeeded', {
    operationId,
    dropId: result.dropId,
    targetKind: result.cards.length ? 'card_receipt' : 'pack',
    ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
  });
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
    let markInstanceCreationPending = false;
    let durable = await loadAdminIrlRedeemFinalizeDurableState(
      env,
      operationId,
      dependencies.loadOperation,
      deadline.signal,
    );
    if (durable.state === 'complete' || (durable.state === 'failed' && !durable.failure.retryable)) {
      return await projectReconciliation(
        env,
        operationId,
        reconcileAdminIrlRedeemFinalizeInspection(durable, { state: 'missing' }),
        deadline.signal,
        body.dropId,
      );
    }
    if (durable.state !== 'absent') {
      let initial = await inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
        env,
        operationId,
        durable,
        dependencies.loadOperation,
        deadline.signal,
      );
      if (initial.decision === 'confirm-instance') {
        initial = await confirmObservedWorkflowInstance(
          request,
          env,
          operationId,
          initial,
          dependencies,
          deadline.signal,
        );
      }
      if (['complete', 'terminal', 'pending'].includes(initial.decision)) {
        return await projectReconciliation(env, operationId, initial, deadline.signal, body.dropId);
      }
      if (initial.decision === 'ensure-running' && initial.observation.state !== 'missing') {
        return await projectReconciliation(env, operationId, initial, deadline.signal, body.dropId);
      }
      markInstanceCreationPending = initial.decision === 'ensure-running';
      durable = initial.durable;
    }
    const reservation = await dependencies.reserveWorkflow({
      body,
      env,
      markInstanceCreationPending,
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
    if (ready.decision === 'confirm-instance') {
      ready = await confirmObservedWorkflowInstance(
        request,
        env,
        operationId,
        ready,
        dependencies,
        deadline.signal,
      );
    }
    if (ready.decision !== 'create' && ready.decision !== 'restart') {
      return await projectReconciliation(env, operationId, ready, deadline.signal, body.dropId);
    }
    let afterEffect: AdminIrlRedeemFinalizeWorkflowReconciliation;
    if (ready.decision === 'create') {
      let effectError: unknown;
      try {
        await raceWithSignal(env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW.createBatch([{
          id: operationId,
          params: reservation.payload,
        }]), deadline.signal);
      } catch (error) {
        effectError = error;
      }
      if (effectError === undefined) {
        await confirmCreatedWorkflowInstance(
          request,
          env,
          operationId,
          dependencies,
          deadline.signal,
        );
        return routeResult(pendingResponse(operationId), 'pending', {
          operationId,
          dropId: body.dropId,
        });
      }
      afterEffect = await reconcileAfterCreateEffect(
        request,
        env,
        operationId,
        reservation.payload,
        effectError,
        dependencies,
        deadline.signal,
      );
    } else {
      if (ready.observation.state !== 'retryable-failure') {
        throw new AdminIrlRedeemFinalizeError('internal', 'Admin IRL redeem finalization failed unexpectedly.');
      }
      afterEffect = await reconcileAfterRestartEffect(
        request,
        env,
        operationId,
        ready.durable,
        ready.observation.instance,
        dependencies.loadOperation,
        deadline.signal,
      );
    }
    const decision = ['create', 'restart', 'confirm-instance'].includes(afterEffect.decision)
      ? 'ensure-running'
      : afterEffect.decision;
    return await projectReconciliation(
      env,
      operationId,
      { ...afterEffect, decision },
      deadline.signal,
      body.dropId,
    );
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
      decision: projectAdminIrlRedeemFinalizeStatusDecision(reconciliation.decision),
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
