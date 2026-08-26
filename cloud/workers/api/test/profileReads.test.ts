import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1 } from './commerceD1Harness.ts';
import {
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
  ProfileReadError,
  handleProfileReadRequest,
  type ProfileProviderFetch,
  type ProfileReadPath,
} from '../src/profileReads.ts';
import { decodeFirestoreFields } from '../src/firestoreContract.ts';
import {
  D1CommerceRepository,
  commerceKeys,
  type CommerceDocumentData,
  type CommerceDocumentRecord,
  type CommerceQuery,
} from '../src/commerceRepository.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const OTHER = 'So11111111111111111111111111111111111111112';
const UID = 'firebase-user-one';
const NOW_MS = Date.parse('2026-08-18T12:00:00.000Z');

function tokenRequest(path: ProfileReadPath, body: unknown, origin = 'https://mons.shop'): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

function stringValue(value: string) {
  return { stringValue: value };
}

function integerValue(value: number) {
  return { integerValue: String(value) };
}

function orderDocument(owner = OWNER, deliveryId = 7) {
  return {
    name: `projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/${deliveryId}`,
    fields: {
      dropId: stringValue('card_nft_2'),
      deliveryId: integerValue(deliveryId),
      status: stringValue('ready_to_ship'),
      createdAt: { timestampValue: '2026-08-18T10:00:00.000Z' },
      processedAt: { timestampValue: '2026-08-18T11:00:00.000Z' },
      items: {
        arrayValue: {
          values: [{ mapValue: { fields: { kind: stringValue('box'), refId: integerValue(3) } } }],
        },
      },
      owner: stringValue(owner),
    },
  };
}

function profileDependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Partial<Parameters<typeof handleProfileReadRequest>[3]> = {},
): Parameters<typeof handleProfileReadRequest>[3] {
  return {
    createCommerceRepository: () => ({
      query: async <T extends CommerceDocumentData>(query: CommerceQuery) => {
        const response = await providerFetch('https://commerce.test/documents:runQuery', {
          method: 'POST',
          body: JSON.stringify(query),
        });
        const payload = await response.json() as unknown;
        if (!Array.isArray(payload)) throw new Error('Invalid repository fixture');
        return payload.flatMap((entry): CommerceDocumentRecord<T>[] => {
          const document = entry && typeof entry === 'object' && 'document' in entry
            ? (entry as { document?: unknown }).document
            : undefined;
          if (!document || typeof document !== 'object') return [];
          const raw = document as { name?: unknown; fields?: unknown; updateTime?: unknown };
          if (typeof raw.name !== 'string') return [];
          const fields = decodeFirestoreFields(raw.fields);
          if (!fields) return [];
          const delivery = raw.name.match(/\/drops\/([^/]+)\/deliveryOrders\/([^/]+)$/);
          const checkout = raw.name.match(/\/drops\/([^/]+)\/stripeCheckouts\/([^/]+)$/);
          const key = delivery
            ? commerceKeys.deliveryOrder(delivery[1], delivery[2])
            : checkout ? commerceKeys.stripeCheckout(checkout[1], checkout[2]) : null;
          if (!key) return [];
          const timestamp = (raw.fields as { processedAt?: { timestampValue?: unknown } })?.processedAt?.timestampValue;
          const milliseconds = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
          const fraction = typeof timestamp === 'string' ? timestamp.match(/\.(\d{1,9})Z$/)?.[1] || '' : '';
          return [{
            createTime: '',
            data: fields as T,
            key,
            processedAt: Number.isFinite(milliseconds)
              ? { seconds: Math.floor(milliseconds / 1000), nanos: Number(fraction.padEnd(9, '0')) || 0 }
              : null,
            updateTime: typeof raw.updateTime === 'string' ? raw.updateTime : '',
            version: 1,
          }];
        });
      },
    } as Pick<D1CommerceRepository, 'query'>),
    loadProfileEmail: async () => undefined,
    nowMs: () => NOW_MS,
    providerFetch,
    resolveD1WalletSession: async () => ({ wallet: OWNER, source: 'session' }),
    timeoutMs: 500,
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    ...overrides,
  };
}

test('shipment and anonymous history routes preserve exact source-query behavior', async () => {
  const queries: Record<string, unknown>[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/documents:runQuery')) {
      queries.push(JSON.parse(String(init?.body)));
      return Response.json([{ document: orderDocument() }]);
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const shipments = await handleProfileReadRequest(
    tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_SHIPMENTS_PATH,
    profileDependencies(providerFetch),
  );
  assert.equal(shipments.response.status, 200);
  assert.deepEqual(await shipments.response.json(), {
    responseMode: 'shipments',
    wallet: OWNER,
    orders: [{
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'ready_to_ship',
      createdAt: Date.parse('2026-08-18T10:00:00.000Z'),
      processedAt: Date.parse('2026-08-18T11:00:00.000Z'),
      items: [{ kind: 'box', refId: 3 }],
    }],
  });
  const anonymous = await handleProfileReadRequest(
    tokenRequest(ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
    profileDependencies(providerFetch),
  );
  assert.equal(anonymous.response.status, 200);
  assert.deepEqual(await anonymous.response.json(), {
    orders: [{
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'ready_to_ship',
      createdAt: Date.parse('2026-08-18T10:00:00.000Z'),
      processedAt: Date.parse('2026-08-18T11:00:00.000Z'),
      items: [{ kind: 'box', refId: 3 }],
    }],
  });
  assert.equal(queries.length, 2);
  const serialized = queries.map((query) => JSON.stringify(query));
  assert.match(serialized[0], new RegExp(OWNER));
  assert.match(serialized[1], new RegExp(`firebase:${UID}`));
  assert.equal(serialized.every((query) => query.includes('delivery_order') && query.includes('ready_to_ship')), true);
});

test('profile state derives identity server-side and returns independently bounded sections', async () => {
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) {
        return Response.json({
          fields: {
            email: stringValue(' owner@example.com '),
            address: { mapValue: { fields: { encrypted: stringValue('secret') } } },
          },
        });
      }
      if (url.endsWith('/documents:runQuery')) {
        return Response.json([
          { document: orderDocument(OWNER, 8) },
          { document: orderDocument(OWNER, 7) },
        ]);
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, { loadProfileEmail: async () => 'owner@example.com' }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    responseMode: 'profile-state',
    sessionWallet: OWNER,
    profile: {
      status: 'ready',
      value: { wallet: OWNER, email: 'owner@example.com' },
    },
    shipments: {
      status: 'ready',
      value: [
        {
          dropId: 'card_nft_2',
          deliveryId: 8,
          status: 'ready_to_ship',
          createdAt: Date.parse('2026-08-18T10:00:00.000Z'),
          processedAt: Date.parse('2026-08-18T11:00:00.000Z'),
          items: [{ kind: 'box', refId: 3 }],
        },
        {
          dropId: 'card_nft_2',
          deliveryId: 7,
          status: 'ready_to_ship',
          createdAt: Date.parse('2026-08-18T10:00:00.000Z'),
          processedAt: Date.parse('2026-08-18T11:00:00.000Z'),
          items: [{ kind: 'box', refId: 3 }],
        },
      ],
    },
  });
  assert.deepEqual(result.profileStateSections, { profile: 'ready', shipments: 'ready' });
});

test('profile state uses D1 wallet sessions without requesting Firestore authSessions', async () => {
  const providerFetch: typeof fetch = async (input) => {
    const url = String(input);
    assert.equal(url.includes('/authSessions/'), false);
    if (url.endsWith('/documents:runQuery')) return Response.json([{ document: orderDocument() }]);
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    {
      COMMERCE_DB: createCommerceD1(),
      OPS_DB: {} as D1Database,
    },
    PROFILE_STATE_PATH,
    profileDependencies(providerFetch, {
      resolveD1WalletSession: async () => ({ wallet: OWNER, source: 'session' }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { sessionWallet: string }).sessionWallet, OWNER);
});

test('staff profile state uses the wallet principal without a Firebase session row', async () => {
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'missing' }, { status: 404 });
      if (url.endsWith('/documents:runQuery')) return Response.json([]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      resolveD1WalletSession: async () => assert.fail('staff identity reached Firebase wallet-session resolution'),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    responseMode: 'profile-state',
    sessionWallet: OWNER,
    profile: { status: 'ready', value: { wallet: OWNER } },
    shipments: { status: 'ready', value: [] },
  });
});

test('profile state returns a settled empty session and preserves legacy wallet UIDs', async () => {
  const missing = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    profileDependencies(async () => assert.fail('missing session reached Firestore'), {
      resolveD1WalletSession: async () => ({ wallet: null, reason: 'legacy_uid_invalid' }),
    }),
  );
  assert.deepEqual(await missing.response.json(), {
    responseMode: 'profile-state',
    sessionWallet: null,
    profile: null,
    shipments: null,
  });

  const legacy = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    {
      ...profileDependencies(async (input) => {
        const url = String(input);
        if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'missing' }, { status: 404 });
        if (url.endsWith('/documents:runQuery')) return Response.json([]);
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
      resolveD1WalletSession: async () => ({ wallet: OWNER, source: 'legacy_uid' }),
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: OWNER }),
    },
  );
  assert.deepEqual(await legacy.response.json(), {
    responseMode: 'profile-state',
    sessionWallet: OWNER,
    profile: { status: 'ready', value: { wallet: OWNER } },
    shipments: { status: 'ready', value: [] },
  });
});

test('profile state reports section failures without discarding successful data', async () => {
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'busy' }, { status: 503 });
      if (url.endsWith('/documents:runQuery')) return Response.json([{ document: orderDocument() }]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => {
        throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      },
    }),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    profile: { status: string; error: { code: string } };
    shipments: { status: string; value: unknown[] };
  };
  assert.equal(payload.profile.status, 'error');
  assert.equal(payload.profile.error.code, 'unavailable');
  assert.equal(payload.shipments.status, 'ready');
  assert.equal(payload.shipments.value.length, 1);
  assert.deepEqual(result.profileStateSections, { profile: 'error', shipments: 'ready' });
});

test('profile state rejects invalid D1 sessions and non-empty requests', async () => {
  const malformedSession = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    profileDependencies(async () => assert.fail('invalid D1 session reached Firestore'), {
      resolveD1WalletSession: async () => { throw new Error('invalid D1 session'); },
    }),
  );
  assert.equal(malformedSession.response.status, 503);

  const invalidBody = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    profileDependencies(async () => assert.fail('invalid request reached provider')),
  );
  assert.equal(invalidBody.response.status, 400);
});

test('shipment route rejects mismatched sessions and malformed requests before source queries', async () => {
  let queries = 0;
  const providerFetch: typeof fetch = async () => {
    queries += 1;
    return Response.json([]);
  };
  const mismatch = await handleProfileReadRequest(
    tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_SHIPMENTS_PATH,
    profileDependencies(providerFetch, {
      resolveD1WalletSession: async () => ({ wallet: OTHER, source: 'session' }),
    }),
  );
  assert.equal(mismatch.response.status, 401);
  assert.deepEqual(await mismatch.response.json(), {
    ok: false,
    error: { code: 'unauthenticated', message: 'Wallet session changed. Sign in again.' },
  });
  assert.equal(queries, 0);

  for (const body of [{}, { ownerWallet: OWNER, extra: true }, { ownerWallet: 'invalid' }]) {
    const invalid = await handleProfileReadRequest(
      tokenRequest(PROFILE_SHIPMENTS_PATH, body),
      { COMMERCE_DB: createCommerceD1() },
      PROFILE_SHIPMENTS_PATH,
      profileDependencies(async () => assert.fail('invalid request reached provider')),
    );
    assert.equal(invalid.response.status, 400);
    assert.equal((await invalid.response.json() as { error: { code: string } }).error.code, 'invalid-argument');
  }
});

test('shipment route preserves legacy wallet-shaped Firebase UIDs when no session document exists', async () => {
  const owners: string[] = [];
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_SHIPMENTS_PATH,
    {
      ...profileDependencies(async (_input, init) => {
        const query = JSON.parse(String(init?.body)) as CommerceQuery;
        const owner = query.filters?.find((filter) => filter.field === 'owner')?.value;
        if (typeof owner === 'string') owners.push(owner);
        else if (Array.isArray(owner)) owners.push(...owner.filter((value): value is string => typeof value === 'string'));
        return Response.json([]);
      }),
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: OWNER }),
    },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { responseMode: 'shipments', wallet: OWNER, orders: [] });
  assert.deepEqual(owners, [OWNER]);
});

test('admin profile route enforces the existing wallet allowlist and returns canonical delivery summaries', async () => {
  const anonymousOnly = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    profileDependencies(async () => Response.json([]), {
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    }),
  );
  assert.equal(anonymousOnly.response.status, 401);

  const denied = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    profileDependencies(async () => {
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => 'owner@example.com',
      resolveD1WalletSession: async () => ({ wallet: OTHER, source: 'session' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.equal((await denied.response.json() as { error: { code: string } }).error.code, 'permission-denied');

  const accepted = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ fields: { email: stringValue('owner@example.com') } });
      if (url.endsWith('/documents:runQuery')) return Response.json([{ document: orderDocument() }]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => 'owner@example.com',
      resolveD1WalletSession: async () => ({ wallet: ADMIN, source: 'session' }),
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

  const missingProfile = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'missing' }, { status: 404 });
      if (url.endsWith('/documents:runQuery')) return Response.json([]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      resolveD1WalletSession: async () => ({ wallet: ADMIN, source: 'session' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.equal(missingProfile.response.status, 200);
  assert.deepEqual(await missingProfile.response.json(), { profile: { wallet: OWNER, orders: [] } });

  const unavailableProfile = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.endsWith('/documents:runQuery')) return Response.json([]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => {
        throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      },
      resolveD1WalletSession: async () => ({ wallet: ADMIN, source: 'session' }),
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
  const owners = await handleProfileReadRequest(
    tokenRequest(ADMIN_DELIVERY_ORDER_OWNERS_PATH, { pageSize: 2 }),
    env,
    ADMIN_DELIVERY_ORDER_OWNERS_PATH,
    profileDependencies(async (_input, init) => {
      const query = JSON.parse(String(init?.body)) as CommerceQuery;
      assert.equal(query.kind, 'delivery_order');
      return Response.json([
        { document: { name: 'projects/mons-shop/databases/(default)/documents/drops/a/deliveryOrders/1', fields: { owner: stringValue(OWNER) } } },
        { document: { name: 'projects/mons-shop/databases/(default)/documents/drops/a/deliveryOrders/2', fields: { owner: stringValue(OTHER) } } },
      ]);
    }, {
      resolveD1WalletSession: async () => ({ wallet: ADMIN, source: 'session' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.deepEqual(await owners.response.json(), { owners: [OWNER, OTHER], nextCursor: null, hasMore: false });

  const fulfillment = await handleProfileReadRequest(
    tokenRequest(FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2', limit: 2, cursor: null }),
    env,
    FULFILLMENT_ORDERS_PATH,
    profileDependencies(async (_input, init) => {
      const query = JSON.parse(String(init?.body)) as CommerceQuery;
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
      resolveD1WalletSession: async () => ({ wallet: ADMIN, source: 'session' }),
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

  const manual = await handleProfileReadRequest(
    tokenRequest(FULFILLMENT_MANUAL_REVIEW_PATH, { dropId: 'card_nft_2' }),
    env,
    FULFILLMENT_MANUAL_REVIEW_PATH,
    profileDependencies(async (input, init) => {
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
          uid: stringValue(OWNER),
          quantity: integerValue(2),
          stripeSessionSummary: { mapValue: { fields: { amount_total: integerValue(4200), currency: stringValue('usd') } } },
        },
      } }]);
    }, {
      resolveD1WalletSession: async () => ({ wallet: ADMIN, source: 'session' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.deepEqual(await manual.response.json(), {
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

test('all seven commerce read routes use D1 without Firestore in d1 mode', async () => {
  const order = orderDocument();
  (order.fields as Record<string, unknown>).buyerOrderShippedEmailState = stringValue('pending');
  const checkout = {
    name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/stripeCheckouts/cs_test_review',
    fields: {
      manualRefundReviewRequired: { booleanValue: true },
      status: stringValue('fulfillment_failed'),
      sessionId: stringValue('cs_test_review'),
      owner: stringValue(OWNER),
      quantity: integerValue(2),
    },
  };
  const modelRow = (document: typeof order | typeof checkout, kind: 'delivery_order' | 'stripe_checkout') => ({
    document_path: document.name.split('/documents/')[1],
    document_kind: kind,
    drop_id: 'card_nft_2',
    document_id: document.name.split('/').at(-1),
    fields_json: JSON.stringify(document.fields),
    document_json: JSON.stringify(decodeFirestoreFields(document.fields)),
    version: 1,
    create_time: '2026-08-18T10:00:00Z',
    update_time: '2026-08-18T12:00:00Z',
    processed_at_seconds: kind === 'delivery_order' ? 1_787_050_800 : null,
    processed_at_nanos: kind === 'delivery_order' ? 0 : null,
  });
  const db = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        first: async () => sql.includes('commerce_authority_control')
          ? { authority_state: 'd1', revision: 2, documents_revision: 0 }
          : null,
        all: async () => ({
          success: true,
          meta: {},
          results: bindings[0] === 'stripe_checkout'
            ? [modelRow(checkout, 'stripe_checkout')]
            : [modelRow(order, 'delivery_order')],
        }),
      };
      return statement;
    },
  } as unknown as D1Database;
  const env = {
    COMMERCE_DB: db,
    ADDRESS_DECRYPTION_SECRET: '',
    OPS_DB: {} as D1Database,
    STRIPE_SECRET_KEY: 'sk_test_primary',
  };
  let firestoreCalls = 0;
  const providerFetch: typeof fetch = async (input) => {
    if (String(input).includes('firestore.googleapis.com')) {
      firestoreCalls += 1;
      throw new Error('D1 route reached Firestore');
    }
    return Response.json({});
  };
  const anonymousDependencies = profileDependencies(providerFetch, {
    createCommerceRepository: (database) => new D1CommerceRepository(database),
  });
  const staffDependencies = profileDependencies(providerFetch, {
    loadProfileEmail: async () => 'owner@example.com',
    resolveD1WalletSession: async () => ({ wallet: ADMIN, source: 'session' }),
    createCommerceRepository: (database) => new D1CommerceRepository(database),
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
  });
  const calls: Array<[ProfileReadPath, unknown, Parameters<typeof handleProfileReadRequest>[3]]> = [
    [PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }, anonymousDependencies],
    [PROFILE_STATE_PATH, {}, anonymousDependencies],
    [ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, {}, anonymousDependencies],
    [ADMIN_PROFILE_PATH, { ownerWallet: OWNER }, staffDependencies],
    [ADMIN_DELIVERY_ORDER_OWNERS_PATH, { pageSize: 2 }, staffDependencies],
    [FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2', limit: 2, cursor: null }, staffDependencies],
    [FULFILLMENT_MANUAL_REVIEW_PATH, { dropId: 'card_nft_2' }, staffDependencies],
  ];
  for (const [path, body, dependencies] of calls) {
    const result = await handleProfileReadRequest(tokenRequest(path, body), env, path, dependencies);
    assert.equal(result.response.status, 200, path);
    const payload = await result.response.json();
    if (path === FULFILLMENT_ORDERS_PATH) {
      assert.doesNotMatch(JSON.stringify(payload), /buyerOrderShippedEmailState/);
    }
  }
  assert.equal(firestoreCalls, 0);
});

test('commerce authority failures fail closed without a provider fallback', async () => {
  let providerCalls = 0;
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
    {
      COMMERCE_DB: {} as D1Database,
    },
    PROFILE_SHIPMENTS_PATH,
    profileDependencies(async () => {
      providerCalls += 1;
      return Response.json([{ document: orderDocument() }]);
    }, { createCommerceRepository: (database) => new D1CommerceRepository(database) }),
  );
  assert.equal(result.response.status, 503);
  assert.equal(providerCalls, 0);
});
