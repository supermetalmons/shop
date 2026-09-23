import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import {
  cleanupAdminIrlRedeemFinalizeWorkflow,
  prepareAdminIrlRedeemFinalizeWorkflowDraft,
  publishAdminIrlRedeemFinalizeWorkflow,
  resumeAndReconcileAdminIrlRedeemFinalizeWorkflow,
  validateAdminIrlRedeemFinalizeWorkflow,
} from './adminIrlRedeemFinalize.js';
import {
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeWorkflowError,
  type AdminIrlRedeemFinalizeWorkflowError,
  type AdminIrlRedeemFinalizeWorkflowOutput,
  type AdminIrlRedeemFinalizeWorkflowPayload,
  type AdminIrlRedeemFinalizeWorkflowResultReference,
} from './adminIrlRedeemFinalizeWorkflowState.js';
import {
  runWorkflowStage,
  workflowRetryError,
  workflowRetryErrorCode,
  type WorkflowStageResult,
} from './workflowStage.js';

const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const PACK_STEP_TIMEOUT_MS = 25 * 60 * 1000;
const STEP_CONFIG = {
  retries: { limit: 4, delay: '2 seconds', backoff: 'exponential' },
  timeout: STEP_TIMEOUT_MS,
} as const satisfies WorkflowStepConfig;
const PACK_STEP_CONFIG = {
  retries: { limit: 4, delay: '2 seconds', backoff: 'exponential' },
  timeout: PACK_STEP_TIMEOUT_MS,
  sensitive: 'output',
} as const satisfies WorkflowStepConfig;
const CLEANUP_STEP_CONFIG = {
  retries: { limit: 3, delay: '1 second', backoff: 'exponential' },
  timeout: 30_000,
} as const satisfies WorkflowStepConfig;
const REPORT_STEP_CONFIG = {
  retries: { limit: 0, delay: 0 },
  timeout: 5_000,
} as const satisfies WorkflowStepConfig;

type RetryableWorkflowErrorCode = 'aborted' | 'deadline-exceeded' | 'unavailable' | 'internal';

const RETRY_ERROR_MARKER = {
  name: 'AdminIrlRedeemFinalizeWorkflowRetry',
  messagePrefix: 'admin-irl-redeem-finalize-retry:',
  isCode: isRetryableWorkflowErrorCode,
  fallbackCode: 'internal',
} as const;
const WORKFLOW_ENGINE_ABORT_PREFIX = 'Aborting engine:';

export type AdminIrlRedeemFinalizeWorkflowDependencies = Readonly<{
  cleanup: typeof cleanupAdminIrlRedeemFinalizeWorkflow;
  prepareDraft: typeof prepareAdminIrlRedeemFinalizeWorkflowDraft;
  publish: typeof publishAdminIrlRedeemFinalizeWorkflow;
  resumeAndReconcile: typeof resumeAndReconcileAdminIrlRedeemFinalizeWorkflow;
  validate: typeof validateAdminIrlRedeemFinalizeWorkflow;
}>;

const defaultDependencies: AdminIrlRedeemFinalizeWorkflowDependencies = {
  cleanup: cleanupAdminIrlRedeemFinalizeWorkflow,
  prepareDraft: prepareAdminIrlRedeemFinalizeWorkflowDraft,
  publish: publishAdminIrlRedeemFinalizeWorkflow,
  resumeAndReconcile: resumeAndReconcileAdminIrlRedeemFinalizeWorkflow,
  validate: validateAdminIrlRedeemFinalizeWorkflow,
};

type WorkflowLogContext = Readonly<{
  dropId: string;
  operationId: string;
  requestId: string;
}>;

type WorkflowLogLevel = 'info' | 'warning' | 'error';

function logWorkflow(
  context: WorkflowLogContext,
  fields: Readonly<Record<string, string | number | boolean>>,
  level: WorkflowLogLevel = 'info',
): void {
  try {
    const entry = JSON.stringify({
      event: 'admin_irl_redeem_finalize_workflow',
      version: 1,
      ...context,
      ...fields,
    });
    if (level === 'error') {
      console.error(entry);
      return;
    }
    if (level === 'warning') {
      console.warn(entry);
      return;
    }
    console.log(entry);
  } catch {
  }
}

function isRetryableWorkflowErrorCode(value: unknown): value is RetryableWorkflowErrorCode {
  return value === 'aborted' || value === 'deadline-exceeded' || value === 'unavailable' || value === 'internal';
}

function isWorkflowEngineAbort(error: unknown): boolean {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return false;
  try {
    return typeof (error as { message?: unknown }).message === 'string' &&
      (error as { message: string }).message.startsWith(WORKFLOW_ENGINE_ABORT_PREFIX);
  } catch {
    return false;
  }
}

function retryFailure(code: RetryableWorkflowErrorCode): AdminIrlRedeemFinalizeWorkflowError {
  return adminIrlRedeemFinalizeWorkflowError(new AdminIrlRedeemFinalizeError(code, ''));
}

async function runStage<T extends Rpc.Serializable<T>>(
  step: Pick<WorkflowStep, 'do'>,
  name: string,
  config: WorkflowStepConfig,
  logContext: WorkflowLogContext,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<WorkflowStageResult<T>> {
  const timeout = typeof config.timeout === 'number' ? config.timeout : STEP_TIMEOUT_MS;
  return runWorkflowStage({
    step,
    name,
    config,
    actionTimeoutMs: Math.max(1, timeout - 5_000),
    normalizeError: adminIrlRedeemFinalizeWorkflowError,
    retryErrorMarker: RETRY_ERROR_MARKER,
    log: (entry) => logWorkflow(logContext, { step: name, ...entry },
      entry.outcome === 'succeeded' ? 'info' : entry.outcome === 'retryable_failure' ? 'warning' : 'error'),
    action,
  });
}

function workflowFailure(error: unknown): AdminIrlRedeemFinalizeWorkflowError {
  const retryCode = workflowRetryErrorCode(error, RETRY_ERROR_MARKER);
  if (retryCode) return retryFailure(retryCode);
  return adminIrlRedeemFinalizeWorkflowError(error);
}

export async function runAdminIrlRedeemFinalizeWorkflow(
  env: Env,
  event: Readonly<WorkflowEvent<AdminIrlRedeemFinalizeWorkflowPayload>>,
  step: Pick<WorkflowStep, 'do'>,
  overrides: Partial<AdminIrlRedeemFinalizeWorkflowDependencies> = {},
): Promise<AdminIrlRedeemFinalizeWorkflowOutput> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const logContext = {
    operationId: event.instanceId,
    dropId: event.payload.dropId,
    requestId: event.payload.requestId,
  };
  const args = (signal: AbortSignal) => ({
    env,
    operationId: event.instanceId,
    payload: event.payload,
    signal,
  });
  let failure: AdminIrlRedeemFinalizeWorkflowError | undefined;
  let reference: AdminIrlRedeemFinalizeWorkflowResultReference | undefined;
  try {
    const resumed = await runStage(
      step,
      'resume exact lease and reconcile WAL',
      STEP_CONFIG,
      logContext,
      (signal) => dependencies.resumeAndReconcile(args(signal)),
    );
    if (!resumed.ok) failure = resumed.error;
    if (!failure) {
      const validated = await runStage(
        step,
        'validate configuration and transfer',
        STEP_CONFIG,
        logContext,
        (signal) => dependencies.validate(args(signal)),
      );
      if (!validated.ok) failure = validated.error;
    }
    if (!failure) {
      const prepared = await runStage(
        step,
        'prepare immutable publication draft',
        PACK_STEP_CONFIG,
        logContext,
        (signal) => dependencies.prepareDraft(args(signal)),
      );
      if (!prepared.ok) failure = prepared.error;
    }
    if (!failure) {
      const published = await runStage(
        step,
        'publish durable completion',
        STEP_CONFIG,
        logContext,
        (signal) => dependencies.publish(args(signal)),
      );
      if (published.ok) reference = published.value;
      else failure = published.error;
    }
  } catch (error) {
    if (isWorkflowEngineAbort(error)) throw error;
    failure = workflowFailure(error);
  }
  if (!failure && reference) {
    return { version: 1, ok: true, result: reference };
  }
  const projected = failure || {
    code: 'internal',
    message: 'Admin IRL redeem finalization failed unexpectedly.',
    retryable: true,
  } as const;
  try {
    await step.do('persist terminal failure', CLEANUP_STEP_CONFIG, async (context) => {
      const startedAt = performance.now();
      try {
        const result = await dependencies.cleanup({
          env,
          error: projected,
          operationId: event.instanceId,
          payload: event.payload,
          signal: AbortSignal.timeout(25_000),
        });
        logWorkflow(logContext, {
          step: 'persist terminal failure',
          retryAttempt: context.attempt,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          outcome: 'terminal_failure',
          errorCode: projected.code,
          cleanupOutcome: result.cleared
            ? 'cleared'
            : projected.retryable ? 'retained_automatic' : 'retained_manual',
        }, 'error');
        return result;
      } catch (error) {
        const normalized = adminIrlRedeemFinalizeWorkflowError(error);
        logWorkflow(logContext, {
          step: 'persist terminal failure',
          retryAttempt: context.attempt,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          outcome: 'cleanup_failure',
          errorCode: normalized.code,
        }, 'error');
        throw workflowRetryError(RETRY_ERROR_MARKER, normalized.code);
      }
    });
  } catch (error) {
    if (isWorkflowEngineAbort(error)) throw error;
    try {
      await step.do('report cleanup exhaustion', REPORT_STEP_CONFIG, async () => {
        logWorkflow(logContext, {
          step: 'persist terminal failure',
          outcome: 'cleanup_exhausted',
          errorCode: 'unavailable',
          retryExhausted: true,
        }, 'error');
        return { reported: true } as const;
      });
    } catch (reportError) {
      if (isWorkflowEngineAbort(reportError)) throw reportError;
    }
    const cleanupFailure = {
      version: 1,
      ok: false,
      error: retryFailure('unavailable'),
    } as const;
    return cleanupFailure;
  }
  return { version: 1, ok: false, error: projected };
}

export class AdminIrlRedeemFinalizeWorkflowV1 extends WorkflowEntrypoint<
  Env,
  AdminIrlRedeemFinalizeWorkflowPayload
> {
  override run(
    event: Readonly<WorkflowEvent<AdminIrlRedeemFinalizeWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<AdminIrlRedeemFinalizeWorkflowOutput> {
    return runAdminIrlRedeemFinalizeWorkflow(this.env, event, step);
  }
}
