import type { MintSelectionConfig, SolanaCluster } from './deploymentCore.ts';
import {
  classifyStripeCheckoutKind,
  STRIPE_UNIT_AMOUNT_CENTS_MAX,
  STRIPE_UNIT_AMOUNT_CENTS_MIN,
  type StripeCheckoutKind,
} from './stripeCheckoutCore.ts';
import {
  STRIPE_CHECKOUT_STATUS,
  STRIPE_OFFCHAIN_CURRENCY,
  STRIPE_OFFCHAIN_FULFILLMENT_MODE,
  normalizeStripeCheckoutQuantity,
  resolveMintSelectionVariantIndex,
} from './stripeCheckoutSession.ts';
import {
  normalizeStripeCheckoutIdentity,
  type StripeCheckoutIdentity,
} from './checkoutIdentity.ts';
import {
  STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
  isStripeCheckoutFulfillmentEventType,
  type StripeCheckoutFulfillmentEventType,
} from './stripeCheckoutFulfillmentJob.ts';

export const STRIPE_WEBHOOK_PATH = '/webhooks/stripe';

export type StripeWebhookSecretScope = 'devnet' | 'mainnet';

export type StripeCheckoutDocumentData = StripeCheckoutIdentity & {
  variantKey?: string;
  quantity: number;
  unitAmountCents: number;
  livemode: boolean;
  status: string;
  deliveryId?: number;
};

export type StripeWebhookDrop = {
  dropId: string;
  solanaCluster: SolanaCluster;
  itemsPerBox: number;
  mintSelection?: MintSelectionConfig;
  salesMode?: unknown;
};

export type StripeWebhookSession = {
  id: string;
  livemode: boolean;
  mode?: unknown;
  payment_status?: unknown;
  automatic_tax?: unknown;
  amount_subtotal?: unknown;
  amount_total?: unknown;
  total_details?: unknown;
  currency?: unknown;
  metadata: Record<string, string>;
};

export type StripeWebhookEvent = {
  id: string;
  type: string;
  data: { object: StripeWebhookSession };
};

export type StripeWebhookAction =
  | { kind: 'ignored'; reason: 'unsupported_event'; eventId: string; eventType: string }
  | {
      kind: 'ignored';
      reason: 'not_app_fulfillment';
      eventId: string;
      eventType: string;
      sessionId: string;
    }
  | {
      kind: 'awaiting_payment';
      dropId: string;
      eventId: string;
      eventType: StripeCheckoutFulfillmentEventType;
      expectedSecretScope: StripeWebhookSecretScope;
      sessionId: string;
    }
  | {
      kind: 'enqueue';
      checkoutKind: StripeCheckoutKind;
      dropId: string;
      eventId: string;
      eventType: StripeCheckoutFulfillmentEventType;
      expectedLivemode: boolean;
      expectedSecretScope: StripeWebhookSecretScope;
      session: StripeWebhookSession;
      sessionId: string;
      variantKey?: string;
    };

export type StripeWebhookTransition = {
  outcome: 'queued' | 'already_pending' | 'already_fulfilled';
  deliveryId?: number;
  fields: Record<string, unknown>;
  deleteFields: string[];
  serverTimestampFields: string[];
};

const STRIPE_CHECKOUT_SESSION_ID_RE = /^[A-Za-z0-9_:-]{4,256}$/;
const FAILURE_STATE_FIELDS = [
  'lastFulfillmentError',
  'lastRetryableFulfillmentAttempt',
  'lastRetryableFulfillmentError',
  'lastRetryableFulfillmentErrorAt',
  'manualRefundReviewRequired',
  'manualRefundReviewReason',
  'nextFulfillmentRetryAt',
  'failedAt',
] as const;
const PROCESSING_STATE_FIELDS = [
  'processingStartedAt',
  'processingAttemptId',
  'processingLeaseExpiresAt',
] as const;

function normalizedString(value: unknown): string {
  return String(value || '').trim();
}

function integerOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && Number.isInteger(numeric) ? numeric : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
  const numeric = integerOrNull(value);
  return numeric != null && numeric > 0 ? numeric : null;
}

function integerInRangeOrNull(value: unknown, min: number, max: number): number | null {
  const numeric = integerOrNull(value);
  return numeric != null && numeric >= min && numeric <= max ? numeric : null;
}

function requireSessionId(value: unknown): string {
  const sessionId = normalizedString(value);
  if (!STRIPE_CHECKOUT_SESSION_ID_RE.test(sessionId)) {
    throw new Error('Stripe checkout session id is invalid');
  }
  return sessionId;
}

function normalizeVariantKey(
  drop: StripeWebhookDrop,
  rawVariantKey: unknown,
  checkoutKind: StripeCheckoutKind,
): string | undefined {
  const raw = normalizedString(rawVariantKey);
  if (checkoutKind !== 'size_variant') {
    if (raw) throw new Error('variantKey is only supported for size Stripe checkout');
    return undefined;
  }
  if (!raw || drop.mintSelection?.kind !== 'size') {
    throw new Error('variantKey is required for Stripe checkout');
  }
  try {
    return drop.mintSelection.options[resolveMintSelectionVariantIndex(drop.mintSelection, raw)].key;
  } catch {
    throw new Error('Invalid variantKey');
  }
}

function sessionSnapshot(session: StripeWebhookSession): Record<string, unknown> {
  return {
    id: session.id,
    livemode: session.livemode,
    ...(session.mode === undefined ? {} : { mode: session.mode }),
    ...(session.payment_status === undefined ? {} : { payment_status: session.payment_status }),
    ...(session.automatic_tax === undefined ? {} : { automatic_tax: session.automatic_tax }),
    ...(session.amount_subtotal === undefined ? {} : { amount_subtotal: session.amount_subtotal }),
    ...(session.amount_total === undefined ? {} : { amount_total: session.amount_total }),
    ...(session.total_details === undefined ? {} : { total_details: session.total_details }),
    ...(session.currency === undefined ? {} : { currency: session.currency }),
    metadata: session.metadata,
  };
}

export function isStripeOffchainFulfillmentSession(
  session: { metadata?: Record<string, unknown> | null } | null | undefined,
): boolean {
  return normalizedString(session?.metadata?.fulfillmentMode) === STRIPE_OFFCHAIN_FULFILLMENT_MODE;
}

export function validateStripeCheckoutDocumentData(params: {
  dropId: string;
  variantKey?: string;
  sessionId: string;
  expectedLivemode?: boolean;
  checkout: unknown;
}): StripeCheckoutDocumentData {
  const checkout = params.checkout && typeof params.checkout === 'object' && !Array.isArray(params.checkout)
    ? params.checkout as Record<string, unknown>
    : {};
  const expectedLivemode = params.expectedLivemode === true;
  const requireString = (value: unknown, expected: string, label: string): void => {
    if (normalizedString(value) !== expected) {
      throw new Error(`App-created Stripe checkout has invalid ${label}`);
    }
  };

  requireString(checkout.sessionId, params.sessionId, 'session id');
  requireString(checkout.fulfillmentMode, STRIPE_OFFCHAIN_FULFILLMENT_MODE, 'fulfillment mode');
  requireString(checkout.dropId, params.dropId, 'drop id');
  const expectedVariantKey = normalizedString(params.variantKey);
  const checkoutVariantKey = normalizedString(checkout.variantKey);
  if (expectedVariantKey || checkoutVariantKey) {
    requireString(checkout.variantKey, expectedVariantKey, 'variant key');
  }
  requireString(checkout.currency, STRIPE_OFFCHAIN_CURRENCY, 'currency');

  let quantity: number;
  try {
    quantity = normalizeStripeCheckoutQuantity(checkout.quantity);
  } catch {
    throw new Error('App-created Stripe checkout has invalid quantity');
  }
  if (checkout.livemode !== expectedLivemode) {
    throw new Error('App-created Stripe checkout has invalid mode');
  }

  const unitAmountCents = integerInRangeOrNull(
    checkout.unitAmountCents,
    STRIPE_UNIT_AMOUNT_CENTS_MIN,
    STRIPE_UNIT_AMOUNT_CENTS_MAX,
  );
  if (unitAmountCents == null) {
    throw new Error('App-created Stripe checkout has invalid unit amount');
  }

  const identity = normalizeStripeCheckoutIdentity(checkout);
  const deliveryId = positiveIntegerOrNull(checkout.deliveryId);
  return {
    ...identity,
    ...(expectedVariantKey ? { variantKey: expectedVariantKey } : {}),
    quantity,
    unitAmountCents,
    livemode: expectedLivemode,
    status: normalizedString(checkout.status),
    ...(deliveryId != null ? { deliveryId } : {}),
  };
}

export function resolveStripeWebhookAction(
  event: StripeWebhookEvent,
  getDrop: (dropId: string) => StripeWebhookDrop | undefined,
): StripeWebhookAction {
  const eventId = normalizedString(event.id);
  const eventType = normalizedString(event.type);
  if (!eventId || !eventType) throw new Error('Stripe webhook event is invalid');
  if (!isStripeCheckoutFulfillmentEventType(eventType)) {
    return { kind: 'ignored', reason: 'unsupported_event', eventId, eventType };
  }

  const session = event.data?.object;
  const sessionId = requireSessionId(session?.id);
  if (!isStripeOffchainFulfillmentSession(session)) {
    return { kind: 'ignored', reason: 'not_app_fulfillment', eventId, eventType, sessionId };
  }
  const dropId = normalizedString(session.metadata?.dropId);
  if (!dropId) throw new Error('Stripe checkout session is missing off-chain fulfillment metadata');
  const drop = getDrop(dropId);
  if (!drop || drop.dropId !== dropId) throw new Error(`Unsupported dropId: ${dropId}`);
  const expectedSecretScope = drop.solanaCluster === 'devnet' ? 'devnet' : 'mainnet';
  if (drop.solanaCluster !== 'devnet' && drop.solanaCluster !== 'mainnet-beta') {
    throw new Error('Stripe checkout is only enabled for devnet and mainnet drops');
  }
  if (eventType === 'checkout.session.completed' && session.payment_status !== 'paid') {
    return { kind: 'awaiting_payment', dropId, eventId, eventType, expectedSecretScope, sessionId };
  }
  const checkoutKind = classifyStripeCheckoutKind({
    itemsPerBox: drop.itemsPerBox,
    mintSelection: drop.mintSelection,
    salesMode: drop.salesMode,
  });
  if (!checkoutKind) throw new Error('Stripe checkout drop configuration is invalid');
  const variantKey = normalizeVariantKey(drop, session.metadata?.variantKey, checkoutKind);
  const expectedLivemode = drop.solanaCluster === 'mainnet-beta';
  if (session.livemode !== expectedLivemode) {
    throw new Error('Stripe checkout mode does not match the drop cluster');
  }
  return {
    kind: 'enqueue',
    checkoutKind,
    dropId,
    eventId,
    eventType,
    expectedLivemode,
    expectedSecretScope,
    session,
    sessionId,
    ...(variantKey ? { variantKey } : {}),
  };
}

export function stripeWebhookTransition(
  checkout: unknown,
  action: Extract<StripeWebhookAction, { kind: 'enqueue' }>,
): StripeWebhookTransition {
  const checkoutData = validateStripeCheckoutDocumentData({
    checkout,
    dropId: action.dropId,
    expectedLivemode: action.expectedLivemode,
    sessionId: action.sessionId,
    ...(action.variantKey ? { variantKey: action.variantKey } : {}),
  });
  const seenFields = { lastStripeWebhookEventId: action.eventId };
  if (checkoutData.status === STRIPE_CHECKOUT_STATUS.FULFILLED) {
    return {
      outcome: 'already_fulfilled',
      ...(checkoutData.deliveryId ? { deliveryId: checkoutData.deliveryId } : {}),
      fields: seenFields,
      deleteFields: [],
      serverTimestampFields: ['updatedAt'],
    };
  }
  if (
    checkoutData.status !== STRIPE_CHECKOUT_STATUS.CREATED &&
    checkoutData.status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED
  ) {
    return {
      outcome: 'already_pending',
      fields: { ...seenFields, fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR },
      deleteFields: [],
      serverTimestampFields: ['updatedAt'],
    };
  }
  return {
    outcome: 'queued',
    fields: {
      ...seenFields,
      fulfillmentProcessor: STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR,
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      paymentStatus: action.session.payment_status ?? null,
      stripeSessionSummary: sessionSnapshot(action.session),
      lastStripeWebhookEventType: action.eventType,
    },
    deleteFields: [...FAILURE_STATE_FIELDS, ...PROCESSING_STATE_FIELDS],
    serverTimestampFields: ['fulfillmentRequestedAt', 'updatedAt'],
  };
}
