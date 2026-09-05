import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.js';
import {
  STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
  createStripeCheckoutFulfillmentJobV1,
  type StripeCheckoutFulfillmentEventType,
} from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import {
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentRecord,
} from './commerceRepository.js';
import { runCommerceTransaction } from './commerceTransactions.js';
import { stripeCheckoutWriteData } from './stripeCheckout/commerce.js';

export const STRIPE_FULFILLMENT_REQUEUE_AFTER_MS = 15 * 60 * 1000;
type RequeueCandidate = {
  checkoutPath: string;
  dropId: string;
  sessionId: string;
  stripeEventId: string;
  stripeEventType: StripeCheckoutFulfillmentEventType;
};

type ReconciliationEnv = Pick<Env,
  'COMMERCE_DB' | 'STRIPE_FULFILLMENT_QUEUE'
>;

type ReconciliationDependencies = {
  error?: (entry: Record<string, unknown>) => void;
  loadCandidates?: (cutoffMs: number, signal: AbortSignal) => Promise<RequeueCandidate[]>;
  log?: (entry: Record<string, unknown>) => void;
  markEnqueued?: (candidate: RequeueCandidate) => Promise<void>;
  markInvalid?: (candidate: RequeueCandidate, error: unknown) => Promise<void>;
  nowMs?: () => number;
};


function reconciliationError(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'UnknownError' };
}

export function parseRequeueCandidates(
  value: readonly CommerceDocumentRecord[],
  cutoffMs: number,
): RequeueCandidate[] {
  const candidates: RequeueCandidate[] = [];
  for (const document of value) {
    if (document.key.kind !== 'stripe_checkout' || !document.key.dropId) continue;
    const dropId = document.key.dropId;
    const sessionId = document.key.documentId;
    const fields = document.data;
    if (
      (
        fields.status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING &&
        fields.status !== STRIPE_CHECKOUT_STATUS.PROCESSING
      ) ||
      fields.fulfillmentProcessor !== STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR ||
      typeof fields.updatedAt !== 'number' ||
      fields.updatedAt > cutoffMs ||
      typeof fields.lastStripeWebhookEventId !== 'string'
    ) continue;
    candidates.push({
      checkoutPath: `drops/${dropId}/stripeCheckouts/${sessionId}`,
      dropId,
      sessionId,
      stripeEventId: fields.lastStripeWebhookEventId,
      stripeEventType: fields.lastStripeWebhookEventType === 'checkout.session.async_payment_succeeded'
        ? fields.lastStripeWebhookEventType
        : 'checkout.session.completed',
    });
  }
  return candidates;
}

async function loadCandidates(
  env: ReconciliationEnv,
  cutoffMs: number,
  signal: AbortSignal,
): Promise<RequeueCandidate[]> {
  signal.throwIfAborted();
  const repository = new D1CommerceRepository(env.COMMERCE_DB);
  const value = await repository.queryStaleStripeFulfillments(cutoffMs);
  signal.throwIfAborted();
  return parseRequeueCandidates(value, cutoffMs);
}

export async function reconcileStaleStripeFulfillments(
  env: ReconciliationEnv,
  signal: AbortSignal,
  overrides: ReconciliationDependencies = {},
): Promise<{ enqueued: number; failed: number }> {
  const nowMs = Math.floor(overrides.nowMs?.() ?? Date.now());
  const log = overrides.log || ((entry: Record<string, unknown>) => console.log(entry));
  const errorLog = overrides.error || ((entry: Record<string, unknown>) => console.error(entry));
  const candidates = await (overrides.loadCandidates
    ? overrides.loadCandidates(nowMs - STRIPE_FULFILLMENT_REQUEUE_AFTER_MS, signal)
    : loadCandidates(env, nowMs - STRIPE_FULFILLMENT_REQUEUE_AFTER_MS, signal));
  const commerce = {
    repository: new D1CommerceRepository(env.COMMERCE_DB),
    nowMs: () => Date.now(),
    signal,
  };
  const markEnqueued = overrides.markEnqueued || (async (candidate: RequeueCandidate) => {
    await runCommerceTransaction(commerce, (transaction) => transaction.update(
      commerceKeys.stripeCheckout(candidate.dropId, candidate.sessionId),
      {
        fulfillmentQueueReenqueuedAt: commerceFieldValue.serverTimestamp(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      },
    ), { shouldRetry: (error) => error.code === 'aborted' });
  });
  const markInvalid = overrides.markInvalid || (async (candidate: RequeueCandidate, error: unknown) => {
    await runCommerceTransaction(commerce, (transaction) => transaction.update(
      commerceKeys.stripeCheckout(candidate.dropId, candidate.sessionId),
      stripeCheckoutWriteData({
        lastFulfillmentReconciliationError: reconciliationError(error),
        lastFulfillmentReconciliationErrorAt: commerceFieldValue.serverTimestamp(),
        updatedAt: commerceFieldValue.serverTimestamp(),
      }),
    ), { shouldRetry: (error) => error.code === 'aborted' });
  });
  let enqueued = 0;
  let failed = 0;
  for (const candidate of candidates) {
    if (signal.aborted) throw signal.reason;
    let job: ReturnType<typeof createStripeCheckoutFulfillmentJobV1>;
    try {
      job = createStripeCheckoutFulfillmentJobV1({
        dropId: candidate.dropId,
        sessionId: candidate.sessionId,
        stripeEventId: candidate.stripeEventId,
        stripeEventType: candidate.stripeEventType,
        enqueuedAtMs: nowMs,
      });
    } catch (error) {
      let loggedError = error;
      try {
        await markInvalid(candidate, error);
      } catch (markError) {
        loggedError = new AggregateError([error, markError], 'Invalid reconciliation candidate could not be deferred');
      }
      failed += 1;
      errorLog({
        event: 'stripe_fulfillment_job_reconciliation_failed',
        dropId: candidate.dropId,
        sessionId: candidate.sessionId,
        error: reconciliationError(loggedError),
      });
      continue;
    }
    try {
      await env.STRIPE_FULFILLMENT_QUEUE.send(job);
      await markEnqueued(candidate);
      enqueued += 1;
      log({
        event: 'stripe_fulfillment_job_reconciled',
        dropId: candidate.dropId,
        sessionId: candidate.sessionId,
        stripeEventId: candidate.stripeEventId,
      });
    } catch (error) {
      failed += 1;
      errorLog({
        event: 'stripe_fulfillment_job_reconciliation_failed',
        dropId: candidate.dropId,
        sessionId: candidate.sessionId,
        error: reconciliationError(error),
      });
    }
  }
  log({
    event: 'stripe_fulfillment_reconciliation_completed',
    candidates: candidates.length,
    enqueued,
    failed,
  });
  if (failed) throw new Error(`Stripe fulfillment reconciliation failed for ${failed} checkout(s)`);
  return { enqueued, failed };
}
