export type StripeChargebackMode = 'live' | 'test';

export const STRIPE_DISPUTE_EVENT_TYPES = [
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.funds_reinstated',
] as const;

export type StripeChargebackMaintenanceErrorResult = {
  ok: false;
  error: { code: string; status: number };
};

export type StripeDispute = Readonly<{
  id: string;
  livemode: boolean;
  chargeId: string;
  paymentIntentId?: string;
  created: number;
}>;

export type StripeChargebackBackfillRequest = {
  mode: StripeChargebackMode;
  cursor?: string;
  write?: boolean;
};

export type StripeChargebackBackfillResult = {
  mode: StripeChargebackMode;
  write: boolean;
  nextCursor: string | null;
  scanned: number;
  matchedOrders: number;
  inserted: number;
  existing: number;
  unrelated: number;
  failures: Array<{ disputeId: string; code: string }>;
};

export type StripeChargebackWebhookConfigurationRequest = {
  mode: StripeChargebackMode;
  write?: boolean;
};

export type StripeChargebackWebhookConfigurationResult = {
  mode: StripeChargebackMode;
  write: boolean;
  endpoints: Array<{
    id: string;
    url: string;
    enabledEvents: string[];
    missingEvents: string[];
    updated: boolean;
  }>;
  complete: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isStripeChargebackSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^cs_(?:live|test)_[A-Za-z0-9_]+$/.test(value);
}

export function isStripeDisputeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^(?:du|dp)_[A-Za-z0-9_]+$/.test(value);
}

export function isStripeDisputeEventType(value: unknown): boolean {
  return STRIPE_DISPUTE_EVENT_TYPES.some((eventType) => eventType === value);
}

function referenceId(value: unknown, pattern: RegExp, livemode: boolean): string | null {
  if (record(value) && typeof value.livemode === 'boolean' && value.livemode !== livemode) return null;
  const id = record(value) ? value.id : value;
  return typeof id === 'string' && id.length <= 256 && pattern.test(id) ? id : null;
}

export function normalizeStripeDispute(value: unknown): StripeDispute | null {
  if (!record(value) || value.object !== 'dispute' || !isStripeDisputeId(value.id) ||
    typeof value.livemode !== 'boolean' || !Number.isSafeInteger(value.created) ||
    Number(value.created) < 0) return null;
  const chargeId = referenceId(value.charge, /^(?:ch|py)_[A-Za-z0-9_]+$/, value.livemode);
  const paymentIntentId = value.payment_intent == null
    ? undefined
    : referenceId(value.payment_intent, /^pi_[A-Za-z0-9_]+$/, value.livemode);
  if (!chargeId || paymentIntentId === null) return null;
  return {
    id: value.id,
    livemode: value.livemode,
    chargeId,
    ...(paymentIntentId ? { paymentIntentId } : {}),
    created: Number(value.created),
  };
}
