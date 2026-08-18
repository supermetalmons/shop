import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FULFILLMENT_ORDER_STATUS_PATH,
  PROFILE_ADDRESSES_PATH,
  handleProfileWriteRequest,
  profileWriteTestHooks,
} from '../src/profileWrites.ts';
import type {
  GoogleAccessTokenProvider,
  ProfileProviderFetch,
} from '../src/firestoreRest.ts';
import { FirebaseIdTokenError } from '../src/firebaseIdToken.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const OTHER = 'So11111111111111111111111111111111111111112';
const UID = 'firebase-user-one';
const NOW_MS = Date.parse('2026-08-18T12:00:00.000Z');
const ADDRESS_ID = 'AbCdEfGhIjKlMnOpQrSt';

function stringValue(value: string) {
  return { stringValue: value };
}

function sessionDocument(wallet: string) {
  return {
    name: `projects/mons-shop/databases/(default)/documents/authSessions/${UID}`,
    fields: { wallet: stringValue(wallet) },
  };
}

function request(path: typeof PROFILE_ADDRESSES_PATH | typeof FULFILLMENT_ORDER_STATUS_PATH, body: unknown): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer firebase-token',
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify(body),
  });
}

function accessTokenProvider(onInvalidate: () => void = () => undefined): GoogleAccessTokenProvider {
  return {
    invalidate: onInvalidate,
    get: async () => 'writer-access-token',
  };
}

function dependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Partial<Parameters<typeof handleProfileWriteRequest>[3]> = {},
): Parameters<typeof handleProfileWriteRequest>[3] {
  return {
    accessTokenProvider: accessTokenProvider(),
    autoId: () => ADDRESS_ID,
    nowMs: () => NOW_MS,
    providerFetch,
    timeoutMs: 500,
    verifyIdToken: async () => ({ uid: UID }),
    ...overrides,
  };
}

const env = { FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: 'writer-service-account' };

test('address route authenticates and atomically commits the exact address and profile writes', async () => {
  let commit: Record<string, unknown> | undefined;
  const calls: Array<{ url: URL; authorization: string }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') || '' });
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/documents:commit')) {
      commit = JSON.parse(String(init?.body));
      return Response.json({ writeResults: [{}, {}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'cipher-text',
      country: 'United States',
      hint: '100…01',
      email: 'owner@example.com',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('cache-control') || '', /no-store/);
  assert.deepEqual(await result.response.json(), {
    id: ADDRESS_ID,
    country: 'United States',
    countryCode: 'US',
    encrypted: 'cipher-text',
    hint: '100…01',
    email: 'owner@example.com',
  });
  assert.deepEqual(commit, {
    writes: [
      {
        update: {
          name: `projects/mons-shop/databases/(default)/documents/profiles/${OWNER}/addresses/${ADDRESS_ID}`,
          fields: {
            encrypted: stringValue('cipher-text'),
            country: stringValue('United States'),
            hint: stringValue('100…01'),
            id: stringValue(ADDRESS_ID),
            countryCode: stringValue('US'),
            email: stringValue('owner@example.com'),
          },
        },
        updateMask: { fieldPaths: ['encrypted', 'country', 'hint', 'id', 'countryCode', 'email'] },
        updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
      },
      {
        update: {
          name: `projects/mons-shop/databases/(default)/documents/profiles/${OWNER}`,
          fields: { wallet: stringValue(OWNER), email: stringValue('owner@example.com') },
        },
        updateMask: { fieldPaths: ['wallet', 'email'] },
      },
    ],
  });
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.metrics.upstreamCalls, 2);
  assert.ok(calls.every((call) => call.authorization === 'Bearer writer-access-token'));
});

test('address commit retries with one stable auto ID after writer token rejection', async () => {
  let commitAttempts = 0;
  let autoIds = 0;
  let invalidations = 0;
  const bodies: string[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/documents:commit')) {
      commitAttempts += 1;
      bodies.push(String(init?.body));
      if (commitAttempts === 1) return Response.json({ error: 'expired' }, { status: 401 });
      return Response.json({ writeResults: [{}, {}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'cipher-text',
      country: 'US',
      countryCode: 'US',
      hint: 'hint',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    dependencies(providerFetch, {
      accessTokenProvider: accessTokenProvider(() => {
        invalidations += 1;
      }),
      autoId: () => {
        autoIds += 1;
        return ADDRESS_ID;
      },
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(commitAttempts, 2);
  assert.equal(autoIds, 1);
  assert.equal(invalidations, 1);
  assert.equal(bodies[0], bodies[1]);
});

test('status route preserves, replaces, and deletes tracking fields with exact update masks', async () => {
  const cases = [
    {
      body: { dropId: 'card_nft_2', deliveryId: 7, status: 'Preparing' },
      expectedFields: {
        dropId: stringValue('card_nft_2'),
        fulfillmentUpdatedBy: stringValue(OWNER),
        fulfillmentStatus: stringValue('Preparing'),
      },
      expectedMask: ['dropId', 'fulfillmentUpdatedBy', 'fulfillmentStatus'],
      expectedResponse: {
        deliveryId: 7,
        fulfillmentStatus: 'Preparing',
        fulfillmentTrackingCode: 'https://tracking.example/old',
      },
    },
    {
      body: { dropId: 'card_nft_2', deliveryId: 7, status: 'Shipped', trackingCode: '  https://tracking.example/new  ' },
      expectedFields: {
        dropId: stringValue('card_nft_2'),
        fulfillmentUpdatedBy: stringValue(OWNER),
        fulfillmentStatus: stringValue('Shipped'),
        fulfillmentTrackingCode: stringValue('https://tracking.example/new'),
      },
      expectedMask: ['dropId', 'fulfillmentUpdatedBy', 'fulfillmentStatus', 'fulfillmentTrackingCode'],
      expectedResponse: {
        deliveryId: 7,
        fulfillmentStatus: 'Shipped',
        fulfillmentTrackingCode: 'https://tracking.example/new',
      },
    },
    {
      body: { dropId: 'card_nft_2', deliveryId: 7, status: 'Shipped', trackingCode: '   ' },
      expectedFields: {
        dropId: stringValue('card_nft_2'),
        fulfillmentUpdatedBy: stringValue(OWNER),
        fulfillmentStatus: stringValue('Shipped'),
      },
      expectedMask: ['dropId', 'fulfillmentUpdatedBy', 'fulfillmentStatus', 'fulfillmentTrackingCode'],
      expectedResponse: { deliveryId: 7, fulfillmentStatus: 'Shipped' },
    },
    {
      body: { dropId: 'card_nft_2', deliveryId: 7, status: null },
      expectedFields: {
        dropId: stringValue('card_nft_2'),
        fulfillmentUpdatedBy: stringValue(OWNER),
      },
      expectedMask: ['dropId', 'fulfillmentUpdatedBy', 'fulfillmentStatus'],
      expectedResponse: {
        deliveryId: 7,
        fulfillmentStatus: '',
        fulfillmentTrackingCode: 'https://tracking.example/old',
      },
    },
  ] as const;
  for (const entry of cases) {
    let commit: { writes: Array<Record<string, unknown>> } | undefined;
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        assert.deepEqual(url.searchParams.getAll('mask.fieldPaths'), ['fulfillmentTrackingCode']);
        return Response.json({ fields: { fulfillmentTrackingCode: stringValue(' https://tracking.example/old ') } });
      }
      if (url.pathname.endsWith('/documents:commit')) {
        commit = JSON.parse(String(init?.body));
        return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_ORDER_STATUS_PATH, entry.body),
      env,
      FULFILLMENT_ORDER_STATUS_PATH,
      dependencies(providerFetch),
    );
    assert.equal(result.response.status, 200);
    assert.deepEqual(await result.response.json(), entry.expectedResponse);
    assert.deepEqual(commit?.writes[0], {
      update: {
        name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
        fields: entry.expectedFields,
      },
      updateMask: { fieldPaths: entry.expectedMask },
      updateTransforms: [{ fieldPath: 'fulfillmentUpdatedAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: true },
    });
  }
});

test('write routes reject invalid payloads, unauthorized wallets, missing orders, and missing writer configuration', async () => {
  let upstreamCalls = 0;
  const neverFetch: typeof fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  for (const body of [
    { encrypted: 'cipher', country: 'US', hint: 'hint', extra: true },
    { encrypted: 'cipher', country: 'US', hint: 'hint', email: 'not-an-email' },
    { encrypted: 'x'.repeat(11 * 1024), country: 'US', hint: 'hint' },
  ]) {
    const result = await handleProfileWriteRequest(
      request(PROFILE_ADDRESSES_PATH, body),
      env,
      PROFILE_ADDRESSES_PATH,
      dependencies(neverFetch),
    );
    assert.equal(result.response.status, 400);
  }
  assert.equal(upstreamCalls, 0);

  const invalidToken = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, { encrypted: 'cipher', country: 'US', hint: 'hint' }),
    env,
    PROFILE_ADDRESSES_PATH,
    dependencies(neverFetch, {
      verifyIdToken: async () => {
        throw new FirebaseIdTokenError('invalid-token');
      },
    }),
  );
  assert.equal(invalidToken.response.status, 401);
  assert.equal(upstreamCalls, 0);

  const missingSecret = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, { encrypted: 'cipher', country: 'US', hint: 'hint' }),
    { FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: '' },
    PROFILE_ADDRESSES_PATH,
    dependencies(neverFetch),
  );
  assert.equal(missingSecret.response.status, 503);
  assert.equal(upstreamCalls, 0);

  let commits = 0;
  const deniedFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OTHER));
    if (url.pathname.endsWith('/deliveryOrders/7')) return Response.json({ fields: {} });
    if (url.pathname.endsWith('/documents:commit')) commits += 1;
    return Response.json({ writeResults: [] });
  };
  const denied = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, { dropId: 'card_nft_2', deliveryId: 7, status: 'Preparing' }),
    env,
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(deniedFetch),
  );
  assert.equal(denied.response.status, 403);
  assert.equal(commits, 0);

  const missingOrderFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) return new Response(null, { status: 404 });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const missingOrder = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, { dropId: 'card_nft_2', deliveryId: 7, status: 'Preparing' }),
    env,
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(missingOrderFetch),
  );
  assert.equal(missingOrder.response.status, 404);
});

test('writer failures stay generic and never expose request or credential material', async () => {
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/documents:commit')) return Response.json({ error: 'writer-secret' }, { status: 403 });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'private-cipher-text',
      country: 'US',
      hint: 'private-hint',
      email: 'private@example.com',
    }),
    { FIRESTORE_WRITER_SERVICE_ACCOUNT_JSON: 'private-writer-credential' },
    PROFILE_ADDRESSES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 502);
  const text = await result.response.text();
  assert.deepEqual(JSON.parse(text), {
    ok: false,
    error: { code: 'unavailable', message: 'Profile data is temporarily unavailable.' },
  });
  for (const secret of ['private-cipher-text', 'private-hint', 'private@example.com', 'private-writer-credential', 'writer-secret']) {
    assert.equal(text.includes(secret), false);
  }
});

test('generated Firestore auto IDs are cryptographic-compatible document IDs', () => {
  const ids = Array.from({ length: 100 }, () => profileWriteTestHooks.firestoreAutoId());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[A-Za-z0-9]{20}$/.test(id)));
});
