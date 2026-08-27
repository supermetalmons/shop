import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1 } from './commerceD1Harness.ts';
import nacl from 'tweetnacl';
import {
  FULFILLMENT_ORDER_ADDRESS_PATH,
  FULFILLMENT_ORDER_STATUS_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
  FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
  FULFILLMENT_SHIPSTATION_RATES_PATH,
  FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
  PROFILE_ADDRESSES_PATH,
  handleProfileWriteRequest,
  profileWriteTestHooks,
  type ProfileWritePath,
} from '../src/profileWrites.ts';
import {
  encryptAddressCipherText,
  decryptAddressCipherText,
  parseAddressCipherPayload,
  serializeAddressCipherPayload,
} from '../../../../shared/addressCipher.ts';
import type { ProfileProviderFetch } from '../src/boundedResponse.ts';
import { ProfileReadError } from '../src/dataAccess.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import { decodeFixtureFields } from './commerceD1Harness.ts';
import {
  CommerceWriteConflict,
  type CommerceDocumentKey,
  type CommerceDocumentRecord,
  type CommerceUpdateValue,
} from '../src/commerceRepository.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const OTHER = 'So11111111111111111111111111111111111111112';
const UID = 'auth-user-one';
const NOW_MS = Date.parse('2026-08-18T12:00:00.000Z');
const ADDRESS_ID = 'AbCdEfGhIjKlMnOpQrSt';
const NOTIFICATION_JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const ADDRESS_KEY_PAIR = nacl.box.keyPair();
const ADDRESS_SECRET = Buffer.from(ADDRESS_KEY_PAIR.secretKey).toString('base64');
const SHIP_FROM = {
  name: 'mons.shop',
  address_line1: '1061 10th Street',
  city_locality: 'West Pittsburg',
  state_province: 'PA',
  postal_code: '16160',
  country_code: 'US',
  address_residential_indicator: 'no',
};
const SHIP_TO = {
  name: 'Ivan',
  address_line1: '100 Main St',
  city_locality: 'Istanbul',
  state_province: 'IST',
  postal_code: '34000',
  country_code: 'TR',
  address_residential_indicator: 'yes',
};
const LABEL_PURCHASE_BODY = {
  dropId: 'card_nft_2',
  deliveryId: 7,
  rateId: 'rate-1',
  expectedTotal: { currency: 'usd', amount: 10 },
  requestId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
};
const LABEL_VOID_BODY = {
  dropId: 'card_nft_2',
  deliveryId: 7,
  labelId: 'label-1',
};

const SHIPSTATION_RATE = {
  rate_id: 'rate-1',
  shipment_id: 'shipment-1',
  carrier_id: 'carrier-1',
  carrier_code: 'ups',
  carrier_friendly_name: 'UPS',
  service_code: 'ups_ground',
  service_type: 'UPS Ground',
  validation_status: 'valid',
  shipping_amount: { currency: 'usd', amount: 10 },
  insurance_amount: { currency: 'usd', amount: 0 },
  confirmation_amount: { currency: 'usd', amount: 0 },
  other_amount: { currency: 'usd', amount: 0 },
  warning_messages: [],
  error_messages: [],
};

function stringValue(value: string) {
  return { stringValue: value };
}

const TEST_DOCUMENT_PREFIX = 'projects/mons-shop/databases/(default)/documents/';
const TEST_DOCUMENTS_URL = `https://commerce.googleapis.com/v1/${TEST_DOCUMENT_PREFIX.slice(0, -1)}`;

function encodedValue(value: unknown, fieldPath: string): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (fieldPath.split('.').at(-1)?.endsWith('At')) return { timestampValue: new Date(value).toISOString() };
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map((entry) => encodedValue(entry, fieldPath)) } };
  const fields = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [key, encodedValue(entry, `${fieldPath}.${key}`)]));
  return { mapValue: { fields } };
}

function setEncodedField(fields: Record<string, unknown>, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.');
  let current = fields;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const existing = current[parts[index]] as { mapValue?: { fields?: Record<string, unknown> } } | undefined;
    if (!existing?.mapValue?.fields) current[parts[index]] = { mapValue: { fields: {} } };
    current = (current[parts[index]] as { mapValue: { fields: Record<string, unknown> } }).mapValue.fields;
  }
  current[parts.at(-1)!] = encodedValue(value, fieldPath);
}

function fixtureRepository(providerFetch: ProfileProviderFetch) {
  const load = async (key: CommerceDocumentKey): Promise<CommerceDocumentRecord | null> => {
    const response = await providerFetch(`${TEST_DOCUMENTS_URL}/${key.path}`, { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Commerce fixture read failed');
    const payload = await response.json() as { fields?: unknown; updateTime?: unknown };
    const data = payload.fields === undefined ? {} : decodeFixtureFields(payload.fields);
    if (!data) throw new Error('Commerce fixture document is invalid');
    return {
      createTime: '',
      data: data as never,
      key,
      processedAt: null,
      updateTime: typeof payload.updateTime === 'string' ? payload.updateTime : '2026-08-18T12:00:00.000Z',
      version: 1,
    };
  };
  return {
    get: load,
    run: async <T>(_nowMs: number, operation: (unit: unknown) => Promise<T>) => {
      const loaded = new Map<string, CommerceDocumentRecord | null>();
      const updates = new Map<string, { key: CommerceDocumentKey; values: Record<string, CommerceUpdateValue> }>();
      const unit = {
        get: async (key: CommerceDocumentKey) => {
          if (!loaded.has(key.path)) loaded.set(key.path, await load(key));
          return loaded.get(key.path) || null;
        },
        update: async (key: CommerceDocumentKey, values: Record<string, CommerceUpdateValue>) => {
          updates.set(key.path, { key, values });
        },
      };
      const result = await operation(unit as never);
      for (const { key, values } of updates.values()) {
        const fields: Record<string, unknown> = {};
        const fieldPaths: string[] = [];
        const updateTransforms: Array<Record<string, unknown>> = [];
        for (const [fieldPath, value] of Object.entries(values)) {
          if (value && typeof value === 'object' && 'kind' in value) {
            const operationValue = value as { kind?: unknown; amount?: unknown; value?: { seconds: number; nanos: number } };
            if (operationValue.kind === 'server-timestamp') {
              updateTransforms.push({ fieldPath, setToServerValue: 'REQUEST_TIME' });
              continue;
            } else if (operationValue.kind === 'timestamp' && operationValue.value) {
              const timestamp = new Date(operationValue.value.seconds * 1000).toISOString().slice(0, 19);
              setEncodedField(fields, fieldPath, `${timestamp}.${String(operationValue.value.nanos).padStart(9, '0')}Z`);
              const target = fields[fieldPath] as { stringValue?: unknown } | undefined;
              if (target?.stringValue) fields[fieldPath] = { timestampValue: target.stringValue };
            }
            fieldPaths.push(fieldPath);
            continue;
          }
          fieldPaths.push(fieldPath);
          setEncodedField(fields, fieldPath, value);
        }
        const current = loaded.get(key.path);
        const write: Record<string, unknown> = {
          update: { name: `${TEST_DOCUMENT_PREFIX}${key.path}`, fields },
          updateMask: { fieldPaths },
          ...(updateTransforms.length ? { updateTransforms } : {}),
          ...(current ? { currentDocument: { updateTime: current.updateTime } } : {}),
        };
        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            response = await providerFetch(`${TEST_DOCUMENTS_URL}:commit`, {
              method: 'POST',
              body: JSON.stringify({ writes: [write] }),
            });
          } catch (error) {
            if (attempt === 0) continue;
            throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
          }
          if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 1) break;
        }
        if (!response) throw new Error('Commerce fixture commit failed');
        const payload = await response.json().catch(() => null) as { error?: { status?: unknown } } | null;
        if (response.status === 400 || response.status === 409) {
          const status = payload?.error?.status;
          if (status === 'ALREADY_EXISTS') throw new CommerceWriteConflict('already-exists');
          if (status === 'FAILED_PRECONDITION') throw new CommerceWriteConflict('failed-precondition');
          throw new CommerceWriteConflict();
        }
        if (!response.ok) throw new Error('Commerce fixture commit failed');
      }
      return result;
    },
  };
}

function request(path: ProfileWritePath, body: unknown): Request {
  return new Request(`https://api.mons.shop${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://mons.shop',
    },
    body: JSON.stringify(body),
  });
}

function dependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Partial<Parameters<typeof handleProfileWriteRequest>[3]> = {},
): Parameters<typeof handleProfileWriteRequest>[3] {
  return {
    autoId: () => ADDRESS_ID,
    createCommerceRepository: () => fixtureRepository(providerFetch) as never,
    createNotificationJobId: () => NOTIFICATION_JOB_ID,
    error: () => undefined,
    log: () => undefined,
    nowMs: () => NOW_MS,
    providerFetch,
    resolveD1AuthWalletBinding: async () => ({ wallet: OWNER, source: 'binding' }),
    saveProfileAddress: async (_db, address) => ({
      id: address.id,
      country: address.country,
      ...(address.countryCode ? { countryCode: address.countryCode } : {}),
      encrypted: address.encrypted,
      hint: address.hint,
      ...(address.email ? { email: address.email } : {}),
    }),
    timeoutMs: 500,
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    warn: () => undefined,
    ...overrides,
  };
}

const env = { COMMERCE_DB: createCommerceD1() };
const fulfillmentEnv = {
  ...env,
  ADDRESS_DECRYPTION_SECRET: ADDRESS_SECRET,
  SHIPSTATION_API_KEY: 'shipstation-api-key',
  SHIPSTATION_SHIP_FROM: JSON.stringify(SHIP_FROM),
};

function notificationQueue(send: Queue['send']): Queue {
  return {
    send,
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
}

function commerceValue(value: unknown): unknown {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(commerceValue) } };
  if (value && typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, commerceValue(entry)])),
      },
    };
  }
  return { nullValue: null };
}

function orderDocument(fields: Record<string, unknown>, updateTime = '2026-08-18T12:00:00.000000Z') {
  const normalizedFields = {
    items: [{ kind: 'dude', refId: 1 }],
    ...fields,
  };
  return {
    name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/deliveryOrders/7',
    fields: Object.fromEntries(Object.entries(normalizedFields).map(([key, value]) => [key, commerceValue(value)])),
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

function encryptedAddress(full: string): string {
  return serializeAddressCipherPayload(
    encryptAddressCipherText(full, ADDRESS_KEY_PAIR.publicKey),
    (value) => Buffer.from(value).toString('base64'),
  );
}

test('address route authenticates and atomically persists the exact D1 profile address', async () => {
  let persisted: Record<string, unknown> | undefined;
  const calls: Array<{ url: URL; authorization: string }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') || '' });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      id: ADDRESS_ID,
      encrypted: 'cipher-text',
      country: 'United States',
      hint: '100…01',
      email: 'owner@example.com',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    dependencies(providerFetch, {
      autoId: () => assert.fail('client-supplied address id used the server generator'),
      saveProfileAddress: async (_db, address) => {
        persisted = address;
        return {
          id: address.id,
          country: address.country,
          ...(address.countryCode ? { countryCode: address.countryCode } : {}),
          encrypted: address.encrypted,
          hint: address.hint,
          ...(address.email ? { email: address.email } : {}),
        };
      },
    }),
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
  assert.deepEqual(persisted, {
    wallet: OWNER,
    id: ADDRESS_ID,
    country: 'United States',
    countryCode: 'US',
    encrypted: 'cipher-text',
    hint: '100…01',
    email: 'owner@example.com',
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  });
  assert.equal(result.authOutcome, 'accepted');
  assert.equal(result.metrics.upstreamCalls, 0);
  assert.equal(calls.length, 0);
});

test('address route maps D1 failures to a generic unavailable response with one stable auto ID', async () => {
  let autoIds = 0;
  const providerFetch: typeof fetch = async () => {
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
      autoId: () => {
        autoIds += 1;
        return ADDRESS_ID;
      },
      saveProfileAddress: async () => {
        throw new Error('private D1 details');
      },
    }),
  );
  assert.equal(result.response.status, 502);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: { code: 'unavailable', message: 'Profile data is temporarily unavailable.' },
  });
  assert.equal(autoIds, 1);
});

test('address route uses D1 wallet sessions without requesting Commerce authSessions', async () => {
  let providerCalls = 0;
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      id: ADDRESS_ID,
      encrypted: 'cipher-text',
      country: 'United States',
      hint: '100…01',
    }),
    { ...env, OPS_DB: {} as D1Database },
    PROFILE_ADDRESSES_PATH,
    dependencies(async () => {
      providerCalls += 1;
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      resolveD1AuthWalletBinding: async () => ({ wallet: OWNER, source: 'binding' }),
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(providerCalls, 0);
});

test('address route applies the request deadline to D1 persistence', async () => {
  const providerFetch: typeof fetch = async () => {
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, {
      encrypted: 'cipher-text',
      country: 'US',
      hint: 'hint',
    }),
    env,
    PROFILE_ADDRESSES_PATH,
    dependencies(providerFetch, {
      timeoutMs: 5,
      saveProfileAddress: async (_db, _address, signal) => new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    }),
  );
  assert.equal(result.response.status, 504);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'deadline-exceeded');
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
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        assert.deepEqual(url.searchParams.getAll('mask.fieldPaths'), []);
        return Response.json(orderDocument({ fulfillmentTrackingCode: ' https://tracking.example/old ' }));
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
      currentDocument: { updateTime: '2026-08-18T12:00:00.000000Z' },
    });
  }
});

test('status route atomically marks, queues, and finalizes the first shipped email', async () => {
  const commits: Array<{ writes: Array<Record<string, any>> }> = [];
  const queued: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  let orderReads = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      orderReads += 1;
      return Response.json(orderDocument(orderReads === 1 ? {
        deliveryId: 7,
        addressSnapshot: { email: 'buyer@example.com' },
        fulfillmentStatus: 'Preparing',
      } : {
        deliveryId: 7,
        addressSnapshot: { email: 'buyer@example.com' },
        fulfillmentStatus: 'Shipped',
        fulfillmentTrackingCode: 'https://tracking.example/new',
        buyerOrderShippedEmailState: 'pending',
        buyerOrderShippedEmailJobId: NOTIFICATION_JOB_ID,
      }, orderReads === 1 ? '2026-08-18T12:00:00.000000Z' : '2026-08-18T12:00:01.000000Z'));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits.push(JSON.parse(String(init?.body)));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:02Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'Shipped',
      trackingCode: 'https://tracking.example/new',
    }),
    {
      ...env,
      NOTIFICATION_EMAIL_QUEUE: notificationQueue(async (body) => {
        queued.push(body);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      }),
    },
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(providerFetch, {
      error: (entry) => logs.push(entry),
      log: (entry) => logs.push(entry),
      warn: (entry) => logs.push(entry),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    buyerOrderShippedEmailState: 'queued',
    deliveryId: 7,
    fulfillmentStatus: 'Shipped',
    fulfillmentTrackingCode: 'https://tracking.example/new',
  });
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], {
    version: 1,
    jobId: NOTIFICATION_JOB_ID,
    kind: 'buyer_order_shipped',
    idempotencyKey: 'card_nft_2:7:order_shipped',
    recipients: ['buyer@example.com'],
    subject: 'Order shipped - Card NFT 2',
    text: (queued[0] as { text: string }).text,
    html: (queued[0] as { html: string }).html,
    context: { dropId: 'card_nft_2', deliveryId: 7 },
  });
  assert.match((queued[0] as { text: string }).text, /Tracking: https:\/\/tracking\.example\/new/);
  assert.match((queued[0] as { html: string }).html, /Track package/);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0].writes[0].updateMask.fieldPaths, [
    'dropId',
    'fulfillmentUpdatedBy',
    'fulfillmentStatus',
    'fulfillmentTrackingCode',
    'buyerOrderShippedEmailState',
    'buyerOrderShippedEmailJobId',
    'buyerOrderShippedEmailIdempotencyKey',
    'buyerOrderShippedEmailQueuedAt',
  ]);
  assert.equal(
    commits[0].writes[0].update.fields.buyerOrderShippedEmailState.stringValue,
    'pending',
  );
  assert.equal(
    commits[0].writes[0].update.fields.buyerOrderShippedEmailJobId.stringValue,
    NOTIFICATION_JOB_ID,
  );
  assert.equal(
    commits[0].writes[0].update.fields.buyerOrderShippedEmailIdempotencyKey.stringValue,
    'card_nft_2:7:order_shipped',
  );
  assert.deepEqual(commits[0].writes[0].currentDocument, {
    updateTime: '2026-08-18T12:00:00.000000Z',
  });
  assert.equal(commits[1].writes[0].update.fields.buyerOrderShippedEmailState.stringValue, 'queued');
  assert.deepEqual(commits[1].writes[0].updateTransforms, [{
    fieldPath: 'buyerOrderShippedEmailQueuedAt',
    setToServerValue: 'REQUEST_TIME',
  }]);
  assert.ok(logs.some((entry) => entry.event === 'buyer_order_shipped_notification_queued'));
});

test('status route leaves a pending marker and returns 503 when Queue publication fails', async () => {
  let commit: { writes: Array<Record<string, any>> } | undefined;
  const errors: Record<string, unknown>[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        deliveryId: 7,
        addressSnapshot: { email: 'buyer@example.com' },
        fulfillmentStatus: 'Preparing',
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commit = JSON.parse(String(init?.body));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:01Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'Shipped',
      trackingCode: 'https://tracking.example/new',
    }),
    {
      ...env,
      NOTIFICATION_EMAIL_QUEUE: notificationQueue(async () => {
        throw new Error('queue unavailable');
      }),
    },
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(providerFetch, { error: (entry) => errors.push(entry) }),
  );
  assert.equal(result.response.status, 503);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: 'unavailable',
      message: 'Order status was saved, but the shipment email could not be queued. Retry saving the status.',
    },
  });
  assert.equal(commit?.writes[0].update.fields.buyerOrderShippedEmailState.stringValue, 'pending');
  assert.equal(commit?.writes[0].update.fields.buyerOrderShippedEmailJobId.stringValue, NOTIFICATION_JOB_ID);
  assert.equal(errors[0]?.event, 'buyer_order_shipped_notification_enqueue_failed');
});

test('status route retries a Commerce conflict before publishing one Queue job', async () => {
  let commits = 0;
  let orderReads = 0;
  let queueSends = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      orderReads += 1;
      return Response.json(orderDocument(orderReads < 3 ? {
        deliveryId: 7,
        addressSnapshot: { email: 'buyer@example.com' },
        fulfillmentStatus: 'Preparing',
      } : {
        deliveryId: 7,
        addressSnapshot: { email: 'buyer@example.com' },
        fulfillmentStatus: 'Shipped',
        fulfillmentTrackingCode: 'https://tracking.example/new',
        buyerOrderShippedEmailState: 'pending',
        buyerOrderShippedEmailJobId: NOTIFICATION_JOB_ID,
      }, `2026-08-18T12:00:0${orderReads}.000000Z`));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits += 1;
      if (commits === 1) {
        return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 409 });
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:04Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'Shipped',
      trackingCode: 'https://tracking.example/new',
    }),
    {
      ...env,
      NOTIFICATION_EMAIL_QUEUE: notificationQueue(async () => {
        queueSends += 1;
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      }),
    },
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.equal(commits, 3);
  assert.equal(queueSends, 1);
});

test('status route retries a pending shipped notification and skips a queued one', async () => {
  for (const [emailState, expectedQueueCount] of [['pending', 1], ['queued', 0]] as const) {
    const queued: unknown[] = [];
    let orderReads = 0;
    const providerFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        orderReads += 1;
        return Response.json(orderDocument({
          deliveryId: 7,
          addressSnapshot: { email: 'buyer@example.com' },
          fulfillmentStatus: 'Shipped',
          fulfillmentTrackingCode: 'https://tracking.example/new',
          buyerOrderShippedEmailState: orderReads > 1 ? 'pending' : emailState,
          buyerOrderShippedEmailJobId: NOTIFICATION_JOB_ID,
        }, orderReads > 1 ? '2026-08-18T12:00:01.000000Z' : '2026-08-18T12:00:00.000000Z'));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:02Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_ORDER_STATUS_PATH, {
        dropId: 'card_nft_2',
        deliveryId: 7,
        status: 'Shipped',
        trackingCode: 'https://tracking.example/new',
      }),
      {
        ...env,
        NOTIFICATION_EMAIL_QUEUE: notificationQueue(async (body) => {
          queued.push(body);
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        }),
      },
      FULFILLMENT_ORDER_STATUS_PATH,
      dependencies(providerFetch),
    );
    assert.equal(result.response.status, 200);
    assert.equal(queued.length, expectedQueueCount);
  }
});

test('status route explicitly replays a queued shipped email with a fresh idempotency key', async () => {
  const previousJobId = '123e4567-e89b-42d3-a456-426614174001';
  const retryIdempotencyKey = `card_nft_2:7:order_shipped:retry:${NOTIFICATION_JOB_ID}`;
  const queued: Array<Record<string, unknown>> = [];
  const commits: Array<{ writes: Array<Record<string, any>> }> = [];
  let orderReads = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      orderReads += 1;
      return Response.json(orderDocument({
        deliveryId: 7,
        addressSnapshot: { email: 'buyer@example.com' },
        fulfillmentStatus: 'Shipped',
        fulfillmentTrackingCode: 'https://tracking.example/new',
        buyerOrderShippedEmailState: orderReads === 1 ? 'queued' : 'pending',
        buyerOrderShippedEmailJobId: orderReads === 1 ? previousJobId : NOTIFICATION_JOB_ID,
        buyerOrderShippedEmailIdempotencyKey: orderReads === 1
          ? 'card_nft_2:7:order_shipped'
          : retryIdempotencyKey,
      }, orderReads === 1 ? '2026-08-18T12:00:00.000000Z' : '2026-08-18T12:00:01.000000Z'));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits.push(JSON.parse(String(init?.body)));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:02Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      retryShippedEmail: true,
      status: 'Shipped',
      trackingCode: 'https://tracking.example/new',
    }),
    {
      ...env,
      NOTIFICATION_EMAIL_QUEUE: notificationQueue(async (body) => {
        queued.push(body as Record<string, unknown>);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      }),
    },
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].jobId, NOTIFICATION_JOB_ID);
  assert.equal(queued[0].idempotencyKey, retryIdempotencyKey);
  assert.equal(
    commits[0].writes[0].update.fields.buyerOrderShippedEmailIdempotencyKey.stringValue,
    retryIdempotencyKey,
  );
  assert.deepEqual(await result.response.json(), {
    buyerOrderShippedEmailState: 'queued',
    deliveryId: 7,
    fulfillmentStatus: 'Shipped',
    fulfillmentTrackingCode: 'https://tracking.example/new',
  });
});

test('status route clears a pending marker when shipment is reversed', async () => {
  let commit: { writes: Array<Record<string, any>> } | undefined;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        deliveryId: 7,
        addressSnapshot: { email: 'buyer@example.com' },
        fulfillmentStatus: 'Shipped',
        fulfillmentTrackingCode: 'https://tracking.example/new',
        buyerOrderShippedEmailState: 'pending',
        buyerOrderShippedEmailJobId: NOTIFICATION_JOB_ID,
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commit = JSON.parse(String(init?.body));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:01Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'Preparing',
    }),
    env,
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  const write = commit?.writes[0];
  assert.ok(write);
  assert.ok(write.updateMask.fieldPaths.includes('buyerOrderShippedEmailState'));
  assert.ok(write.updateMask.fieldPaths.includes('buyerOrderShippedEmailJobId'));
  assert.ok(write.updateMask.fieldPaths.includes('buyerOrderShippedEmailIdempotencyKey'));
  assert.ok(write.updateMask.fieldPaths.includes('buyerOrderShippedEmailQueuedAt'));
  assert.equal(Object.hasOwn(write.update.fields, 'buyerOrderShippedEmailState'), false);
  assert.equal(Object.hasOwn(write.update.fields, 'buyerOrderShippedEmailJobId'), false);
  assert.equal(Object.hasOwn(write.update.fields, 'buyerOrderShippedEmailIdempotencyKey'), false);
});

test('status route returns success when only queued-marker finalization fails', async () => {
  const queued: unknown[] = [];
  const errors: Record<string, unknown>[] = [];
  let orderReads = 0;
  let commits = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      orderReads += 1;
      return Response.json(orderDocument(orderReads === 1 ? {
        deliveryId: 7,
        addressSnapshot: { email: 'buyer@example.com' },
        fulfillmentStatus: 'Preparing',
      } : {
        deliveryId: 7,
        addressSnapshot: { email: 'buyer@example.com' },
        fulfillmentStatus: 'Shipped',
        fulfillmentTrackingCode: 'https://tracking.example/new',
        buyerOrderShippedEmailState: 'pending',
        buyerOrderShippedEmailJobId: NOTIFICATION_JOB_ID,
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits += 1;
      return commits === 1
        ? Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:01Z' })
        : Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'Shipped',
      trackingCode: 'https://tracking.example/new',
    }),
    {
      ...env,
      NOTIFICATION_EMAIL_QUEUE: notificationQueue(async (body) => {
        queued.push(body);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      }),
    },
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(providerFetch, { error: (entry) => errors.push(entry) }),
  );
  assert.equal(result.response.status, 200);
  assert.equal(queued.length, 1);
  assert.equal(errors[0]?.event, 'buyer_order_shipped_notification_marker_finalization_failed');
});

test('fulfillment address route encrypts the address and conditionally clears stale ShipStation rates', async () => {
  let commit: { writes: Array<Record<string, unknown>> } | undefined;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
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
    'shipstation.ratesClaimId',
    'shipstation.ratesClaimedAt',
    'shipstation.ratesClaimedBy',
  ]);
  assert.deepEqual(write.updateTransforms, [
    { fieldPath: 'fulfillmentAddressUpdatedAt', setToServerValue: 'REQUEST_TIME' },
  ]);
});

test('fulfillment address route retries the full read and validation after a Commerce precondition conflict', async () => {
  let reads = 0;
  let commits = 0;
  const updateTimes: string[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
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
    dependencies(async () => {
      providerCalls += 1;
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      resolveD1AuthWalletBinding: async () => ({ wallet: adminWallet, source: 'binding' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: adminWallet }),
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.equal((await denied.response.json() as { error: { code: string } }).error.code, 'permission-denied');
  assert.equal(providerCalls, 0);

  for (const [orderFields, code] of [
    [{ addressSnapshot: {}, shipstation: { shipmentId: 'shipment-1' } }, 'failed-precondition'],
    [{ addressSnapshot: {}, shipstation: { labelPurchase: { status: 'purchasing' } } }, 'aborted'],
    [{
      addressSnapshot: {},
      shipstation: { label: { labelId: 'label-1', shipmentId: 'shipment-1', status: 'completed' } },
    }, 'failed-precondition'],
    [{ addressSnapshot: {}, shipstation: { ratesClaimedAt: NOW_MS - 1000 } }, 'aborted'],
    [{ addressSnapshot: {}, shipstation: { claimedAt: NOW_MS - 1000 } }, 'aborted'],
    [{ addressSnapshot: {}, shipstation: {}, source: 'admin_irl_redeem' }, 'failed-precondition'],
  ] as const) {
    const guarded = await handleProfileWriteRequest(
      request(FULFILLMENT_ORDER_ADDRESS_PATH, { dropId: 'card_nft_2', deliveryId: 7, full: 'address' }),
      fulfillmentEnv,
      FULFILLMENT_ORDER_ADDRESS_PATH,
      dependencies(async (input) => {
        const url = new URL(String(input));
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

test('ShipStation shipment route returns an existing Commerce shipment without calling ShipStation', async () => {
  let shipStationCalls = 0;
  let commits = 0;
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    dependencies(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        shipStationCalls += 1;
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        return Response.json(orderDocument({
          shipstation: { shipmentId: 'shipment-1', createdAt: NOW_MS - 5_000 },
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) commits += 1;
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    alreadyAdded: true,
    shipstationAddedAt: NOW_MS - 5_000,
  });
  assert.equal(shipStationCalls, 0);
  assert.equal(commits, 0);
});

test('ShipStation shipment route never cleans up a claim it did not acquire', async () => {
  for (const [orderFields, expectedCode] of [
    [{ shipstation: { claimedAt: NOW_MS - 1_000, claimedBy: OTHER } }, 'aborted'],
    [{ shipstation: {}, source: 'admin_irl_redeem' }, 'failed-precondition'],
  ] as const) {
    let commits = 0;
    let shipStationCalls = 0;
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
      dependencies(async (input) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.shipstation.com') {
          shipStationCalls += 1;
          return Response.json({ error: 'unexpected' }, { status: 500 });
        }
        if (url.pathname.endsWith('/deliveryOrders/7')) return Response.json(orderDocument(orderFields));
        if (url.pathname.endsWith('/documents:commit')) commits += 1;
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    );
    assert.equal(result.response.status, 409);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, expectedCode);
    assert.equal(commits, 0);
    assert.equal(shipStationCalls, 0);
  }
});

test('ShipStation shipment route fails before claiming when provider configuration is missing', async () => {
  for (const missingEnv of [
    { ...fulfillmentEnv, SHIPSTATION_API_KEY: '' },
    { ...fulfillmentEnv, SHIPSTATION_SHIP_FROM: '' },
  ]) {
    let orderReads = 0;
    let commits = 0;
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      missingEnv,
      FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
      dependencies(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/deliveryOrders/7')) orderReads += 1;
        if (url.pathname.endsWith('/documents:commit')) commits += 1;
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    );
    assert.equal(result.response.status, 409);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'failed-precondition');
    assert.equal(result.authOutcome, 'provider-failure');
    assert.equal(orderReads, 0);
    assert.equal(commits, 0);
  }
});

test('ShipStation shipment route safely releases a claim after its commit response is lost', async () => {
  let claimId = '';
  let orderReads = 0;
  let claimCommitAttempts = 0;
  let releaseCommits = 0;
  let shipStationCalls = 0;
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    dependencies(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        shipStationCalls += 1;
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        orderReads += 1;
        return Response.json(orderDocument({
          shipstation: claimId ? { claimId, claimedAt: NOW_MS, claimedBy: OWNER } : {},
        }, `2026-08-18T12:00:0${orderReads}.000000Z`));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
        const write = commit.writes[0] as {
          update?: {
            fields?: {
              shipstation?: {
                mapValue?: { fields?: Record<string, { stringValue?: string }> };
              };
            };
          };
          updateMask?: { fieldPaths?: string[] };
        };
        const nextClaimId = write.update?.fields?.shipstation?.mapValue?.fields?.claimId?.stringValue;
        if (nextClaimId) {
          claimCommitAttempts += 1;
          claimId = nextClaimId;
          if (claimCommitAttempts === 1) throw new Error('commit response lost');
          return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
        }
        releaseCommits += 1;
        assert.ok(write.updateMask?.fieldPaths?.includes('shipstation.claimId'));
        return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:03Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(claimCommitAttempts, 2);
  assert.equal(releaseCommits, 1);
  assert.equal(shipStationCalls, 0);
});

test('ShipStation shipment route claims, decrypts, creates, and conditionally persists one shipment', async () => {
  let claimId = '';
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  let createBody: unknown;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      assert.equal(new Headers(init?.headers).get('api-key'), 'shipstation-api-key');
      if (url.pathname === '/v2/shipments/external_shipment_id/mons-card_nft_2-7') {
        return Response.json({}, { status: 404 });
      }
      if (url.pathname === '/v2/shipments' && init?.method === 'POST') {
        createBody = JSON.parse(String(init.body));
        return Response.json({
          shipments: [{
            shipment_id: 'shipment-new',
            packages: [{
              weight: { value: 8, unit: 'ounce' },
              dimensions: { length: 10, width: 8, height: 3, unit: 'inch' },
            }],
          }],
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        addressSnapshot: {
          encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
          countryCode: 'TR',
          email: 'owner@example.com',
          phone: '+905555555555',
        },
        items: [
          { kind: 'box', refId: 1 },
          { kind: 'dude', refId: 2 },
          { kind: 'box', refId: 0 },
          { kind: 'other', refId: 3 },
        ],
        shipstation: claimId ? { claimId, claimedAt: NOW_MS, claimedBy: OWNER } : {},
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const fields = (commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: { claimId?: { stringValue?: string } } } } } };
      }).update?.fields?.shipstation?.mapValue?.fields;
      claimId = fields?.claimId?.stringValue ?? claimId;
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      package: { length: 10, width: 8, height: 3, weight: 8 },
    }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-new',
    alreadyAdded: false,
    shipstationAddedAt: NOW_MS,
  });
  assert.equal(commits.length, 2);
  assert.match(claimId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(createBody, {
    shipments: [{
      external_shipment_id: 'mons-card_nft_2-7',
      shipment_number: '7',
      ship_to: {
        name: 'Ivan',
        address_line1: '100 Main St',
        city_locality: 'Istanbul',
        state_province: '',
        postal_code: '34000',
        country_code: 'TR',
        address_residential_indicator: 'yes',
        email: 'owner@example.com',
        phone: '+905555555555',
      },
      ship_from: SHIP_FROM,
      packages: [{
        content_description: 'Printed collectible art card',
        weight: { value: 8, unit: 'ounce' },
        dimensions: { length: 10, width: 8, height: 3, unit: 'inch' },
        products: [{
          description: 'Printed collectible art card',
          quantity: 4,
          value: { amount: 14.67, currency: 'usd' },
          weight: { value: 0.2, unit: 'ounce' },
          harmonized_tariff_code: '4911.99',
          country_of_origin: 'US',
          sku: 'card-nft-2',
        }],
      }],
      customs: {
        contents: 'merchandise',
        non_delivery: 'return_to_sender',
        terms_of_trade_code: 'dap',
      },
      create_sales_order: true,
      shipment_status: 'pending',
    }],
  });
  const finalWrite = commits[1].writes[0] as {
    update: { fields: { shipstation: { mapValue: { fields: Record<string, unknown> } } } };
    updateMask: { fieldPaths: string[] };
    updateTransforms: unknown[];
  };
  const finalFields = finalWrite.update.fields.shipstation.mapValue.fields;
  assert.deepEqual(finalFields.shipmentId, stringValue('shipment-new'));
  assert.deepEqual(finalFields.externalShipmentId, stringValue('mons-card_nft_2-7'));
  assert.ok(finalWrite.updateMask.fieldPaths.includes('shipstation.claimId'));
  assert.ok(finalWrite.updateMask.fieldPaths.includes('shipstation.lastError'));
  assert.deepEqual(finalWrite.updateTransforms, [
    { fieldPath: 'shipstation.createdAt', setToServerValue: 'REQUEST_TIME' },
  ]);
});

test('ShipStation shipment route raises an international default parcel above declared net weight', async () => {
  let claimId = '';
  let createBody: { shipments: Array<Record<string, unknown>> } | undefined;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
      if (url.pathname === '/v2/shipments' && init?.method === 'POST') {
        createBody = JSON.parse(String(init.body)) as { shipments: Array<Record<string, unknown>> };
        return Response.json({
          shipments: [{
            shipment_id: 'shipment-new',
            packages: createBody.shipments[0].packages,
          }],
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        addressSnapshot: {
          encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
          countryCode: 'TR',
        },
        items: [{ kind: 'box', refId: 1 }],
        shipstation: claimId ? { claimId, claimedAt: NOW_MS, claimedBy: OWNER } : {},
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as {
        writes: Array<{
          update?: { fields?: { shipstation?: { mapValue?: { fields?: { claimId?: { stringValue?: string } } } } } };
        }>;
      };
      claimId = commit.writes[0].update?.fields?.shipstation?.mapValue?.fields?.claimId?.stringValue ?? claimId;
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'little_swag_hoodies',
      deliveryId: 7,
    }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(createBody?.shipments[0].packages, [{
    content_description: 'Printed cotton hooded sweatshirt',
    weight: { value: 25, unit: 'ounce' },
    dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
    products: [{
      description: 'Printed cotton hooded sweatshirt',
      quantity: 1,
      value: { amount: 219, currency: 'usd' },
      weight: { value: 24, unit: 'ounce' },
      harmonized_tariff_code: '6110.20',
      country_of_origin: 'US',
      sku: 'swag-hoodie',
    }],
  }]);
  assert.deepEqual(createBody?.shipments[0].customs, {
    contents: 'merchandise',
    non_delivery: 'return_to_sender',
    terms_of_trade_code: 'dap',
  });
});

test('ShipStation shipment route retains its claim when final persistence conflicts after creation', async () => {
  let claimId = '';
  let finalPersistAttempts = 0;
  let retained = false;
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    dependencies(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
        return Response.json({ shipments: [{ shipment_id: 'shipment-new', packages: [] }] });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        return Response.json(orderDocument({
          addressSnapshot: {
            encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
            countryCode: 'TR',
          },
          items: [{ kind: 'box', refId: 1 }],
          shipstation: claimId ? { claimId, claimedAt: NOW_MS, claimedBy: OWNER } : {},
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{
            update?: {
              fields?: {
                shipstation?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } };
              };
            };
            updateTransforms?: Array<{ fieldPath: string }>;
          }>;
        };
        const write = commit.writes[0];
        const fields = write.update?.fields?.shipstation?.mapValue?.fields ?? {};
        if (fields.shipmentId) {
          finalPersistAttempts += 1;
          return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 409 });
        }
        if (fields.lastError) {
          retained = fields.claimId?.stringValue === claimId &&
            Boolean(write.updateTransforms?.some((entry) => entry.fieldPath === 'shipstation.claimedAt'));
          return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
        }
        claimId = fields.claimId?.stringValue ?? claimId;
        return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(finalPersistAttempts, 3);
  assert.equal(retained, true);
});

test('ShipStation shipment route adopts an external-id match without creating a duplicate', async () => {
  let claimId = '';
  let mutationCalls = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (init?.method && init.method !== 'GET') mutationCalls += 1;
      return Response.json({
        shipment: {
          shipment_id: 'shipment-adopted',
          shipment_status: 'pending',
          packages: [{
            weight: { value: 12, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          }],
        },
      });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: claimId
          ? { claimId, claimedAt: NOW_MS, claimedBy: OWNER }
          : { claimedAt: NOW_MS - 120_001, claimedBy: OTHER },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as {
        writes: Array<{ update?: { fields?: { shipstation?: { mapValue?: { fields?: { claimId?: { stringValue?: string } } } } } } }>;
      };
      claimId = commit.writes[0].update?.fields?.shipstation?.mapValue?.fields?.claimId?.stringValue ?? claimId;
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      package: { length: 10, width: 8, height: 3, weight: 8 },
      addressPatch: { state_province: 'PA' },
    }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-adopted',
    alreadyAdded: true,
    shipstationAddedAt: NOW_MS,
  });
  assert.equal(mutationCalls, 0);
});

test('ShipStation shipment route retains only its own claim after an ambiguous create failure', async () => {
  for (const replacement of [false, true]) {
    let claimId = '';
    const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
        return new Promise<Response>((_resolve, reject) => {
          reject(new Error('network failed after sending a private address'));
        });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        return Response.json(orderDocument({
          addressSnapshot: {
            encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
            countryCode: 'TR',
          },
          items: [{ kind: 'box', refId: 1 }],
          shipstation: claimId
            ? replacement && commits.length === 1
              ? { claimId: 'replacement-claim', claimedAt: NOW_MS, claimedBy: OTHER }
              : { claimId, claimedAt: NOW_MS, claimedBy: OWNER }
            : {},
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
        commits.push(commit);
        const fields = (commit.writes[0] as {
          update?: { fields?: { shipstation?: { mapValue?: { fields?: { claimId?: { stringValue?: string } } } } } };
        }).update?.fields?.shipstation?.mapValue?.fields;
        claimId = fields?.claimId?.stringValue ?? claimId;
        return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
      dependencies(providerFetch),
    );
    assert.equal(result.response.status, 409);
    const payload = await result.response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, 'aborted');
    assert.doesNotMatch(payload.error.message, /100 Main St|private address/);
    assert.equal(commits.length, replacement ? 1 : 2);
    if (!replacement) {
      const transition = commits[1].writes[0] as {
        update: { fields: { shipstation: { mapValue: { fields: Record<string, { stringValue?: string }> } } } };
        updateTransforms: Array<{ fieldPath: string }>;
      };
      const fields = transition.update.fields.shipstation.mapValue.fields;
      assert.equal(fields.claimId.stringValue, claimId);
      assert.equal(fields.lastError.stringValue, 'Could not reach ShipStation');
      assert.ok(transition.updateTransforms.some((entry) => entry.fieldPath === 'shipstation.claimedAt'));
    }
  }
});

test('ShipStation shipment route releases its claim after a definitive provider rejection', async () => {
  let claimId = '';
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
      return Response.json({
        errors: [{ error_code: 'invalid_address', message: 'Ivan, 100 Main St' }],
      }, { status: 400 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        addressSnapshot: {
          encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
          countryCode: 'TR',
        },
        items: [{ kind: 'box', refId: 1 }],
        shipstation: claimId ? { claimId, claimedAt: NOW_MS, claimedBy: OWNER } : {},
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const fields = (commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: { claimId?: { stringValue?: string } } } } } };
      }).update?.fields?.shipstation?.mapValue?.fields;
      claimId = fields?.claimId?.stringValue ?? claimId;
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  const payload = await result.response.json() as {
    error: { code: string; message: string; details?: { kind: string; fields: string[] } };
  };
  assert.equal(payload.error.code, 'failed-precondition');
  assert.match(payload.error.message, /invalid_address/);
  assert.doesNotMatch(payload.error.message, /100 Main St/);
  assert.deepEqual(payload.error.details, {
    kind: 'shipstation-address-correction',
    fields: [
      'name',
      'address_line1',
      'address_line2',
      'address_line3',
      'city_locality',
      'state_province',
      'postal_code',
      'country_code',
    ],
  });
  assert.equal(commits.length, 2);
  const release = commits[1].writes[0] as {
    update: { fields: { shipstation: { mapValue: { fields: Record<string, { stringValue?: string }> } } } };
    updateMask: { fieldPaths: string[] };
  };
  assert.equal(release.update.fields.shipstation.mapValue.fields.claimFenceId.stringValue, claimId);
  assert.ok(release.updateMask.fieldPaths.includes('shipstation.claimedAt'));
});

test('ShipStation shipment route releases a structured 5xx rejection and accepts a temporary correction', async () => {
  let claimId = '';
  let createCalls = 0;
  let correctedCreateBody: { shipments: Array<Record<string, unknown>> } | undefined;
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
      if (url.pathname === '/v2/shipments' && init?.method === 'POST') {
        createCalls += 1;
        if (createCalls === 1) {
          return Response.json({
            errors: [{
              error_code: 'unspecified',
              field_name: 'state_province',
              field_value: 'Private subdivision',
              message: 'Ivan at 100 Main St',
            }],
          }, { status: 500 });
        }
        correctedCreateBody = JSON.parse(String(init.body)) as { shipments: Array<Record<string, unknown>> };
        return Response.json({
          shipments: [{
            shipment_id: 'shipment-corrected',
            packages: correctedCreateBody.shipments[0].packages,
          }],
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        addressSnapshot: {
          encrypted: encryptedAddress('Ivan\n100 Main St\nSuite 4\nIstanbul, 34000\nTurkey'),
          countryCode: 'TR',
          email: 'owner@example.com',
          phone: '+905555555555',
        },
        items: [{ kind: 'box', refId: 1 }],
        shipstation: claimId ? { claimId, claimedAt: NOW_MS, claimedBy: OWNER } : {},
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const write = commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: { claimId?: { stringValue?: string } } } } } };
        updateMask?: { fieldPaths?: string[] };
      };
      if (write.updateMask?.fieldPaths?.includes('shipstation.claimId')) {
        claimId = write.update?.fields?.shipstation?.mapValue?.fields?.claimId?.stringValue ?? '';
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const run = (body: Record<string, unknown>) => handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, body),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
    dependencies(providerFetch),
  );

  const rejected = await run({ dropId: 'card_nft_2', deliveryId: 7 });
  assert.equal(rejected.response.status, 409);
  const rejectedPayload = await rejected.response.json() as {
    error: { message: string; details?: { kind: string; fields: string[] } };
  };
  assert.deepEqual(rejectedPayload.error.details, {
    kind: 'shipstation-address-correction',
    fields: ['state_province'],
  });
  assert.doesNotMatch(JSON.stringify(rejectedPayload), /Private subdivision|100 Main St/);
  assert.equal(claimId, '');

  const corrected = await run({
    dropId: 'card_nft_2',
    deliveryId: 7,
    addressPatch: { address_line2: '   ', state_province: ' PA ', country_code: ' us ' },
  });
  assert.equal(corrected.response.status, 200);
  assert.deepEqual(await corrected.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-corrected',
    alreadyAdded: false,
    shipstationAddedAt: NOW_MS,
  });
  assert.equal(createCalls, 2);
  const shipment = correctedCreateBody?.shipments[0];
  assert.deepEqual(shipment?.ship_to, {
    name: 'Ivan',
    address_line1: '100 Main St',
    city_locality: 'Istanbul',
    state_province: 'PA',
    postal_code: '34000',
    country_code: 'US',
    address_residential_indicator: 'yes',
    email: 'owner@example.com',
    phone: '+905555555555',
  });
  assert.equal(Object.hasOwn(shipment ?? {}, 'customs'), false);
  assert.equal(claimId, '');
  for (const commit of commits) {
    const fieldPaths = (commit.writes[0] as { updateMask?: { fieldPaths?: string[] } }).updateMask?.fieldPaths ?? [];
    assert.equal(fieldPaths.some((field) => field.startsWith('addressSnapshot')), false);
  }
});

test('ShipStation shipment route preserves its sanitized provider error when claim cleanup fails', async () => {
  let claimId = '';
  let cleanupAttempts = 0;
  const logged: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logged.push(values.map(String).join(' '));
  try {
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_SHIPMENT_PATH,
      dependencies(async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.shipstation.com') {
          if (url.pathname.includes('/external_shipment_id/')) return Response.json({}, { status: 404 });
          return Response.json({
            errors: [{ error_code: 'invalid_address', message: 'Ivan, 100 Main St' }],
          }, { status: 400 });
        }
        if (url.pathname.endsWith('/deliveryOrders/7')) {
          return Response.json(orderDocument({
            addressSnapshot: {
              encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
              countryCode: 'TR',
            },
            items: [{ kind: 'box', refId: 1 }],
            shipstation: claimId ? { claimId, claimedAt: NOW_MS, claimedBy: OWNER } : {},
          }));
        }
        if (url.pathname.endsWith('/documents:commit')) {
          const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
          const write = commit.writes[0] as {
            update?: {
              fields?: {
                shipstation?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } };
              };
            };
          };
          const nextClaimId = write.update?.fields?.shipstation?.mapValue?.fields?.claimId?.stringValue;
          if (nextClaimId) {
            claimId = nextClaimId;
            return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
          }
          cleanupAttempts += 1;
          return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    );
    assert.equal(result.response.status, 409);
    const payload = await result.response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, 'failed-precondition');
    assert.match(payload.error.message, /invalid_address/);
    assert.doesNotMatch(payload.error.message, /100 Main St/);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(cleanupAttempts, 2);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /fulfillment_shipstation_shipment_claim_transition_failed/);
  assert.doesNotMatch(logged[0], /100 Main St/);
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
  assert.equal(write.updateMask.fieldPaths.includes('shipstation.ratesClaimId'), false);
  assert.equal(write.updateMask.fieldPaths.includes('shipstation.ratesClaimedAt'), false);
  assert.equal(write.updateMask.fieldPaths.includes('shipstation.ratesClaimedBy'), false);
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

test('ShipStation label route keeps a voided label terminal across stale provider reads', async () => {
  let commits = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      const label = {
        label_id: 'label-1',
        shipment_id: 'shipment-1',
        status: 'completed',
        tracking_number: 'tracking-1',
      };
      return Response.json(url.pathname === '/v2/labels/label-1' ? { label } : { labels: [label] });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          label: {
            labelId: 'label-1',
            shipmentId: 'shipment-1',
            status: 'voided',
            trackingNumber: 'tracking-1',
            purchasedAt: NOW_MS - 1000,
          },
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
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { label: { status: string } }).label.status, 'voided');
  assert.equal(commits, 0);
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
  const commerceFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deliveryOrders/7')) return Response.json(order);
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const missing = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    { ...fulfillmentEnv, SHIPSTATION_API_KEY: '' },
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(commerceFetch),
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
      return commerceFetch(input);
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
      return commerceFetch(input);
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
      return commerceFetch(input);
    }),
  );
  assert.equal(malformed.response.status, 502);
  assert.equal((await malformed.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.equal(malformed.authOutcome, 'provider-failure');

  const malformedEntry = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') return Response.json({ labels: [{}] });
      return commerceFetch(input);
    }),
  );
  assert.equal(malformedEntry.response.status, 502);
  assert.equal((await malformedEntry.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.equal(malformedEntry.authOutcome, 'provider-failure');

  const timedOut = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PATH,
    dependencies(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.shipstation.com') return commerceFetch(input);
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

test('ShipStation label void route persists the exact label and conditionally removes its tracking code', async () => {
  const run = async (fulfillmentTrackingCode: string) => {
    let putCalls = 0;
    let commit: { writes: Array<Record<string, unknown>> } | undefined;
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        putCalls += 1;
        assert.equal(url.pathname, '/v2/labels/label-1/void');
        assert.equal(init?.method, 'PUT');
        assert.equal(init?.body, undefined);
        assert.equal(new Headers(init?.headers).get('api-key'), 'shipstation-api-key');
        return Response.json({ approved: true, message: 'Refund requested' });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        return Response.json(orderDocument({
          fulfillmentStatus: 'Shipped',
          fulfillmentTrackingCode,
          shipstation: {
            shipmentId: 'shipment-1',
            rateQuotes: [{ rateId: 'rate-1' }],
            label: {
              labelId: 'label-1',
              shipmentId: 'shipment-1',
              status: 'completed',
              trackingNumber: 'tracking-1',
              purchasedAt: NOW_MS - 1000,
            },
          },
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        commit = JSON.parse(String(init?.body));
        return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH, LABEL_VOID_BODY),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
      dependencies(providerFetch),
    );
    return { result, putCalls, commit };
  };

  const matching = await run('tracking-1');
  assert.equal(matching.result.response.status, 200);
  assert.deepEqual(await matching.result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    label: {
      labelId: 'label-1',
      shipmentId: 'shipment-1',
      status: 'voided',
      trackingNumber: 'tracking-1',
      purchasedAt: NOW_MS - 1000,
    },
  });
  assert.equal(matching.putCalls, 1);
  const matchingWrite = matching.commit?.writes[0] as {
    update: {
      fields: {
        fulfillmentTrackingCode?: unknown;
        fulfillmentStatus?: unknown;
        shipstation: { mapValue: { fields: { label: { mapValue: { fields: Record<string, { stringValue?: string }> } } } } };
      };
    };
    updateMask: { fieldPaths: string[] };
  };
  assert.equal(
    matchingWrite.update.fields.shipstation.mapValue.fields.label.mapValue.fields.status.stringValue,
    'voided',
  );
  assert.ok(matchingWrite.updateMask.fieldPaths.includes('shipstation.rateQuotes'));
  assert.ok(matchingWrite.updateMask.fieldPaths.includes('fulfillmentTrackingCode'));
  assert.equal(Object.hasOwn(matchingWrite.update.fields, 'fulfillmentTrackingCode'), false);
  assert.equal(matchingWrite.updateMask.fieldPaths.includes('fulfillmentStatus'), false);
  assert.equal(Object.hasOwn(matchingWrite.update.fields, 'fulfillmentStatus'), false);

  const manual = await run('manual-tracking');
  assert.equal(manual.result.response.status, 200);
  const manualWrite = manual.commit?.writes[0] as { updateMask: { fieldPaths: string[] } };
  assert.equal(manualWrite.updateMask.fieldPaths.includes('fulfillmentTrackingCode'), false);
  assert.equal(manualWrite.updateMask.fieldPaths.includes('fulfillmentStatus'), false);
});

test('ShipStation label void route is idempotent and rejects stale or ineligible labels before calling ShipStation', async () => {
  let providerCalls = 0;
  let commits = 0;
  let labelStatus: 'voided' | 'processing' | 'error' = 'voided';
  let labelId = 'label-1';
  let source: string | undefined;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      providerCalls += 1;
      return Response.json({ approved: true, message: 'ok' });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        ...(source ? { source } : {}),
        shipstation: {
          shipmentId: 'shipment-1',
          label: { labelId, shipmentId: 'shipment-1', status: labelStatus, purchasedAt: NOW_MS - 1000 },
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) commits += 1;
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const run = (activeEnv = fulfillmentEnv) => handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH, LABEL_VOID_BODY),
    activeEnv,
    FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
    dependencies(providerFetch),
  );

  const idempotent = await run();
  assert.equal(idempotent.response.status, 200);
  assert.equal((await idempotent.response.json() as { label: { status: string } }).label.status, 'voided');
  assert.equal(providerCalls, 0);
  assert.equal(commits, 0);

  labelStatus = 'processing';
  assert.equal((await run()).response.status, 409);
  labelStatus = 'error';
  assert.equal((await run()).response.status, 409);
  labelStatus = 'voided';
  labelId = 'replacement-label';
  assert.equal((await run()).response.status, 409);
  labelId = 'label-1';
  source = 'admin_irl_redeem';
  assert.equal((await run()).response.status, 409);
  const missingConfig = await run({ ...fulfillmentEnv, SHIPSTATION_API_KEY: '' });
  assert.equal(missingConfig.response.status, 409);
  assert.equal(providerCalls, 0);
  assert.equal(commits, 0);
});

test('ShipStation label void route maps definite rejection without leaking provider messages', async () => {
  let commits = 0;
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH, LABEL_VOID_BODY),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
    dependencies(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        return Response.json({
          approved: false,
          message: 'Private 100 Main St secret-token',
          reason_code: 'label_already_used',
        });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        return Response.json(orderDocument({
          shipstation: {
            shipmentId: 'shipment-1',
            label: {
              labelId: 'label-1',
              shipmentId: 'shipment-1',
              status: 'completed',
              purchasedAt: NOW_MS - 1000,
            },
          },
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) commits += 1;
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }),
  );
  assert.equal(result.response.status, 409);
  const payload = await result.response.json() as { error: { message: string } };
  assert.match(payload.error.message, /already been used/);
  assert.doesNotMatch(payload.error.message, /Private|100 Main|secret-token/);
  assert.equal(commits, 0);
});

test('ShipStation label void route reconciles an ambiguous provider result with a fresh signal', async () => {
  let voidCalls = 0;
  let cleanupUsedFreshSignal = false;
  let commit: { writes: Array<Record<string, unknown>> } | undefined;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname.endsWith('/void')) {
        voidCalls += 1;
        return Response.json({}, { status: 408 });
      }
      cleanupUsedFreshSignal = init?.signal?.aborted === false;
      assert.equal(url.pathname, '/v2/labels/label-1');
      return Response.json({
        label: {
          label_id: 'label-1',
          shipment_id: 'shipment-1',
          status: 'voided',
          created_at: '2026-08-18T11:59:00.000Z',
        },
      });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      cleanupUsedFreshSignal ||= voidCalls > 0 && init?.signal?.aborted === false;
      return Response.json(orderDocument({
        fulfillmentTrackingCode: 'tracking-1',
        shipstation: {
          shipmentId: 'shipment-1',
          label: {
            labelId: 'label-1',
            shipmentId: 'shipment-1',
            status: 'completed',
            trackingNumber: 'tracking-1',
            purchasedAt: NOW_MS - 1000,
          },
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commit = JSON.parse(String(init?.body));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH, LABEL_VOID_BODY),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { label: { status: string } }).label.status, 'voided');
  assert.equal(voidCalls, 1);
  assert.equal(cleanupUsedFreshSignal, true);
  assert.ok(commit);
});

test('ShipStation label void route does not overwrite a replacement label after provider approval', async () => {
  let orderReads = 0;
  let commits = 0;
  const logs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logs.push(values.map(String).join(' '));
  try {
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH, LABEL_VOID_BODY),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_LABEL_VOID_PATH,
      dependencies(async (input) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.shipstation.com') {
          return Response.json({ approved: true, message: 'Refund requested' });
        }
        if (url.pathname.endsWith('/deliveryOrders/7')) {
          orderReads += 1;
          const currentLabelId = orderReads === 1 ? 'label-1' : 'replacement-label';
          return Response.json(orderDocument({
            shipstation: {
              shipmentId: 'shipment-1',
              label: {
                labelId: currentLabelId,
                shipmentId: 'shipment-1',
                status: 'completed',
                purchasedAt: NOW_MS - 1000,
              },
            },
          }));
        }
        if (url.pathname.endsWith('/documents:commit')) commits += 1;
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    );
    assert.equal(result.response.status, 409);
    assert.match((await result.response.json() as { error: { message: string } }).error.message, /did not confirm/);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(commits, 0);
  assert.ok(orderReads >= 3);
  assert.match(logs.join('\n'), /fulfillment_shipstation_label_void_reconcile_failed/);
});

test('ShipStation label purchase route claims, validates, purchases, and atomically persists a label', async () => {
  let purchaseState: Record<string, unknown> | undefined;
  let labelListCalls = 0;
  let purchaseCalls = 0;
  let orderReads = 0;
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      assert.equal(new Headers(init?.headers).get('api-key'), 'shipstation-api-key');
      assert.equal(init?.redirect, 'manual');
      if (url.pathname === '/v2/labels') {
        labelListCalls += 1;
        return Response.json({ labels: [] });
      }
      if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
      if (url.pathname === '/v2/labels/rates/rate-1') {
        purchaseCalls += 1;
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          label_format: 'pdf',
          label_layout: '4x6',
          label_download_type: 'url',
        });
        return Response.json({
          label_id: 'label-1',
          shipment_id: 'shipment-1',
          status: 'completed',
          tracking_number: 'tracking-1',
          shipment_cost: { currency: 'usd', amount: 10 },
          created_at: '2026-08-18T12:00:00.000Z',
          label_download: { pdf: 'https://labels.example/label-1.pdf' },
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      orderReads += 1;
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          rateQuotes: [{
            rateId: 'rate-1',
            shipmentId: 'shipment-1',
            totalAmount: { currency: 'usd', amount: 10 },
          }],
          ...(purchaseState ? { labelPurchase: purchaseState } : {}),
        },
      }, `2026-08-18T12:00:0${orderReads}.000000Z`));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const purchaseFields = (commit.writes[0] as {
        update?: {
          fields?: {
            shipstation?: {
              mapValue?: {
                fields?: {
                  labelPurchase?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } };
                };
              };
            };
          };
        };
      }).update?.fields?.shipstation?.mapValue?.fields?.labelPurchase?.mapValue?.fields;
      if (purchaseFields?.status?.stringValue === 'purchasing') {
        purchaseState = {
          status: 'purchasing',
          requestId: purchaseFields.requestId?.stringValue,
          rateId: purchaseFields.rateId?.stringValue,
          claimedBy: purchaseFields.claimedBy?.stringValue,
        };
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    label: {
      labelId: 'label-1',
      shipmentId: 'shipment-1',
      status: 'completed',
      rateId: 'rate-1',
      trackingNumber: 'tracking-1',
      carrierId: 'carrier-1',
      carrierCode: 'ups',
      carrierName: 'UPS',
      serviceCode: 'ups_ground',
      serviceName: 'UPS Ground',
      shipmentCost: { currency: 'usd', amount: 10 },
      totalCost: { currency: 'usd', amount: 10 },
      purchasedAt: NOW_MS,
      purchasedBy: OWNER,
    },
    labelDownloadUrl: 'https://labels.example/label-1.pdf',
    alreadyPurchased: false,
  });
  assert.equal(labelListCalls, 2);
  assert.equal(purchaseCalls, 1);
  assert.equal(orderReads, 4);
  assert.equal(commits.length, 2);
  const claim = commits[0].writes[0] as {
    updateMask: { fieldPaths: string[] };
    updateTransforms: Array<{ fieldPath: string }>;
  };
  assert.ok(claim.updateMask.fieldPaths.includes('shipstation.labelPurchase.requestId'));
  assert.deepEqual(claim.updateTransforms, [
    { fieldPath: 'shipstation.labelPurchase.claimedAt', setToServerValue: 'REQUEST_TIME' },
  ]);
  const persistence = commits[1].writes[0] as { updateMask: { fieldPaths: string[] } };
  assert.ok(persistence.updateMask.fieldPaths.includes('shipstation.label'));
  assert.ok(persistence.updateMask.fieldPaths.includes('shipstation.labelPurchase'));
  assert.ok(persistence.updateMask.fieldPaths.includes('shipstation.rateQuotes'));
});

test('ShipStation label purchase route adopts an existing provider label without charging', async () => {
  let purchaseCalls = 0;
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') {
        return Response.json({
          labels: [{
            label_id: 'existing-label',
            shipment_id: 'shipment-1',
            status: 'completed',
            tracking_number: 'existing-tracking',
            label_download: { pdf: 'https://labels.example/existing.pdf' },
          }],
        });
      }
      if (init?.method === 'POST') purchaseCalls += 1;
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({ shipstation: { shipmentId: 'shipment-1' } }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits.push(JSON.parse(String(init?.body)));
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    alreadyPurchased: boolean;
    label: { labelId: string };
    labelDownloadUrl: string;
  };
  assert.equal(payload.alreadyPurchased, true);
  assert.equal(payload.label.labelId, 'existing-label');
  assert.equal(payload.labelDownloadUrl, 'https://labels.example/existing.pdf');
  assert.equal(purchaseCalls, 0);
  assert.equal(commits.length, 1);
});

test('ShipStation label purchase route records definite failures and unresolved ambiguous purchases safely', async () => {
  for (const mode of [
    'definite',
    'ambiguous',
    'missing-status',
    'unsupported-status',
    'missing-status-voided',
    'unsupported-status-voided',
  ] as const) {
    let purchaseState: Record<string, unknown> | undefined;
    let labelListCalls = 0;
    const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        if (url.pathname === '/v2/labels') {
          labelListCalls += 1;
          return Response.json({ labels: [] });
        }
        if (url.pathname === '/v2/rates/rate-1') {
          return mode === 'definite'
            ? Response.json({ errors: [{ error_code: 'invalid_rate', message: 'Private 100 Main St' }] }, { status: 400 })
            : Response.json(SHIPSTATION_RATE);
        }
        if (url.pathname === '/v2/labels/rates/rate-1') {
          if (mode === 'ambiguous') throw new TypeError('Private 100 Main St');
          return Response.json({
            label_id: 'label-1',
            shipment_id: 'shipment-1',
            ...(mode.startsWith('unsupported-status') ? { status: 'queued' } : {}),
            ...(mode.endsWith('-voided') ? { voided: true } : {}),
          });
        }
        return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        return Response.json(orderDocument({
          shipstation: {
            shipmentId: 'shipment-1',
            rateQuotes: [{
              rateId: 'rate-1',
              shipmentId: 'shipment-1',
              totalAmount: { currency: 'usd', amount: 10 },
            }],
            ...(purchaseState ? { labelPurchase: purchaseState } : {}),
          },
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
        commits.push(commit);
        const purchaseFields = (commit.writes[0] as {
          update?: {
            fields?: {
              shipstation?: {
                mapValue?: {
                  fields?: {
                    labelPurchase?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } };
                  };
                };
              };
            };
          };
        }).update?.fields?.shipstation?.mapValue?.fields?.labelPurchase?.mapValue?.fields;
        if (purchaseFields?.status?.stringValue) {
          purchaseState = {
            status: purchaseFields.status.stringValue,
            requestId: purchaseFields.requestId?.stringValue,
            rateId: purchaseFields.rateId?.stringValue,
          };
        }
        return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
      dependencies(providerFetch),
    );
    assert.equal(result.response.status, 409, mode);
    const payload = await result.response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, mode === 'definite' ? 'failed-precondition' : 'aborted');
    assert.doesNotMatch(JSON.stringify(payload), /100 Main St|Private/);
    if (mode !== 'definite') {
      assert.match(payload.error.message, /Check purchase status or open ShipStation/);
      assert.equal(labelListCalls, 3);
    }
    assert.equal(commits.length, 2, mode);
    const transitionFields = (commits[1].writes[0] as {
      update: {
        fields: {
          shipstation: {
            mapValue: {
              fields: {
                labelPurchase: { mapValue: { fields: Record<string, { stringValue?: string }> } };
              };
            };
          };
        };
      };
    }).update.fields.shipstation.mapValue.fields.labelPurchase.mapValue.fields;
    assert.equal(transitionFields.status.stringValue, mode === 'definite' ? 'failed' : 'unknown');
    assert.doesNotMatch(transitionFields.lastError.stringValue || '', /100 Main St|Private/);
  }
});

test('ShipStation label purchase stays unknown after a successful charge and repeated Commerce conflicts', async () => {
  let purchaseState: Record<string, unknown> | undefined;
  let purchaseCalls = 0;
  let persistenceConflicts = 0;
  const transitionStatuses: string[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
      if (url.pathname === '/v2/labels/rates/rate-1') {
        purchaseCalls += 1;
        return Response.json({
          label_id: 'charged-label',
          shipment_id: 'shipment-1',
          status: 'completed',
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          rateQuotes: [{
            rateId: 'rate-1',
            shipmentId: 'shipment-1',
            totalAmount: { currency: 'usd', amount: 10 },
          }],
          ...(purchaseState ? { labelPurchase: purchaseState } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      const write = commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: Record<string, unknown> } } } };
        updateMask?: { fieldPaths?: string[] };
      };
      const purchaseFields = ((write.update?.fields?.shipstation?.mapValue?.fields?.labelPurchase as {
        mapValue?: { fields?: Record<string, { stringValue?: string }> };
      } | undefined)?.mapValue?.fields);
      const status = purchaseFields?.status?.stringValue;
      if (write.updateMask?.fieldPaths?.includes('shipstation.label')) {
        persistenceConflicts += 1;
        return Response.json({ error: { status: 'ABORTED' } }, { status: 409 });
      }
      if (status) {
        transitionStatuses.push(status);
        purchaseState = {
          status,
          requestId: purchaseFields?.requestId?.stringValue ?? LABEL_PURCHASE_BODY.requestId,
          rateId: purchaseFields?.rateId?.stringValue ?? LABEL_PURCHASE_BODY.rateId,
        };
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    dependencies(providerFetch, { timeoutMs: 2_000 }),
  );
  assert.equal(result.response.status, 409);
  const payload = await result.response.json() as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'aborted');
  assert.match(payload.error.message, /Check purchase status or open ShipStation/);
  assert.equal(purchaseCalls, 1);
  assert.equal(persistenceConflicts, 3);
  assert.deepEqual(transitionStatuses, ['purchasing', 'unknown']);
  assert.equal(purchaseState?.status, 'unknown');
});

test('ShipStation label purchase timeout uses a fresh cleanup signal and stores unknown', async () => {
  let purchaseState: Record<string, unknown> | undefined;
  let chargedPostStarted = false;
  let chargedPostAborted = false;
  let cleanupUsedFreshSignal = false;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
      if (url.pathname === '/v2/labels/rates/rate-1') {
        chargedPostStarted = true;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => {
            chargedPostAborted = true;
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (chargedPostAborted) cleanupUsedFreshSignal ||= init?.signal?.aborted === false;
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          rateQuotes: [{
            rateId: 'rate-1',
            shipmentId: 'shipment-1',
            totalAmount: { currency: 'usd', amount: 10 },
          }],
          ...(purchaseState ? { labelPurchase: purchaseState } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      const fields = (commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: Record<string, unknown> } } } };
      }).update?.fields?.shipstation?.mapValue?.fields?.labelPurchase as {
        mapValue?: { fields?: Record<string, { stringValue?: string }> };
      } | undefined;
      const purchaseFields = fields?.mapValue?.fields;
      if (purchaseFields?.status?.stringValue) {
        purchaseState = {
          status: purchaseFields.status.stringValue,
          requestId: purchaseFields.requestId?.stringValue ?? LABEL_PURCHASE_BODY.requestId,
          rateId: purchaseFields.rateId?.stringValue ?? LABEL_PURCHASE_BODY.rateId,
        };
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    dependencies(providerFetch, { timeoutMs: 75 }),
  );
  assert.equal(chargedPostStarted, true);
  assert.equal(chargedPostAborted, true);
  assert.equal(cleanupUsedFreshSignal, false);
  assert.equal(result.response.status, 409);
  const payload = await result.response.json() as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'aborted');
  assert.equal(
    payload.error.message,
    'ShipStation did not confirm the label purchase. Check purchase status or open ShipStation before retrying.',
  );
  assert.equal(purchaseState?.status, 'unknown');
});

test('ShipStation label purchase cleanup failure keeps the claim blocked and logs only safe metadata', async () => {
  let purchaseState: Record<string, unknown> | undefined;
  let purchaseFailed = false;
  let commitCount = 0;
  const logs: string[] = [];
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
      if (url.pathname === '/v2/labels/rates/rate-1') {
        purchaseFailed = true;
        throw new TypeError('Private 100 Main St Bearer secret-token shipstation-api-key');
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      if (purchaseFailed) {
        return Response.json({ error: 'Private 100 Main St Bearer secret-token' }, { status: 500 });
      }
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          rateQuotes: [{
            rateId: 'rate-1',
            shipmentId: 'shipment-1',
            totalAmount: { currency: 'usd', amount: 10 },
          }],
          ...(purchaseState ? { labelPurchase: purchaseState } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commitCount += 1;
      purchaseState = {
        status: 'purchasing',
        requestId: LABEL_PURCHASE_BODY.requestId,
        rateId: LABEL_PURCHASE_BODY.rateId,
      };
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => logs.push(values.map(String).join(' '));
  try {
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
      dependencies(providerFetch, { timeoutMs: 2_000 }),
    );
    assert.equal(result.response.status, 409);
    const payload = await result.response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, 'aborted');
    assert.match(payload.error.message, /Check purchase status or open ShipStation/);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(commitCount, 1);
  assert.equal(purchaseState?.status, 'purchasing');
  assert.match(logs.join('\n'), /fulfillment_shipstation_label_purchase_cleanup_failed/);
  assert.doesNotMatch(logs.join('\n'), /Private|100 Main|Bearer|secret-token|shipstation-api-key/);
});

test('ShipStation label purchase route reconciles a label after an ambiguous charged request', async () => {
  let purchaseState: Record<string, unknown> | undefined;
  let labelListCalls = 0;
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') {
        labelListCalls += 1;
        return Response.json({
          labels: labelListCalls === 3
            ? [{
                label_id: 'recovered-label',
                shipment_id: 'shipment-1',
                status: 'completed',
                tracking_number: 'recovered-tracking',
              }]
            : [],
        });
      }
      if (url.pathname === '/v2/rates/rate-1') return Response.json(SHIPSTATION_RATE);
      if (url.pathname === '/v2/labels/rates/rate-1') throw new TypeError('connection closed');
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          rateQuotes: [{
            rateId: 'rate-1',
            shipmentId: 'shipment-1',
            totalAmount: { currency: 'usd', amount: 10 },
          }],
          ...(purchaseState ? { labelPurchase: purchaseState } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const purchaseFields = (commit.writes[0] as {
        update?: {
          fields?: {
            shipstation?: {
              mapValue?: {
                fields?: {
                  labelPurchase?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } };
                };
              };
            };
          };
        };
      }).update?.fields?.shipstation?.mapValue?.fields?.labelPurchase?.mapValue?.fields;
      if (purchaseFields?.status?.stringValue === 'purchasing') {
        purchaseState = {
          status: 'purchasing',
          requestId: purchaseFields.requestId?.stringValue,
          rateId: purchaseFields.rateId?.stringValue,
        };
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    alreadyPurchased: boolean;
    label: { labelId: string; trackingNumber: string };
  };
  assert.equal(payload.alreadyPurchased, false);
  assert.equal(payload.label.labelId, 'recovered-label');
  assert.equal(payload.label.trackingNumber, 'recovered-tracking');
  assert.equal(labelListCalls, 3);
  assert.equal(commits.length, 2);
  const persistence = commits[1].writes[0] as { updateMask: { fieldPaths: string[] } };
  assert.ok(persistence.updateMask.fieldPaths.includes('shipstation.labelPurchase'));
});

test('ShipStation label purchase route never charges after its Commerce claim is replaced', async () => {
  let purchaseState: Record<string, unknown> | undefined;
  let purchaseCalls = 0;
  let rateRead = false;
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/rates/rate-1') {
        rateRead = true;
        purchaseState = { status: 'purchasing', requestId: 'replacement-request', rateId: 'rate-2' };
        return Response.json(SHIPSTATION_RATE);
      }
      if (url.pathname === '/v2/labels/rates/rate-1') purchaseCalls += 1;
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          rateQuotes: [{
            rateId: 'rate-1',
            shipmentId: 'shipment-1',
            totalAmount: { currency: 'usd', amount: 10 },
          }],
          ...(purchaseState ? { labelPurchase: purchaseState } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      if (!rateRead) {
        purchaseState = {
          status: 'purchasing',
          requestId: LABEL_PURCHASE_BODY.requestId,
          rateId: LABEL_PURCHASE_BODY.rateId,
        };
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, LABEL_PURCHASE_BODY),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(purchaseCalls, 0);
  assert.equal(commits.length, 1);
});

test('ShipStation rates route refreshes a single package without replacing its ShipStation address', async () => {
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const shipStationCalls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const manuallyCorrectedShipTo = {
    ...SHIP_TO,
    name: 'Manually Corrected Recipient',
    address_line1: '200 Corrected Ave',
    address_line2: 'Suite 4',
    instructions: 'Side door',
  };
  let claimId = '';
  const currentOrder = () => orderDocument({
    addressSnapshot: {
      encrypted: 'stale-commerce-address',
      email: 'owner@example.com',
      phone: '+905551234567',
      countryCode: 'TR',
    },
    shipstation: {
      shipmentId: 'shipment-1',
      package: { length: 12, width: 9, height: 2, weight: 4 },
      packageCount: 1,
      ...(claimId ? { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER } : {}),
    },
  });
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      shipStationCalls.push({ method, path: `${url.pathname}${url.search}`, ...(body ? { body } : {}) });
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: {
            ...manuallyCorrectedShipTo,
            address_validation_status: 'verified',
          },
          packages: [{
            weight: { value: 4, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          }],
        });
      }
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: manuallyCorrectedShipTo,
          packages: [{
            weight: { value: 8, unit: 'ounce' },
            dimensions: { length: 10, width: 8, height: 3, unit: 'inch' },
          }],
        });
      }
      if (url.pathname === '/v2/carriers') {
        return Response.json({ carriers: [{ carrier_id: 'carrier-1', send_rates: true }] });
      }
      if (url.pathname === '/v2/rates') {
        return Response.json({
          shipment_id: 'shipment-1',
          rate_request_id: 'request-1',
          status: 'completed',
          rates: [{
            rate_id: 'rate-1',
            shipment_id: 'shipment-1',
            carrier_id: 'carrier-1',
            carrier_code: 'ups',
            carrier_friendly_name: 'UPS',
            service_code: 'ups_ground',
            service_type: 'UPS Ground',
            validation_status: 'valid',
            shipping_amount: { currency: 'usd', amount: 10 },
            insurance_amount: { currency: 'usd', amount: 1 },
            confirmation_amount: { currency: 'usd', amount: 0 },
            other_amount: { currency: 'usd', amount: 0.5 },
            warning_messages: [],
            error_messages: [],
          }],
          invalid_rates: [],
          errors: [],
        });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) return Response.json(currentOrder());
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const write = commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: { ratesClaimId?: { stringValue?: string } } } } } };
      };
      claimId = write.update?.fields?.shipstation?.mapValue?.fields?.ratesClaimId?.stringValue ?? claimId;
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      package: { length: 10, width: 8, height: 3, weight: 8 },
    }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    package: Record<string, number>;
    packageCount: number;
    rates: Array<{ rateId: string; totalAmount: { currency: string; amount: number } }>;
  };
  assert.deepEqual(payload.package, { length: 10, width: 8, height: 3, weight: 8 });
  assert.equal(payload.packageCount, 1);
  assert.equal(payload.rates[0].rateId, 'rate-1');
  assert.deepEqual(payload.rates[0].totalAmount, { currency: 'usd', amount: 11.5 });
  const shipmentUpdate = shipStationCalls.find((call) => call.method === 'PUT');
  assert.deepEqual(shipmentUpdate?.body, {
    ship_to: manuallyCorrectedShipTo,
    ship_from: SHIP_FROM,
    packages: [{
      content_description: 'Printed collectible art card',
      weight: { value: 8, unit: 'ounce' },
      dimensions: { length: 10, width: 8, height: 3, unit: 'inch' },
      products: [{
        description: 'Printed collectible art card',
        quantity: 1,
        value: { amount: 14.67, currency: 'usd' },
        weight: { value: 0.2, unit: 'ounce' },
        harmonized_tariff_code: '4911.99',
        country_of_origin: 'US',
        sku: 'card-nft-2',
      }],
    }],
    customs: {
      contents: 'merchandise',
      non_delivery: 'return_to_sender',
      terms_of_trade_code: 'dap',
    },
  });
  assert.equal(commits.length, 3);
  const claim = commits[0].writes[0] as {
    updateMask: { fieldPaths: string[] };
    updateTransforms: unknown[];
  };
  assert.deepEqual(claim.updateMask.fieldPaths, [
    'shipstation.rateQuotes',
    'shipstation.ratesClaimId',
    'shipstation.ratesClaimedBy',
    'shipstation.ratesClaimFenceId',
  ]);
  assert.deepEqual(claim.updateTransforms, [
    { fieldPath: 'shipstation.ratesClaimedAt', setToServerValue: 'REQUEST_TIME' },
  ]);
  const finalWrite = commits[2].writes[0] as {
    update: { fields: { shipstation: { mapValue: { fields: Record<string, unknown> } } } };
    updateMask: { fieldPaths: string[] };
  };
  const finalFields = finalWrite.update.fields.shipstation.mapValue.fields;
  assert.ok(Object.hasOwn(finalFields, 'rateQuotes'));
  assert.ok(Object.hasOwn(finalFields, 'ratesUpdatedBy'));
  assert.ok(!Object.hasOwn(finalFields, 'ratesClaimedAt'));
  assert.ok(finalWrite.updateMask.fieldPaths.includes('shipstation.rateRequest'));
  assert.ok(finalWrite.updateMask.fieldPaths.includes('shipstation.ratesClaimId'));
  assert.ok(finalWrite.updateMask.fieldPaths.includes('shipstation.ratesClaimedAt'));
});

test('ShipStation rates route preserves manual declarations, repairs zeroed packages, and keeps domestic parcels', async () => {
  const run = async (scenario: {
    shipTo: Record<string, unknown>;
    sourcePackage: Record<string, unknown>;
    storedPackage: Record<string, number>;
    customs?: Record<string, unknown>;
    items?: Array<Record<string, unknown>>;
  }) => {
    let claimId = '';
    let shipmentUpdate: Record<string, unknown> | undefined;
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        const method = init?.method || 'GET';
        if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
        if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
          return Response.json({
            shipment_id: 'shipment-1',
            ship_to: scenario.shipTo,
            packages: [scenario.sourcePackage],
            ...(scenario.customs ? { customs: scenario.customs } : {}),
          });
        }
        if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') {
          shipmentUpdate = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({
            shipment_id: 'shipment-1',
            ship_to: shipmentUpdate.ship_to,
            packages: shipmentUpdate.packages,
          });
        }
        if (url.pathname === '/v2/carriers') {
          return Response.json({ carriers: [{ carrier_id: 'carrier-1', send_rates: true }] });
        }
        if (url.pathname === '/v2/rates') {
          return Response.json({
            shipment_id: 'shipment-1',
            rate_request_id: 'request-1',
            status: 'completed',
            rates: [SHIPSTATION_RATE],
            invalid_rates: [],
            errors: [],
          });
        }
        return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        return Response.json(orderDocument({
          items: scenario.items ?? [{ kind: 'dude', refId: 1 }],
          shipstation: {
            shipmentId: 'shipment-1',
            package: scenario.storedPackage,
            packageCount: 1,
            ...(claimId ? { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER } : {}),
          },
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        const commit = JSON.parse(String(init?.body)) as {
          writes: Array<{
            update?: { fields?: { shipstation?: { mapValue?: { fields?: { ratesClaimId?: { stringValue?: string } } } } } };
          }>;
        };
        claimId = commit.writes[0].update?.fields?.shipstation?.mapValue?.fields?.ratesClaimId?.stringValue ?? claimId;
        return Response.json({ writeResults: [{}], commitTime: '2026-08-19T00:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_RATES_PATH,
      dependencies(providerFetch),
    );
    assert.equal(result.response.status, 200);
    return shipmentUpdate;
  };

  const manualProduct = {
    description: 'Manual cotton art card case',
    quantity: 2,
    value: { amount: 91.25, currency: 'eur' },
    weight: { value: 2, unit: 'ounce' },
    harmonized_tariff_code: '4202.92',
    country_of_origin: 'PT',
    unit_of_measure: 'each',
    sku: 'manual-case',
    sku_description: 'Manual case correction',
    mid_code: 'PTMANUAL123',
    product_url: 'https://mons.shop/manual-case',
    vat_rate: 0.2,
  };
  const manualCustoms = {
    contents: 'gift',
    non_delivery: 'treat_as_abandoned',
    terms_of_trade_code: 'ddp',
    declaration: 'Manual declaration',
    pending_documents: true,
  };
  const manualUpdate = await run({
    shipTo: { ...SHIP_TO, address_line1: '200 Manually Corrected Ave' },
    sourcePackage: {
      package_id: 'se-3',
      package_code: 'package',
      shipment_package_id: 'se-read-only',
      package_name: 'Read only',
      tracking_number: 'private-tracking',
      weight: { value: 20, unit: 'ounce' },
      dimensions: { length: 14, width: 10, height: 4, unit: 'inch' },
      insured_value: { amount: 50, currency: 'usd' },
      label_messages: { reference1: 'Manual reference', reference2: null, reference3: null },
      external_package_id: 'parcel-7',
      content_description: 'Manual corrected contents',
      products: [manualProduct],
    },
    storedPackage: { length: 12, width: 9, height: 2, weight: 12 },
    customs: manualCustoms,
  });
  assert.deepEqual(manualUpdate, {
    ship_to: { ...SHIP_TO, address_line1: '200 Manually Corrected Ave' },
    ship_from: SHIP_FROM,
    packages: [{
      package_id: 'se-3',
      package_code: 'package',
      insured_value: { amount: 50, currency: 'usd' },
      label_messages: { reference1: 'Manual reference', reference2: null, reference3: null },
      external_package_id: 'parcel-7',
      content_description: 'Manual corrected contents',
      products: [manualProduct],
      weight: { value: 20, unit: 'ounce' },
      dimensions: { length: 14, width: 10, height: 4, unit: 'inch' },
    }],
    customs: manualCustoms,
  });

  const repairedUpdate = await run({
    shipTo: SHIP_TO,
    sourcePackage: {
      package_code: 'package',
      shipment_package_id: 'se-read-only',
      weight: { value: 0, unit: 'ounce' },
      dimensions: { length: 0, width: 0, height: 0, unit: 'inch' },
    },
    storedPackage: { length: 12, width: 9, height: 2, weight: 12 },
    items: [{ kind: 'box', refId: 1 }, { kind: 'dude', refId: 2 }],
  });
  assert.deepEqual(repairedUpdate, {
    ship_to: SHIP_TO,
    ship_from: SHIP_FROM,
    packages: [{
      package_code: 'package',
      content_description: 'Printed collectible art card',
      products: [{
        description: 'Printed collectible art card',
        quantity: 4,
        value: { amount: 14.67, currency: 'usd' },
        weight: { value: 0.2, unit: 'ounce' },
        harmonized_tariff_code: '4911.99',
        country_of_origin: 'US',
        sku: 'card-nft-2',
      }],
      weight: { value: 12, unit: 'ounce' },
      dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
    }],
    customs: {
      contents: 'merchandise',
      non_delivery: 'return_to_sender',
      terms_of_trade_code: 'dap',
    },
  });

  const domesticShipTo = {
    ...SHIP_TO,
    city_locality: 'New York',
    state_province: 'NY',
    postal_code: '10001',
    country_code: 'US',
  };
  const domesticUpdate = await run({
    shipTo: domesticShipTo,
    sourcePackage: {
      package_code: 'package',
      weight: { value: 15, unit: 'ounce' },
      dimensions: { length: 13, width: 8, height: 3, unit: 'inch' },
    },
    storedPackage: { length: 12, width: 9, height: 2, weight: 12 },
  });
  assert.deepEqual(domesticUpdate, {
    ship_to: domesticShipTo,
    ship_from: SHIP_FROM,
    packages: [{
      package_code: 'package',
      weight: { value: 15, unit: 'ounce' },
      dimensions: { length: 13, width: 8, height: 3, unit: 'inch' },
    }],
  });
});

test('ShipStation rates route rejects a parcel lighter than its declared products', async () => {
  let claimId = '';
  let updateCalls = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      const method = init?.method || 'GET';
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: SHIP_TO,
          customs: {
            contents: 'merchandise',
            non_delivery: 'return_to_sender',
            terms_of_trade_code: 'dap',
          },
          packages: [{
            content_description: 'Manual cotton T-shirt',
            weight: { value: 4, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
            products: [{
              description: 'Manual cotton T-shirt',
              quantity: 1,
              value: { amount: 144, currency: 'usd' },
              weight: { value: 10, unit: 'ounce' },
              harmonized_tariff_code: '6109.10',
              country_of_origin: 'US',
              sku: 'manual-shirt',
            }],
          }],
        });
      }
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') updateCalls += 1;
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          package: { length: 12, width: 9, height: 2, weight: 4 },
          packageCount: 1,
          ...(claimId ? { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as {
        writes: Array<{
          update?: { fields?: { shipstation?: { mapValue?: { fields?: { ratesClaimId?: { stringValue?: string } } } } } };
        }>;
      };
      claimId = commit.writes[0].update?.fields?.shipstation?.mapValue?.fields?.ratesClaimId?.stringValue ?? claimId;
      return Response.json({ writeResults: [{}], commitTime: '2026-08-19T00:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    error: {
      code: 'failed-precondition',
      message: 'Package weight must be at least 10 oz for the customs items in this shipment.',
    },
  });
  assert.equal(updateCalls, 0);
});

test('ShipStation rates route resumes and polls pending requests with exact delays', async () => {
  const rate = {
    rate_id: 'rate-1',
    shipment_id: 'shipment-1',
    carrier_id: 'carrier-1',
    carrier_code: 'ups',
    carrier_friendly_name: 'UPS',
    service_code: 'ups_ground',
    service_type: 'UPS Ground',
    validation_status: 'valid',
    shipping_amount: { currency: 'usd', amount: 10 },
    insurance_amount: { currency: 'usd', amount: 0 },
    confirmation_amount: { currency: 'usd', amount: 0 },
    other_amount: { currency: 'usd', amount: 0 },
    warning_messages: [],
    error_messages: [],
  };
  const run = async (mode: 'fresh' | 'resumed' | 'changed' | 'working') => {
    const packageWeight = mode === 'resumed' ? 1616 : 4;
    const product = {
      description: 'Printed collectible art card',
      quantity: 1,
      value: { amount: 14.67, currency: 'usd' },
      weight: { value: 0.2, unit: 'ounce' },
      harmonized_tariff_code: '4911.99',
      country_of_origin: 'US',
      sku: 'card-nft-2',
    };
    const inputHash = await profileWriteTestHooks.shipStationRateInputHash({
      ship_to: SHIP_TO,
      ship_from: SHIP_FROM,
      packages: [{
        content_description: 'Printed collectible art card',
        products: [product],
        weight: { value: packageWeight, unit: 'ounce' },
        dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
      }],
      customs: {
        contents: 'merchandise',
        non_delivery: 'return_to_sender',
        terms_of_trade_code: 'dap',
      },
    });
    let claimId = '';
    let pollCalls = 0;
    const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
    const delays: number[] = [];
    const shipStationCalls: string[] = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        const method = init?.method || 'GET';
        shipStationCalls.push(`${method} ${url.pathname}`);
        if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
        if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
          return Response.json({
            shipment_id: 'shipment-1',
            ship_to: SHIP_TO,
            customs: {
              contents: 'merchandise',
              non_delivery: 'return_to_sender',
              terms_of_trade_code: 'dap',
            },
            packages: [{
              content_description: 'Printed collectible art card',
              weight: { value: packageWeight, unit: 'ounce' },
              dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
              products: [product],
            }],
          });
        }
        if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') {
          return Response.json({
            shipment_id: 'shipment-1',
            packages: [{
              weight: { value: packageWeight, unit: 'ounce' },
              dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
            }],
          });
        }
        if (url.pathname === '/v2/carriers') {
          return Response.json({ carriers: [{ carrier_id: 'carrier-1' }] });
        }
        if (url.pathname === '/v2/rates' && method === 'POST') {
          return Response.json({
            shipment_id: 'shipment-1',
            rate_request_id: 'request-1',
            created_at: '2026-08-19T00:00:00Z',
            status: 'working',
            rates: [],
          });
        }
        if (url.pathname === '/v2/shipments/shipment-1/rates') {
          pollCalls += 1;
          const completed = mode === 'resumed' || mode === 'changed' || (mode === 'fresh' && pollCalls === 3);
          return Response.json([{
            shipment_id: 'shipment-1',
            rate_request_id: 'request-1',
            created_at: '2026-08-19T00:00:00Z',
            status: completed ? 'completed' : 'working',
            rates: completed ? [rate] : [],
          }]);
        }
        return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        return Response.json(orderDocument({
          addressSnapshot: {
            encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
            countryCode: 'TR',
          },
          shipstation: {
            shipmentId: 'shipment-1',
            package: { length: 12, width: 9, height: 2, weight: packageWeight },
            packageCount: 1,
            ...(mode === 'resumed' || mode === 'changed' ? {
              rateRequest: {
                requestId: 'request-1',
                createdAt: '2026-08-19T00:00:00Z',
                requestedAt: NOW_MS - 1_000,
                shipmentId: 'shipment-1',
                inputHash: mode === 'changed' ? '0'.repeat(64) : inputHash,
                package: { length: 12, width: 9, height: 2, weight: packageWeight },
              },
            } : {}),
            ...(claimId ? { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER } : {}),
          },
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
        commits.push(commit);
        const fields = (commit.writes[0] as {
          update?: { fields?: { shipstation?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } } } };
        }).update?.fields?.shipstation?.mapValue?.fields;
        claimId = fields?.ratesClaimId?.stringValue ?? claimId;
        return Response.json({ writeResults: [{}], commitTime: '2026-08-19T00:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_RATES_PATH,
      dependencies(providerFetch, {
        pauseForRatePoll: async (_signal, delayMs) => { delays.push(delayMs); },
      }),
    );
    return { commits, delays, result, shipStationCalls };
  };

  const fresh = await run('fresh');
  assert.equal(fresh.result.response.status, 200);
  assert.deepEqual(fresh.delays, [400, 800, 1200]);
  assert.equal(fresh.commits.length, 4);
  assert.ok((fresh.commits[2].writes[0] as { updateMask: { fieldPaths: string[] } })
    .updateMask.fieldPaths.includes('shipstation.rateRequest.requestId'));

  const resumed = await run('resumed');
  assert.equal(resumed.result.response.status, 200);
  assert.deepEqual(resumed.delays, []);
  assert.equal(resumed.shipStationCalls.some((call) => call === 'GET /v2/carriers'), false);
  assert.equal(resumed.shipStationCalls.some((call) => call === 'POST /v2/rates'), false);

  const changed = await run('changed');
  assert.equal(changed.result.response.status, 200);
  assert.equal(changed.shipStationCalls.some((call) => call === 'GET /v2/carriers'), true);
  assert.equal(changed.shipStationCalls.some((call) => call === 'POST /v2/rates'), true);

  const working = await run('working');
  assert.equal(working.result.response.status, 502);
  assert.equal((await working.result.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.deepEqual(working.delays, [400, 800, 1200]);
  assert.deepEqual(
    (working.commits.at(-1)?.writes[0] as { updateMask: { fieldPaths: string[] } }).updateMask.fieldPaths,
    [
      'shipstation.ratesClaimId',
      'shipstation.ratesClaimedAt',
      'shipstation.ratesClaimedBy',
      'shipstation.ratesClaimFenceId',
    ],
  );
});

test('ShipStation rates route maps rate limits, timeouts, and oversized responses', async () => {
  const run = async (mode: 'rate-limit' | 'timeout' | 'oversized') => {
    let claimId = '';
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        const method = init?.method || 'GET';
        if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
        if (url.pathname === '/v2/shipments/shipment-1') {
          return Response.json({
            shipment_id: 'shipment-1',
            ship_to: SHIP_TO,
            packages: [{
              weight: { value: 4, unit: 'ounce' },
              dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
            }],
          });
        }
        if (url.pathname === '/v2/carriers') {
          if (mode === 'rate-limit') return Response.json({ errors: [] }, { status: 429 });
          if (mode === 'oversized') {
            return new Response('{}', { headers: { 'Content-Length': String(513 * 1024) } });
          }
          return new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(init?.signal?.reason);
            init?.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        return Response.json({ error: `unexpected ${method} ${url.pathname}` }, { status: 500 });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        return Response.json(orderDocument({
          addressSnapshot: {
            encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
            countryCode: 'TR',
          },
          shipstation: {
            shipmentId: 'shipment-1',
            package: { length: 12, width: 9, height: 2, weight: 4 },
            packageCount: 1,
            ...(claimId ? { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER } : {}),
          },
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
        const fields = (commit.writes[0] as {
          update?: { fields?: { shipstation?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } } } };
        }).update?.fields?.shipstation?.mapValue?.fields;
        claimId = fields?.ratesClaimId?.stringValue ?? claimId;
        return Response.json({ writeResults: [{}], commitTime: '2026-08-19T00:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    return handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_RATES_PATH,
      dependencies(providerFetch, { ...(mode === 'timeout' ? { timeoutMs: 50 } : {}) }),
    );
  };

  for (const [mode, status, code] of [
    ['rate-limit', 429, 'resource-exhausted'],
    ['timeout', 504, 'deadline-exceeded'],
    ['oversized', 502, 'unavailable'],
  ] as const) {
    const result = await run(mode);
    assert.equal(result.response.status, status, mode);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, code, mode);
  }
});

test('ShipStation rates route rejects a fresh foreign claim before reading a multi-package shipment', async () => {
  let shipmentReads = 0;
  let commits = 0;
  const providerFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1') {
        shipmentReads += 1;
        return Response.json({ shipment_id: 'shipment-1', packages: [{}, {}] });
      }
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          ratesClaimId: 'foreign-claim',
          ratesClaimedAt: NOW_MS - 1_000,
          ratesClaimedBy: OTHER,
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits += 1;
      return Response.json({ writeResults: [{}] });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.equal(shipmentReads, 0);
  assert.equal(commits, 0);
});

test('ShipStation rates route rejects same-id label state changes', async () => {
  let claimed = false;
  let claimId = '';
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: SHIP_TO,
          packages: [{
            weight: { value: 4, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          }],
        });
      }
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        addressSnapshot: {
          encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
          countryCode: 'TR',
        },
        shipstation: {
          shipmentId: 'shipment-1',
          label: {
            labelId: 'label-1',
            shipmentId: 'shipment-1',
            status: claimed ? 'voided' : 'error',
            trackingNumber: claimed ? 'new-tracking' : 'old-tracking',
          },
          ...(claimId ? { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const fields = (commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } } } };
      }).update?.fields?.shipstation?.mapValue?.fields;
      if (fields?.ratesClaimId?.stringValue) {
        claimId = fields.ratesClaimId.stringValue;
        claimed = true;
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-19T00:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(commits.length, 2);
});

test('ShipStation rates route stops when an updated shipment becomes multi-package', async () => {
  let claimId = '';
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const shipStationPaths: string[] = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      const method = init?.method || 'GET';
      shipStationPaths.push(`${method} ${url.pathname}`);
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'GET') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: SHIP_TO,
          packages: [{
            weight: { value: 4, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          }],
        });
      }
      if (url.pathname === '/v2/shipments/shipment-1' && method === 'PUT') {
        return Response.json({ shipment_id: 'shipment-1', packages: [{}, {}] });
      }
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        addressSnapshot: {
          encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
          countryCode: 'TR',
        },
        shipstation: {
          shipmentId: 'shipment-1',
          ...(claimId ? { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const write = commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: { ratesClaimId?: { stringValue?: string } } } } } };
      };
      claimId = write.update?.fields?.shipstation?.mapValue?.fields?.ratesClaimId?.stringValue ?? claimId;
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    packageCount: 2,
    rates: [],
    invalidRates: [],
  });
  assert.equal(commits.length, 2);
  const cleanup = commits[1].writes[0] as {
    update: { fields: { shipstation: { mapValue: { fields: { packageCount: { integerValue: string } } } } } };
    updateMask: { fieldPaths: string[] };
  };
  assert.equal(cleanup.update.fields.shipstation.mapValue.fields.packageCount.integerValue, '2');
  assert.deepEqual(cleanup.updateMask.fieldPaths, [
    'shipstation.packageCount',
    'shipstation.package',
    'shipstation.rateQuotes',
    'shipstation.rateRequest',
    'shipstation.ratesClaimId',
    'shipstation.ratesClaimedAt',
    'shipstation.ratesClaimedBy',
  ]);
  assert.equal(shipStationPaths.some((path) => path.includes('/v2/rates') || path.includes('/v2/carriers')), false);
});

test('ShipStation rates route rejects concurrent label, purchase, and claim changes', async () => {
  for (const race of ['label', 'purchase', 'claim'] as const) {
    let claimId = '';
    let claimWritten = false;
    const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
    const shipStationPaths: string[] = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.shipstation.com') {
        const method = init?.method || 'GET';
        shipStationPaths.push(`${method} ${url.pathname}`);
        if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
        if (url.pathname === '/v2/shipments/shipment-1') {
          return Response.json({
            shipment_id: 'shipment-1',
            ship_to: SHIP_TO,
            packages: [{
              weight: { value: 4, unit: 'ounce' },
              dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
            }],
          });
        }
        return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
      }
      if (url.pathname.endsWith('/deliveryOrders/7')) {
        const concurrentState = claimWritten
          ? race === 'label'
            ? { label: { labelId: 'label-new', shipmentId: 'shipment-1', status: 'completed', purchasedAt: NOW_MS } }
            : race === 'purchase'
              ? { labelPurchase: { status: 'purchasing', requestId: 'purchase-new' } }
              : {}
          : {};
        return Response.json(orderDocument({
          addressSnapshot: {
            encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
            countryCode: 'TR',
          },
          shipstation: {
            shipmentId: 'shipment-1',
            ...(claimWritten
              ? race === 'claim'
                ? { ratesClaimId: 'claim-new', ratesClaimedAt: NOW_MS, ratesClaimedBy: OTHER }
                : { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER }
              : {}),
            ...concurrentState,
          },
        }));
      }
      if (url.pathname.endsWith('/documents:commit')) {
        const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
        commits.push(commit);
        const write = commit.writes[0] as {
          update?: { fields?: { shipstation?: { mapValue?: { fields?: { ratesClaimId?: { stringValue?: string } } } } } };
        };
        const writtenClaimId = write.update?.fields?.shipstation?.mapValue?.fields?.ratesClaimId?.stringValue;
        if (writtenClaimId) {
          claimId = writtenClaimId;
          claimWritten = true;
        }
        return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };
    const result = await handleProfileWriteRequest(
      request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
      fulfillmentEnv,
      FULFILLMENT_SHIPSTATION_RATES_PATH,
      dependencies(providerFetch),
    );
    assert.equal(result.response.status, 409, race);
    assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted', race);
    assert.equal(commits.length, race === 'claim' ? 1 : 2, race);
    assert.equal(shipStationPaths.some((path) => path.includes('/v2/rates') || path.includes('/v2/carriers')), false);
  }
});

test('ShipStation rates route preserves purchase, package-count, and refresh-claim guards', async () => {
  let scenario: 'purchase' | 'multi' | 'claimed' = 'purchase';
  let commits = 0;
  let claimId = '';
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: SHIP_TO,
          packages: scenario === 'multi'
            ? [{ weight: {}, dimensions: {} }, { weight: {}, dimensions: {} }]
            : [{
                weight: { value: 4, unit: 'ounce' },
                dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
              }],
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        addressSnapshot: {},
        shipstation: {
          shipmentId: 'shipment-1',
          ...(scenario === 'purchase' ? { labelPurchase: { status: 'unknown' } } : {}),
          ...(scenario === 'claimed' ? { ratesClaimedAt: NOW_MS - 1_000, ratesClaimedBy: OTHER } : {}),
          ...(scenario === 'multi' && claimId
            ? { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER }
            : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      commits += 1;
      const commit = JSON.parse(String(init?.body)) as {
        writes: Array<{
          update?: { fields?: { shipstation?: { mapValue?: { fields?: { ratesClaimId?: { stringValue?: string } } } } } };
        }>;
      };
      claimId = commit.writes[0]?.update?.fields?.shipstation?.mapValue?.fields?.ratesClaimId?.stringValue ?? claimId;
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const invoke = () => handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch),
  );
  const purchase = await invoke();
  assert.equal(purchase.response.status, 200);
  assert.equal((await purchase.response.json() as { purchaseUnknown: boolean }).purchaseUnknown, true);
  assert.equal(commits, 0);
  scenario = 'multi';
  claimId = '';
  const multi = await invoke();
  assert.equal(multi.response.status, 200);
  assert.equal((await multi.response.json() as { packageCount: number }).packageCount, 2);
  assert.equal(commits, 2);
  scenario = 'claimed';
  commits = 0;
  const claimed = await invoke();
  assert.equal(claimed.response.status, 409);
  assert.equal((await claimed.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(commits, 0);
  const missingOrigin = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    { ...fulfillmentEnv, SHIPSTATION_SHIP_FROM: '' },
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(missingOrigin.response.status, 409);
  assert.equal((await missingOrigin.response.json() as { error: { code: string } }).error.code, 'failed-precondition');
  assert.equal(missingOrigin.authOutcome, 'provider-failure');
});

test('ShipStation rates route safely releases its own claim after an upstream failure', async () => {
  let orderReads = 0;
  let claimId = '';
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1' && (init?.method || 'GET') === 'GET') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: SHIP_TO,
          packages: [{
            weight: { value: 4, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          }],
        });
      }
      if (url.pathname === '/v2/shipments/shipment-1' && init?.method === 'PUT') {
        return Response.json({ errors: [{ error_code: 'server_error' }] }, { status: 503 });
      }
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      orderReads += 1;
      return Response.json(orderDocument({
        addressSnapshot: {
          encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
          countryCode: 'TR',
        },
        shipstation: {
          shipmentId: 'shipment-1',
          ...(claimId ? { ratesClaimId: claimId, ratesClaimedAt: NOW_MS, ratesClaimedBy: OWNER } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const write = commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: { ratesClaimId?: { stringValue?: string } } } } } };
      };
      claimId = write.update?.fields?.shipstation?.mapValue?.fields?.ratesClaimId?.stringValue ?? claimId;
      return Response.json({ writeResults: [{}], commitTime: '2026-08-18T12:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 502);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'unavailable');
  assert.equal(commits.length, 2);
  assert.deepEqual(
    (commits[1].writes[0] as { updateMask: { fieldPaths: string[] } }).updateMask.fieldPaths,
    [
      'shipstation.ratesClaimId',
      'shipstation.ratesClaimedAt',
      'shipstation.ratesClaimedBy',
      'shipstation.ratesClaimFenceId',
    ],
  );
});

test('ShipStation rates route releases a claim whose successful commit response was lost', async () => {
  let currentClaimId = '';
  let currentClaimedBy = '';
  let claimCommitCalls = 0;
  let released = false;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          ...(currentClaimId ? {
            ratesClaimId: currentClaimId,
            ratesClaimedAt: NOW_MS,
            ratesClaimedBy: currentClaimedBy,
          } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as {
        writes: Array<{
          update?: { fields?: { shipstation?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } } } };
          updateMask?: { fieldPaths?: string[] };
        }>;
      };
      const write = commit.writes[0];
      const fields = write.update?.fields?.shipstation?.mapValue?.fields;
      const writtenClaimId = fields?.ratesClaimId?.stringValue;
      if (writtenClaimId) {
        claimCommitCalls += 1;
        if (claimCommitCalls === 1) {
          currentClaimId = writtenClaimId;
          currentClaimedBy = fields?.ratesClaimedBy?.stringValue ?? '';
          throw new TypeError('connection closed after commit');
        }
        return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 409 });
      }
      if (write.updateMask?.fieldPaths?.includes('shipstation.ratesClaimId')) {
        released = true;
        currentClaimId = '';
        currentClaimedBy = '';
        return Response.json({ writeResults: [{}], commitTime: '2026-08-19T00:00:00Z' });
      }
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch, { timeoutMs: 2_000 }),
  );
  assert.equal(result.response.status, 409);
  assert.equal((await result.response.json() as { error: { code: string } }).error.code, 'aborted');
  assert.equal(claimCommitCalls, 2);
  assert.equal(released, true);
  assert.equal(currentClaimId, '');
});

test('ShipStation rates route releases a claim that becomes visible during cleanup', async () => {
  let pendingClaimId = '';
  let pendingClaimedBy = '';
  let currentClaimId = '';
  let currentClaimedBy = '';
  let claimCommitCalls = 0;
  let claimFailed = false;
  let cleanupReads = 0;
  let released = false;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      return Response.json({ error: 'unexpected ShipStation request' }, { status: 500 });
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      const response = Response.json(orderDocument({
        shipstation: {
          shipmentId: 'shipment-1',
          ...(currentClaimId ? {
            ratesClaimId: currentClaimId,
            ratesClaimedAt: NOW_MS,
            ratesClaimedBy: currentClaimedBy,
          } : {}),
        },
      }));
      if (claimFailed) {
        cleanupReads += 1;
        if (cleanupReads === 1) {
          currentClaimId = pendingClaimId;
          currentClaimedBy = pendingClaimedBy;
        }
      }
      return response;
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as {
        writes: Array<{
          update?: { fields?: { shipstation?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } } } };
          updateMask?: { fieldPaths?: string[] };
        }>;
      };
      const write = commit.writes[0];
      const fields = write.update?.fields?.shipstation?.mapValue?.fields;
      const writtenClaimId = fields?.ratesClaimId?.stringValue;
      if (writtenClaimId) {
        claimCommitCalls += 1;
        pendingClaimId = writtenClaimId;
        pendingClaimedBy = fields?.ratesClaimedBy?.stringValue ?? '';
        if (claimCommitCalls === 2) claimFailed = true;
        throw new TypeError('connection closed while commit was in flight');
      }
      if (fields?.ratesClaimFenceId?.stringValue) {
        return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 409 });
      }
      if (write.updateMask?.fieldPaths?.includes('shipstation.ratesClaimId')) {
        released = true;
        currentClaimId = '';
        currentClaimedBy = '';
        return Response.json({ writeResults: [{}], commitTime: '2026-08-19T00:00:00Z' });
      }
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch, { timeoutMs: 2_000 }),
  );
  assert.equal(result.response.status, 502);
  assert.equal(cleanupReads, 2);
  assert.equal(released, true);
  assert.equal(currentClaimId, '');
});

test('ShipStation rates route never releases a replacement claim', async () => {
  let currentClaimId = '';
  let currentClaimedBy = '';
  const commits: Array<{ writes: Array<Record<string, unknown>> }> = [];
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.shipstation.com') {
      if (url.pathname === '/v2/labels') return Response.json({ labels: [] });
      if (url.pathname === '/v2/shipments/shipment-1' && (init?.method || 'GET') === 'GET') {
        return Response.json({
          shipment_id: 'shipment-1',
          ship_to: SHIP_TO,
          packages: [{
            weight: { value: 4, unit: 'ounce' },
            dimensions: { length: 12, width: 9, height: 2, unit: 'inch' },
          }],
        });
      }
      if (url.pathname === '/v2/shipments/shipment-1' && init?.method === 'PUT') {
        currentClaimId = 'replacement-claim';
        currentClaimedBy = OTHER;
        return Response.json({ errors: [{ error_code: 'server_error' }] }, { status: 503 });
      }
    }
    if (url.pathname.endsWith('/deliveryOrders/7')) {
      return Response.json(orderDocument({
        addressSnapshot: {
          encrypted: encryptedAddress('Ivan\n100 Main St\nIstanbul, 34000\nTurkey'),
          countryCode: 'TR',
        },
        shipstation: {
          shipmentId: 'shipment-1',
          ...(currentClaimId ? {
            ratesClaimId: currentClaimId,
            ratesClaimedAt: NOW_MS,
            ratesClaimedBy: currentClaimedBy,
          } : {}),
        },
      }));
    }
    if (url.pathname.endsWith('/documents:commit')) {
      const commit = JSON.parse(String(init?.body)) as { writes: Array<Record<string, unknown>> };
      commits.push(commit);
      const fields = (commit.writes[0] as {
        update?: { fields?: { shipstation?: { mapValue?: { fields?: Record<string, { stringValue?: string }> } } } };
      }).update?.fields?.shipstation?.mapValue?.fields;
      if (fields?.ratesClaimId?.stringValue) {
        currentClaimId = fields.ratesClaimId.stringValue;
        currentClaimedBy = fields.ratesClaimedBy?.stringValue ?? '';
      }
      return Response.json({ writeResults: [{}], commitTime: '2026-08-19T00:00:00Z' });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  const result = await handleProfileWriteRequest(
    request(FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7 }),
    fulfillmentEnv,
    FULFILLMENT_SHIPSTATION_RATES_PATH,
    dependencies(providerFetch),
  );
  assert.equal(result.response.status, 502);
  assert.equal(commits.length, 1);
  assert.equal(currentClaimId, 'replacement-claim');
  assert.equal(currentClaimedBy, OTHER);
});

test('write routes reject invalid payloads, unauthorized wallets, and missing orders without Commerce configuration', async () => {
  let upstreamCalls = 0;
  const neverFetch: typeof fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
  for (const body of [
    { encrypted: 'cipher', country: 'US', hint: 'hint', extra: true },
    { id: 'invalid', encrypted: 'cipher', country: 'US', hint: 'hint' },
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
    [FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, { ...LABEL_PURCHASE_BODY, extra: true }],
    [FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, { ...LABEL_PURCHASE_BODY, requestId: 'not-a-uuid' }],
    [FULFILLMENT_SHIPSTATION_LABEL_PURCHASE_PATH, {
      ...LABEL_PURCHASE_BODY,
      expectedTotal: { currency: 'usd', amount: Number.POSITIVE_INFINITY },
    }],
    [FULFILLMENT_SHIPSTATION_RATES_PATH, { dropId: 'card_nft_2', deliveryId: 7, extra: true }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7, extra: true }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, { dropId: 'card_nft_2', deliveryId: 7, addressPatch: {} }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2', deliveryId: 7, addressPatch: { name: ' ' },
    }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2', deliveryId: 7, addressPatch: { address_line1: 'x'.repeat(51) },
    }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2', deliveryId: 7, addressPatch: { country_code: 'USA' },
    }],
    [FULFILLMENT_SHIPSTATION_SHIPMENT_PATH, {
      dropId: 'card_nft_2', deliveryId: 7, addressPatch: { company_name: 'Private' },
    }],
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
      verifyIdentity: async () => {
        throw new RequestIdentityError('invalid-token');
      },
    }),
  );
  assert.equal(invalidToken.response.status, 401);
  assert.equal(upstreamCalls, 0);

  const anonymousOnlyStaffWrite = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, {
      dropId: 'card_nft_2',
      deliveryId: 7,
      status: 'Preparing',
    }),
    env,
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(neverFetch, {
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    }),
  );
  assert.equal(anonymousOnlyStaffWrite.response.status, 401);

  const retiredSecret = await handleProfileWriteRequest(
    request(PROFILE_ADDRESSES_PATH, { encrypted: 'cipher', country: 'US', hint: 'hint' }),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_ADDRESSES_PATH,
    dependencies(neverFetch),
  );
  assert.equal(retiredSecret.response.status, 200);
  assert.equal(upstreamCalls, 0);

  let commits = 0;
  const deniedFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/deliveryOrders/7')) return Response.json({ fields: {} });
    if (url.pathname.endsWith('/documents:commit')) commits += 1;
    return Response.json({ writeResults: [] });
  };
  const denied = await handleProfileWriteRequest(
    request(FULFILLMENT_ORDER_STATUS_PATH, { dropId: 'card_nft_2', deliveryId: 7, status: 'Preparing' }),
    env,
    FULFILLMENT_ORDER_STATUS_PATH,
    dependencies(deniedFetch, {
      resolveD1AuthWalletBinding: async () => ({ wallet: OTHER, source: 'binding' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OTHER }),
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.equal(commits, 0);

  const missingOrderFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
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
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_ADDRESSES_PATH,
    dependencies(providerFetch, {
      saveProfileAddress: async () => {
        throw new Error('private D1 writer-secret');
      },
    }),
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

test('generated Commerce auto IDs are cryptographic-compatible document IDs', () => {
  const ids = Array.from({ length: 100 }, () => profileWriteTestHooks.commerceAutoId());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[A-Za-z0-9]{20}$/.test(id)));
});
