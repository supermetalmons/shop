import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import {
  FULFILLMENT_ORDER_ADDRESS_PATH,
  FULFILLMENT_ORDER_STATUS_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PATH,
  PROFILE_ADDRESSES_PATH,
  handleProfileWriteRequest,
  profileWriteTestHooks,
  type ProfileWritePath,
} from '../src/profileWrites.ts';
import {
  decryptAddressCipherText,
  parseAddressCipherPayload,
} from '../../../../functions/src/shared/addressCipher.ts';
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
const ADDRESS_KEY_PAIR = nacl.box.keyPair();
const ADDRESS_SECRET = Buffer.from(ADDRESS_KEY_PAIR.secretKey).toString('base64');

function stringValue(value: string) {
  return { stringValue: value };
}

function sessionDocument(wallet: string) {
  return {
    name: `projects/mons-shop/databases/(default)/documents/authSessions/${UID}`,
    fields: { wallet: stringValue(wallet) },
  };
}

function request(path: ProfileWritePath, body: unknown): Request {
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
const fulfillmentEnv = {
  ...env,
  ADDRESS_DECRYPTION_SECRET: ADDRESS_SECRET,
  SHIPSTATION_API_KEY: 'shipstation-api-key',
};

function firestoreValue(value: unknown): unknown {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (value && typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, firestoreValue(entry)])),
      },
    };
  }
  return { nullValue: null };
}

function orderDocument(fields: Record<string, unknown>, updateTime = '2026-08-18T12:00:00.000000Z') {
  return {
    name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, firestoreValue(value)])),
    updateTime,
  };
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

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

test('fulfillment address route encrypts the address and conditionally clears stale ShipStation rates', async () => {
  let commit: { writes: Array<Record<string, unknown>> } | undefined;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        addressSnapshot: {
          label: 'Home',
          email: 'owner@example.com',
          phone: '+15555550123',
          country: 'United States',
          countryCode: 'US',
        },
        shipstation: {},
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commit = JSON.parse(String(init?.body));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const full = '界'.repeat(2048);
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full }),
    fulfillmentEnv,
    FULFILLMENT_ORDER_ADDRESS_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    deliveryId: number;
    address: { encrypted: string; hint: string; full: string; label?: string; email?: string; phone?: string; country?: string; countryCode?: string };
  };
  assert.equal(payload.deliveryId, 7);
  assert.equal(payload.address.full, full);
  assert.equal(payload.address.hint, '界...界界');
  assert.equal(payload.address.label, 'Home');
  assert.equal(payload.address.email, 'owner@example.com');
  assert.equal(payload.address.phone, '+15555550123');
  assert.equal(payload.address.country, 'United States');
  assert.equal(payload.address.countryCode, 'US');
  const cipher = parseAddressCipherPayload(payload.address.encrypted, decodeBase64);
  assert.ok(cipher);
  assert.equal(decryptAddressCipherText(cipher, ADDRESS_KEY_PAIR.secretKey), full);
  const write = commit?.writes[0] as {
    currentDocument: { updateTime: string };
    update: { fields: { addressSnapshot: { mapValue: { fields: Record<string, { stringValue: string }> } } } };
    updateMask: { fieldPaths: string[] };
    updateTransforms: unknown[];
  };
  assert.equal(write.currentDocument.updateTime, '2026-08-18T12:00:00.000000Z');
  assert.equal(write.update.fields.addressSnapshot.mapValue.fields.encrypted.stringValue, payload.address.encrypted);
  assert.deepEqual(write.updateMask.fieldPaths, [
    'addressSnapshot.encrypted',
    'addressSnapshot.hint',
    'fulfillmentAddressUpdatedBy',
    'shipstation.rateQuotes',
    'shipstation.ratesClaimedAt',
    'shipstation.ratesClaimedBy',
  ]);
  assert.deepEqual(write.updateTransforms, [
    { fieldPath: 'fulfillmentAddressUpdatedAt', setToServerValue: 'REQUEST_TIME' },
  ]);
});

test('fulfillment address route retries the full read and validation after a Firestore precondition conflict', async () => {
  let reads = 0;
  let commits = 0;
  const updateTimes: string[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      reads += 1;
      return Response.json(orderDocument(
        { addressSnapshot: {}, shipstation: {} },
        `2026-08-18T12:00:0${reads}.000000Z`,
      ));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits += 1;
      const body = JSON.parse(String(init?.body)) as { writes: Array<{ currentDocument: { updateTime: string } }> };
      updateTimes.push(body.writes[0].currentDocument.updateTime);
      if (commits === 1) {
        return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:02Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_ADDRESS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      full: 'Ivan\n100 Main St\nIstanbul, 34000\nTurkey',
    }),
    fulfillmentEnv,
    FULFILLMENT_ORDER_ADDRESS_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.equal(reads, 2);
  assert.equal(commits, 2);
  assert.deepEqual(updateTimes, [
    '2026-08-18T12:00:01.000000Z',
    '2026-08-18T12:00:02.000000Z',
  ]);
});

test('fulfillment address route preserves authorization and order-state guards', async () => {
  const adminWallet = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
  let providerCalls = 0;
  const denied = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full: 'address' }),
    fulfillmentEnv,
    FULFILLMENT_ORDER_ADDRESS_PATH,
    dependencies(async (input) => {
      providerCalls += 1;
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(adminWallet));
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.equal((await denied.response.json() as { error: { code: string } }).error.code, 'permission-denied');
  assert.equal(providerCalls, 1);

  for (const [orderFields, code] of [
    [{ addressSnapshot: {}, shipstation: { shipmentId: 'shipment-1' } }, 'failed-precondition'],
    [{ addressSnapshot: {}, shipstation: { labelPurchase: { status: 'purchasing' } } }, 'aborted'],
    [{
      addressSnapshot: {},
      shipstation: { label: { labelId: 'label-1', shipmentId: 'shipment-1', status: 'completed' } },
    }, 'failed-precondition'],
    [{ addressSnapshot: {}, shipstation: { ratesClaimedAt: NOW_MS - 1000 } }, 'aborted'],
    [{ addressSnapshot: {}, shipstation: {}, source: 'admin_irl_redeem' }, 'failed-precondition'],
  ] as const) {
    const guarded = await handleProfileWriteRequest(
      request(FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full: 'address' }),
      fulfillmentEnv,
      FULFILLMENT_ORDER_ADDRESS_PATH,
      dependencies(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
        if (url.pathname.endsWith('/deliveryOrders/7')) {
          return Response.json(orderDocument(orderFields));
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    );
    assert.equal(guarded.response.status, 409);
    assert.equal((await guarded.response.json() as { error: { code: string } }).error.code, code);
  }
});

test('ShipStation label route refreshes and conditionally persists an active stored label', async () => {
  let orderReads = 0;
  let commit: { writes: Array<Record<string, unknown>> } | undefined;
  const storedLabel = {
    labelId: 'label-1',
    shipmentId: 'shipment-1',
    status: 'processing',
    trackingNumber: 'old-tracking',
    purchasedAt: NOW_MS - 1000,
  };
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      assert.equal(url.pathname, '/v2/labels/label-1');
      assert.equal(url.searchParams.get('label_download_type'), 'url');
      assert.equal(new Headers(init?.headers).get('api-key'), 'shipstation-api-key');
      return Response.json({
        label: {
          label_id: 'label-1',
          shipment_id: 'shipment-1',
          status: 'completed',
          tracking_number: 'new-tracking',
          created_at: '2026-08-18T11:59:00.000Z',
          shipment_cost: { currency: 'usd', amount: 10 },
          insurance_cost: { currency: 'usd', amount: 1 },
          label_download: { pdf: 'https://labels.example/label-1.pdf' },
        },
      });
    }
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      orderReads += 1;
      return Response.json(orderDocument({
        fulfillmentTrackingCode: 'old-tracking',
        shipstation: { shipmentId: 'shipment-1', label: storedLabel, labelPurchase: { status: 'purchasing' } },
      }, `2026-08-18T12:00:0${orderReads}.000000Z`));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commit = JSON.parse(String(init?.body));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    deliveryId: number;
    shipmentId: string;
    label: { status: string; trackingNumber: string; totalCost: { currency: string; amount: number } };
    labelDownloadUrl: string;
  };
  assert.equal(payload.deliveryId, 7);
  assert.equal(payload.shipmentId, 'shipment-1');
  assert.equal(payload.label.status, 'completed');
  assert.equal(payload.label.trackingNumber, 'new-tracking');
  assert.deepEqual(payload.label.totalCost, { currency: 'usd', amount: 11 });
  assert.equal(payload.labelDownloadUrl, 'https://labels.example/label-1.pdf');
  assert.equal(orderReads, 2);
  const write = commit?.writes[0] as {
    currentDocument: { updateTime: string };
    update: { fields: Record<string, unknown> };
    updateMask: { fieldPaths: string[] };
  };
  assert.equal(write.currentDocument.updateTime, '2026-08-18T12:00:02.000000Z');
  assert.ok(write.updateMask.fieldPaths.includes('shipstation.labelPurchase'));
  assert.ok(write.updateMask.fieldPaths.includes('fulfillmentTrackingCode'));
  assert.ok(write.updateMask.fieldPaths.includes('shipstation.rateQuotes'));
  assert.ok(Object.hasOwn(write.update.fields, 'fulfillmentTrackingCode'));
});

test('ShipStation label route adopts a discovered label and resolves an uncertain purchase', async () => {
  let scenario: 'adopt' | 'unknown' = 'adopt';
  let commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      assert.equal(url.pathname, '/v2/labels');
      return Response.json({
        labels: scenario === 'adopt'
          ? [{
              label_id: 'adopted-label',
              shipment_id: 'shipment-1',
              status: 'completed',
              tracking_number: 'adopted-tracking',
            }]
          : [],
      });
    }
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          ...(scenario === 'unknown'
            ? { labelPurchase: { status: 'purchasing', requestId: 'request-1' } }
            : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits.push(JSON.parse(String(init?.body)));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const adopted = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(providerFetch),
  );
  assert.equal(adopted.response.status, 200);
  assert.equal((await adopted.response.json() as { label: { labelId: string } }).label.labelId, 'adopted-label');
  assert.equal(commits.length, 1);

  scenario = 'unknown';
  commits = [];
  const unknown = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(providerFetch),
  );
  assert.equal(unknown.response.status, 200);
  assert.deepEqual(await unknown.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    purchaseUnknown: true,
  });
  const write = commits[0].writes[0] as {
    updateMask: { fieldPaths: string[] };
    updateTransforms: unknown[];
  };
  assert.deepEqual(write.updateMask.fieldPaths, [
    'shipstation.labelPurchase.status',
    'shipstation.labelPurchase.checkedBy',
  ]);
  assert.deepEqual(write.updateTransforms, [
    { fieldPath: 'shipstation.labelPurchase.checkedAt', setToServerValue: 'REQUEST_TIME' },
  ]);
});

test('ShipStation label adoption replaces stale metadata from the previous label', async () => {
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const staleLabel = {
    labelId: 'old-label',
    shipmentId: 'shipment-1',
    status: 'voided',
    trackingNumber: 'stale-tracking',
    rateId: 'stale-rate',
    totalCost: { currency: 'usd', amount: 99 },
    purchasedBy: OWNER,
    purchasedAt: NOW_MS - 1000,
  };
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels/old-label') {
        return Response.json({
          label: {
            label_id: 'old-label',
            shipment_id: 'shipment-1',
            status: 'voided',
          },
        });
      }
      assert.equal(url.pathname, '/v2/labels');
      return Response.json({
        labels: [{
          label_id: 'adopted-label',
          shipment_id: 'shipment-1',
          status: 'processing',
        }],
      });
    }
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        fulfillmentTrackingCode: 'stale-tracking',
        shipstation: { shipmentId: 'shipment-1', label: staleLabel },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits.push(JSON.parse(String(init?.body)));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual((await result.response.json() as { label: Record<string, unknown> }).label, {
    labelId: 'adopted-label',
    shipmentId: 'shipment-1',
    status: 'processing',
    purchasedAt: NOW_MS,
  });
  assert.equal(commits.length, 2);
  const adoptedWrite = commits[1].writes[0] as {
    update: {
      fields: {
        shipstation: { mapValue: { fields: { label: { mapValue: { fields: Record<string, unknown> } } } } };
      };
    };
    updateMask: { fieldPaths: string[] };
  };
  assert.ok(adoptedWrite.updateMask.fieldPaths.includes('shipstation.label'));
  assert.ok(adoptedWrite.updateMask.fieldPaths.includes('fulfillmentTrackingCode'));
  assert.equal(
    adoptedWrite.updateMask.fieldPaths.some((field) => field.startsWith('shipstation.label.')),
    false,
  );
  assert.deepEqual(Object.keys(adoptedWrite.update.fields.shipstation.mapValue.fields.label.mapValue.fields).sort(), [
    'labelId',
    'purchasedAt',
    'recordedBy',
    'shipmentId',
    'status',
  ]);
  assert.equal(Object.hasOwn(adoptedWrite.update.fields, 'fulfillmentTrackingCode'), false);
});

test('ShipStation label route does not overwrite a label created during adoption', async () => {
  let orderReads = 0;
  let commits = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      return Response.json({
        labels: [{
          label_id: 'adopted-label',
          shipment_id: 'shipment-1',
          status: 'completed',
        }],
      });
    }
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      orderReads += 1;
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          ...(orderReads > 1
            ? { label: { labelId: 'newer-label', shipmentId: 'shipment-1', status: 'completed' } }
            : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) commits += 1;
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(orderReads, 2);
  assert.equal(commits, 0);
});

test('ShipStation label route rejects a label from another shipment before persisting it', async () => {
  let commits = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      return Response.json({
        label: {
          label_id: 'label-1',
          shipment_id: 'shipment-2',
          status: 'completed',
        },
      });
    }
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          label: { labelId: 'label-1', shipmentId: 'shipment-1', status: 'processing' },
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) commits += 1;
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(commits, 0);
});

test('ShipStation label route rejects a shipment change before transitioning purchase state', async () => {
  let orderReads = 0;
  let commits = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') return Response.json({ labels: [] });
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      orderReads += 1;
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: orderReads === 1 ? 'shipment-1' : 'shipment-2',
          labelPurchase: { status: 'purchasing', requestId: 'request-1' },
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) commits += 1;
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(orderReads, 2);
  assert.equal(commits, 0);
});

test('ShipStation label route fails closed for missing configuration and oversized provider responses', async () => {
  const order = orderDocument({ shipstation: { shipmentId: 'shipment-1' } });
  const firestoreFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/authSessions/${UID}`)) return Response.json(sessionDocument(OWNER));
    if (url.pathname.endsWith('/deliveryOrders/7')) return Response.json(order);
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const missing = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    { ...fulfillmentEnv, SHIPSTATION_API_KEY: '' },
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(firestoreFetch),
  );
  assert.equal(missing.response.status, 409);
  assert.equal((await missing.response.json() as { error: { code: string } }).error.code, 'failed-precondition');
  assert.equal(missing.authOutcome, 'provider-failure');

  const rateLimited = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') return Response.json({}, { status: 429 });
      return firestoreFetch(input);
    }),
  );
  assert.equal(rateLimited.response.status, 429);
  assert.equal(rateLimited.authOutcome, 'provider-failure');

  const oversized = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        return new Response('{}', { headers: { 'Content-Length': String(300 * 1024) } });
      }
      return firestoreFetch(input);
    }),
  );
  assert.equal(oversized.response.status, 502);
  assert.equal((await oversized.response.json() as { error: { code: string } }).error.code, 'unavailable');

  const malformed = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') return Response.json({});
      return firestoreFetch(input);
    }),
  );
  assert.equal(malformed.response.status, 500);
  assert.equal((await malformed.response.json() as { error: { code: string } }).error.code, 'internal');
  assert.equal(malformed.authOutcome, 'provider-failure');

  const malformedEntry = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') return Response.json({ labels: [{}] });
      return firestoreFetch(input);
    }),
  );
  assert.equal(malformedEntry.response.status, 500);
  assert.equal((await malformedEntry.response.json() as { error: { code: string } }).error.code, 'internal');
  assert.equal(malformedEntry.authOutcome, 'provider-failure');

  const timedOut = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.shipstation.com') return firestoreFetch(input);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }, { timeoutMs: 25 }),
  );
  assert.equal(timedOut.response.status, 504);
  assert.equal((await timedOut.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
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
  for (const [path, body] of [
    [FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full: 'address', extra: true }],
    [FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full: 'x'.repeat(2049) }],
    [FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7, extra: true }],
  ] as const) {
    const result = await handleProfileWriteRequest(
      request(path, body),
      fulfillmentEnv,
      path,
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
