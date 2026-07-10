export const NOTIFICATION_EMAIL_FROM = 'notifications@support.mons.shop';
export const FULFILLMENT_APP_URL = 'https://mons.shop/fulfillment';
const BUYER_ORDER_EMAIL_SUPPORT_FOOTNOTE = 'If you have any questions, reply to this email.';

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
  itemPreviews?: ShipperVisibleOrderEmailItem[];
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

export type NotificationEmailItem = {
  label: string;
  thumbnailUrl?: string;
};

declare const buyerVisibleOrderEmailItemBrand: unique symbol;
declare const shipperVisibleOrderEmailItemBrand: unique symbol;

// Order-backed notification emails must only use items produced by the
// audience-specific resolvers in orderEmailItems.ts. These brands catch typed
// call sites that try to pass fulfillment-only previews directly into buyer or
// shipper notification emails.
export type BuyerVisibleOrderEmailItem = NotificationEmailItem & {
  readonly [buyerVisibleOrderEmailItemBrand]: true;
};

export type ShipperVisibleOrderEmailItem = NotificationEmailItem & {
  readonly [shipperVisibleOrderEmailItemBrand]: true;
};

/**
 * @deprecated Use BuyerVisibleOrderEmailItem so the sealed-pack privacy
 * boundary stays explicit at call sites.
 */
export type BuyerOrderEmailItem = BuyerVisibleOrderEmailItem;

export type BuyerOrderEmailMessageBase = {
  idempotencyKey: string;
  recipients: string[];
  dropId: string;
  dropName: string;
  deliveryId: number;
  items: BuyerVisibleOrderEmailItem[];
};

export type BuyerOrderReceivedEmailMessage = BuyerOrderEmailMessageBase;
export type BuyerOrderUpdateEmailMessage = BuyerOrderEmailMessageBase;

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

function shipperReadyItemSummaryText(items: ShipperReadyOrderSummary): string {
  const parts = [
    items.boxCount ? `${items.boxCount} ${items.boxCount === 1 ? 'box' : 'boxes'}` : '',
    items.dudeCount ? `${items.dudeCount} ${items.dudeCount === 1 ? 'figure' : 'figures'}` : '',
  ].filter(Boolean);
  return parts.length ? `${items.itemCount} total (${parts.join(', ')})` : `${items.itemCount} total`;
}

function shipperReadyItemsText(message: ShipperReadyToShipEmailMessage): string[] {
  if (message.itemPreviews?.length) return notificationEmailItemsText(message.itemPreviews);
  if (message.items.itemCount > 0) return [`- ${shipperReadyItemSummaryText(message.items)}`];
  return ['- Items pending'];
}

export function buildShipperReadyEmailText(message: ShipperReadyToShipEmailMessage): string {
  return [
    `New order - ${message.deliveryId}`,
    '',
    ...shipperReadyItemsText(message),
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
  return notificationEmailHtmlShell({
    title: 'New order',
    orderNumber: message.deliveryId,
    items: message.itemPreviews || [],
    showItemsHeading: false,
    emptyItemsLabel: message.items.itemCount > 0 ? shipperReadyItemSummaryText(message.items) : 'Items pending',
    action: {
      label: 'Open fulfillment',
      url: message.fulfillmentUrl,
    },
  });
}

function subjectPrefix(options?: NotificationEmailContentOptions): string {
  return options?.subjectPrefix || '';
}

export function buildShipperReadyToShipEmailContent(
  message: ShipperReadyToShipEmailMessage,
  options?: NotificationEmailContentOptions,
): NotificationEmailContent {
  return {
    subject: `${subjectPrefix(options)}New order - ${message.dropName}`,
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

function notificationEmailItemsText(items: NotificationEmailItem[]): string[] {
  if (!items.length) return ['- Items pending'];
  return items.map((item) => `- ${item.label || 'Item'}`);
}

function buyerOrderEmailText(args: {
  title: string;
  intro: string;
  message: BuyerOrderEmailMessageBase;
  trackingUrl?: string;
  footnote?: string;
}): string {
  const lines = [
    `${args.title} - ${args.message.deliveryId}`,
    '',
    args.intro,
    '',
    'Items:',
    ...notificationEmailItemsText(args.message.items),
  ];
  if (args.trackingUrl) lines.push('', `Tracking: ${args.trackingUrl}`);
  if (args.footnote) lines.push('', args.footnote);
  return lines.join('\n');
}

export function buildBuyerOrderReceivedEmailText(message: BuyerOrderReceivedEmailMessage): string {
  return buyerOrderEmailText({
    title: 'Order received',
    intro: 'We received your order.',
    message,
    footnote: BUYER_ORDER_EMAIL_SUPPORT_FOOTNOTE,
  });
}

export function buildBuyerOrderUpdateEmailText(message: BuyerOrderUpdateEmailMessage): string {
  return buyerOrderEmailText({
    title: 'Order update',
    intro: "Thanks for your patience. We'll let you know when your order ships.",
    message,
    footnote: BUYER_ORDER_EMAIL_SUPPORT_FOOTNOTE,
  });
}

export function buildBuyerOrderShippedEmailText(message: BuyerOrderShippedEmailMessage): string {
  return buyerOrderEmailText({
    title: 'Order shipped',
    intro: 'Your order shipped.',
    message,
    trackingUrl: message.trackingUrl,
  });
}

const NOTIFICATION_EMAIL_ITEM_GRID_COLUMNS = 4;
const NOTIFICATION_EMAIL_ITEM_THUMBNAIL_MAX_SIZE = 112;
const NOTIFICATION_EMAIL_ITEM_CELL_WIDTH_PERCENT = 100 / NOTIFICATION_EMAIL_ITEM_GRID_COLUMNS;
const NOTIFICATION_EMAIL_ITEM_CELL_STYLE = `width:${NOTIFICATION_EMAIL_ITEM_CELL_WIDTH_PERCENT}%;padding:0 4px 16px 4px;vertical-align:top;text-align:center;`;

function notificationEmailItemThumbnailHtml(item: NotificationEmailItem): string {
  if (!item.thumbnailUrl) return '';

  return `<img src="${escapeHtml(item.thumbnailUrl)}" alt="${escapeHtml(item.label)}" width="${NOTIFICATION_EMAIL_ITEM_THUMBNAIL_MAX_SIZE}" height="${NOTIFICATION_EMAIL_ITEM_THUMBNAIL_MAX_SIZE}" style="display:block;width:${NOTIFICATION_EMAIL_ITEM_THUMBNAIL_MAX_SIZE}px;max-width:100%;height:${NOTIFICATION_EMAIL_ITEM_THUMBNAIL_MAX_SIZE}px;object-fit:contain;object-position:center;background:transparent;border:0;border-radius:0;padding:0;margin:0 auto 8px auto;box-sizing:border-box;">`;
}

function notificationEmailItemCellHtml(item: NotificationEmailItem): string {
  const thumbnail = notificationEmailItemThumbnailHtml(item);
  return [
    `<td style="${NOTIFICATION_EMAIL_ITEM_CELL_STYLE}">`,
    thumbnail,
    `<div style="font-size:11px;line-height:1.3;color:#111827;text-align:center;word-break:break-word;">${escapeHtml(item.label || 'Item')}</div>`,
    '</td>',
  ].join('');
}

function notificationEmailEmptyItemCellHtml(): string {
  return `<td style="${NOTIFICATION_EMAIL_ITEM_CELL_STYLE}">&nbsp;</td>`;
}

function notificationEmailItemGridRowHtml(items: NotificationEmailItem[]): string {
  const cells = items.map(notificationEmailItemCellHtml);
  while (cells.length < NOTIFICATION_EMAIL_ITEM_GRID_COLUMNS) {
    cells.push(notificationEmailEmptyItemCellHtml());
  }
  return `<tr>${cells.join('')}</tr>`;
}

function notificationEmailItemsHtml(items: NotificationEmailItem[], emptyLabel = 'Items pending'): string {
  if (!items.length) {
    return [
      '<tr>',
      `<td colspan="${NOTIFICATION_EMAIL_ITEM_GRID_COLUMNS}" style="padding:0;font-size:14px;color:#52606d;">${escapeHtml(emptyLabel)}</td>`,
      '</tr>',
    ].join('');
  }

  const rows: string[] = [];
  for (let index = 0; index < items.length; index += NOTIFICATION_EMAIL_ITEM_GRID_COLUMNS) {
    rows.push(notificationEmailItemGridRowHtml(items.slice(index, index + NOTIFICATION_EMAIL_ITEM_GRID_COLUMNS)));
  }
  return rows.join('');
}

function notificationEmailActionHtml(action: { label: string; url: string } | undefined): string {
  if (!action?.url) return '';
  return [
    '<div style="margin:22px 0 0 0;">',
    `<a href="${escapeHtml(action.url)}" style="display:inline-block;min-width:200px;box-sizing:border-box;background:#0071e3;color:#ffffff;text-decoration:none;border:0;border-radius:980px;padding:14px 36px;font-size:18px;font-weight:700;letter-spacing:0.3px;line-height:1;text-align:center;">${escapeHtml(action.label)}</a>`,
    '</div>',
  ].join('');
}

function notificationEmailFootnoteHtml(footnote: string | undefined): string {
  if (!footnote) return '';
  return `<p style="font-size:12px;line-height:1.5;margin:24px 0 0 0;color:#52606d;">${escapeHtml(footnote)}</p>`;
}

function notificationEmailHtmlShell(args: {
  title: string;
  intro?: string;
  orderNumber: number;
  items: NotificationEmailItem[];
  showItemsHeading?: boolean;
  emptyItemsLabel?: string;
  action?: {
    label: string;
    url: string;
  };
  footnote?: string;
}): string {
  const itemRows = notificationEmailItemsHtml(args.items, args.emptyItemsLabel);
  const actionBlock = notificationEmailActionHtml(args.action);
  const footnoteBlock = notificationEmailFootnoteHtml(args.footnote);
  const introBlock = args.intro
    ? `<p style="font-size:15px;margin:0 0 18px 0;color:#374151;">${escapeHtml(args.intro)}</p>`
    : '';
  const itemsHeading = args.showItemsHeading === false
    ? ''
    : '<h2 style="font-size:16px;line-height:1.3;margin:0 0 12px 0;">Items</h2>';
  const titleBottomMargin = args.intro ? 12 : 20;

  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5;max-width:560px;margin:0 auto;padding:24px 16px;">',
    `<h1 style="font-size:24px;line-height:1.2;margin:0 0 ${titleBottomMargin}px 0;">${escapeHtml(args.title)} - ${escapeHtml(args.orderNumber)}</h1>`,
    introBlock,
    itemsHeading,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;">${itemRows}</table>`,
    actionBlock,
    footnoteBlock,
    '</div>',
  ].join('');
}

export function buildBuyerOrderReceivedEmailHtml(message: BuyerOrderReceivedEmailMessage): string {
  return notificationEmailHtmlShell({
    title: 'Order received',
    intro: "Thanks for your order. We'll let you know when it ships.",
    orderNumber: message.deliveryId,
    items: message.items,
    footnote: BUYER_ORDER_EMAIL_SUPPORT_FOOTNOTE,
  });
}

export function buildBuyerOrderUpdateEmailHtml(message: BuyerOrderUpdateEmailMessage): string {
  return notificationEmailHtmlShell({
    title: 'Order update',
    intro: "Thanks for your patience. We'll let you know when your order ships.",
    orderNumber: message.deliveryId,
    items: message.items,
    footnote: BUYER_ORDER_EMAIL_SUPPORT_FOOTNOTE,
  });
}

export function buildBuyerOrderShippedEmailHtml(message: BuyerOrderShippedEmailMessage): string {
  return notificationEmailHtmlShell({
    title: 'Order shipped',
    intro: 'Your package is on the way.',
    orderNumber: message.deliveryId,
    items: message.items,
    action: {
      label: 'Track package',
      url: message.trackingUrl,
    },
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

export function buildBuyerOrderUpdateEmailContent(
  message: BuyerOrderUpdateEmailMessage,
  options?: NotificationEmailContentOptions,
): NotificationEmailContent {
  return {
    subject: `${subjectPrefix(options)}Order update - ${message.dropName || message.dropId}`,
    text: buildBuyerOrderUpdateEmailText(message),
    html: buildBuyerOrderUpdateEmailHtml(message),
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
