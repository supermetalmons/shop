import {
  isExactSubscribeToNotificationsRequest,
  normalizeNotificationEmailRecipient,
} from '../../../../shared/notificationSubscription.js';
import {
  PUBLIC_RATE_LIMITS,
  applyPublicCors,
  observePublicRateLimit,
  publicRequestOrigin,
} from './publicRequestPolicy.js';
import {
  createRequestDeadline,
  isRequestCancellationError,
  raceWithSignal,
} from './boundedRequest.js';
import {
  cancelResponseBody,
  readBoundedResponseJson,
} from './boundedResponse.js';
import {
  parseJsonRequestBody,
  publicJsonResponse,
  publicOriginDeniedResponse,
  type WorkerDependencies,
  type WorkerRequestMetrics,
} from './publicRouteSupport.js';

const MAX_RESEND_RESPONSE_BODY_BYTES = 8 * 1024;

const RESEND_CONTACTS_API_URL = 'https://api.resend.com/contacts';

const EXISTING_RESEND_CONTACT_ERROR_NAMES = new Set([
  'contact_already_exists',
  'duplicate_contact',
  'already_exists',
]);

function isExistingResendContactError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const name = (value as Record<string, unknown>).name;
  return typeof name === 'string' && EXISTING_RESEND_CONTACT_ERROR_NAMES.has(name.trim().toLowerCase());
}

export async function handleNotificationSubscription(
  request: Request,
  env: Env,
  dependencies: Pick<WorkerDependencies, 'log' | 'resendFetch' | 'resendTimeoutMs'>,
  metrics: WorkerRequestMetrics,
): Promise<Response> {
  const origin = publicRequestOrigin(request);
  if (!origin) return publicOriginDeniedResponse();
  const respond = (response: Response) => applyPublicCors(response, origin, 'POST, OPTIONS');
  let rawEmail: string;
  try {
    rawEmail = (await parseJsonRequestBody(
      request,
      isExactSubscribeToNotificationsRequest,
    )).email;
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    return respond(publicJsonResponse({ ok: false, error: 'invalid-request' }, 400));
  }
  const email = normalizeNotificationEmailRecipient(rawEmail);
  if (!email) return respond(publicJsonResponse({ ok: false, error: 'invalid-email' }, 400));

  await observePublicRateLimit({
    binding: env.PUBLIC_NOTIFICATION_RATE_LIMITER,
    keyScope: 'notification-subscription',
    limit: PUBLIC_RATE_LIMITS.notification,
    log: dependencies.log,
    request,
    route: '/notifications/subscribe',
  });

  const apiKey = typeof env.RESEND_CONTACTS_API_KEY === 'string'
    ? env.RESEND_CONTACTS_API_KEY.trim()
    : '';
  if (!apiKey) return respond(publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));

  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.resendTimeoutMs,
    timeoutMessage: 'Resend request timed out',
  });
  const startedAt = performance.now();
  metrics.upstreamCalls += 1;
  try {
    const providerResponse = await raceWithSignal(dependencies.resendFetch(RESEND_CONTACTS_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, unsubscribed: false }),
      signal: deadline.signal,
    }), deadline.signal);
    if (providerResponse.status === 409) {
      await cancelResponseBody(providerResponse);
      return respond(publicJsonResponse({ subscribed: true }, 200));
    }
    if (!providerResponse.body) {
      await cancelResponseBody(providerResponse);
      return respond(publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));
    }
    let payload: unknown;
    try {
      payload = await readBoundedResponseJson(providerResponse, {
        maxBytes: MAX_RESEND_RESPONSE_BODY_BYTES,
        signal: deadline.signal,
        contentType: 'ignore',
        createError: (failure) => new Error(
          failure === 'too-large'
            ? 'provider-response-too-large'
            : 'provider-response-invalid',
        ),
      });
    } catch (error) {
      if (!providerResponse.ok) {
        return respond(publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));
      }
      if (isRequestCancellationError(request, error)) throw error;
      return respond(deadline.timedOut()
        ? publicJsonResponse({ ok: false, error: 'provider-timeout' }, 504)
        : publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));
    }
    if (!providerResponse.ok) {
      return respond(isExistingResendContactError(payload)
        ? publicJsonResponse({ subscribed: true }, 200)
        : publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload) ||
      typeof (payload as Record<string, unknown>).id !== 'string' ||
      !(payload as Record<string, unknown>).id
    ) {
      return respond(publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));
    }
    return respond(publicJsonResponse({ subscribed: true }, 200));
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    return respond(deadline.timedOut()
      ? publicJsonResponse({ ok: false, error: 'provider-timeout' }, 504)
      : publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));
  } finally {
    deadline.dispose();
    metrics.providerDurationMs += performance.now() - startedAt;
  }
}
