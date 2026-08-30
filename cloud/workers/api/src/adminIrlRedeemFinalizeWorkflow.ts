import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import {
  AdminIrlRedeemFinalizeError,
  adminIrlRedeemFinalizeWorkflowError,
  cleanupAdminIrlRedeemFinalizeWorkflow,
  prepareAdminIrlRedeemFinalizeWorkflowDraft,
  publishAdminIrlRedeemFinalizeWorkflow,
  resumeAndReconcileAdminIrlRedeemFinalizeWorkflow,
  validateAdminIrlRedeemFinalizeWorkflow,
  type AdminIrlRedeemFinalizeWorkflowError,
  type AdminIrlRedeemFinalizeWorkflowOutput,
  type AdminIrlRedeemFinalizeWorkflowPayload,
  type AdminIrlRedeemFinalizeWorkflowResultReference,
} from './adminIrlRedeemFinalize.js';

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

type StageResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: AdminIrlRedeemFinalizeWorkflowError }>;

type RetryableWorkflowErrorCode = 'aborted' | 'deadline-exceeded' | 'unavailable' | 'internal';

const RETRY_ERROR_NAME = 'AdminIrlRedeemFinalizeWorkflowRetry';
const RETRY_ERROR_MESSAGE_PREFIX = 'admin-irl-redeem-finalize-retry:';

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
}

function isRetryableWorkflowErrorCode(value: unknown): value is RetryableWorkflowErrorCode {
  return value === 'aborted' || value === 'deadline-exceeded' || value === 'unavailable' || value === 'internal';
}

function retryStageError(code: RetryableWorkflowErrorCode): Error {
  const error = new Error(`${RETRY_ERROR_MESSAGE_PREFIX}${code}`);
  error.name = RETRY_ERROR_NAME;
  return error;
}

function retryErrorCode(error: unknown): RetryableWorkflowErrorCode | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null;
  let name: unknown;
  let message: unknown;
  try {
    name = (error as { name?: unknown }).name;
    message = (error as { message?: unknown }).message;
  } catch {
    return null;
  }
  if (name !== RETRY_ERROR_NAME || typeof message !== 'string' || !message.startsWith(RETRY_ERROR_MESSAGE_PREFIX)) {
    return null;
  }
  const code = message.slice(RETRY_ERROR_MESSAGE_PREFIX.length);
  return isRetryableWorkflowErrorCode(code) ? code : null;
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
): Promise<StageResult<T>> {
  const timeout = typeof config.timeout === 'number' ? config.timeout : STEP_TIMEOUT_MS;
  return step.do(name, config, async (context) => {
    const startedAt = performance.now();
    try {
      const value = await action(AbortSignal.timeout(Math.max(1, timeout - 5_000)));
      logWorkflow(logContext, {
        step: name,
        retryAttempt: context.attempt,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: 'succeeded',
      });
      return { ok: true, value } as const;
    } catch (error) {
      const normalized = adminIrlRedeemFinalizeWorkflowError(error);
      logWorkflow(logContext, {
        step: name,
        retryAttempt: context.attempt,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: normalized.retryable ? 'retryable_failure' : 'terminal_failure',
        errorCode: normalized.code,
      }, normalized.retryable ? 'warning' : 'error');
      if (normalized.retryable) {
        throw retryStageError(isRetryableWorkflowErrorCode(normalized.code) ? normalized.code : 'internal');
      }
      return { ok: false, error: normalized } as const;
    }
  });
}

function workflowFailure(error: unknown): AdminIrlRedeemFinalizeWorkflowError {
  const retryCode = retryErrorCode(error);
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
    failure = workflowFailure(error);
  }
  if (!failure && reference) {
    logWorkflow(logContext, { step: 'workflow', retryAttempt: 1, durationMs: 0, outcome: 'succeeded' });
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
          outcome: result.cleared ? 'cleared' : 'retained_recovery',
          errorCode: projected.code,
        }, 'warning');
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
        throw retryStageError(isRetryableWorkflowErrorCode(normalized.code) ? normalized.code : 'internal');
      }
    });
  } catch {
    const cleanupFailure = {
      version: 1,
      ok: false,
      error: retryFailure('unavailable'),
    } as const;
    logWorkflow(logContext, {
      step: 'workflow',
      retryAttempt: 1,
      durationMs: 0,
      outcome: 'failed',
      errorCode: cleanupFailure.error.code,
      cleanupExhausted: true,
    }, 'error');
    return cleanupFailure;
  }
  logWorkflow(logContext, {
    step: 'workflow',
    retryAttempt: 1,
    durationMs: 0,
    outcome: 'failed',
    errorCode: projected.code,
    cleanupExhausted: false,
  }, 'error');
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
