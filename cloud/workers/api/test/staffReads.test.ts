import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness, seedCommerceDocument, seedCommerceDocuments } from './commerceD1Harness.ts';
import {
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
  handleStaffReadRequest,
  staffReadTestHooks,
  type StaffReadPath,
} from '../src/staffReads.ts';
import { ProfileReadError } from '../src/dataAccess.ts';
import { loadStripeChargebackSessionIds, recordStripeChargeback } from '../src/stripeChargebackStore.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentData } from '../src/commerceRepository.ts';
import {
  OWNER, ADMIN, OTHER, SYSTEM_OWNER, UID, NOW_MS, tokenRequest, stringValue, integerValue,
  base64UrlJson, orderDocument, manualReviewDocument, staffDependencies,
  legacyFirestoreStaffDependencies, d1StaffDependencies,
} from './readTestFixtures.ts';

test('all staff reads reject anonymous identities before accessing data', async () => {
  const cases: Array<[StaffReadPath, unknown]> = [
    [ADMIN_PROFILE_PATH, { ownerWallet: OWNER }],
    [ADMIN_DELIVERY_ORDER_OWNERS_PATH, {}],
    [FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2' }],
    [FULFILLMENT_MANUAL_REVIEW_PATH, { dropId: 'card_nft_2' }],
  ];
  for (const [path, body] of cases) {
    const result = await handleStaffReadRequest(
      tokenRequest(path, body),
      { COMMERCE_DB: {} as D1Database },
      path,
      {},
      {
        verifyIdentity: async () => ({ kind: 'anonymous', authSubject: ADMIN }),
        createCommerceRepository: () => assert.fail('Anonymous identity must not access Commerce'),
        loadProfileEmail: async () => assert.fail('Anonymous identity must not read profile email'),
        loadStripeChargebackSessionIds: async () => assert.fail('Anonymous identity must not read disputes'),
        providerFetch: async () => assert.fail('Anonymous identity must not contact a provider'),
      },
    );
    assert.equal(result.response.status, 401, path);
    assert.deepEqual(await result.response.json(), {
      ok: false,
      error: { code: 'unauthenticated', message: 'Staff wallet authentication is required.' },
    }, path);
    assert.equal(result.authOutcome, 'rejected', path);
    assert.deepEqual(result.metrics, { upstreamCalls: 0, providerDurationMs: 0 }, path);
  }
});

test('staff wallet resolution preserves cancellation before reading delivery-order owners', async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled after staff authentication');
  const db = {} as D1Database;
  const repository = new D1CommerceRepository(db);
  let reads = 0;
  repository.queryDeliveryOrderOwners = async () => {
    reads += 1;
    return [];
  };
  const request = new Request(tokenRequest(ADMIN_DELIVERY_ORDER_OWNERS_PATH, {}), {
    signal: controller.signal,
  });
  await assert.rejects(handleStaffReadRequest(
    request,
    { COMMERCE_DB: db },
    ADMIN_DELIVERY_ORDER_OWNERS_PATH,
    {},
    staffDependencies(async () => assert.fail('Unexpected provider request'), () => {
      queueMicrotask(() => controller.abort(reason));
      return repository;
    }),
  ), (error) => error === reason);
  assert.equal(reads, 0);
});

test('fulfillment adds only matching dispute history without exposing Stripe IDs or changing orders', async () => {
  const harness = createCommerceD1Harness();
  await recordStripeChargeback(harness.db, {
    livemode: true,
    sessionId: 'cs_live_history',
    disputeId: 'dp_history',
    dropId: 'card_nft_2',
    chargeId: 'ch_history',
    paymentIntentId: 'pi_history',
    disputeCreatedAt: Math.floor(NOW_MS / 1000) - 60,
    recordedAtMs: NOW_MS,
  });
  await recordStripeChargeback(harness.db, {
    livemode: false,
    sessionId: 'cs_test_otherdrop',
    disputeId: 'dp_otherdrop',
    dropId: 'little_swag_boxes',
    chargeId: 'ch_otherdrop',
    paymentIntentId: 'pi_otherdrop',
    disputeCreatedAt: Math.floor(NOW_MS / 1000) - 60,
    recordedAtMs: NOW_MS,
  });
  const variations: CommerceDocumentData[] = [
    { stripeCheckoutSessionId: 'cs_live_history' },
    { stripeCheckoutSessionId: 'cs_live_clean' },
    { stripeCheckoutSessionId: 'cs_live_history', source: 'onchain' },
    { stripeCheckoutSessionId: 'cs_live_history', source: 'admin_irl_redeem' },
    { stripeCheckoutSessionId: 'cs_live_history ' },
    { stripeCheckoutSessionId: 'https://stripe.example/cs_live_history' },
    {},
    { stripeCheckoutSessionId: 'cs_test_otherdrop' },
    { stripeCheckoutSessionId: 'cs_live_history', dropId: 'little_swag_boxes' },
    { stripeChargeback: true },
    { stripeCheckoutSessionId: 'cs_live_history' },
  ];
  variations.forEach((variation, index) => seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder('card_nft_2', String(index + 1)),
    data: {
      deliveryId: index + 1,
      owner: OWNER,
      source: 'stripe_offchain',
      status: 'ready_to_ship',
      fulfillmentStatus: 'Preparing',
      createdAt: NOW_MS + 1000,
      processedAt: NOW_MS + 1000,
      stripePaymentIntentId: 'pi_should_not_leak',
      items: [],
      ...variation,
    },
    processedAt: { seconds: Math.floor(NOW_MS / 1000) + 1, nanos: 0 },
  }));
  const before = harness.database.prepare('SELECT * FROM commerce_documents ORDER BY document_path').all();
  const lookups: { dropId: string; sessionIds: readonly string[] }[] = [];
  const result = await handleStaffReadRequest(
    tokenRequest(FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2', limit: 20 }),
    { COMMERCE_DB: harness.db, ADDRESS_DECRYPTION_SECRET: '' },
    FULFILLMENT_ORDERS_PATH,
    {},
    d1StaffDependencies(async () => { throw new Error('Unexpected provider request'); }, {
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
      loadStripeChargebackSessionIds: async (db, dropId, sessionIds) => {
        lookups.push({ dropId, sessionIds });
        return loadStripeChargebackSessionIds(db, dropId, sessionIds);
      },
    }),
  );
  assert.equal(result.response.status, 200);
  const text = await result.response.text();
  const payload = JSON.parse(text) as { orders: { deliveryId: number; stripeChargeback?: boolean; fulfillmentStatus: string }[] };
  assert.equal(payload.orders.length, variations.length);
  assert.deepEqual(
    payload.orders.filter((order) => order.stripeChargeback).map((order) => order.deliveryId).sort((a, b) => a - b),
    [1, 11],
  );
  assert.equal(payload.orders.every((order) => order.fulfillmentStatus === 'Preparing'), true);
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].dropId, 'card_nft_2');
  assert.deepEqual([...lookups[0].sessionIds].sort(), ['cs_live_clean', 'cs_live_history', 'cs_test_otherdrop']);
  assert.doesNotMatch(text, /stripeCheckoutSessionId|stripePaymentIntentId|cs_live_|cs_test_|pi_should_not_leak/);
  assert.deepEqual(harness.database.prepare('SELECT * FROM commerce_documents ORDER BY document_path').all(), before);
});

test('admin profile route enforces the existing wallet allowlist and returns canonical delivery summaries', async () => {
  const anonymousOnly = await handleStaffReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    {},
    legacyFirestoreStaffDependencies(async () => Response.json([]), {
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    }),
  );
  assert.equal(anonymousOnly.response.status, 401);

  const denied = await handleStaffReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    {},
    legacyFirestoreStaffDependencies(async () => {
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => 'owner@example.com',
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.equal((await denied.response.json() as { error: { code: string } }).error.code, 'permission-denied');

  const accepted = await handleStaffReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    {},
    legacyFirestoreStaffDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ fields: { email: stringValue('owner@example.com') } });
      if (url.endsWith('/documents:runQuery')) return Response.json([{ document: orderDocument() }]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => 'owner@example.com',
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.equal(accepted.response.status, 200);
  assert.deepEqual(await accepted.response.json(), {
    profile: {
      wallet: OWNER,
      email: 'owner@example.com',
      orders: [{
        dropId: 'card_nft_2',
        deliveryId: 7,
        status: 'ready_to_ship',
        createdAt: Date.parse('2026-08-18T10:00:00.000Z'),
        processedAt: Date.parse('2026-08-18T11:00:00.000Z'),
        items: [{ kind: 'box', refId: 3 }],
      }],
    },
  });

  const missingProfile = await handleStaffReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    {},
    legacyFirestoreStaffDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'missing' }, { status: 404 });
      if (url.endsWith('/documents:runQuery')) return Response.json([]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.equal(missingProfile.response.status, 200);
  assert.deepEqual(await missingProfile.response.json(), { profile: { wallet: OWNER, orders: [] } });

  const unavailableProfile = await handleStaffReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    {},
    legacyFirestoreStaffDependencies(async (input) => {
      const url = String(input);
      if (url.endsWith('/documents:runQuery')) return Response.json([]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => {
        throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      },
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.equal(unavailableProfile.response.status, 502);
});

test('admin and fulfillment read routes preserve access, pagination, masking, and Stripe fallback', async () => {
  const env = {
    COMMERCE_DB: createCommerceD1(),
    ADDRESS_DECRYPTION_SECRET: '',
    STRIPE_SECRET_KEY: 'sk_test_primary',
    STRIPE_RESTRICTED_KEY: 'rk_test_fallback',
    STRIPE_SECRET_KEY_LIVE: 'sk_live_primary',
    STRIPE_RESTRICTED_KEY_LIVE: 'rk_live_fallback',
  };
  const owners = await handleStaffReadRequest(
    tokenRequest(ADMIN_DELIVERY_ORDER_OWNERS_PATH, { pageSize: 2 }),
    env,
    ADMIN_DELIVERY_ORDER_OWNERS_PATH,
    {},
    legacyFirestoreStaffDependencies(async (_input, init) => {
      const query = JSON.parse(String(init?.body)) as { operation: string };
      assert.equal(query.operation, 'queryDeliveryOrderOwners');
      return Response.json([
        { document: { name: 'projects/mons-shop/databases/(default)/documents/drops/a/deliveryOrders/1', fields: { owner: stringValue(OWNER) } } },
        { document: { name: 'projects/mons-shop/databases/(default)/documents/drops/a/deliveryOrders/2', fields: { owner: stringValue(OTHER) } } },
      ]);
    }, {
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.deepEqual(await owners.response.json(), { owners: [OTHER, OWNER], nextCursor: null, hasMore: false });

  const fulfillment = await handleStaffReadRequest(
    tokenRequest(FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2', limit: 2, cursor: null }),
    env,
    FULFILLMENT_ORDERS_PATH,
    {},
    legacyFirestoreStaffDependencies(async (_input, init) => {
      const query = JSON.parse(String(init?.body)) as { operation: string; limit: number };
      assert.equal(query.operation, 'queryFulfillmentOrders');
      assert.equal(query.limit, 3);
      return Response.json([{ document: {
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
        fields: {
          deliveryId: integerValue(7),
          owner: stringValue(OWNER),
          status: stringValue('ready_to_ship'),
          buyerOrderShippedEmailState: stringValue('pending'),
          processedAt: { timestampValue: '2026-08-18T11:00:00.123456789Z' },
          addressSnapshot: { mapValue: { fields: { encrypted: stringValue('private.payload.value'), email: stringValue('owner@example.com') } } },
          items: { arrayValue: {} },
        },
      } }]);
    }, {
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.deepEqual(await fulfillment.response.json(), {
    orders: [{
      dropId: 'card_nft_2',
      deliveryId: 7,
      owner: OWNER,
      status: 'ready_to_ship',
      processedAt: Date.parse('2026-08-18T11:00:00.123Z'),
      address: { full: '***' },
      boxes: [],
      looseDudes: [],
      cardClaims: [],
    }],
    nextCursor: null,
  });

  const manual = await handleStaffReadRequest(
    tokenRequest(FULFILLMENT_MANUAL_REVIEW_PATH, { dropId: 'card_nft_2' }),
    env,
    FULFILLMENT_MANUAL_REVIEW_PATH,
    {},
    legacyFirestoreStaffDependencies(async (input, init) => {
      const url = String(input);
      if (url.includes('api.stripe.com')) {
        assert.equal(new Headers(init?.headers).get('stripe-version'), '2026-07-29.dahlia');
        return Response.json({ error: 'temporary' }, { status: 503 });
      }
      return Response.json([{ document: {
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/stripeCheckouts/cs_test_review',
        fields: {
          manualRefundReviewRequired: { booleanValue: true },
          status: stringValue('fulfillment_failed'),
          sessionId: stringValue('cs_test_review'),
          owner: stringValue(OWNER),
          ownerKind: stringValue('wallet'),
          quantity: integerValue(2),
          stripeSessionSummary: { mapValue: { fields: { amount_total: integerValue(4200), currency: stringValue('usd') } } },
        },
      } }]);
    }, {
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.deepEqual(await manual.response.json(), {
    nextCursor: null,
    checkouts: [{
      dropId: 'card_nft_2',
      sessionId: 'cs_test_review',
      owner: OWNER,
      quantity: 2,
      amountTotal: 4200,
      currency: 'usd',
      address: { full: null },
    }],
  });
});

test('delivery-order owner pages are unique, ordered, valid, and cursor-stable', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocuments(harness, [
    { key: commerceKeys.deliveryOrder('drop', '1'), data: { owner: OWNER } },
    { key: commerceKeys.deliveryOrder('drop', '2'), data: { owner: OTHER } },
    { key: commerceKeys.deliveryOrder('drop', '3'), data: { owner: ADMIN } },
    { key: commerceKeys.deliveryOrder('drop', '4'), data: { owner: SYSTEM_OWNER } },
    { key: commerceKeys.deliveryOrder('other', '5'), data: { owner: OWNER } },
    { key: commerceKeys.deliveryOrder('drop', '6'), data: { owner: 'anonymous:subject' } },
    { key: commerceKeys.deliveryOrder('drop', '7'), data: { owner: '2'.repeat(32) } },
    { key: commerceKeys.deliveryOrder('drop', '8'), data: { owner: `${OTHER} ` } },
    { key: commerceKeys.deliveryOrder('drop', '9'), data: {} },
  ]);
  const dependencies = d1StaffDependencies(async () => Response.json({}), {
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
  });
  const env = { COMMERCE_DB: harness.db, OPS_DB: {} as D1Database };

  const first = await handleStaffReadRequest(
    tokenRequest(ADMIN_DELIVERY_ORDER_OWNERS_PATH, { pageSize: 2 }),
    env,
    ADMIN_DELIVERY_ORDER_OWNERS_PATH,
    {},
    dependencies,
  );
  assert.equal(first.response.status, 200);
  const firstPage = await first.response.json() as {
    owners: string[];
    nextCursor: string | null;
    hasMore: boolean;
  };
  assert.deepEqual(firstPage.owners, [SYSTEM_OWNER, ADMIN]);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  assert.deepEqual(
    JSON.parse(Buffer.from(firstPage.nextCursor, 'base64url').toString('utf8')),
    { v: 1, afterOwner: ADMIN },
  );

  const second = await handleStaffReadRequest(
    tokenRequest(ADMIN_DELIVERY_ORDER_OWNERS_PATH, { pageSize: 2, cursor: firstPage.nextCursor }),
    env,
    ADMIN_DELIVERY_ORDER_OWNERS_PATH,
    {},
    dependencies,
  );
  assert.equal(second.response.status, 200);
  const secondPage = await second.response.json() as {
    owners: string[];
    nextCursor: string | null;
    hasMore: boolean;
  };
  assert.deepEqual(secondPage, { owners: [OTHER, OWNER], nextCursor: null, hasMore: false });
  assert.deepEqual([...firstPage.owners, ...secondPage.owners], [SYSTEM_OWNER, ADMIN, OTHER, OWNER]);
});

test('delivery-order owner pagination enforces v1 cursors and page-size bounds', async () => {
  const queryLimits: number[] = [];
  const dependencies = staffDependencies(
    async () => Response.json({}),
    () => ({
      notificationOutbox: new D1CommerceRepository(createCommerceD1()).notificationOutbox,
      queryShipmentHistoryPage: async () => assert.fail('Unexpected paged shipment query'),
      queryDeliveryHistory: async () => [],
      queryFulfillmentOrders: async () => [],
      queryManualReviewCheckouts: async () => [],
      queryDeliveryOrderOwners: async ({ limit }) => {
        queryLimits.push(limit);
        return [];
      },
    }),
    {
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    },
  );
  const env = { COMMERCE_DB: createCommerceD1(), OPS_DB: {} as D1Database };

  for (const body of [{}, { pageSize: 1 }, { pageSize: 500 }]) {
    const result = await handleStaffReadRequest(
      tokenRequest(ADMIN_DELIVERY_ORDER_OWNERS_PATH, body),
      env,
      ADMIN_DELIVERY_ORDER_OWNERS_PATH,
      {},
      dependencies,
    );
    assert.equal(result.response.status, 200);
    assert.deepEqual(await result.response.json(), { owners: [], nextCursor: null, hasMore: false });
  }
  assert.deepEqual(queryLimits, [201, 2, 501]);

  for (const pageSize of [0, 501]) {
    const result = await handleStaffReadRequest(
      tokenRequest(ADMIN_DELIVERY_ORDER_OWNERS_PATH, { pageSize }),
      env,
      ADMIN_DELIVERY_ORDER_OWNERS_PATH,
      {},
      dependencies,
    );
    assert.equal(result.response.status, 400);
  }
  assert.deepEqual(queryLimits, [201, 2, 501]);

  const cursors = [
    base64UrlJson({ path: 'drops/drop/deliveryOrders/1' }),
    base64UrlJson({ v: 2, afterOwner: OWNER }),
    base64UrlJson({ v: 1, afterOwner: OWNER, extra: true }),
    base64UrlJson({ v: 1, afterOwner: 'invalid' }),
    'not+base64url',
  ];
  for (const cursor of cursors) {
    const result = await handleStaffReadRequest(
      tokenRequest(ADMIN_DELIVERY_ORDER_OWNERS_PATH, { cursor }),
      env,
      ADMIN_DELIVERY_ORDER_OWNERS_PATH,
      {},
      dependencies,
    );
    assert.equal(result.response.status, 400, cursor);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'invalid-argument');
  }
  assert.deepEqual(queryLimits, [201, 2, 501]);
});

test('delivery-order owner pagination bounds malformed candidates and stops after cancellation', async () => {
  const malformedOwner = (index: number) => {
    const suffix = (index + 1).toString(9).replace(/[0-8]/g, (digit) => String(Number(digit) + 1));
    return `${'2'.repeat(28)}${suffix.padStart(4, 'A')}`;
  };
  const invalidOwners = Array.from({ length: 8 }, (_, index) => malformedOwner(index)).sort();
  const candidates = [...invalidOwners, OWNER].sort();
  const queryLimits: number[] = [];
  const page = await staffReadTestHooks.loadDeliveryOrderOwners({
    pageSize: 1,
    repository: {
      queryDeliveryOrderOwners: async ({ limit, startAfterOwner }) => {
        queryLimits.push(limit);
        return candidates
          .filter((owner) => startAfterOwner === undefined || owner > startAfterOwner)
          .slice(0, limit);
      },
    },
    signal: new AbortController().signal,
  });
  assert.deepEqual(page, { owners: [OWNER], nextCursor: null, hasMore: false });
  assert.deepEqual(queryLimits, [2, 682]);

  const malformedCandidates = Array.from({ length: 2048 }, (_, index) => malformedOwner(index)).sort();
  const malformedQueryLimits: number[] = [];
  let fetchedCandidateCount = 0;
  await assert.rejects(
    staffReadTestHooks.loadDeliveryOrderOwners({
      pageSize: 1,
      repository: {
        queryDeliveryOrderOwners: async ({ limit, startAfterOwner }) => {
          malformedQueryLimits.push(limit);
          const result = malformedCandidates
            .filter((owner) => startAfterOwner === undefined || owner > startAfterOwner)
            .slice(0, limit);
          fetchedCandidateCount += result.length;
          return result;
        },
      },
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof ProfileReadError && error.code === 'unavailable',
  );
  assert.deepEqual(malformedQueryLimits, [2, 682, 682, 682]);
  assert.equal(fetchedCandidateCount, 2048);

  const controller = new AbortController();
  const reason = new Error('owner scan cancelled');
  let cancelledQueryCount = 0;
  await assert.rejects(
    staffReadTestHooks.loadDeliveryOrderOwners({
      pageSize: 1,
      repository: {
        queryDeliveryOrderOwners: async () => {
          cancelledQueryCount += 1;
          controller.abort(reason);
          return invalidOwners;
        },
      },
      signal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(cancelledQueryCount, 1);
});

test('manual review rethrows client cancellation and retains server-timeout Stripe fallback', async () => {
  const env = {
    COMMERCE_DB: createCommerceD1(),
    STRIPE_SECRET_KEY: 'sk_test_primary',
    STRIPE_SECRET_KEY_LIVE: 'sk_live_primary',
  };
  const dependencies = (
    stripeStarted: () => void,
    timeoutMs: number,
  ): Parameters<typeof handleStaffReadRequest>[4] => legacyFirestoreStaffDependencies(
    async (input) => {
      if (String(input).includes('api.stripe.com')) {
        stripeStarted();
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return Response.json([{ document: manualReviewDocument() }]);
    },
    {
      timeoutMs,
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    },
  );

  const controller = new AbortController();
  const reason = new Error('client disconnected');
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const request = new Request(
    tokenRequest(FULFILLMENT_MANUAL_REVIEW_PATH, { dropId: 'card_nft_2' }),
    { signal: controller.signal },
  );
  const cancelled = handleStaffReadRequest(
    request,
    env,
    FULFILLMENT_MANUAL_REVIEW_PATH,
    {},
    dependencies(markStarted, 500),
  );
  await started;
  controller.abort(reason);
  await assert.rejects(cancelled, (error: unknown) => error === reason);

  const timedOut = await handleStaffReadRequest(
    tokenRequest(FULFILLMENT_MANUAL_REVIEW_PATH, { dropId: 'card_nft_2' }),
    env,
    FULFILLMENT_MANUAL_REVIEW_PATH,
    {},
    dependencies(() => undefined, 5),
  );
  assert.equal(timedOut.response.status, 200);
  const payload = await timedOut.response.json() as { checkouts: Array<{ sessionId: string }> };
  assert.deepEqual(payload.checkouts.map((checkout) => checkout.sessionId), ['cs_test_review']);
});

test('staff commerce read routes use D1 without Commerce in d1 mode', async () => {
  const harness = createCommerceD1Harness();
  seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder('card_nft_2', '7'),
    data: {
      buyerOrderShippedEmailState: 'pending',
      createdAt: Date.parse('2026-08-18T10:00:00.000Z'),
      deliveryId: 7,
      dropId: 'card_nft_2',
      items: [{ kind: 'box', refId: 3 }],
      owner: OWNER,
      processedAt: Date.parse('2026-08-18T11:00:00.000Z'),
      status: 'ready_to_ship',
    },
    processedAt: { seconds: Date.parse('2026-08-18T11:00:00.000Z') / 1000, nanos: 0 },
  });
  seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout('card_nft_2', 'cs_test_review'),
    data: {
      manualRefundReviewRequired: true,
      owner: OWNER,
      quantity: 2,
      sessionId: 'cs_test_review',
      status: 'fulfillment_failed',
    },
  });
  const env = {
    COMMERCE_DB: harness.db,
    ADDRESS_DECRYPTION_SECRET: '',
    OPS_DB: {} as D1Database,
    STRIPE_SECRET_KEY: 'sk_test_primary',
  };
  let commerceCalls = 0;
  const providerFetch: typeof fetch = async (input) => {
    if (String(input).includes('commerce.googleapis.com')) {
      commerceCalls += 1;
      throw new Error('D1 route reached Commerce');
    }
    return Response.json({});
  };
  const staffDependencies = d1StaffDependencies(providerFetch, {
    loadProfileEmail: async () => 'owner@example.com',
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
  });
  const calls: Array<[StaffReadPath, unknown, Parameters<typeof handleStaffReadRequest>[4]]> = [
    [ADMIN_PROFILE_PATH, { ownerWallet: OWNER }, staffDependencies],
    [ADMIN_DELIVERY_ORDER_OWNERS_PATH, { pageSize: 2 }, staffDependencies],
    [FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2', limit: 2, cursor: null }, staffDependencies],
    [FULFILLMENT_MANUAL_REVIEW_PATH, { dropId: 'card_nft_2' }, staffDependencies],
  ];
  for (const [path, body, dependencies] of calls) {
    const result = await handleStaffReadRequest(tokenRequest(path, body), env, path, {}, dependencies);
    assert.equal(result.response.status, 200, path);
    const payload = await result.response.json();
    if (path === FULFILLMENT_ORDERS_PATH) {
      assert.doesNotMatch(JSON.stringify(payload), /buyerOrderShippedEmailState/);
    }
  }
  const repository = new D1CommerceRepository(harness.db);
  for (const state of ['queued', 'failed'] as const) {
    await repository.run(NOW_MS, (unit) => unit.replaceNotificationOutbox({
      parentPath: commerceKeys.deliveryOrder('card_nft_2', '7').path,
      family: 'shipped', dropId: 'card_nft_2', generation: crypto.randomUUID(), retryUntilMs: NOW_MS,
      entries: [{ kind: 'buyer_order_shipped', jobId: crypto.randomUUID(),
        idempotencyKey: 'card_nft_2:7:order_shipped', state }],
    }));
    const result = await handleStaffReadRequest(tokenRequest(FULFILLMENT_ORDERS_PATH, {
      dropId: 'card_nft_2', limit: 2, cursor: null,
    }), env, FULFILLMENT_ORDERS_PATH, {}, staffDependencies);
    const payload = await result.response.json() as { orders: Array<{ buyerOrderShippedEmailState?: string }> };
    assert.equal(payload.orders[0].buyerOrderShippedEmailState, state === 'failed' ? 'pending' : 'queued');
  }
  assert.equal(commerceCalls, 0);
});

test('D1 staff reads enforce drop, status, ordering, and cursor filters', async () => {
  const harness = createCommerceD1Harness();
  const seedOrder = (args: {
    deliveryId: number;
    dropId: string;
    nanos: number;
    owner: string;
    seconds: number;
    status: string;
  }) => seedCommerceDocument(harness, {
    key: commerceKeys.deliveryOrder(args.dropId, String(args.deliveryId)),
    data: {
      createdAt: args.seconds * 1_000 - 500,
      deliveryId: args.deliveryId,
      dropId: args.dropId,
      items: [{ kind: 'box', refId: args.deliveryId }],
      owner: args.owner,
      processedAt: args.seconds * 1_000,
      status: args.status,
    },
    processedAt: { seconds: args.seconds, nanos: args.nanos },
  });
  seedOrder({ deliveryId: 1, dropId: 'card_nft_2', nanos: 1, owner: OWNER, seconds: 100, status: 'ready_to_ship' });
  seedOrder({ deliveryId: 2, dropId: 'card_nft_2', nanos: 2, owner: OTHER, seconds: 100, status: 'ready_to_ship' });
  seedOrder({ deliveryId: 3, dropId: 'card_nft_2', nanos: 0, owner: OWNER, seconds: 101, status: 'processing' });
  seedOrder({ deliveryId: 4, dropId: 'little_swag_boxes', nanos: 0, owner: OWNER, seconds: 102, status: 'ready_to_ship' });
  seedOrder({ deliveryId: 5, dropId: 'card_nft_2', nanos: 0, owner: OWNER, seconds: 103, status: 'failed' });

  const staffDependencies = d1StaffDependencies(async () => Response.json({}), {
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
  });
  const fulfillmentEnv = {
    COMMERCE_DB: harness.db,
    ADDRESS_DECRYPTION_SECRET: '',
    OPS_DB: {} as D1Database,
  };
  const firstPage = await handleStaffReadRequest(
    tokenRequest(FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2', limit: 1, cursor: null }),
    fulfillmentEnv,
    FULFILLMENT_ORDERS_PATH,
    {},
    staffDependencies,
  );
  assert.equal(firstPage.response.status, 200);
  const firstPayload = await firstPage.response.json() as {
    orders: Array<{ deliveryId: number }>;
    nextCursor: { processedAt: { seconds: number; nanos: number }; id: string } | null;
  };
  assert.deepEqual(firstPayload.orders.map((order) => order.deliveryId), [2]);
  assert.deepEqual(firstPayload.nextCursor, { processedAt: { seconds: 100, nanos: 2 }, id: '2' });

  const secondPage = await handleStaffReadRequest(
    tokenRequest(FULFILLMENT_ORDERS_PATH, {
      dropId: 'card_nft_2',
      limit: 1,
      cursor: firstPayload.nextCursor,
    }),
    fulfillmentEnv,
    FULFILLMENT_ORDERS_PATH,
    {},
    staffDependencies,
  );
  assert.equal(secondPage.response.status, 200);
  const secondPayload = await secondPage.response.json() as {
    orders: Array<{ deliveryId: number }>;
    nextCursor: unknown;
  };
  assert.deepEqual(secondPayload.orders.map((order) => order.deliveryId), [1]);
  assert.equal(secondPayload.nextCursor, null);
});
