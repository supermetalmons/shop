import type { AdminIrlRedeemFinalizeOperationId } from '../../../../shared/contracts.js';
import {
  reserveAdminIrlRedeemFinalizeWorkflow,
  type AdminIrlRedeemFinalizeRequest,
  type AdminIrlRedeemFinalizeWorkflowReservation,
} from './adminIrlRedeemFinalize.js';
import {
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeWorkflowError,
} from './adminIrlRedeemFinalizeWorkflowState.js';
import {
  claimAdminIrlRedeemFinalizeWorkflowEffect,
  dispatchAdminIrlRedeemFinalizeWorkflowRestart,
  loadAdminIrlRedeemFinalizeWorkflowOperation,
  retractAdminIrlRedeemFinalizeWorkflowRestartDispatch,
} from './adminIrlRedeemFinalizeWorkflowStore.js';
import {
  inspectAdminIrlRedeemFinalizeWorkflow,
  inspectAndReconcileAdminIrlRedeemFinalizeWorkflow,
  loadAdminIrlRedeemFinalizeDurableState,
  reconcileAdminIrlRedeemFinalizeInspection,
  type AdminIrlRedeemFinalizeLoadOperation,
  type AdminIrlRedeemFinalizeWorkflowReconciliation,
} from './adminIrlRedeemFinalizeWorkflowRecovery.js';
import { raceWithSignal } from './boundedRequest.js';

export type AdminIrlRedeemFinalizeWorkflowStartDependencies = Readonly<{
  claimEffect: typeof claimAdminIrlRedeemFinalizeWorkflowEffect;
  dispatchRestart: typeof dispatchAdminIrlRedeemFinalizeWorkflowRestart;
  loadOperation: AdminIrlRedeemFinalizeLoadOperation;
  retractRestart: typeof retractAdminIrlRedeemFinalizeWorkflowRestartDispatch;
  reserveWorkflow: typeof reserveAdminIrlRedeemFinalizeWorkflow;
}>;

const defaultDependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies = {
  claimEffect: claimAdminIrlRedeemFinalizeWorkflowEffect,
  dispatchRestart: dispatchAdminIrlRedeemFinalizeWorkflowRestart,
  loadOperation: loadAdminIrlRedeemFinalizeWorkflowOperation,
  retractRestart: retractAdminIrlRedeemFinalizeWorkflowRestartDispatch,
  reserveWorkflow: reserveAdminIrlRedeemFinalizeWorkflow,
};

type ClientCancellation = Readonly<{
  signal: AbortSignal;
  isCancellationError: (error: unknown) => boolean;
}>;

type WorkflowStartResult =
  | Readonly<{ status: 'pending' }>
  | Extract<AdminIrlRedeemFinalizeWorkflowReservation, { status: 'complete' }>
  | Readonly<{
      status: 'reconciled';
      reconciliation: AdminIrlRedeemFinalizeWorkflowReconciliation;
    }>;

export class EnsureRunningError extends AdminIrlRedeemFinalizeError {}

function ensureRunningError(error: unknown): EnsureRunningError {
  if (error instanceof AdminIrlRedeemFinalizeError) {
    return new EnsureRunningError(error.code, error.message, error.details);
  }
  const normalized = adminIrlRedeemFinalizeWorkflowError(error);
  return new EnsureRunningError(normalized.code, normalized.message);
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
  clientCancellation: ClientCancellation,
  env: Env,
  operationId: AdminIrlRedeemFinalizeOperationId,
  dependencies: AdminIrlRedeemFinalizeWorkflowStartDependencies,
  signal: AbortSignal,
  effectError: unknown,
): Promise<AdminIrlRedeemFinalizeWorkflowReconciliation> {
  try {
    return await reloadStartReconciliation(env, operationId, dependencies, signal);
  } catch (error) {
    if (clientCancellation.isCancellationError(error)) throw error;
    throw ensureRunningError(effectError);
  }
}

export async function ensureAdminIrlRedeemFinalizeWorkflowRunning(
  args: Readonly<{
    body: AdminIrlRedeemFinalizeRequest;
    staffWallet: string;
    operationId: AdminIrlRedeemFinalizeOperationId;
    env: Env;
    signal: AbortSignal;
    clientCancellation: ClientCancellation;
  }>,
  overrides: Partial<AdminIrlRedeemFinalizeWorkflowStartDependencies> = {},
): Promise<WorkflowStartResult> {
  const { body, staffWallet, operationId, env, signal, clientCancellation } = args;
  const dependencies = { ...defaultDependencies, ...overrides };
  let requestedEffect: 'create' | 'restart' | undefined;
  let durable = await loadAdminIrlRedeemFinalizeDurableState(
    env,
    operationId,
    dependencies.loadOperation,
    signal,
  );
  if (
    durable.state === 'complete' || durable.state === 'effect-pending' ||
    durable.state === 'restart-claim-pending' ||
    durable.state === 'restart-dispatch-pending' ||
    (durable.state === 'failed' && !durable.failure.retryable)
  ) {
    return {
      status: 'reconciled',
      reconciliation: reconcileAdminIrlRedeemFinalizeInspection(durable, { state: 'missing' }),
    };
  }
  if (durable.state !== 'absent') {
    const initial = await inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
      env,
      operationId,
      durable,
      dependencies.loadOperation,
      signal,
    );
    if (['complete', 'terminal', 'pending'].includes(initial.decision)) {
      return { status: 'reconciled', reconciliation: initial };
    }
    if (initial.decision === 'ensure-running' && initial.observation.state !== 'missing') {
      return { status: 'reconciled', reconciliation: initial };
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
    signal,
    staffWallet,
  });
  if (reservation.status === 'complete') {
    return reservation;
  }
  durable = await loadAdminIrlRedeemFinalizeDurableState(
    env,
    operationId,
    dependencies.loadOperation,
    signal,
  );
  let ready = await inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
    env,
    operationId,
    durable,
    dependencies.loadOperation,
    signal,
  );
  ready = preserveRequestedEffect(ready, requestedEffect);
  if (ready.decision !== 'create' && ready.decision !== 'restart') {
    return { status: 'reconciled', reconciliation: ready };
  }
  if (ready.decision === 'restart') {
    ready = await inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
      env,
      operationId,
      ready.durable,
      dependencies.loadOperation,
      signal,
      true,
    );
    ready = preserveRequestedEffect(ready, requestedEffect);
    if (ready.decision !== 'restart') {
      return { status: 'reconciled', reconciliation: ready };
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
          signal,
        })
      : await dependencies.claimEffect({
          claimId: restartClaimId || '',
          env,
          expectedRevision,
          kind: 'restart',
          operationId,
          signal,
        });
  } catch (error) {
    if (clientCancellation.isCancellationError(error)) throw error;
    if (restartClaimId !== undefined) {
      try {
        claim = await dependencies.claimEffect({
          claimId: restartClaimId,
          env,
          expectedRevision,
          kind: 'restart',
          operationId,
          signal,
        });
      } catch (retryError) {
        if (clientCancellation.isCancellationError(retryError)) throw retryError;
        const reconciled = await reconcileAfterFenceError(
          clientCancellation,
          env,
          operationId,
          dependencies,
          signal,
          retryError,
        );
        return { status: 'reconciled', reconciliation: projectStartReconciliation(reconciled) };
      }
    } else {
      const reconciled = await reconcileAfterFenceError(
        clientCancellation,
        env,
        operationId,
        dependencies,
        signal,
        error,
      );
      return { status: 'reconciled', reconciliation: projectStartReconciliation(reconciled) };
    }
  }
  if (claim.status === 'busy') {
    return { status: 'pending' };
  }
  if (claim.status === 'changed') {
    const changed = await reloadStartReconciliation(
      env,
      operationId,
      dependencies,
      signal,
    );
    return { status: 'reconciled', reconciliation: projectStartReconciliation(changed) };
  }
  if (effectKind === 'create') {
    try {
      await raceWithSignal(env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW.createBatch([{
        id: operationId,
        params: reservation.payload,
      }]), signal);
    } catch (error) {
      if (clientCancellation.signal.aborted) throw clientCancellation.signal.reason;
      if (signal.aborted) throw signal.reason;
    }
    if (clientCancellation.signal.aborted) throw clientCancellation.signal.reason;
    if (signal.aborted) throw signal.reason;
    return { status: 'pending' };
  }
  if (!restartClaimId) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Admin IRL redeem finalization failed unexpectedly.');
  }
  const claimedObservation = await inspectAdminIrlRedeemFinalizeWorkflow(
    env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
    operationId,
    signal,
  );
  if (!isRestartableObservation(claimedObservation)) {
    if (clientCancellation.signal.aborted) throw clientCancellation.signal.reason;
    if (signal.aborted) throw signal.reason;
    return { status: 'pending' };
  }
  let dispatchConfirmed = false;
  let dispatch: Awaited<ReturnType<typeof dependencies.dispatchRestart>> | undefined;
  try {
    dispatch = await dependencies.dispatchRestart({
      claimId: restartClaimId,
      env,
      operationId,
      signal,
    });
  } catch (error) {
    if (clientCancellation.isCancellationError(error)) throw error;
    try {
      dispatch = await dependencies.dispatchRestart({
        claimId: restartClaimId,
        env,
        operationId,
        signal,
      });
    } catch (retryError) {
      if (clientCancellation.isCancellationError(retryError)) throw retryError;
      const reconciled = await reconcileAfterFenceError(
        clientCancellation,
        env,
        operationId,
        dependencies,
        signal,
        retryError,
      );
      if (
        (reconciled.durable.state === 'restart-dispatch-pending' ||
          reconciled.durable.state === 'restart-dispatched') &&
        reconciled.durable.claimId === restartClaimId
      ) {
        dispatchConfirmed = true;
      } else {
        return { status: 'reconciled', reconciliation: projectStartReconciliation(reconciled) };
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
      signal,
    );
    if (
      (changed.durable.state === 'restart-dispatch-pending' ||
        changed.durable.state === 'restart-dispatched') &&
      changed.durable.claimId === restartClaimId
    ) {
      dispatchConfirmed = true;
    } else {
      return { status: 'reconciled', reconciliation: projectStartReconciliation(changed) };
    }
  }
  if (!dispatchConfirmed) {
    throw new AdminIrlRedeemFinalizeError('internal', 'Admin IRL redeem finalization failed unexpectedly.');
  }
  const dispatchedObservation = await inspectAdminIrlRedeemFinalizeWorkflow(
    env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
    operationId,
    signal,
  );
  if (!isRestartableObservation(dispatchedObservation)) {
    if (clientCancellation.signal.aborted) throw clientCancellation.signal.reason;
    if (signal.aborted) throw signal.reason;
    let retract: Awaited<ReturnType<typeof dependencies.retractRestart>> | undefined;
    let retractError: unknown;
    let retractFailed = false;
    try {
      retract = await dependencies.retractRestart({
        claimId: restartClaimId,
        env,
        operationId,
        signal,
      });
    } catch (error) {
      if (clientCancellation.isCancellationError(error)) throw error;
      try {
        retract = await dependencies.retractRestart({
          claimId: restartClaimId,
          env,
          operationId,
          signal,
        });
      } catch (retryError) {
        if (clientCancellation.isCancellationError(retryError)) throw retryError;
        retractFailed = true;
        retractError = retryError;
      }
    }
    if (retract?.status === 'retracted') {
      return { status: 'pending' };
    }
    const reconciled = retractFailed
      ? await reconcileAfterFenceError(
          clientCancellation,
          env,
          operationId,
          dependencies,
          signal,
          retractError,
        )
      : await reloadStartReconciliation(
          env,
          operationId,
          dependencies,
          signal,
        );
    if (
      (reconciled.durable.state === 'restart-claim-pending' ||
        reconciled.durable.state === 'restart-claim-expired') &&
      reconciled.durable.claimId === restartClaimId
    ) {
      return { status: 'pending' };
    }
    return { status: 'reconciled', reconciliation: projectStartReconciliation(reconciled) };
  }
  try {
    await raceWithSignal(dispatchedObservation.instance.restart(), signal);
  } catch (error) {
    if (clientCancellation.signal.aborted) throw clientCancellation.signal.reason;
    if (signal.aborted) throw signal.reason;
  }
  if (clientCancellation.signal.aborted) throw clientCancellation.signal.reason;
  if (signal.aborted) throw signal.reason;
  return { status: 'pending' };
}
