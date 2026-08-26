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
  FIRESTORE_DATABASE_NAME,
  FIRESTORE_DOCUMENT_NAME_PREFIX,
  FIRESTORE_DOCUMENTS_BASE_URL,
  FirestoreWriteConflict,
  ProfileReadError,
  commerceDocumentRequest,
  decodeFirestoreFields,
  isRecord,
  type CommerceDocumentRequester,
  type ProfileProviderFetch,
} from './firestoreRest.js';

export { STRIPE_WEBHOOK_PATH };

const STRIPE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const STRIPE_WEBHOOK_TIMEOUT_MS = 15_000;
const FIRESTORE_MUTATION_ATTEMPTS = 3;

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
  getDrop: (dropId: string) => StripeWebhookDrop | undefined;
  log: (entry: Record<string, unknown>) => void;
  nowMs: () => number;
  providerFetch: ProfileProviderFetch;
  requestCommerceDocument: CommerceDocumentRequester;
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

type FirestoreDocument = {
  fields: Record<string, unknown>;
  updateTime: string;
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
  requestCommerceDocument: commerceDocumentRequest,
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
    await request.body?.cancel().catch(() => undefined);
    throw new StripeWebhookRequestError(400, 'invalid_request');
  }
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw new StripeWebhookRequestError(400, 'request_too_large');
  }
  if (!request.body) throw new StripeWebhookRequestError(400, 'invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      size += value.byteLength;
      if (size > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
        throw new StripeWebhookRequestError(400, 'request_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const payload = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
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

function firestoreValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Unsupported Firestore number');
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(firestoreValue) } };
  }
  if (isRecord(value)) {
    const fields: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) fields[key] = firestoreValue(entry);
    }
    return { mapValue: { fields } };
  }
  throw new Error('Unsupported Firestore value');
}

function documentName(path: string): string {
  return `${FIRESTORE_DOCUMENT_NAME_PREFIX}${path}`;
}

async function loadCheckoutDocument(
  path: string,
  common: {
    commerceDb: D1Database;
    nowMs: number;
    providerFetch: ProfileProviderFetch;
    requestCommerceDocument: CommerceDocumentRequester;
    signal: AbortSignal;
  },
): Promise<FirestoreDocument> {
  const payload = await common.requestCommerceDocument({
    ...common,
    method: 'GET',
    url: `${FIRESTORE_DOCUMENTS_BASE_URL}/${path}`,
  });
  if (payload === null) throw new Error('Stripe checkout session was not created by this app');
  if (!isRecord(payload) || typeof payload.updateTime !== 'string' || !payload.updateTime) {
    throw new ProfileReadError('unavailable', 502, 'Stripe webhook processing failed');
  }
  const fields = payload.fields === undefined ? {} : decodeFirestoreFields(payload.fields);
  if (!fields) throw new ProfileReadError('unavailable', 502, 'Stripe webhook processing failed');
  return { fields, updateTime: payload.updateTime };
}

function transitionWrite(
  path: string,
  updateTime: string,
  action: Extract<StripeWebhookAction, { kind: 'enqueue' }>,
  transition: StripeWebhookTransition,
): Record<string, unknown> {
  const fields = Object.fromEntries(
    Object.entries(transition.fields).map(([key, value]) => [key, firestoreValue(value)]),
  );
  return {
    update: {
      name: documentName(path),
      fields,
    },
    updateMask: {
      fieldPaths: [...Object.keys(fields), ...transition.deleteFields],
    },
    updateTransforms: [
      {
        fieldPath: 'stripeWebhookEventIds',
        appendMissingElements: { values: [{ stringValue: action.eventId }] },
      },
      ...transition.serverTimestampFields.map((fieldPath) => ({
        fieldPath,
        setToServerValue: 'REQUEST_TIME',
      })),
    ],
    currentDocument: { updateTime },
  };
}

async function pauseForConflict(signal: AbortSignal, attempt: number): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, 25 * (attempt + 1));
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function mutateCheckout(
  action: Extract<StripeWebhookAction, { kind: 'enqueue' }>,
  common: {
    commerceDb: D1Database;
    nowMs: number;
    providerFetch: ProfileProviderFetch;
    requestCommerceDocument: CommerceDocumentRequester;
    signal: AbortSignal;
  },
): Promise<StripeWebhookTransition> {
  const path = `drops/${action.dropId}/stripeCheckouts/${action.sessionId}`;
  for (let attempt = 0; attempt < FIRESTORE_MUTATION_ATTEMPTS; attempt += 1) {
    const document = await loadCheckoutDocument(path, common);
    const transition = stripeWebhookTransition(document.fields, action);
    try {
      await common.requestCommerceDocument({
        ...common,
        body: JSON.stringify({
          writes: [transitionWrite(path, document.updateTime, action, transition)],
        }),
        method: 'POST',
        url: `https://firestore.googleapis.com/v1/${FIRESTORE_DATABASE_NAME}/documents:commit`,
      });
      return transition;
    } catch (error) {
      if (!(error instanceof FirestoreWriteConflict)) throw error;
      if (attempt + 1 >= FIRESTORE_MUTATION_ATTEMPTS) throw error;
      await pauseForConflict(common.signal, attempt);
    }
  }
  throw new FirestoreWriteConflict();
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
  try {
    if (request.method !== 'POST') {
      await request.body?.cancel().catch(() => undefined);
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
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Stripe webhook timed out', 'TimeoutError')),
      STRIPE_WEBHOOK_TIMEOUT_MS,
    );
    try {
      const payload = await readRawBody(request, controller.signal);
      const verified = await verifyWebhookEvent(payload, signature, secrets, dependencies.verifyEvent);
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
      const trackedFetch: ProfileProviderFetch = async (input, init) => {
        const providerStartedAt = performance.now();
        metrics.upstreamCalls += 1;
        try {
          return await dependencies.providerFetch(input, init);
        } finally {
          metrics.providerDurationMs += Math.max(0, performance.now() - providerStartedAt);
        }
      };
      const transition = await mutateCheckout(action, {
        commerceDb: env.COMMERCE_DB,
        nowMs: dependencies.nowMs(),
        providerFetch: trackedFetch,
        requestCommerceDocument: dependencies.requestCommerceDocument,
        signal: controller.signal,
      });
      if (transition.outcome !== 'already_fulfilled') {
        const queueResult = await env.STRIPE_FULFILLMENT_QUEUE.send(
          createStripeCheckoutFulfillmentJobV1({
            dropId: action.dropId,
            sessionId: action.sessionId,
            stripeEventId: action.eventId,
            stripeEventType: action.eventType,
            enqueuedAtMs: dependencies.nowMs(),
          }),
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
      clearTimeout(timeout);
    }
  } catch (error) {
    const requestError = error instanceof StripeWebhookRequestError ? error : null;
    const status = requestError?.status ?? 500;
    const outcome = requestError?.outcome ?? (
      error instanceof FirestoreWriteConflict
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
