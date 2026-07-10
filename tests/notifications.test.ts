import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED,
  firstRejectedReadyToShipNotificationError,
  normalizeNotificationEmailRecipient,
  planReadyToShipOrderNotifications,
  resolveNotificationDeliveryId,
  shouldNotifyBuyerForDeliveryShippedWrite,
  shouldNotifyShippersForDeliveryReadyToShipWrite,
  shouldSendResendNotificationEmail,
  validateNotificationEmailRecipient,
} from '../functions/src/notifications.ts';
import {
  buildBuyerOrderReceivedEmailContent,
  buildBuyerOrderShippedEmailContent,
  buildShipperReadyToShipEmailContent,
  buildStripeCheckoutManualReviewEmailContent,
  type BuyerVisibleOrderEmailItem,
  fulfillmentAppUrlForOrder,
  type NotificationEmailItem,
  type ShipperVisibleOrderEmailItem,
  summarizeShipperReadyOrderItems,
} from '../functions/src/notificationEmails.ts';
import {
  buildBuyerVisibleOrderEmailItems,
  buildShipperVisibleOrderEmailItems,
} from '../functions/src/orderEmailItems.ts';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../functions/src/stripeCheckout/contract.ts';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countSubstring(value: string, substring: string): number {
  return value.split(substring).length - 1;
}

function buyerVisibleItemsForEmailBuilderTest(items: NotificationEmailItem[]): BuyerVisibleOrderEmailItem[] {
  return items as BuyerVisibleOrderEmailItem[];
}

function shipperVisibleItemsForEmailBuilderTest(items: NotificationEmailItem[]): ShipperVisibleOrderEmailItem[] {
  return items as ShipperVisibleOrderEmailItem[];
}

test('Resend non-checkout error notification emails are enabled', () => {
  assert.equal(RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED, true);
  assert.equal(shouldSendResendNotificationEmail('buyer_order_received'), true);
  assert.equal(shouldSendResendNotificationEmail('buyer_order_shipped'), true);
  assert.equal(shouldSendResendNotificationEmail('shipper_ready_to_ship'), true);
  assert.equal(shouldSendResendNotificationEmail('stripe_checkout_manual_review'), true);
});

test('shipped notification requires the first Shipped state with a valid HTTPS tracking link', () => {
  assert.equal(
    shouldNotifyBuyerForDeliveryShippedWrite({
      before: { fulfillmentStatus: 'Preparing' },
      after: {
        fulfillmentStatus: 'Shipped',
        fulfillmentTrackingCode: ' https://carrier.example/track?id=AB123 ',
      },
    }),
    true,
  );
  assert.equal(
    shouldNotifyBuyerForDeliveryShippedWrite({
      before: { fulfillmentStatus: 'Shipped' },
      after: { fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: 'https://carrier.example/track?id=AB123' },
    }),
    true,
  );
  assert.equal(
    shouldNotifyBuyerForDeliveryShippedWrite({
      before: { fulfillmentStatus: 'Preparing' },
      after: { fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: '' },
    }),
    false,
  );
  assert.equal(
    shouldNotifyBuyerForDeliveryShippedWrite({
      before: { fulfillmentStatus: 'Preparing' },
      after: { fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: 'http://carrier.example/track?id=AB123' },
    }),
    false,
  );
  assert.equal(
    shouldNotifyBuyerForDeliveryShippedWrite({
      before: { fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: 'https://carrier.example/track?id=AB123' },
      after: { fulfillmentStatus: 'Shipped', fulfillmentTrackingCode: 'https://carrier.example/track?id=CD456' },
    }),
    false,
  );
});

test('shipped notification ignores non-customer delivery order sources', () => {
  assert.equal(
    shouldNotifyBuyerForDeliveryShippedWrite({
      before: { fulfillmentStatus: 'Preparing' },
      after: {
        fulfillmentStatus: 'Shipped',
        fulfillmentTrackingCode: 'https://carrier.example/track?id=AB123',
        source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
      },
      ignoredSources: [ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE],
    }),
    false,
  );
});

test('notification delivery IDs are path-authoritative positive safe integers', () => {
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '123', storedDeliveryId: 123 }), 123);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '123', storedDeliveryId: '123' }), 123);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '123' }), 123);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '123', storedDeliveryId: null }), 123);

  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '123', storedDeliveryId: 999 }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '123', storedDeliveryId: 123.5 }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '123', storedDeliveryId: true }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '0', storedDeliveryId: 0 }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '-1', storedDeliveryId: -1 }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '1.5', storedDeliveryId: 1.5 }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '001', storedDeliveryId: 1 }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '1e3', storedDeliveryId: 1000 }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: String(Number.MAX_SAFE_INTEGER + 1) }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: 'not-an-order' }), null);
  assert.equal(resolveNotificationDeliveryId({ deliveryDocId: '' }), null);
});

test('notification email recipients are normalized and validated', () => {
  assert.equal(normalizeNotificationEmailRecipient(' Buyer@Example.COM '), 'buyer@example.com');
  assert.equal(normalizeNotificationEmailRecipient('not an email'), null);
  assert.equal(normalizeNotificationEmailRecipient(''), null);
  assert.equal(normalizeNotificationEmailRecipient(null), null);
  assert.equal(validateNotificationEmailRecipient(' Buyer@Example.COM '), 'Buyer@Example.COM');
  assert.equal(validateNotificationEmailRecipient('not an email'), null);
});

test('ready-to-ship notification plan keeps buyer email independent from shipper recipients', () => {
  assert.deepEqual(
    planReadyToShipOrderNotifications({
      buyerEmail: ' Buyer@Example.COM ',
      shipperRecipients: [],
    }),
    {
      buyerRecipient: 'Buyer@Example.COM',
      shipperRecipients: [],
      shouldBuildOrderEmailItems: true,
    },
  );
});

test('ready-to-ship notification plan keeps shipper email independent from buyer recipient', () => {
  assert.deepEqual(
    planReadyToShipOrderNotifications({
      buyerEmail: undefined,
      shipperRecipients: [' Shipper@Example.COM ', 'shipper@example.com', 'not an email'],
    }),
    {
      buyerRecipient: null,
      shipperRecipients: ['shipper@example.com'],
      shouldBuildOrderEmailItems: true,
    },
  );
});

test('ready-to-ship notification plan skips item previews when only buyer skip will be recorded', () => {
  assert.deepEqual(
    planReadyToShipOrderNotifications({
      buyerEmail: 'invalid',
      shipperRecipients: [],
    }),
    {
      buyerRecipient: null,
      shipperRecipients: [],
      shouldBuildOrderEmailItems: false,
    },
  );
});

test('ready-to-ship notification rejection selection prefers retryable failures', () => {
  const permanent = new Error('permanent');
  const retryable = new Error('retryable');
  const results: PromiseSettledResult<void>[] = [
    { status: 'rejected', reason: permanent },
    { status: 'fulfilled', value: undefined },
    { status: 'rejected', reason: retryable },
  ];

  assert.equal(
    firstRejectedReadyToShipNotificationError(results, (reason) => reason === retryable),
    retryable,
  );
});

test('ready-to-ship notification rejection selection falls back to first failure', () => {
  const first = new Error('first');
  const second = new Error('second');
  const results: PromiseSettledResult<void>[] = [
    { status: 'rejected', reason: first },
    { status: 'rejected', reason: second },
  ];

  assert.equal(firstRejectedReadyToShipNotificationError(results, () => false), first);
  assert.equal(
    firstRejectedReadyToShipNotificationError([{ status: 'fulfilled', value: undefined }], () => true),
    undefined,
  );
});

test('shipper ready email builder uses a compact order number and escapes html', () => {
  const items = summarizeShipperReadyOrderItems({
    items: [{ kind: 'box' }, { kind: 'dude' }, { kind: 'dude' }, { kind: 'other' }],
  });
  const fulfillmentUrl = fulfillmentAppUrlForOrder('card_nft_2', 123);
  const content = buildShipperReadyToShipEmailContent(
    {
      idempotencyKey: 'test-shipper-ready',
      recipients: ['ivan@ivan.lol'],
      dropId: 'card_nft_2',
      dropName: 'Card NFT 2 <Drop>',
      deliveryId: 123,
      owner: 'owner<&>',
      items,
      itemPreviews: shipperVisibleItemsForEmailBuilderTest([
        {
          label: 'Card <111>',
          thumbnailUrl: 'https://cdn.example/card.jpg?x=<bad>&y="quote"',
        },
        { label: 'Pack & Box' },
      ]),
      fulfillmentUrl,
    },
    { subjectPrefix: '[TEST] ' },
  );

  assert.deepEqual(items, { itemCount: 4, boxCount: 1, dudeCount: 2 });
  assert.equal(content.subject, '[TEST] New order - Card NFT 2 <Drop>');
  assert.match(content.text, /^New order - 123/);
  assert.doesNotMatch(content.text, /New order received\./);
  assert.doesNotMatch(content.text, /^Items:$/m);
  assert.doesNotMatch(content.text, /Drop: Card NFT 2 <Drop>/);
  assert.doesNotMatch(content.text, /Owner: owner<&>/);
  assert.doesNotMatch(content.text, /Items: 4 total \(1 box, 2 figures\)/);
  assert.match(content.text, /- Card <111>/);
  assert.match(content.text, new RegExp(`Open fulfillment: ${escapeRegExp(fulfillmentUrl)}`));
  assert.match(content.html, /margin:0 0 20px 0;">New order - 123<\/h1>/);
  assert.doesNotMatch(content.html, /A new order is ready for fulfillment\./);
  assert.doesNotMatch(content.html, />Items<\/h2>/);
  assert.doesNotMatch(content.html, /Card NFT 2 &lt;Drop&gt;/);
  assert.doesNotMatch(content.html, /owner&lt;&amp;&gt;/);
  assert.doesNotMatch(content.html, /background:#f8fafc;border:1px solid #e5e7eb/);
  assert.match(content.html, /Card &lt;111&gt;/);
  assert.match(content.html, /Pack &amp; Box/);
  assert.match(content.html, /https:\/\/cdn\.example\/card\.jpg\?x=&lt;bad&gt;&amp;y=&quot;quote&quot;/);
  assert.match(content.html, /Open fulfillment/);
  assert.match(
    content.html,
    /min-width:200px;box-sizing:border-box;background:#0071e3;color:#ffffff;text-decoration:none;border:0;border-radius:980px;padding:14px 36px;font-size:18px;font-weight:700;letter-spacing:0\.3px;line-height:1;text-align:center/,
  );
  assert.doesNotMatch(content.html, /Card NFT 2 <Drop>/);
});

test('stripe checkout manual review email builder includes details and escapes html', () => {
  const content = buildStripeCheckoutManualReviewEmailContent(
    {
      idempotencyKey: 'test-stripe-manual-review',
      recipients: ['ivan@ivan.lol'],
      dropId: 'card_nft_2',
      dropName: 'Card NFT 2 <Drop>',
      sessionId: 'cs_test_123',
      checkoutPath: 'drops/card_nft_2/stripeCheckouts/cs_test_123',
      livemode: false,
      variantKey: 'xl',
      owner: 'owner<&>',
      firebaseUid: 'uid-123',
      manualRefundReviewReason: 'needs <review>',
      lastFulfillmentError: { message: 'bad <tag> & "quotes"' },
      createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      failedAt: Date.UTC(2026, 0, 2, 3, 6, 5),
    },
    { subjectPrefix: '[TEST] ' },
  );

  assert.equal(content.subject, '[TEST] Stripe Checkout Manual Review — Card NFT 2 <Drop>');
  assert.match(content.text, /Mode: test/);
  assert.match(content.text, /Session ID: cs_test_123/);
  assert.match(content.text, /Review reason: needs <review>/);
  assert.match(content.text, /Created at: 2026-01-02T03:04:05.000Z/);
  assert.match(content.html, /Card NFT 2 &lt;Drop&gt;/);
  assert.match(content.html, /needs &lt;review&gt;/);
  assert.match(content.html, /bad &lt;tag&gt; &amp; \\&quot;quotes\\&quot;/);
  assert.doesNotMatch(content.html, /bad <tag>/);
});

test('buyer order received email builder includes item thumbnails and escapes html', () => {
  const content = buildBuyerOrderReceivedEmailContent(
    {
      idempotencyKey: 'test-order-received',
      recipients: ['ivan@ivan.lol'],
      dropId: 'card_nft_2',
      dropName: 'Card NFT 2 <Drop>',
      deliveryId: 123,
      items: buyerVisibleItemsForEmailBuilderTest([
        {
          label: 'Card <111>',
          thumbnailUrl: 'https://cdn.example/card.jpg?x=<bad>&y="quote"',
        },
        { label: 'Pack & Box' },
        { label: 'Figure 3', thumbnailUrl: 'https://cdn.example/figure-3.webp' },
        { label: 'Figure 4' },
        { label: 'Figure 5' },
      ]),
    },
    { subjectPrefix: '[TEST] ' },
  );

  assert.equal(content.subject, '[TEST] Order received - Card NFT 2 <Drop>');
  assert.match(content.text, /We received your order\./);
  assert.match(content.text, /^Order received - 123/);
  assert.doesNotMatch(content.text, /Drop: Card NFT 2 <Drop>/);
  assert.doesNotMatch(content.text, /Items: 5 total/);
  assert.match(content.text, /- Card <111>/);
  assert.match(content.html, />Order received - 123<\/h1>/);
  assert.match(
    content.html,
    /font-size:15px;margin:0 0 18px 0;color:#374151;">Thanks for your order\. We&#39;ll let you know when it ships\.<\/p>/,
  );
  assert.doesNotMatch(content.html, /Card NFT 2 &lt;Drop&gt;/);
  assert.doesNotMatch(content.html, /background:#f8fafc;border:1px solid #e5e7eb/);
  assert.match(content.html, /Card &lt;111&gt;/);
  assert.match(content.html, /Pack &amp; Box/);
  assert.match(content.html, /https:\/\/cdn\.example\/card\.jpg\?x=&lt;bad&gt;&amp;y=&quot;quote&quot;/);
  assert.match(content.html, /table-layout:fixed/);
  assert.match(content.html, /width="112"/);
  assert.match(content.html, /height="112"/);
  assert.match(
    content.html,
    /width:112px;max-width:100%;height:112px;object-fit:contain;object-position:center;background:transparent;border:0;border-radius:0;padding:0/,
  );
  assert.match(content.html, /font-size:11px;line-height:1\.3;color:#111827;text-align:center/);
  assert.match(content.html, /width:25%;padding:0 4px 16px 4px;vertical-align:top;text-align:center/);
  assert.equal(countSubstring(content.html, '<tr>'), 2);
  assert.equal(countSubstring(content.html, '<img '), 2);
  assert.doesNotMatch(content.html, /width="100%"/);
  assert.doesNotMatch(content.html, /width:64px;padding:0 12px 12px 0/);
  assert.doesNotMatch(content.html, /width:56px;height:56px;border-radius:8px;background:#f1f3f5/);
  assert.doesNotMatch(content.html, /Card <111>/);
});

test('buyer order shipped email builder includes tracking link and escapes html', () => {
  const trackingUrl = 'https://carrier.example/track?id=AB<123>&ref="x"';
  const content = buildBuyerOrderShippedEmailContent(
    {
      idempotencyKey: 'test-order-shipped',
      recipients: ['ivan@ivan.lol'],
      dropId: 'little_swag_hoodies',
      dropName: 'Little Swag Hoodies <Drop>',
      deliveryId: 456,
      items: buyerVisibleItemsForEmailBuilderTest([
        { label: 'Hoodie XL <special>', thumbnailUrl: 'https://cdn.example/hoodie.webp' },
      ]),
      trackingUrl,
    },
    { subjectPrefix: '[TEST] ' },
  );

  assert.equal(content.subject, '[TEST] Order shipped - Little Swag Hoodies <Drop>');
  assert.match(content.text, /Your order shipped\./);
  assert.match(content.text, /^Order shipped - 456/);
  assert.match(content.text, new RegExp(`Tracking: ${escapeRegExp(trackingUrl)}`));
  assert.match(content.html, />Order shipped - 456<\/h1>/);
  assert.doesNotMatch(content.html, /Little Swag Hoodies &lt;Drop&gt;/);
  assert.doesNotMatch(content.html, /background:#f8fafc;border:1px solid #e5e7eb/);
  assert.match(content.html, /Hoodie XL &lt;special&gt;/);
  assert.match(content.html, /Track package/);
  assert.match(content.html, /background:#0071e3/);
  assert.match(content.html, /border-radius:980px/);
  assert.match(content.html, /href="https:\/\/carrier\.example\/track\?id=AB&lt;123&gt;&amp;ref=&quot;x&quot;"/);
  assert.doesNotMatch(content.html, /Hoodie XL <special>/);
});

test('buyer order email items include direct-delivery size labels and thumbnails', async () => {
  const items = await buildBuyerVisibleOrderEmailItems(
    {
      items: [
        { kind: 'box', refId: 16 },
        { kind: 'box', refId: 31 },
      ],
    },
    { dropId: 'little_swag_hoodies' },
  );

  assert.deepEqual(
    items.map((item) => item.label),
    ['XL', '2XL'],
  );
  assert.equal(items.length, 2);
  assert.match(items[0].thumbnailUrl || '', /hoodie_clean\.webp/);
  assert.match(items[1].thumbnailUrl || '', /hoodie_clean\.webp/);
});

test('order email items keep assigned card contents hidden for card nft 2 packs', async () => {
  const items = await buildBuyerVisibleOrderEmailItems(
    {
      items: [{ kind: 'box', refId: 8 }],
      irlClaims: [{ boxId: 8, dudeIds: [12, 1] }],
    },
    { dropId: 'card_nft_2' },
  );

  assert.deepEqual(
    items.map((item) => item.label),
    ['Pack 8'],
  );
  assert.equal(items.length, 1);
  assert.match(items[0].thumbnailUrl || '', /\/pack\/4\/initial\.webp/);
  assert.doesNotMatch(items.map((item) => item.label).join('\n'), /Card (1|12)/);
  assert.doesNotMatch(items.map((item) => item.thumbnailUrl || '').join('\n'), /\/fronts_1400\//);
});

test('buyer order email items keep assigned figures hidden for openable boxes', async () => {
  const items = await buildBuyerVisibleOrderEmailItems(
    {
      items: [{ kind: 'box', refId: 5 }],
      irlClaims: [{ boxId: 5, dudeIds: [3, 1, 2] }],
    },
    { dropId: 'little_swag_boxes' },
  );

  assert.deepEqual(
    items.map((item) => item.label),
    ['Box 5'],
  );
  assert.equal(items.length, 1);
  assert.match(items[0].thumbnailUrl || '', /\/little_swag_boxes\/box\/tight\.webp/);
  assert.doesNotMatch(items.map((item) => item.label).join('\n'), /Figure [123]/);
  assert.doesNotMatch(items.map((item) => item.thumbnailUrl || '').join('\n'), /\/figures\/clean\//);
});

test('buyer order email items preserve loose figures in sorted order', async () => {
  const items = await buildBuyerVisibleOrderEmailItems(
    {
      items: [
        { kind: 'dude', refId: 9 },
        { kind: 'dude', refId: 2 },
      ],
    },
    { dropId: 'little_swag_boxes' },
  );

  assert.deepEqual(
    items.map((item) => item.label),
    ['Figure 2', 'Figure 9'],
  );
});

test('buyer and shipper order email captions use item and media ids with the same thumbnail', async () => {
  const order = {
    items: [{ kind: 'dude', refId: 344 }],
  };
  const selectedOrder = { dropId: 'little_swag_boxes' };

  const [buyerItems, shipperItems] = await Promise.all([
    buildBuyerVisibleOrderEmailItems(order, selectedOrder),
    buildShipperVisibleOrderEmailItems(order, selectedOrder),
  ]);

  assert.deepEqual(
    buyerItems.map((item) => item.label),
    ['Figure 344'],
  );
  assert.deepEqual(
    shipperItems.map((item) => item.label),
    ['Figure 1'],
  );
  assert.match(buyerItems[0].thumbnailUrl || '', /\/little_swag_boxes\/figures\/clean\/1\.webp/);
  assert.equal(shipperItems[0].thumbnailUrl, buyerItems[0].thumbnailUrl);
});

test('buyer order email items ignore malformed delivery items and sealed-box claim ids', async () => {
  const items = await buildBuyerVisibleOrderEmailItems(
    {
      items: [
        { kind: 'box', refId: 7 },
        { kind: 'box', refId: 0 },
        { kind: 'dude', refId: 'bad' },
        { kind: 'other', refId: 1 },
      ],
      irlClaims: [
        { boxId: 7, dudeIds: [4, 'bad', 0, 3] },
        { boxId: 'bad', dudeIds: [10] },
      ],
    },
    { dropId: 'little_swag_boxes' },
  );

  assert.deepEqual(
    items.map((item) => item.label),
    ['Box 7'],
  );
  assert.match(items[0].thumbnailUrl || '', /\/little_swag_boxes\/box\/tight\.webp/);
  assert.doesNotMatch(items.map((item) => item.label).join('\n'), /Figure [34]/);
  assert.doesNotMatch(items.map((item) => item.thumbnailUrl || '').join('\n'), /\/figures\/clean\//);
});

test('order email items expose loose figures but keep boxed assignments sealed', async () => {
  const items = await buildBuyerVisibleOrderEmailItems(
    {
      items: [
        { kind: 'box', refId: 7 },
        { kind: 'dude', refId: 11 },
      ],
      irlClaims: [{ boxId: 7, dudeIds: [4] }],
    },
    { dropId: 'poncho_drifella' },
  );

  assert.deepEqual(
    items.map((item) => item.label),
    ['Pack 7', 'Card 11'],
  );
  assert.match(items[0].thumbnailUrl || '', /\/poncho_drifella\/pack\/initial\.webp/);
  assert.match(items[1].thumbnailUrl || '', /\/poncho_drifella\/items\/clean\/11\.webp/);
  assert.doesNotMatch(items.map((item) => item.label).join('\n'), /Card 4/);
  assert.doesNotMatch(items.map((item) => item.thumbnailUrl || '').join('\n'), /\/items\/clean\/4\.webp/);
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite accepts create-ready delivery orders', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: null,
      after: { status: 'ready_to_ship' },
    }),
    true,
  );
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite accepts transitions into ready_to_ship', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: { status: 'prepared' },
      after: { status: 'ready_to_ship' },
    }),
    true,
  );
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: { status: 'processing' },
      after: { status: 'ready_to_ship' },
    }),
    true,
  );
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite ignores repeated ready_to_ship writes', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: { status: 'ready_to_ship' },
      after: { status: 'ready_to_ship' },
    }),
    false,
  );
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite ignores non-ready creates', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: null,
      after: { status: 'processing' },
    }),
    false,
  );
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite ignores configured sources', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: null,
      after: { status: 'ready_to_ship', source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE },
      ignoredSources: [ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE],
    }),
    false,
  );
});

test('shouldNotifyShippersForDeliveryReadyToShipWrite ignores deletes', () => {
  assert.equal(
    shouldNotifyShippersForDeliveryReadyToShipWrite({
      before: { status: 'ready_to_ship' },
      after: null,
    }),
    false,
  );
});
