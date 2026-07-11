import test from 'node:test';
import assert from 'node:assert/strict';
import { planResendInboundForward, type ResendInboundForwardPlan } from '../functions/src/resendInbound.ts';
import {
  FirestoreResendInboundStore,
  RESEND_INBOUND_AMBIGUOUS_REVIEW_MS,
  RESEND_INBOUND_FORWARD_LEASE_MS,
  RESEND_INBOUND_RETENTION_MS,
} from '../functions/src/resendInboundStore.ts';

function plan(): ResendInboundForwardPlan {
  const result = planResendInboundForward({
    type: 'email.received',
    created_at: '2026-07-10T12:00:00.000Z',
    data: {
      email_id: 'store-test-email',
      created_at: '2026-07-10T12:00:00.000Z',
      from: 'buyer@example.com',
      to: ['notifications@support.mons.shop'],
      cc: [],
      bcc: [],
      message_id: 'message-id',
      subject: 'subject',
      attachments: [],
    },
  } as any);
  assert.equal(result.kind, 'forward');
  return result.plan;
}

function applyWrite(existing: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const next = { ...existing };
  for (const [key, value] of Object.entries(data)) {
    const kind = value?.constructor?.name;
    if (kind === 'DeleteTransform') delete next[key];
    else if (kind === 'NumericIncrementTransform') next[key] = (Number(next[key]) || 0) + value.operand;
    else if (kind === 'ServerTimestampTransform') next[key] = { toMillis: () => 999_999 };
    else next[key] = value;
  }
  return next;
}

class MemoryFirestore {
  docs = new Map<string, Record<string, any>>();
  lastPath = '';

  doc(path: string) {
    this.lastPath = path;
    return { path };
  }

  async runTransaction<T>(operation: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: async (ref: { path: string }) => {
        const value = this.docs.get(ref.path);
        return { exists: Boolean(value), data: () => value };
      },
      set: (ref: { path: string }, data: Record<string, any>, options?: { merge?: boolean }) => {
        const existing = options?.merge ? this.docs.get(ref.path) || {} : {};
        this.docs.set(ref.path, applyWrite(existing, data));
      },
    };
    return operation(tx);
  }

  current() {
    return this.docs.get(this.lastPath)!;
  }
}

function setup() {
  const db = new MemoryFirestore();
  const store = new FirestoreResendInboundStore(db as any);
  return { db, store, plan: plan() };
}

test('store uses the resendInboundEmails collection group and creates a fenced live lease', async () => {
  const { db, store, plan } = setup();
  const reserved = await store.reserve({ plan, webhookId: 'webhook-1', attemptId: 'attempt-1', nowMs: 1_000 });
  assert.equal(reserved.kind, 'reserved');
  assert.equal(reserved.kind === 'reserved' && reserved.unresolvedProviderAttempt, false);
  assert.match(db.lastPath, /^system\/resendInbound\/resendInboundEmails\/[a-f0-9]{64}$/);
  assert.equal(db.current().activeAttemptId, 'attempt-1');
  assert.equal(db.current().attempts, 1);
  assert.equal(db.current().leaseExpiresAt.toMillis(), 1_000 + RESEND_INBOUND_FORWARD_LEASE_MS);
  assert.equal(db.current().expiresAt.toMillis(), 1_000 + RESEND_INBOUND_RETENTION_MS);

  const active = await store.reserve({ plan, webhookId: 'webhook-2', attemptId: 'attempt-2', nowMs: 2_000 });
  assert.deepEqual(active, { kind: 'in_progress', leaseExpiresAt: 1_000 + RESEND_INBOUND_FORWARD_LEASE_MS });
  assert.equal(db.current().attempts, 1);
});

test('expired leases can be reclaimed and stale failure writes are fenced', async () => {
  const { db, store, plan } = setup();
  await store.reserve({ plan, webhookId: 'webhook-1', attemptId: 'old', nowMs: 1_000 });
  const reclaimed = await store.reserve({
    plan,
    webhookId: 'webhook-2',
    attemptId: 'new',
    nowMs: 1_000 + RESEND_INBOUND_FORWARD_LEASE_MS + 1,
  });
  assert.equal(reclaimed.kind, 'reserved');
  assert.equal(db.current().activeAttemptId, 'new');
  assert.equal(db.current().attempts, 2);

  assert.equal(await store.recordFailure({
    emailId: plan.emailId,
    attemptId: 'old',
    retryable: true,
    ambiguous: true,
    reason: 'timeout',
    error: { name: 'timeout', statusCode: null },
    nowMs: 9_000,
  }), 'superseded');
  assert.equal(db.current().status, 'forwarding');
  assert.equal(db.current().activeAttemptId, 'new');
});

test('prepared payload identity is frozen and a changed retry moves to needs_review', async () => {
  const { db, store, plan } = setup();
  await store.reserve({ plan, webhookId: 'webhook-1', attemptId: 'attempt-1', nowMs: 1_000 });
  assert.equal(await store.recordPrepared({
    emailId: plan.emailId,
    attemptId: 'attempt-1',
    payloadDigest: 'digest-1',
    idempotencyKey: 'key-1',
    variant: 'full',
    nowMs: 2_000,
  }), 'prepared');
  const startedAt = db.current().providerAttemptStartedAt.toMillis();

  db.current().status = 'failed_retryable';
  delete db.current().activeAttemptId;
  const retry = await store.reserve({ plan, webhookId: 'webhook-2', attemptId: 'attempt-2', nowMs: 3_000 });
  assert.equal(retry.kind, 'reserved');
  assert.equal(retry.kind === 'reserved' && retry.unresolvedProviderAttempt, true);
  assert.deepEqual(retry.kind === 'reserved' && retry.prepared, {
    payloadDigest: 'digest-1', idempotencyKey: 'key-1', variant: 'full',
  });
  assert.equal(await store.recordPrepared({
    emailId: plan.emailId,
    attemptId: 'attempt-2',
    payloadDigest: 'digest-1',
    idempotencyKey: 'key-1',
    variant: 'full',
    nowMs: 4_000,
  }), 'prepared');
  assert.equal(db.current().providerAttemptStartedAt.toMillis(), startedAt, 'retry must not extend provider window');

  db.current().status = 'failed_retryable';
  delete db.current().activeAttemptId;
  await store.reserve({ plan, webhookId: 'webhook-3', attemptId: 'attempt-3', nowMs: 5_000 });
  assert.equal(await store.recordPrepared({
    emailId: plan.emailId,
    attemptId: 'attempt-3',
    payloadDigest: 'digest-changed',
    idempotencyKey: 'key-1',
    variant: 'full',
    nowMs: 6_000,
  }), 'needs_review');
  assert.equal(db.current().status, 'needs_review');
});

test('prepared payload replacement is limited to the deterministic body-only fallback', async () => {
  const allowed = setup();
  await allowed.store.reserve({
    plan: allowed.plan, webhookId: 'webhook-1', attemptId: 'attempt', nowMs: 1_000,
  });
  await allowed.store.recordPrepared({
    emailId: allowed.plan.emailId,
    attemptId: 'attempt',
    payloadDigest: 'full-digest',
    idempotencyKey: allowed.plan.idempotencyBaseKey,
    variant: 'full',
    nowMs: 2_000,
  });
  assert.equal(await allowed.store.recordPrepared({
    emailId: allowed.plan.emailId,
    attemptId: 'attempt',
    payloadDigest: 'body-digest',
    idempotencyKey: `${allowed.plan.idempotencyBaseKey}:body-only`,
    variant: 'body_only',
    degradedReason: 'attachment_forwarding_failed',
    nowMs: 3_000,
    allowReplace: true,
  }), 'prepared');
  assert.equal(allowed.db.current().payloadVariant, 'body_only');
  assert.equal(allowed.db.current().providerAttemptStartedAt.toMillis(), 3_000);

  const rejected = setup();
  await rejected.store.reserve({
    plan: rejected.plan, webhookId: 'webhook-1', attemptId: 'attempt', nowMs: 1_000,
  });
  await rejected.store.recordPrepared({
    emailId: rejected.plan.emailId,
    attemptId: 'attempt',
    payloadDigest: 'full-digest',
    idempotencyKey: rejected.plan.idempotencyBaseKey,
    variant: 'full',
    nowMs: 2_000,
  });
  assert.equal(await rejected.store.recordPrepared({
    emailId: rejected.plan.emailId,
    attemptId: 'attempt',
    payloadDigest: 'unexpected-digest',
    idempotencyKey: 'unexpected-key',
    variant: 'body_only',
    nowMs: 3_000,
    allowReplace: true,
  }), 'needs_review');
});

test('matching provider success is monotonic even from a stale worker', async () => {
  const { db, store, plan } = setup();
  await store.reserve({ plan, webhookId: 'webhook-1', attemptId: 'old', nowMs: 1_000 });
  await store.recordPrepared({
    emailId: plan.emailId,
    attemptId: 'old',
    payloadDigest: 'digest',
    idempotencyKey: 'key',
    variant: 'full',
    nowMs: 2_000,
  });
  db.current().leaseExpiresAt = { toMillis: () => 2_500 };
  await store.reserve({ plan, webhookId: 'webhook-2', attemptId: 'new', nowMs: 3_000 });

  assert.equal(await store.recordSuccess({
    emailId: plan.emailId,
    attemptId: 'old',
    payloadDigest: 'digest',
    idempotencyKey: 'key',
    variant: 'full',
    forwardedEmailId: 'provider-id',
    nowMs: 4_000,
  }), 'recorded');
  assert.equal(db.current().status, 'forwarded');
  assert.equal(db.current().forwardedEmailId, 'provider-id');

  assert.deepEqual(await store.reserve({ plan, webhookId: 'webhook-3', attemptId: 'third', nowMs: 5_000 }), {
    kind: 'terminal', status: 'forwarded',
  });
});

test('mismatched provider success cannot overwrite state', async () => {
  const { db, store, plan } = setup();
  await store.reserve({ plan, webhookId: 'webhook-1', attemptId: 'attempt', nowMs: 1_000 });
  await store.recordPrepared({
    emailId: plan.emailId,
    attemptId: 'attempt',
    payloadDigest: 'digest',
    idempotencyKey: 'key',
    variant: 'full',
    nowMs: 2_000,
  });
  assert.equal(await store.recordSuccess({
    emailId: plan.emailId,
    attemptId: 'attempt',
    payloadDigest: 'other-digest',
    idempotencyKey: 'key',
    variant: 'full',
    forwardedEmailId: 'provider-id',
    nowMs: 3_000,
  }), 'needs_review');
  assert.equal(db.current().status, 'needs_review');
  assert.equal(db.current().forwardedEmailId, undefined);
});

test('retryable/permanent failure states and ambiguous-attempt review cutoff are enforced', async () => {
  const { db, store, plan } = setup();
  await store.reserve({ plan, webhookId: 'webhook-1', attemptId: 'attempt-1', nowMs: 1_000 });
  await store.recordPrepared({
    emailId: plan.emailId,
    attemptId: 'attempt-1',
    payloadDigest: 'digest',
    idempotencyKey: 'key',
    variant: 'full',
    nowMs: 2_000,
  });
  await store.recordFailure({
    emailId: plan.emailId,
    attemptId: 'attempt-1',
    retryable: true,
    ambiguous: true,
    reason: 'network_failure',
    error: { name: 'network_failure', statusCode: null },
    nowMs: 3_000,
  });
  assert.equal(db.current().status, 'failed_retryable');
  assert.ok(db.current().providerAttemptStartedAt);

  const review = await store.reserve({
    plan,
    webhookId: 'webhook-2',
    attemptId: 'attempt-2',
    nowMs: 2_000 + RESEND_INBOUND_AMBIGUOUS_REVIEW_MS,
  });
  assert.deepEqual(review, { kind: 'terminal', status: 'needs_review' });
  assert.equal(db.current().status, 'needs_review');

  const permanentSetup = setup();
  await permanentSetup.store.reserve({
    plan: permanentSetup.plan, webhookId: 'webhook-1', attemptId: 'attempt', nowMs: 1_000,
  });
  await permanentSetup.store.recordFailure({
    emailId: permanentSetup.plan.emailId,
    attemptId: 'attempt',
    retryable: false,
    ambiguous: false,
    reason: 'validation_error',
    error: { name: 'validation_error', statusCode: 422 },
    nowMs: 2_000,
  });
  assert.equal(permanentSetup.db.current().status, 'failed_permanent');
  assert.equal(permanentSetup.db.current().providerAttemptStartedAt, undefined);
});
