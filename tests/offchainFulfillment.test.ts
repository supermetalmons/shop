import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_ADMIN_DELIVERY_ORDER,
  IX_ADMIN_DELIVER_VARIANT_ORDER,
  STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
  STRIPE_CHECKOUT_SHIPPING_COUNTRY,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_OFFCHAIN_CURRENCY,
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
  normalizeStripeReceiptClaimCode,
  requireStripeReceiptClaimCode,
  resolveMintSelectionVariantIndex,
  shouldProcessStripeCheckoutFulfillmentWrite,
  stripeCheckoutOwnerId,
  stripeCheckoutSessionOrderHash,
  stripeFulfillmentAddressFromSession,
  validateStripeCheckoutContract,
  validateStripeCheckoutDocumentData,
  validateStripeTestCheckoutContract,
} from '../functions/src/stripeCheckout/contract.ts';
import {
  STRIPE_CHECKOUT_PROCESSING_LEASE_MS,
  checkoutReturnUrl,
  createOrGetStripeOffchainDeliveryOrder,
  createStripeCheckoutSessionForRequest,
  createTestStripeCheckoutSessionForRequest,
  enqueueStripeCheckoutFulfillment,
  isRetryableStripeCheckoutFulfillmentError,
  markStripeCheckoutFulfillmentFailed,
  markStripeCheckoutFulfillmentFulfilled,
  runStripeCheckoutFulfillmentWithRetry,
  startStripeCheckoutFulfillmentDocument,
  stripeApiKeyForMode,
  stripeCheckoutProductTaxCodeForDrop,
  stripeCheckoutShippingParams,
  stripeCheckoutUnitAmountCentsForDrop,
  stripeTestApiKey,
} from '../functions/src/stripeCheckout/service.ts';
import { IRL_CLAIM_CODE_DIGITS, normalizeIrlClaimCode } from '../functions/src/claimCodes.ts';
import { IX_BUBBLEGUM_TRANSFER_V2, bubblegumTransferV2Ix } from '../functions/src/bubblegum.ts';

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

test('IRL claim code normalization rejects Stripe-formatted alphabetic codes', () => {
  assert.equal(normalizeIrlClaimCode('123-456 7890'), '1234567890');
  assert.equal(normalizeIrlClaimCode('ABCDEF-0123456789'), '');
  assert.equal(IRL_CLAIM_CODE_DIGITS, 10);
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

test('admin order PDA and instruction args use the on-chain seed and discriminator', () => {
  const programId = pubkey(1);
  const configPda = pubkey(2);
  const orderHash = Buffer.alloc(32, 9);
  const [pda] = deriveAdminOrderPda(programId, configPda, orderHash);
  const data = encodeAdminDeliverVariantOrderArgs({ orderHash, variantIndex: 2, quantity: 1 });

  assert.deepEqual(IX_ADMIN_DELIVER_VARIANT_ORDER, anchorDiscriminator('global', 'admin_deliver_variant_order'));
  assert.deepEqual(ACCOUNT_ADMIN_DELIVERY_ORDER, anchorDiscriminator('account', 'AdminDeliveryOrderRecord'));
  assert.ok(PublicKey.isOnCurve(pda.toBuffer()) === false);
  assert.equal(data.length, 8 + 32 + 1 + 1);
  assert.deepEqual(data.subarray(0, 8), IX_ADMIN_DELIVER_VARIANT_ORDER);
  assert.equal(data.readUInt8(40), 2);
  assert.equal(data.readUInt8(41), 1);
});

test('resolveMintSelectionVariantIndex maps configured size keys', () => {
  const selection = {
    kind: 'size' as const,
    options: [
      { key: 'L', startId: 1, endId: 15 },
      { key: 'XL', startId: 16, endId: 30 },
      { key: '2XL', startId: 31, endId: 34 },
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

test('stripeCheckoutShippingParams does not request phone numbers', () => {
  const params = stripeCheckoutShippingParams();
  assert.equal('phone_number_collection' in params, false);
  assert.deepEqual(params.shipping_address_collection?.allowed_countries, [STRIPE_CHECKOUT_SHIPPING_COUNTRY]);
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
      total_details: { amount_tax: 2142 },
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
    owner: 'firebase:anon_uid_123',
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
    firebaseUid: 'anon_uid_123',
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
  };
  const doc = buildStripeOffchainDeliveryOrderDocument(input);

  assert.equal(doc.source, 'stripe_offchain');
  assert.equal(doc.status, 'ready_to_ship');
  assert.equal(doc.owner, 'firebase:anon_uid_123');
  assert.equal(doc.ownerKind, STRIPE_CHECKOUT_OWNER_KIND_FIREBASE);
  assert.equal(doc.firebaseUid, 'anon_uid_123');
  assert.equal(doc.receiptOwner, pubkey(90).toBase58());
  assert.deepEqual(doc.items, [{ kind: 'box', refId: 16, variantKey: 'XL' }]);
  assert.equal(doc.receiptsMinted, 1);
  assert.deepEqual(doc.receiptTxs, ['tx123']);
  assert.deepEqual(doc.stripeReceiptClaim, {
    namespace: STRIPE_RECEIPT_CLAIM_CODE_NAMESPACE,
    code: 'ABCDEF-0123456789',
    boxId: 16,
    status: 'unclaimed',
  });
  assert.equal(doc.stripeCheckoutSessionId, 'cs_test_123');
  assert.equal(doc.stripePaymentIntentId, 'pi_123');
  assert.deepEqual(buildStripeOffchainOrderMarkerDocument(input), {
    dropId: 'little_swag_hoodies_devnet',
    deliveryId: 123,
    owner: 'firebase:anon_uid_123',
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
    firebaseUid: 'anon_uid_123',
    receiptOwner: pubkey(90).toBase58(),
    metadataId: 16,
    variantKey: 'XL',
    offchainOrderHash: 'ab'.repeat(32),
    stripeCheckoutSessionId: 'cs_test_123',
    receiptTx: 'tx123',
    stripeReceiptClaimCode: 'ABCDEF-0123456789',
  });
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
    order: {
      dropId,
      orderHashHex,
      owner: 'firebase:anon_uid_456',
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
      firebaseUid: 'anon_uid_456',
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
});

test('validateStripeCheckoutDocumentData accepts only the app-created session contract', () => {
  assert.deepEqual(buildStripeCheckoutSessionMetadata({ dropId: 'little_swag_hoodies_devnet', uid: 'anon_uid_123', variantKey: 'XL' }), {
    dropId: 'little_swag_hoodies_devnet',
    uid: 'anon_uid_123',
    fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
    placeholder: 'stripe_direct_delivery',
    quantity: '1',
    variantKey: 'XL',
  });

  const checkout = buildStripeCheckoutDocument({
    dropId: 'little_swag_hoodies_devnet',
    sessionId: 'cs_test_123',
    uid: 'anon_uid_123',
    variantKey: 'XL',
    unitAmountCents: 100,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  });
  assert.deepEqual(checkout, {
    sessionId: 'cs_test_123',
    dropId: 'little_swag_hoodies_devnet',
    uid: 'anon_uid_123',
    owner: 'firebase:anon_uid_123',
    ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
    firebaseUid: 'anon_uid_123',
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
      uid: 'anon_uid_123',
      variantKey: 'XL',
      unitAmountCents: 100,
      livemode: false,
      status: STRIPE_CHECKOUT_STATUS.CREATED,
    },
  );
  const liveCheckout = buildStripeCheckoutDocument({
    dropId: 'little_swag_hoodies',
    sessionId: 'cs_live_123',
    uid: 'anon_uid_123',
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
      uid: 'anon_uid_123',
      variantKey: 'XL',
      unitAmountCents: 24900,
      livemode: true,
      status: STRIPE_CHECKOUT_STATUS.CREATED,
    },
  );
  assert.equal(stripeCheckoutOwnerId('anon_uid_123'), 'firebase:anon_uid_123');
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

test('stripeCheckoutUnitAmountCentsForDrop separates devnet test and mainnet live pricing', () => {
  const previous = process.env.STRIPE_TEST_UNIT_AMOUNT_CENTS;
  try {
    delete process.env.STRIPE_TEST_UNIT_AMOUNT_CENTS;
    assert.equal(
      stripeCheckoutUnitAmountCentsForDrop({
        cluster: 'devnet',
        config: {},
      } as any),
      100,
    );
    process.env.STRIPE_TEST_UNIT_AMOUNT_CENTS = '250';
    assert.equal(
      stripeCheckoutUnitAmountCentsForDrop({
        cluster: 'devnet',
        config: { stripeLiveUnitAmountCents: 24900 },
      } as any),
      250,
    );
    assert.equal(
      stripeCheckoutUnitAmountCentsForDrop({
        cluster: 'mainnet-beta',
        config: { stripeLiveUnitAmountCents: 24900 },
      } as any),
      24900,
    );
    assert.throws(
      () =>
        stripeCheckoutUnitAmountCentsForDrop({
          cluster: 'mainnet-beta',
          config: {},
        } as any),
      /Stripe live unit amount is not configured/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.STRIPE_TEST_UNIT_AMOUNT_CENTS;
    } else {
      process.env.STRIPE_TEST_UNIT_AMOUNT_CENTS = previous;
    }
  }
});

test('stripeCheckoutProductTaxCodeForDrop requires explicit checkout enablement and product tax code', () => {
  assert.equal(
    stripeCheckoutProductTaxCodeForDrop({
      config: {
        stripeCheckoutEnabled: true,
        stripeProductTaxCode: 'txcd_30011000',
      },
    } as any),
    'txcd_30011000',
  );
  assert.throws(
    () =>
      stripeCheckoutProductTaxCodeForDrop({
        config: {
          stripeProductTaxCode: 'txcd_30011000',
        },
      } as any),
    /not enabled/,
  );
  assert.throws(
    () =>
      stripeCheckoutProductTaxCodeForDrop({
        config: {
          stripeCheckoutEnabled: true,
        },
      } as any),
    /product tax code is not configured/,
  );
  assert.throws(
    () =>
      stripeCheckoutProductTaxCodeForDrop({
        config: {
          stripeCheckoutEnabled: true,
          stripeProductTaxCode: 'clothing',
        },
      } as any),
    /product tax code is invalid/,
  );
});

test('enqueueStripeCheckoutFulfillment marks the checkout document fulfillment_pending', async () => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const variantKey = 'XL';
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/${sessionId}` } as any;
  const updates: Array<{ ref: any; data: any }> = [];
  const checkout = buildStripeCheckoutDocument({
    dropId,
    sessionId,
    uid: 'anon_uid_123',
    variantKey,
    unitAmountCents: 100,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  });
  const session = {
    id: sessionId,
    livemode: false,
    mode: 'payment',
    payment_status: 'paid',
    amount_total: 100,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    metadata: {
      fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
      dropId,
      variantKey,
      quantity: '1',
    },
  } as any;
  const tx = {
    get: async (ref: any) => {
      if (ref === checkoutRef) return { exists: true, data: () => checkout };
      throw new Error(`unexpected ref: ${ref.path}`);
    },
    update: (ref: any, data: any) => {
      updates.push({ ref, data });
    },
  };
  const db = {
    doc: (path: string) => {
      if (path === checkoutRef.path) return checkoutRef;
      throw new Error(`unexpected path: ${path}`);
    },
    runTransaction: async (fn: any) => fn(tx),
  } as any;

  const result = await enqueueStripeCheckoutFulfillment({
    db,
    event: { id: 'evt_123', type: 'checkout.session.completed', data: { object: session } } as any,
    session,
    requireDropId: (raw) => String(raw),
    getDropRuntime: (id) =>
      ({
        dropId: id,
        cluster: 'devnet',
        config: {
          mintSelection: {
            kind: 'size',
            options: [{ key: 'L' }, { key: 'XL' }, { key: '2XL' }],
          },
        },
      }) as any,
  });

  assert.deepEqual(result, {
    queued: true,
    dropId,
    sessionId,
    checkoutPath: checkoutRef.path,
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ref, checkoutRef);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING);
});

test('enqueueStripeCheckoutFulfillment ignores non-app Stripe sessions', async () => {
  const session = { id: 'cs_test_unrelated', metadata: {} } as any;
  const result = await enqueueStripeCheckoutFulfillment({
    db: { runTransaction: async () => assert.fail('unexpected transaction') } as any,
    event: { id: 'evt_123', type: 'checkout.session.completed', data: { object: session } } as any,
    session,
    requireDropId: (raw) => String(raw),
    getDropRuntime: (id) => ({ dropId: id, config: {} }) as any,
  });

  assert.deepEqual(result, {
    ignored: true,
    reason: 'not_app_fulfillment',
    sessionId: 'cs_test_unrelated',
  });
});

test('enqueueStripeCheckoutFulfillment requires the app-created checkout document', async () => {
  const dropId = 'little_swag_hoodies_devnet';
  const sessionId = 'cs_test_123';
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/${sessionId}` } as any;
  const session = {
    id: sessionId,
    metadata: {
      fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
      dropId,
      variantKey: 'XL',
    },
  } as any;
  const db = {
    doc: (path: string) => {
      if (path === checkoutRef.path) return checkoutRef;
      throw new Error(`unexpected path: ${path}`);
    },
    runTransaction: async (fn: any) =>
      fn({
        get: async () => ({ exists: false }),
      }),
  } as any;

  await assert.rejects(
    () =>
      enqueueStripeCheckoutFulfillment({
        db,
        event: { id: 'evt_123', type: 'checkout.session.completed', data: { object: session } } as any,
        session,
        requireDropId: (raw) => String(raw),
        getDropRuntime: (id) => ({ dropId: id, cluster: 'devnet', config: {} }) as any,
      }),
    /created by this app/,
  );
});

test('enqueueStripeCheckoutFulfillment accepts live mainnet app checkout documents', async () => {
  const dropId = 'little_swag_hoodies';
  const sessionId = 'cs_live_123';
  const variantKey = 'XL';
  const checkoutRef = { path: `drops/${dropId}/stripeCheckouts/${sessionId}` } as any;
  const updates: Array<{ ref: any; data: any }> = [];
  const checkout = buildStripeCheckoutDocument({
    dropId,
    sessionId,
    uid: 'anon_uid_123',
    variantKey,
    unitAmountCents: 24900,
    livemode: true,
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  });
  const session = {
    id: sessionId,
    livemode: true,
    mode: 'payment',
    payment_status: 'paid',
    amount_total: 24900,
    currency: STRIPE_OFFCHAIN_CURRENCY,
    metadata: {
      fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
      dropId,
      variantKey,
      quantity: '1',
    },
  } as any;
  const tx = {
    get: async (ref: any) => {
      if (ref === checkoutRef) return { exists: true, data: () => checkout };
      throw new Error(`unexpected ref: ${ref.path}`);
    },
    update: (ref: any, data: any) => {
      updates.push({ ref, data });
    },
  };
  const db = {
    doc: (path: string) => {
      if (path === checkoutRef.path) return checkoutRef;
      throw new Error(`unexpected path: ${path}`);
    },
    runTransaction: async (fn: any) => fn(tx),
  } as any;

  const result = await enqueueStripeCheckoutFulfillment({
    db,
    event: { id: 'evt_live_123', type: 'checkout.session.completed', data: { object: session } } as any,
    session,
    requireDropId: (raw) => String(raw),
    getDropRuntime: (id) =>
      ({
        dropId: id,
        cluster: 'mainnet-beta',
        config: {
          mintSelection: {
            kind: 'size',
            options: [{ key: 'L' }, { key: 'XL' }, { key: '2XL' }],
          },
        },
      }) as any,
  });

  assert.deepEqual(result, {
    queued: true,
    dropId,
    sessionId,
    checkoutPath: checkoutRef.path,
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ref, checkoutRef);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING);
  assert.equal(updates[0].data.stripeSessionSummary.livemode, true);
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
        uid: 'anon_uid_123',
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
  checkoutRef.firestore = { runTransaction: async (fn: any) => fn(tx) };

  const started = await startStripeCheckoutFulfillmentDocument({ dropId, sessionId, checkoutRef });

  assert.equal(started.started, true);
  const processingAttemptId = started.started ? started.processingAttemptId : '';
  assert.match(processingAttemptId, /^[0-9a-z]+:[0-9a-z]+$/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ref, checkoutRef);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
  assert.equal(updates[0].data.processingAttemptId, processingAttemptId);
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
        uid: 'anon_uid_123',
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
  checkoutRef.firestore = {
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
        uid: 'anon_uid_123',
        variantKey,
        unitAmountCents: 100,
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      }),
      status: STRIPE_CHECKOUT_STATUS.PROCESSING,
      processingLeaseExpiresAt: timestampLike(nowMs - 1),
    }),
  };
  checkoutRef.firestore = {
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
      uid: 'anon_uid_123',
      variantKey,
      unitAmountCents: 100,
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    }),
    status: STRIPE_CHECKOUT_STATUS.PROCESSING,
    processingStartedAt: timestampLike(nowMs - STRIPE_CHECKOUT_PROCESSING_LEASE_MS - 1),
  };
  checkoutRef.firestore = {
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
  checkoutRef.firestore = {
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

test('markStripeCheckoutFulfillmentFailed writes manual-review failure', async () => {
  const sets: Array<{ ref: any; data: any; options: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.firestore = {
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
  checkoutRef.firestore = {
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
  checkoutRef.firestore = {
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
  });

  assert.deepEqual(result, { status: 'fulfilled' });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ref, checkoutRef);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.FULFILLED);
  assert.equal(updates[0].data.deliveryId, 123);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0].data, 'processingAttemptId'), true);
});

test('markStripeCheckoutFulfillmentFulfilled ignores stale processing attempts', async () => {
  const updates: Array<{ ref: any; data: any }> = [];
  const checkoutRef = { path: 'checkout' } as any;
  checkoutRef.firestore = {
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
      owner: 'firebase:anon_uid_123',
      ownerKind: STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
      firebaseUid: 'anon_uid_123',
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
  assert.equal(isRetryableStripeCheckoutFulfillmentError(Object.assign(new Error('rpc timeout'), { code: 'unavailable' })), true);
  assert.equal(isRetryableStripeCheckoutFulfillmentError(Object.assign(new Error('rate limited'), { statusCode: 429 })), true);
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
    firestore: {
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
    firestore: {
      runTransaction: async () => {
        throw new Error('firestore unavailable');
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

test('createTestStripeCheckoutSessionForRequest rejects bad returnUrl before config fetch', async () => {
  let configFetches = 0;
  const deps = {
    requireDropId: (raw: unknown) => String(raw),
    getDropRuntime: (dropId: string) =>
      ({
        dropId,
        cluster: 'devnet',
        itemsPerBox: 0,
        receiptsMerkleTreeStr: 'tree',
        config: {
          mintSelection: {
            kind: 'size',
            options: [{ key: 'L' }, { key: 'XL' }, { key: '2XL' }],
          },
        },
      }) as any,
    fetchCheckoutConfig: async () => {
      configFetches += 1;
      throw new Error('unexpected config fetch');
    },
  } as any;

  await assert.rejects(
    () =>
      createTestStripeCheckoutSessionForRequest({
        db: {} as any,
        request: {
          data: {
            dropId: 'little_swag_hoodies_devnet',
            variantKey: 'XL',
            returnUrl: 'https://evil.example/drop',
          },
          rawRequest: { headers: {} },
        } as any,
        uid: 'anon_uid_123',
        apiKeys: ['sk_test_secret'],
        deps,
      }),
    /returnUrl origin mismatch/,
  );
  assert.equal(configFetches, 0);
});

test('createStripeCheckoutSessionForRequest rejects drops without explicit Stripe checkout enablement before Stripe call', async () => {
  let configFetches = 0;
  const deps = {
    requireDropId: (raw: unknown) => String(raw),
    getDropRuntime: (dropId: string) =>
      ({
        dropId,
        cluster: 'mainnet-beta',
        itemsPerBox: 0,
        receiptsMerkleTreeStr: 'tree',
        config: {
          mintSelection: {
            kind: 'size',
            options: [{ key: 'L' }, { key: 'XL' }, { key: '2XL' }],
          },
        },
      }) as any,
    connection: () => ({}),
    fetchCheckoutConfig: async () => {
      configFetches += 1;
      throw new Error('unexpected config fetch');
    },
    requireStripeCheckoutVariantAvailable: () => undefined,
    requireStripeCheckoutCollectionMatchesConfig: () => undefined,
    requireStripeCheckoutFulfillmentPrerequisites: () => undefined,
  } as any;

  await assert.rejects(
    () =>
      createStripeCheckoutSessionForRequest({
        db: {} as any,
        request: {
          data: {
            dropId: 'little_swag_hoodies',
            variantKey: 'XL',
            returnUrl: 'https://mons.shop/drop',
          },
          rawRequest: { headers: {} },
        } as any,
        uid: 'anon_uid_123',
        apiKeys: ['sk_live_secret'],
        deps,
      }),
    /Stripe checkout is not enabled/,
  );
  assert.equal(configFetches, 0);
});

test('checkoutReturnUrl rejects arbitrary no-origin return URLs', () => {
  const noOriginRequest = { rawRequest: { headers: {} } } as any;
  const browserRequest = { rawRequest: { headers: { origin: 'https://mons.shop' } } } as any;

  assert.equal(
    checkoutReturnUrl(noOriginRequest, 'https://mons.shop/drop?drop=devnet', 'success'),
    'https://mons.shop/drop?drop=devnet&stripe_checkout=success&session_id={CHECKOUT_SESSION_ID}',
  );
  assert.equal(
    checkoutReturnUrl(browserRequest, 'https://mons.shop/drop?drop=devnet', 'cancel'),
    'https://mons.shop/drop?drop=devnet&stripe_checkout=cancel',
  );
  assert.equal(
    checkoutReturnUrl(noOriginRequest, 'http://localhost:5173/drop', 'cancel'),
    'http://localhost:5173/drop?stripe_checkout=cancel',
  );
  assert.throws(
    () => checkoutReturnUrl(noOriginRequest, 'https://evil.example/drop', 'success'),
    /returnUrl origin mismatch/,
  );
});
