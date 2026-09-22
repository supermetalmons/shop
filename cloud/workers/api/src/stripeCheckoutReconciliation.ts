import {
  createStripeCheckoutFulfillmentJobV1,
} from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import {
  D1CommerceRepository,
  type CommerceDocumentRecord,
} from './commerceRepository.js';
import { markStripeCheckoutReenqueued, recordStripeCheckoutReconciliationFailure } from './stripeCheckout/sessionStore.js';
import { stripeCheckoutRequeueCandidate, type StripeCheckoutRequeueCandidate } from './stripeCheckout/readModel.js';

export const STRIPE_FULFILLMENT_REQUEUE_AFTER_MS = 15 * 60 * 1000;
type RequeueCandidate = StripeCheckoutRequeueCandidate;

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


function reconciliationError(error: unknown): { name: string; message?: string } {
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
    const candidate = stripeCheckoutRequeueCandidate(document, cutoffMs);
    if (candidate) candidates.push(candidate);
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
  const markEnqueued = overrides.markEnqueued || ((candidate: RequeueCandidate) =>
    markStripeCheckoutReenqueued(commerce, candidate));
  const markInvalid = overrides.markInvalid || ((candidate: RequeueCandidate, error: unknown) =>
    recordStripeCheckoutReconciliationFailure(commerce, candidate, reconciliationError(error)));
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
