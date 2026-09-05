import test, { type TestContext } from 'node:test';
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
import {
  CommerceWriteConflict,
  D1CommerceRepository,
  commerceFieldValue,
  commerceKeys,
  type CommerceDocumentData,
  type CommerceDocumentKey,
} from '../cloud/workers/api/src/commerceRepository.ts';
import {
  createCommerceD1Harness,
  seedCommerceDocument,
  type CommerceD1CallObservation,
} from '../cloud/workers/api/test/commerceD1Harness.ts';
import { parseStripeTerminalNotificationOutbox } from '../cloud/workers/api/src/stripeCheckout/notificationOutboxState.ts';
import type { StripeCheckoutCommerceContext } from '../cloud/workers/api/src/stripeCheckout/commerce.ts';
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

const STRIPE_CHECKOUT_OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const COMMERCE_NOW_MS = 1_700_000_000_000;

function stripeCommerceFixture(
  t: TestContext,
  data: Record<string, unknown> | null,
  {
    dropId = 'little_swag_hoodies_devnet',
    sessionId = 'cs_test_123',
    nowMs = COMMERCE_NOW_MS,
    observeCall,
  }: {
    dropId?: string;
    sessionId?: string;
    nowMs?: number;
    observeCall?: (call: CommerceD1CallObservation) => void;
  } = {},
) {
  const calls: CommerceD1CallObservation[] = [];
  const harness = createCommerceD1Harness({
    observeCall: (call) => {
      calls.push(call);
      observeCall?.(call);
    },
  });
  t.after(() => harness.database.close());
  const repository = new D1CommerceRepository(harness.db);
  const checkoutKey = commerceKeys.stripeCheckout(dropId, sessionId);
  if (data) seedCommerceDocument(harness, {
    key: checkoutKey,
    data: data as CommerceDocumentData,
    updateTime: new Date(nowMs - 1).toISOString(),
  });
  const commerce: StripeCheckoutCommerceContext = { repository, nowMs: () => nowMs };
  return { harness, repository, checkoutKey, commerce, calls };
}

function commerceDocumentWriteBatches(calls: readonly CommerceD1CallObservation[]) {
  return calls.filter((call) => call.method === 'batch'
    && call.statements.some((statement) => /INSERT INTO commerce_documents/.test(statement.sql)));
}

function commerceDocumentReadBatches(calls: readonly CommerceD1CallObservation[]) {
  return calls.filter((call) => call.method === 'batch'
    && call.statements.some((statement) => /\bFROM commerce_documents\b/.test(statement.sql)));
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

test('createOrGetStripeOffchainDeliveryOrder creates a Stripe receipt claim code atomically', async (t) => {
  const dropId = 'little_swag_hoodies_devnet';
  const orderHashHex = 'cd'.repeat(32);
  const markerKey = commerceKeys.offchainOrder(dropId, orderHashHex);
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_current',
  }, { dropId, sessionId: 'cs_test_456' });
  const result = await createOrGetStripeOffchainDeliveryOrder({
    commerce,
    checkoutKey,
    isAlreadyExistsError: () => false,
    processingAttemptId: 'attempt_current',
    fulfillmentCompletionFields: {
      fulfillmentCompletedBy: 'cloudflare_queue_v1',
      fulfillmentCompletedAt: commerceFieldValue.serverTimestamp(),
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
  assert.equal(commerceDocumentReadBatches(calls).length, 2);
  const orders = await repository.query({ kind: 'delivery_order', dropId });
  const markers = await repository.query({ kind: 'offchain_order', dropId });
  const claims = await repository.query({ kind: 'claim_code' });
  const checkout = await repository.get(checkoutKey);
  assert.equal(orders.length, 1);
  assert.equal(markers.length, 1);
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  const orderCreate = orders[0];
  const markerCreate = await repository.get(markerKey);
  assert.equal(claims.length, 1);
  const claimCreate = claims[0];
  assert.ok(orderCreate);
  assert.ok(markerCreate);
  assert.ok(claimCreate);
  assert.match(String(claimCreate.data.code), /^[A-Z]{6}-\d{10}$/);
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
  assert.equal(checkout?.version, 2);
  assert.ok(checkout);
  const notification = parseStripeTerminalNotificationOutbox(checkout.data.stripeTerminalNotification);
  assert.ok(notification);
  assert.equal(checkout.data.fulfillmentCompletedBy, 'cloudflare_queue_v1');
  assert.equal(checkout.data.fulfillmentCompletedAt, COMMERCE_NOW_MS);
  assert.equal(checkout.data.stripeTerminalNotificationState, 'pending');
  assert.equal(notification.outcome, 'fulfilled');
  assert.equal(notification.attemptCount, 0);
});

test('createOrGetStripeOffchainDeliveryOrder batches reads for the maximum checkout quantity', async (t) => {
  const dropId = 'little_swag_hoodies_devnet';
  const orderHashHex = 'ef'.repeat(32);
  const metadataIds = Array.from({ length: STRIPE_OFFCHAIN_CHECKOUT_MAX_QUANTITY }, (_, index) => 16 + index);
  const boxKeys = metadataIds.map((boxId) => `box_${boxId}`).sort();
  const markerKey = commerceKeys.offchainOrder(dropId, orderHashHex);
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_current',
  }, { dropId, sessionId: 'cs_test_multi' });
  const result = await createOrGetStripeOffchainDeliveryOrder({
    commerce,
    checkoutKey,
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
      metadataIds,
      variantKey: 'XL',
      stripeSession: { id: 'cs_test_multi' },
      receiptTx: 'txmulti',
      addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
    },
  });

  assert.equal(result.checkoutStatus, 'fulfilled');
  assert.equal(commerceDocumentReadBatches(calls).length, 2);
  const orders = await repository.query({ kind: 'delivery_order', dropId });
  const markers = await repository.query({ kind: 'offchain_order', dropId });
  const claims = await repository.query({ kind: 'claim_code' });
  const checkout = await repository.get(checkoutKey);
  assert.equal(orders.length, 1);
  assert.equal(markers.length, 1);
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  const orderCreate = orders[0];
  const markerCreate = await repository.get(markerKey);
  const claimCreates = claims;
  assert.ok(orderCreate);
  assert.ok(markerCreate);
  assert.equal(claimCreates.length, metadataIds.length);
  assert.deepEqual(claimCreates.map((entry) => entry.data.boxId).sort((a, b) => Number(a) - Number(b)), metadataIds);
  assert.equal(new Set(claimCreates.map((entry) => entry.data.code)).size, metadataIds.length);
  assert.deepEqual(orderCreate.data.items, metadataIds.map((refId) => ({ kind: 'box', refId, variantKey: 'XL' })));
  assert.equal(orderCreate.data.receiptsMinted, metadataIds.length);
  assert.equal('stripeReceiptClaims' in orderCreate.data, false);
  assert.deepEqual(Object.keys(orderCreate.data.stripeReceiptClaimsByBoxId).sort(), boxKeys);
  assert.equal(markerCreate.data.quantity, metadataIds.length);
  assert.deepEqual(markerCreate.data.metadataIds, metadataIds);
  assert.deepEqual(Object.keys(markerCreate.data.stripeReceiptClaimCodesByBoxId).sort(), boxKeys);
  assert.equal('stripeReceiptClaims' in markerCreate.data, false);
  assert.equal(checkout?.version, 2);
  assert.ok(checkout);
  assert.equal('fulfillmentCompletedBy' in checkout.data, false);
  assert.equal('fulfillmentCompletedAt' in checkout.data, false);
  assert.deepEqual(checkout.data.metadataIds, metadataIds);
  assert.equal(Object.hasOwn(checkout.data, 'metadataId'), false);
  assert.equal(checkout.data.quantity, metadataIds.length);
});

test('createOrGetStripeOffchainDeliveryOrder retries allocation collisions after preloading', async (t) => {
  for (const collisionKind of ['delivery_order', 'claim_code'] as const) {
    await t.test(collisionKind, async (t) => {
      const dropId = 'little_swag_hoodies_devnet';
      const orderHashHex = '56'.repeat(32);
      const { harness, repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, {
        status: STRIPE_CHECKOUT_STATUS.PROCESSING,
        processingAttemptId: 'attempt_current',
      }, { dropId });
      let attempts = 0;
      let collisions = 0;
      let collisionKey: CommerceDocumentKey | undefined;
      const collisionData = { owner: 'competing-owner', status: 'prepared', retained: true };
      const competingCommerce: StripeCheckoutCommerceContext = {
        ...commerce,
        repository: {
          get: repository.get.bind(repository),
          run: (now, operation) => repository.run(now, async (unit) => {
            attempts += 1;
            const create = unit.create.bind(unit);
            unit.create = async (key, data) => {
              if (!collisionKey && key.kind === collisionKind) {
                assert.equal(commerceDocumentReadBatches(calls).length, 2);
                collisionKey = key;
                seedCommerceDocument(harness, { key, data: collisionData });
              }
              return create(key, data);
            };
            return operation(unit);
          }),
        },
      };

      const result = await createOrGetStripeOffchainDeliveryOrder({
        commerce: competingCommerce,
        checkoutKey,
        processingAttemptId: 'attempt_current',
        isAlreadyExistsError: (error) => {
          assert.ok(error instanceof CommerceWriteConflict);
          assert.equal(error.code, 'already-exists');
          collisions += 1;
          return true;
        },
        order: {
          dropId,
          orderHashHex,
          owner: 'anonymous:anon_uid_collision',
          ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
          authSubject: 'anon_uid_collision',
          receiptOwner: pubkey(93).toBase58(),
          metadataIds: [16, 17],
          variantKey: 'XL',
          stripeSession: { id: 'cs_test_123' },
          receiptTx: 'txcollision',
          addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
        },
      });

      assert.equal(result.checkoutStatus, 'fulfilled');
      assert.equal(attempts, 2);
      assert.equal(collisions, 1);
      assert.ok(collisionKey);
      const collided = await repository.get(collisionKey);
      assert.equal(collided?.version, 1);
      assert.deepEqual(collided?.data, collisionData);
      const orders = await repository.query({ kind: 'delivery_order', dropId });
      const markers = await repository.query({ kind: 'offchain_order', dropId });
      const claims = await repository.query({ kind: 'claim_code' });
      assert.equal(orders.length, collisionKind === 'delivery_order' ? 2 : 1);
      assert.equal(markers.length, 1);
      assert.equal(claims.length, collisionKind === 'claim_code' ? 3 : 2);
      assert.equal(markers[0].data.deliveryId, result.deliveryId);
      const allocatedClaims = claims.filter((claim) => claim.key.path !== collisionKey.path);
      assert.deepEqual(allocatedClaims.map((claim) => claim.data.boxId).sort(), [16, 17]);
      assert.ok(allocatedClaims.every((claim) => claim.data.deliveryId === result.deliveryId));
      const checkout = await repository.get(checkoutKey);
      assert.equal(checkout?.version, 2);
      assert.equal(checkout?.data.deliveryId, result.deliveryId);
    });
  }
});

test('createOrGetStripeOffchainDeliveryOrder keeps the D1 projection out of the critical commerce transaction', async (t) => {
  const dropId = 'card_nft_2';
  const orderHashHex = '12'.repeat(32);
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_current',
  }, { dropId, sessionId: 'cs_live_pack' });
  const packStatusCalls: unknown[] = [];

  const result = await createOrGetStripeOffchainDeliveryOrder({
    commerce,
    dropRuntime: { dropId, cluster: 'mainnet-beta', itemsPerBox: 3, maxSupply: 12_000 },
    checkoutKey,
    isAlreadyExistsError: () => false,
    processingAttemptId: 'attempt_current',
    countPackStatus: async (input) => {
      assert.equal(commerceDocumentWriteBatches(calls).length, 1);
      assert.equal((await repository.get(checkoutKey))?.data.status, STRIPE_CHECKOUT_STATUS.FULFILLED);
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
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  const statements = calls.flatMap((call) => call.method === 'batch' ? call.statements : [call]);
  assert.equal(statements.some(({ sql }) => /pack_status|packStatusEvents/.test(sql)), false);
  for (const kind of ['delivery_order', 'offchain_order', 'claim_code', 'stripe_checkout'] as const) {
    for (const record of await repository.query({ kind })) {
      assert.equal(Object.hasOwn(record.data, 'packStatus'), false);
    }
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

test('createOrGetStripeOffchainDeliveryOrder reuses existing pack order markers on retry', async (t) => {
  const dropId = 'card_nft_2';
  const orderHashHex = '34'.repeat(32);
  const markerKey = commerceKeys.offchainOrder(dropId, orderHashHex);
  const { harness, repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_current',
  }, { dropId, sessionId: 'cs_test_pack_retry' });
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
  seedCommerceDocument(harness, { key: markerKey, data: markerData as CommerceDocumentData });
  const packStatusCalls: unknown[] = [];

  const result = await createOrGetStripeOffchainDeliveryOrder({
    commerce,
    dropRuntime: { dropId, cluster: 'mainnet-beta', itemsPerBox: 3, maxSupply: 12_000 },
    checkoutKey,
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
  assert.equal(commerceDocumentReadBatches(calls).length, 1);
  assert.equal((await repository.query({ kind: 'delivery_order', dropId })).length, 0);
  assert.equal((await repository.query({ kind: 'claim_code' })).length, 0);
  assert.equal((await repository.get(markerKey))?.version, 1);
  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  const notification = parseStripeTerminalNotificationOutbox(checkout.data.stripeTerminalNotification);
  assert.ok(notification);
  assert.equal(checkout.version, 2);
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.deepEqual(checkout.data.metadataIds, [1, 2]);
  assert.equal(checkout.data.quantity, 2);
  assert.equal(checkout.data.stripeTerminalNotificationState, 'pending');
  assert.equal(notification.outcome, 'fulfilled');
  assert.equal('variantKey' in markerData, false);
  assert.equal(packStatusCalls.length, 1);
  assert.equal((packStatusCalls[0] as { deliveryId: number }).deliveryId, 789);
  const originalNotification = structuredClone(checkout.data.stripeTerminalNotification);
  calls.length = 0;
  await assert.rejects(
    createOrGetStripeOffchainDeliveryOrder({
      commerce,
      dropRuntime: { dropId, cluster: 'mainnet-beta', itemsPerBox: 3, maxSupply: 12_000 },
      checkoutKey,
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
  assert.equal(commerceDocumentReadBatches(calls).length, 1);
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
  const retried = await repository.get(checkoutKey);
  assert.equal(retried?.data.status, STRIPE_CHECKOUT_STATUS.FULFILLED);
  assert.deepEqual(retried?.data.stripeTerminalNotification, originalNotification);
  assert.equal((await repository.get(markerKey))?.version, 1);
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

test('startStripeCheckoutFulfillmentDocument processes only pending checkout documents', async (t) => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const variantKey = 'XL';
  const checkoutData = {
    ...buildStripeCheckoutDocument({
      dropId,
      sessionId,
      ...createStripeCheckoutIdentity('anon_uid_123'),
      variantKey,
      unitAmountCents: 100,
      createdAt: COMMERCE_NOW_MS,
      updatedAt: COMMERCE_NOW_MS,
    }),
    status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData, { dropId, sessionId });

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, commerce, checkoutKey });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.equal(started.started, true);
  const processingAttemptId = started.started ? started.processingAttemptId : '';
  assert.match(processingAttemptId, /^[0-9a-z]+:[0-9a-z]+$/);
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.equal(checkout.version, 2);
  assert.deepEqual(checkout.key, checkoutKey);
  assert.equal(checkout.data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
  assert.equal(checkout.data.processingAttemptId, processingAttemptId);
});

test('startStripeCheckoutFulfillmentDocument starts pack documents without variantKey', async (t) => {
  const dropId = 'card_nft_2';
  const sessionId = 'cs_test_pack';
  const checkoutData = {
    ...buildStripeCheckoutDocument({
      dropId,
      sessionId,
      ...createStripeCheckoutIdentity('anon_uid_pack'),
      quantity: 2,
      unitAmountCents: 100,
      createdAt: COMMERCE_NOW_MS,
      updatedAt: COMMERCE_NOW_MS,
    }),
    status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData, { dropId, sessionId });

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, commerce, checkoutKey });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.equal(started.started, true);
  if (started.started) {
    assert.equal('variantKey' in started, false);
    assert.equal(started.checkout.quantity, 2);
  }
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.equal(checkout.version, 2);
  assert.equal(checkout.data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
});

test('startStripeCheckoutFulfillmentDocument skips active processing leases', async (t) => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const variantKey = 'XL';
  const nowMs = 1_700_000_000_000;
  const checkoutData = {
    ...buildStripeCheckoutDocument({
      dropId,
      sessionId,
      ...createStripeCheckoutIdentity('anon_uid_123'),
      variantKey,
      unitAmountCents: 100,
      createdAt: COMMERCE_NOW_MS,
      updatedAt: COMMERCE_NOW_MS,
    }),
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingLeaseExpiresAt: nowMs + 1_000,
    processingStartedAt: nowMs - STRIPE_CHECKOUT_PROCESSING_LEASE_MS - 1_000,
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData, { dropId, sessionId, nowMs });

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, commerce, checkoutKey, nowMs });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.deepEqual(started, { started: false, reason: 'processing' });
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
  assert.equal(checkout.version, 1);
  assert.deepEqual(checkout.data, checkoutData);
});

test('startStripeCheckoutFulfillmentDocument reclaims expired processing leases', async (t) => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const variantKey = 'XL';
  const nowMs = 1_700_000_000_000;
  const checkoutData = {
    ...buildStripeCheckoutDocument({
      dropId,
      sessionId,
      ...createStripeCheckoutIdentity('anon_uid_123'),
      variantKey,
      unitAmountCents: 100,
      createdAt: COMMERCE_NOW_MS,
      updatedAt: COMMERCE_NOW_MS,
    }),
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingLeaseExpiresAt: nowMs - 1,
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData, { dropId, sessionId, nowMs });

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, commerce, checkoutKey, nowMs });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.equal(started.started, true);
  const processingAttemptId = started.started ? started.processingAttemptId : '';
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.equal(checkout.version, 2);
  assert.equal(checkout.data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
  assert.equal(checkout.data.processingAttemptId, processingAttemptId);
  assert.equal(checkout.data.processingLeaseExpiresAt, nowMs + STRIPE_CHECKOUT_PROCESSING_LEASE_MS);
});

test('startStripeCheckoutFulfillmentDocument uses legacy processingStartedAt as stale fallback', async (t) => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const variantKey = 'XL';
  const nowMs = 1_700_000_000_000;
  const checkoutData = {
    ...buildStripeCheckoutDocument({
      dropId,
      sessionId,
      ...createStripeCheckoutIdentity('anon_uid_123'),
      variantKey,
      unitAmountCents: 100,
      createdAt: COMMERCE_NOW_MS,
      updatedAt: COMMERCE_NOW_MS,
    }),
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingStartedAt: nowMs - STRIPE_CHECKOUT_PROCESSING_LEASE_MS - 1,
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData, { dropId, sessionId, nowMs });

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, commerce, checkoutKey, nowMs });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.equal(started.started, true);
  const processingAttemptId = started.started ? started.processingAttemptId : '';
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.equal(checkout.version, 2);
  assert.equal(checkout.data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
  assert.equal(checkout.data.processingAttemptId, processingAttemptId);
});

test('markStripeCheckoutFulfillmentFailed leaves an already-fulfilled checkout intact', async (t) => {
  const checkoutData = {
    status: STRIPE_CHECKOUT_STATUS.FULFILLED,
    deliveryId: 123,
    metadataId: 16,
    receiptTx: 'tx123',
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);

  const result = await markStripeCheckoutFulfillmentFailed(commerce, checkoutKey, new Error('late failure'), {
    summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
    sessionIdentity: { dropId: 'little_swag_hoodies_devnet', sessionId: 'cs_test_123' },
  });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.deepEqual(result, { status: 'already_fulfilled' });
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
  assert.equal(checkout.version, 1);
  assert.deepEqual(checkout.data, checkoutData);
});

test('retryable fulfillment failures release the current lease back to pending', async (t) => {
  const checkoutData = {
    processingLeaseExpiresAt: COMMERCE_NOW_MS + 1_000,
    processingStartedAt: COMMERCE_NOW_MS - 1_000,
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_current',
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);

  const result = await releaseStripeCheckoutFulfillmentForRetry(
    commerce,
    checkoutKey,
    new Error('provider unavailable'),
    {
      summarizeError: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
      processingAttemptId: 'attempt_current',
    },
  );

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.deepEqual(result, { status: 'released' });
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.equal(checkout.version, 2);
  assert.equal(checkout.data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING);
  assert.deepEqual(checkout.data.lastRetryableFulfillmentError, { message: 'provider unavailable' });
  assert.equal(Object.hasOwn(checkout.data, 'processingAttemptId'), false);
  assert.equal(Object.hasOwn(checkout.data, 'processingLeaseExpiresAt'), false);
  assert.equal(Object.hasOwn(checkout.data, 'processingStartedAt'), false);
});

test('final Queue attempts persist retryable fulfillment failures for manual review', async (t) => {
  let failNextRead = true;
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, {
    status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING,
  }, {
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_final_attempt',
    observeCall: () => {
      if (!failNextRead) return;
      failNextRead = false;
      throw Object.assign(new Error('provider unavailable'), { code: 'unavailable' });
    },
  });
  const result = await processStripeCheckoutFulfillmentDocument({
    commerce,
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_final_attempt',
    checkoutKey,
    apiKeys: [],
    deps: {
      getDropRuntime: () => ({ cluster: 'devnet' }),
      summarizeError: (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
    } as any,
    treatRetryableFailureAsTerminal: true,
  });
  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  const notification = parseStripeTerminalNotificationOutbox(checkout.data.stripeTerminalNotification);
  assert.ok(notification);
  assert.equal(result.status, 'failed');
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.equal(checkout.version, 2);
  assert.equal(checkout.data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED);
  assert.equal(checkout.data.manualRefundReviewRequired, true);
  assert.equal(checkout.data.stripeTerminalNotificationState, 'pending');
  assert.equal(notification.outcome, 'manual_review');
});

test('already-fulfilled Queue retries repair pack status idempotently', async (t) => {
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, {
    status: STRIPE_CHECKOUT_STATUS.FULFILLED,
    deliveryId: 123,
  }, { dropId: 'card_nft_2', sessionId: 'cs_test_repair' });
  const repairs: unknown[] = [];
  const result = await processStripeCheckoutFulfillmentDocument({
    commerce,
    dropId: 'card_nft_2',
    sessionId: 'cs_test_repair',
    checkoutKey,
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
  assert.deepEqual(repairs, [{
    dropRuntime: { dropId: 'card_nft_2', cluster: 'mainnet-beta' },
    checkoutKey,
    sessionId: 'cs_test_repair',
  }]);
  assert.equal((await repository.get(checkoutKey))?.version, 1);
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
});

test('markStripeCheckoutFulfillmentFailed writes manual-review failure', async (t) => {
  const checkoutData = {
    preserved: 'checkout-field',
    processingLeaseExpiresAt: COMMERCE_NOW_MS + 1_000,
    nextFulfillmentRetryAt: COMMERCE_NOW_MS + 2_000,
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_current',
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);

  const result = await markStripeCheckoutFulfillmentFailed(commerce, checkoutKey, new Error('processing failure'), {
    summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
    sessionIdentity: { dropId: 'little_swag_hoodies_devnet', sessionId: 'cs_test_123' },
    processingAttemptId: 'attempt_current',
  });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  const notification = parseStripeTerminalNotificationOutbox(checkout.data.stripeTerminalNotification);
  assert.ok(notification);
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.equal(checkout.version, 2);
  assert.deepEqual(checkout.key, checkoutKey);
  assert.equal(checkout.data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED);
  assert.equal(checkout.data.manualRefundReviewRequired, true);
  assert.equal(checkout.data.stripeTerminalNotificationState, 'pending');
  assert.equal(notification.version, 1);
  assert.equal(notification.outcome, 'manual_review');
  assert.equal(notification.attemptCount, 0);
  assert.match(notification.jobIds.stripe_checkout_manual_review, /^[0-9a-f-]{36}$/);
  assert.equal(Object.hasOwn(checkout.data, 'processingAttemptId'), false);
  assert.equal(Object.hasOwn(checkout.data, 'processingLeaseExpiresAt'), false);
  assert.equal(Object.hasOwn(checkout.data, 'nextFulfillmentRetryAt'), false);
  assert.equal(checkout.data.preserved, 'checkout-field');

  const missing = stripeCommerceFixture(t, null);
  assert.equal(await missing.repository.get(missing.checkoutKey), null);
  assert.deepEqual(await markStripeCheckoutFulfillmentFailed(missing.commerce, missing.checkoutKey, new Error('missing checkout'), {
    summarizeError: () => ({ message: 'missing checkout' }),
    sessionIdentity: { dropId: 'little_swag_hoodies_devnet', sessionId: 'cs_test_123' },
  }), { status: 'failed' });
  const created = await missing.repository.get(missing.checkoutKey);
  assert.equal(created?.version, 1);
  assert.equal(created?.data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED);
  assert.equal(created?.data.dropId, 'little_swag_hoodies_devnet');
  assert.equal(created?.data.sessionId, 'cs_test_123');
  assert.equal(created?.data.manualRefundReviewRequired, true);
  assert.equal(created?.data.failedAt, COMMERCE_NOW_MS);
  assert.equal(created?.data.stripeTerminalNotificationState, 'pending');
  assert.equal(parseStripeTerminalNotificationOutbox(created?.data.stripeTerminalNotification)?.outcome, 'manual_review');
  assert.equal(commerceDocumentWriteBatches(missing.calls).length, 1);
});

test('markStripeCheckoutFulfillmentFailed ignores stale processing attempts', async (t) => {
  const checkoutData = {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_new',
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);

  const result = await markStripeCheckoutFulfillmentFailed(commerce, checkoutKey, new Error('late failure'), {
    summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
    sessionIdentity: { dropId: 'little_swag_hoodies_devnet', sessionId: 'cs_test_123' },
    processingAttemptId: 'attempt_old',
  });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.deepEqual(result, { status: 'stale_processing_attempt' });
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
  assert.equal(checkout.version, 1);
  assert.deepEqual(checkout.data, checkoutData);
});

test('markStripeCheckoutFulfillmentFulfilled writes only the current processing attempt', async (t) => {
  const checkoutData = {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_current',
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);

  const result = await markStripeCheckoutFulfillmentFulfilled(commerce, checkoutKey, {
    deliveryId: 123,
    metadataId: 16,
    receiptTx: 'tx123',
    processingAttemptId: 'attempt_current',
    fulfillmentCompletionFields: {
      fulfillmentCompletedBy: 'cloudflare_queue_v1',
      fulfillmentCompletedAt: commerceFieldValue.serverTimestamp(),
    },
  });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  const notification = parseStripeTerminalNotificationOutbox(checkout.data.stripeTerminalNotification);
  assert.ok(notification);
  assert.deepEqual(result, { status: 'fulfilled' });
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.equal(checkout.version, 2);
  assert.deepEqual(checkout.key, checkoutKey);
  assert.equal(checkout.data.status, STRIPE_CHECKOUT_STATUS.FULFILLED);
  assert.equal(checkout.data.deliveryId, 123);
  assert.equal(checkout.data.fulfillmentCompletedBy, 'cloudflare_queue_v1');
  assert.equal(checkout.data.fulfillmentCompletedAt, COMMERCE_NOW_MS);
  assert.equal(Object.hasOwn(checkout.data, 'processingAttemptId'), false);
  assert.equal(checkout.data.stripeTerminalNotificationState, 'pending');
  assert.equal(notification.version, 1);
  assert.equal(notification.outcome, 'fulfilled');
  assert.equal(notification.attemptCount, 0);
  assert.match(notification.jobIds.buyer_order_received, /^[0-9a-f-]{36}$/);
  assert.match(notification.jobIds.shipper_ready_to_ship, /^[0-9a-f-]{36}$/);
});

test('terminal checkout writes preserve queued notifications on replay without a processing attempt', async (t) => {
  for (const outcome of ['fulfilled', 'manual_review'] as const) {
    const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, { status: STRIPE_CHECKOUT_STATUS.PROCESSING });
    const complete = () => outcome === 'fulfilled'
      ? markStripeCheckoutFulfillmentFulfilled(commerce, checkoutKey, { deliveryId: 123 })
      : markStripeCheckoutFulfillmentFailed(commerce, checkoutKey, new Error('payment requires review'), {
        summarizeError: () => ({ message: 'payment requires review' }),
      });

    await complete();
    const completed = await repository.get(checkoutKey);
    assert.equal(completed?.data.stripeTerminalNotificationState, 'pending');
    const notification = structuredClone(completed?.data.stripeTerminalNotification);
    await repository.run(COMMERCE_NOW_MS, (unit) => unit.update(checkoutKey, { stripeTerminalNotificationState: 'queued' }));
    await complete();

    const replayed = await repository.get(checkoutKey);
    assert.equal(commerceDocumentWriteBatches(calls).length, 3);
    assert.equal(replayed?.version, 4);
    assert.equal(replayed?.data.stripeTerminalNotificationState, 'queued');
    assert.deepEqual(replayed?.data.stripeTerminalNotification, notification);
  }
});

test('terminal checkout writes do not backfill notifications for historical terminal records', async (t) => {
  for (const outcome of ['fulfilled', 'manual_review'] as const) {
    const initial = outcome === 'fulfilled'
      ? { status: STRIPE_CHECKOUT_STATUS.FULFILLED }
      : { status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED, manualRefundReviewRequired: true };
    const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, initial);

    if (outcome === 'fulfilled') {
      await markStripeCheckoutFulfillmentFulfilled(commerce, checkoutKey, { deliveryId: 123 });
    } else {
      await markStripeCheckoutFulfillmentFailed(commerce, checkoutKey, new Error('payment requires review'), {
        summarizeError: () => ({ message: 'payment requires review' }),
      });
    }

    const checkout = await repository.get(checkoutKey);
    assert.ok(checkout);
    assert.equal(commerceDocumentWriteBatches(calls).length, 1);
    assert.equal(checkout.version, 2);
    assert.equal(Object.hasOwn(checkout.data, 'stripeTerminalNotificationState'), false);
    assert.equal(Object.hasOwn(checkout.data, 'stripeTerminalNotification'), false);
  }
});

test('markStripeCheckoutFulfillmentFulfilled clears singular metadataId for multi-item checkout docs', async (t) => {
  const checkoutData = {
    metadataId: 16,
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_current',
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);

  const result = await markStripeCheckoutFulfillmentFulfilled(commerce, checkoutKey, {
    deliveryId: 123,
    metadataIds: [16, 17, 18],
    receiptTx: 'tx123',
    processingAttemptId: 'attempt_current',
  });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.deepEqual(result, { status: 'fulfilled' });
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  assert.equal(checkout.version, 2);
  assert.deepEqual(checkout.data.metadataIds, [16, 17, 18]);
  assert.equal('fulfillmentCompletedBy' in checkout.data, false);
  assert.equal('fulfillmentCompletedAt' in checkout.data, false);
  assert.equal(checkout.data.quantity, 3);
  assert.equal(Object.hasOwn(checkout.data, 'metadataId'), false);
});

test('markStripeCheckoutFulfillmentFulfilled ignores stale processing attempts', async (t) => {
  const checkoutData = {
    status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
    processingAttemptId: 'attempt_new',
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);

  const result = await markStripeCheckoutFulfillmentFulfilled(commerce, checkoutKey, {
    deliveryId: 123,
    metadataId: 16,
    receiptTx: 'tx123',
    processingAttemptId: 'attempt_old',
  });

  const checkout = await repository.get(checkoutKey);
  assert.ok(checkout);
  assert.deepEqual(result, { status: 'stale_processing_attempt' });
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
  assert.equal(checkout.version, 1);
  assert.deepEqual(checkout.data, checkoutData);
});

test('createOrGetStripeOffchainDeliveryOrder does not create documents for stale processing attempts', async (t) => {
  const dropId = 'little_swag_hoodies_devnet';
  const orderHashHex = 'ab'.repeat(32);
  const checkoutData = {
    status: STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED,
    processingAttemptId: 'attempt_new',
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData, { dropId });

  const result = await createOrGetStripeOffchainDeliveryOrder({
    commerce,
    checkoutKey,
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
  assert.equal(commerceDocumentReadBatches(calls).length, 1);
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
  assert.equal((await repository.query({ kind: 'delivery_order', dropId })).length, 0);
  assert.equal((await repository.query({ kind: 'offchain_order', dropId })).length, 0);
  assert.equal((await repository.query({ kind: 'claim_code' })).length, 0);
  const checkout = await repository.get(checkoutKey);
  assert.equal(checkout?.version, 1);
  assert.deepEqual(checkout?.data, checkoutData);
});

test('createOrGetStripeOffchainDeliveryOrder skips candidate reads for fulfilled checkouts without a marker', async (t) => {
  const dropId = 'little_swag_hoodies_devnet';
  const checkoutData = { status: STRIPE_CHECKOUT_STATUS.FULFILLED, deliveryId: 789 };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData, { dropId });
  const result = await createOrGetStripeOffchainDeliveryOrder({
    commerce,
    checkoutKey,
    processingAttemptId: 'attempt_current',
    isAlreadyExistsError: () => false,
    order: {
      dropId,
      orderHashHex: '78'.repeat(32),
      owner: 'anonymous:anon_uid_fulfilled',
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_ANONYMOUS,
      authSubject: 'anon_uid_fulfilled',
      receiptOwner: pubkey(90).toBase58(),
      metadataId: 16,
      variantKey: 'XL',
      stripeSession: { id: 'cs_test_123' },
      receiptTx: 'txfulfilled',
      addressSnapshot: { encrypted: 'ciphertext', hint: 'Buyer, US' },
    },
  });

  assert.deepEqual(result, { deliveryId: 789, checkoutStatus: 'already_fulfilled' });
  assert.equal(commerceDocumentReadBatches(calls).length, 1);
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
  for (const kind of ['delivery_order', 'offchain_order', 'claim_code'] as const) {
    assert.deepEqual(await repository.query({ kind }), []);
  }
  const checkout = await repository.get(checkoutKey);
  assert.equal(checkout?.version, 1);
  assert.deepEqual(checkout?.data, checkoutData);
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

test('runStripeCheckoutFulfillmentWithRetry retries a retryable failure once', async (t) => {
  const checkoutData = {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);
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
      commerce,
      checkoutKey,
      summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
      retryDelayMs: 0,
    },
  );

  assert.equal(result, 'fulfilled');
  assert.equal(attempts, 2);
  assert.equal(commerceDocumentWriteBatches(calls).length, 1);
  const checkout = await repository.get(checkoutKey);
  assert.equal(checkout?.version, 2);
  assert.equal(checkout?.data.lastRetryableFulfillmentAttempt, 1);
});

test('runStripeCheckoutFulfillmentWithRetry does not retry deterministic failures', async (t) => {
  const checkoutData = {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);
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
          commerce,
          checkoutKey,
          summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
          retryDelayMs: 0,
        },
      ),
    /unit amount/,
  );

  assert.equal(attempts, 1);
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
  const checkout = await repository.get(checkoutKey);
  assert.equal(checkout?.version, 1);
  assert.deepEqual(checkout?.data, checkoutData);
});

test('runStripeCheckoutFulfillmentWithRetry stops when processing attempt is stale', async (t) => {
  const checkoutData = {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_new',
  };
  const { repository, commerce, checkoutKey, calls } = stripeCommerceFixture(t, checkoutData);
  let attempts = 0;

  await assert.rejects(
    () =>
      runStripeCheckoutFulfillmentWithRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('temporary rpc timeout'), { code: 'deadline-exceeded' });
        },
        {
          commerce,
          checkoutKey,
          summarizeError: (err) => ({ message: err instanceof Error ? err.message : String(err) }),
          retryDelayMs: 0,
          processingAttemptId: 'attempt_old',
        },
      ),
    /no longer owns the processing lease/,
  );

  assert.equal(attempts, 1);
  assert.equal(commerceDocumentWriteBatches(calls).length, 0);
  const checkout = await repository.get(checkoutKey);
  assert.equal(checkout?.version, 1);
  assert.deepEqual(checkout?.data, checkoutData);
});

test('runStripeCheckoutFulfillmentWithRetry fails closed when ownership cannot be verified', async (t) => {
  const { commerce, checkoutKey } = stripeCommerceFixture(t, {
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingAttemptId: 'attempt_current',
  }, {
    observeCall: () => { throw new Error('commerce database unavailable'); },
  });
  let attempts = 0;

  await assert.rejects(
    () =>
      runStripeCheckoutFulfillmentWithRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('temporary rpc timeout'), { code: 'deadline-exceeded' });
        },
        {
          commerce,
          checkoutKey,
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
      operationId: STRIPE_CHECKOUT_OPERATION_ID,
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
      operationId: STRIPE_CHECKOUT_OPERATION_ID,
      body: {
        dropId: 'little_swag_hoodies',
        variantKey: 'XL',
        returnUrl: 'https://mons.shop/drop',
      },
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
    operationId: STRIPE_CHECKOUT_OPERATION_ID,
    body: {
      dropId: 'card_nft_binder_devnet',
      quantity: 1,
      returnUrl: 'https://mons.shop/drop',
    },
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
      assert.equal(request.operationId, STRIPE_CHECKOUT_OPERATION_ID);
      assert.equal(
        request.idempotencyKey,
        `mons-checkout:${STRIPE_CHECKOUT_OPERATION_ID}:anonymous:anonymous:anon_uid_123`,
      );
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
    operationId: STRIPE_CHECKOUT_OPERATION_ID,
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
