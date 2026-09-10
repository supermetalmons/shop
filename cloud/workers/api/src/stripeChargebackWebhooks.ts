import {
  STRIPE_DISPUTE_EVENT_TYPES,
  type StripeChargebackMode,
  type StripeChargebackWebhookConfigurationRequest,
  type StripeChargebackWebhookConfigurationResult,
} from '../../../../shared/stripeChargebacks.js';
import {
  stripeRead,
  StripeChargebackError,
  type StripeChargebackEnv,
  type StripeChargebackOptions,
} from './stripeChargebacks.js';

const STRIPE_ORDER_WEBHOOK_URL = 'https://api.mons.shop/webhooks/stripe';

type WebhookEndpoint = {
  id: string;
  url: string;
  livemode: boolean;
  status: 'enabled' | 'disabled';
  enabledEvents: string[];
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidEndpoint(): StripeChargebackError {
  return new StripeChargebackError('stripe-webhook-invalid-response', 502, 'Stripe webhook configuration data is invalid.');
}

function webhookEndpoint(value: unknown, mode: StripeChargebackMode): WebhookEndpoint {
  if (!record(value) || value.object !== 'webhook_endpoint' ||
    typeof value.id !== 'string' || value.id.length > 256 || !/^we_[A-Za-z0-9_]+$/.test(value.id) ||
    typeof value.url !== 'string' || value.livemode !== (mode === 'live') ||
    (value.status !== 'enabled' && value.status !== 'disabled') || !Array.isArray(value.enabled_events) ||
    !value.enabled_events.every((eventType): eventType is string =>
      typeof eventType === 'string' && (eventType === '*' || /^[a-z0-9_.]+$/.test(eventType)))) {
    throw invalidEndpoint();
  }
  return {
    id: value.id,
    url: value.url,
    livemode: value.livemode,
    status: value.status,
    enabledEvents: value.enabled_events,
  };
}

function missingEvents(endpoint: WebhookEndpoint): string[] {
  return endpoint.enabledEvents.includes('*')
    ? []
    : STRIPE_DISPUTE_EVENT_TYPES.filter((eventType) => !endpoint.enabledEvents.includes(eventType));
}

function verifyEndpointIdentity(before: WebhookEndpoint, after: WebhookEndpoint): void {
  if (after.id !== before.id || after.url !== before.url || after.livemode !== before.livemode ||
    after.status !== before.status) {
    throw new StripeChargebackError('stripe-webhook-verification-failed', 409, 'Stripe webhook configuration could not be verified.');
  }
}

function verifyEndpoint(before: WebhookEndpoint, after: WebhookEndpoint): void {
  verifyEndpointIdentity(before, after);
  if (missingEvents(after).length || before.enabledEvents.some((eventType) => !after.enabledEvents.includes(eventType))) {
    throw new StripeChargebackError('stripe-webhook-verification-failed', 409, 'Stripe webhook configuration could not be verified.');
  }
}

export async function configureStripeChargebackWebhooks(
  request: StripeChargebackWebhookConfigurationRequest,
  env: StripeChargebackEnv,
  options: StripeChargebackOptions,
): Promise<StripeChargebackWebhookConfigurationResult> {
  if (!record(request) || (request.mode !== 'live' && request.mode !== 'test') ||
    (request.write !== undefined && typeof request.write !== 'boolean') ||
    Object.keys(request).some((key) => key !== 'mode' && key !== 'write')) {
    throw new StripeChargebackError('invalid-argument', 400, 'Stripe webhook configuration request is invalid.');
  }
  const write = request.write === true;
  const matches: WebhookEndpoint[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    options.signal.throwIfAborted();
    const page = await stripeRead('webhook_endpoints', {
      limit: '100',
      ...(cursor ? { starting_after: cursor } : {}),
    }, request.mode, env, options);
    if (!record(page) || page.object !== 'list' || !Array.isArray(page.data) ||
      page.data.length > 100 || typeof page.has_more !== 'boolean' || (page.has_more && !page.data.length)) {
      throw invalidEndpoint();
    }
    for (const value of page.data) {
      const endpoint = webhookEndpoint(value, request.mode);
      if (seen.has(endpoint.id)) throw invalidEndpoint();
      seen.add(endpoint.id);
      cursor = endpoint.id;
      if (endpoint.url === STRIPE_ORDER_WEBHOOK_URL && endpoint.status === 'enabled') matches.push(endpoint);
    }
    if (!page.has_more) break;
  }
  if (!matches.length) {
    throw new StripeChargebackError('stripe-webhook-not-active', 409, 'No active Stripe order webhook endpoint was found.');
  }
  const endpoints: StripeChargebackWebhookConfigurationResult['endpoints'] = [];
  for (const endpoint of matches) {
    options.signal.throwIfAborted();
    const pathname = `webhook_endpoints/${endpoint.id}`;
    let configured = write
      ? webhookEndpoint(await stripeRead(pathname, {}, request.mode, env, options), request.mode)
      : endpoint;
    verifyEndpointIdentity(endpoint, configured);
    let updated = false;
    if (write && missingEvents(configured).length) {
      const before = configured;
      const events = [...new Set([...before.enabledEvents, ...STRIPE_DISPUTE_EVENT_TYPES])];
      const form = new URLSearchParams();
      for (const eventType of events) form.append('enabled_events[]', eventType);
      const response = webhookEndpoint(await stripeRead(pathname, {}, request.mode, env, options, form), request.mode);
      verifyEndpoint(before, response);
      configured = webhookEndpoint(await stripeRead(pathname, {}, request.mode, env, options), request.mode);
      verifyEndpoint(before, configured);
      updated = true;
    }
    endpoints.push({
      id: configured.id,
      url: configured.url,
      enabledEvents: [...configured.enabledEvents],
      missingEvents: missingEvents(configured),
      updated,
    });
  }
  return { mode: request.mode, write, endpoints, complete: endpoints.every((endpoint) => endpoint.missingEvents.length === 0) };
}
