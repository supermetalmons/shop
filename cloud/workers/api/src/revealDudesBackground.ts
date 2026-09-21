import { isBase58Bytes, isNonZeroBase58Bytes } from '../../../../shared/solanaRpcProxy.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { isRecord } from './dataAccess.js';
import {
  RESERVATION_ID_PATTERN,
  runtimeForDrop,
  type RevealContext,
  type RevealRuntime,
  type RevealSubmission,
} from './revealDudesDomain.js';
import {
  confirmRevealSubmission,
  countOnlineRevealPackStatus,
  failRevealSubmission,
  loadRevealSubmission,
  requireRevealSubmissionStorageControl,
} from './revealDudesStore.js';
import { reconcileRevealSubmission } from './revealDudesTransactions.js';
import type { RevealSubmissionStorageControl } from './revealSubmissionD1.js';
import { resolveRevealSubmission } from './revealSubmissionLifecycle.js';

export const REVEAL_BACKGROUND_JOB_TIMEOUT_MS = 60_000;

const REVEAL_BACKGROUND_JOB_RETRY_DELAYS_SECONDS = [5, 15, 30, 60, 120, 300] as const;

export type RevealBackgroundJob = {
  kind: 'reveal_submission_reconcile';
  dropId: string;
  boxAssetId: string;
  reservationId: string;
  signature: string;
};

function revealBackgroundJob(
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
): RevealBackgroundJob {
  return {
    kind: 'reveal_submission_reconcile',
    dropId: runtime.dropId,
    boxAssetId,
    reservationId: submission.reservationId,
    signature: submission.signature,
  };
}

export function isRevealBackgroundJob(value: unknown): value is RevealBackgroundJob {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 5 ||
    !['kind', 'dropId', 'boxAssetId', 'reservationId', 'signature'].every((key) => Object.hasOwn(value, key)) ||
    value.kind !== 'reveal_submission_reconcile' ||
    typeof value.dropId !== 'string' ||
    value.dropId.length < 1 ||
    value.dropId.length > 64 ||
    typeof value.boxAssetId !== 'string' ||
    typeof value.reservationId !== 'string' ||
    !RESERVATION_ID_PATTERN.test(value.reservationId) ||
    !isNonZeroBase58Bytes(value.signature, 64) ||
    !isBase58Bytes(value.boxAssetId, 32)
  ) return false;
  return true;
}

export async function enqueueRevealBackgroundJob(
  queue: Queue,
  runtime: RevealRuntime,
  boxAssetId: string,
  submission: RevealSubmission,
  delaySeconds = 0,
): Promise<void> {
  await queue.send(revealBackgroundJob(runtime, boxAssetId, submission), {
    contentType: 'json',
    ...(delaySeconds > 0 ? { delaySeconds } : {}),
  });
}

type RevealBackgroundJobDependencies = {
  confirmRevealSubmission: typeof confirmRevealSubmission;
  countOnlineRevealPackStatus: typeof countOnlineRevealPackStatus;
  failRevealSubmission: typeof failRevealSubmission;
  loadRevealSubmission: typeof loadRevealSubmission;
  loadStorageControl: typeof requireRevealSubmissionStorageControl;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  reconcileRevealSubmission: typeof reconcileRevealSubmission;
  log: (entry: Record<string, unknown>) => void;
  warn: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
};

const defaultRevealBackgroundJobDependencies: RevealBackgroundJobDependencies = {
  confirmRevealSubmission,
  countOnlineRevealPackStatus,
  failRevealSubmission,
  loadRevealSubmission,
  loadStorageControl: requireRevealSubmissionStorageControl,
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  reconcileRevealSubmission,
  log: (entry) => console.info(entry),
  warn: (entry) => console.warn(entry),
  error: (entry) => console.error(entry),
};

export function revealBackgroundJobRetryDelaySeconds(attempts: number): number {
  const index = Math.min(
    Math.max(1, Math.floor(attempts)) - 1,
    REVEAL_BACKGROUND_JOB_RETRY_DELAYS_SECONDS.length - 1,
  );
  return REVEAL_BACKGROUND_JOB_RETRY_DELAYS_SECONDS[index];
}

function retryRevealBackgroundJob(
  message: Message<unknown>,
  dependencies: RevealBackgroundJobDependencies,
  job: RevealBackgroundJob,
  reason: string,
): void {
  const delaySeconds = revealBackgroundJobRetryDelaySeconds(message.attempts);
  dependencies.warn({
    event: 'reveal_background_job_retry',
    dropId: job.dropId,
    boxAssetId: job.boxAssetId,
    signature: job.signature,
    attempts: message.attempts,
    delaySeconds,
    reason,
  });
  message.retry({ delaySeconds });
}

export async function processRevealBackgroundJobMessage(
  message: Message<unknown>,
  env: Pick<Env, 'HELIUS_API_KEY' | 'OPS_DB'> & Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env, 'DATA_DB'>>,
  overrides: Partial<RevealBackgroundJobDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultRevealBackgroundJobDependencies, ...overrides };
  if (!isRevealBackgroundJob(message.body)) {
    dependencies.error({
      event: 'reveal_background_job_invalid',
      queueMessageId: message.id,
      attempts: message.attempts,
    });
    message.ack();
    return;
  }
  const job = message.body;
  const signal = AbortSignal.timeout(REVEAL_BACKGROUND_JOB_TIMEOUT_MS);
  let storageControl: RevealSubmissionStorageControl;
  try {
    storageControl = await dependencies.loadStorageControl(env.OPS_DB, signal);
  } catch (error) {
    retryRevealBackgroundJob(
      message,
      dependencies,
      job,
      error instanceof Error ? error.message : 'storage_control_unavailable',
    );
    return;
  }
  if (storageControl.paused) {
    retryRevealBackgroundJob(message, dependencies, job, 'reveal_submissions_paused');
    return;
  }
  const revealContext: RevealContext = {
    commerceDb: env.COMMERCE_DB,
    nowMs: dependencies.nowMs(),
    providerFetch: dependencies.providerFetch,
    signal,
    dataDb: env.DATA_DB,
    opsDb: env.OPS_DB,
  };
  try {
    const runtime = runtimeForDrop(job.dropId);
    const submission = await dependencies.loadRevealSubmission(revealContext, runtime, job.boxAssetId);
    if (
      !submission ||
      submission.reservationId !== job.reservationId ||
      submission.signature !== job.signature
    ) {
      dependencies.log({
        event: 'reveal_background_job_stale',
        dropId: job.dropId,
        boxAssetId: job.boxAssetId,
        signature: job.signature,
      });
      message.ack();
      return;
    }
    if (submission.status === 'failed') {
      message.ack();
      return;
    }
    const outcome = await resolveRevealSubmission({
      submission,
      reconcile: () => {
        const apiKey = typeof env.HELIUS_API_KEY === 'string' ? env.HELIUS_API_KEY.trim() : '';
        if (!apiKey) throw new Error('helius_api_key_not_configured');
        return dependencies.reconcileRevealSubmission(
          { apiKey, fetch: dependencies.providerFetch, signal },
          runtime,
          submission,
        );
      },
      confirm: () => dependencies.confirmRevealSubmission(revealContext, runtime, job.boxAssetId, submission),
      fail: () => dependencies.failRevealSubmission(revealContext, runtime, job.boxAssetId, submission),
    });
    if (outcome === 'unknown') {
      retryRevealBackgroundJob(message, dependencies, job, 'transaction_status_unknown');
      return;
    }
    if (outcome !== 'confirmed') {
      dependencies.log({
        event: 'reveal_background_job_terminal',
        dropId: job.dropId,
        boxAssetId: job.boxAssetId,
        signature: job.signature,
        outcome: 'failed',
      });
      message.ack();
      return;
    }
    await dependencies.countOnlineRevealPackStatus(
      revealContext,
      runtime,
      job.boxAssetId,
      job.signature,
    );
    dependencies.log({
      event: 'reveal_background_job_terminal',
      dropId: job.dropId,
      boxAssetId: job.boxAssetId,
      signature: job.signature,
      outcome: 'confirmed',
    });
    message.ack();
  } catch (error) {
    retryRevealBackgroundJob(
      message,
      dependencies,
      job,
      error instanceof Error ? error.message : 'unknown_error',
    );
  }
}
