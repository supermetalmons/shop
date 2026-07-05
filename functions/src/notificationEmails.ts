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

export type BuyerOrderEmailItem = {
  label: string;
  thumbnailUrl?: string;
};

export type BuyerOrderEmailMessageBase = {
  idempotencyKey: string;
  recipients: string[];
  dropId: string;
  dropName: string;
  deliveryId: number;
  items: BuyerOrderEmailItem[];
};

export type BuyerOrderReceivedEmailMessage = BuyerOrderEmailMessageBase;

export type BuyerOrderShippedEmailMessage = BuyerOrderEmailMessageBase & {
  trackingUrl: string;
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

function buyerOrderEmailDetails(message: BuyerOrderEmailMessageBase): NotificationEmailDetail[] {
  return [
    { label: 'Drop', value: message.dropName || message.dropId },
    { label: 'Order', value: String(message.deliveryId) },
    { label: 'Items', value: `${message.items.length} total` },
  ];
}

function buyerOrderItemsText(message: BuyerOrderEmailMessageBase): string[] {
  if (!message.items.length) return ['- Items pending'];
  return message.items.map((item) => `- ${item.label || 'Item'}`);
}

function buyerOrderEmailText(args: {
  intro: string;
  message: BuyerOrderEmailMessageBase;
  trackingUrl?: string;
}): string {
  const details = buyerOrderEmailDetails(args.message).map(({ label, value }) => `${label}: ${value}`);
  const lines = [args.intro, '', ...details, '', 'Items:', ...buyerOrderItemsText(args.message)];
  if (args.trackingUrl) lines.push('', `Tracking: ${args.trackingUrl}`);
  return lines.join('\n');
}

export function buildBuyerOrderReceivedEmailText(message: BuyerOrderReceivedEmailMessage): string {
  return buyerOrderEmailText({
    intro: 'We received your order.',
    message,
  });
}

export function buildBuyerOrderShippedEmailText(message: BuyerOrderShippedEmailMessage): string {
  return buyerOrderEmailText({
    intro: 'Your order shipped.',
    message,
    trackingUrl: message.trackingUrl,
  });
}

function buyerOrderDetailsHtml(message: BuyerOrderEmailMessageBase): string {
  return buyerOrderEmailDetails(message)
    .map(
      ({ label, value }) =>
        `<div style="margin:0 0 4px 0;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`,
    )
    .join('');
}

function buyerOrderItemThumbnailHtml(item: BuyerOrderEmailItem): string {
  if (!item.thumbnailUrl) {
    return '<div style="width:56px;height:56px;border-radius:8px;background:#f1f3f5;"></div>';
  }

  return `<img src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(item.label)}" width="56" height="56" style="display:block;width:56px;height:56px;object-fit:contain;background:#f8fafc;border-radius:8px;padding:4px;box-sizing:border-box;">`;
}

function buyerOrderItemRowHtml(item: BuyerOrderEmailItem): string {
  const thumbnail = buyerOrderItemThumbnailHtml(item);
  return [
    '<tr>',
    `<td style="width:64px;padding:0 12px 12px 0;vertical-align:top;">${thumbnail}</td>`,
    `<td style="padding:0 0 12px 0;vertical-align:middle;font-size:14px;color:#1f2933;">${escapeHtml(item.label || 'Item')}</td>`,
    '</tr>',
  ].join('');
}

function buyerOrderItemsHtml(message: BuyerOrderEmailMessageBase): string {
  if (!message.items.length) {
    return [
      '<tr>',
      '<td style="padding:0;font-size:14px;color:#52606d;">Items pending</td>',
      '</tr>',
    ].join('');
  }

  return message.items.map(buyerOrderItemRowHtml).join('');
}

function buyerOrderTrackingHtml(trackingUrl: string | undefined): string {
  if (!trackingUrl) return '';
  return [
    '<div style="margin:22px 0 0 0;">',
    `<a href="${escapeHtml(trackingUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;padding:11px 16px;font-weight:700;font-size:14px;">Track package</a>`,
    '</div>',
  ].join('');
}

function buyerOrderHtmlShell(args: {
  title: string;
  intro: string;
  message: BuyerOrderEmailMessageBase;
  trackingUrl?: string;
}): string {
  const details = buyerOrderDetailsHtml(args.message);
  const itemRows = buyerOrderItemsHtml(args.message);
  const trackingBlock = buyerOrderTrackingHtml(args.trackingUrl);

  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5;max-width:560px;margin:0 auto;padding:24px 16px;">',
    `<h1 style="font-size:24px;line-height:1.2;margin:0 0 12px 0;">${escapeHtml(args.title)}</h1>`,
    `<p style="font-size:15px;margin:0 0 18px 0;color:#374151;">${escapeHtml(args.intro)}</p>`,
    `<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 22px 0;font-size:14px;">${details}</div>`,
    '<h2 style="font-size:16px;line-height:1.3;margin:0 0 12px 0;">Items</h2>',
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${itemRows}</table>`,
    trackingBlock,
    '</div>',
  ].join('');
}

export function buildBuyerOrderReceivedEmailHtml(message: BuyerOrderReceivedEmailMessage): string {
  return buyerOrderHtmlShell({
    title: 'Order received',
    intro: "Thanks for your order. We'll let you know when it ships.",
    message,
  });
}

export function buildBuyerOrderShippedEmailHtml(message: BuyerOrderShippedEmailMessage): string {
  return buyerOrderHtmlShell({
    title: 'Order shipped',
    intro: 'Your package is on the way.',
    message,
    trackingUrl: message.trackingUrl,
  });
}

export function buildBuyerOrderReceivedEmailContent(
  message: BuyerOrderReceivedEmailMessage,
  options?: NotificationEmailContentOptions,
): NotificationEmailContent {
  return {
    subject: `${subjectPrefix(options)}Order received - ${message.dropName || message.dropId}`,
    text: buildBuyerOrderReceivedEmailText(message),
    html: buildBuyerOrderReceivedEmailHtml(message),
  };
}

export function buildBuyerOrderShippedEmailContent(
  message: BuyerOrderShippedEmailMessage,
  options?: NotificationEmailContentOptions,
): NotificationEmailContent {
  return {
    subject: `${subjectPrefix(options)}Order shipped - ${message.dropName || message.dropId}`,
    text: buildBuyerOrderShippedEmailText(message),
    html: buildBuyerOrderShippedEmailHtml(message),
  };
}
