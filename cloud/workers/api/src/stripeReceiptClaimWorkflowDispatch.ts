import { raceWithSignal } from './boundedRequest.js';
import { isRecord } from './dataAccess.js';
import { StripeReceiptClaimError } from './stripeReceiptClaimErrors.js';
import {
  advanceReceiptClaimWorkflowGeneration,
  claimReceiptClaimWorkflowDispatch,
  deferReceiptClaimWorkflow,
  failReceiptClaimWorkflow,
  joinReceiptClaimWorkflowGeneration,
  loadReceiptClaimWorkflow,
  markReceiptClaimWorkflowDispatched,
  queryDueReceiptClaimWorkflows,
} from './stripeReceiptClaimWorkflowStore.js';
import {
  receiptClaimWorkflowInstanceId,
  type ReceiptClaimWorkflowPayload,
  type ReceiptClaimWorkflowSnapshot,
} from './stripeReceiptClaimWorkflowState.js';
import { receiptClaimWorkflowContext } from './stripeReceiptClaimWorkflowSupport.js';

type InstanceObservation = 'missing' | 'active' | 'terminal' | 'unavailable';

export class ReceiptClaimWorkflowRecoveryPending extends StripeReceiptClaimError {
  constructor() {
    super('unavailable', 'Receipt claim recovery is initializing. Retry this same request shortly.');
  }
}

export async function inspectReceiptClaimWorkflow(
  binding: Workflow<ReceiptClaimWorkflowPayload>,
  snapshot: ReceiptClaimWorkflowSnapshot,
  signal: AbortSignal,
): Promise<InstanceObservation> {
  try {
    const instance = await raceWithSignal(binding.get(receiptClaimWorkflowInstanceId(snapshot.operation)), signal);
    const status = await raceWithSignal(instance.status(), signal);
    return ['complete', 'errored', 'terminated'].includes(status.status) ? 'terminal' : 'active';
  } catch (error) {
    signal.throwIfAborted();
    return isRecord(error) && (error.code === 'instance.not_found' || error.message === 'instance.not_found')
      ? 'missing'
      : 'unavailable';
  }
}

const defaultDependencies = {
  load: loadReceiptClaimWorkflow,
  claimDispatch: claimReceiptClaimWorkflowDispatch,
  markDispatched: markReceiptClaimWorkflowDispatched,
  advance: advanceReceiptClaimWorkflowGeneration,
  defer: deferReceiptClaimWorkflow,
  fail: failReceiptClaimWorkflow,
  join: joinReceiptClaimWorkflowGeneration,
  inspect: inspectReceiptClaimWorkflow,
  nowMs: Date.now,
};

export async function ensureReceiptClaimWorkflowRunning(
  env: Env,
  snapshot: ReceiptClaimWorkflowSnapshot,
  signal: AbortSignal,
  requestId?: string,
  overrides: Partial<typeof defaultDependencies> = {},
): Promise<ReceiptClaimWorkflowSnapshot> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const context = receiptClaimWorkflowContext(env, signal, dependencies.nowMs());
  const latest = await dependencies.load(context, snapshot.operation.operationId);
  if (!latest) throw new StripeReceiptClaimError('not-found', 'Receipt claim operation not found.');
  if (latest.operation.phase === 'complete') return latest;
  snapshot = requestId && latest.operation.generation > snapshot.operation.generation
    ? await dependencies.join(context, snapshot, requestId)
    : latest;
  if (snapshot.operation.phase === 'complete') return snapshot;
  const failed = snapshot.operation.phase !== 'pending';
  const explicitRetry = requestId !== undefined && !snapshot.operation.requestIds.includes(requestId);
  if (failed && (!explicitRetry || !snapshot.operation.error?.retryable)) return snapshot;
  let observation = await dependencies.inspect(env.STRIPE_RECEIPT_CLAIM_WORKFLOW, snapshot, signal);
  if (failed && observation === 'missing') {
    try {
      await raceWithSignal(env.STRIPE_RECEIPT_CLAIM_WORKFLOW.createBatch([{
        id: receiptClaimWorkflowInstanceId(snapshot.operation),
        params: { version: 1, operationId: snapshot.operation.operationId, generation: snapshot.operation.generation },
      }]), signal);
    } catch {
      signal.throwIfAborted();
      throw new ReceiptClaimWorkflowRecoveryPending();
    }
    observation = await dependencies.inspect(env.STRIPE_RECEIPT_CLAIM_WORKFLOW, snapshot, signal);
  }
  if (failed && observation !== 'terminal') throw new ReceiptClaimWorkflowRecoveryPending();
  const expired = !failed && dependencies.nowMs() >= snapshot.operation.deadlineAtMs &&
    (observation === 'active' || observation === 'terminal');
  if (expired || observation === 'active') {
    try {
      if (expired) {
        await dependencies.fail(context, snapshot, {
          code: 'deadline-exceeded',
          message: 'Receipt delivery is still resolving. Retry with the same receiver address.',
          retryable: true,
        }, true);
      } else {
        await dependencies.defer(context, snapshot, dependencies.nowMs() + 60_000);
      }
    } catch (error) {
      if (!(error instanceof StripeReceiptClaimError) || error.code !== 'aborted') throw error;
      const current = await dependencies.load(context, snapshot.operation.operationId);
      if (!current || (current.operation.generation === snapshot.operation.generation && current.operation.phase === 'pending')) throw error;
      return current;
    }
    return await dependencies.load(context, snapshot.operation.operationId) || snapshot;
  }
  if (observation === 'terminal') {
    const advanced = await dependencies.advance(context, snapshot, dependencies.nowMs(), {
      resetRetryWindow: explicitRetry && failed,
      ...(explicitRetry && failed ? { requestId } : {}),
    });
    if (!advanced) return requestId
      ? dependencies.join(context, snapshot, requestId)
      : await dependencies.load(context, snapshot.operation.operationId) || snapshot;
    snapshot = advanced;
  }
  const claimed = await dependencies.claimDispatch(context, {
    operationId: snapshot.operation.operationId,
    generation: snapshot.operation.generation,
    nowMs: dependencies.nowMs(),
  });
  if (!claimed) return await dependencies.load(context, snapshot.operation.operationId) || snapshot;
  try {
    await raceWithSignal(env.STRIPE_RECEIPT_CLAIM_WORKFLOW.createBatch([{
      id: receiptClaimWorkflowInstanceId(claimed.operation),
      params: {
        version: 1,
        operationId: claimed.operation.operationId,
        generation: claimed.operation.generation,
      },
    }]), signal);
    await dependencies.markDispatched(context, claimed, dependencies.nowMs());
  } catch (error) {
    signal.throwIfAborted();
    console.warn({
      event: 'receipt_claim_workflow_dispatch_pending',
      operationId: claimed.operation.operationId,
      generation: claimed.operation.generation,
      error: error instanceof Error ? { name: error.name } : { name: 'UnknownError' },
    });
  }
  return await dependencies.load(context, snapshot.operation.operationId) || claimed;
}

export async function reconcileReceiptClaimWorkflows(
  env: Env,
  signal: AbortSignal,
  overrides: {
    queryDue?: typeof queryDueReceiptClaimWorkflows;
    ensure?: typeof ensureReceiptClaimWorkflowRunning;
    load?: typeof loadReceiptClaimWorkflow;
    nowMs?: () => number;
  } = {},
): Promise<number> {
  const nowMs = overrides.nowMs || Date.now;
  signal.throwIfAborted();
  const operationIds = await (overrides.queryDue || queryDueReceiptClaimWorkflows)(env.COMMERCE_DB, nowMs(), 8);
  const failures: unknown[] = [];
  let processed = 0;
  for (const operationId of operationIds) {
    signal.throwIfAborted();
    try {
      const snapshot = await (overrides.load || loadReceiptClaimWorkflow)(receiptClaimWorkflowContext(env, signal, nowMs()), operationId);
      if (!snapshot) continue;
      await (overrides.ensure || ensureReceiptClaimWorkflowRunning)(env, snapshot, signal);
      processed += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Receipt claim Workflow reconciliation failed');
  return processed;
}
