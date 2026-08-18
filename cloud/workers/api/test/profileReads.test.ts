import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SignJWT,
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
} from 'jose';
import {
  FirebaseIdTokenError,
  createFirebaseIdTokenVerifier,
} from '../src/firebaseIdToken.ts';
import {
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
  ProfileReadError,
  createGoogleAccessTokenProvider,
  handleProfileReadRequest,
  type GoogleAccessTokenProvider,
  type ProfileProviderFetch,
  type ProfileReadPath,
} from '../src/profileReads.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const OTHER = 'So11111111111111111111111111111111111111112';
const UID = 'firebase-user-one';
const NOW_MS = Date.parse('2026-08-18T12:00:00.000Z');
const CERTIFICATE = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n';

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

function sessionDocument(wallet: string) {
  return {
    name: `projects/mons-shop/databases/(default)/documents/authSessions/${UID}`,
    fields: { wallet: stringValue(wallet) },
  };
}

function accessTokenProvider(): GoogleAccessTokenProvider {
  return {
    invalidate: () => undefined,
    get: async () => 'google-access-token',
  };
}

function profileDependencies(
  providerFetch: ProfileProviderFetch,
): Parameters<typeof handleProfileReadRequest>[3] {
  return {
    accessTokenProvider: accessTokenProvider(),
    nowMs: () => NOW_MS,
    providerFetch,
    timeoutMs: 500,
    verifyIdToken: async () => ({ uid: UID }),
  };
}

async function signedFirebaseToken(args: {
  privateKey: CryptoKey;
  kid?: string;
  issuer?: string;
  audience?: string;
  issuedAt?: number;
  authTime?: number;
  expirationTime?: number;
  subject?: string;
}): Promise<string> {
  const nowSeconds = Math.floor(NOW_MS / 1000);
  return new SignJWT({ auth_time: args.authTime ?? nowSeconds - 30 })
    .setProtectedHeader({ alg: 'RS256', kid: args.kid ?? 'test-kid' })
    .setIssuer(args.issuer ?? 'https://securetoken.google.com/mons-shop')
    .setAudience(args.audience ?? 'mons-shop')
    .setSubject(args.subject ?? UID)
    .setIssuedAt(args.issuedAt ?? nowSeconds - 30)
    .setExpirationTime(args.expirationTime ?? nowSeconds + 3600)
    .sign(args.privateKey);
}

test('Firebase token verifier validates claims, signatures, and certificate caching', async () => {
  const signing = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256', { extractable: true });
  let certificateFetches = 0;
  const providerFetch: typeof fetch = async () => {
    certificateFetches += 1;
    return Response.json(
      { 'test-kid': CERTIFICATE },
      { headers: { 'Cache-Control': 'public, max-age=3600' } },
    );
  };
  const verifier = createFirebaseIdTokenVerifier(async () => signing.publicKey);
  const token = await signedFirebaseToken({ privateKey: signing.privateKey });
  assert.deepEqual(await verifier(`Bearer ${token}`, providerFetch, new AbortController().signal, NOW_MS), { uid: UID });
  assert.deepEqual(await verifier(`Bearer ${token}`, providerFetch, new AbortController().signal, NOW_MS + 1000), { uid: UID });
  assert.equal(certificateFetches, 1);

  const unknownKid = await signedFirebaseToken({ privateKey: signing.privateKey, kid: 'unknown-kid' });
  await assert.rejects(
    verifier(`Bearer ${unknownKid}`, providerFetch, new AbortController().signal, NOW_MS + 2000),
    (error) => error instanceof FirebaseIdTokenError && error.kind === 'invalid-token',
  );
  assert.equal(certificateFetches, 1);

  for (const invalidToken of [
    await signedFirebaseToken({ privateKey: other.privateKey }),
    await signedFirebaseToken({ privateKey: signing.privateKey, audience: 'other-project' }),
    await signedFirebaseToken({ privateKey: signing.privateKey, issuer: 'https://securetoken.google.com/other-project' }),
    await signedFirebaseToken({ privateKey: signing.privateKey, expirationTime: Math.floor(NOW_MS / 1000) - 10 }),
    await signedFirebaseToken({ privateKey: signing.privateKey, issuedAt: Math.floor(NOW_MS / 1000) + 10 }),
    await signedFirebaseToken({ privateKey: signing.privateKey, authTime: Math.floor(NOW_MS / 1000) + 10 }),
    await signedFirebaseToken({ privateKey: signing.privateKey, subject: '' }),
  ]) {
    await assert.rejects(
      verifier(`Bearer ${invalidToken}`, providerFetch, new AbortController().signal, NOW_MS),
      (error) => error instanceof FirebaseIdTokenError && error.kind === 'invalid-token',
    );
  }
  for (const authorization of [null, '', 'Basic token', 'Bearer', 'Bearer token extra']) {
    await assert.rejects(
      verifier(authorization, providerFetch, new AbortController().signal, NOW_MS),
      (error) => error instanceof FirebaseIdTokenError && error.kind === 'invalid-token',
    );
  }
});

test('Firebase token verifier distinguishes certificate-provider failures from invalid tokens', async () => {
  const signing = await generateKeyPair('RS256', { extractable: true });
  const token = await signedFirebaseToken({ privateKey: signing.privateKey });
  const verifier = createFirebaseIdTokenVerifier(async () => signing.publicKey);
  await assert.rejects(
    verifier(
      `Bearer ${token}`,
      async () => Response.json({ error: 'unavailable' }, { status: 503 }),
      new AbortController().signal,
      NOW_MS,
    ),
    (error) => error instanceof FirebaseIdTokenError && error.kind === 'provider-unavailable',
  );
});

test('Google access-token provider signs the exact datastore assertion and caches its token', async () => {
  const signing = await generateKeyPair('RS256', { extractable: true });
  const privateKey = await exportPKCS8(signing.privateKey);
  const serviceAccount = JSON.stringify({
    project_id: 'mons-shop',
    client_email: 'mons-shop-cloudflare-reader@mons-shop.iam.gserviceaccount.com',
    private_key: `${privateKey.trim()}\n`,
  });
  const assertions: string[] = [];
  const providerFetch: typeof fetch = async (_input, init) => {
    const form = new URLSearchParams(String(init?.body));
    assertions.push(String(form.get('assertion')));
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    return Response.json({ access_token: 'access-token', token_type: 'Bearer', expires_in: 3600 });
  };
  const provider = createGoogleAccessTokenProvider();
  assert.equal(await provider.get(serviceAccount, providerFetch, new AbortController().signal, NOW_MS), 'access-token');
  assert.equal(await provider.get(serviceAccount, providerFetch, new AbortController().signal, NOW_MS + 1000), 'access-token');
  assert.equal(assertions.length, 1);
  const header = decodeProtectedHeader(assertions[0]);
  const claims = decodeJwt(assertions[0]);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(claims.iss, 'mons-shop-cloudflare-reader@mons-shop.iam.gserviceaccount.com');
  assert.equal(claims.sub, claims.iss);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore');
  provider.invalidate();
  await provider.get(serviceAccount, providerFetch, new AbortController().signal, NOW_MS + 2000);
  assert.equal(assertions.length, 2);
});

test('shipment and anonymous history routes preserve exact source-query behavior', async () => {
  const queries: Record<string, unknown>[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/documents:runQuery')) {
      queries.push(JSON.parse(String(init?.body)));
      return Response.json([{ document: orderDocument() }]);
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const shipments = await handleProfileReadRequest(
    tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
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
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
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
  assert.equal(serialized.every((query) => query.includes('deliveryOrders') && query.includes('ready_to_ship')), true);
});

test('profile state derives identity server-side and returns independently bounded sections', async () => {
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    PROFILE_STATE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.includes('/authSessions/')) return Response.json(sessionDocument(OWNER));
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
    }),
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

test('profile state returns a settled empty session and preserves legacy wallet UIDs', async () => {
  const missing = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    PROFILE_STATE_PATH,
    profileDependencies(async (input) => {
      assert.match(String(input), /authSessions/);
      return Response.json({ error: 'missing' }, { status: 404 });
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
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    PROFILE_STATE_PATH,
    {
      ...profileDependencies(async (input) => {
        const url = String(input);
        if (url.includes('/authSessions/')) return Response.json({ error: 'missing' }, { status: 404 });
        if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'missing' }, { status: 404 });
        if (url.endsWith('/documents:runQuery')) return Response.json([]);
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
      verifyIdToken: async () => ({ uid: OWNER }),
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
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    PROFILE_STATE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.includes('/authSessions/')) return Response.json(sessionDocument(OWNER));
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'busy' }, { status: 503 });
      if (url.endsWith('/documents:runQuery')) return Response.json([{ document: orderDocument() }]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
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

test('profile state rejects malformed session documents and non-empty requests', async () => {
  const malformedSession = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    PROFILE_STATE_PATH,
    profileDependencies(async () => Response.json({ fields: { wallet: stringValue('invalid') } })),
  );
  assert.equal(malformedSession.response.status, 401);

  const invalidBody = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, { ownerWallet: OWNER }),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    PROFILE_STATE_PATH,
    profileDependencies(async () => assert.fail('invalid request reached provider')),
  );
  assert.equal(invalidBody.response.status, 400);
});

test('shipment route rejects mismatched sessions and malformed requests before source queries', async () => {
  let queries = 0;
  const providerFetch: typeof fetch = async (input) => {
    if (String(input).includes('/authSessions/')) return Response.json(sessionDocument(OTHER));
    queries += 1;
    return Response.json([]);
  };
  const mismatch = await handleProfileReadRequest(
    tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    PROFILE_SHIPMENTS_PATH,
    profileDependencies(providerFetch),
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
      { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
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
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    PROFILE_SHIPMENTS_PATH,
    {
      ...profileDependencies(async (input, init) => {
        if (String(input).includes('/authSessions/')) return Response.json({ error: 'missing' }, { status: 404 });
        const body = JSON.stringify(JSON.parse(String(init?.body)));
        const match = body.match(/"stringValue":"([1-9A-HJ-NP-Za-km-z]+)"/);
        if (match?.[1]) owners.push(match[1]);
        return Response.json([]);
      }),
      verifyIdToken: async () => ({ uid: OWNER }),
    },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { responseMode: 'shipments', wallet: OWNER, orders: [] });
  assert.deepEqual(owners, [OWNER]);
});

test('admin profile route enforces the existing wallet allowlist and returns canonical delivery summaries', async () => {
  const denied = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    ADMIN_PROFILE_PATH,
    profileDependencies(async (input) => {
      if (String(input).includes('/authSessions/')) return Response.json(sessionDocument(OTHER));
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.equal((await denied.response.json() as { error: { code: string } }).error.code, 'permission-denied');

  const accepted = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    ADMIN_PROFILE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.includes('/authSessions/')) return Response.json(sessionDocument(ADMIN));
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ fields: { email: stringValue('owner@example.com') } });
      if (url.endsWith('/documents:runQuery')) return Response.json([{ document: orderDocument() }]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
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
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    ADMIN_PROFILE_PATH,
    profileDependencies(async (input) => {
      const url = String(input);
      if (url.includes('/authSessions/')) return Response.json(sessionDocument(ADMIN));
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'missing' }, { status: 404 });
      if (url.endsWith('/documents:runQuery')) return Response.json([]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  assert.equal(missingProfile.response.status, 200);
  assert.deepEqual(await missingProfile.response.json(), { profile: { wallet: OWNER, orders: [] } });
});

test('admin and fulfillment read routes preserve access, pagination, masking, and Stripe fallback', async () => {
  const env = {
    FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account',
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
    profileDependencies(async (input, init) => {
      const url = String(input);
      if (url.includes('/authSessions/')) return Response.json(sessionDocument(ADMIN));
      const query = JSON.parse(String(init?.body));
      assert.equal(query.structuredQuery.from[0].collectionId, 'deliveryOrders');
      return Response.json([
        { document: { name: 'projects/mons-shop/databases/(default)/documents/drops/a/deliveryOrders/1', fields: { owner: stringValue(OWNER) } } },
        { document: { name: 'projects/mons-shop/databases/(default)/documents/drops/a/deliveryOrders/2', fields: { owner: stringValue(OTHER) } } },
      ]);
    }),
  );
  assert.deepEqual(await owners.response.json(), { owners: [OWNER, OTHER], nextCursor: null, hasMore: false });

  const fulfillment = await handleProfileReadRequest(
    tokenRequest(FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2', limit: 2, cursor: null }),
    env,
    FULFILLMENT_ORDERS_PATH,
    profileDependencies(async (input, init) => {
      const url = String(input);
      if (url.includes('/authSessions/')) return Response.json(sessionDocument(ADMIN));
      const query = JSON.parse(String(init?.body));
      assert.equal(query.structuredQuery.limit, 3);
      return Response.json([{ document: {
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
        fields: {
          deliveryId: integerValue(7),
          owner: stringValue(OWNER),
          status: stringValue('ready_to_ship'),
          processedAt: { timestampValue: '2026-08-18T11:00:00.123456789Z' },
          addressSnapshot: { mapValue: { fields: { encrypted: stringValue('private.payload.value'), email: stringValue('owner@example.com') } } },
          items: { arrayValue: {} },
        },
      } }]);
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
      if (url.includes('/authSessions/')) return Response.json(sessionDocument(ADMIN));
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
          quantity: integerValue(2),
          stripeSessionSummary: { mapValue: { fields: { amount_total: integerValue(4200), currency: stringValue('usd') } } },
        },
      } }]);
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

test('Firestore reads refresh once after 401, retry transient failures, and remain bounded', async () => {
  let gets = 0;
  let invalidations = 0;
  const accessProvider: GoogleAccessTokenProvider = {
    get: async () => {
      gets += 1;
      return `token-${gets}`;
    },
    invalidate: () => {
      invalidations += 1;
    },
  };
  let calls = 0;
  const response = await handleProfileReadRequest(
    tokenRequest(ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, {}),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
    {
      ...profileDependencies(async () => {
        calls += 1;
        return calls === 1 ? Response.json({ error: 'expired' }, { status: 401 }) : Response.json([]);
      }),
      accessTokenProvider: accessProvider,
    },
  );
  assert.equal(response.response.status, 200);
  assert.equal(gets, 2);
  assert.equal(invalidations, 1);

  let transientCalls = 0;
  const transient = await handleProfileReadRequest(
    tokenRequest(ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, {}),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
    profileDependencies(async () => {
      transientCalls += 1;
      return transientCalls === 1
        ? Response.json({ error: 'busy' }, { status: 503 })
        : Response.json([]);
    }),
  );
  assert.equal(transient.response.status, 200);
  assert.equal(transientCalls, 2);

  const oversized = await handleProfileReadRequest(
    tokenRequest(ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, {}),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
    profileDependencies(async () => new Response('[]', {
      headers: {
        'Content-Length': String(16 * 1024 * 1024 + 1),
        'Content-Type': 'application/json',
      },
    })),
  );
  assert.equal(oversized.response.status, 502);
  assert.equal((await oversized.response.json() as { error: { code: string } }).error.code, 'unavailable');
});

test('profile reads convert an overall provider deadline to a stable timeout', async () => {
  const result = await handleProfileReadRequest(
    tokenRequest(ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, {}),
    { FIRESTORE_SERVICE_ACCOUNT_JSON: 'test-service-account' },
    ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
    {
      ...profileDependencies(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })),
      timeoutMs: 1,
    },
  );
  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
});

test('invalid service-account material fails closed before Firestore access', async () => {
  const provider = createGoogleAccessTokenProvider();
  await assert.rejects(
    provider.get('{}', async () => assert.fail('invalid credential reached OAuth'), new AbortController().signal, NOW_MS),
    (error) => error instanceof ProfileReadError && error.status === 503,
  );
});
