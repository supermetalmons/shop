import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdminIrlRedeemClaimCodeDocument,
  buildAdminIrlRedeemDeliveryOrderDocument,
  buildAdminIrlRedeemMarkerDocument,
  buildAdminIrlRedeemSelectionKey,
  getAdminIrlRedeemUnsupportedReason,
  resolveAdminIrlRedeemMarkerReuse,
} from '../functions/src/adminIrlRedeem.ts';
import {
  ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE,
  STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  isReceiptClaimDeliveryOrderSource,
} from '../functions/src/stripeCheckout/contract.ts';
import {
  canAdminIrlRedeemCardReceipt,
  canAdminIrlRedeemSelection,
  removeHiddenAssetIds,
  retainTransientHiddenAssetIdsPresentInInventory,
} from '../src/lib/adminIrlRedeem.ts';

const ADMIN_WALLET = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const IRL_REDEEM_WALLETS = [
  '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
  'AmzcjtuzXkSziYHRqmavPiTsbJveW13wiRhCTRnuheiq',
];
const SHIPPER_WITHOUT_IRL_REDEEM_ACCESS = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';

test('direct-card transient hiding clears absent receipts without changing persistent hidden assets', () => {
  const transient = new Set(['receipt-present', 'receipt-gone']);
  assert.deepEqual(
    Array.from(retainTransientHiddenAssetIdsPresentInInventory(transient, ['receipt-present', 'unrelated'])),
    ['receipt-present'],
  );
  assert.deepEqual(Array.from(transient), ['receipt-present', 'receipt-gone']);
});

test('claim completion unhides only the exact returned receipt asset ids', () => {
  const hidden = new Set(['receipt-a', 'receipt-b', 'pack-c']);
  assert.deepEqual(Array.from(removeHiddenAssetIds(hidden, ['receipt-b', '', 'missing'])), ['receipt-a', 'pack-c']);
  assert.deepEqual(Array.from(hidden), ['receipt-a', 'receipt-b', 'pack-c']);
});

test('Admin IRL Redeem eligibility is true for authorized wallets selecting their own card_nft_2 packs', () => {
  const selectedItems = [
    { dropId: 'card_nft_2', kind: 'box' as const },
    { dropId: 'card_nft_2', kind: 'box' as const },
  ];
  const base = {
    wallet: ADMIN_WALLET,
    isSignedInWallet: true,
    selectedCount: 2,
    selectedDropIds: ['card_nft_2'],
    selectedItems,
    deliverableItems: selectedItems,
    selectionOwner: ADMIN_WALLET,
    selectedDropFamily: 'card_nft_2' as const,
  };

  assert.equal(canAdminIrlRedeemSelection(base), true);
  IRL_REDEEM_WALLETS.forEach((wallet) => {
    assert.equal(canAdminIrlRedeemSelection({ ...base, wallet, selectionOwner: wallet }), true);
  });
  assert.equal(
    canAdminIrlRedeemSelection({
      ...base,
      wallet: SHIPPER_WITHOUT_IRL_REDEEM_ACCESS,
      selectionOwner: SHIPPER_WITHOUT_IRL_REDEEM_ACCESS,
    }),
    false,
  );
  assert.equal(canAdminIrlRedeemSelection({ ...base, selectionOwner: IRL_REDEEM_WALLETS[0] }), false);
  assert.equal(canAdminIrlRedeemSelection({ ...base, selectionOwner: null }), false);
  assert.equal(canAdminIrlRedeemSelection({ ...base, wallet: '11111111111111111111111111111111' }), false);
  assert.equal(canAdminIrlRedeemSelection({ ...base, isSignedInWallet: false }), false);
  assert.equal(canAdminIrlRedeemSelection({ ...base, selectedDropFamily: 'little_swag_boxes' as any }), false);
  assert.equal(
    canAdminIrlRedeemSelection({
      ...base,
      selectedItems: [{ dropId: 'card_nft_2', kind: 'dude' as const }],
      deliverableItems: [{ dropId: 'card_nft_2', kind: 'dude' as const }],
      selectedCount: 1,
    }),
    false,
  );
  assert.equal(
    canAdminIrlRedeemSelection({
      ...base,
      selectedDropIds: ['card_nft_2', 'poncho_drifella'],
      selectedCount: 3,
      selectedItems: [...selectedItems, { dropId: 'poncho_drifella', kind: 'box' as const }],
      deliverableItems: [...selectedItems, { dropId: 'poncho_drifella', kind: 'box' as const }],
    }),
    false,
  );
  assert.equal(
    canAdminIrlRedeemSelection({
      ...base,
      selectedItems: [...selectedItems, { dropId: 'card_nft_2', kind: 'certificate' as const }],
      selectedCount: 3,
    } as any),
    false,
  );
});

test('Admin IRL Redeem card eligibility accepts one owned card_nft_2 card receipt for the existing admins', () => {
  const item = { dropId: 'card_nft_2', kind: 'certificate' as const, dudeId: 42 };
  const base = {
    wallet: ADMIN_WALLET,
    isSignedInWallet: true,
    selectionOwner: ADMIN_WALLET,
    receiptCount: 1,
    item,
    dropFamily: 'card_nft_2' as const,
  };

  assert.equal(canAdminIrlRedeemCardReceipt(base), true);
  IRL_REDEEM_WALLETS.forEach((wallet) => {
    assert.equal(canAdminIrlRedeemCardReceipt({ ...base, wallet, selectionOwner: wallet }), true);
  });
});

test('Admin IRL Redeem card eligibility rejects unauthorized, grouped, non-card, and non-owned receipts', () => {
  const base = {
    wallet: ADMIN_WALLET,
    isSignedInWallet: true,
    selectionOwner: ADMIN_WALLET,
    receiptCount: 1,
    item: { dropId: 'card_nft_2', kind: 'certificate' as const, dudeId: 42 },
    dropFamily: 'card_nft_2' as const,
  };

  assert.equal(canAdminIrlRedeemCardReceipt({ ...base, isSignedInWallet: false }), false);
  assert.equal(canAdminIrlRedeemCardReceipt({ ...base, selectionOwner: IRL_REDEEM_WALLETS[0] }), false);
  assert.equal(canAdminIrlRedeemCardReceipt({ ...base, selectionOwner: null }), false);
  assert.equal(canAdminIrlRedeemCardReceipt({ ...base, receiptCount: 0 }), false);
  assert.equal(canAdminIrlRedeemCardReceipt({ ...base, receiptCount: 2 }), false);
  assert.equal(canAdminIrlRedeemCardReceipt({ ...base, dropFamily: 'little_swag_boxes' as any }), false);
  assert.equal(
    canAdminIrlRedeemCardReceipt({
      ...base,
      wallet: SHIPPER_WITHOUT_IRL_REDEEM_ACCESS,
      selectionOwner: SHIPPER_WITHOUT_IRL_REDEEM_ACCESS,
    }),
    false,
  );
  assert.equal(
    canAdminIrlRedeemCardReceipt({
      ...base,
      item: { dropId: 'card_nft_2', kind: 'box' as const, dudeId: 42 },
    }),
    false,
  );
  assert.equal(
    canAdminIrlRedeemCardReceipt({
      ...base,
      item: { dropId: 'card_nft_2', kind: 'certificate' as const, dudeId: undefined },
    }),
    false,
  );
  assert.equal(
    canAdminIrlRedeemCardReceipt({
      ...base,
      item: { dropId: 'card_nft_2', kind: 'certificate' as const, dudeId: 0 },
    }),
    false,
  );
  assert.equal(
    canAdminIrlRedeemCardReceipt({
      ...base,
      item: { dropId: 'card_nft_2', kind: 'certificate' as const, dudeId: 42.5 },
    }),
    false,
  );
});

test('Admin IRL Redeem unsupported reason mirrors server drop capability checks', () => {
  assert.equal(
    getAdminIrlRedeemUnsupportedReason({
      dropFamily: 'card_nft_2',
      itemsPerBox: 3,
      sharesCollectionMint: false,
    }),
    null,
  );
  assert.equal(
    getAdminIrlRedeemUnsupportedReason({
      dropFamily: 'little_swag_boxes',
      itemsPerBox: 3,
      sharesCollectionMint: false,
    }),
    'Admin IRL redeem is only available for card_nft_2 packs.',
  );
  assert.equal(
    getAdminIrlRedeemUnsupportedReason({
      dropFamily: 'card_nft_2',
      itemsPerBox: 0,
      sharesCollectionMint: false,
    }),
    'Admin IRL redeem requires pack-based drops.',
  );
  assert.equal(
    getAdminIrlRedeemUnsupportedReason({
      dropFamily: 'card_nft_2',
      itemsPerBox: 3,
      sharesCollectionMint: true,
    }),
    'Admin IRL redeem cannot be disambiguated for a shared collection mint.',
  );
});

test('Admin IRL Redeem delivery order document exposes long receipt claim codes through fulfillment fields', () => {
  const doc = buildAdminIrlRedeemDeliveryOrderDocument({
    dropId: 'card_nft_2',
    deliveryId: 456,
    requestId: 'request_12345678',
    owner: ADMIN_WALLET,
    receiptOwner: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    transferSignature: 'tx-transfer',
    receiptTxs: ['tx-receipt-a', 'tx-receipt-a', 'tx-receipt-b'],
    boxes: [
      {
        boxId: 22,
        originalAssetId: 'original-pack-22',
        receiptAssetId: 'receipt-pack-22',
        receiptClaimCode: 'BBBBBB-2222222222',
        dudeIds: [7, 8, 9],
      },
      {
        boxId: 11,
        originalAssetId: 'original-pack-11',
        receiptAssetId: 'receipt-pack-11',
        receiptClaimCode: 'AAAAAA-1111111111',
        dudeIds: [1, 2, 3],
      },
    ],
  }) as any;

  assert.equal(doc.source, ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE);
  assert.equal(doc.status, 'ready_to_ship');
  assert.deepEqual(doc.addressSnapshot, {
    label: 'Redeemed for IRL',
    country: 'Redeemed for IRL',
  });
  assert.deepEqual(doc.itemIds, ['receipt-pack-11', 'receipt-pack-22']);
  assert.deepEqual(doc.originalItemIds, ['original-pack-11', 'original-pack-22']);
  assert.deepEqual(doc.items, [
    { kind: 'box', refId: 11, assetId: 'receipt-pack-11', originalAssetId: 'original-pack-11' },
    { kind: 'box', refId: 22, assetId: 'receipt-pack-22', originalAssetId: 'original-pack-22' },
  ]);
  assert.deepEqual(doc.receiptTxs, ['tx-receipt-a', 'tx-receipt-b']);
  assert.deepEqual(doc.stripeReceiptClaimsByBoxId, {
    box_11: {
      namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
      code: 'AAAAAA-1111111111',
      boxId: 11,
      status: 'unclaimed',
    },
    box_22: {
      namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
      code: 'BBBBBB-2222222222',
      boxId: 22,
      status: 'unclaimed',
    },
  });
  assert.deepEqual(doc.irlClaims, [
    { boxId: 11, boxAssetId: 'receipt-pack-11', dudeIds: [1, 2, 3] },
    { boxId: 22, boxAssetId: 'receipt-pack-22', dudeIds: [7, 8, 9] },
  ]);
  assert.deepEqual(doc.adminIrlRedeem, {
    requestId: 'request_12345678',
    transferSignature: 'tx-transfer',
    originalItemIds: ['original-pack-11', 'original-pack-22'],
  });
});

test('Admin IRL Redeem claim code document uses the box receipt claim code as the single code source', () => {
  const doc = buildAdminIrlRedeemClaimCodeDocument({
    dropId: 'card_nft_2',
    deliveryId: 789,
    owner: ADMIN_WALLET,
    receiptOwner: '8wtxG6HMg4sdYGixfEvJ9eAATheyYsAU3Y7pTmqeA5nM',
    requestId: 'request_87654321',
    box: {
      boxId: 33,
      originalAssetId: 'original-pack-33',
      receiptAssetId: 'receipt-pack-33',
      receiptClaimCode: 'CCCCCC-3333333333',
      dudeIds: [10, 11, 12],
    },
  }) as any;

  assert.equal(doc.namespace, STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE);
  assert.equal(doc.source, ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE);
  assert.equal(doc.status, 'unclaimed');
  assert.equal(doc.code, 'CCCCCC-3333333333');
  assert.equal(doc.boxAssetId, 'receipt-pack-33');
  assert.equal(doc.originalBoxAssetId, 'original-pack-33');
  assert.deepEqual(doc.dudeIds, [10, 11, 12]);
});

test('Admin IRL Redeem selection key is stable across selected item order', () => {
  const first = buildAdminIrlRedeemSelectionKey({
    dropId: 'card_nft_2',
    originalAssetIds: ['original-pack-22', 'original-pack-11'],
  });
  const second = buildAdminIrlRedeemSelectionKey({
    dropId: 'card_nft_2',
    originalAssetIds: ['original-pack-11', 'original-pack-22'],
  });
  const differentDrop = buildAdminIrlRedeemSelectionKey({
    dropId: 'poncho_drifella',
    originalAssetIds: ['original-pack-11', 'original-pack-22'],
  });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, differentDrop);
});

test('Admin IRL Redeem marker document records pack idempotency fields', () => {
  const selectionKey = buildAdminIrlRedeemSelectionKey({
    dropId: 'card_nft_2',
    originalAssetIds: ['original-pack-44'],
  });
  const doc = buildAdminIrlRedeemMarkerDocument({
    dropId: 'card_nft_2',
    deliveryId: 444,
    requestId: 'request_marker_44',
    owner: ADMIN_WALLET,
    transferSignature: 'tx-transfer-marker',
    selectionKey,
    box: {
      boxId: 44,
      originalAssetId: 'original-pack-44',
      receiptAssetId: 'receipt-pack-44',
      receiptClaimCode: 'DDDDDD-4444444444',
      dudeIds: [13, 14, 15],
    },
  }) as any;

  assert.equal(doc.version, 1);
  assert.equal(doc.source, ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE);
  assert.equal(doc.dropId, 'card_nft_2');
  assert.equal(doc.selectionKey, selectionKey);
  assert.equal(doc.requestId, 'request_marker_44');
  assert.equal(doc.deliveryId, 444);
  assert.equal(doc.owner, ADMIN_WALLET);
  assert.equal(doc.originalAssetId, 'original-pack-44');
  assert.equal(doc.receiptAssetId, 'receipt-pack-44');
  assert.equal(doc.boxId, 44);
  assert.equal(doc.claimCode, 'DDDDDD-4444444444');
  assert.equal(doc.transferSignature, 'tx-transfer-marker');
});

test('Admin IRL Redeem marker reuse resolves exact duplicate selections', () => {
  const originalAssetIds = ['original-pack-11', 'original-pack-22'];
  const selectionKey = buildAdminIrlRedeemSelectionKey({ dropId: 'card_nft_2', originalAssetIds });
  const markerA = buildAdminIrlRedeemMarkerDocument({
    dropId: 'card_nft_2',
    deliveryId: 1234,
    requestId: 'request_original',
    owner: ADMIN_WALLET,
    transferSignature: 'tx-transfer-original',
    selectionKey,
    box: {
      boxId: 11,
      originalAssetId: 'original-pack-11',
      receiptAssetId: 'receipt-pack-11',
      receiptClaimCode: 'AAAAAA-1111111111',
      dudeIds: [1, 2, 3],
    },
  });
  const markerB = buildAdminIrlRedeemMarkerDocument({
    dropId: 'card_nft_2',
    deliveryId: 1234,
    requestId: 'request_original',
    owner: ADMIN_WALLET,
    transferSignature: 'tx-transfer-original',
    selectionKey,
    box: {
      boxId: 22,
      originalAssetId: 'original-pack-22',
      receiptAssetId: 'receipt-pack-22',
      receiptClaimCode: 'BBBBBB-2222222222',
      dudeIds: [7, 8, 9],
    },
  });

  const resolution = resolveAdminIrlRedeemMarkerReuse({
    dropId: 'card_nft_2',
    selectionKey,
    originalAssetIds: ['original-pack-22', 'original-pack-11'],
    markers: [markerA, markerA, markerB],
  });

  assert.equal(resolution.status, 'reuse');
  if (resolution.status !== 'reuse') return;
  assert.equal(resolution.deliveryId, 1234);
  assert.equal(resolution.requestId, 'request_original');
  assert.deepEqual(resolution.claimCodes, ['BBBBBB-2222222222', 'AAAAAA-1111111111']);
  assert.deepEqual(resolution.boxes, [
    {
      boxId: 22,
      originalAssetId: 'original-pack-22',
      receiptAssetId: 'receipt-pack-22',
      claimCode: 'BBBBBB-2222222222',
    },
    {
      boxId: 11,
      originalAssetId: 'original-pack-11',
      receiptAssetId: 'receipt-pack-11',
      claimCode: 'AAAAAA-1111111111',
    },
  ]);
});

test('Admin IRL Redeem marker reuse rejects partial-overlap selections', () => {
  const completeSelectionKey = buildAdminIrlRedeemSelectionKey({
    dropId: 'card_nft_2',
    originalAssetIds: ['original-pack-11', 'original-pack-22'],
  });
  const marker = buildAdminIrlRedeemMarkerDocument({
    dropId: 'card_nft_2',
    deliveryId: 1234,
    requestId: 'request_original',
    owner: ADMIN_WALLET,
    transferSignature: 'tx-transfer-original',
    selectionKey: completeSelectionKey,
    box: {
      boxId: 11,
      originalAssetId: 'original-pack-11',
      receiptAssetId: 'receipt-pack-11',
      receiptClaimCode: 'AAAAAA-1111111111',
      dudeIds: [1, 2, 3],
    },
  });

  const resolution = resolveAdminIrlRedeemMarkerReuse({
    dropId: 'card_nft_2',
    selectionKey: completeSelectionKey,
    originalAssetIds: ['original-pack-11', 'original-pack-22'],
    markers: [marker],
  });

  assert.deepEqual(resolution, { status: 'conflict', reason: 'partial marker overlap' });
});

test('long receipt claim source guard accepts Stripe and Admin IRL Redeem only', () => {
  assert.equal(isReceiptClaimDeliveryOrderSource(STRIPE_OFFCHAIN_DELIVERY_ORDER_SOURCE), true);
  assert.equal(isReceiptClaimDeliveryOrderSource(ADMIN_IRL_REDEEM_DELIVERY_ORDER_SOURCE), true);
  assert.equal(isReceiptClaimDeliveryOrderSource('manual_delivery'), false);
  assert.equal(isReceiptClaimDeliveryOrderSource(undefined), false);
});
