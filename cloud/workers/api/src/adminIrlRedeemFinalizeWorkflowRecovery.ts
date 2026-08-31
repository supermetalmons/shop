import type {
  AdminIrlRedeemFinalizeWorkflowError,
  AdminIrlRedeemFinalizeWorkflowOutput,
  AdminIrlRedeemFinalizeWorkflowPayload,
  AdminIrlRedeemFinalizeWorkflowStoredOperation,
} from './adminIrlRedeemFinalize.js';
import {
  loadAdminIrlRedeemFinalizeWorkflowOperation,
  parseAdminIrlRedeemFinalizeWorkflowOutput,
} from './adminIrlRedeemFinalize.js';
import { raceWithSignal } from './boundedRequest.js';
import { isRecord } from './dataAccess.js';

export type AdminIrlRedeemFinalizeDurableState =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'active-confirmed' }>
  | Readonly<{ state: 'active-unconfirmed' }>
  | Readonly<{ state: 'complete' }>
  | Readonly<{
      state: 'failed';
      failure: AdminIrlRedeemFinalizeWorkflowError;
    }>;

export type AdminIrlRedeemFinalizeWorkflowObservation = Readonly<{
  state:
    | 'missing'
    | 'pending'
    | 'succeeded'
    | 'retryable-failure'
    | 'terminal-failure'
    | 'terminated'
    | 'invalid'
    | 'unavailable';
}>;

export type AdminIrlRedeemFinalizeRecoveryDecision =
  | 'complete'
  | 'terminal'
  | 'pending'
  | 'create'
  | 'restart'
  | 'confirm-instance'
  | 'ensure-running'
  | 'not-found';

export type AdminIrlRedeemFinalizeWorkflowInspection =
  | Readonly<{ state: 'missing' }>
  | Readonly<{ state: 'pending'; instance: WorkflowInstance }>
  | Readonly<{
      state: 'succeeded';
      instance: WorkflowInstance;
      output: Extract<AdminIrlRedeemFinalizeWorkflowOutput, { ok: true }>;
    }>
  | Readonly<{
      state: 'retryable-failure';
      error: AdminIrlRedeemFinalizeWorkflowError;
      instance: WorkflowInstance;
    }>
  | Readonly<{
      state: 'terminal-failure';
      error?: AdminIrlRedeemFinalizeWorkflowError;
      instance: WorkflowInstance;
    }>
  | Readonly<{ state: 'terminated'; instance: WorkflowInstance }>
  | Readonly<{ state: 'invalid'; instance: WorkflowInstance }>
  | Readonly<{
      state: 'unavailable';
      error: unknown;
      reason: 'resource-10200' | 'inspection';
    }>;

export type AdminIrlRedeemFinalizeWorkflowReconciliation = Readonly<{
  decision: AdminIrlRedeemFinalizeRecoveryDecision;
  durable: AdminIrlRedeemFinalizeDurableState;
  observation: AdminIrlRedeemFinalizeWorkflowInspection;
}>;

export type AdminIrlRedeemFinalizeLoadOperation =
  typeof loadAdminIrlRedeemFinalizeWorkflowOperation;

type DurableDecisionState =
  | 'absent'
  | 'active-confirmed'
  | 'active-unconfirmed'
  | 'complete'
  | 'retryable-failure'
  | 'terminal-failure';

const RECOVERY_DECISIONS: Readonly<Record<
  DurableDecisionState,
  Readonly<Record<AdminIrlRedeemFinalizeWorkflowObservation['state'], AdminIrlRedeemFinalizeRecoveryDecision>>
>> = {
  absent: {
    missing: 'not-found', pending: 'not-found', succeeded: 'not-found',
    'retryable-failure': 'not-found', 'terminal-failure': 'not-found',
    terminated: 'not-found', invalid: 'not-found', unavailable: 'not-found',
  },
  'active-confirmed': {
    missing: 'terminal', pending: 'pending', succeeded: 'complete',
    'retryable-failure': 'restart', 'terminal-failure': 'terminal',
    terminated: 'terminal', invalid: 'terminal', unavailable: 'pending',
  },
  'active-unconfirmed': {
    missing: 'create', pending: 'confirm-instance', succeeded: 'confirm-instance',
    'retryable-failure': 'confirm-instance', 'terminal-failure': 'confirm-instance',
    terminated: 'confirm-instance', invalid: 'confirm-instance', unavailable: 'pending',
  },
  complete: {
    missing: 'complete', pending: 'complete', succeeded: 'complete',
    'retryable-failure': 'complete', 'terminal-failure': 'complete',
    terminated: 'complete', invalid: 'complete', unavailable: 'complete',
  },
  'retryable-failure': {
    missing: 'ensure-running', pending: 'pending', succeeded: 'complete',
    'retryable-failure': 'restart', 'terminal-failure': 'terminal',
    terminated: 'terminal', invalid: 'terminal', unavailable: 'ensure-running',
  },
  'terminal-failure': {
    missing: 'terminal', pending: 'terminal', succeeded: 'terminal',
    'retryable-failure': 'terminal', 'terminal-failure': 'terminal',
    terminated: 'terminal', invalid: 'terminal', unavailable: 'terminal',
  },
};

function normalizeAdminIrlRedeemFinalizeDurableState(
  operation: AdminIrlRedeemFinalizeWorkflowStoredOperation | null,
): AdminIrlRedeemFinalizeDurableState {
  if (!operation) return { state: 'absent' };
  if (operation.status === 'complete') return { state: 'complete' };
  if (operation.failure) return { state: 'failed', failure: operation.failure };
  return {
    state: operation.instanceCreationPending === true
      ? 'active-unconfirmed'
      : 'active-confirmed',
  };
}

function reconcileAdminIrlRedeemFinalizeWorkflow(
  durable: AdminIrlRedeemFinalizeDurableState,
  observation: AdminIrlRedeemFinalizeWorkflowObservation,
): AdminIrlRedeemFinalizeRecoveryDecision {
  const durableState: DurableDecisionState = durable.state !== 'failed'
    ? durable.state
    : durable.failure.retryable ? 'retryable-failure' : 'terminal-failure';
  return RECOVERY_DECISIONS[durableState][observation.state];
}

export function projectAdminIrlRedeemFinalizeStatusDecision(
  decision: AdminIrlRedeemFinalizeRecoveryDecision,
): AdminIrlRedeemFinalizeRecoveryDecision {
  return ({
    create: 'ensure-running',
    restart: 'ensure-running',
    'confirm-instance': 'ensure-running',
  } as const)[
    decision as 'create' | 'restart' | 'confirm-instance'
  ] || decision;
}

export function isAdminIrlRedeemFinalizeWorkflowResourceError(error: unknown): boolean {
  return isRecord(error) && error.code === 10200;
}

export async function inspectAdminIrlRedeemFinalizeWorkflow(
  binding: Workflow<AdminIrlRedeemFinalizeWorkflowPayload>,
  operationId: string,
  signal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeWorkflowInspection> {
  try {
    const instance = await raceWithSignal(binding.get(operationId), signal);
    const status = await raceWithSignal(instance.status(), signal);
    if (['queued', 'running', 'paused', 'waiting', 'waitingForPause', 'unknown'].includes(status.status)) {
      return { state: 'pending', instance };
    }
    if (status.status === 'terminated') return { state: 'terminated', instance };
    if (status.status === 'errored') return { state: 'terminal-failure', instance };
    if (status.status !== 'complete') return { state: 'invalid', instance };
    const output = parseAdminIrlRedeemFinalizeWorkflowOutput(status.output);
    if (!output) return { state: 'invalid', instance };
    if (output.ok) return { state: 'succeeded', instance, output };
    return output.error.retryable
      ? { state: 'retryable-failure', instance, error: output.error }
      : { state: 'terminal-failure', instance, error: output.error };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (
      isRecord(error) && error.code !== 10200 &&
      (error.code === 'instance.not_found' || error.message === 'instance.not_found')
    ) return { state: 'missing' };
    return {
      state: 'unavailable',
      error,
      reason: isAdminIrlRedeemFinalizeWorkflowResourceError(error)
        ? 'resource-10200'
        : 'inspection',
    };
  }
}

export async function loadAdminIrlRedeemFinalizeDurableState(
  env: Env,
  operationId: string,
  loadOperation: AdminIrlRedeemFinalizeLoadOperation,
  signal: AbortSignal,
): Promise<AdminIrlRedeemFinalizeDurableState> {
  if (signal.aborted) throw signal.reason;
  return normalizeAdminIrlRedeemFinalizeDurableState(
    await raceWithSignal(loadOperation({ env, operationId }), signal),
  );
}

export function reconcileAdminIrlRedeemFinalizeInspection(
  durable: AdminIrlRedeemFinalizeDurableState,
  observation: AdminIrlRedeemFinalizeWorkflowInspection,
): AdminIrlRedeemFinalizeWorkflowReconciliation {
  return {
    decision: reconcileAdminIrlRedeemFinalizeWorkflow(durable, observation),
    durable,
    observation,
  };
}

export async function inspectAndReconcileAdminIrlRedeemFinalizeWorkflow(
  env: Env,
  operationId: string,
  durable: AdminIrlRedeemFinalizeDurableState,
  loadOperation: AdminIrlRedeemFinalizeLoadOperation,
  signal: AbortSignal,
  forceReload = false,
): Promise<AdminIrlRedeemFinalizeWorkflowReconciliation> {
  const observation = await inspectAdminIrlRedeemFinalizeWorkflow(
    env.ADMIN_IRL_REDEEM_FINALIZE_WORKFLOW,
    operationId,
    signal,
  );
  const latest = forceReload || observation.state !== 'pending'
    ? await loadAdminIrlRedeemFinalizeDurableState(env, operationId, loadOperation, signal)
    : durable;
  return reconcileAdminIrlRedeemFinalizeInspection(latest, observation);
}
