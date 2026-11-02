import type { SubscribeToNotificationsRequest } from '../../../../shared/contracts.js';
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

function notificationSegmentId(mapping: unknown, family: string): string | null {
  if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) return null;
  if (!Object.prototype.hasOwnProperty.call(mapping, family)) return null;
  const id = (mapping as Record<string, unknown>)[family];
  return typeof id === 'string' && id.trim() ? id.trim() : null;
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
  let subscription: SubscribeToNotificationsRequest;
  try {
    subscription = await parseJsonRequestBody(request, isExactSubscribeToNotificationsRequest);
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    return respond(publicJsonResponse({ ok: false, error: 'invalid-request' }, 400));
  }
  const email = normalizeNotificationEmailRecipient(subscription.email);
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
  const segmentId = subscription.dropFamily
    ? notificationSegmentId(env.RESEND_DROP_SEGMENT_IDS, subscription.dropFamily)
    : null;
  if (!apiKey || (subscription.dropFamily && !segmentId)) {
    return respond(publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));
  }

  const deadline = createRequestDeadline(request, {
    timeoutMs: dependencies.resendTimeoutMs,
    timeoutMessage: 'Resend request timed out',
  });
  const startedAt = performance.now();
  const postResend = async (
    url: string,
    options: { body?: unknown; existingContact?: boolean; expectedId?: string } = {},
  ): Promise<boolean> => {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    metrics.upstreamCalls += 1;
    const providerResponse = await raceWithSignal(dependencies.resendFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: deadline.signal,
    }), deadline.signal);
    if (options.existingContact && providerResponse.status === 409) {
      await cancelResponseBody(providerResponse);
      return true;
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
      if (!providerResponse.ok) return false;
      throw error;
    }
    if (!providerResponse.ok) return Boolean(options.existingContact && isExistingResendContactError(payload));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
    const id = (payload as Record<string, unknown>).id;
    return typeof id === 'string' && id.length > 0 && (options.expectedId === undefined || id === options.expectedId);
  };
  try {
    const contactAccepted = await postResend(RESEND_CONTACTS_API_URL, {
      body: { email, unsubscribed: false },
      existingContact: true,
    });
    if (!contactAccepted) return respond(publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));
    if (segmentId) {
      const segmentAccepted = await postResend(
        `${RESEND_CONTACTS_API_URL}/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
        { expectedId: segmentId },
      );
      if (!segmentAccepted) return respond(publicJsonResponse({ ok: false, error: 'provider-unavailable' }, 502));
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
