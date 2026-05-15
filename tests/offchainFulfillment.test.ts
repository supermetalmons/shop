import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_ADMIN_DELIVERY_ORDER,
  IX_ADMIN_DELIVER_VARIANT_ORDER,
  STRIPE_CHECKOUT_OWNER_KIND_FIREBASE,
  STRIPE_CHECKOUT_STATUS,
  STRIPE_OFFCHAIN_CURRENCY,
  STRIPE_OFFCHAIN_CHECKOUT_QUANTITY,
  STRIPE_OFFCHAIN_FULFILLMENT_MODE,
  buildStripeCheckoutDocument,
  buildStripeCheckoutSessionMetadata,
  buildStripeOffchainDeliveryOrderDocument,
  buildStripeOffchainOrderMarkerDocument,
  buildStripeOffchainAddressSnapshot,
  decodeAdminDeliveryOrderRecord,
  deriveAdminOrderPda,
  encodeAdminDeliverVariantOrderArgs,
  isStripeOffchainFulfillmentSession,
  resolveMintSelectionVariantIndex,
  shouldProcessStripeCheckoutFulfillmentWrite,
  stripeCheckoutOwnerId,
  stripeCheckoutSessionOrderHash,
  stripeFulfillmentAddressFromSession,
  validateStripeCheckoutDocumentData,
  validateStripeTestCheckoutContract,
} from '../functions/src/stripeCheckout/contract.ts';
import {
  checkoutReturnUrl,
  createTestStripeCheckoutSessionForRequest,
  enqueueStripeCheckoutFulfillment,
  markStripeCheckoutFulfillmentFailed,
  startStripeCheckoutFulfillmentDocument,
  stripeCheckoutShippingParams,
  stripeTestApiKey,
} from '../functions/src/stripeCheckout/service.ts';

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

test('stripeFulfillmentAddressFromSession formats shipping details without wallet data', () => {
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
  assert.equal(address?.phone, '+15551234567');
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
  assert.equal(address?.phone, '+15551234567');
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

test('buildStripeOffchainAddressSnapshot requires a parsed and encrypted address', () => {
  const validSession = {
    customer_details: { email: 'buyer@example.com', phone: '+15551234567' },
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
      phone: '+15551234567',
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

test('stripeCheckoutShippingParams preserves phone collection for shippers', () => {
  const params = stripeCheckoutShippingParams();
  assert.deepEqual(params.phone_number_collection, { enabled: true });
  assert.ok(params.shipping_address_collection?.allowed_countries.includes('US'));
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

test('validateStripeTestCheckoutContract rejects quantity mismatches and multiple line items', () => {
  const session = {
    mode: 'payment',
    payment_status: 'paid',
    livemode: false,
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
  };
  const doc = buildStripeOffchainDeliveryOrderDocument(input);

  assert.equal(doc.source, 'stripe_offchain');
  assert.equal(doc.owner, 'firebase:anon_uid_123');
  assert.equal(doc.ownerKind, STRIPE_CHECKOUT_OWNER_KIND_FIREBASE);
  assert.equal(doc.firebaseUid, 'anon_uid_123');
  assert.equal(doc.receiptOwner, pubkey(90).toBase58());
  assert.deepEqual(doc.items, [{ kind: 'box', refId: 16, variantKey: 'XL' }]);
  assert.equal(doc.receiptsMinted, 1);
  assert.deepEqual(doc.receiptTxs, ['tx123']);
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
  });
});

test('validateStripeCheckoutDocumentData accepts only the app-created session contract', () => {
  assert.deepEqual(buildStripeCheckoutSessionMetadata({ dropId: 'little_swag_hoodies_devnet', uid: 'anon_uid_123', variantKey: 'XL' }), {
    dropId: 'little_swag_hoodies_devnet',
    uid: 'anon_uid_123',
    fulfillmentMode: STRIPE_OFFCHAIN_FULFILLMENT_MODE,
    placeholder: 'devnet_direct_delivery',
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
    { uid: 'anon_uid_123', variantKey: 'XL', unitAmountCents: 100, status: STRIPE_CHECKOUT_STATUS.CREATED },
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
        getDropRuntime: (id) => ({ dropId: id, config: {} }) as any,
      }),
    /created by this app/,
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
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ref, checkoutRef);
  assert.equal(updates[0].data.status, STRIPE_CHECKOUT_STATUS.PROCESSING);
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
            data: () => ({ status: STRIPE_CHECKOUT_STATUS.PROCESSING }),
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
  });

  assert.deepEqual(result, { status: 'failed' });
  assert.equal(sets.length, 1);
  assert.equal(sets[0].ref, checkoutRef);
  assert.equal(sets[0].data.status, STRIPE_CHECKOUT_STATUS.FULFILLMENT_FAILED);
  assert.equal(sets[0].data.manualRefundReviewRequired, true);
  assert.deepEqual(sets[0].options, { merge: true });
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
