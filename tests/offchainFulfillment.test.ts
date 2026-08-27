import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import Stripe from 'stripe';
import {
  ACCOUNT_ADMIN_DELIVERY_ORDER,
  IX_ADMIN_DELIVER_VARIANT_ORDER,
  STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
  STRIPE_CHECKOUT_OWNER_KIND_WALLET,
  STRIPE_CHECKOUT_SHIPPING_COUNTRY,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES,
  STRIPE_OFFCHAIN_CURRENCY,
  STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY,
  STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
  STRIPE_OFFCHAIN_FULFILLMENT_MODE,
  STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
  buildStripeCheckoutDocument,
  buildStripeCheckoutSessionMetadata,
  buildStripeOffchainDeliveryOrderDocument,
  buildStripeOffchainOrderMarkerDocument,
  buildStripeOffchainAddressSnapshot,
  decodeAdminDeliveryOrderRecord,
  deriveAdminOrderPda,
  encodeAdminDeliverVariantOrderArgs,
  generateStripeReceiptClaimCode,
  isStripeOffchainFulfillmentSession,
  normalizeStripeCheckoutQuantity,
  normalizeStripeReceiptClaimCode,
  requireStripeReceiptClaimCode,
  resolveMintSelectionVariantIndex,
  shouldProcessStripeCheckoutFulfillmentWrite,
  stripeCheckoutAnonymousOwnerId,
  stripeCheckoutSessionOrderHash,
  stripeFulfillmentAddressFromSession,
  validateStripeCheckoutContract,
  validateStripeCheckoutDocumentData,
  validateStripeTestCheckoutContract,
  type StripeOffchainDeliveryOrderDocumentInput,
} from '../cloud/workers/api/src/stripeCheckout/contract.ts';
import {
  orderStripeReceiptClaimByBoxId,
  stripeAssignedIrlClaimForBox,
} from '../shared/stripeReceiptClaims.ts';
import {
  STRIPE_CHECKOUT_PROCESSING_LEASE_MS,
  StripeCheckoutPackStatusProjectionError,
  buildStripeCheckoutManualReviewSummary,
  createOrGetStripeOffchainDeliveryOrder,
  isRetryableStripeCheckoutFulfillmentError,
  markStripeCheckoutFulfillmentFailed,
  markStripeCheckoutFulfillmentFulfilled,
  processStripeCheckoutFulfillmentDocument,
  releaseStripeCheckoutFulfillmentForRetry,
  runStripeCheckoutFulfillmentWithRetry,
  isStripeCheckoutManualReviewCandidate,
  startStripeCheckoutFulfillmentDocument,
  stripeApiModeForCluster,
  stripeApiKeysForMode,
  stripeApiKeyForMode,
  stripeCheckoutKindForDrop,
  stripeTestApiKey,
} from '../cloud/workers/api/src/stripeCheckout/service.ts';
import { stripeCheckoutFieldValue } from '../cloud/workers/api/src/stripeCheckout/store.ts';
import {
  createStripeCheckoutSessionCore,
  createStripeCheckoutIdentity,
  normalizeStripeCheckoutReturnUrl,
  stripeCheckoutProductName,
  stripeCheckoutProductTaxCodeForDrop,
  stripeCheckoutShippingCountriesForDropFamily,
  stripeCheckoutUnitAmountCentsForDrop,
} from '../shared/stripeCheckoutSession.ts';
import { IRL_CLAIM_CODE_DIGITS, normalizeIrlClaimCode } from '../cloud/workers/api/src/claimCodes.ts';
import {
  IX_BUBBLEGUM_MINT_V2,
  IX_BUBBLEGUM_BURN_V2,
  IX_BUBBLEGUM_TRANSFER_V2,
  bubblegumBurnV2Ix,
  bubblegumMintV2Ix,
  bubblegumTransferV2Ix,
  encodeBubblegumMintV2Args,
} from '../cloud/workers/api/src/bubblegum.ts';
import { COUNTRIES } from '../src/lib/countries.ts';
import { manualReviewCheckoutFromRecord } from '../shared/fulfillmentReadModel.ts';

function pubkey(seed: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff));
}

function u32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function timestampLike(ms: number): { toMillis(): number } {
  return { toMillis: () => ms };
}

function anchorDiscriminator(namespace: string, name: string): Buffer {
  return createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8);
}

test('stripeCheckoutSessionOrderHash is stable and livemode-scoped', () => {
  const testHash = stripeCheckoutSessionOrderHash('cs_test_123', false);
  const repeatHash = stripeCheckoutSessionOrderHash('cs_test_123', false);
  const liveHash = stripeCheckoutSessionOrderHash('cs_test_123', true);

  assert.equal(testHash.length, 32);
  assert.deepEqual(testHash, repeatHash);
  assert.notDeepEqual(testHash, liveHash);
});

test('Stripe receipt claim codes use canonical letters-dash-digits format', () => {
  const code = generateStripeReceiptClaimCode();
  assert.match(code, /^[A-Z]{6}-\d{10}$/);
  assert.equal(normalizeStripeReceiptClaimCode('  abcdef-0123456789  '), 'ABCDEF-0123456789');
  assert.equal(requireStripeReceiptClaimCode('abcdef-0123456789'), 'ABCDEF-0123456789');
  assert.throws(() => requireStripeReceiptClaimCode('ABCDEF0123456789'), /Invalid Stripe receipt claim code/);
});

test('Stripe receipt claim lookup can fall back from invalid plural data to a singular claim', () => {
  const order = {
    items: [{ kind: 'box', refId: 16 }],
    stripeReceiptClaimsByBoxId: {
      box_16: { code: 'bad-code', boxId: 16 },
    },
    stripeReceiptClaim: {
      code: 'ABCDEF-0123456789',
      status: 'unclaimed',
    },
  };

  assert.equal(orderStripeReceiptClaimByBoxId(order, 16)?.code, 'bad-code');
  assert.equal(
    orderStripeReceiptClaimByBoxId(order, 16, {
      includeSingularFallback: true,
      acceptClaim: (claim) => /^[A-Z]{6}-\d{10}$/.test(String(claim?.code || '')),
    })?.code,
    'ABCDEF-0123456789',
  );
});

test('IRL claim code normalization rejects Stripe-formatted alphabetic codes', () => {
  assert.equal(normalizeIrlClaimCode('123-456 7890'), '1234567890');
  assert.equal(normalizeIrlClaimCode('ABCDEF-0123456789'), '');
  assert.equal(IRL_CLAIM_CODE_DIGITS, 10);
});

test('Stripe assigned IRL claim helper returns specific receipt ids for a box', () => {
  const order = {
    irlClaims: [
      { boxId: 9, boxAssetId: 'receipt-9', dudeIds: [101, 102, 103] },
      { boxId: 10, boxAssetId: 'receipt-10', dudeIds: [104, 105, 106] },
    ],
  };

  assert.deepEqual(stripeAssignedIrlClaimForBox(order, 10, { itemsPerBox: 3, maxDudeId: 999 }), {
    boxId: 10,
    boxAssetId: 'receipt-10',
    dudeIds: [104, 105, 106],
  });
  assert.equal(stripeAssignedIrlClaimForBox(order, 11, { itemsPerBox: 3, maxDudeId: 999 }), null);
});

test('Stripe assigned IRL claim helper rejects incomplete receipt assignments', () => {
  assert.throws(
    () =>
      stripeAssignedIrlClaimForBox(
        {
          irlClaims: [{ boxId: 9, dudeIds: [101, 102] }],
        },
        9,
        { itemsPerBox: 3, maxDudeId: 999 },
      ),
    /invalid assigned receipt count/,
  );
  assert.throws(
    () =>
      stripeAssignedIrlClaimForBox(
        {
          irlClaims: [{ boxId: 9, dudeIds: [101, 102, 103] }],
        },
        9,
        { itemsPerBox: 3, maxDudeId: 999 },
      ),
    /missing assigned pack receipt asset id/,
  );
  assert.throws(
    () =>
      stripeAssignedIrlClaimForBox(
        {
          irlClaims: [{ boxId: 9, dudeIds: [101, 101, 103] }],
        },
        9,
        { itemsPerBox: 3, maxDudeId: 999 },
      ),
    /duplicate assigned receipt ids/,
  );
  assert.throws(
    () =>
      stripeAssignedIrlClaimForBox(
        {
          irlClaims: [{ boxId: 9, dudeIds: [101, 102.5, 103] }],
        },
        9,
        { itemsPerBox: 3, maxDudeId: 999 },
      ),
    /invalid assigned receipt id/,
  );
  assert.throws(
    () =>
      stripeAssignedIrlClaimForBox(
        {
          irlClaims: [
            { boxId: 9, boxAssetId: 'receipt-9a', dudeIds: [101, 102, 103] },
            { boxId: 9, boxAssetId: 'receipt-9b', dudeIds: [104, 105, 106] },
          ],
        },
        9,
        { itemsPerBox: 3, maxDudeId: 999 },
      ),
    /duplicate assigned box entries/,
  );
});

test('Bubblegum transferV2 helper uses expected discriminator and account order', () => {
  const payer = pubkey(1);
  const authority = pubkey(2);
  const leafOwner = pubkey(3);
  const leafDelegate = pubkey(4);
  const newLeafOwner = pubkey(5);
  const merkleTree = pubkey(6);
  const coreCollection = pubkey(7);
  const proof = [pubkey(8), pubkey(9)];
  const ix = bubblegumTransferV2Ix({
    bubblegumProgramId: pubkey(20),
    mplNoopProgramId: pubkey(21),
    mplAccountCompressionProgramId: pubkey(22),
    treeConfig: pubkey(23),
    payer,
    authority,
    leafOwner,
    leafDelegate,
    newLeafOwner,
    merkleTree,
    coreCollection,
    root: Buffer.alloc(32, 1),
    dataHash: Buffer.alloc(32, 2),
    creatorHash: Buffer.alloc(32, 3),
    assetDataHash: Buffer.alloc(32, 4),
    flags: 1,
    nonce: 12,
    index: 12,
    proof,
  });

  assert.deepEqual(ix.data.subarray(0, 8), IX_BUBBLEGUM_TRANSFER_V2);
  assert.equal(ix.keys[1].pubkey.toBase58(), payer.toBase58());
  assert.equal(ix.keys[1].isSigner, true);
  assert.equal(ix.keys[2].pubkey.toBase58(), authority.toBase58());
  assert.equal(ix.keys[2].isSigner, true);
  assert.equal(ix.keys[3].pubkey.toBase58(), leafOwner.toBase58());
  assert.equal(ix.keys[4].pubkey.toBase58(), leafDelegate.toBase58());
  assert.equal(ix.keys[5].pubkey.toBase58(), newLeafOwner.toBase58());
  assert.equal(ix.keys[6].pubkey.toBase58(), merkleTree.toBase58());
  assert.equal(ix.keys[7].pubkey.toBase58(), coreCollection.toBase58());
  assert.equal(ix.keys.at(-2)?.pubkey.toBase58(), proof[0].toBase58());
  assert.equal(ix.keys.at(-1)?.pubkey.toBase58(), proof[1].toBase58());
});

test('Bubblegum burnV2 helper uses expected discriminator and account order', () => {
  const payer = pubkey(1);
  const authority = pubkey(2);
  const leafOwner = pubkey(3);
  const leafDelegate = pubkey(4);
  const merkleTree = pubkey(5);
  const coreCollection = pubkey(6);
  const proof = [pubkey(7), pubkey(8)];
  const ix = bubblegumBurnV2Ix({
    bubblegumProgramId: pubkey(20),
    mplNoopProgramId: pubkey(21),
    mplAccountCompressionProgramId: pubkey(22),
    mplCoreProgramId: pubkey(23),
    mplCoreCpiSigner: pubkey(24),
    treeConfig: pubkey(25),
    payer,
    authority,
    leafOwner,
    leafDelegate,
    merkleTree,
    coreCollection,
    root: Buffer.alloc(32, 1),
    dataHash: Buffer.alloc(32, 2),
    creatorHash: Buffer.alloc(32, 3),
    assetDataHash: Buffer.alloc(32, 4),
    flags: 1,
    nonce: 12,
    index: 12,
    proof,
  });

  assert.deepEqual(ix.data.subarray(0, 8), IX_BUBBLEGUM_BURN_V2);
  assert.equal(ix.keys[1].pubkey.toBase58(), payer.toBase58());
  assert.equal(ix.keys[2].pubkey.toBase58(), authority.toBase58());
  assert.equal(ix.keys[3].pubkey.toBase58(), leafOwner.toBase58());
  assert.equal(ix.keys[4].pubkey.toBase58(), leafDelegate.toBase58());
  assert.equal(ix.keys[5].pubkey.toBase58(), merkleTree.toBase58());
  assert.equal(ix.keys[6].pubkey.toBase58(), coreCollection.toBase58());
  assert.equal(ix.keys.at(-2)?.pubkey.toBase58(), proof[0].toBase58());
  assert.equal(ix.keys.at(-1)?.pubkey.toBase58(), proof[1].toBase58());
});

test('Bubblegum mintV2 helper matches the receipt metadata encoding and account order', () => {
  const payer = pubkey(1);
  const merkleTree = pubkey(2);
  const coreCollection = pubkey(3);
  const treeConfig = pubkey(4);
  const mplCoreCpiSigner = pubkey(5);
  const name = 'receipt · binder 16';
  const uri = 'https://cdn.lil.org/nft/card_nft_binder/json/rb16.json';
  const data = encodeBubblegumMintV2Args({
    name,
    uri,
    coreCollection,
  });
  const expected = Buffer.concat([
    IX_BUBBLEGUM_MINT_V2,
    u32LE(Buffer.byteLength(name)),
    Buffer.from(name),
    u32LE(0),
    u32LE(Buffer.byteLength(uri)),
    Buffer.from(uri),
    Buffer.from([0, 0, 0, 1, 1, 0]),
    u32LE(0),
    Buffer.from([1]),
    coreCollection.toBuffer(),
    Buffer.from([0, 0]),
  ]);
  assert.deepEqual(data, expected);

  const ix = bubblegumMintV2Ix({
    bubblegumProgramId: pubkey(20),
    mplNoopProgramId: pubkey(21),
    mplAccountCompressionProgramId: pubkey(22),
    mplCoreProgramId: pubkey(23),
    mplCoreCpiSigner,
    treeConfig,
    payer,
    treeCreatorOrDelegate: payer,
    collectionAuthority: payer,
    leafOwner: payer,
    leafDelegate: payer,
    merkleTree,
    coreCollection,
    name,
    uri,
  });

  assert.deepEqual(
    ix.keys.map((key) => [
      key.pubkey.toBase58(),
      key.isSigner,
      key.isWritable,
    ]),
    [
      [treeConfig.toBase58(), false, true],
      [payer.toBase58(), true, true],
      [payer.toBase58(), true, false],
      [payer.toBase58(), true, false],
      [payer.toBase58(), false, false],
      [payer.toBase58(), false, false],
      [merkleTree.toBase58(), false, true],
      [coreCollection.toBase58(), false, true],
      [mplCoreCpiSigner.toBase58(), false, false],
      [pubkey(21).toBase58(), false, false],
      [pubkey(22).toBase58(), false, false],
      [pubkey(23).toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
    ],
  );
});

test('admin order PDA and instruction args use the on-chain seed and discriminator', () => {
  const programId = pubkey(1);
  const configPda = pubkey(2);
  const orderHash = Buffer.alloc(32, 9);
  const [pda] = deriveAdminOrderPda(programId, configPda, orderHash);
  const data = encodeAdminDeliverVariantOrderArgs({ orderHash, variantIndex: 2, quantity: 1 });
  const packData = encodeAdminDeliverVariantOrderArgs({ orderHash, variantIndex: 0, quantity: 3 });

  assert.deepEqual(IX_ADMIN_DELIVER_VARIANT_ORDER, anchorDiscriminator('global', 'admin_deliver_variant_order'));
  assert.deepEqual(ACCOUNT_ADMIN_DELIVERY_ORDER, anchorDiscriminator('account', 'AdminDeliveryOrderRecord'));
  assert.ok(PublicKey.isOnCurve(pda.toBuffer()) === false);
  assert.equal(data.length, 8 + 32 + 1 + 1);
  assert.deepEqual(data.subarray(0, 8), IX_ADMIN_DELIVER_VARIANT_ORDER);
  assert.equal(data.readUInt8(40), 2);
  assert.equal(data.readUInt8(41), 1);
  assert.equal(packData.readUInt8(40), 0);
  assert.equal(packData.readUInt8(41), 3);
});

test('resolveMintSelectionVariantIndex maps configured size keys', () => {
  const selection = {
    kind: 'size' as const,
    options: [
      { key: 'L', label: 'L', startId: 1, endId: 15 },
      { key: 'XL', label: 'XL', startId: 16, endId: 30 },
      { key: '2XL', label: '2XL', startId: 31, endId: 34 },
    ],
  };

  assert.equal(resolveMintSelectionVariantIndex(selection, 'XL'), 1);
  assert.throws(() => resolveMintSelectionVariantIndex(selection, 'M'), /Invalid variantKey/);
});

test('decodeAdminDeliveryOrderRecord decodes the Anchor account layout', () => {
  const orderHash = Buffer.alloc(32, 7);
  const owner = pubkey(80);
  const data = Buffer.concat([
    ACCOUNT_ADMIN_DELIVERY_ORDER,
    orderHash,
    Buffer.from([1, 1]),
    u32LE(16),
    owner.toBuffer(),
    u64LE(1234n),
    Buffer.from([255]),
  ]);

  const decoded = decodeAdminDeliveryOrderRecord(data);
  assert.deepEqual(decoded.orderHash, orderHash);
  assert.equal(decoded.variantIndex, 1);
  assert.equal(decoded.quantity, 1);
  assert.equal(decoded.firstMetadataId, 16);
  assert.equal(decoded.receiptOwner.toBase58(), owner.toBase58());
  assert.equal(decoded.createdSlot, 1234n);
  assert.equal(decoded.bump, 255);
});

test('stripeFulfillmentAddressFromSession formats shipping details without phone data', () => {
  const address = stripeFulfillmentAddressFromSession({
    customer_details: { email: 'buyer@example.com', phone: '+15551234567' },
    shipping_details: {
      name: 'Buyer Name',
      address: {
        line1: '1 Main St',
        line2: 'Unit 2',
        city: 'New York',
        state: 'NY',
        postal_code: '10001',
        country: 'US',
      },
    },
  });

  assert.equal(address?.email, 'buyer@example.com');
  assert.equal(address && 'phone' in address, false);
  assert.equal(address?.countryCode, 'US');
  assert.equal(address?.formatted, 'Buyer Name\n1 Main St\nUnit 2\nNew York, NY 10001\nUS');
});

test('stripeFulfillmentAddressFromSession reads Stripe v22 collected shipping details', () => {
  const address = stripeFulfillmentAddressFromSession({
    customer_details: { email: 'buyer@example.com', phone: '+15551234567' },
    collected_information: {
      shipping_details: {
        name: 'Buyer Name',
        address: {
          line1: '1 Main St',
          line2: 'Unit 2',
          city: 'New York',
          state: 'NY',
          postal_code: '10001',
          country: 'US',
        },
      },
    },
  });

  assert.equal(address?.email, 'buyer@example.com');
  assert.equal(address && 'phone' in address, false);
  assert.equal(address?.countryCode, 'US');
  assert.equal(address?.formatted, 'Buyer Name\n1 Main St\nUnit 2\nNew York, NY 10001\nUS');
});

test('stripeFulfillmentAddressFromSession returns null when address is missing', () => {
  assert.equal(stripeFulfillmentAddressFromSession({ customer_details: { email: 'buyer@example.com' } }), null);
  assert.equal(
    stripeFulfillmentAddressFromSession({
      customer_details: {
        email: 'buyer@example.com',
        address: {
          line1: '1 Billing St',
          city: 'New York',
          state: 'NY',
          postal_code: '10001',
          country: 'US',
        },
      },
    }),
    null,
  );
});

test('buildStripeCheckoutManualReviewSummary includes failed manual-review checkout contact info when allowed', () => {
  const checkout = {
    status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
    manualRefundReviewRequired: true,
    manualRefundReviewReason: 'delivery_order_creation_failed',
    owner: 'anonymous:anonymous_subject',
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
    authSubject: 'anonymous_subject',
    quantity: '15',
    createdAt: timestampLike(1_000),
    failedAt: timestampLike(2_000),
    lastFulfillmentError: { message: 'processing failure\nstack hidden' },
    stripeSessionSummary: {
      amount_total: '66000',
      currency: STRIPE_OFFCHAIN_CURRENCY,
    },
  };
  const session = {
    id: 'cs_test_manual_review_123',
    amount_total: 66000,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    metadata: { quantity: '15' },
    customer_details: { email: 'buyer@example.com', phone: '+15551234567' },
    shipping_details: {
      name: 'Buyer Name',
      address: {
        line1: '1 Main St',
        line2: 'Unit 2',
        city: 'New York',
        state: 'NY',
        postal_code: '10001',
        country: 'US',
      },
    },
  };

  const summary = buildStripeCheckoutManualReviewSummary({
    dropId: 'card_nft_2',
    sessionId: 'cs_test_manual_review_123',
    checkout,
    session: session as any,
    canViewSensitiveAddress: true,
  });

  assert.deepEqual(summary, {
    dropId: 'card_nft_2',
    sessionId: 'cs_test_manual_review_123',
    owner: 'anonymous:anonymous_subject',
    authSubject: 'anonymous_subject',
    quantity: 15,
    amountTotal: 66000,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    createdAt: 1_000,
    failedAt: 2_000,
    manualRefundReviewReason: 'delivery_order_creation_failed',
    errorMessage: 'processing failure',
    address: {
      email: 'buyer@example.com',
      country: 'US',
      countryCode: 'US',
      full: 'Buyer Name\n1 Main St\nUnit 2\nNew York, NY 10001\nUS',
    },
  });
  assert.equal(summary?.address && 'phone' in summary.address, false);
});

test('buildStripeCheckoutManualReviewSummary masks failed checkout contact info when address access is not allowed', () => {
  const checkout = {
    status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
    manualRefundReviewRequired: true,
    owner: 'owner_wallet',
    manualRefundReviewReason: 'fulfillment_failed',
  };
  const session = {
    id: 'cs_test_manual_review_456',
    customer_details: { email: 'buyer@example.com' },
    shipping_details: {
      name: 'Buyer Name',
      address: {
        line1: '1 Main St',
        city: 'New York',
        state: 'NY',
        postal_code: '10001',
        country: 'US',
      },
    },
  };

  const summary = buildStripeCheckoutManualReviewSummary({
    dropId: 'card_nft_2',
    sessionId: 'cs_test_manual_review_456',
    checkout,
    session: session as any,
    canViewSensitiveAddress: false,
  });

  assert.equal(summary?.address.full, '***');
  assert.equal(summary?.address.email, undefined);
  assert.equal(summary?.address.countryCode, 'US');
});

test('wallet-owned manual-review summaries do not fabricate an auth subject', () => {
  const wallet = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
  const summary = manualReviewCheckoutFromRecord({
    canViewSensitiveAddress: false,
    checkout: {
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
      manualRefundReviewRequired: true,
      ...createStripeCheckoutIdentity(wallet, wallet),
    },
    dropId: 'card_nft_2',
    session: null,
    sessionId: 'cs_test_staff_manual_review',
  });
  assert.equal(summary?.owner, wallet);
  assert.equal(Object.hasOwn(summary || {}, 'authSubject'), false);
});

test('manual-review summaries retain records with invalid identity metadata', () => {
  const summary = manualReviewCheckoutFromRecord({
    canViewSensitiveAddress: false,
    checkout: {
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
      manualRefundReviewRequired: true,
      ...createStripeCheckoutIdentity('anon:one'),
      owner: 'anonymous:anon:wrong',
    },
    dropId: 'card_nft_2',
    session: null,
    sessionId: 'cs_test_invalid_identity_manual_review',
  });
  assert.equal(summary?.owner, 'anonymous:anon:wrong');
  assert.equal(Object.hasOwn(summary || {}, 'authSubject'), false);
});

test('manual-review checkout summary excludes non-failed or non-manual-review checkout docs', () => {
  const included = {
    status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
    manualRefundReviewRequired: true,
    owner: 'owner_wallet',
  };
  const excluded = [
    { ...included, manualRefundReviewRequired: false },
    { ...included, status: STRIPE_CHECKOUT_STATUS.FULFILLED },
    { ...included, status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING },
    { ...included, status: STRIPE_CHECKOUT_STATUS.CREATED, manualRefundReviewRequired: true },
  ];

  assert.equal(isStripeCheckoutManualReviewCandidate(included), true);
  assert.ok(
    buildStripeCheckoutManualReviewSummary({
      dropId: 'card_nft_2',
      sessionId: 'cs_test_manual_review_789',
      checkout: included,
      session: null,
      canViewSensitiveAddress: true,
    }),
  );
  excluded.forEach((checkout) => {
    assert.equal(isStripeCheckoutManualReviewCandidate(checkout), false);
    assert.equal(
      buildStripeCheckoutManualReviewSummary({
        dropId: 'card_nft_2',
        sessionId: 'cs_test_manual_review_789',
        checkout,
        session: null,
        canViewSensitiveAddress: true,
      }),
      null,
    );
  });
});

test('buildStripeOffchainAddressSnapshot accepts US shipping addresses', () => {
  const validSession = {
    customer_details: { email: 'buyer@example.com' },
    shipping_details: {
      name: 'Buyer Name',
      address: {
        line1: '1 Main St',
        city: 'New York',
        state: 'NY',
        postal_code: '10001',
        country: 'US',
      },
    },
  };

  assert.deepEqual(
    buildStripeOffchainAddressSnapshot({
      session: validSession,
      encryptAddress: () => ({ encrypted: 'cipher', hint: 'B...US' }),
    }),
    {
      email: 'buyer@example.com',
      country: 'US',
      countryCode: 'US',
      encrypted: 'cipher',
      hint: 'B...US',
    },
  );
  assert.throws(
    () =>
      buildStripeOffchainAddressSnapshot({
        session: { customer_details: { email: 'buyer@example.com' } },
        encryptAddress: () => ({ encrypted: 'cipher', hint: 'B...US' }),
      }),
    /missing a shipping address/,
  );
  assert.throws(
    () =>
      buildStripeOffchainAddressSnapshot({
        session: validSession,
        encryptAddress: () => null,
      }),
    /could not be encrypted/,
  );
});

test('buildStripeOffchainAddressSnapshot rejects non-US shipping addresses', () => {
  assert.throws(
    () =>
      buildStripeOffchainAddressSnapshot({
        session: {
          customer_details: { email: 'buyer@example.com' },
          shipping_details: {
            name: 'Buyer Name',
            address: {
              line1: '1 King St',
              city: 'Toronto',
              state: 'ON',
              postal_code: 'M5H 1A1',
              country: 'CA',
            },
          },
        },
        encryptAddress: () => ({ encrypted: 'cipher', hint: 'B...CA' }),
      }),
    /must be in the US/,
  );
});

test('buildStripeOffchainAddressSnapshot accepts supported international binder addresses', () => {
  const session = {
    customer_details: { email: 'buyer@example.com' },
    shipping_details: {
      name: 'Buyer Name',
      address: {
        line1: '1 King St',
        city: 'Toronto',
        state: 'ON',
        postal_code: 'M5H 1A1',
        country: 'CA',
      },
    },
  };

  assert.deepEqual(
    buildStripeOffchainAddressSnapshot({
      session,
      dropFamily: 'card_nft_binder',
      encryptAddress: () => ({ encrypted: 'cipher', hint: 'B...CA' }),
    }),
    {
      email: 'buyer@example.com',
      country: 'CA',
      countryCode: 'CA',
      encrypted: 'cipher',
      hint: 'B...CA',
    },
  );
  assert.throws(
    () =>
      buildStripeOffchainAddressSnapshot({
        session: {
          ...session,
          shipping_details: {
            ...session.shipping_details,
            address: {
              ...session.shipping_details.address,
              country: 'IR',
            },
          },
        },
        dropFamily: 'card_nft_binder',
        encryptAddress: () => ({ encrypted: 'cipher', hint: 'B...IR' }),
      }),
    /country is not supported/,
  );
});

test('stripe checkout shipping countries vary by drop family', () => {
  assert.deepEqual(stripeCheckoutShippingCountriesForDropFamily(undefined), [STRIPE_CHECKOUT_SHIPPING_COUNTRY]);
  const binderCountriesList = stripeCheckoutShippingCountriesForDropFamily('card_nft_binder');
  assert.deepEqual(
    binderCountriesList,
    STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES,
  );
  const binderCountries = new Set<string>(binderCountriesList);
  assert.deepEqual(
    [...binderCountries].sort(),
    COUNTRIES.filter(({ code }) => code !== 'INTL').map(({ code }) => code).sort(),
  );
  assert.equal(binderCountries.has('CA'), true);
  assert.equal(binderCountries.has('TR'), true);
  assert.equal(binderCountries.has('IR'), false);
});

test('isStripeOffchainFulfillmentSession only accepts the app fulfillment mode', () => {
  assert.equal(
    isStripeOffchainFulfillmentSession({ metadata: { fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE } }),
    true,
  );
  assert.equal(isStripeOffchainFulfillmentSession({ metadata: { fulfillmentMode: 'manual' } }), false);
  assert.equal(isStripeOffchainFulfillmentSession({ metadata: {} }), false);
});

test('validateStripeTestCheckoutContract ignores unrelated checkout sessions', () => {
  const result = validateStripeTestCheckoutContract({
    session: { mode: 'payment', payment_status: 'paid', livemode: false, metadata: {} },
    lineItems: { data: [] },
    expectedUnitAmountCents: 100,
  });

  assert.deepEqual(result, { ignored: true });
});

test('validateStripeTestCheckoutContract accepts a one-item USD test checkout', () => {
  const result = validateStripeTestCheckoutContract({
    session: {
      mode: 'payment',
      payment_status: 'paid',
      livemode: false,
      automatic_tax: { enabled: true, status: 'complete' },
      amount_subtotal: 100,
      amount_total: 100,
      currency: STRIPE_OFFCHAIN_CURRENCY,
      metadata: {
        fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
        quantity: '1',
      },
    },
    lineItems: {
      data: [
        {
          quantity: 1,
          currency: STRIPE_OFFCHAIN_CURRENCY,
          amount_total: 100,
          price: { currency: STRIPE_OFFCHAIN_CURRENCY, unit_amount: 100 },
        },
      ],
    },
    expectedUnitAmountCents: 100,
  });

  assert.deepEqual(result, { quantity: 1, currency: STRIPE_OFFCHAIN_CURRENCY, unitAmountCents: 100 });
});

test('validateStripeCheckoutContract accepts a one-item USD live checkout', () => {
  const result = validateStripeCheckoutContract({
    session: {
      mode: 'payment',
      payment_status: 'paid',
      livemode: true,
      automatic_tax: { enabled: true, status: 'complete' },
      amount_subtotal: 24900,
      amount_total: 27042,
      currency: STRIPE_OFFCHAIN_CURRENCY,
      metadata: {
        fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
        quantity: '1',
      },
    },
    lineItems: {
      data: [
        {
          quantity: 1,
          currency: STRIPE_OFFCHAIN_CURRENCY,
          amount_subtotal: 24900,
          amount_total: 27042,
          price: { currency: STRIPE_OFFCHAIN_CURRENCY, unit_amount: 24900 },
        },
      ],
    },
    expectedUnitAmountCents: 24900,
    expectedLivemode: true,
  });

  assert.deepEqual(result, { quantity: 1, currency: STRIPE_OFFCHAIN_CURRENCY, unitAmountCents: 24900 });
  assert.throws(
    () =>
      validateStripeCheckoutContract({
        session: {
          mode: 'payment',
          payment_status: 'paid',
          livemode: false,
          metadata: { fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE },
        },
        lineItems: { data: [{ quantity: 1, currency: STRIPE_OFFCHAIN_CURRENCY, amount_total: 24900 }] },
        expectedUnitAmountCents: 24900,
        expectedLivemode: true,
      }),
    /live mode/,
  );
});

test('validateStripeCheckoutContract accepts multi-item checkout quantity when expected', () => {
  const result = validateStripeCheckoutContract({
    session: {
      mode: 'payment',
      payment_status: 'paid',
      livemode: true,
      automatic_tax: { enabled: true, status: 'complete' },
      amount_subtotal: 74700,
      amount_total: 81126,
      currency: STRIPE_OFFCHAIN_CURRENCY,
      metadata: {
        fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
        quantity: '3',
      },
    },
    lineItems: {
      data: [
        {
          quantity: 3,
          currency: STRIPE_OFFCHAIN_CURRENCY,
          amount_subtotal: 74700,
          amount_total: 81126,
          price: { currency: STRIPE_OFFCHAIN_CURRENCY, unit_amount: 24900 },
        },
      ],
    },
    expectedUnitAmountCents: 24900,
    expectedQuantity: 3,
    expectedLivemode: true,
  });

  assert.deepEqual(result, { quantity: 3, currency: STRIPE_OFFCHAIN_CURRENCY, unitAmountCents: 24900 });
  assert.throws(
    () =>
      validateStripeCheckoutContract({
        session: {
          mode: 'payment',
          payment_status: 'paid',
          livemode: true,
          automatic_tax: { enabled: true, status: 'complete' },
          amount_subtotal: 74700,
          amount_total: 74700,
          currency: STRIPE_OFFCHAIN_CURRENCY,
          metadata: {
            fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
            quantity: '3',
          },
        },
        lineItems: {
          data: [
            {
              quantity: 3,
              currency: STRIPE_OFFCHAIN_CURRENCY,
              amount_subtotal: 74700,
              amount_total: 74700,
              price: { currency: STRIPE_OFFCHAIN_CURRENCY, unit_amount: 24900 },
            },
          ],
        },
        expectedUnitAmountCents: 24900,
        expectedQuantity: 2,
        expectedLivemode: true,
      }),
    /quantity does not match expected quantity/,
  );
});

test('validateStripeTestCheckoutContract rejects quantity mismatches and multiple line items', () => {
  const session = {
    mode: 'payment',
    payment_status: 'paid',
    livemode: false,
    automatic_tax: { enabled: true, status: 'complete' },
    amount_total: 200,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    metadata: {
      fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
      quantity: '1',
    },
  };

  assert.throws(
    () =>
      validateStripeTestCheckoutContract({
        session,
        lineItems: {
          data: [{ quantity: 2, currency: STRIPE_OFFCHAIN_CURRENCY, amount_total: 200 }],
        },
        expectedUnitAmountCents: 100,
      }),
    /quantity metadata does not match/,
  );
  assert.throws(
    () =>
      validateStripeTestCheckoutContract({
        session,
        lineItems: {
          data: [
            { quantity: 1, currency: STRIPE_OFFCHAIN_CURRENCY, amount_total: 100 },
            { quantity: 1, currency: STRIPE_OFFCHAIN_CURRENCY, amount_total: 100 },
          ],
        },
        expectedUnitAmountCents: 100,
      }),
    /exactly one line item/,
  );
});

test('validateStripeTestCheckoutContract rejects wrong currency and amount', () => {
  const session = {
    mode: 'payment',
    payment_status: 'paid',
    livemode: false,
    automatic_tax: { enabled: true, status: 'complete' },
    amount_total: 100,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    metadata: {
      fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
      quantity: '1',
    },
  };

  assert.throws(
    () =>
      validateStripeTestCheckoutContract({
        session: { ...session, currency: 'eur' },
        lineItems: { data: [{ quantity: 1, currency: 'eur', amount_total: 100 }] },
        expectedUnitAmountCents: 100,
      }),
    /currency must be usd/,
  );
  assert.throws(
    () =>
      validateStripeTestCheckoutContract({
        session: { ...session, amount_total: 200 },
        lineItems: { data: [{ quantity: 1, currency: STRIPE_OFFCHAIN_CURRENCY, amount_total: 200 }] },
        expectedUnitAmountCents: 100,
      }),
    /unit amount does not match/,
  );
  assert.throws(
    () =>
      validateStripeTestCheckoutContract({
        session: { ...session, amount_subtotal: 200, amount_total: 200 },
        lineItems: {
          data: [
            {
              quantity: 1,
              currency: STRIPE_OFFCHAIN_CURRENCY,
              amount_subtotal: 200,
              amount_total: 200,
              price: { currency: STRIPE_OFFCHAIN_CURRENCY, unit_amount: 100 },
            },
          ],
        },
        expectedUnitAmountCents: 100,
      }),
    /subtotal amount does not match/,
  );
  assert.throws(
    () =>
      validateStripeTestCheckoutContract({
        session: { ...session, amount_subtotal: 100, amount_total: 90 },
        lineItems: {
          data: [
            {
              quantity: 1,
              currency: STRIPE_OFFCHAIN_CURRENCY,
              amount_subtotal: 100,
              amount_total: 90,
              price: { currency: STRIPE_OFFCHAIN_CURRENCY, unit_amount: 100 },
            },
          ],
        },
        expectedUnitAmountCents: 100,
      }),
    /total amount is less than expected subtotal/,
  );
  assert.throws(
    () =>
      validateStripeTestCheckoutContract({
        session: { ...session, automatic_tax: { enabled: false, status: 'complete' } },
        lineItems: {
          data: [
            {
              quantity: 1,
              currency: STRIPE_OFFCHAIN_CURRENCY,
              amount_subtotal: 100,
              amount_total: 100,
              price: { currency: STRIPE_OFFCHAIN_CURRENCY, unit_amount: 100 },
            },
          ],
        },
        expectedUnitAmountCents: 100,
      }),
    /automatic tax must be enabled/,
  );
});

test('buildStripeOffchainDeliveryOrderDocument shapes fulfillment UI fields', () => {
  const input = {
    dropId: 'little_swag_hoodies_devnet',
    deliveryId: 123,
    owner: 'anonymous:anon_uid_123',
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
    authSubject: 'anon_uid_123',
    receiptOwner: pubkey(90).toBase58(),
    metadataId: 16,
    variantKey: 'XL',
    orderHashHex: 'ab'.repeat(32),
    stripeSession: {
      id: 'cs_test_123',
      payment_intent: 'pi_123',
      customer: 'cus_123',
    },
    receiptTx: 'tx123',
    addressSnapshot: { encrypted: 'cipher', hint: 'B...US', countryCode: 'US' },
    stripeReceiptClaim: { code: 'ABCDEF-0123456789', status: 'unclaimed' },
  } satisfies StripeOffchainDeliveryOrderDocumentInput;
  const doc = buildStripeOffchainDeliveryOrderDocument(input);

  assert.equal(doc.source, 'stripe_offchain');
  assert.equal(doc.status, 'ready_to_ship');
  assert.equal(doc.owner, 'anonymous:anon_uid_123');
  assert.equal(doc.ownerKind, STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS);
  assert.equal(doc.authSubject, 'anon_uid_123');
  assert.equal(doc.receiptOwner, pubkey(90).toBase58());
  assert.equal(doc.quantity, 1);
  assert.deepEqual(doc.metadataIds, [16]);
  assert.equal(doc.metadataId, 16);
  assert.deepEqual(doc.items, [{ kind: 'box', refId: 16, variantKey: 'XL' }]);
  assert.equal(doc.receiptsMinted, 1);
  assert.deepEqual(doc.receiptTxs, ['tx123']);
  assert.deepEqual(doc.stripeReceiptClaim, {
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: 'ABCDEF-0123456789',
    boxId: 16,
    status: 'unclaimed',
  });
  assert.equal('stripeReceiptClaims' in doc, false);
  assert.deepEqual(doc.stripeReceiptClaimsByBoxId, {
    box_16: {
      namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
      code: 'ABCDEF-0123456789',
      boxId: 16,
      status: 'unclaimed',
    },
  });
  assert.equal(doc.stripeCheckoutSessionId, 'cs_test_123');
  assert.equal(doc.stripePaymentIntentId, 'pi_123');
  assert.deepEqual(buildStripeOffchainOrderMarkerDocument(input), {
    dropId: 'little_swag_hoodies_devnet',
    deliveryId: 123,
    owner: 'anonymous:anon_uid_123',
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
    authSubject: 'anon_uid_123',
    receiptOwner: pubkey(90).toBase58(),
    quantity: 1,
    firstMetadataId: 16,
    metadataIds: [16],
    metadataId: 16,
    variantKey: 'XL',
    offchainOrderHash: 'ab'.repeat(32),
    stripeCheckoutSessionId: 'cs_test_123',
    receiptTx: 'tx123',
    stripeReceiptClaimCodesByBoxId: { box_16: 'ABCDEF-0123456789' },
    stripeReceiptClaimCode: 'ABCDEF-0123456789',
  });
});

test('buildStripeOffchainDeliveryOrderDocument shapes multi-item receipt claims', () => {
  const input = {
    dropId: 'little_swag_hoodies_devnet',
    deliveryId: 456,
    owner: 'anonymous:anon_uid_456',
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
    authSubject: 'anon_uid_456',
    receiptOwner: pubkey(91).toBase58(),
    metadataIds: [16, 17, 18],
    variantKey: 'XL',
    orderHashHex: 'cd'.repeat(32),
    stripeSession: { id: 'cs_test_456' },
    receiptTx: 'tx456',
    addressSnapshot: { encrypted: 'cipher', hint: 'B...US', countryCode: 'US' },
    stripeReceiptClaims: [
      { code: 'ABCDEF-0123456789', boxId: 16, status: 'unclaimed' },
      { code: 'GHIJKL-0123456789', boxId: 17, status: 'unclaimed' },
      { code: 'MNOPQR-0123456789', boxId: 18, status: 'unclaimed' },
    ],
  } satisfies StripeOffchainDeliveryOrderDocumentInput;

  const doc = buildStripeOffchainDeliveryOrderDocument(input);
  assert.equal(doc.quantity, 3);
  assert.deepEqual(doc.metadataIds, [16, 17, 18]);
  assert.equal('metadataId' in doc, false);
  assert.deepEqual(doc.items, [
    { kind: 'box', refId: 16, variantKey: 'XL' },
    { kind: 'box', refId: 17, variantKey: 'XL' },
    { kind: 'box', refId: 18, variantKey: 'XL' },
  ]);
  assert.equal(doc.receiptsMinted, 3);
  assert.equal('stripeReceiptClaim' in doc, false);
  assert.equal('stripeReceiptClaims' in doc, false);
  assert.deepEqual(doc.stripeReceiptClaimsByBoxId, {
    box_16: { namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE, code: 'ABCDEF-0123456789', boxId: 16, status: 'unclaimed' },
    box_17: { namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE, code: 'GHIJKL-0123456789', boxId: 17, status: 'unclaimed' },
    box_18: { namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE, code: 'MNOPQR-0123456789', boxId: 18, status: 'unclaimed' },
  });

  const marker = buildStripeOffchainOrderMarkerDocument(input);
  assert.equal(marker.quantity, 3);
  assert.equal(marker.firstMetadataId, 16);
  assert.deepEqual(marker.metadataIds, [16, 17, 18]);
  assert.deepEqual(marker.stripeReceiptClaimCodesByBoxId, {
    box_16: 'ABCDEF-0123456789',
    box_17: 'GHIJKL-0123456789',
    box_18: 'MNOPQR-0123456789',
  });
  assert.equal('metadataId' in marker, false);
  assert.equal('stripeReceiptClaims' in marker, false);
  assert.equal('stripeReceiptClaimCode' in marker, false);
});

test('buildStripeOffchainDeliveryOrderDocument omits variant labels for pack checkouts', () => {
  const input = {
    dropId: 'card_nft_2',
    deliveryId: 789,
    owner: 'anonymous:anon_uid_pack',
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
    authSubject: 'anon_uid_pack',
    receiptOwner: pubkey(93).toBase58(),
    metadataIds: [1, 2],
    orderHashHex: '12'.repeat(32),
    stripeSession: { id: 'cs_test_pack' },
    receiptTx: 'txpack',
    addressSnapshot: { encrypted: 'cipher', hint: 'B...US', countryCode: 'US' },
    stripeReceiptClaims: [
      { code: 'PACKAA-0123456789', boxId: 1, status: 'unclaimed' },
      { code: 'PACKBB-0123456789', boxId: 2, status: 'unclaimed' },
    ],
  } satisfies StripeOffchainDeliveryOrderDocumentInput;

  const doc = buildStripeOffchainDeliveryOrderDocument(input);
  assert.deepEqual(doc.items, [
    { kind: 'box', refId: 1 },
    { kind: 'box', refId: 2 },
  ]);
  assert.equal('variantKey' in doc, false);

  const marker = buildStripeOffchainOrderMarkerDocument(input);
  assert.equal('variantKey' in marker, false);
  assert.deepEqual(marker.metadataIds, [1, 2]);
});

test('createOrGetStripeOffchainDeliveryOrder creates a Stripe receipt claim code atomically', async () => {
  const dropId = 'little_swag_hoodies_devnet';
  const orderHashHex = 'cd'.repeat(32);
  const markerRef = { path: `drops/${dropId}/offchainOrders/${orderHashHex}` };
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/cs_test_456` } as any;
  const creates: Array<{ ref: any; data: any }> = [];
  const updates: Array<{ ref: any; data: any }> = [];
  const db = {
    doc: (path: string) => {
      if (path === markerRef.path) return markerRef;
      if (path.startsWith(`drops/${dropId}/deliveryOrders/`)) return { path };
      if (path.startsWith('claimCodes/')) return { path };
      return { path };
    },
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          if (ref === markerRef) return { exists: false };
          if (ref === checkoutRef) {
            return {
              exists: true,
              data: () => ({
                status: STRIPE_CHECKOUT_STATUS.PROCESSING,
                processingAttemptId: 'attempt_current',
              }),
            };
          }
          if (String(ref?.path || '').startsWith('claimCodes/')) return { exists: false };
          throw new Error(`unexpected ref: ${ref?.path}`);
        },
        create: (ref: any, data: any) => {
          creates.push({ ref, data });
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  } as any;
  const result = await createOrGetStripeOffchainDeliveryOrder({
    db,
    checkoutRef,
    isAlreadyExistsError: () => false,
    processingAttemptId: 'attempt_current',
    fulfillmentCompletionFields: {
      fulfillmentCompletedBy: 'cloudflare_queue_v1',
      fulfillmentCompletedAt: stripeCheckoutFieldValue.serverTimestamp(),
    },
    order: {
      dropId,
      orderHashHex,
      owner: 'anonymous:anon_uid_456',
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
      authSubject: 'anon_uid_456',
      receiptOwner: pubkey(91).toBase58(),
      metadataId: 16,
      variantKey: 'XL',
      stripeSession: { id: 'cs_test_456' },
      receiptTx: 'tx456',
      addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
    },
  });

  assert.equal(result.checkoutStatus, 'fulfilled');
  assert.equal(creates.length, 3);
  const orderCreate = creates.find((entry) => String(entry.ref.path).startsWith(`drops/${dropId}/deliveryOrders/`));
  const markerCreate = creates.find((entry) => entry.ref === markerRef);
  const claimCreate = creates.find((entry) => String(entry.ref.path).startsWith('claimCodes/'));
  assert.ok(orderCreate);
  assert.ok(markerCreate);
  assert.ok(claimCreate);
  assert.match(claimCreate.data.code, /^[A-Z]{6}-\d{10}$/);
  assert.equal(claimCreate.data.authSubject, 'anon_uid_456');
  assert.equal(claimCreate.data.namespace, STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE);
  assert.equal(claimCreate.data.status, 'unclaimed');
  assert.equal(claimCreate.data.boxId, 16);
  assert.equal(claimCreate.data.deliveryId, result.deliveryId);
  assert.deepEqual(orderCreate.data.stripeReceiptClaim, {
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: claimCreate.data.code,
    boxId: 16,
    status: 'unclaimed',
  });
  assert.equal(markerCreate.data.stripeReceiptClaimCode, claimCreate.data.code);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.fulfillmentCompletedBy, 'cloudflare_queue_v1');
  assert.equal(updates[0].data.fulfillmentCompletedAt?.kind, 'server_timestamp');
});

test('createOrGetStripeOffchainDeliveryOrder creates one order with multiple claim codes', async () => {
  const dropId = 'little_swag_hoodies_devnet';
  const orderHashHex = 'ef'.repeat(32);
  const markerRef = { path: `drops/${dropId}/offchainOrders/${orderHashHex}` };
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/cs_test_multi` } as any;
  const creates: Array<{ ref: any; data: any }> = [];
  const updates: Array<{ ref: any; data: any }> = [];
  const db = {
    doc: (path: string) => {
      if (path === markerRef.path) return markerRef;
      if (path.startsWith(`drops/${dropId}/deliveryOrders/`)) return { path };
      if (path.startsWith('claimCodes/')) return { path };
      return { path };
    },
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          if (ref === markerRef) return { exists: false };
          if (ref === checkoutRef) {
            return {
              exists: true,
              data: () => ({
                status: STRIPE_CHECKOUT_STATUS.PROCESSING,
                processingAttemptId: 'attempt_current',
              }),
            };
          }
          if (String(ref?.path || '').startsWith('claimCodes/')) return { exists: false };
          throw new Error(`unexpected ref: ${ref?.path}`);
        },
        create: (ref: any, data: any) => {
          creates.push({ ref, data });
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  } as any;
  const result = await createOrGetStripeOffchainDeliveryOrder({
    db,
    checkoutRef,
    isAlreadyExistsError: () => false,
    processingAttemptId: 'attempt_current',
    order: {
      dropId,
      orderHashHex,
      owner: 'anonymous:anon_uid_multi',
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
      authSubject: 'anon_uid_multi',
      receiptOwner: pubkey(92).toBase58(),
      metadataId: 16,
      metadataIds: [16, 17, 18],
      variantKey: 'XL',
      stripeSession: { id: 'cs_test_multi' },
      receiptTx: 'txmulti',
      addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
    },
  });

  assert.equal(result.checkoutStatus, 'fulfilled');
  assert.equal(creates.length, 5);
  const orderCreate = creates.find((entry) => String(entry.ref.path).startsWith(`drops/${dropId}/deliveryOrders/`));
  const markerCreate = creates.find((entry) => entry.ref === markerRef);
  const claimCreates = creates.filter((entry) => String(entry.ref.path).startsWith('claimCodes/'));
  assert.ok(orderCreate);
  assert.ok(markerCreate);
  assert.equal(claimCreates.length, 3);
  assert.deepEqual(claimCreates.map((entry) => entry.data.boxId).sort((a, b) => a - b), [16, 17, 18]);
  assert.equal(new Set(claimCreates.map((entry) => entry.data.code)).size, 3);
  assert.deepEqual(orderCreate.data.items, [
    { kind: 'box', refId: 16, variantKey: 'XL' },
    { kind: 'box', refId: 17, variantKey: 'XL' },
    { kind: 'box', refId: 18, variantKey: 'XL' },
  ]);
  assert.equal(orderCreate.data.receiptsMinted, 3);
  assert.equal('stripeReceiptClaims' in orderCreate.data, false);
  assert.deepEqual(Object.keys(orderCreate.data.stripeReceiptClaimsByBoxId).sort(), ['box_16', 'box_17', 'box_18']);
  assert.equal(markerCreate.data.quantity, 3);
  assert.deepEqual(markerCreate.data.metadataIds, [16, 17, 18]);
  assert.deepEqual(Object.keys(markerCreate.data.stripeReceiptClaimCodesByBoxId).sort(), ['box_16', 'box_17', 'box_18']);
  assert.equal('stripeReceiptClaims' in markerCreate.data, false);
  assert.equal(updates.length, 1);
  assert.equal('fulfillmentCompletedBy' in updates[0].data, false);
  assert.equal('fulfillmentCompletedAt' in updates[0].data, false);
  assert.deepEqual(updates[0].data.metadataIds, [16, 17, 18]);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'metadataId'), true);
  assert.notEqual(updates[0].data.metadataId, 16);
  assert.equal(updates[0].data.quantity, 3);
});

test('createOrGetStripeOffchainDeliveryOrder keeps the D1 projection out of the critical commerce transaction', async () => {
  const dropId = 'card_nft_2';
  const orderHashHex = '12'.repeat(32);
  const markerRef = { path: `drops/${dropId}/offchainOrders/${orderHashHex}` };
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/cs_live_pack` } as any;
  const transactions: Array<{
    gets: string[];
    creates: Array<{ ref: any; data: any }>;
    updates: Array<{ ref: any; data: any }>;
  }> = [];
  const packStatusCalls: unknown[] = [];
  const db = {
    doc: (path: string) => {
      if (path === markerRef.path) return markerRef;
      if (path.startsWith(`drops/${dropId}/deliveryOrders/`)) return { path };
      if (path.startsWith('claimCodes/')) return { path };
      return { path };
    },
    runTransaction: async (fn: any) => {
      const ops = { gets: [] as string[], creates: [] as Array<{ ref: any; data: any }>, updates: [] as Array<{ ref: any; data: any }> };
      transactions.push(ops);
      return fn({
        get: async (ref: any) => {
          ops.gets.push(String(ref?.path || ''));
          if (ref === markerRef) return { exists: false };
          if (ref === checkoutRef) {
            return {
              exists: true,
              data: () => ({
                status: STRIPE_CHECKOUT_STATUS.PROCESSING,
                processingAttemptId: 'attempt_current',
              }),
            };
          }
          if (String(ref?.path || '').startsWith('claimCodes/')) return { exists: false };
          throw new Error(`unexpected ref: ${ref?.path}`);
        },
        create: (ref: any, data: any) => {
          ops.creates.push({ ref, data });
        },
        update: (ref: any, data: any) => {
          ops.updates.push({ ref, data });
        },
      });
    },
  } as any;

  const result = await createOrGetStripeOffchainDeliveryOrder({
    db,
    dropRuntime: { dropId, cluster: 'mainnet-beta', itemsPerBox: 3, maxSupply: 12_000 },
    checkoutRef,
    isAlreadyExistsError: () => false,
    processingAttemptId: 'attempt_current',
    countPackStatus: async (input) => {
      packStatusCalls.push(input);
    },
    order: {
      dropId,
      orderHashHex,
      owner: 'anonymous:anon_uid_pack',
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
      authSubject: 'anon_uid_pack',
      receiptOwner: pubkey(95).toBase58(),
      metadataId: 101,
      metadataIds: [101, 102],
      stripeSession: { id: 'cs_live_pack' },
      receiptTx: 'txpack',
      addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
    },
  });

  assert.equal(result.checkoutStatus, 'fulfilled');
  assert.equal(transactions.length, 1);
  const critical = transactions[0];
  assert.ok(critical);
  assert.equal(critical.gets.some((path) => path.includes('/meta/packStatus') || path.includes('/packStatusEvents/')), false);
  for (const write of [...critical.creates, ...critical.updates]) {
    assert.equal(Object.prototype.hasOwnProperty.call(write.data, 'packStatus'), false);
  }
  assert.equal(packStatusCalls.length, 1);
  const packStatusCall = packStatusCalls[0] as Record<string, unknown>;
  assert.equal(Number.isSafeInteger(packStatusCall.deliveryId), true);
  assert.equal(Number(packStatusCall.deliveryId) > 0, true);
  assert.deepEqual({ ...packStatusCall, deliveryId: undefined }, {
    dropRuntime: { dropId, cluster: 'mainnet-beta', itemsPerBox: 3, maxSupply: 12_000 },
    orderHashHex,
    quantity: 2,
    deliveryId: undefined,
    checkoutSessionId: 'cs_live_pack',
  });
});

test('createOrGetStripeOffchainDeliveryOrder reuses existing pack order markers on retry', async () => {
  const dropId = 'card_nft_2';
  const orderHashHex = '34'.repeat(32);
  const markerRef = { path: `drops/${dropId}/offchainOrders/${orderHashHex}` };
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/cs_test_pack_retry` } as any;
  const markerData = buildStripeOffchainOrderMarkerDocument({
    dropId,
    deliveryId: 789,
    owner: 'anonymous:anon_uid_pack',
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
    authSubject: 'anon_uid_pack',
    receiptOwner: pubkey(94).toBase58(),
    metadataIds: [1, 2],
    orderHashHex,
    stripeSession: { id: 'cs_test_pack_retry' },
    receiptTx: 'txpackretry',
    addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
    stripeReceiptClaims: [
      { code: 'PACKCC-0123456789', boxId: 1, status: 'unclaimed' },
      { code: 'PACKDD-0123456789', boxId: 2, status: 'unclaimed' },
    ],
  });
  const creates: Array<{ ref: any; data: any }> = [];
  const updates: Array<{ ref: any; data: any }> = [];
  const packStatusCalls: unknown[] = [];
  const db = {
    doc: (path: string) => {
      if (path === markerRef.path) return markerRef;
      if (path.startsWith(`drops/${dropId}/deliveryOrders/`)) return { path };
      if (path.startsWith('claimCodes/')) return { path };
      return { path };
    },
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          if (ref === markerRef) {
            return {
              exists: true,
              get: (fieldPath: string) => (markerData as any)[fieldPath],
            };
          }
          if (ref === checkoutRef) {
            return {
              exists: true,
              data: () => ({
                status: STRIPE_CHECKOUT_STATUS.PROCESSING,
                processingAttemptId: 'attempt_current',
              }),
            };
          }
          throw new Error(`unexpected ref: ${ref?.path}`);
        },
        create: (ref: any, data: any) => {
          creates.push({ ref, data });
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  } as any;

  const result = await createOrGetStripeOffchainDeliveryOrder({
    db,
    dropRuntime: { dropId, cluster: 'mainnet-beta', itemsPerBox: 3, maxSupply: 12_000 },
    checkoutRef,
    isAlreadyExistsError: () => false,
    processingAttemptId: 'attempt_current',
    countPackStatus: async (input) => {
      packStatusCalls.push(input);
    },
    order: {
      dropId,
      orderHashHex,
      owner: 'anonymous:anon_uid_pack',
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
      authSubject: 'anon_uid_pack',
      receiptOwner: pubkey(94).toBase58(),
      metadataIds: [1, 2],
      stripeSession: { id: 'cs_test_pack_retry' },
      receiptTx: 'txpackretry',
      addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
    },
  });

  assert.deepEqual(result, { deliveryId: 789, checkoutStatus: 'fulfilled' });
  assert.equal(creates.length, 0);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data.metadataIds, [1, 2]);
  assert.equal(updates[0].data.quantity, 2);
  assert.equal('variantKey' in markerData, false);
  assert.equal(packStatusCalls.length, 1);
  assert.equal((packStatusCalls[0] as { deliveryId: number }).deliveryId, 789);
  await assert.rejects(
    createOrGetStripeOffchainDeliveryOrder({
      db,
      dropRuntime: { dropId, cluster: 'mainnet-beta', itemsPerBox: 3, maxSupply: 12_000 },
      checkoutRef,
      isAlreadyExistsError: () => false,
      processingAttemptId: 'attempt_current',
      countPackStatus: async () => {
        throw new Error('d1 unavailable');
      },
      order: {
        dropId,
        orderHashHex,
        owner: 'anonymous:anon_uid_pack',
        ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
        authSubject: 'anon_uid_pack',
        receiptOwner: pubkey(94).toBase58(),
        metadataIds: [1, 2],
        stripeSession: { id: 'cs_test_pack_retry' },
        receiptTx: 'txpackretry',
        addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
      },
    }),
    StripeCheckoutPackStatusProjectionError,
  );
});

test('validateStripeCheckoutDocumentData accepts only the app-created session contract', () => {
  assert.deepEqual(buildStripeCheckoutSessionMetadata({
    dropId: 'little_swag_hoodies_devnet',
    identity: createStripeCheckoutIdentity('anon_uid_123'),
    variantKey: 'XL',
  }), {
    dropId: 'little_swag_hoodies_devnet',
    identitySchema: 'owner-v1',
    ...createStripeCheckoutIdentity('anon_uid_123'),
    fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
    placeholder: 'stripe_direct_delivery',
    quantity: '1',
    variantKey: 'XL',
  });
  assert.deepEqual(
    buildStripeCheckoutSessionMetadata({
      dropId: 'little_swag_hoodies_devnet',
      identity: createStripeCheckoutIdentity('anon_uid_123'),
      variantKey: 'XL',
      quantity: 3,
    }),
    {
      dropId: 'little_swag_hoodies_devnet',
      identitySchema: 'owner-v1',
      ...createStripeCheckoutIdentity('anon_uid_123'),
      fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
      placeholder: 'stripe_direct_delivery',
      quantity: '3',
      variantKey: 'XL',
    },
  );

  const checkout = buildStripeCheckoutDocument({
    dropId: 'little_swag_hoodies_devnet',
    sessionId: 'cs_test_123',
    ...createStripeCheckoutIdentity('anon_uid_123'),
    variantKey: 'XL',
    unitAmountCents: 100,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  });
  assert.deepEqual(checkout, {
    sessionId: 'cs_test_123',
    dropId: 'little_swag_hoodies_devnet',
    ...createStripeCheckoutIdentity('anon_uid_123'),
    variantKey: 'XL',
    quantity: STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    unitAmountCents: 100,
    fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
    livemode: false,
    status: STRIPE_CHECKOUT_STATUS.CREATED,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  });

  assert.deepEqual(
    validateStripeCheckoutDocumentData({
      dropId: 'little_swag_hoodies_devnet',
      variantKey: 'XL',
      sessionId: 'cs_test_123',
      checkout,
    }),
    {
      ...createStripeCheckoutIdentity('anon_uid_123'),
      variantKey: 'XL',
      quantity: 1,
      unitAmountCents: 100,
      livemode: false,
      status: STRIPE_CHECKOUT_STATUS.CREATED,
    },
  );
  const multiCheckout = buildStripeCheckoutDocument({
    dropId: 'little_swag_hoodies_devnet',
    sessionId: 'cs_test_multi',
    ...createStripeCheckoutIdentity('anon_uid_123'),
    variantKey: 'XL',
    quantity: 3,
    unitAmountCents: 100,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  });
  assert.deepEqual(
    validateStripeCheckoutDocumentData({
      dropId: 'little_swag_hoodies_devnet',
      variantKey: 'XL',
      sessionId: 'cs_test_multi',
      checkout: multiCheckout,
    }),
    {
      ...createStripeCheckoutIdentity('anon_uid_123'),
      variantKey: 'XL',
      quantity: 3,
      unitAmountCents: 100,
      livemode: false,
      status: STRIPE_CHECKOUT_STATUS.CREATED,
    },
  );
  const liveCheckout = buildStripeCheckoutDocument({
    dropId: 'little_swag_hoodies',
    sessionId: 'cs_live_123',
    ...createStripeCheckoutIdentity('anon_uid_123'),
    variantKey: 'XL',
    unitAmountCents: 24900,
    livemode: true,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  });
  assert.deepEqual(
    validateStripeCheckoutDocumentData({
      dropId: 'little_swag_hoodies',
      variantKey: 'XL',
      sessionId: 'cs_live_123',
      expectedLivemode: true,
      checkout: liveCheckout,
    }),
    {
      ...createStripeCheckoutIdentity('anon_uid_123'),
      variantKey: 'XL',
      quantity: 1,
      unitAmountCents: 24900,
      livemode: true,
      status: STRIPE_CHECKOUT_STATUS.CREATED,
    },
  );
  assert.equal(stripeCheckoutAnonymousOwnerId('anon_uid_123'), 'anonymous:anon_uid_123');
  const staffWallet = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
  const staffCheckout = buildStripeCheckoutDocument({
    dropId: 'little_swag_hoodies_devnet',
    sessionId: 'cs_test_staff',
    ...createStripeCheckoutIdentity(staffWallet, staffWallet),
    variantKey: 'XL',
    unitAmountCents: 100,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  });
  assert.equal(staffCheckout.owner, staffWallet);
  assert.equal(staffCheckout.ownerKind, STRIPE_CHECKOUT_OWNER_KIND_WALLET);
  assert.equal(Object.hasOwn(staffCheckout, 'authSubject'), false);
  assert.equal(validateStripeCheckoutDocumentData({
    dropId: 'little_swag_hoodies_devnet',
    variantKey: 'XL',
    sessionId: 'cs_test_staff',
    checkout: staffCheckout,
  }).owner, staffWallet);
  assert.throws(
    () =>
      validateStripeCheckoutDocumentData({
        dropId: 'little_swag_hoodies_devnet',
        variantKey: 'L',
        sessionId: 'cs_test_123',
        checkout,
      }),
    /invalid variant key/,
  );
  assert.throws(
    () =>
      validateStripeCheckoutDocumentData({
        dropId: 'little_swag_hoodies_devnet',
        variantKey: 'XL',
        sessionId: 'cs_test_123',
        checkout: { ...checkout, livemode: true },
      }),
    /invalid mode/,
  );
  assert.throws(
    () =>
      validateStripeCheckoutDocumentData({
        dropId: 'little_swag_hoodies_devnet',
        variantKey: 'XL',
        sessionId: 'cs_test_123',
        checkout: { ...checkout, unitAmountCents: 100.9 },
      }),
    /invalid unit amount/,
  );
});

test('Stripe checkout contract accepts pack documents without variantKey up to max quantity', () => {
  assert.equal(STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY, 15);
  assert.equal(normalizeStripeCheckoutQuantity(15), 15);
  assert.throws(() => normalizeStripeCheckoutQuantity(16), /1 to 15/);
  assert.deepEqual(
    buildStripeCheckoutSessionMetadata({
      dropId: 'card_nft_2',
      identity: createStripeCheckoutIdentity('anon_uid_pack'),
      quantity: STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY,
    }),
    {
      dropId: 'card_nft_2',
      identitySchema: 'owner-v1',
      ...createStripeCheckoutIdentity('anon_uid_pack'),
      fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
      placeholder: 'stripe_direct_delivery',
      quantity: '15',
    },
  );
  assert.throws(
    () =>
      buildStripeCheckoutSessionMetadata({
        dropId: 'card_nft_2',
        identity: createStripeCheckoutIdentity('anon_uid_pack'),
        quantity: 16,
      }),
    /1 to 15/,
  );

  const checkout = buildStripeCheckoutDocument({
    dropId: 'card_nft_2',
    sessionId: 'cs_test_pack',
    ...createStripeCheckoutIdentity('anon_uid_pack'),
    quantity: 15,
    unitAmountCents: 100,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  });
  assert.equal('variantKey' in checkout, false);
  assert.deepEqual(
    validateStripeCheckoutDocumentData({
      dropId: 'card_nft_2',
      sessionId: 'cs_test_pack',
      checkout,
    }),
    {
      ...createStripeCheckoutIdentity('anon_uid_pack'),
      quantity: 15,
      unitAmountCents: 100,
      livemode: false,
      status: STRIPE_CHECKOUT_STATUS.CREATED,
    },
  );
  assert.throws(
    () =>
      validateStripeCheckoutDocumentData({
        dropId: 'card_nft_2',
        variantKey: 'XL',
        sessionId: 'cs_test_pack',
        checkout,
      }),
    /invalid variant key/,
  );
});

test('stripeTestApiKey uses the first configured test key only', () => {
  assert.equal(stripeTestApiKey(['rk_test_restricted', 'sk_test_secret']), 'rk_test_restricted');
  assert.equal(stripeTestApiKey(['', 'sk_live_ignored', 'sk_test_secret']), 'sk_test_secret');
  assert.throws(() => stripeTestApiKey(['', 'sk_live_wrong']), /Stripe test key is not configured/);
});

test('stripeApiKeyForMode selects only keys matching the requested mode', () => {
  assert.equal(stripeApiKeyForMode(['sk_live_ignored', 'rk_test_restricted'], 'test'), 'rk_test_restricted');
  assert.equal(stripeApiKeyForMode(['sk_test_ignored', 'rk_live_restricted'], 'live'), 'rk_live_restricted');
  assert.throws(() => stripeApiKeyForMode(['sk_test_wrong'], 'live'), /Stripe live key is not configured/);
  assert.throws(() => stripeApiKeyForMode(['sk_live_wrong'], 'test'), /Stripe test key is not configured/);
});

test('stripeApiKeysForMode preserves matching fallback keys', () => {
  assert.deepEqual(stripeApiKeysForMode(['rk_live_primary', 'sk_live_fallback', 'rk_live_primary'], 'live'), [
    'rk_live_primary',
    'sk_live_fallback',
  ]);
  assert.deepEqual(stripeApiKeysForMode(['sk_live_ignored', 'rk_test_restricted', 'sk_test_fallback'], 'test'), [
    'rk_test_restricted',
    'sk_test_fallback',
  ]);
});

test('stripeApiModeForCluster preserves supported modes and exact unsupported-cluster error', () => {
  assert.equal(stripeApiModeForCluster('devnet'), 'test');
  assert.equal(stripeApiModeForCluster('mainnet-beta'), 'live');
  assert.throws(
    () => stripeApiModeForCluster('testnet'),
    (error: any) => {
      assert.equal(error?.code, 'failed-precondition');
      assert.equal(error?.message, 'Stripe checkout is only enabled for devnet and mainnet drops.');
      return true;
    },
  );
});

test('stripeCheckoutKindForDrop accepts size variants, standard packs, and explicit receipt-only drops', () => {
  assert.equal(
    stripeCheckoutKindForDrop({
      dropId: 'little_swag_hoodies_devnet',
      itemsPerBox: 0,
      config: {
        mintSelection: { kind: 'size', options: [{ key: 'L' }, { key: 'XL' }] },
      },
    } as any),
    'size_variant',
  );
  assert.equal(
    stripeCheckoutKindForDrop({
      dropId: 'card_nft_2',
      itemsPerBox: 5,
      config: {},
    } as any),
    'standard_pack',
  );
  assert.equal(
    stripeCheckoutKindForDrop({
      dropId: 'card_nft_binder_devnet',
      itemsPerBox: 0,
      config: { salesMode: 'stripe_receipt_only' },
    } as any),
    'receipt_only',
  );
  assert.throws(
    () =>
      stripeCheckoutKindForDrop({
        dropId: 'direct_delivery_without_size',
        itemsPerBox: 0,
        config: {},
      } as any),
    /receipt-only drops/,
  );
  assert.throws(
    () =>
      stripeCheckoutKindForDrop({
        dropId: 'variant_pack',
        itemsPerBox: 5,
        config: {
          mintSelection: { kind: 'size', options: [{ key: 'L' }] },
        },
      } as any),
    /receipt-only drops/,
  );
});

test('stripeCheckoutProductName uses a singular, non-duplicated item label', () => {
  assert.equal(
    stripeCheckoutProductName(
      {
        dropId: 'card_nft_binder',
        collectionName: 'Mons Shop Receipts',
        displayName: 'Card NFT Binder',
        namePrefix: 'binder',
      } as any,
      undefined,
      'live',
    ),
    'Card NFT Binder',
  );
  assert.equal(
    stripeCheckoutProductName(
      {
        dropId: 'little_swag_hoodies',
        collectionName: 'Little Swag Hoodies',
        namePrefix: 'hoodie',
      } as any,
      'L',
      'live',
    ),
    'Little Swag Hoodie L',
  );
  assert.equal(
    stripeCheckoutProductName(
      {
        dropId: 'little_swag_hoodies_devnet',
        collectionName: 'Little Swag Hoodies',
        namePrefix: 'hoodie',
      } as any,
      'XL',
      'test',
    ),
    'test Little Swag Hoodie XL',
  );
});

test('stripeCheckoutUnitAmountCentsForDrop separates devnet test and mainnet live pricing', () => {
  assert.equal(stripeCheckoutUnitAmountCentsForDrop({ solanaCluster: 'devnet' } as any), 100);
  assert.equal(stripeCheckoutUnitAmountCentsForDrop({ solanaCluster: 'devnet' } as any, '250'), 250);
  assert.equal(stripeCheckoutUnitAmountCentsForDrop({ solanaCluster: 'devnet' } as any, '250.9'), 250);
  assert.equal(
    stripeCheckoutUnitAmountCentsForDrop({ solanaCluster: 'mainnet-beta', stripeLiveUnitAmountCents: 24900 } as any),
    24900,
  );
  assert.throws(
    () => stripeCheckoutUnitAmountCentsForDrop({ solanaCluster: 'mainnet-beta' } as any),
    /Stripe live unit amount is not configured/,
  );
  assert.throws(
    () => stripeCheckoutUnitAmountCentsForDrop({ solanaCluster: 'mainnet-beta', stripeLiveUnitAmountCents: 49 } as any),
    /Stripe unit amount must be an integer from 50 to 99999999/,
  );
  assert.throws(
    () => stripeCheckoutUnitAmountCentsForDrop({ solanaCluster: 'mainnet-beta', stripeLiveUnitAmountCents: 100_000_000 } as any),
    /Stripe unit amount must be an integer from 50 to 99999999/,
  );
});

test('stripeCheckoutProductTaxCodeForDrop requires explicit checkout enablement and product tax code', () => {
  assert.equal(
    stripeCheckoutProductTaxCodeForDrop({
      stripeCheckoutEnabled: true,
      stripeProductTaxCode: 'txcd_30011000',
    } as any),
    'txcd_30011000',
  );
  assert.throws(
    () =>
      stripeCheckoutProductTaxCodeForDrop({
        stripeProductTaxCode: 'txcd_30011000',
      } as any),
    /not enabled/,
  );
  assert.throws(
    () =>
      stripeCheckoutProductTaxCodeForDrop({
        stripeCheckoutEnabled: true,
      } as any),
    /product tax code is not configured/,
  );
  assert.throws(
    () =>
      stripeCheckoutProductTaxCodeForDrop({
        stripeCheckoutEnabled: true,
        stripeProductTaxCode: 'clothing',
      } as any),
    /product tax code is invalid/,
  );
});

test('startStripeCheckoutFulfillmentDocument processes only pending checkout documents', async () => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const variantKey = 'XL';
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/${sessionId}` } as any;
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutSnap = {
    exists: true,
    data: () =>
      ({
        ...buildStripeCheckoutDocument({
          dropId,
          sessionId,
          ...createStripeCheckoutIdentity('anon_uid_123'),
          variantKey,
          unitAmountCents: 100,
          createdAt: 'createdAt',
          updatedAt: 'updatedAt',
        }),
        status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      }),
  };
  const tx = {
    get: async (ref: any) => {
      assert.equal(ref, checkoutRef);
      return checkoutSnap;
    },
    update: (ref: any, data: any) => {
      updates.push({ ref, data });
    },
  };
  checkoutRef.store = { runTransaction: async (fn: any) => fn(tx) };

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, checkoutRef });

  assert.equal(started.started, true);
  const processingAttemptId = started.started ? started.processingAttemptId : '';
  assert.match(processingAttemptId, /^[0-9a-z]+:[0-9a-z]+$/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ref, checkoutRef);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
  assert.equal(updates[0].data.processingAttemptId, processingAttemptId);
});

test('startStripeCheckoutFulfillmentDocument starts pack documents without variantKey', async () => {
  const dropId = 'card_nft_2';
  const sessionId = 'cs_test_pack';
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/${sessionId}` } as any;
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutSnap = {
    exists: true,
    data: () => ({
      ...buildStripeCheckoutDocument({
        dropId,
        sessionId,
        ...createStripeCheckoutIdentity('anon_uid_pack'),
        quantity: 2,
        unitAmountCents: 100,
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      }),
      status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
    }),
  };
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return checkoutSnap;
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  };

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, checkoutRef });

  assert.equal(started.started, true);
  if (started.started) {
    assert.equal('variantKey' in started, false);
    assert.equal(started.checkout.quantity, 2);
  }
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
});

test('startStripeCheckoutFulfillmentDocument skips active processing leases', async () => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const variantKey = 'XL';
  const nowMs = 1_700_000_000_000;
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/${sessionId}` } as any;
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutSnap = {
    exists: true,
    data: () => ({
      ...buildStripeCheckoutDocument({
        dropId,
        sessionId,
        ...createStripeCheckoutIdentity('anon_uid_123'),
        variantKey,
        unitAmountCents: 100,
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      }),
      status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      processingLeaseExpiresAt: timestampLike(nowMs + 1_000),
      processingStartedAt: timestampLike(nowMs - STRIPE_CHECKOUT_PROCESSING_LEASE_MS - 1_000),
    }),
  };
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return checkoutSnap;
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  };

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, checkoutRef, nowMs });

  assert.deepEqual(started, { started: false, reason: 'processing' });
  assert.equal(updates.length, 0);
});

test('startStripeCheckoutFulfillmentDocument reclaims expired processing leases', async () => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const variantKey = 'XL';
  const nowMs = 1_700_000_000_000;
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/${sessionId}` } as any;
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutSnap = {
    exists: true,
    data: () => ({
      ...buildStripeCheckoutDocument({
        dropId,
        sessionId,
        ...createStripeCheckoutIdentity('anon_uid_123'),
        variantKey,
        unitAmountCents: 100,
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      }),
      status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      processingLeaseExpiresAt: timestampLike(nowMs - 1),
    }),
  };
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return checkoutSnap;
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  };

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, checkoutRef, nowMs });

  assert.equal(started.started, true);
  const processingAttemptId = started.started ? started.processingAttemptId : '';
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
  assert.equal(updates[0].data.processingAttemptId, processingAttemptId);
  assert.equal(typeof updates[0].data.processingLeaseExpiresAt?.toMillis, 'function');
});

test('startStripeCheckoutFulfillmentDocument uses legacy processingStartedAt as stale fallback', async () => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const variantKey = 'XL';
  const nowMs = 1_700_000_000_000;
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/${sessionId}` } as any;
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutData = {
    ...buildStripeCheckoutDocument({
      dropId,
      sessionId,
      ...createStripeCheckoutIdentity('anon_uid_123'),
      variantKey,
      unitAmountCents: 100,
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    }),
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingStartedAt: timestampLike(nowMs - STRIPE_CHECKOUT_PROCESSING_LEASE_MS - 1),
  };
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return { exists: true, data: () => checkoutData };
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  };

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, checkoutRef, nowMs });

  assert.equal(started.started, true);
  const processingAttemptId = started.started ? started.processingAttemptId : '';
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
  assert.equal(updates[0].data.processingAttemptId, processingAttemptId);
});

test('markStripeCheckoutFulfillmentFailed leaves an already-fulfilled checkout intact', async () => {
  const sets: Array<{ ref: any; data: any; options: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return {
            exists: true,
            data: () => ({
              status: STRIPE_CHECKOUT_STATUS.FULFILLED,
              deliveryId: 123,
              metadataId: 16,
              receiptTx: 'tx123',
            }),
          };
        },
        set: (ref: any, data: any, options: any) => {
          sets.push({ ref, data, options });
        },
      }),
  };

  const result = await markStripeCheckoutFulfillmentFailed(checkoutRef, new Error('late failure'), {
    summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
    sessionIdentity: { dropId: 'little_swag_hoodies_devnet', sessionId: 'cs_test_123' },
  });

  assert.deepEqual(result, { status: 'already_fulfilled' });
  assert.equal(sets.length, 0);
});

test('retryable fulfillment failures release the current lease back to pending', async () => {
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.store = {
    runTransaction: async (fn: any) => fn({
      get: async () => ({
        exists: true,
        data: () => ({ status: STRIPE_CHECKOUT_STATUS.PROCESSING, processingAttemptId: 'attempt_current' }),
      }),
      update: (ref: any, data: any) => updates.push({ ref, data }),
    }),
  };

  const result = await releaseStripeCheckoutFulfillmentForRetry(
    checkoutRef,
    new Error('provider unavailable'),
    {
      summarizeError: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
      processingAttemptId: 'attempt_current',
    },
  );

  assert.deepEqual(result, { status: 'released' });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING);
  assert.equal(updates[0].data.lastRetryableFulfillmentError.message, 'provider unavailable');
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'processingAttemptId'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'processingLeaseExpiresAt'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'processingStartedAt'), true);
});

test('final Queue attempts persist retryable fulfillment failures for manual review', async () => {
  const sets: Array<{ data: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  let transactionCalls = 0;
  checkoutRef.store = {
    runTransaction: async (fn: any) => {
      transactionCalls += 1;
      if (transactionCalls === 1) {
        return fn({
          get: async () => {
            throw Object.assign(new Error('provider unavailable'), { code: 'unavailable' });
          },
        });
      }
      return fn({
        get: async () => ({
          exists: true,
          data: () => ({ status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING }),
        }),
        set: (_ref: any, data: any) => sets.push({ data }),
      });
    },
  };
  const result = await processStripeCheckoutFulfillmentDocument({
    db: checkoutRef.store,
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_final_attempt',
    checkoutRef,
    apiKeys: [],
    deps: {
      getDropRuntime: () => ({ cluster: 'devnet' }),
      summarizeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
    } as any,
    treatRetryableFailureAsTerminal: true,
  });
  assert.equal(result.status, 'failed');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED);
  assert.equal(sets[0].data.manualRefundReviewRequired, true);
});

test('already-fulfilled Queue retries repair pack status idempotently', async () => {
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.store = {
    runTransaction: async (operation: any) => operation({
      get: async () => ({
        exists: true,
        data: () => ({ status: STRIPE_CHECKOUT_STATUS.FULFILLED, deliveryId: 123 }),
      }),
    }),
  };
  const repairs: unknown[] = [];
  const result = await processStripeCheckoutFulfillmentDocument({
    db: checkoutRef.store,
    dropId: 'card_nft_2',
    sessionId: 'cs_test_repair',
    checkoutRef,
    apiKeys: [],
    deps: {
      getDropRuntime: () => ({ dropId: 'card_nft_2', cluster: 'mainnet-beta' }),
      repairPackStatus: async (input: unknown) => {
        repairs.push(input);
      },
    } as any,
  });
  assert.deepEqual(result, {
    status: 'ignored',
    dropId: 'card_nft_2',
    sessionId: 'cs_test_repair',
    reason: 'already_fulfilled',
  });
  assert.equal(repairs.length, 1);
});

test('markStripeCheckoutFulfillmentFailed writes manual-review failure', async () => {
  const sets: Array<{ ref: any; data: any; options: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return {
            exists: true,
            data: () => ({ status: STRIPE_CHECKOUT_STATUS.PROCESSING, processingAttemptId: 'attempt_current' }),
          };
        },
        set: (ref: any, data: any, options: any) => {
          sets.push({ ref, data, options });
        },
      }),
  };

  const result = await markStripeCheckoutFulfillmentFailed(checkoutRef, new Error('processing failure'), {
    summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
    sessionIdentity: { dropId: 'little_swag_hoodies_devnet', sessionId: 'cs_test_123' },
    processingAttemptId: 'attempt_current',
  });

  assert.deepEqual(result, { status: 'failed' });
  assert.equal(sets.length, 1);
  assert.equal(sets[0].ref, checkoutRef);
  assert.equal(sets[0].data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED);
  assert.equal(sets[0].data.manualRefundReviewRequired, true);
  assert.equal(Object.prototype.hasOwnProperty.call(sets[0].data, 'processingAttemptId'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(sets[0].data, 'processingLeaseExpiresAt'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(sets[0].data, 'nextFulfillmentRetryAt'), true);
  assert.deepEqual(sets[0].options, { merge: true });
});

test('markStripeCheckoutFulfillmentFailed ignores stale processing attempts', async () => {
  const sets: Array<{ ref: any; data: any; options: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return {
            exists: true,
            data: () => ({ status: STRIPE_CHECKOUT_STATUS.PROCESSING, processingAttemptId: 'attempt_new' }),
          };
        },
        set: (ref: any, data: any, options: any) => {
          sets.push({ ref, data, options });
        },
      }),
  };

  const result = await markStripeCheckoutFulfillmentFailed(checkoutRef, new Error('late failure'), {
    summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
    sessionIdentity: { dropId: 'little_swag_hoodies_devnet', sessionId: 'cs_test_123' },
    processingAttemptId: 'attempt_old',
  });

  assert.deepEqual(result, { status: 'stale_processing_attempt' });
  assert.equal(sets.length, 0);
});

test('markStripeCheckoutFulfillmentFulfilled writes only the current processing attempt', async () => {
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return {
            exists: true,
            data: () => ({ status: STRIPE_CHECKOUT_STATUS.PROCESSING, processingAttemptId: 'attempt_current' }),
          };
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  };

  const result = await markStripeCheckoutFulfillmentFulfilled(checkoutRef, {
    deliveryId: 123,
    metadataId: 16,
    receiptTx: 'tx123',
    processingAttemptId: 'attempt_current',
    fulfillmentCompletionFields: {
      fulfillmentCompletedBy: 'cloudflare_queue_v1',
      fulfillmentCompletedAt: stripeCheckoutFieldValue.serverTimestamp(),
    },
  });

  assert.deepEqual(result, { status: 'fulfilled' });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ref, checkoutRef);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.FULFILLED);
  assert.equal(updates[0].data.deliveryId, 123);
  assert.equal(updates[0].data.fulfillmentCompletedBy, 'cloudflare_queue_v1');
  assert.equal(updates[0].data.fulfillmentCompletedAt?.kind, 'server_timestamp');
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'processingAttemptId'), true);
});

test('markStripeCheckoutFulfillmentFulfilled clears singular metadataId for multi-item checkout docs', async () => {
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return {
            exists: true,
            data: () => ({ status: STRIPE_CHECKOUT_STATUS.PROCESSING, processingAttemptId: 'attempt_current' }),
          };
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  };

  const result = await markStripeCheckoutFulfillmentFulfilled(checkoutRef, {
    deliveryId: 123,
    metadataIds: [16, 17, 18],
    receiptTx: 'tx123',
    processingAttemptId: 'attempt_current',
  });

  assert.deepEqual(result, { status: 'fulfilled' });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data.metadataIds, [16, 17, 18]);
  assert.equal('fulfillmentCompletedBy' in updates[0].data, false);
  assert.equal('fulfillmentCompletedAt' in updates[0].data, false);
  assert.equal(updates[0].data.quantity, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'metadataId'), true);
  assert.notEqual(updates[0].data.metadataId, 16);
});

test('markStripeCheckoutFulfillmentFulfilled ignores stale processing attempts', async () => {
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.store = {
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          assert.equal(ref, checkoutRef);
          return {
            exists: true,
            data: () => ({ status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED, processingAttemptId: 'attempt_new' }),
          };
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  };

  const result = await markStripeCheckoutFulfillmentFulfilled(checkoutRef, {
    deliveryId: 123,
    metadataId: 16,
    receiptTx: 'tx123',
    processingAttemptId: 'attempt_old',
  });

  assert.deepEqual(result, { status: 'stale_processing_attempt' });
  assert.equal(updates.length, 0);
});

test('createOrGetStripeOffchainDeliveryOrder does not create documents for stale processing attempts', async () => {
  const dropId = 'little_swag_hoodies_devnet';
  const orderHashHex = 'ab'.repeat(32);
  const markerRef = { path: `drops/${dropId}/offchainOrders/${orderHashHex}` };
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/cs_test_123` } as any;
  const creates: Array<{ ref: any; data: any }> = [];
  const updates: Array<{ ref: any; data: any }> = [];
  const db = {
    doc: (path: string) => {
      if (path === markerRef.path) return markerRef;
      return { path };
    },
    runTransaction: async (fn: any) =>
      fn({
        get: async (ref: any) => {
          if (ref === markerRef) return { exists: false };
          if (ref === checkoutRef) {
            return {
              exists: true,
              data: () => ({
                status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
                processingAttemptId: 'attempt_new',
              }),
            };
          }
          throw new Error(`unexpected ref: ${ref?.path}`);
        },
        create: (ref: any, data: any) => {
          creates.push({ ref, data });
        },
        update: (ref: any, data: any) => {
          updates.push({ ref, data });
        },
      }),
  } as any;

  const result = await createOrGetStripeOffchainDeliveryOrder({
    db,
    checkoutRef,
    isAlreadyExistsError: () => false,
    processingAttemptId: 'attempt_old',
    order: {
      dropId,
      orderHashHex,
      owner: 'anonymous:anon_uid_123',
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
      authSubject: 'anon_uid_123',
      receiptOwner: pubkey(90).toBase58(),
      metadataId: 16,
      variantKey: 'XL',
      stripeSession: { id: 'cs_test_123' },
      receiptTx: 'tx123',
      addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
    },
  });

  assert.deepEqual(result, { checkoutStatus: 'stale_processing_attempt' });
  assert.equal(creates.length, 0);
  assert.equal(updates.length, 0);
});

test('isRetryableStripeCheckoutFulfillmentError classifies transient errors only', () => {
  assert.equal(isRetryableStripeCheckoutFulfillmentError(new Stripe.errors.StripeConnectionError({
    message: 'An error occurred with our connection to Stripe.',
  })), true);
  assert.equal(isRetryableStripeCheckoutFulfillmentError(Object.assign(new Error('rpc timeout'), { code: 'unavailable' })), true);
  assert.equal(isRetryableStripeCheckoutFulfillmentError(Object.assign(new Error('rate limited'), { statusCode: 429 })), true);
  assert.equal(isRetryableStripeCheckoutFulfillmentError(Object.assign(new Error('write conflict'), { status: 'ABORTED' })), true);
  assert.equal(isRetryableStripeCheckoutFulfillmentError(Object.assign(new Error('create conflict'), { status: 'ALREADY_EXISTS' })), false);
  assert.equal(isRetryableStripeCheckoutFulfillmentError(Object.assign(new Error('precondition'), { status: 'FAILED_PRECONDITION' })), false);
  assert.equal(isRetryableStripeCheckoutFulfillmentError(new Error('fetch failed: socket hang up')), true);
  assert.equal(
    isRetryableStripeCheckoutFulfillmentError(Object.assign(new Error('contract mismatch'), { code: 'failed-precondition' })),
    false,
  );
  assert.equal(isRetryableStripeCheckoutFulfillmentError(Object.assign(new Error('bad request'), { statusCode: 400 })), false);
});

test('runStripeCheckoutFulfillmentWithRetry retries a retryable failure once', async () => {
  const updates: any[] = [];
  const checkoutRef = {
    update: async (data: any) => {
      updates.push(data);
    },
  } as any;
  let attempts = 0;

  const result = await runStripeCheckoutFulfillmentWithRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('temporary rpc timeout'), { code: 'deadline-exceeded' });
      }
      return 'fulfilled';
    },
    {
      checkoutRef,
      summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
      retryDelayMs: 0,
    },
  );

  assert.equal(result, 'fulfilled');
  assert.equal(attempts, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].lastRetryableFulfillmentAttempt, 1);
});

test('runStripeCheckoutFulfillmentWithRetry does not retry deterministic failures', async () => {
  const updates: any[] = [];
  const checkoutRef = {
    update: async (data: any) => {
      updates.push(data);
    },
  } as any;
  let attempts = 0;

  await assert.rejects(
    () =>
      runStripeCheckoutFulfillmentWithRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('Stripe checkout unit amount does not match expected amount'), {
            code: 'failed-precondition',
          });
        },
        {
          checkoutRef,
          summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
          retryDelayMs: 0,
        },
      ),
    /unit amount/,
  );

  assert.equal(attempts, 1);
  assert.equal(updates.length, 0);
});

test('runStripeCheckoutFulfillmentWithRetry stops when processing attempt is stale', async () => {
  const updates: any[] = [];
  const checkoutRef = {
    update: async (data: any) => {
      updates.push(data);
    },
    store: {
      runTransaction: async (fn: any) =>
        fn({
          get: async (ref: any) => {
            assert.equal(ref, checkoutRef);
            return {
              exists: true,
              data: () => ({ status: STRIPE_CHECKOUT_STATUS.PROCESSING, processingAttemptId: 'attempt_new' }),
            };
          },
          update: (ref: any, data: any) => {
            updates.push({ ref, data });
          },
        }),
    },
  } as any;
  let attempts = 0;

  await assert.rejects(
    () =>
      runStripeCheckoutFulfillmentWithRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('temporary rpc timeout'), { code: 'deadline-exceeded' });
        },
        {
          checkoutRef,
          summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
          retryDelayMs: 0,
          processingAttemptId: 'attempt_old',
        },
      ),
    /no longer owns the processing lease/,
  );

  assert.equal(attempts, 1);
  assert.equal(updates.length, 0);
});

test('runStripeCheckoutFulfillmentWithRetry fails closed when ownership cannot be verified', async () => {
  const checkoutRef = {
    store: {
      runTransaction: async () => {
        throw new Error('commerce store unavailable');
      },
    },
  } as any;
  let attempts = 0;

  await assert.rejects(
    () =>
      runStripeCheckoutFulfillmentWithRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('temporary rpc timeout'), { code: 'deadline-exceeded' });
        },
        {
          checkoutRef,
          summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
          retryDelayMs: 0,
          processingAttemptId: 'attempt_current',
        },
      ),
    /Could not verify Stripe checkout fulfillment processing lease ownership/,
  );

  assert.equal(attempts, 1);
});

test('shouldProcessStripeCheckoutFulfillmentWrite accepts only created/failed to pending transitions', () => {
  assert.equal(
    shouldProcessStripeCheckoutFulfillmentWrite({
      beforeStatus: STRIPE_CHECKOUT_STATUS.CREATED,
      afterStatus: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
    }),
    true,
  );
  assert.equal(
    shouldProcessStripeCheckoutFulfillmentWrite({
      beforeStatus: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
      afterStatus: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
    }),
    true,
  );
  assert.equal(
    shouldProcessStripeCheckoutFulfillmentWrite({
      beforeStatus: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      afterStatus: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
    }),
    false,
  );
  assert.equal(
    shouldProcessStripeCheckoutFulfillmentWrite({
      beforeStatus: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
      afterStatus: STRIPE_CHECKOUT_STATUS.PROCESSING,
    }),
    false,
  );
  assert.equal(
    shouldProcessStripeCheckoutFulfillmentWrite({
      beforeStatus: undefined,
      afterStatus: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
    }),
    false,
  );
  assert.equal(
    shouldProcessStripeCheckoutFulfillmentWrite({
      beforeStatus: STRIPE_CHECKOUT_STATUS.PROCESSING,
      afterStatus: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
    }),
    false,
  );
});

test('checkout session core rejects bad returnUrl before config fetch', async () => {
  let configFetches = 0;
  await assert.rejects(
    () => createStripeCheckoutSessionCore({
      identity: createStripeCheckoutIdentity('anon_uid_123'),
      body: {
        dropId: 'little_swag_hoodies_devnet',
        variantKey: 'XL',
        returnUrl: 'https://evil.example/drop',
      },
    }, {
      getDrop: () => undefined,
      loadOnchainConfig: async () => {
        configFetches += 1;
        throw new Error('unexpected config fetch');
      },
      requireFulfillmentPrerequisites: () => undefined,
      createProviderSession: async () => { throw new Error('unexpected provider call'); },
      persistCheckout: async () => undefined,
    }),
    /returnUrl origin mismatch/,
  );
  assert.equal(configFetches, 0);
});

test('checkout session core rejects disabled drops before config fetch', async () => {
  let configFetches = 0;
  await assert.rejects(
    () => createStripeCheckoutSessionCore({
      identity: createStripeCheckoutIdentity('anon_uid_123'),
      body: { dropId: 'little_swag_hoodies', variantKey: 'XL', returnUrl: 'https://mons.shop/drop' },
    }, {
      getDrop: (dropId) => ({
        dropId,
        solanaCluster: 'mainnet-beta',
        dropFamily: 'little_swag_hoodies',
        collectionName: 'Little Swag Hoodies',
        itemsPerBox: 0,
        namePrefix: 'hoodie',
        mintSelection: { kind: 'size', options: [
          { key: 'L', label: 'L', startId: 1, endId: 10 },
          { key: 'XL', label: 'XL', startId: 11, endId: 20 },
          { key: '2XL', label: '2XL', startId: 21, endId: 30 },
        ] },
        boxMinterProgramId: pubkey(1).toBase58(),
        boxMinterConfigPda: pubkey(2).toBase58(),
        collectionMint: pubkey(3).toBase58(),
        receiptsMerkleTree: pubkey(4).toBase58(),
      }),
      loadOnchainConfig: async () => {
        configFetches += 1;
        throw new Error('unexpected config fetch');
      },
      requireFulfillmentPrerequisites: () => undefined,
      createProviderSession: async () => { throw new Error('unexpected provider call'); },
      persistCheckout: async () => undefined,
    }),
    /Stripe checkout is not enabled/,
  );
  assert.equal(configFetches, 0);
});

test('checkout session core persists the established Stripe checkout document', async () => {
  const writes: Array<{ path: string; document: Record<string, unknown> }> = [];
  const collectionMint = pubkey(3).toBase58();
  const result = await createStripeCheckoutSessionCore({
    identity: createStripeCheckoutIdentity('anon_uid_123'),
    requestOrigin: 'https://mons.shop',
    body: { dropId: 'card_nft_binder_devnet', quantity: 1, returnUrl: 'https://mons.shop/drop' },
  }, {
    getDrop: (dropId) => ({
      dropId,
      solanaCluster: 'devnet',
      dropFamily: 'card_nft_binder',
      collectionName: 'Card NFT Binder',
      salesMode: 'stripe_receipt_only',
      stripeCheckoutEnabled: true,
      stripeProductTaxCode: 'txcd_99999999',
      itemsPerBox: 0,
      namePrefix: 'binder',
      boxMinterProgramId: pubkey(1).toBase58(),
      boxMinterConfigPda: pubkey(2).toBase58(),
      collectionMint,
      receiptsMerkleTree: pubkey(4).toBase58(),
    }),
    loadOnchainConfig: async () => ({
      admin: pubkey(5).toBase58(),
      coreCollection: collectionMint,
      maxSupply: 100,
      maxPerTx: 5,
      itemsPerBox: 0,
      minted: 1,
      started: true,
      mintVariantKind: 0,
      mintVariantStartIds: [0, 0, 0],
      mintVariantEndIds: [0, 0, 0],
      mintVariantNextIds: [0, 0, 0],
    }),
    requireFulfillmentPrerequisites: () => undefined,
    createProviderSession: async (request, mode) => {
      assert.equal(mode, 'test');
      assert.equal(request.quantity, 1);
      assert.deepEqual(request.allowedCountries, STRIPE_CHECKOUT_BINDER_SHIPPING_COUNTRIES);
      return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/test', livemode: false };
    },
    persistCheckout: async (path, document) => {
      writes.push({ path, document });
    },
    nowMs: () => 1_700_000_000_000,
  });
  assert.deepEqual(result.session, {
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/c/pay/test',
    livemode: false,
  });
  assert.equal(writes[0]?.path, 'drops/card_nft_binder_devnet/stripeCheckouts/cs_test_123');
  assert.deepEqual(writes[0]?.document, {
    sessionId: 'cs_test_123',
    dropId: 'card_nft_binder_devnet',
    ...createStripeCheckoutIdentity('anon_uid_123'),
    quantity: 1,
    currency: 'usd',
    unitAmountCents: 100,
    fulfillmentMode: 'admin_variant_receipt',
    livemode: false,
    status: 'created',
    createdAt: { serverTimestamp: true },
    updatedAt: { serverTimestamp: true },
  });
});

test('checkout return URL rejects arbitrary no-origin return URLs', () => {
  assert.equal(
    normalizeStripeCheckoutReturnUrl({ rawReturnUrl: 'https://mons.shop/drop?drop=devnet', status: 'success' }),
    'https://mons.shop/drop?drop=devnet&stripe_checkout=success&session_id={CHECKOUT_SESSION_ID}',
  );
  assert.equal(
    normalizeStripeCheckoutReturnUrl({ requestOrigin: 'https://mons.shop', rawReturnUrl: 'https://mons.shop/drop?drop=devnet', status: 'cancel' }),
    'https://mons.shop/drop?drop=devnet&stripe_checkout=cancel',
  );
  assert.equal(
    normalizeStripeCheckoutReturnUrl({ rawReturnUrl: 'http://localhost:5173/drop', status: 'cancel' }),
    'http://localhost:5173/drop?stripe_checkout=cancel',
  );
  assert.throws(
    () => normalizeStripeCheckoutReturnUrl({ rawReturnUrl: 'https://evil.example/drop', status: 'success' }),
    /returnUrl origin mismatch/,
  );
});
