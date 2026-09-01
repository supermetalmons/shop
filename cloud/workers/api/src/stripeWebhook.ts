import Stripe from 'stripe';
import { getApiDrop } from './dropConfig.js';
import {
  STRIPE_WEBHOOK_PATH,
  resolveStripeWebhookAction,
  stripeWebhookTransition,
  type StripeWebhookAction,
  type StripeWebhookDrop,
  type StripeWebhookEvent,
  type StripeWebhookSecretScope,
  type StripeWebhookSession,
  type StripeWebhookTransition,
} from '../../../../shared/stripeWebhook.js';
import {
  createStripeCheckoutFulfillmentJobV1,
  isStripeCheckoutFulfillmentEventType,
} from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import {
  type ProfileProviderFetch,
} from './boundedResponse.js';
import {
  createRequestDeadline,
  isRequestCancellationError,
  raceWithSignal,
  readBoundedRequestBytes,
  runCriticalRequestOperation,
} from './boundedRequest.js';
import {
  rethrowDeferredWorkRegistrationError,
  type DeferredWork,
} from './deferredWork.js';
import { isRecord, ProfileReadError } from './dataAccess.js';
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentWriteData,
} from './commerceRepository.js';
import { runCommerceTransaction } from './commerceTransactions.js';

export { STRIPE_WEBHOOK_PATH };

const STRIPE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const STRIPE_WEBHOOK_TIMEOUT_MS = 15_000;

type StripeWebhookEnv = Pick<Env,
  | 'STRIPE_FULFILLMENT_QUEUE'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'STRIPE_WEBHOOK_SECRET_DEVNET'
> & Pick<Env, 'COMMERCE_DB'>;

type StripeWebhookMetrics = {
  upstreamCalls: number;
  providerDurationMs: number;
};

export type StripeWebhookRequestResult = {
  response: Response;
  metrics: StripeWebhookMetrics;
  eventId?: string;
  eventType?: string;
  dropId?: string;
  sessionId?: string;
  outcome: string;
};

type StripeWebhookDependencies = {
  defer: DeferredWork;
  getDrop: (dropId: string) => StripeWebhookDrop | undefined;
  log: (entry: Record<string, unknown>) => void;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  timeoutMs: number;
  verifyEvent: (
    payload: Uint8Array,
    signature: string,
    secret: string,
  ) => Promise<StripeWebhookEvent>;
};

type WebhookSecret = {
  scope: StripeWebhookSecretScope;
  value: string;
};

class StripeWebhookRequestError extends Error {
  constructor(
    readonly status: 400 | 500,
    readonly outcome: string,
  ) {
    super(outcome);
    this.name = 'StripeWebhookRequestError';
  }
}

const defaultDependencies: StripeWebhookDependencies = {
  defer: () => undefined,
  getDrop: (dropId) => {
    const drop = getApiDrop(dropId);
    if (!drop) return undefined;
    return {
      dropId: drop.dropId,
      solanaCluster: drop.solanaCluster,
      itemsPerBox: drop.itemsPerBox,
      ...(drop.mintSelection ? { mintSelection: drop.mintSelection } : {}),
      ...(drop.salesMode ? { salesMode: drop.salesMode } : {}),
    };
  },
  log: (entry) => console.log(entry),
  nowMs: () => Date.now(),
  providerFetch: (input, init) => fetch(input, init),
  timeoutMs: STRIPE_WEBHOOK_TIMEOUT_MS,
  verifyEvent: async (payload, signature, secret) => {
    const event = await Stripe.webhooks.constructEventAsync(
      payload,
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider(crypto.subtle),
    );
    return normalizeStripeEvent(event);
  },
};

function jsonResponse(body: unknown, status: number, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function normalizeMetadata(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') metadata[key] = entry;
  }
  return metadata;
}

function normalizeStripeEvent(value: unknown): StripeWebhookEvent {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string' || !isRecord(value.data)) {
    throw new StripeWebhookRequestError(400, 'invalid_event');
  }
  const eventType = value.type.trim();
  if (!isStripeCheckoutFulfillmentEventType(eventType)) {
    return {
      id: value.id,
      type: eventType,
      data: {
        object: {
          id: '',
          livemode: false,
          metadata: {},
        },
      },
    };
  }
  if (!isRecord(value.data.object)) throw new StripeWebhookRequestError(400, 'invalid_event');
  const session = value.data.object;
  if (typeof session.id !== 'string' || typeof session.livemode !== 'boolean') {
    throw new StripeWebhookRequestError(400, 'invalid_event');
  }
  const normalized: StripeWebhookSession = {
    id: session.id,
    livemode: session.livemode,
    metadata: normalizeMetadata(session.metadata),
    ...(session.mode === undefined ? {} : { mode: session.mode }),
    ...(session.payment_status === undefined ? {} : { payment_status: session.payment_status }),
    ...(session.automatic_tax === undefined ? {} : { automatic_tax: session.automatic_tax }),
    ...(session.amount_subtotal === undefined ? {} : { amount_subtotal: session.amount_subtotal }),
    ...(session.amount_total === undefined ? {} : { amount_total: session.amount_total }),
    ...(session.total_details === undefined ? {} : { total_details: session.total_details }),
    ...(session.currency === undefined ? {} : { currency: session.currency }),
  };
  return { id: value.id, type: eventType, data: { object: normalized } };
}

async function secretsMatch(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function webhookSecrets(env: StripeWebhookEnv): Promise<WebhookSecret[]> {
  const devnet = String(env.STRIPE_WEBHOOK_SECRET_DEVNET || '').trim();
  const mainnet = String(env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!devnet || !mainnet || await secretsMatch(devnet, mainnet)) {
    throw new StripeWebhookRequestError(500, 'configuration_error');
  }
  return [
    { scope: 'devnet', value: devnet },
    { scope: 'mainnet', value: mainnet },
  ];
}

async function readRawBody(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  const contentType = String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    void request.body?.cancel().catch(() => undefined);
    throw new StripeWebhookRequestError(400, 'invalid_request');
  }
  return readBoundedRequestBytes(request, {
    maxBytes: STRIPE_WEBHOOK_MAX_BODY_BYTES,
    signal,
    createError: (failure) => new StripeWebhookRequestError(
      400,
      failure === 'too-large' ? 'request_too_large' : 'invalid_request',
    ),
  });
}

async function verifyWebhookEvent(
  payload: Uint8Array,
  signature: string,
  secrets: readonly WebhookSecret[],
  verifyEvent: StripeWebhookDependencies['verifyEvent'],
): Promise<{ event: StripeWebhookEvent; verifiedScope: StripeWebhookSecretScope }> {
  for (const secret of secrets) {
    try {
      return {
        event: await verifyEvent(payload, signature, secret.value),
        verifiedScope: secret.scope,
      };
    } catch (error) {
      if (error instanceof StripeWebhookRequestError) throw error;
    }
  }
  throw new StripeWebhookRequestError(400, 'invalid_signature');
}

function transitionUpdate(
  action: Extract<StripeWebhookAction, { kind: 'enqueue' }>,
  transition: StripeWebhookTransition,
): CommerceDocumentWriteData {
  return {
    ...transition.fields,
    ...Object.fromEntries(transition.deleteFields.map((field) => [field, commerceFieldValue.delete()])),
    stripeWebhookEventIds: commerceFieldValue.arrayUnion(action.eventId),
    ...Object.fromEntries(transition.serverTimestampFields.map((field) => [field, commerceFieldValue.serverTimestamp()])),
  } as CommerceDocumentWriteData;
}

async function mutateCheckout(
  action: Extract<StripeWebhookAction, { kind: 'enqueue' }>,
  common: {
    commerceDb: D1Database;
    nowMs: number;
    signal: AbortSignal;
  },
): Promise<StripeWebhookTransition> {
  const repository = new D1CommerceRepository(common.commerceDb);
  const key = commerceKeys.stripeCheckout(action.dropId, action.sessionId);
  return runCommerceTransaction({
    nowMs: common.nowMs,
    repository,
    signal: common.signal,
  }, async (unit) => {
    const document = await unit.get(key);
    if (!document) throw new Error('Stripe checkout session was not created by this app');
    const transition = stripeWebhookTransition(document.data, action);
    await unit.update(key, transitionUpdate(action, transition));
    return transition;
  });
}

function actionResponse(
  action: Exclude<StripeWebhookAction, { kind: 'enqueue' }>,
): StripeWebhookRequestResult {
  if (action.kind === 'awaiting_payment') {
    return {
      response: jsonResponse({ received: true, awaitingPayment: true, sessionId: action.sessionId }, 200),
      metrics: { upstreamCalls: 0, providerDurationMs: 0 },
      eventId: action.eventId,
      eventType: action.eventType,
      dropId: action.dropId,
      sessionId: action.sessionId,
      outcome: 'awaiting_payment',
    };
  }
  const sessionId = 'sessionId' in action ? action.sessionId : undefined;
  return {
    response: jsonResponse({
      received: true,
      ignored: true,
      reason: action.reason,
      ...(sessionId ? { sessionId } : {}),
    }, 200),
    metrics: { upstreamCalls: 0, providerDurationMs: 0 },
    eventId: action.eventId,
    eventType: action.eventType,
    ...(sessionId ? { sessionId } : {}),
    outcome: action.reason,
  };
}

export async function handleStripeWebhookRequest(
  request: Request,
  env: StripeWebhookEnv,
  overrides: Partial<StripeWebhookDependencies> = {},
): Promise<StripeWebhookRequestResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const metrics: StripeWebhookMetrics = { upstreamCalls: 0, providerDurationMs: 0 };
  const startedAt = performance.now();
  let responseStatus = 500;
  let logContext: Omit<StripeWebhookRequestResult, 'response' | 'metrics'> = { outcome: 'rejected' };
  let requestCancelled = false;
  try {
    if (request.signal.aborted) {
      requestCancelled = true;
      throw request.signal.reason;
    }
    if (request.method !== 'POST') {
      void request.body?.cancel().catch(() => undefined);
      const result: StripeWebhookRequestResult = {
        response: jsonResponse({ received: false, error: 'Method not allowed' }, 405, { Allow: 'POST' }),
        metrics,
        outcome: 'method_not_allowed',
      };
      responseStatus = result.response.status;
      logContext = { outcome: result.outcome };
      return result;
    }
    const secrets = await webhookSecrets(env);
    const signature = String(request.headers.get('Stripe-Signature') || '').trim();
    if (!signature) throw new StripeWebhookRequestError(400, 'invalid_signature');
    const deadline = createRequestDeadline(request, {
      timeoutMs: dependencies.timeoutMs,
      timeoutMessage: 'Stripe webhook timed out',
    });
    try {
      const payload = await readRawBody(request, deadline.signal);
      const verified = await raceWithSignal(
        verifyWebhookEvent(payload, signature, secrets, dependencies.verifyEvent),
        deadline.signal,
      );
      const action = resolveStripeWebhookAction(verified.event, dependencies.getDrop);
      logContext = {
        outcome: action.kind,
        eventId: action.eventId,
        eventType: action.eventType,
        ...('dropId' in action ? { dropId: action.dropId } : {}),
        ...('sessionId' in action ? { sessionId: action.sessionId } : {}),
      };
      if ('expectedSecretScope' in action && action.expectedSecretScope !== verified.verifiedScope) {
        throw new StripeWebhookRequestError(400, 'secret_scope_mismatch');
      }
      if (action.kind !== 'enqueue') {
        const result = actionResponse(action);
        result.metrics = metrics;
        responseStatus = result.response.status;
        logContext = {
          outcome: result.outcome,
          eventId: result.eventId,
          eventType: result.eventType,
          dropId: result.dropId,
          sessionId: result.sessionId,
        };
        return result;
      }
      const transition = await runCriticalRequestOperation(
        () => mutateCheckout(action, {
          commerceDb: env.COMMERCE_DB,
          nowMs: dependencies.nowMs(),
          signal: deadline.signal,
        }),
        { deadline, defer: dependencies.defer },
      );
      if (transition.outcome !== 'already_fulfilled') {
        const queueResult = await runCriticalRequestOperation(
          () => env.STRIPE_FULFILLMENT_QUEUE.send(
            createStripeCheckoutFulfillmentJobV1({
              dropId: action.dropId,
              sessionId: action.sessionId,
              stripeEventId: action.eventId,
              stripeEventType: action.eventType,
              enqueuedAtMs: dependencies.nowMs(),
            }),
          ),
          { deadline, defer: dependencies.defer },
        );
        dependencies.log({
          event: 'stripe_fulfillment_job_enqueued',
          dropId: action.dropId,
          sessionId: action.sessionId,
          stripeEventId: action.eventId,
          stripeEventType: action.eventType,
          transition: transition.outcome,
          backlogCount: queueResult.metadata.metrics.backlogCount,
          backlogBytes: queueResult.metadata.metrics.backlogBytes,
        });
      }
      const responseBody = transition.outcome === 'queued'
        ? {
            received: true,
            queued: true,
            dropId: action.dropId,
            sessionId: action.sessionId,
            checkoutPath: `drops/${action.dropId}/stripeCheckouts/${action.sessionId}`,
          }
        : {
            received: true,
            ignored: true,
            reason: transition.outcome,
            dropId: action.dropId,
            sessionId: action.sessionId,
            ...(transition.outcome === 'already_pending'
              ? { checkoutPath: `drops/${action.dropId}/stripeCheckouts/${action.sessionId}` }
              : {}),
            ...(transition.deliveryId ? { deliveryId: transition.deliveryId } : {}),
          };
      const result: StripeWebhookRequestResult = {
        response: jsonResponse(responseBody, 200),
        metrics,
        eventId: action.eventId,
        eventType: action.eventType,
        dropId: action.dropId,
        sessionId: action.sessionId,
        outcome: transition.outcome,
      };
      responseStatus = result.response.status;
      logContext = {
        eventId: result.eventId,
        eventType: result.eventType,
        dropId: result.dropId,
        sessionId: result.sessionId,
        outcome: result.outcome,
      };
      return result;
    } finally {
      deadline.dispose();
    }
  } catch (error) {
    rethrowDeferredWorkRegistrationError(error);
    if (isRequestCancellationError(request, error)) {
      requestCancelled = true;
      throw error;
    }
    const requestError = error instanceof StripeWebhookRequestError ? error : null;
    const status = requestError?.status ?? 500;
    const outcome = requestError?.outcome ?? (
      error instanceof CommerceWriteConflict
        ? 'write_conflict'
        : error instanceof ProfileReadError && error.code === 'deadline-exceeded'
          ? 'deadline_exceeded'
          : 'processing_error'
    );
    logContext = { ...logContext, outcome };
    responseStatus = status;
    return {
      response: jsonResponse({
        received: status === 500,
        error: status === 400 ? 'Invalid Stripe webhook request' : 'Stripe webhook processing failed',
      }, status),
      metrics,
      ...logContext,
      outcome,
    };
  } finally {
    requestCancelled ||= request.signal.aborted && responseStatus >= 200 && responseStatus < 300;
    if (!requestCancelled) {
      dependencies.log({
        event: 'stripe_webhook_request',
        ...logContext,
        status: responseStatus,
        durationMs: Math.round(performance.now() - startedAt),
        providerDurationMs: Math.round(metrics.providerDurationMs),
        upstreamCalls: metrics.upstreamCalls,
      });
    }
  }
}
