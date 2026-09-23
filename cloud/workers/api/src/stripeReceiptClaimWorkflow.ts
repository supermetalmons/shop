import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from 'cloudflare:workers';
import { loadCommerceAuthorityControl } from './commerceRepository.js';
import { StripeReceiptClaimError } from './stripeReceiptClaimErrors.js';
import {
  broadcastReceiptClaimWorkflowTransaction,
  prepareReceiptClaimWorkflowTransaction,
  reconcileReceiptClaimWorkflowOnchain,
} from './stripeReceiptClaimWorkflowOnchain.js';
import {
  completeReceiptClaimWorkflow,
  failReceiptClaimWorkflow,
  loadReceiptClaimWorkflow,
  persistReceiptClaimWorkflowSubmission,
} from './stripeReceiptClaimWorkflowStore.js';
import {
  isReceiptClaimWorkflowOperationId,
  receiptClaimWorkflowInstanceId,
  type ReceiptClaimWorkflowPayload,
  type ReceiptClaimWorkflowSnapshot,
} from './stripeReceiptClaimWorkflowState.js';
import {
  receiptClaimWorkflowContext,
  receiptClaimWorkflowFailure,
  logReceiptClaimWorkflow,
  isReceiptClaimWorkflowRetryableCode,
  type ReceiptClaimWorkflowFailure,
} from './stripeReceiptClaimWorkflowSupport.js';
import { runWorkflowStage, workflowRetryErrorCode } from './workflowStage.js';

const STEP_CONFIG = {
  retries: { limit: 4, delay: '2 seconds', backoff: 'exponential' },
  timeout: '60 seconds',
} as const satisfies WorkflowStepConfig;
const CLEANUP_CONFIG = {
  retries: { limit: 3, delay: '1 second', backoff: 'exponential' },
  timeout: '30 seconds',
} as const satisfies WorkflowStepConfig;

const defaultDependencies = {
  load: loadReceiptClaimWorkflow,
  reconcile: reconcileReceiptClaimWorkflowOnchain,
  prepare: prepareReceiptClaimWorkflowTransaction,
  persist: persistReceiptClaimWorkflowSubmission,
  broadcast: broadcastReceiptClaimWorkflowTransaction,
  complete: completeReceiptClaimWorkflow,
  fail: failReceiptClaimWorkflow,
  authority: loadCommerceAuthorityControl,
  nowMs: Date.now,
};

const RETRY_ERROR_MARKER = {
  name: 'StripeReceiptClaimWorkflowRetry',
  messagePrefix: 'stripe-receipt-claim-retry:',
  isCode: isReceiptClaimWorkflowRetryableCode,
  fallbackCode: 'unavailable',
} as const;

export async function runStripeReceiptClaimWorkflow(
  env: Env,
  event: Readonly<WorkflowEvent<ReceiptClaimWorkflowPayload>>,
  step: Pick<WorkflowStep, 'do' | 'sleep'>,
  overrides: Partial<typeof defaultDependencies> = {},
): Promise<{ version: 1; operationId: string; status: 'complete' | 'failed' | 'superseded' }> {
  const payload = event.payload;
  if (payload.version !== 1 || !isReceiptClaimWorkflowOperationId(payload.operationId) ||
    !Number.isSafeInteger(payload.generation) || payload.generation < 1 ||
    event.instanceId !== receiptClaimWorkflowInstanceId(payload)) {
    throw new Error('Invalid receipt claim Workflow payload.');
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  const stage = <T extends Rpc.Serializable<T>>(name: string, action: (signal: AbortSignal) => Promise<T>) =>
    runWorkflowStage({
      step,
      name,
      config: STEP_CONFIG,
      actionTimeoutMs: 55_000,
      normalizeError: receiptClaimWorkflowFailure,
      retryErrorMarker: RETRY_ERROR_MARKER,
      log: (entry) => logReceiptClaimWorkflow({
        operationId: payload.operationId, generation: payload.generation, stage: name, ...entry,
      }),
      action,
    });
  const context = (signal: AbortSignal) => receiptClaimWorkflowContext(env, signal, dependencies.nowMs());
  const current = async (signal: AbortSignal): Promise<ReceiptClaimWorkflowSnapshot> => {
    signal.throwIfAborted();
    const snapshot = await dependencies.load(context(signal), payload.operationId);
    if (!snapshot || snapshot.operation.generation !== payload.generation || snapshot.operation.phase !== 'pending') {
      throw new StripeReceiptClaimError('failed-precondition', 'Receipt claim Workflow execution changed.');
    }
    return snapshot;
  };
  let failure: ReceiptClaimWorkflowFailure | undefined;
  try {
    for (let iteration = 0; !failure; iteration += 1) {
      const reconciled = await stage(`reconcile receipt ${iteration}`, async (signal) => {
        const snapshot = await current(signal);
        if (dependencies.nowMs() >= snapshot.operation.deadlineAtMs) return { status: 'expired' } as const;
        if ((await dependencies.authority(env.COMMERCE_DB)).state === 'paused') return { status: 'pending' } as const;
        return dependencies.reconcile({ env, snapshot, signal });
      });
      if (!reconciled.ok) { failure = reconciled.error; break; }
      const outcome = reconciled.value;
      if (outcome.status === 'expired') {
        failure = {
          code: 'deadline-exceeded',
          message: 'Receipt delivery is still resolving. Retry with the same receiver address.',
          retryable: true,
        };
        break;
      }
      if (outcome.status === 'complete') {
        const completed = await stage(`publish receipt completion ${iteration}`, async (signal) => {
          await dependencies.complete(context(signal), await current(signal), outcome.result);
          logReceiptClaimWorkflow({ operationId: payload.operationId, generation: payload.generation, outcome: 'complete' });
          return { completed: true };
        });
        if (!completed.ok) { failure = completed.error; break; }
        return { version: 1, operationId: payload.operationId, status: 'complete' };
      }
      if (outcome.status === 'prepare') {
        const persisted = await stage(`journal receipt transaction ${iteration}`, async (signal) => {
          const snapshot = await current(signal);
          if (snapshot.operation.submission && snapshot.operation.submission.status !== 'not_landed') {
            return { signature: snapshot.operation.submission.signature };
          }
          const prepared = await dependencies.prepare({ env, snapshot, signal });
          await dependencies.persist(context(signal), snapshot, prepared);
          return { signature: prepared.signature };
        });
        if (!persisted.ok) { failure = persisted.error; break; }
      }
      if (outcome.status === 'prepare' || outcome.status === 'broadcast') {
        const broadcast = await stage(`broadcast receipt transaction ${iteration}`, async (signal) => {
          const snapshot = await current(signal);
          if (dependencies.nowMs() >= snapshot.operation.deadlineAtMs) return { sent: false };
          if ((await dependencies.authority(env.COMMERCE_DB)).state === 'paused') return { sent: false };
          await dependencies.broadcast({ env, snapshot, signal });
          return { sent: true };
        });
        if (!broadcast.ok) { failure = broadcast.error; break; }
      }
      await step.sleep(`wait for receipt confirmation ${iteration}`, '5 seconds');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Aborting engine:')) throw error;
    const retryCode = workflowRetryErrorCode(error, RETRY_ERROR_MARKER);
    failure = retryCode
      ? { ...receiptClaimWorkflowFailure(undefined), code: retryCode }
      : receiptClaimWorkflowFailure(error);
  }
  return step.do('persist receipt claim failure', CLEANUP_CONFIG, async () => {
    const signal = AbortSignal.timeout(25_000);
    const snapshot = await dependencies.load(context(signal), payload.operationId);
    if (snapshot?.operation.phase === 'complete') {
      return { version: 1, operationId: payload.operationId, status: 'complete' } as const;
    }
    if (!snapshot || snapshot.operation.generation !== payload.generation) {
      return { version: 1, operationId: payload.operationId, status: 'superseded' } as const;
    }
    if (snapshot.operation.phase === 'pending') {
      const error = failure || receiptClaimWorkflowFailure(undefined);
      await dependencies.fail(context(signal), snapshot, error, error.retryable);
      logReceiptClaimWorkflow({
        outcome: 'failed',
        operationId: payload.operationId,
        generation: payload.generation,
        errorCode: error.code,
        retryable: error.retryable,
      });
    }
    return { version: 1, operationId: payload.operationId, status: 'failed' } as const;
  });
}

export class StripeReceiptClaimWorkflowV1 extends WorkflowEntrypoint<Env, ReceiptClaimWorkflowPayload> {
  override run(event: Readonly<WorkflowEvent<ReceiptClaimWorkflowPayload>>, step: WorkflowStep) {
    return runStripeReceiptClaimWorkflow(this.env, event, step);
  }
}
