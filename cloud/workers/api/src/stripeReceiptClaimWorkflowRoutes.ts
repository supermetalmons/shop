import {
  STRIPE_CHECKOUT_RETRY_HEADER,
  STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
  type StripeReceiptClaimResult,
} from '../../../../shared/contracts.js';
import {
  STRIPE_RECEIPT_CLAIM_HTTP_TIMEOUT_MS,
  STRIPE_RECEIPT_CLAIM_POLL_INTERVAL_MS,
  STRIPE_RECEIPT_CLAIM_REQUEST_HEADER,
  isStripeReceiptClaimOperationId,
  type StripeReceiptClaimPendingResponse,
} from '../../../../shared/stripeReceiptClaimWorkflow.js';
import { createRequestDeadline, createTimedAbortScope, isRequestCancellationError, raceWithSignal, readBoundedRequestJson, sleepWithSignal } from './boundedRequest.js';
import { isRecord } from './dataAccess.js';
import { apiErrorBody, httpStatusForApiErrorCode, jsonResponse, type ApiErrorLike } from './httpResponse.js';
import { RequestIdentityError, verifyRequestIdentity, type RequestAuthContext } from './requestIdentity.js';
import { canonicalRecipient, normalizedCode, readRequestBody } from './stripeReceiptClaim.js';
import { StripeReceiptClaimError } from './stripeReceiptClaimErrors.js';
import { ensureReceiptClaimWorkflowRunning, ReceiptClaimWorkflowRecoveryPending } from './stripeReceiptClaimWorkflowDispatch.js';
import { loadReceiptClaimWorkflow, reserveReceiptClaimWorkflow } from './stripeReceiptClaimWorkflowStore.js';
import type { ReceiptClaimWorkflowSnapshot } from './stripeReceiptClaimWorkflowState.js';
import { receiptClaimWorkflowContext, receiptClaimWorkflowFailure } from './stripeReceiptClaimWorkflowSupport.js';

type RouteResult = {
  response: Response;
  metrics: { upstreamCalls: number; providerDurationMs: number };
  authOutcome: 'accepted' | 'rejected' | 'provider-failure';
  operationId?: string;
  dropId?: string;
  deliveryId?: number;
  outcome: string;
};

const defaultDependencies = {
  reserve: reserveReceiptClaimWorkflow,
  load: loadReceiptClaimWorkflow,
  ensure: ensureReceiptClaimWorkflowRunning,
  verifyIdentity: verifyRequestIdentity,
  nowMs: Date.now,
  sleep: sleepWithSignal,
  httpTimeoutMs: STRIPE_RECEIPT_CLAIM_HTTP_TIMEOUT_MS,
  legacyTimeoutMs: 180_000,
};

function result(response: Response, outcome: string, options: Partial<RouteResult> = {}): RouteResult {
  return { response, outcome, metrics: { upstreamCalls: 0, providerDurationMs: 0 }, authOutcome: 'accepted', ...options };
}

function failureResponse(error: ApiErrorLike, retrySameOperation = false): Response {
  return jsonResponse(apiErrorBody(error), httpStatusForApiErrorCode(error.code, 503), {
    headers: {
      'Timing-Allow-Origin': '*',
      ...(retrySameOperation ? { [STRIPE_CHECKOUT_RETRY_HEADER]: STRIPE_CHECKOUT_RETRY_SAME_OPERATION } : {}),
    },
  });
}

function completedResponse(value: StripeReceiptClaimResult, operationId?: string): RouteResult {
  return result(jsonResponse(value, 200, { headers: { 'Timing-Allow-Origin': '*' } }), 'complete', {
    dropId: value.dropId, deliveryId: value.deliveryId, ...(operationId ? { operationId } : {}),
  });
}

function project(snapshot: ReceiptClaimWorkflowSnapshot): RouteResult {
  const operationId = snapshot.operation.operationId;
  if (!isStripeReceiptClaimOperationId(operationId)) throw new StripeReceiptClaimError('internal', 'Invalid receipt claim operation.');
  const context = { operationId, dropId: snapshot.started.dropId, deliveryId: snapshot.started.deliveryId };
  if (snapshot.operation.phase === 'complete' && snapshot.operation.result) return completedResponse(snapshot.operation.result, operationId);
  if (snapshot.operation.phase !== 'pending') {
    const error = snapshot.operation.error || receiptClaimWorkflowFailure(undefined);
    return result(failureResponse(error), error.code, context);
  }
  const pending: StripeReceiptClaimPendingResponse = {
    accepted: true, operationId, status: 'pending', retryAfterMs: STRIPE_RECEIPT_CLAIM_POLL_INTERVAL_MS,
  };
  return result(jsonResponse(pending, 202, {
    headers: { 'Retry-After': '2', 'Timing-Allow-Origin': '*' },
  }), 'pending', context);
}

async function handle(
  mode: 'start' | 'status' | 'legacy',
  request: Request,
  env: Env,
  authContext: RequestAuthContext,
  overrides: Partial<typeof defaultDependencies>,
): Promise<RouteResult> {
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    return result(jsonResponse(apiErrorBody({ code: 'invalid-argument', message: 'Method not allowed.' }), 405, {
      headers: { Allow: 'POST, OPTIONS' },
    }), 'method-not-allowed', { authOutcome: 'rejected' });
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  const timeoutMs = mode === 'legacy' ? dependencies.legacyTimeoutMs : dependencies.httpTimeoutMs;
  const deadline = createRequestDeadline(request, {
    timeoutMs,
    timeoutMessage: 'Receipt claim request timed out.',
  });
  const enrichment = createTimedAbortScope(deadline.signal, {
    timeoutMs: Math.max(0, Math.min(5_000, timeoutMs - 1_000)),
    timeoutMessage: 'Receipt metadata lookup timed out.',
  });
  let operationId: string | undefined;
  let authenticated = false;
  try {
    let body: { code: string; recipient: string; operationId?: string };
    if (mode === 'status') {
      const value = await readBoundedRequestJson(request, {
        maxBytes: 1024,
        signal: deadline.signal,
        createError: () => new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim status request.'),
      });
      if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.code !== 'string' ||
        typeof value.recipient !== 'string' || !isStripeReceiptClaimOperationId(value.operationId)) {
        throw new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim status request.');
      }
      body = { code: value.code, recipient: value.recipient, operationId: value.operationId };
    } else {
      body = await readRequestBody(request, deadline.signal);
    }
    await raceWithSignal(dependencies.verifyIdentity(request, env.OPS_DB, deadline.signal, dependencies.nowMs(), authContext), deadline.signal);
    authenticated = true;
    const code = normalizedCode(body.code);
    const recipient = canonicalRecipient(body.recipient).wallet;
    const context = () => receiptClaimWorkflowContext(env, deadline.signal, dependencies.nowMs());
    let snapshot: ReceiptClaimWorkflowSnapshot;
    if (mode === 'status') {
      operationId = body.operationId;
      const stored = await raceWithSignal(dependencies.load(context(), operationId!), deadline.signal);
      if (!stored || stored.code !== code || stored.operation.recipient !== recipient) {
        throw new StripeReceiptClaimError('not-found', 'Receipt claim operation not found.');
      }
      return project(stored);
    }
    const requestId = request.headers.get(STRIPE_RECEIPT_CLAIM_REQUEST_HEADER) || (mode === 'legacy' ? crypto.randomUUID() : '');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) {
      throw new StripeReceiptClaimError('invalid-argument', 'Invalid receipt claim request id.');
    }
    const reserved = await raceWithSignal(dependencies.reserve(context(), code, recipient, dependencies.nowMs(), {
      allowNew: String(env.STRIPE_RECEIPT_CLAIM_ADMISSION_ENABLED) === 'true', requestId,
      provider: { apiKey: String(env.HELIUS_API_KEY || '').trim(), providerFetch: fetch, signal: enrichment.signal },
    }), deadline.signal);
    if (reserved.status === 'complete') return completedResponse(reserved.result);
    snapshot = reserved.snapshot;
    operationId = snapshot.operation.operationId;
    snapshot = await raceWithSignal(dependencies.ensure(env, snapshot, deadline.signal, requestId), deadline.signal);
    if (mode !== 'legacy') return project(snapshot);
    while (snapshot.operation.phase === 'pending') {
      await dependencies.sleep(STRIPE_RECEIPT_CLAIM_POLL_INTERVAL_MS, deadline.signal);
      const next = await raceWithSignal(dependencies.load(context(), operationId), deadline.signal);
      if (!next || next.code !== code || next.operation.recipient !== recipient) {
        throw new StripeReceiptClaimError('not-found', 'Receipt claim operation not found.');
      }
      snapshot = next;
    }
    return project(snapshot);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    const normalized = deadline.timedOut()
      ? { code: 'deadline-exceeded' as const, message: 'Receipt claim request timed out. Retry with the same receiver address.' }
      : error instanceof RequestIdentityError
        ? { code: error.kind === 'invalid-token' ? 'unauthenticated' as const : 'unavailable' as const,
            message: error.kind === 'invalid-token' ? 'Authentication is required.' : 'Authentication is temporarily unavailable.' }
        : error instanceof StripeReceiptClaimError ? error : receiptClaimWorkflowFailure(error);
    const transient = deadline.timedOut() || error instanceof ReceiptClaimWorkflowRecoveryPending || !(error instanceof StripeReceiptClaimError) &&
      !(error instanceof RequestIdentityError && error.kind === 'invalid-token');
    return result(failureResponse(normalized, transient), normalized.code, {
      ...(operationId ? { operationId } : {}),
      authOutcome: authenticated ? 'provider-failure' : normalized.code === 'unauthenticated' ? 'rejected' : 'provider-failure',
    });
  } finally {
    enrichment.dispose();
    deadline.dispose();
  }
}

export function handleStripeReceiptClaimWorkflowStart(request: Request, env: Env, authContext: RequestAuthContext = {}, overrides: Partial<typeof defaultDependencies> = {}) {
  return handle('start', request, env, authContext, overrides);
}

export function handleStripeReceiptClaimWorkflowStatus(request: Request, env: Env, authContext: RequestAuthContext = {}, overrides: Partial<typeof defaultDependencies> = {}) {
  return handle('status', request, env, authContext, overrides);
}

export function handleStripeReceiptClaimWorkflowLegacy(request: Request, env: Env, authContext: RequestAuthContext = {}, overrides: Partial<typeof defaultDependencies> = {}) {
  return handle('legacy', request, env, authContext, overrides);
}
