import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED,
  shouldNotifyShippersForDeliveryReadyToShipWrite,
  shouldSendResendNotificationEmail,
} from '../functions/src/notifications.ts';
import {
  buildBuyerOrderReceivedEmailContent,
  buildBuyerOrderShippedEmailContent,
  buildShipperReadyToShipEmailContent,
  buildStripeCheckoutManualReviewEmailContent,
  fulfillmentAppUrlForOrder,
  summarizeShipperReadyOrderItems,
} from '../functions/src/notificationEmails.ts';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../functions/src/stripeCheckout/contract.ts';
import { buildBuyerOrderEmailItems } from '../functions/scripts/buyerOrderEmailItems.ts';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('Resend non-checkout error notification emails are enabled', () => {
  assert.equal(RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED, true);
  assert.equal(shouldSendResendNotificationEmail('shipper_ready_to_ship'), true);
  assert.equal(shouldSendResendNotificationEmail('stripe_checkout_manual_review'), true);
});

test('shipper ready email builder includes details and escapes html', () => {
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
      fulfillmentUrl,
    },
    { subjectPrefix: '[TEST] ' },
  );

  assert.deepEqual(items, { itemCount: 4, boxCount: 1, dudeCount: 2 });
  assert.equal(content.subject, '[TEST] New Order — Card NFT 2 <Drop>');
  assert.match(content.text, /Drop: Card NFT 2 <Drop>/);
  assert.match(content.text, /Delivery ID: 123/);
  assert.match(content.text, /Items: 4 total/);
  assert.match(content.text, new RegExp(`Open fulfillment: ${escapeRegExp(fulfillmentUrl)}`));
  assert.match(content.html, /Card NFT 2 &lt;Drop&gt;/);
  assert.match(content.html, /owner&lt;&amp;&gt;/);
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
      items: [
        {
          label: 'Card <111>',
          thumbnailUrl: 'https://cdn.example/card.jpg?x=<bad>&y="quote"',
        },
        { label: 'Pack & Box' },
      ],
    },
    { subjectPrefix: '[TEST] ' },
  );

  assert.equal(content.subject, '[TEST] Order received - Card NFT 2 <Drop>');
  assert.match(content.text, /We received your order\./);
  assert.match(content.text, /Order: 123/);
  assert.match(content.text, /- Card <111>/);
  assert.match(content.html, /Card NFT 2 &lt;Drop&gt;/);
  assert.match(content.html, /Card &lt;111&gt;/);
  assert.match(content.html, /Pack &amp; Box/);
  assert.match(content.html, /https:\/\/cdn\.example\/card\.jpg\?x=&lt;bad&gt;&amp;y=&quot;quote&quot;/);
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
      items: [{ label: 'Hoodie XL <special>', thumbnailUrl: 'https://cdn.example/hoodie.webp' }],
      trackingUrl,
    },
    { subjectPrefix: '[TEST] ' },
  );

  assert.equal(content.subject, '[TEST] Order shipped - Little Swag Hoodies <Drop>');
  assert.match(content.text, /Your order shipped\./);
  assert.match(content.text, new RegExp(`Tracking: ${escapeRegExp(trackingUrl)}`));
  assert.match(content.html, /Little Swag Hoodies &lt;Drop&gt;/);
  assert.match(content.html, /Hoodie XL &lt;special&gt;/);
  assert.match(content.html, /Track package/);
  assert.match(content.html, /href="https:\/\/carrier\.example\/track\?id=AB&lt;123&gt;&amp;ref=&quot;x&quot;"/);
  assert.doesNotMatch(content.html, /Hoodie XL <special>/);
});

test('buyer order email items include direct-delivery size labels and thumbnails', async () => {
  const items = await buildBuyerOrderEmailItems(
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

test('buyer order email items use assigned figures for openable boxes', async () => {
  const items = await buildBuyerOrderEmailItems(
    {
      items: [{ kind: 'box', refId: 5 }],
      irlClaims: [{ boxId: 5, dudeIds: [3, 1, 2] }],
    },
    { dropId: 'little_swag_boxes' },
  );

  assert.deepEqual(
    items.map((item) => item.label),
    ['Figure 1', 'Figure 2', 'Figure 3'],
  );
  assert.match(items[0].thumbnailUrl || '', /\/figures\/clean\/1\.webp/);
});

test('buyer order email items preserve loose figures in sorted order', async () => {
  const items = await buildBuyerOrderEmailItems(
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

test('buyer order email items ignore malformed delivery item and claim ids', async () => {
  const items = await buildBuyerOrderEmailItems(
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
    ['Figure 3', 'Figure 4'],
  );
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
