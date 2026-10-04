import {
  createStripeCheckoutFulfillmentJobV1,
} from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import {
  D1CommerceRepository,
  type CommerceDocumentRecord,
} from './commerceRepository.js';
import { markStripeCheckoutReenqueued, recordStripeCheckoutReconciliationFailure } from './stripeCheckout/sessionStore.js';
import { stripeCheckoutRequeueCandidate, type StripeCheckoutRequeueCandidate } from './stripeCheckout/readModel.js';
import { drainReconciliationCandidates } from './reconciliationPass.js';
import {
  emptyReconciliationResult, reportReconciliationFailure,
  reportReconciliationResult, reconciliationLogger, reconciliationErrorSummary, type ReconciliationOptions, type ReconciliationResult,
} from './reconciliationResult.js';

export const STRIPE_FULFILLMENT_REQUEUE_AFTER_MS = 15 * 60 * 1000;
type RequeueCandidate = StripeCheckoutRequeueCandidate;

type ReconciliationEnv = Pick<Env,
  'COMMERCE_DB' | 'STRIPE_FULFILLMENT_QUEUE'
>;

type ReconciliationDependencies = ReconciliationOptions & {
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
): Promise<ReconciliationResult> {
  let summary: ReconciliationResult = emptyReconciliationResult();
  try {
    const nowMs = Math.floor(overrides.nowMs?.() ?? Date.now());
    const log = reconciliationLogger(overrides.log || ((entry) => console.log(entry)));
    const errorLog = reconciliationLogger(overrides.error || ((entry) => console.error(entry)));
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
    await drainReconciliationCandidates({
      signal,
      checkAbortedBeforeLoad: false,
      cancellationMode: 'throw',
      loadCandidates: async () => candidates,
      onResult: (result) => { summary = result; },
      failureMessage: 'Stripe fulfillment reconciliation failed',
      processCandidate: async (candidate) => {
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
          reportReconciliationFailure('stripe', { dropId: candidate.dropId, sessionId: candidate.sessionId }, error);
          errorLog({
            event: 'stripe_fulfillment_job_reconciliation_failed',
            dropId: candidate.dropId,
            sessionId: candidate.sessionId,
            error: reconciliationErrorSummary(loggedError),
          });
          return 'failed';
        }
        try {
          await env.STRIPE_FULFILLMENT_QUEUE.send(job);
          await markEnqueued(candidate);
          log({
            event: 'stripe_fulfillment_job_reconciled',
            dropId: candidate.dropId,
            sessionId: candidate.sessionId,
            stripeEventId: candidate.stripeEventId,
          });
          return 'completed';
        } catch (error) {
          reportReconciliationFailure('stripe', { dropId: candidate.dropId, sessionId: candidate.sessionId }, error);
          errorLog({
            event: 'stripe_fulfillment_job_reconciliation_failed',
            dropId: candidate.dropId,
            sessionId: candidate.sessionId,
            error: reconciliationErrorSummary(error),
          });
          return 'failed';
        }
      },
    });
    log({
      event: 'stripe_fulfillment_reconciliation_completed',
      candidates: candidates.length,
      enqueued: summary.completed,
      failed: summary.failed,
    });
    if (summary.failed) throw new Error(`Stripe fulfillment reconciliation failed for ${summary.failed} checkout(s)`);
    return summary;
  } finally {
    reportReconciliationResult(summary, overrides.onResult);
  }
}
