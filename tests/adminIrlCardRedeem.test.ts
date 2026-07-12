import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_IRL_REDEEM_CARD_MARKER_VERSION,
  ADMIN_IRL_REDEEM_MARKER_VERSION,
  buildAdminIrlRedeemCardClaimCodeDocument,
  buildAdminIrlRedeemCardDeliveryOrderDocument,
  buildAdminIrlRedeemCardMarkerDocument,
  buildAdminIrlRedeemDeliveryOrderDocument,
  buildAdminIrlRedeemMarkerDocument,
  buildAdminIrlRedeemSelectionKey,
} from '../functions/src/adminIrlRedeem.ts';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
} from '../functions/src/stripeCheckout/contract.ts';

const OWNER = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const RECEIPT_OWNER = '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM';
const CARD = {
  figureId: 137,
  receiptAssetId: 'card-receipt-asset-137',
  receiptClaimCode: 'abcdef-0123456789',
};

test('single-card Admin IRL Redeem order preserves the exact receipt as one normal card item', () => {
  const doc = buildAdminIrlRedeemCardDeliveryOrderDocument({
    dropId: 'card_nft_2',
    deliveryId: 7137,
    requestId: 'request_card_137',
    owner: OWNER,
    receiptOwner: RECEIPT_OWNER,
    transferSignature: 'transfer-card-receipt-137',
    card: CARD,
  }) as any;

  assert.equal(doc.source, ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE);
  assert.equal(doc.status, 'ready_to_ship');
  assert.equal(doc.owner, OWNER);
  assert.equal(doc.receiptOwner, RECEIPT_OWNER);
  assert.equal(doc.quantity, 1);
  assert.deepEqual(doc.itemIds, [CARD.receiptAssetId]);
  assert.deepEqual(doc.originalItemIds, [CARD.receiptAssetId]);
  assert.deepEqual(doc.items, [{ kind: 'dude', refId: CARD.figureId, assetId: CARD.receiptAssetId }]);
  assert.deepEqual(doc.receiptTxs, ['transfer-card-receipt-137']);
  assert.deepEqual(doc.stripeReceiptClaim, {
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: 'ABCDEF-0123456789',
    boxId: CARD.figureId,
    status: 'unclaimed',
    receiptKind: 'figure',
    figureId: CARD.figureId,
    receiptAssetId: CARD.receiptAssetId,
  });
  assert.deepEqual(doc.adminIrlRedeem, {
    targetKind: 'card_receipt',
    requestId: 'request_card_137',
    transferSignature: 'transfer-card-receipt-137',
    originalItemIds: [CARD.receiptAssetId],
  });
  assert.equal('stripeReceiptClaimsByBoxId' in doc, false);
  assert.equal('irlClaims' in doc, false);
  assert.equal('metadataId' in doc, false);
  assert.equal('metadataIds' in doc, false);
});

test('single-card claim document is a long-code claim for the exact receipt NFT', () => {
  const doc = buildAdminIrlRedeemCardClaimCodeDocument({
    dropId: 'card_nft_2',
    deliveryId: 7137,
    requestId: 'request_card_137',
    owner: OWNER,
    receiptOwner: RECEIPT_OWNER,
    card: CARD,
  }) as any;

  assert.deepEqual(doc, {
    version: 1,
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
    code: 'ABCDEF-0123456789',
    dropId: 'card_nft_2',
    deliveryId: 7137,
    owner: OWNER,
    receiptOwner: RECEIPT_OWNER,
    requestId: 'request_card_137',
    boxId: CARD.figureId,
    receiptKind: 'figure',
    figureId: CARD.figureId,
    receiptAssetId: CARD.receiptAssetId,
    status: 'unclaimed',
  });
  assert.match(doc.code, /^[A-Z]{6}-\d{10}$/);

  assert.throws(
    () =>
      buildAdminIrlRedeemCardClaimCodeDocument({
        dropId: 'card_nft_2',
        deliveryId: 7137,
        requestId: 'request_card_137',
        owner: OWNER,
        receiptOwner: RECEIPT_OWNER,
        card: { ...CARD, receiptClaimCode: '137' },
      }),
    /Invalid Stripe receipt claim code/,
  );
  assert.throws(
    () =>
      buildAdminIrlRedeemCardClaimCodeDocument({
        dropId: 'card_nft_2',
        deliveryId: 7137,
        requestId: 'request_card_137',
        owner: OWNER,
        receiptOwner: RECEIPT_OWNER,
        card: { ...CARD, figureId: 137.5 },
      }),
    /Invalid admin IRL redeem figure id/,
  );
});

test('single-card marker uses its own version and card receipt discriminator', () => {
  const doc = buildAdminIrlRedeemCardMarkerDocument({
    dropId: 'card_nft_2',
    deliveryId: 7137,
    requestId: 'request_card_137',
    owner: OWNER,
    transferSignature: 'transfer-card-receipt-137',
    card: CARD,
  }) as any;

  assert.deepEqual(doc, {
    version: ADMIN_IRL_REDEEM_CARD_MARKER_VERSION,
    source: ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
    targetKind: 'card_receipt',
    dropId: 'card_nft_2',
    requestId: 'request_card_137',
    deliveryId: 7137,
    owner: OWNER,
    receiptAssetId: CARD.receiptAssetId,
    figureId: CARD.figureId,
    claimCode: 'ABCDEF-0123456789',
    transferSignature: 'transfer-card-receipt-137',
  });
  assert.notEqual(ADMIN_IRL_REDEEM_CARD_MARKER_VERSION, ADMIN_IRL_REDEEM_MARKER_VERSION);
});

test('adding card redemption leaves legacy pack order and marker contracts unchanged', () => {
  const selectionKey = buildAdminIrlRedeemSelectionKey({
    dropId: 'card_nft_2',
    originalAssetIds: ['pack-asset-42'],
  });
  const box = {
    boxId: 42,
    originalAssetId: 'pack-asset-42',
    receiptAssetId: 'pack-receipt-42',
    receiptClaimCode: 'PACKED-4242424242',
    dudeIds: [1, 2, 3],
  };
  const order = buildAdminIrlRedeemDeliveryOrderDocument({
    dropId: 'card_nft_2',
    deliveryId: 7042,
    requestId: 'request_pack_42',
    owner: OWNER,
    receiptOwner: RECEIPT_OWNER,
    transferSignature: 'transfer-pack-42',
    receiptTxs: ['mint-pack-receipt-42'],
    boxes: [box],
  }) as any;
  const marker = buildAdminIrlRedeemMarkerDocument({
    dropId: 'card_nft_2',
    deliveryId: 7042,
    requestId: 'request_pack_42',
    owner: OWNER,
    transferSignature: 'transfer-pack-42',
    selectionKey,
    box,
  }) as any;

  assert.deepEqual(order.items, [
    { kind: 'box', refId: 42, assetId: 'pack-receipt-42', originalAssetId: 'pack-asset-42' },
  ]);
  assert.deepEqual(order.stripeReceiptClaimsByBoxId, {
    box_42: {
      namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
      code: 'PACKED-4242424242',
      boxId: 42,
      status: 'unclaimed',
    },
  });
  assert.equal('stripeReceiptClaim' in order, false);
  assert.deepEqual(order.adminIrlRedeem, {
    requestId: 'request_pack_42',
    transferSignature: 'transfer-pack-42',
    originalItemIds: ['pack-asset-42'],
  });

  assert.equal(marker.version, ADMIN_IRL_REDEEM_MARKER_VERSION);
  assert.equal(marker.originalAssetId, 'pack-asset-42');
  assert.equal(marker.receiptAssetId, 'pack-receipt-42');
  assert.equal(marker.boxId, 42);
  assert.equal('targetKind' in marker, false);
  assert.equal('figureId' in marker, false);
});
