import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.js';
import { stripeCheckoutReconciliationQuery } from '../../../../shared/stripeCheckoutReconciliation.js';
import {
  STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
  createStripeCheckoutFulfillmentJobV1,
  type StripeCheckoutFulfillmentEventType,
} from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import { stripeCheckoutFieldValue } from './stripeCheckout/store.js';
import {
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FIRESTORE_DOCUMENTS_BASE_URL,
  ProfileReadError,
  authenticatedFirestoreRequest,
  createGoogleAccessTokenProvider,
  decodeFirestoreFields,
  isRecord,
} from './firestoreRest.js';
import { createWorkerStripeCheckoutStore } from './stripeCheckoutFirestore.js';

const REQUEUE_AFTER_MS = 15 * 60 * 1000;
const MAX_REQUEUES_PER_RUN = 100;

type RequeueCandidate = {
  checkoutPath: string;
  dropId: string;
  sessionId: string;
  stripeEventId: string;
  stripeEventType: StripeCheckoutFulfillmentEventType;
};

type ReconciliationEnv = Pick<Env,
  | 'FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON'
  | 'STRIPE_FULFILLMENT_QUEUE'
> & Partial<Pick<Env, 'COMMERCE_DB'>>;

type ReconciliationDependencies = {
  error?: (entry: Record<string, unknown>) => void;
  loadCandidates?: (cutoffMs: number, signal: AbortSignal) => Promise<RequeueCandidate[]>;
  log?: (entry: Record<string, unknown>) => void;
  markEnqueued?: (candidate: RequeueCandidate) => Promise<void>;
  markInvalid?: (candidate: RequeueCandidate, error: unknown) => Promise<void>;
  nowMs?: () => number;
};

const accessTokenProvider = createGoogleAccessTokenProvider();

function reconciliationError(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'UnknownError' };
}

function parseRequeueCandidates(value: unknown, cutoffMs: number): RequeueCandidate[] {
  if (!Array.isArray(value)) {
    throw new ProfileReadError('unavailable', 502, 'Stripe fulfillment reconciliation is temporarily unavailable.');
  }
  const candidates: RequeueCandidate[] = [];
  for (const entry of value) {
    const document = isRecord(entry) && isRecord(entry.document) ? entry.document : null;
    if (!document || typeof document.name !== 'string') continue;
    const relativePath = document.name.startsWith(FIRESTORE_DOCUMENT_NAME_PREFIX)
      ? document.name.slice(FIRESTORE_DOCUMENT_NAME_PREFIX.length)
      : '';
    const pathMatch = /^drops\/([^/]+)\/stripeCheckouts\/([^/]+)$/.exec(relativePath);
    if (!pathMatch) continue;
    const [, dropId, sessionId] = pathMatch;
    const fields = decodeFirestoreFields(document.fields);
    if (!fields) {
      throw new ProfileReadError('unavailable', 502, 'Stripe fulfillment reconciliation is temporarily unavailable.');
    }
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
  const serviceAccountJson = String(env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON || '').trim();
  if (!serviceAccountJson) {
    throw new ProfileReadError('unavailable', 503, 'Stripe fulfillment reconciliation is not configured.');
  }
  const value = await authenticatedFirestoreRequest({
    accessTokenProvider,
    commerceDb: env.COMMERCE_DB,
    body: JSON.stringify(stripeCheckoutReconciliationQuery(cutoffMs, MAX_REQUEUES_PER_RUN)),
    method: 'POST',
    nowMs: Date.now(),
    providerFetch: (input, init) => fetch(input, init),
    serviceAccountJson,
    signal,
    url: `${FIRESTORE_DOCUMENTS_BASE_URL}:runQuery`,
  });
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
    ? overrides.loadCandidates(nowMs - REQUEUE_AFTER_MS, signal)
    : loadCandidates(env, nowMs - REQUEUE_AFTER_MS, signal));
  const store = createWorkerStripeCheckoutStore({
    accessTokenProvider,
    commerceDb: env.COMMERCE_DB,
    providerFetch: (input, init) => fetch(input, init),
    serviceAccountJson: env.FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON,
    signal,
  });
  const markEnqueued = overrides.markEnqueued || (async (candidate: RequeueCandidate) => {
    await store.doc(candidate.checkoutPath).update({
      fulfillmentQueueReenqueuedAt: stripeCheckoutFieldValue.serverTimestamp(),
      updatedAt: stripeCheckoutFieldValue.serverTimestamp(),
    });
  });
  const markInvalid = overrides.markInvalid || (async (candidate: RequeueCandidate, error: unknown) => {
    await store.doc(candidate.checkoutPath).update({
      lastFulfillmentReconciliationError: reconciliationError(error),
      lastFulfillmentReconciliationErrorAt: stripeCheckoutFieldValue.serverTimestamp(),
      updatedAt: stripeCheckoutFieldValue.serverTimestamp(),
    });
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

export const stripeCheckoutReconciliationTestHooks = {
  parseRequeueCandidates,
  requeueAfterMs: REQUEUE_AFTER_MS,
  stripeCheckoutReconciliationQuery,
};
