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
  type BuyerOrderEmailItem,
  fulfillmentAppUrlForOrder,
  summarizeShipperReadyOrderItems,
} from '../functions/src/notificationEmails.ts';
import { buildOrderEmailItems } from '../functions/src/orderEmailItems.ts';
import { ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE } from '../functions/src/stripeCheckout/contract.ts';
import { getFrontendDrop, type FrontendDeploymentConfig } from '../src/config/deployment.ts';
import { normalizeBoxDisplayImage, resolveDropContent } from '../src/lib/dropContent.ts';
import { dropAssetReference } from '../src/lib/dropLabels.ts';
import {
  figureMetadataCacheKey,
  loadFigureMetadataBatch,
  type FigureMetadataRecord,
} from '../src/lib/figureMetadata.ts';
import {
  resolveFulfillmentDirectDeliveryBoxLabel,
  resolveFulfillmentFigurePreview,
} from '../src/lib/fulfillmentLabels.ts';
import { isDirectDeliveryItemsPerBox } from '../src/lib/shipping.ts';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type TestDeliveryOrderItem = {
  kind: 'box' | 'dude';
  refId: number;
};

type TestOrderEmailContext = {
  boxes: TestDeliveryOrderItem[];
  looseFigureIds: number[];
  assignedFigureIdsByBoxId: Map<number, number[]>;
};

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
}

function testOrderEmailContext(order: any): TestOrderEmailContext {
  const items = (Array.isArray(order?.items) ? order.items : [])
    .map((item: any) => {
      if (!item || (item.kind !== 'box' && item.kind !== 'dude')) return null;
      const refId = normalizePositiveInteger(item.refId);
      return refId ? ({ kind: item.kind, refId } as TestDeliveryOrderItem) : null;
    })
    .filter((item: TestDeliveryOrderItem | null): item is TestDeliveryOrderItem => Boolean(item));
  const assignedFigureIdsByBoxId = new Map<number, number[]>();
  for (const claim of Array.isArray(order?.irlClaims) ? order.irlClaims : []) {
    const boxId = normalizePositiveInteger(claim?.boxId);
    if (!boxId) continue;
    const dudeIds = (Array.isArray(claim?.dudeIds) ? claim.dudeIds : [])
      .map((id: unknown) => normalizePositiveInteger(id))
      .filter((id): id is number => Boolean(id))
      .sort((a, b) => a - b);
    if (dudeIds.length) assignedFigureIdsByBoxId.set(boxId, dudeIds);
  }
  return {
    boxes: items.filter((item) => item.kind === 'box').sort((a, b) => a.refId - b.refId),
    looseFigureIds: items
      .filter((item) => item.kind === 'dude')
      .map((item) => item.refId)
      .sort((a, b) => a - b),
    assignedFigureIdsByBoxId,
  };
}

async function frontendFigureMetadataByKey(
  dropId: string,
  drop: FrontendDeploymentConfig | undefined,
  context: TestOrderEmailContext,
): Promise<Record<string, FigureMetadataRecord>> {
  const content = resolveDropContent(drop || dropId);
  if (content.figures.fulfillmentPreviewMode !== 'metadata_stills') return {};
  const figureIds = isDirectDeliveryItemsPerBox(drop?.itemsPerBox)
    ? context.looseFigureIds
    : [
        ...context.boxes.flatMap((box) => context.assignedFigureIdsByBoxId.get(box.refId) || []),
        ...context.looseFigureIds,
      ];
  if (!figureIds.length) return {};
  const records = await loadFigureMetadataBatch(figureIds.map((figureId) => ({ dropId, figureId })));
  return Object.fromEntries(records.map((record) => [figureMetadataCacheKey(record.dropId, record.id), record]));
}

function frontendOrderFigureItem(args: {
  dropId: string;
  drop: FrontendDeploymentConfig | undefined;
  figureId: number;
  index: number;
  figureMetadataByKey: Record<string, FigureMetadataRecord>;
}): BuyerOrderEmailItem {
  const content = resolveDropContent(args.drop || args.dropId);
  const preview = resolveFulfillmentFigurePreview({
    dropId: args.dropId,
    drop: args.drop,
    figureId: args.figureId,
    index: args.index,
    previewMode: content.figures.fulfillmentPreviewMode,
    figureMediaBase: content.figures.fulfillmentMediaBaseUrl,
    figureMetadataByKey: args.figureMetadataByKey,
  });
  const normalizedLabel = String(preview.label ?? '').trim();
  return {
    label:
      normalizedLabel && !/^\d+$/.test(normalizedLabel)
        ? normalizedLabel
        : dropAssetReference(args.drop, 'figure', normalizedLabel || args.figureId),
    ...(preview.imageSrc ? { thumbnailUrl: preview.imageSrc } : {}),
  };
}

async function frontendOrderEmailItems(order: any, dropId: string): Promise<BuyerOrderEmailItem[]> {
  const drop = getFrontendDrop(dropId);
  const context = testOrderEmailContext(order);
  const figureMetadataByKey = await frontendFigureMetadataByKey(dropId, drop, context);
  const isDirectDelivery = isDirectDeliveryItemsPerBox(drop?.itemsPerBox);
  const items: BuyerOrderEmailItem[] = [];
  let figureIndex = 0;
  const addFigure = (figureId: number) => {
    items.push(frontendOrderFigureItem({ dropId, drop, figureId, index: figureIndex, figureMetadataByKey }));
    figureIndex += 1;
  };

  if (isDirectDelivery) {
    for (const box of context.boxes) {
      const { label } = resolveFulfillmentDirectDeliveryBoxLabel(drop, box.refId);
      const thumbnailUrl = normalizeBoxDisplayImage({ dropId, boxId: box.refId });
      items.push({ label, ...(thumbnailUrl ? { thumbnailUrl } : {}) });
    }
  } else {
    for (const box of context.boxes) {
      const assignedFigureIds = context.assignedFigureIdsByBoxId.get(box.refId) || [];
      if (!assignedFigureIds.length) {
        const thumbnailUrl = normalizeBoxDisplayImage({ dropId, boxId: box.refId });
        items.push({
          label: dropAssetReference(drop, 'box', box.refId),
          ...(thumbnailUrl ? { thumbnailUrl } : {}),
        });
        continue;
      }
      assignedFigureIds.forEach(addFigure);
    }
  }

  context.looseFigureIds.forEach(addFigure);
  return items;
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
      itemPreviews: [
        {
          label: 'Card <111>',
          thumbnailUrl: 'https://cdn.example/card.jpg?x=<bad>&y="quote"',
        },
        { label: 'Pack & Box' },
      ],
      fulfillmentUrl,
    },
    { subjectPrefix: '[TEST] ' },
  );

  assert.deepEqual(items, { itemCount: 4, boxCount: 1, dudeCount: 2 });
  assert.equal(content.subject, '[TEST] New Order — Card NFT 2 <Drop>');
  assert.match(content.text, /Drop: Card NFT 2 <Drop>/);
  assert.match(content.text, /Order: 123/);
  assert.match(content.text, /Items: 4 total \(1 box, 2 figures\)/);
  assert.match(content.text, /- Card <111>/);
  assert.match(content.text, new RegExp(`Open fulfillment: ${escapeRegExp(fulfillmentUrl)}`));
  assert.match(content.html, /Card NFT 2 &lt;Drop&gt;/);
  assert.match(content.html, /owner&lt;&amp;&gt;/);
  assert.match(content.html, /Card &lt;111&gt;/);
  assert.match(content.html, /Pack &amp; Box/);
  assert.match(content.html, /https:\/\/cdn\.example\/card\.jpg\?x=&lt;bad&gt;&amp;y=&quot;quote&quot;/);
  assert.match(content.html, /Open fulfillment/);
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
  const items = await buildOrderEmailItems(
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

test('order email items include assigned card thumbnails for card nft 2', async () => {
  const items = await buildOrderEmailItems(
    {
      items: [{ kind: 'box', refId: 8 }],
      irlClaims: [{ boxId: 8, dudeIds: [12, 1] }],
    },
    { dropId: 'card_nft_2' },
  );

  assert.deepEqual(
    items.map((item) => item.label),
    ['Card 1', 'Card 12'],
  );
  assert.match(items[0].thumbnailUrl || '', /\/fronts_1400\/0001\.webp/);
  assert.match(items[1].thumbnailUrl || '', /\/fronts_1400\/0012\.webp/);
});

test('buyer order email items use assigned figures for openable boxes', async () => {
  const items = await buildOrderEmailItems(
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
  const items = await buildOrderEmailItems(
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
  const items = await buildOrderEmailItems(
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

test('order email items stay aligned with fulfillment dashboard previews', async () => {
  const cases = [
    {
      dropId: 'card_nft_2',
      order: {
        items: [{ kind: 'box', refId: 8 }],
        irlClaims: [{ boxId: 8, dudeIds: [12, 1] }],
      },
    },
    {
      dropId: 'card_nft_2',
      order: {
        items: [{ kind: 'box', refId: 8 }],
      },
    },
    {
      dropId: 'little_swag_boxes',
      order: {
        items: [{ kind: 'box', refId: 5 }, { kind: 'dude', refId: 9 }],
        irlClaims: [{ boxId: 5, dudeIds: [3, 1, 2] }],
      },
    },
    {
      dropId: 'little_swag_hoodies',
      order: {
        items: [
          { kind: 'box', refId: 16 },
          { kind: 'box', refId: 31 },
        ],
      },
    },
    {
      dropId: 'poncho_drifella',
      order: {
        items: [{ kind: 'box', refId: 7 }, { kind: 'dude', refId: 11 }],
        irlClaims: [{ boxId: 7, dudeIds: [4] }],
      },
    },
  ];

  for (const { dropId, order } of cases) {
    assert.deepEqual(await buildOrderEmailItems(order, { dropId }), await frontendOrderEmailItems(order, dropId), dropId);
  }
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
