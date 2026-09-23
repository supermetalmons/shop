import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { ApiErrorCode } from './dataAccess.js';

type WorkflowStageFailure = Readonly<{
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
}>;

export type WorkflowStageResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: WorkflowStageFailure }>;

type WorkflowRetryErrorMarker<Code extends ApiErrorCode> = Readonly<{
  name: string;
  messagePrefix: string;
  isCode: (value: unknown) => value is Code;
  fallbackCode: Code;
}>;

type WorkflowStageOutcome =
  | Readonly<{ outcome: 'succeeded' }>
  | Readonly<{ outcome: 'retryable_failure' | 'terminal_failure'; errorCode: ApiErrorCode }>;

type WorkflowStageLog = WorkflowStageOutcome & Readonly<{
  retryAttempt: number;
  durationMs: number;
}>;

export function workflowRetryError<Code extends ApiErrorCode>(
  marker: WorkflowRetryErrorMarker<Code>,
  code: ApiErrorCode,
): Error {
  const validatedCode = marker.isCode(code) ? code : marker.fallbackCode;
  const error = new Error(`${marker.messagePrefix}${validatedCode}`);
  error.name = marker.name;
  return error;
}

export function workflowRetryErrorCode<Code extends ApiErrorCode>(
  error: unknown,
  marker: WorkflowRetryErrorMarker<Code>,
): Code | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null;
  try {
    const name = (error as { name?: unknown }).name;
    const message = (error as { message?: unknown }).message;
    const prefix = name === marker.name ? marker.messagePrefix
      : name === 'Error' ? `${marker.name}: ${marker.messagePrefix}` : null;
    if (!prefix || typeof message !== 'string' || !message.startsWith(prefix)) {
      return null;
    }
    const code = message.slice(prefix.length);
    return marker.isCode(code) ? code : null;
  } catch {
    return null;
  }
}

export function runWorkflowStage<T extends Rpc.Serializable<T>>(args: {
  step: Pick<WorkflowStep, 'do'>;
  name: string;
  config: WorkflowStepConfig;
  actionTimeoutMs: number;
  normalizeError: (error: unknown) => WorkflowStageFailure;
  retryErrorMarker: WorkflowRetryErrorMarker<ApiErrorCode>;
  log: (entry: WorkflowStageLog) => void;
  action: (signal: AbortSignal) => Promise<T>;
}): Promise<WorkflowStageResult<T>> {
  return args.step.do(args.name, args.config, async (context) => {
    const startedAt = performance.now();
    const log = (entry: WorkflowStageOutcome) => {
      try {
        args.log({
          ...entry,
          retryAttempt: context.attempt,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      } catch {}
    };
    try {
      const value = await args.action(AbortSignal.timeout(args.actionTimeoutMs));
      log({ outcome: 'succeeded' });
      return { ok: true, value } as const;
    } catch (error) {
      const failure = args.normalizeError(error);
      log({
        outcome: failure.retryable ? 'retryable_failure' : 'terminal_failure',
        errorCode: failure.code,
      });
      if (failure.retryable) throw workflowRetryError(args.retryErrorMarker, failure.code);
      return { ok: false, error: failure } as const;
    }
  });
}
