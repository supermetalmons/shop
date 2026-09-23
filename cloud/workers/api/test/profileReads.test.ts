import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceD1, createCommerceD1Harness, seedCommerceDocument } from './commerceD1Harness.ts';
import {
  ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH,
  PROFILE_SHIPMENTS_PATH,
  PROFILE_STATE_PATH,
  handleProfileReadRequest,
  type ProfileReadPath,
} from '../src/profileReads.ts';
import { applyProfileCors, handleProfileCorsPreflight, loadProfileEmail } from '../src/profileReadSupport.ts';
import { ProfileReadError } from '../src/dataAccess.ts';
import { readBoundedResponseJson, type ProfileProviderFetch } from '../src/boundedResponse.ts';
import { RequestIdentityError } from '../src/requestIdentity.ts';
import { D1CommerceRepository, commerceKeys, type CommerceDocumentRecord } from '../src/commerceRepository.ts';
import { STRIPE_CHECKOUT_OPERATION_HEADER, STRIPE_CHECKOUT_RETRY_HEADER } from '../../../../shared/contracts.ts';
import {
  OWNER, OTHER, UID, NOW_MS, tokenRequest, stringValue, orderDocument,
  profileDependencies, legacyFirestoreProfileDependencies, d1ProfileDependencies,
} from './readTestFixtures.ts';

function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  return readBoundedResponseJson(response, {
    maxBytes,
    signal,
    contentType: 'require-json',
    createError: () => new ProfileReadError('unavailable', 502, 'Profile data is temporarily unavailable.'),
  });
}

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

test('profile reads preserve identity failure responses and authentication outcomes', async (context) => {
  const harness = createCommerceD1Harness();
  context.after(() => harness.database.close());
  for (const expected of [
    {
      kind: 'invalid-token',
      status: 401,
      code: 'unauthenticated',
      message: 'Authentication is required.',
      authOutcome: 'rejected',
    },
    {
      kind: 'provider-timeout',
      status: 504,
      code: 'deadline-exceeded',
      message: 'Profile request timed out.',
      authOutcome: 'provider-failure',
    },
    {
      kind: 'provider-unavailable',
      status: 502,
      code: 'unavailable',
      message: 'Authentication is temporarily unavailable.',
      authOutcome: 'provider-failure',
    },
  ] as const) {
    await context.test(expected.kind, async () => {
      const result = await handleProfileReadRequest(
        tokenRequest(PROFILE_STATE_PATH, {}),
        { COMMERCE_DB: harness.db },
        PROFILE_STATE_PATH,
        {},
        {
          nowMs: () => NOW_MS,
          verifyIdentity: async () => { throw new RequestIdentityError(expected.kind); },
          createCommerceRepository: () => assert.fail('Identity failure must not access Commerce'),
          resolveD1AuthWalletBinding: async () => assert.fail('Identity failure must not resolve a wallet'),
          providerFetch: async () => assert.fail('Identity failure must not contact a provider'),
        },
      );
      assert.equal(result.response.status, expected.status);
      assert.deepEqual(await result.response.json(), {
        ok: false,
        error: { code: expected.code, message: expected.message },
      });
      assert.equal(result.authOutcome, expected.authOutcome);
      assert.deepEqual(result.metrics, { upstreamCalls: 0, providerDurationMs: 0 });
    });
  }
});

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
    loadProfileEmail({
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
    {},
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
      {},
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
    {},
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
    {},
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
  assert.deepEqual(queries, [
    { operation: 'queryDeliveryHistory', owners: [OWNER] },
    { operation: 'queryDeliveryHistory', owners: [`anonymous:${UID}`] },
  ]);
});

test('profile state derives identity server-side and returns independently bounded sections', async () => {
  const result = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, {}),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    {},
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
    {},
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
    {},
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
    {},
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
    {},
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
    {},
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
    {},
    profileDependencies(
      async () => assert.fail('profile state deadline reached provider fetch'),
      () => ({
        queryShipmentHistoryPage: async () => assert.fail('Unexpected paged shipment query'),
        queryShipmentPresence: async () => assert.fail('Unexpected shipment presence query'),
        queryDeliveryHistory: async () => new Promise<CommerceDocumentRecord[]>(() => undefined),
      }),
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
      {},
      profileDependencies(
        async () => assert.fail('D1 deadline reached provider fetch'),
        () => ({
        queryShipmentHistoryPage: async () => assert.fail('Unexpected paged shipment query'),
        queryShipmentPresence: async () => assert.fail('Unexpected shipment presence query'),
          queryDeliveryHistory: async () => mode === 'stalled'
            ? new Promise<CommerceDocumentRecord[]>(() => undefined)
            : new Promise<CommerceDocumentRecord[]>((resolve) => setTimeout(() => resolve([]), 20)),
        }),
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
      {},
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
    {},
    profileDependencies(
      async () => assert.fail('profile state D1 deadline reached provider fetch'),
      () => ({
        queryShipmentHistoryPage: async () => assert.fail('Unexpected paged shipment query'),
        queryShipmentPresence: async () => assert.fail('Unexpected shipment presence query'),
        queryDeliveryHistory: async () => new Promise<CommerceDocumentRecord[]>(() => undefined),
      }),
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
    {},
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
    {},
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
    {},
    legacyFirestoreProfileDependencies(async () => assert.fail('invalid D1 session reached Commerce'), {
      resolveD1AuthWalletBinding: async () => { throw new Error('invalid D1 session'); },
    }),
  );
  assert.equal(malformedSession.response.status, 503);

  const invalidBody = await handleProfileReadRequest(
    tokenRequest(PROFILE_STATE_PATH, { ownerWallet: OWNER }),
    { COMMERCE_DB: createCommerceD1() },
    PROFILE_STATE_PATH,
    {},
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
    {},
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
      {},
      legacyFirestoreProfileDependencies(async () => assert.fail('invalid request reached provider'), {
        verifyIdentity: async () => assert.fail('invalid request reached authentication'),
        nowMs: () => assert.fail('invalid request read the authentication clock'),
      }),
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
    {},
    {
      ...legacyFirestoreProfileDependencies(async (_input, init) => {
        const query = JSON.parse(String(init?.body)) as { operation: string; owners: string[] };
        assert.equal(query.operation, 'queryDeliveryHistory');
        owners.push(...query.owners);
        return Response.json([]);
      }),
      verifyIdentity: async () => ({ kind: 'anonymous' as const, authSubject: OWNER }),
    },
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { responseMode: 'shipments', wallet: OWNER, orders: [] });
  assert.deepEqual(owners, [OWNER]);
});

test('customer commerce read routes use D1 without Commerce in d1 mode', async () => {
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
  const dependencies = d1ProfileDependencies(providerFetch);
  const calls: Array<[ProfileReadPath, unknown]> = [
    [PROFILE_SHIPMENTS_PATH, { ownerWallet: OWNER }],
    [PROFILE_STATE_PATH, {}],
    [ANONYMOUS_STRIPE_DELIVERY_HISTORY_PATH, {}],
  ];
  for (const [path, body] of calls) {
    const result = await handleProfileReadRequest(tokenRequest(path, body), env, path, {}, dependencies);
    assert.equal(result.response.status, 200, path);
    await result.response.json();
  }
  assert.equal(commerceCalls, 0);
});

test('D1 profile reads enforce owner, status, and ordering filters', async () => {
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
    {},
    anonymousDependencies,
  );
  assert.equal(shipments.response.status, 200);
  const shipmentPayload = await shipments.response.json() as { orders: Array<{ deliveryId: number }> };
  assert.deepEqual(shipmentPayload.orders.map((order) => order.deliveryId), [4, 3, 1]);
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
    {},
    legacyFirestoreProfileDependencies(async () => {
      providerCalls += 1;
      return Response.json([{ document: orderDocument() }]);
    }, { createCommerceRepository: (database) => new D1CommerceRepository(database) }),
  );
  assert.equal(result.response.status, 503);
  assert.equal(providerCalls, 0);
});
