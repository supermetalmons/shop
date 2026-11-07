import {
  createStripeCheckoutFulfillmentJobV1,
} from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import { D1CommerceRepository } from './commerceRepository.js';
import { markStripeCheckoutReenqueued, recordStripeCheckoutReconciliationFailure } from './stripeCheckout/sessionStore.js';
import type { StripeCheckoutRequeueCandidate, StripeCheckoutRequeueCursor } from './commerceDiscoveryCandidates.js';
import { drainReconciliationCandidates, type ReconciliationPage } from './reconciliationPass.js';
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
  loadPage?: (args: { cutoffMs: number; limit: number; startAfter?: StripeCheckoutRequeueCursor },
    signal: AbortSignal) => Promise<ReconciliationPage<RequeueCandidate>>;
  probeBacklog?: (cutoffMs: number, signal: AbortSignal) => Promise<{ hasMore: boolean; oldestDueAgeMs: number | null }>;
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

export async function reconcileStaleStripeFulfillments(
  env: ReconciliationEnv,
  signal: AbortSignal,
  overrides: ReconciliationDependencies = {},
): Promise<ReconciliationResult> {
  let summary: ReconciliationResult = emptyReconciliationResult();
  try {
    const clock = overrides.nowMs || Date.now;
    const nowMs = Math.floor(clock());
    const cutoffMs = nowMs - STRIPE_FULFILLMENT_REQUEUE_AFTER_MS;
    const log = reconciliationLogger(overrides.log || ((entry) => console.log(entry)));
    const errorLog = reconciliationLogger(overrides.error || ((entry) => console.error(entry)));
    const repository = new D1CommerceRepository(env.COMMERCE_DB);
    const loadPage = async (startAfter: StripeCheckoutRequeueCursor | undefined, limit: number) => {
      if (overrides.loadPage) return overrides.loadPage({ cutoffMs, limit, startAfter }, signal);
      signal.throwIfAborted();
      const page = await repository.queryStaleStripeFulfillments(cutoffMs, limit, startAfter);
      signal.throwIfAborted();
      return page;
    };
    const commerce = {
      repository,
      nowMs: () => Date.now(),
      signal,
    };
    const markEnqueued = overrides.markEnqueued || ((candidate: RequeueCandidate) =>
      markStripeCheckoutReenqueued(commerce, candidate));
    const markInvalid = overrides.markInvalid || ((candidate: RequeueCandidate, error: unknown) =>
      recordStripeCheckoutReconciliationFailure(commerce, candidate, reconciliationError(error)));
    await drainReconciliationCandidates<RequeueCandidate>({
      signal,
      checkAbortedBeforeLoad: false,
      cancellationMode: 'throw',
      paging: {
        inspectionLimit: 100,
        budgetMs: null,
        loadPage,
        candidateKey: (candidate) => candidate.checkoutPath,
        probeBacklog: overrides.probeBacklog
          ? () => overrides.probeBacklog!(cutoffMs, signal)
          : async () => {
            const { candidates: [oldest] } = await loadPage(undefined, 1);
            return { hasMore: Boolean(oldest),
              oldestDueAgeMs: oldest ? Math.max(0, clock() - oldest.updatedAtMs - STRIPE_FULFILLMENT_REQUEUE_AFTER_MS) : null };
          },
      },
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
      candidates: summary.inspected,
      enqueued: summary.completed,
      failed: summary.failed,
    });
    if (summary.failed) throw new Error(`Stripe fulfillment reconciliation failed for ${summary.failed} checkout(s)`);
    return summary;
  } finally {
    reportReconciliationResult(summary, overrides.onResult);
  }
}
