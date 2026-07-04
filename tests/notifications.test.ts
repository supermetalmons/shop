import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESEND_NON_CHECKOUT_ERROR_NOTIFICATION_EMAILS_ENABLED,
  shouldNotifyShippersForDeliveryReadyToShipWrite,
  shouldSendResendNotificationEmail,
} from '../functions/src/notifications.ts';
import {
  buildShipperReadyToShipEmailContent,
  buildStripeCheckoutManualReviewEmailContent,
  fulfillmentAppUrlForOrder,
  summarizeShipperReadyOrderItems,
} from '../functions/src/notificationEmails.ts';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../functions/src/stripeCheckout/contract.ts';

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
  assert.match(content.text, new RegExp(`Open fulfillment: ${fulfillmentUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
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
