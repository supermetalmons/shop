import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { resendInboundForwardDocumentId, type ResendInboundForwardPlan } from './resendInbound.js';

export const RESEND_INBOUND_FORWARD_LEASE_MS = 5 * 60 * 1000;
export const RESEND_INBOUND_AMBIGUOUS_REVIEW_MS = 23 * 60 * 60 * 1000;
export const RESEND_INBOUND_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

type ResendInboundForwardStatus =
  | 'forwarding'
  | 'forwarded'
  | 'forwarded_degraded'
  | 'failed_retryable'
  | 'failed_permanent'
  | 'needs_review';

type FrozenResendInboundPlan = ResendInboundForwardPlan;

export type ResendInboundReservation =
  | {
      kind: 'reserved';
      attemptId: string;
      plan: FrozenResendInboundPlan;
      attempts: number;
      unresolvedProviderAttempt: boolean;
      prepared?: {
        payloadDigest: string;
        idempotencyKey: string;
        variant: 'full' | 'body_only';
      };
    }
  | { kind: 'in_progress'; leaseExpiresAt: number }
  | { kind: 'terminal'; status: Exclude<ResendInboundForwardStatus, 'forwarding' | 'failed_retryable'> };

export type ResendInboundPreparedResult = 'prepared' | 'superseded' | 'needs_review';
export type ResendInboundFinalizeResult = 'recorded' | 'superseded' | 'needs_review';

function toMillis(value: any): number {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}

function frozenPlanFromDocument(existing: any, fallback: ResendInboundForwardPlan): FrozenResendInboundPlan {
  return {
    emailId: typeof existing?.emailId === 'string' ? existing.emailId : fallback.emailId,
    messageId: typeof existing?.messageId === 'string' ? existing.messageId : fallback.messageId,
    receivedAt: typeof existing?.receivedAt === 'string' ? existing.receivedAt : fallback.receivedAt,
    matchedRecipients: stringArray(existing?.matchedRecipients) || fallback.matchedRecipients,
    forwardFrom: typeof existing?.forwardFrom === 'string' ? existing.forwardFrom : fallback.forwardFrom,
    forwardTo: stringArray(existing?.forwardTo) || fallback.forwardTo,
    payloadVersion: typeof existing?.payloadVersion === 'string' ? existing.payloadVersion : fallback.payloadVersion,
    idempotencyBaseKey:
      typeof existing?.idempotencyBaseKey === 'string' ? existing.idempotencyBaseKey : fallback.idempotencyBaseKey,
  } as FrozenResendInboundPlan;
}

type TerminalResendInboundForwardStatus = Exclude<
  ResendInboundForwardStatus,
  'forwarding' | 'failed_retryable'
>;

function terminalStatus(value: unknown): TerminalResendInboundForwardStatus | null {
  return value === 'forwarded' ||
    value === 'forwarded_degraded' ||
    value === 'failed_permanent' ||
    value === 'needs_review'
    ? value
    : null;
}

export class FirestoreResendInboundStore {
  constructor(private readonly db: FirebaseFirestore.Firestore) {}

  private ref(emailId: string): FirebaseFirestore.DocumentReference {
    return this.db.doc(`system/resendInbound/resendInboundEmails/${resendInboundForwardDocumentId(emailId)}`);
  }

  async reserve(params: {
    plan: ResendInboundForwardPlan;
    webhookId: string;
    attemptId: string;
    nowMs: number;
  }): Promise<ResendInboundReservation> {
    const ref = this.ref(params.plan.emailId);
    return this.db.runTransaction<ResendInboundReservation>(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as any) : null;
      const terminal = terminalStatus(existing?.status);
      if (terminal || existing?.forwardedAt) {
        return { kind: 'terminal', status: terminal || 'forwarded' };
      }

      const leaseExpiresAt = toMillis(existing?.leaseExpiresAt);
      if (existing?.status === 'forwarding' && leaseExpiresAt > params.nowMs) {
        return { kind: 'in_progress', leaseExpiresAt };
      }

      const providerAttemptStartedAt = toMillis(existing?.providerAttemptStartedAt);
      if (providerAttemptStartedAt && providerAttemptStartedAt <= params.nowMs - RESEND_INBOUND_AMBIGUOUS_REVIEW_MS) {
        tx.set(
          ref,
          {
            status: 'needs_review',
            failureReason: 'provider_idempotency_window_expiring',
            needsReviewAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            expiresAt: Timestamp.fromMillis(params.nowMs + RESEND_INBOUND_RETENTION_MS),
            activeAttemptId: FieldValue.delete(),
            leaseExpiresAt: FieldValue.delete(),
          },
          { merge: true },
        );
        return { kind: 'terminal', status: 'needs_review' };
      }

      const plan = frozenPlanFromDocument(existing, params.plan);
      if (plan.payloadVersion !== params.plan.payloadVersion) {
        tx.set(
          ref,
          {
            status: 'needs_review',
            failureReason: 'payload_version_changed',
            needsReviewAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            expiresAt: Timestamp.fromMillis(params.nowMs + RESEND_INBOUND_RETENTION_MS),
            activeAttemptId: FieldValue.delete(),
            leaseExpiresAt: FieldValue.delete(),
          },
          { merge: true },
        );
        return { kind: 'terminal', status: 'needs_review' };
      }

      const attempts = (typeof existing?.attempts === 'number' ? existing.attempts : 0) + 1;
      tx.set(
        ref,
        {
          schemaVersion: 1,
          status: 'forwarding',
          provider: 'resend',
          ...plan,
          attempts: FieldValue.increment(1),
          activeAttemptId: params.attemptId,
          lastWebhookId: params.webhookId,
          ...(!snap.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
          updatedAt: FieldValue.serverTimestamp(),
          lastAttemptAt: FieldValue.serverTimestamp(),
          leaseExpiresAt: Timestamp.fromMillis(params.nowMs + RESEND_INBOUND_FORWARD_LEASE_MS),
          expiresAt: Timestamp.fromMillis(params.nowMs + RESEND_INBOUND_RETENTION_MS),
          failedAt: FieldValue.delete(),
          failureReason: FieldValue.delete(),
          lastError: FieldValue.delete(),
        },
        { merge: true },
      );
      const prepared =
        typeof existing?.payloadDigest === 'string' &&
        typeof existing?.providerIdempotencyKey === 'string' &&
        (existing?.payloadVariant === 'full' || existing?.payloadVariant === 'body_only')
          ? {
              payloadDigest: existing.payloadDigest,
              idempotencyKey: existing.providerIdempotencyKey,
              variant: existing.payloadVariant,
            }
          : undefined;
      return {
        kind: 'reserved',
        attemptId: params.attemptId,
        plan,
        attempts,
        unresolvedProviderAttempt: Boolean(providerAttemptStartedAt),
        prepared,
      };
    });
  }

  async recordPrepared(params: {
    emailId: string;
    attemptId: string;
    payloadDigest: string;
    idempotencyKey: string;
    variant: 'full' | 'body_only';
    degradedReason?: string;
    nowMs: number;
    allowReplace?: boolean;
  }): Promise<ResendInboundPreparedResult> {
    const ref = this.ref(params.emailId);
    return this.db.runTransaction<ResendInboundPreparedResult>(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as any) : null;
      if (terminalStatus(existing?.status)) return 'superseded';
      if (existing?.status !== 'forwarding' || existing?.activeAttemptId !== params.attemptId) return 'superseded';
      const payloadChanged =
        (existing?.payloadDigest && existing.payloadDigest !== params.payloadDigest) ||
        (existing?.providerIdempotencyKey && existing.providerIdempotencyKey !== params.idempotencyKey);
      const replaceWithBodyOnlyFallback =
        params.allowReplace === true &&
        existing?.payloadVariant === 'full' &&
        params.variant === 'body_only' &&
        typeof existing?.providerIdempotencyKey === 'string' &&
        params.idempotencyKey === `${existing.providerIdempotencyKey}:body-only`;
      if (payloadChanged && !replaceWithBodyOnlyFallback) {
        tx.set(
          ref,
          {
            status: 'needs_review',
            failureReason: 'prepared_payload_changed',
            needsReviewAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            expiresAt: Timestamp.fromMillis(params.nowMs + RESEND_INBOUND_RETENTION_MS),
            activeAttemptId: FieldValue.delete(),
            leaseExpiresAt: FieldValue.delete(),
          },
          { merge: true },
        );
        return 'needs_review';
      }
      tx.set(
        ref,
        {
          payloadDigest: params.payloadDigest,
          providerIdempotencyKey: params.idempotencyKey,
          payloadVariant: params.variant,
          degradedReason: params.degradedReason || FieldValue.delete(),
          ...(!existing?.providerAttemptStartedAt || replaceWithBodyOnlyFallback
            ? { providerAttemptStartedAt: Timestamp.fromMillis(params.nowMs) }
            : {}),
          updatedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(params.nowMs + RESEND_INBOUND_RETENTION_MS),
        },
        { merge: true },
      );
      return 'prepared';
    });
  }

  async recordSuccess(params: {
    emailId: string;
    attemptId: string;
    payloadDigest: string;
    idempotencyKey: string;
    variant: 'full' | 'body_only';
    degradedReason?: string;
    forwardedEmailId: string;
    nowMs: number;
  }): Promise<ResendInboundFinalizeResult> {
    const ref = this.ref(params.emailId);
    return this.db.runTransaction<ResendInboundFinalizeResult>(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as any) : null;
      if (existing?.status === 'forwarded' || existing?.status === 'forwarded_degraded' || existing?.forwardedAt) {
        return 'recorded';
      }
      if (
        existing?.payloadDigest !== params.payloadDigest ||
        existing?.providerIdempotencyKey !== params.idempotencyKey
      ) {
        tx.set(
          ref,
          {
            status: 'needs_review',
            failureReason: 'provider_success_payload_mismatch',
            needsReviewAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            expiresAt: Timestamp.fromMillis(params.nowMs + RESEND_INBOUND_RETENTION_MS),
            activeAttemptId: FieldValue.delete(),
            leaseExpiresAt: FieldValue.delete(),
          },
          { merge: true },
        );
        return 'needs_review';
      }
      tx.set(
        ref,
        {
          status: params.variant === 'body_only' ? 'forwarded_degraded' : 'forwarded',
          forwardedAt: FieldValue.serverTimestamp(),
          forwardedEmailId: params.forwardedEmailId,
          degradedReason: params.degradedReason || FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(params.nowMs + RESEND_INBOUND_RETENTION_MS),
          activeAttemptId: FieldValue.delete(),
          leaseExpiresAt: FieldValue.delete(),
          providerAttemptStartedAt: FieldValue.delete(),
          failedAt: FieldValue.delete(),
          failureReason: FieldValue.delete(),
          lastError: FieldValue.delete(),
        },
        { merge: true },
      );
      return 'recorded';
    });
  }

  async recordFailure(params: {
    emailId: string;
    attemptId: string;
    retryable: boolean;
    ambiguous: boolean;
    reason: string;
    error: unknown;
    nowMs: number;
  }): Promise<ResendInboundFinalizeResult> {
    const ref = this.ref(params.emailId);
    return this.db.runTransaction<ResendInboundFinalizeResult>(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (snap.data() as any) : null;
      if (terminalStatus(existing?.status)) return 'superseded';
      if (existing?.status !== 'forwarding' || existing?.activeAttemptId !== params.attemptId) return 'superseded';
      tx.set(
        ref,
        {
          status: params.retryable ? 'failed_retryable' : 'failed_permanent',
          failedAt: FieldValue.serverTimestamp(),
          failureReason: params.reason,
          lastError: params.error,
          updatedAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(params.nowMs + RESEND_INBOUND_RETENTION_MS),
          activeAttemptId: FieldValue.delete(),
          leaseExpiresAt: FieldValue.delete(),
          ...(!params.ambiguous ? { providerAttemptStartedAt: FieldValue.delete() } : {}),
        },
        { merge: true },
      );
      return 'recorded';
    });
  }
}
