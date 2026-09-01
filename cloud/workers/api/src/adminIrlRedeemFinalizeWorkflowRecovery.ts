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

const RESTART_DISPATCH_GRACE_MS = 30_000;

export type AdminIrlRedeemFinalizeDurableState =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'active-confirmed'; revision: string }>
  | Readonly<{ state: 'effect-pending'; revision: string }>
  | Readonly<{ state: 'effect-expired'; revision: string }>
  | Readonly<{ state: 'restart-claim-pending'; claimId: string; revision: string }>
  | Readonly<{ state: 'restart-claim-expired'; claimId: string; revision: string }>
  | Readonly<{ state: 'restart-dispatch-pending'; claimId?: string; revision: string }>
  | Readonly<{ state: 'restart-dispatched'; claimId?: string; revision: string }>
  | Readonly<{
      state: 'manual-recovery';
      failure: AdminIrlRedeemFinalizeWorkflowError;
      revision: string;
    }>
  | Readonly<{ state: 'complete'; revision: string }>
  | Readonly<{
      state: 'failed';
      failure: AdminIrlRedeemFinalizeWorkflowError;
      revision: string;
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
  | 'effect-pending'
  | 'effect-expired'
  | 'restart-claim-pending'
  | 'restart-claim-expired'
  | 'restart-dispatch-pending'
  | 'restart-dispatched'
  | 'manual-recovery'
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
    missing: 'create', pending: 'pending', succeeded: 'complete',
    'retryable-failure': 'restart', 'terminal-failure': 'terminal',
    terminated: 'restart', invalid: 'restart', unavailable: 'pending',
  },
  'effect-pending': {
    missing: 'pending', pending: 'pending', succeeded: 'pending',
    'retryable-failure': 'pending', 'terminal-failure': 'pending',
    terminated: 'pending', invalid: 'pending', unavailable: 'pending',
  },
  'effect-expired': {
    missing: 'create', pending: 'pending', succeeded: 'complete',
    'retryable-failure': 'restart', 'terminal-failure': 'restart',
    terminated: 'restart', invalid: 'restart', unavailable: 'ensure-running',
  },
  'restart-claim-pending': {
    missing: 'pending', pending: 'pending', succeeded: 'pending',
    'retryable-failure': 'pending', 'terminal-failure': 'pending',
    terminated: 'pending', invalid: 'pending', unavailable: 'pending',
  },
  'restart-claim-expired': {
    missing: 'create', pending: 'pending', succeeded: 'complete',
    'retryable-failure': 'restart', 'terminal-failure': 'restart',
    terminated: 'restart', invalid: 'restart', unavailable: 'ensure-running',
  },
  'restart-dispatch-pending': {
    missing: 'pending', pending: 'pending', succeeded: 'pending',
    'retryable-failure': 'pending', 'terminal-failure': 'pending',
    terminated: 'pending', invalid: 'pending', unavailable: 'pending',
  },
  'restart-dispatched': {
    missing: 'terminal', pending: 'pending', succeeded: 'complete',
    'retryable-failure': 'terminal', 'terminal-failure': 'terminal',
    terminated: 'terminal', invalid: 'terminal', unavailable: 'pending',
  },
  'manual-recovery': {
    missing: 'create', pending: 'pending', succeeded: 'complete',
    'retryable-failure': 'restart', 'terminal-failure': 'restart',
    terminated: 'restart', invalid: 'restart', unavailable: 'ensure-running',
  },
  complete: {
    missing: 'complete', pending: 'complete', succeeded: 'complete',
    'retryable-failure': 'complete', 'terminal-failure': 'complete',
    terminated: 'complete', invalid: 'complete', unavailable: 'complete',
  },
  'retryable-failure': {
    missing: 'create', pending: 'pending', succeeded: 'complete',
    'retryable-failure': 'restart', 'terminal-failure': 'terminal',
    terminated: 'restart', invalid: 'restart', unavailable: 'ensure-running',
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
  const revision = operation.revision;
  if (operation.status === 'complete') return { state: 'complete', revision };
  if (operation.status === 'processing' && operation.pendingEffect !== undefined) {
    if (operation.pendingEffect.kind === 'restart-claim') {
      return {
        state: operation.pendingEffect.untilMs > Date.now()
          ? 'restart-claim-pending'
          : 'restart-claim-expired',
        claimId: operation.pendingEffect.claimId,
        revision,
      };
    }
    if (operation.pendingEffect.kind === 'restart') {
      return {
        state: operation.pendingEffect.dispatchedAtMs + RESTART_DISPATCH_GRACE_MS > Date.now()
          ? 'restart-dispatch-pending'
          : 'restart-dispatched',
        ...(operation.pendingEffect.claimId ? { claimId: operation.pendingEffect.claimId } : {}),
        revision,
      };
    }
    return {
      state: operation.pendingEffect.untilMs > Date.now()
        ? 'effect-pending'
        : 'effect-expired',
      revision,
    };
  }
  if (operation.status === 'processing' && operation.failure && !operation.failure.retryable) {
    return { state: 'manual-recovery', failure: operation.failure, revision };
  }
  if (operation.failure) return { state: 'failed', failure: operation.failure, revision };
  return { state: 'active-confirmed', revision };
}

function reconcileAdminIrlRedeemFinalizeWorkflow(
  durable: AdminIrlRedeemFinalizeDurableState,
  observation: AdminIrlRedeemFinalizeWorkflowInspection,
): AdminIrlRedeemFinalizeRecoveryDecision {
  const durableState: DurableDecisionState = durable.state !== 'failed'
    ? durable.state
    : durable.failure.retryable ? 'retryable-failure' : 'terminal-failure';
  if (
    observation.state === 'terminal-failure' &&
    observation.error === undefined &&
    (durableState === 'active-confirmed' || durableState === 'retryable-failure')
  ) return 'restart';
  return RECOVERY_DECISIONS[durableState][observation.state];
}

export function projectAdminIrlRedeemFinalizeStatusDecision(
  reconciliation: AdminIrlRedeemFinalizeWorkflowReconciliation,
): AdminIrlRedeemFinalizeRecoveryDecision {
  if (reconciliation.durable.state === 'manual-recovery') {
    if (['create', 'restart', 'ensure-running'].includes(reconciliation.decision)) return 'terminal';
  }
  if (
    reconciliation.durable.state === 'effect-expired' ||
    reconciliation.durable.state === 'restart-claim-expired'
  ) {
    if (['create', 'restart', 'ensure-running'].includes(reconciliation.decision)) return 'ensure-running';
  }
  if (reconciliation.decision === 'ensure-running') return 'ensure-running';
  if (reconciliation.decision === 'create') {
    return reconciliation.durable.state === 'failed' && reconciliation.durable.failure.retryable
      ? 'ensure-running'
      : 'terminal';
  }
  if (reconciliation.decision === 'restart') {
    return reconciliation.observation.state === 'retryable-failure' ||
        (reconciliation.observation.state === 'terminal-failure' &&
          reconciliation.observation.error === undefined) ||
        (reconciliation.durable.state === 'failed' && reconciliation.durable.failure.retryable)
      ? 'ensure-running'
      : 'terminal';
  }
  return reconciliation.decision;
}

function isAdminIrlRedeemFinalizeWorkflowResourceError(error: unknown): boolean {
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
