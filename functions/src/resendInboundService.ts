import { randomUUID } from 'crypto';
import {
  prepareResendInboundForward,
  summarizeResendInboundError,
  type PreparedResendInboundForward,
  type ResendInboundForwardPlan,
  type ResendInboundProvider,
} from './resendInbound.js';
import type {
  ResendInboundFinalizeResult,
  ResendInboundPreparedResult,
  ResendInboundReservation,
} from './resendInboundStore.js';

export interface ResendInboundStore {
  reserve(params: {
    plan: ResendInboundForwardPlan;
    webhookId: string;
    attemptId: string;
    nowMs: number;
  }): Promise<ResendInboundReservation>;
  recordPrepared(params: {
    emailId: string;
    attemptId: string;
    payloadDigest: string;
    idempotencyKey: string;
    variant: 'full' | 'body_only';
    degradedReason?: string;
    nowMs: number;
    allowReplace?: boolean;
  }): Promise<ResendInboundPreparedResult>;
  recordSuccess(params: {
    emailId: string;
    attemptId: string;
    payloadDigest: string;
    idempotencyKey: string;
    variant: 'full' | 'body_only';
    degradedReason?: string;
    forwardedEmailId: string;
    nowMs: number;
  }): Promise<ResendInboundFinalizeResult>;
  recordFailure(params: {
    emailId: string;
    attemptId: string;
    retryable: boolean;
    ambiguous: boolean;
    reason: string;
    error: unknown;
    nowMs: number;
  }): Promise<ResendInboundFinalizeResult>;
}

export type ResendInboundProcessingOutcome =
  | { kind: 'forwarded'; degraded: boolean; attempts: number; providerStatus: 'accepted' }
  | { kind: 'duplicate'; terminalStatus: string }
  | { kind: 'in_progress'; leaseExpiresAt: number }
  | { kind: 'needs_review'; reason: string }
  | { kind: 'failed_permanent'; reason: string; attempts: number; providerStatus?: number | null }
  | { kind: 'failed_retryable'; reason: string; attempts: number; providerStatus?: number | null };

function safeFailureSummary(error: ReturnType<typeof summarizeResendInboundError>): {
  name: string;
  statusCode: number | null;
} {
  return { name: error.error.name, statusCode: error.error.statusCode };
}

function isInvalidAttachmentRejection(error: ReturnType<typeof summarizeResendInboundError>): boolean {
  return error.error.name === 'invalid_attachment';
}

function isAmbiguousProviderSendFailure(error: ReturnType<typeof summarizeResendInboundError>): boolean {
  const { name, statusCode } = error.error;
  return (
    (name === 'application_error' && statusCode === null) ||
    name === 'concurrent_idempotent_requests' ||
    statusCode === 408 ||
    Boolean(statusCode && statusCode >= 500)
  );
}

async function recordPreparation(params: {
  store: ResendInboundStore;
  plan: ResendInboundForwardPlan;
  attemptId: string;
  prepared: PreparedResendInboundForward;
  now: () => number;
  allowReplace?: boolean;
}): Promise<ResendInboundPreparedResult> {
  return params.store.recordPrepared({
    emailId: params.plan.emailId,
    attemptId: params.attemptId,
    payloadDigest: params.prepared.payloadDigest,
    idempotencyKey: params.prepared.idempotencyKey,
    variant: params.prepared.variant,
    degradedReason: params.prepared.degradedReason,
    nowMs: params.now(),
    allowReplace: params.allowReplace,
  });
}

export async function processResendInboundForward(params: {
  plan: ResendInboundForwardPlan;
  webhookId: string;
  provider: ResendInboundProvider;
  store: ResendInboundStore;
  now?: () => number;
  newAttemptId?: () => string;
}): Promise<ResendInboundProcessingOutcome> {
  const now = params.now || Date.now;
  const attemptId = (params.newAttemptId || randomUUID)();
  const reservation = await params.store.reserve({
    plan: params.plan,
    webhookId: params.webhookId,
    attemptId,
    nowMs: now(),
  });
  if (reservation.kind === 'in_progress') {
    return { kind: 'in_progress', leaseExpiresAt: reservation.leaseExpiresAt };
  }
  if (reservation.kind === 'terminal') {
    if (reservation.status === 'needs_review') {
      return { kind: 'needs_review', reason: 'terminal_needs_review' };
    }
    if (reservation.status === 'failed_permanent') {
      return { kind: 'failed_permanent', reason: 'terminal_permanent_failure', attempts: 0 };
    }
    return { kind: 'duplicate', terminalStatus: reservation.status };
  }
  let unresolvedProviderAttempt = reservation.unresolvedProviderAttempt;

  const fail = async (
    error: unknown,
    ambiguous: boolean,
    forceRetryable = false,
  ): Promise<ResendInboundProcessingOutcome> => {
    const summary = summarizeResendInboundError(error);
    const retryable = forceRetryable || summary.retryable;
    const finalization = await params.store.recordFailure({
      emailId: reservation.plan.emailId,
      attemptId,
      retryable,
      ambiguous,
      reason: summary.reason,
      error: safeFailureSummary(summary),
      nowMs: now(),
    });
    if (finalization === 'needs_review') return { kind: 'needs_review', reason: summary.reason };
    if (finalization === 'superseded') {
      return { kind: 'failed_retryable', reason: 'attempt_superseded', attempts: reservation.attempts };
    }
    return {
      kind: retryable ? 'failed_retryable' : 'failed_permanent',
      reason: summary.reason,
      attempts: reservation.attempts,
      providerStatus: summary.error.statusCode,
    };
  };

  let prepared: PreparedResendInboundForward;
  try {
    prepared = await prepareResendInboundForward({ plan: reservation.plan, provider: params.provider });
  } catch (error) {
    return fail(
      error,
      unresolvedProviderAttempt,
      unresolvedProviderAttempt,
    );
  }

  if (reservation.prepared) {
    const candidates = [prepared, prepared.bodyOnlyFallback].filter(
      (candidate): candidate is PreparedResendInboundForward => Boolean(candidate),
    );
    const frozen = candidates.find(
      (candidate) =>
        candidate.payloadDigest === reservation.prepared?.payloadDigest &&
        candidate.idempotencyKey === reservation.prepared?.idempotencyKey &&
        candidate.variant === reservation.prepared?.variant,
    );
    if (frozen) prepared = frozen;
  }

  let preparation = await recordPreparation({
    store: params.store,
    plan: reservation.plan,
    attemptId,
    prepared,
    now,
  });
  if (preparation === 'needs_review') return { kind: 'needs_review', reason: 'prepared_payload_changed' };
  if (preparation === 'superseded') {
    return { kind: 'failed_retryable', reason: 'attempt_superseded', attempts: reservation.attempts };
  }

  let sent;
  try {
    sent = await params.provider.sendEmail(prepared.payload, prepared.idempotencyKey);
  } catch (error) {
    return fail(error, true);
  }

  if (sent.error) {
    const summary = summarizeResendInboundError(sent.error);
    if (prepared.bodyOnlyFallback && isInvalidAttachmentRejection(summary)) {
      prepared = prepared.bodyOnlyFallback;
      preparation = await recordPreparation({
        store: params.store,
        plan: reservation.plan,
        attemptId,
        prepared,
        now,
        allowReplace: true,
      });
      if (preparation === 'needs_review') return { kind: 'needs_review', reason: 'fallback_payload_changed' };
      if (preparation === 'superseded') {
        return { kind: 'failed_retryable', reason: 'attempt_superseded', attempts: reservation.attempts };
      }
      // The explicit invalid-attachment response resolves any earlier uncertainty
      // for the full-payload key. The fallback starts its own provider window.
      unresolvedProviderAttempt = false;
      try {
        sent = await params.provider.sendEmail(prepared.payload, prepared.idempotencyKey);
      } catch (error) {
        return fail(error, true);
      }
    }
  }

  if (sent.error) {
    const summary = summarizeResendInboundError(sent.error);
    const ambiguous = unresolvedProviderAttempt || isAmbiguousProviderSendFailure(summary);
    return fail(sent.error, ambiguous, ambiguous);
  }

  const finalization = await params.store.recordSuccess({
    emailId: reservation.plan.emailId,
    attemptId,
    payloadDigest: prepared.payloadDigest,
    idempotencyKey: prepared.idempotencyKey,
    variant: prepared.variant,
    degradedReason: prepared.degradedReason,
    forwardedEmailId: sent.data.id,
    nowMs: now(),
  });
  if (finalization === 'needs_review') return { kind: 'needs_review', reason: 'provider_success_payload_mismatch' };
  if (finalization === 'superseded') {
    return { kind: 'failed_retryable', reason: 'success_record_superseded', attempts: reservation.attempts };
  }
  return {
    kind: 'forwarded',
    degraded: prepared.variant === 'body_only',
    attempts: reservation.attempts,
    providerStatus: 'accepted',
  };
}
