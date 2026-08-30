import {
  ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
  ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
  ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
  createAdminIrlRedeemFinalizeOperationId,
  isAdminIrlRedeemFinalizeOperationId,
  type AdminIrlRedeemFinalizeOperationId,
  type AdminIrlRedeemFinalizePendingResponse,
} from '../../../../shared/contracts.js';
import {
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeWorkflowError,
  cleanupAdminIrlRedeemFinalizeWorkflow,
  loadAdminIrlRedeemFinalizeWorkflowOperation,
  loadAdminIrlRedeemFinalizeWorkflowResult,
  parseAdminIrlRedeemFinalizeWorkflowOutput,
  readAdminIrlRedeemFinalizeRequest,
  reserveAdminIrlRedeemFinalizeWorkflow,
  resolveAdminIrlRedeemFinalizeStaffWallet,
  type AdminIrlRedeemFinalizeErrorCode,
  type AdminIrlRedeemFinalizeWorkflowOutput,
  type AdminIrlRedeemFinalizeWorkflowPayload,
} from './adminIrlRedeemFinalize.js';
import {
  createRequestDeadline,
  createTimedAbortScope,
  isRequestCancellationError,
  raceWithSignal,
  readBoundedRequestJson,
  type TimedAbortScope,
} from './boundedRequest.js';
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

type AdminIrlRedeemFinalizeWorkflowStartDependencies = Readonly<{
  createDeadline: typeof createRequestDeadline;
  createRecoveryScope: () => TimedAbortScope;
}>;

const defaultStartDependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies = {
  createDeadline: createRequestDeadline,
  createRecoveryScope: () => createTimedAbortScope(new AbortController().signal, {
    timeoutMs: CREATE_FAILURE_RECOVERY_TIMEOUT_MS,
    timeoutMessage: 'Admin IRL redeem Workflow create recovery timed out',
  }),
};

type WorkflowInspection =
  | Readonly<{ state: 'missing' }>
  | Readonly<{ state: 'pending'; instance: WorkflowInstance }>
  | Readonly<{ state: 'terminated'; instance: WorkflowInstance }>
  | Readonly<{ state: 'errored' | 'invalid'; instance: WorkflowInstance }>
  | Readonly<{
      state: 'complete';
      instance: WorkflowInstance;
      output: AdminIrlRedeemFinalizeWorkflowOutput;
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

function failureResponse(
  error: Readonly<{ code: AdminIrlRedeemFinalizeErrorCode; message: string }>,
): Response {
  return jsonResponse({ ok: false, error: { code: error.code, message: error.message } }, statusForCode(error.code));
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

function isAdminIrlRedeemFinalizeWorkflowInstanceMissing(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === 10200) return false;
  return error.code === 'instance.not_found' || error.message === 'instance.not_found';
}

function isDefinitiveAdminIrlRedeemFinalizeWorkflowCreateFailure(error: unknown): boolean {
  return isRecord(error) && error.code === 10200;
}

async function inspectWorkflow(
  binding: Workflow<AdminIrlRedeemFinalizeWorkflowPayload>,
  operationId: string,
  signal: AbortSignal,
): Promise<WorkflowInspection> {
  let instance: WorkflowInstance;
  try {
    instance = await raceWithSignal(binding.get(operationId), signal);
    const status = await raceWithSignal(instance.status(), signal);
    if (['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(status.status)) {
      return { state: 'pending', instance };
    }
    if (status.status === 'terminated') return { state: 'terminated', instance };
    if (status.status === 'errored') return { state: 'errored', instance };
    if (status.status !== 'complete') return { state: 'invalid', instance };
    const output = parseAdminIrlRedeemFinalizeWorkflowOutput(status.output);
    return output ? { state: 'complete', instance, output } : { state: 'invalid', instance };
  } catch (error) {
    if (isAdminIrlRedeemFinalizeWorkflowInstanceMissing(error)) return { state: 'missing' };
    throw error;
  }
}

async function projectComplete(
  env: Env,
  operationId: string,
  output: AdminIrlRedeemFinalizeWorkflowOutput,
): Promise<AdminIrlRedeemFinalizeWorkflowRouteResult> {
  if (!output.ok) {
    return routeResult(failureResponse(output.error), output.error.code, {
      operationId,
      authOutcome: output.error.code === 'invalid-argument' || output.error.code === 'permission-denied' ||
        output.error.code === 'failed-precondition' || output.error.code === 'resource-exhausted'
        ? 'rejected'
        : 'provider-failure',
    });
  }
  const result = await loadAdminIrlRedeemFinalizeWorkflowResult({
    env,
    operationId,
    reference: output.result,
  });
  return routeResult(jsonResponse(result, 200), 'succeeded', {
    operationId,
    dropId: result.dropId,
    targetKind: result.cards.length ? 'card_receipt' : 'pack',
    ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
  });
}

async function projectInspection(
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  inspection: WorkflowInspection,
): Promise<AdminIrlRedeemFinalizeWorkflowRouteResult> {
  if (inspection.state === 'pending') {
    return routeResult(pendingResponse(operationId), 'pending', { operationId });
  }
  if (inspection.state === 'missing') {
    return routeResult(failureResponse({ code: 'not-found', message: 'Admin IRL redeem Workflow operation not found.' }), 'not-found', {
      operationId,
      authOutcome: 'rejected',
    });
  }
  if (inspection.state === 'terminated') {
    return routeResult(failureResponse({ code: 'aborted', message: 'Admin IRL redeem Workflow operation was terminated.' }), 'aborted', {
      operationId,
      authOutcome: 'rejected',
    });
  }
  if (inspection.state === 'errored' || inspection.state === 'invalid') {
    return routeResult(failureResponse({ code: 'internal', message: 'Admin IRL redeem finalization failed unexpectedly.' }), 'internal', {
      operationId,
      authOutcome: 'provider-failure',
    });
  }
  if (inspection.state === 'complete') return projectComplete(env, operationId, inspection.output);
  return routeResult(failureResponse({ code: 'internal', message: 'Admin IRL redeem finalization failed unexpectedly.' }), 'internal', {
    operationId,
    authOutcome: 'provider-failure',
  });
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

export async function handleAdminIrlRedeemFinalizeWorkflowStart(
  request: Request,
  env: Env,
  overrides: Partial<AdminIrlRedeemFinalizeWorkflowStartDependencies> = {},
): Promise<AdminIrlRedeemFinalizeWorkflowRouteResult> {
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const result = methodNotAllowed();
    result.response.headers.set('Allow', 'POST, OPTIONS');
    return result;
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
    const persisted = await loadAdminIrlRedeemFinalizeWorkflowOperation({ env, operationId });
    if (persisted?.status === 'complete') {
      const result = await loadAdminIrlRedeemFinalizeWorkflowResult({ env, operationId });
      return routeResult(jsonResponse(result, 200), 'succeeded', {
        operationId,
        dropId: result.dropId,
        targetKind: result.cards.length ? 'card_receipt' : 'pack',
        ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
      });
    }
    if (persisted?.failure && !persisted.failure.retryable) {
      return routeResult(failureResponse(persisted.failure), persisted.failure.code, {
        operationId,
        authOutcome: ['invalid-argument', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted']
          .includes(persisted.failure.code) ? 'rejected' : 'provider-failure',
      });
    }
    let inspection = persisted
      ? await inspectWorkflow(env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW, operationId, deadline.signal)
      : undefined;
    if (
      inspection &&
      (inspection.state === 'terminated' || inspection.state === 'errored' || inspection.state === 'invalid' ||
        (inspection.state === 'complete' && (inspection.output.ok || !inspection.output.error.retryable)))
    ) {
      return await projectInspection(env, operationId, inspection);
    }
    const reservation = await reserveAdminIrlRedeemFinalizeWorkflow({
      body,
      env,
      operationId,
      signal: deadline.signal,
      staffWallet,
    });
    if (reservation.status === 'complete') {
      const result = reservation.result;
      return routeResult(jsonResponse(result, 200), 'succeeded', {
        operationId,
        dropId: result.dropId,
        targetKind: result.cards.length ? 'card_receipt' : 'pack',
        ...(result.deliveryId === undefined ? {} : { deliveryId: result.deliveryId }),
      });
    }
    inspection = inspection || await inspectWorkflow(
      env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
      operationId,
      deadline.signal,
    );
    if (inspection.state === 'missing') {
      try {
        await raceWithSignal(env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW.createBatch([{
          id: operationId,
          params: reservation.payload,
        }]), deadline.signal);
        return routeResult(pendingResponse(operationId), 'pending', { operationId, dropId: body.dropId });
      } catch (error) {
        const recovery = dependencies.createRecoveryScope();
        try {
          inspection = await inspectWorkflow(
            env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
            operationId,
            recovery.signal,
          );
          if (inspection.state === 'missing') {
            if (isDefinitiveAdminIrlRedeemFinalizeWorkflowCreateFailure(error)) {
              const projected = adminIrlRedeemFinalizeWorkflowError(error);
              await cleanupAdminIrlRedeemFinalizeWorkflow({
                env,
                error: projected,
                operationId,
                payload: reservation.payload,
                signal: recovery.signal,
              });
            }
            throw error;
          }
        } finally {
          recovery.dispose();
        }
        if (deadline.signal.aborted) throw error;
      }
    }
    if (inspection.state === 'complete' && !inspection.output.ok && inspection.output.error.retryable) {
      const current = await inspectWorkflow(
        env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
        operationId,
        deadline.signal,
      );
      if (current.state === 'pending') {
        return routeResult(pendingResponse(operationId), 'pending', { operationId, dropId: body.dropId });
      }
      if (current.state !== 'complete' || current.output.ok || !current.output.error.retryable) {
        return await projectInspection(env, operationId, current);
      }
      try {
        await raceWithSignal(current.instance.restart(), deadline.signal);
      } catch (error) {
        const latest = await inspectWorkflow(
          env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
          operationId,
          deadline.signal,
        );
        if (latest.state !== 'pending') throw error;
      }
      return routeResult(pendingResponse(operationId), 'pending', { operationId, dropId: body.dropId });
    }
    return await projectInspection(env, operationId, inspection);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    const normalized = deadline.timedOut()
      ? new AdminIrlRedeemFinalizeError('deadline-exceeded', 'Admin IRL redeem finalization timed out.')
      : error instanceof RequestIdentityError
        ? identityError(error)
        : new AdminIrlRedeemFinalizeError(
            adminIrlRedeemFinalizeWorkflowError(error).code,
            adminIrlRedeemFinalizeWorkflowError(error).message,
          );
    return routeResult(failureResponse(normalized), normalized.code, {
      ...(operationId ? { operationId } : {}),
      authOutcome: ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted']
        .includes(normalized.code) ? 'rejected' : 'provider-failure',
    });
  } finally {
    deadline.dispose();
  }
}

async function readStatusOperationId(request: Request, signal: AbortSignal): Promise<AdminIrlRedeemFinalizeOperationId> {
  const value = await readBoundedRequestJson(request, {
    maxBytes: STATUS_MAX_BYTES,
    signal,
    createError: () => new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow status request.'),
  });
  if (
    !isRecord(value) || Object.keys(value).length !== 1 ||
    !isAdminIrlRedeemFinalizeOperationId(value.operationId)
  ) {
    throw new AdminIrlRedeemFinalizeError('invalid-argument', 'Invalid Admin IRL redeem Workflow status request.');
  }
  return value.operationId;
}

export async function handleAdminIrlRedeemFinalizeWorkflowStatus(
  request: Request,
  env: Env,
): Promise<AdminIrlRedeemFinalizeWorkflowRouteResult> {
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    const result = methodNotAllowed();
    result.response.headers.set('Allow', 'POST, OPTIONS');
    return result;
  }
  const deadline = createRequestDeadline(request, {
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
    const operation = await loadAdminIrlRedeemFinalizeWorkflowOperation({ env, operationId });
    if (!operation) {
      return routeResult(failureResponse({ code: 'not-found', message: 'Admin IRL redeem Workflow operation not found.' }), 'not-found', {
        operationId,
        authOutcome: 'rejected',
      });
    }
    const inspection = await inspectWorkflow(env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW, operationId, deadline.signal);
    return await projectInspection(env, operationId, inspection);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    const normalized = deadline.timedOut()
      ? new AdminIrlRedeemFinalizeError('deadline-exceeded', 'Admin IRL redeem Workflow status request timed out.')
      : error instanceof RequestIdentityError
        ? identityError(error)
        : new AdminIrlRedeemFinalizeError(
            adminIrlRedeemFinalizeWorkflowError(error).code,
            adminIrlRedeemFinalizeWorkflowError(error).message,
          );
    return routeResult(failureResponse(normalized), normalized.code, {
      ...(operationId ? { operationId } : {}),
      authOutcome: ['invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'failed-precondition', 'resource-exhausted']
        .includes(normalized.code) ? 'rejected' : 'provider-failure',
    });
  } finally {
    deadline.dispose();
  }
}
