export const NOTIFICATION_EMAIL_FROM = 'notifications@support.mons.shop';
export const FULFILLMENT_APP_URL = 'https://mons.shop/fulfillment';

export type ShipperReadyOrderSummary = {
  itemCount: number;
  boxCount: number;
  dudeCount: number;
};

export type ShipperReadyToShipEmailMessage = {
  idempotencyKey: string;
  recipients: string[];
  dropId: string;
  dropName: string;
  deliveryId: number;
  owner: string;
  items: ShipperReadyOrderSummary;
  fulfillmentUrl: string;
};

export type StripeCheckoutManualReviewEmailMessage = {
  idempotencyKey: string;
  recipients: string[];
  dropId: string;
  dropName: string;
  sessionId: string;
  checkoutPath: string;
  livemode: boolean;
  variantKey?: string;
  owner?: string;
  firebaseUid?: string;
  manualRefundReviewReason?: string;
  lastFulfillmentError?: unknown;
  createdAt?: number;
  fulfillmentRequestedAt?: number;
  processingStartedAt?: number;
  failedAt?: number;
};

export type NotificationEmailContent = {
  subject: string;
  text: string;
  html: string;
};

type NotificationEmailDetail = {
  label: string;
  value: string;
};

type NotificationEmailContentOptions = {
  subjectPrefix?: string;
};

export function summarizeShipperReadyOrderItems(order: any): ShipperReadyOrderSummary {
  const items = Array.isArray(order?.items) ? order.items : [];
  let boxCount = 0;
  let dudeCount = 0;
  for (const item of items) {
    if (item?.kind === 'box') {
      boxCount += 1;
    } else if (item?.kind === 'dude') {
      dudeCount += 1;
    }
  }
  return {
    itemCount: items.length,
    boxCount,
    dudeCount,
  };
}

export function fulfillmentAppUrlForOrder(dropId: string, deliveryId: number): string {
  const url = new URL(FULFILLMENT_APP_URL);
  url.searchParams.set('dropId', dropId);
  url.searchParams.set('deliveryId', String(deliveryId));
  return url.toString();
}

function shipperReadyEmailDetails(message: ShipperReadyToShipEmailMessage): NotificationEmailDetail[] {
  return [
    { label: 'Drop', value: `${message.dropName}` },
    { label: 'Delivery ID', value: String(message.deliveryId) },
    { label: 'Owner', value: message.owner || 'unknown' },
    {
      label: 'Items',
      value: `${message.items.itemCount} total`,
    },
  ];
}

export function buildShipperReadyEmailText(message: ShipperReadyToShipEmailMessage): string {
  const details = shipperReadyEmailDetails(message).map(({ label, value }) => `${label}: ${value}`);
  return [
    'New order received.',
    '',
    ...details,
    '',
    `Open fulfillment: ${message.fulfillmentUrl}`,
  ].join('\n');
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildShipperReadyEmailHtml(message: ShipperReadyToShipEmailMessage): string {
  const details = shipperReadyEmailDetails(message)
    .map(({ label, value }) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`)
    .join('');
  return [
    '<p>New order received.</p>',
    '<ul>',
    details,
    '</ul>',
    `<p><a href="${escapeHtml(message.fulfillmentUrl)}">Open fulfillment</a></p>`,
  ].join('');
}

function subjectPrefix(options?: NotificationEmailContentOptions): string {
  return options?.subjectPrefix || '';
}

export function buildShipperReadyToShipEmailContent(
  message: ShipperReadyToShipEmailMessage,
  options?: NotificationEmailContentOptions,
): NotificationEmailContent {
  return {
    subject: `${subjectPrefix(options)}New Order — ${message.dropName}`,
    text: buildShipperReadyEmailText(message),
    html: buildShipperReadyEmailHtml(message),
  };
}

function timestampEmailValue(value: number | undefined): string {
  return value ? new Date(value).toISOString() : 'unknown';
}

function stringifyEmailValue(value: unknown): string {
  if (value == null) return 'unknown';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stripeCheckoutManualReviewEmailDetails(
  message: StripeCheckoutManualReviewEmailMessage,
): NotificationEmailDetail[] {
  return [
    { label: 'Drop', value: message.dropName || message.dropId },
    { label: 'Drop ID', value: message.dropId },
    { label: 'Session ID', value: message.sessionId },
    { label: 'Mode', value: message.livemode ? 'live' : 'test' },
    { label: 'Variant', value: message.variantKey || 'unknown' },
    { label: 'Owner', value: message.owner || 'unknown' },
    { label: 'Firebase UID', value: message.firebaseUid || 'unknown' },
    { label: 'Review reason', value: message.manualRefundReviewReason || 'unknown' },
    { label: 'Checkout path', value: message.checkoutPath },
    { label: 'Created at', value: timestampEmailValue(message.createdAt) },
    { label: 'Fulfillment requested at', value: timestampEmailValue(message.fulfillmentRequestedAt) },
    { label: 'Processing started at', value: timestampEmailValue(message.processingStartedAt) },
    { label: 'Failed at', value: timestampEmailValue(message.failedAt) },
  ];
}

export function buildStripeCheckoutManualReviewEmailText(message: StripeCheckoutManualReviewEmailMessage): string {
  const details = stripeCheckoutManualReviewEmailDetails(message).map(({ label, value }) => `${label}: ${value}`);
  return [
    'Stripe checkout fulfillment needs manual review.',
    '',
    ...details,
    '',
    'Last fulfillment error:',
    stringifyEmailValue(message.lastFulfillmentError),
  ].join('\n');
}

export function buildStripeCheckoutManualReviewEmailHtml(message: StripeCheckoutManualReviewEmailMessage): string {
  const details = stripeCheckoutManualReviewEmailDetails(message)
    .map(({ label, value }) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`)
    .join('');
  return [
    '<p>Stripe checkout fulfillment needs manual review.</p>',
    '<ul>',
    details,
    '</ul>',
    '<p><strong>Last fulfillment error:</strong></p>',
    `<pre>${escapeHtml(stringifyEmailValue(message.lastFulfillmentError))}</pre>`,
  ].join('');
}

export function buildStripeCheckoutManualReviewEmailContent(
  message: StripeCheckoutManualReviewEmailMessage,
  options?: NotificationEmailContentOptions,
): NotificationEmailContent {
  return {
    subject: `${subjectPrefix(options)}Stripe Checkout Manual Review — ${message.dropName || message.dropId}`,
    text: buildStripeCheckoutManualReviewEmailText(message),
    html: buildStripeCheckoutManualReviewEmailHtml(message),
  };
}
