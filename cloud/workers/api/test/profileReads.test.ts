import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCommerceD1,
  createCommerceD1Harness,
  decodeLegacyFirestoreFixtureFields,
  seedCommerceDocument,
} from './commerceD1Harness.ts';
import {
  ADMIN_PROFILE_PATH,
  ADMIN_DELIVERY_ORDER_OWNERS_PATH,
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  FULFILLMENT_ORDERS_PATH,
  FULFILLMENT_MANUAL_REVIEW_PATH,
  ProfileReadError,
  applyProfileCors,
  handleProfileCorsPreflight,
  handleProfileReadRequest,
  profileReadTestHooks,
  type ProfileProviderFetch,
  type ProfileReadPath,
} from '../src/profileReads.ts';
import { readBoundedJson } from '../src/boundedResponse.ts';
import {
  D1CommerceRepository,
  commerceKeys,
  type CommerceDocumentData,
  type CommerceDocumentRecord,
  type CommerceQuery,
} from '../src/commerceRepository.ts';
import {
  STRIPE_CHECKOUT_OPERATION_HEADER,
  STRIPE_CHECKOUT_RETRY_HEADER,
} from '../../../../shared/contracts.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const ADMIN = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
const OTHER = 'So11111111111111111111111111111111111111112';
const UID = 'auth-user-one';
const NOW_MS = Date.parse('2026-08-18T12:00:00.000Z');

test('profile CORS permits checkout operation headers and exposes retry guidance', () => {
  const request = new Request('https://api.mons.shop/checkout/session', {
    method: 'OPTIONS',
    headers: { Origin: 'https://mons.shop' },
  });
  const preflight = handleProfileCorsPreflight(request);
  const allowedHeaders = preflight.headers.get('Access-Control-Allow-Headers') || '';
  assert.equal(preflight.status, 204);
  assert.equal(
    allowedHeaders.toLowerCase().split(/,\s*/).includes(STRIPE_CHECKOUT_OPERATION_HEADER.toLowerCase()),
    true,
  );
  const response = applyProfileCors(request, new Response(null));
  assert.equal(response.headers.get('Access-Control-Expose-Headers'), STRIPE_CHECKOUT_RETRY_HEADER);
});

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

function manualReviewDocument() {
  return {
    name: 'projects/mons-shop/databases/(default)/documents/drops/card_nft_2/stripeCheckouts/cs_test_review',
    fields: {
      manualRefundReviewRequired: { booleanValue: true },
      status: stringValue('fulfillment_failed'),
      sessionId: stringValue('cs_test_review'),
      owner: stringValue(OWNER),
      ownerKind: stringValue('wallet'),
      quantity: integerValue(2),
      stripeSessionSummary: {
        mapValue: {
          fields: {
            amount_total: integerValue(4200),
            currency: stringValue('usd'),
          },
        },
      },
    },
  };
}

function profileDependencies(
  providerFetch: ProfileProviderFetch,
  createCommerceRepository: NonNullable<Parameters<typeof handleProfileReadRequest>[3]>['createCommerceRepository'],
  overrides: Partial<Parameters<typeof handleProfileReadRequest>[3]> = {},
): Parameters<typeof handleProfileReadRequest>[3] {
  return {
    createCommerceRepository,
    loadProfileEmail: async () => undefined,
    nowMs: () => NOW_MS,
    providerFetch,
    resolveD1AuthWalletBinding: async () => ({ wallet: OWNER, source: 'binding' }),
    timeoutMs: 500,
    verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    ...overrides,
  };
}

function legacyFirestoreProfileDependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Partial<Parameters<typeof handleProfileReadRequest>[3]> = {},
): Parameters<typeof handleProfileReadRequest>[3] {
  const createCommerceRepository = () => ({
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
        const fields = decodeLegacyFirestoreFixtureFields(raw.fields);
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
  } as Pick<D1CommerceRepository, 'query'>);
  return profileDependencies(providerFetch, createCommerceRepository, overrides);
}

function d1ProfileDependencies(
  providerFetch: ProfileProviderFetch,
  overrides: Partial<Parameters<typeof handleProfileReadRequest>[3]> = {},
): Parameters<typeof handleProfileReadRequest>[3] {
  return profileDependencies(
    providerFetch,
    (database) => new D1CommerceRepository(database),
    overrides,
  );
}

test('bounded provider JSON preserves exact aborts and an earlier stream failure', async () => {
  const abortController = new AbortController();
  const abortReason = new Error('client disconnected');
  const stalled = readBoundedJson(new Response(new ReadableStream<Uint8Array>({
    start() {},
  }), {
    headers: { 'Content-Type': 'application/json' },
  }), 1024, abortController.signal);
  abortController.abort(abortReason);
  await assert.rejects(stalled, (error: unknown) => error === abortReason);

  const streamFailure = new Error('provider body failed');
  const lateAbort = new AbortController();
  const failed = readBoundedJson(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(streamFailure);
    },
  }), {
    headers: { 'Content-Type': 'application/json' },
  }), 1024, lateAbort.signal);
  lateAbort.abort(new Error('late client disconnect'));
  await assert.rejects(
    failed,
    (error: unknown) => error instanceof ProfileReadError && error.code === 'unavailable',
  );
});

test('bounded provider rejection never waits for response cancellation', async () => {
  let cancelStarted = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() {
      cancelStarted = true;
      return new Promise<void>(() => undefined);
    },
  }), {
    headers: {
      'Content-Length': '1025',
      'Content-Type': 'application/json',
    },
  });

  await assert.rejects(
    readBoundedJson(response, 1024, new AbortController().signal),
    (error) => error instanceof ProfileReadError && error.code === 'unavailable',
  );
  assert.equal(cancelStarted, true);
});

test('profile email preserves a D1 failure that settles before client cancellation', async () => {
  const controller = new AbortController();
  const d1Failure = new Error('D1 read failed first');
  const clientReason = new Error('late client disconnect');
  const statement = {
    bind() {
      return this;
    },
    first() {
      return new Promise((_resolve, reject) => {
        reject(d1Failure);
        controller.abort(clientReason);
      });
    },
  } as unknown as D1PreparedStatement;
  const db = {
    prepare: () => statement,
  } as unknown as D1Database;

  await assert.rejects(
    profileReadTestHooks.loadProfileEmail({
      db,
      nowMs: NOW_MS,
      ownerWallet: OWNER,
      providerFetch: fetch,
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof ProfileReadError && error.code === 'unavailable',
  );
});

test('profile wallet binding distinguishes cancellation from an earlier D1 failure', async () => {
  const providerFetch: ProfileProviderFetch = async () => Response.json({ error: 'unexpected' }, { status: 500 });
  const racedController = new AbortController();
  const d1Failure = new Error('D1 wallet binding failed first');
  const lateReason = new Error('late client disconnect');
  const raced = await handleProfileReadRequest(
    new Request(tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }), {
      signal: racedController.signal,
    }),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_SHIPMENTS_PATH,
    d1ProfileDependencies(providerFetch, {
      resolveD1AuthWalletBinding: () => new Promise<never>((_resolve, reject) => {
        reject(d1Failure);
        setTimeout(() => racedController.abort(lateReason), 0);
      }),
    }),
  );
  assert.equal(raced.response.status, 503);
  assert.equal((await raced.response.json() as { error: { code: string } }).error.code, 'unavailable');

  const cancelledController = new AbortController();
  const cancellation = new Error('client disconnected during wallet binding');
  await assert.rejects(
    handleProfileReadRequest(
      new Request(tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }), {
        signal: cancelledController.signal,
      }),
      { COMMERCE_DB: createCommerceD1() },
      PROFILE_SHIPMENTS_PATH,
      d1ProfileDependencies(providerFetch, {
        resolveD1AuthWalletBinding: async () => {
          cancelledController.abort(cancellation);
          throw cancellation;
        },
      }),
    ),
    (error: unknown) => error === cancellation,
  );
});

test('legacy Firestore fixtures preserve shipment and anonymous history query compatibility', async () => {
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
    legacyFirestoreProfileDependencies(providerFetch),
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
    legacyFirestoreProfileDependencies(providerFetch),
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
  assert.match(serialized[1], new RegExp(`anonymous:${UID}`));
  assert.equal(serialized.every((query) => query.includes('delivery_order') && query.includes('ready_to_ship')), true);
});

test('profile state derives identity server-side and returns independently bounded sections', async () => {
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    legacyFirestoreProfileDependencies(async (input) => {
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

test('profile state uses D1 wallet sessions without requesting Commerce authSessions', async () => {
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
    legacyFirestoreProfileDependencies(providerFetch, {
      resolveD1AuthWalletBinding: async () => ({ wallet: OWNER, source: 'binding' }),
    }),
  );
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json() as { sessionWallet: string }).sessionWallet, OWNER);
});

test('staff profile state uses the wallet principal without a Auth session row', async () => {
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    legacyFirestoreProfileDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'missing' }, { status: 404 });
      if (url.endsWith('/documents:runQuery')) return Response.json([]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      resolveD1AuthWalletBinding: async () => assert.fail('staff identity reached Auth wallet-session resolution'),
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
    legacyFirestoreProfileDependencies(async () => assert.fail('missing session reached Commerce'), {
      resolveD1AuthWalletBinding: async () => ({ wallet: null, reason: 'missing-binding' }),
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
      ...legacyFirestoreProfileDependencies(async (input) => {
        const url = String(input);
        if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'missing' }, { status: 404 });
        if (url.endsWith('/documents:runQuery')) return Response.json([]);
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
      resolveD1AuthWalletBinding: async () => ({ wallet: OWNER, source: 'binding' }),
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
    legacyFirestoreProfileDependencies(async (input) => {
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

test('profile state preserves an earlier unavailable section when its sibling times out', async () => {
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    profileDependencies(
      async () => assert.fail('profile state deadline reached provider fetch'),
      () => ({
        query: async () => new Promise<CommerceDocumentRecord[]>(() => undefined),
      } as Pick<D1CommerceRepository, 'query'>),
      {
        loadProfileEmail: async () => {
          throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
        },
        timeoutMs: 5,
      },
    ),
  );

  assert.equal(result.response.status, 200);
  const payload = await result.response.json() as {
    profile: { status: string; error: { code: string } };
    shipments: { status: string; error: { code: string } };
  };
  assert.equal(payload.profile.status, 'error');
  assert.equal(payload.profile.error.code, 'unavailable');
  assert.equal(payload.shipments.status, 'error');
  assert.equal(payload.shipments.error.code, 'deadline-exceeded');
  assert.deepEqual(result.profileStateSections, { profile: 'error', shipments: 'error' });
});

test('profile reads enforce deadlines when D1 ignores the signal', async () => {
  for (const mode of ['stalled', 'late-success'] as const) {
    const result = await handleProfileReadRequest(
      tokenRequest(ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, {}),
      { COMMERCE_DB: createCommerceD1() },
      ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
      profileDependencies(
        async () => assert.fail('D1 deadline reached provider fetch'),
        () => ({
          query: async () => mode === 'stalled'
            ? new Promise<CommerceDocumentRecord[]>(() => undefined)
            : new Promise<CommerceDocumentRecord[]>((resolve) => setTimeout(() => resolve([]), 20)),
        } as Pick<D1CommerceRepository, 'query'>),
        { timeoutMs: 5 },
      ),
    );
    assert.equal(result.response.status, 504, mode);
    assert.equal(
      (await result.response.json() as { error: { code: string } }).error.code,
      'deadline-exceeded',
      mode,
    );
  }

  for (const mode of ['stalled-wallet', 'late-wallet'] as const) {
    const result = await handleProfileReadRequest(
      tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
      { COMMERCE_DB: createCommerceD1() },
      PROFILE_SHIPMENTS_PATH,
      d1ProfileDependencies(async () => assert.fail('wallet deadline reached provider fetch'), {
        resolveD1AuthWalletBinding: async () => mode === 'stalled-wallet'
          ? new Promise<never>(() => undefined)
          : new Promise<{ wallet: string; source: 'binding' }>((resolve) => setTimeout(() => resolve({
              wallet: OWNER,
              source: 'binding',
            }), 20)),
        timeoutMs: 5,
      }),
    );
    assert.equal(result.response.status, 504, mode);
    assert.equal(
      (await result.response.json() as { error: { code: string } }).error.code,
      'deadline-exceeded',
      mode,
    );
  }
});

test('profile state preserves independently completed sections when D1 ignores the deadline signal', async () => {
  const run = async (profileStalls: boolean) => handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    profileDependencies(
      async () => assert.fail('profile state D1 deadline reached provider fetch'),
      () => ({
        query: async () => new Promise<CommerceDocumentRecord[]>(() => undefined),
      } as Pick<D1CommerceRepository, 'query'>),
      {
        loadProfileEmail: profileStalls
          ? async () => new Promise<string | undefined>(() => undefined)
          : async () => 'owner@example.com',
        timeoutMs: 5,
      },
    ),
  );

  const partial = await run(false);
  assert.equal(partial.response.status, 200);
  const partialPayload = await partial.response.json() as {
    profile: { status: string; value: { email: string } };
    shipments: { status: string; error: { code: string } };
  };
  assert.equal(partialPayload.profile.status, 'ready');
  assert.equal(partialPayload.profile.value.email, 'owner@example.com');
  assert.equal(partialPayload.shipments.status, 'error');
  assert.equal(partialPayload.shipments.error.code, 'deadline-exceeded');
  assert.deepEqual(partial.profileStateSections, { profile: 'ready', shipments: 'error' });

  const both = await run(true);
  assert.equal(both.response.status, 200);
  const bothPayload = await both.response.json() as {
    profile: { status: string; error: { code: string } };
    shipments: { status: string; error: { code: string } };
  };
  assert.equal(bothPayload.profile.error.code, 'deadline-exceeded');
  assert.equal(bothPayload.shipments.error.code, 'deadline-exceeded');
  assert.deepEqual(both.profileStateSections, { profile: 'error', shipments: 'error' });
});

test('profile state rethrows client cancellation and retains server-timeout section fallback', async () => {
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const request = new Request(tokenRequest(PROFILE_STATE_PATH, {}), {
    signal: controller.signal,
  });
  const cancelled = handleProfileReadRequest(
    request,
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    legacyFirestoreProfileDependencies(async () => Response.json([]), {
      loadProfileEmail: async ({ signal }) => {
        markStarted();
        return new Promise<string | undefined>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
    }),
  );
  await started;
  controller.abort(reason);
  await assert.rejects(cancelled, (error: unknown) => error === reason);

  const timedOut = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    legacyFirestoreProfileDependencies(async () => Response.json([]), {
      loadProfileEmail: async ({ signal }) => new Promise<string | undefined>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
      timeoutMs: 5,
    }),
  );
  assert.equal(timedOut.response.status, 200);
  const payload = await timedOut.response.json() as {
    profile: { status: string; error: { code: string } };
    shipments: { status: string; value: unknown[] };
  };
  assert.equal(payload.profile.status, 'error');
  assert.equal(payload.profile.error.code, 'deadline-exceeded');
  assert.equal(payload.shipments.status, 'ready');
  assert.deepEqual(timedOut.profileStateSections, { profile: 'error', shipments: 'ready' });
});

test('profile state rejects invalid D1 sessions and non-empty requests', async () => {
  const malformedSession = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    legacyFirestoreProfileDependencies(async () => assert.fail('invalid D1 session reached Commerce'), {
      resolveD1AuthWalletBinding: async () => { throw new Error('invalid D1 session'); },
    }),
  );
  assert.equal(malformedSession.response.status, 503);

  const invalidBody = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    legacyFirestoreProfileDependencies(async () => assert.fail('invalid request reached provider')),
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
    legacyFirestoreProfileDependencies(providerFetch, {
      resolveD1AuthWalletBinding: async () => ({ wallet: OTHER, source: 'binding' }),
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
      legacyFirestoreProfileDependencies(async () => assert.fail('invalid request reached provider')),
    );
    assert.equal(invalid.response.status, 400);
    assert.equal((await invalid.response.json() as { error: { code: string } }).error.code, 'invalid-argument');
  }
});

test('shipment route preserves legacy wallet-shaped Auth UIDs when no session document exists', async () => {
  const owners: string[] = [];
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_SHIPMENTS_PATH,
    {
      ...legacyFirestoreProfileDependencies(async (_input, init) => {
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
    legacyFirestoreProfileDependencies(async () => Response.json([]), {
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: UID }),
    }),
  );
  assert.equal(anonymousOnly.response.status, 401);

  const denied = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    legacyFirestoreProfileDependencies(async () => {
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => 'owner@example.com',
      resolveD1AuthWalletBinding: async () => ({ wallet: OTHER, source: 'binding' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: OWNER }),
    }),
  );
  assert.equal(denied.response.status, 403);
  assert.equal((await denied.response.json() as { error: { code: string } }).error.code, 'permission-denied');

  const accepted = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    legacyFirestoreProfileDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ fields: { email: stringValue('owner@example.com') } });
      if (url.endsWith('/documents:runQuery')) return Response.json([{ document: orderDocument() }]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => 'owner@example.com',
      resolveD1AuthWalletBinding: async () => ({ wallet: ADMIN, source: 'binding' }),
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
    legacyFirestoreProfileDependencies(async (input) => {
      const url = String(input);
      if (url.includes(`/profiles/${OWNER}?`)) return Response.json({ error: 'missing' }, { status: 404 });
      if (url.endsWith('/documents:runQuery')) return Response.json([]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      resolveD1AuthWalletBinding: async () => ({ wallet: ADMIN, source: 'binding' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.equal(missingProfile.response.status, 200);
  assert.deepEqual(await missingProfile.response.json(), { profile: { wallet: OWNER, orders: [] } });

  const unavailableProfile = await handleProfileReadRequest(
    tokenRequest(ADMIN_PROFILE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    ADMIN_PROFILE_PATH,
    legacyFirestoreProfileDependencies(async (input) => {
      const url = String(input);
      if (url.endsWith('/documents:runQuery')) return Response.json([]);
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }, {
      loadProfileEmail: async () => {
        throw new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.');
      },
      resolveD1AuthWalletBinding: async () => ({ wallet: ADMIN, source: 'binding' }),
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
    legacyFirestoreProfileDependencies(async (_input, init) => {
      const query = JSON.parse(String(init?.body)) as CommerceQuery;
      assert.equal(query.kind, 'delivery_order');
      return Response.json([
        { document: { name: 'projects/mons-shop/databases/(default)/documents/drops/a/deliveryOrders/1', fields: { owner: stringValue(OWNER) } } },
        { document: { name: 'projects/mons-shop/databases/(default)/documents/drops/a/deliveryOrders/2', fields: { owner: stringValue(OTHER) } } },
      ]);
    }, {
      resolveD1AuthWalletBinding: async () => ({ wallet: ADMIN, source: 'binding' }),
      verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
    }),
  );
  assert.deepEqual(await owners.response.json(), { owners: [OWNER, OTHER], nextCursor: null, hasMore: false });

  const fulfillment = await handleProfileReadRequest(
    tokenRequest(FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2', limit: 2, cursor: null }),
    env,
    FULFILLMENT_ORDERS_PATH,
    legacyFirestoreProfileDependencies(async (_input, init) => {
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
      resolveD1AuthWalletBinding: async () => ({ wallet: ADMIN, source: 'binding' }),
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
    legacyFirestoreProfileDependencies(async (input, init) => {
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
      resolveD1AuthWalletBinding: async () => ({ wallet: ADMIN, source: 'binding' }),
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

test('manual review rethrows client cancellation and retains server-timeout Stripe fallback', async () => {
  const env = {
    COMMERCE_DB: createCommerceD1(),
    STRIPE_SECRET_KEY: 'sk_test_primary',
    STRIPE_SECRET_KEY_LIVE: 'sk_live_primary',
  };
  const dependencies = (
    stripeStarted: () => void,
    timeoutMs: number,
  ): Parameters<typeof handleProfileReadRequest>[3] => legacyFirestoreProfileDependencies(
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
  const cancelled = handleProfileReadRequest(
    request,
    env,
    FULFILLMENT_MANUAL_REVIEW_PATH,
    dependencies(markStarted, 500),
  );
  await started;
  controller.abort(reason);
  await assert.rejects(cancelled, (error: unknown) => error === reason);

  const timedOut = await handleProfileReadRequest(
    tokenRequest(FULFILLMENT_MANUAL_REVIEW_PATH, { dropId: 'card_nft_2' }),
    env,
    FULFILLMENT_MANUAL_REVIEW_PATH,
    dependencies(() => undefined, 5),
  );
  assert.equal(timedOut.response.status, 200);
  const payload = await timedOut.response.json() as { checkouts: Array<{ sessionId: string }> };
  assert.deepEqual(payload.checkouts.map((checkout) => checkout.sessionId), ['cs_test_review']);
});

test('all seven commerce read routes use D1 without Commerce in d1 mode', async () => {
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
  const anonymousDependencies = d1ProfileDependencies(providerFetch);
  const staffDependencies = d1ProfileDependencies(providerFetch, {
    loadProfileEmail: async () => 'owner@example.com',
    resolveD1AuthWalletBinding: async () => ({ wallet: ADMIN, source: 'binding' }),
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
  assert.equal(commerceCalls, 0);
});

test('D1 profile reads enforce owner, drop, status, ordering, and cursor filters', async () => {
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

  const anonymousDependencies = d1ProfileDependencies(async () => Response.json({}));
  const shipments = await handleProfileReadRequest(
    tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: harness.db, OPS_DB: {} as D1Database },
    PROFILE_SHIPMENTS_PATH,
    anonymousDependencies,
  );
  assert.equal(shipments.response.status, 200);
  const shipmentPayload = await shipments.response.json() as { orders: Array<{ deliveryId: number }> };
  assert.deepEqual(shipmentPayload.orders.map((order) => order.deliveryId), [4, 3, 1]);

  const staffDependencies = d1ProfileDependencies(async () => Response.json({}), {
    resolveD1AuthWalletBinding: async () => ({ wallet: ADMIN, source: 'binding' }),
    verifyIdentity: async () => ({ kind: 'staff-wallet' as const, wallet: ADMIN }),
  });
  const fulfillmentEnv = {
    COMMERCE_DB: harness.db,
    ADDRESS_DECRYPTION_SECRET: '',
    OPS_DB: {} as D1Database,
  };
  const firstPage = await handleProfileReadRequest(
    tokenRequest(FULFILLMENT_ORDERS_PATH, { dropId: 'card_nft_2', limit: 1, cursor: null }),
    fulfillmentEnv,
    FULFILLMENT_ORDERS_PATH,
    staffDependencies,
  );
  assert.equal(firstPage.response.status, 200);
  const firstPayload = await firstPage.response.json() as {
    orders: Array<{ deliveryId: number }>;
    nextCursor: { processedAt: { seconds: number; nanos: number }; id: string } | null;
  };
  assert.deepEqual(firstPayload.orders.map((order) => order.deliveryId), [2]);
  assert.deepEqual(firstPayload.nextCursor, { processedAt: { seconds: 100, nanos: 2 }, id: '2' });

  const secondPage = await handleProfileReadRequest(
    tokenRequest(FULFILLMENT_ORDERS_PATH, {
      dropId: 'card_nft_2',
      limit: 1,
      cursor: firstPayload.nextCursor,
    }),
    fulfillmentEnv,
    FULFILLMENT_ORDERS_PATH,
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

test('current D1 rejects legacy uid identity fields on commerce documents', () => {
  const harness = createCommerceD1Harness();
  assert.throws(() => seedCommerceDocument(harness, {
    key: commerceKeys.stripeCheckout('card_nft_2', 'cs_test_review'),
    data: {
      manualRefundReviewRequired: true,
      owner: OWNER,
      ownerKind: 'wallet',
      quantity: 2,
      sessionId: 'cs_test_review',
      status: 'fulfillment_failed',
      uid: UID,
    },
  }), /commerce document contains noncanonical identity data/);
});

test('commerce authority failures fail closed without a provider fallback', async () => {
  let providerCalls = 0;
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }),
    {
      COMMERCE_DB: {} as D1Database,
    },
    PROFILE_SHIPMENTS_PATH,
    legacyFirestoreProfileDependencies(async () => {
      providerCalls += 1;
      return Response.json([{ document: orderDocument() }]);
    }, { createCommerceRepository: (database) => new D1CommerceRepository(database) }),
  );
  assert.equal(result.response.status, 503);
  assert.equal(providerCalls, 0);
});
