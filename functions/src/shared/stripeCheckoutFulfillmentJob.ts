export const STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR = 'cloudflare_queue_v1' as const;
export const STRIPE_CHECKOUT_FULFILLMENT_JOB_KIND = 'stripe_checkout_fulfillment' as const;
export const STRIPE_CHECKOUT_FULFILLMENT_JOB_VERSION = 1 as const;
const STRIPE_CHECKOUT_FULFILLMENT_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
] as const;

export type StripeCheckoutFulfillmentEventType = typeof STRIPE_CHECKOUT_FULFILLMENT_EVENT_TYPES[number];

const DROP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STRIPE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:-]{4,256}$/;
const STRIPE_EVENT_TYPES: ReadonlySet<string> = new Set(STRIPE_CHECKOUT_FULFILLMENT_EVENT_TYPES);

export type StripeCheckoutFulfillmentJobV1 = {
  version: typeof STRIPE_CHECKOUT_FULFILLMENT_JOB_VERSION;
  kind: typeof STRIPE_CHECKOUT_FULFILLMENT_JOB_KIND;
  dropId: string;
  sessionId: string;
  stripeEventId: string;
  stripeEventType: StripeCheckoutFulfillmentEventType;
  enqueuedAtMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isStripeCheckoutFulfillmentEventType(
  value: unknown,
): value is StripeCheckoutFulfillmentEventType {
  return typeof value === 'string' && STRIPE_EVENT_TYPES.has(value);
}

export function isExactStripeCheckoutFulfillmentJobV1(
  value: unknown,
): value is StripeCheckoutFulfillmentJobV1 {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'dropId',
    'enqueuedAtMs',
    'kind',
    'sessionId',
    'stripeEventId',
    'stripeEventType',
    'version',
  ];
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    value.version === STRIPE_CHECKOUT_FULFILLMENT_JOB_VERSION &&
    value.kind === STRIPE_CHECKOUT_FULFILLMENT_JOB_KIND &&
    typeof value.dropId === 'string' &&
    DROP_ID_PATTERN.test(value.dropId) &&
    typeof value.sessionId === 'string' &&
    STRIPE_IDENTIFIER_PATTERN.test(value.sessionId) &&
    typeof value.stripeEventId === 'string' &&
    STRIPE_IDENTIFIER_PATTERN.test(value.stripeEventId) &&
    isStripeCheckoutFulfillmentEventType(value.stripeEventType) &&
    Number.isSafeInteger(value.enqueuedAtMs) &&
    Number(value.enqueuedAtMs) > 0
  );
}

export function createStripeCheckoutFulfillmentJobV1(args: {
  dropId: string;
  sessionId: string;
  stripeEventId: string;
  stripeEventType: string;
  enqueuedAtMs?: number;
}): StripeCheckoutFulfillmentJobV1 {
  const job = {
    version: STRIPE_CHECKOUT_FULFILLMENT_JOB_VERSION,
    kind: STRIPE_CHECKOUT_FULFILLMENT_JOB_KIND,
    dropId: args.dropId,
    sessionId: args.sessionId,
    stripeEventId: args.stripeEventId,
    stripeEventType: args.stripeEventType,
    enqueuedAtMs: Math.floor(args.enqueuedAtMs ?? Date.now()),
  };
  if (!isExactStripeCheckoutFulfillmentJobV1(job)) {
    throw new Error('Invalid Stripe checkout fulfillment job');
  }
  return job;
}
