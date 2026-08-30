import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import bs58 from 'bs58';
import {
  parseAdminIrlRedeemFinalizeResult,
  parseAdminIrlRedeemPrepareResponse,
  parseDeliveryPrepareResponse,
  parseIrlClaimPrepareResponse,
  parseIssueReceiptsResult,
  parseReceiptTransferPrepareResponse,
  parseRecoverDeliveryOrdersResult,
  parseRevealDudesResponse,
  parseRevealDudesSubmissionUnknownDetails,
  parseStripeCheckoutSessionResponse,
  parseStripeReceiptClaimResponse,
  revealDudesSubmissionUnknownDetails,
  createCommerceApiClient,
  stripeCheckoutOperationAfterFailure,
  stripeCheckoutOperationState,
  stripeCheckoutOperationWithCredential,
} from '../src/api/commerce.ts';
import {
  ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
  ADMIN_IRL_REDEEM_FINALIZE_OVERALL_TIMEOUT_MS,
  ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
  ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
  createAdminIrlRedeemFinalizeOperationId,
  parseAdminIrlRedeemFinalizePendingResponse,
  STRIPE_CHECKOUT_OPERATION_HEADER,
  STRIPE_CHECKOUT_RETRY_HEADER,
  STRIPE_CHECKOUT_RETRY_SAME_OPERATION,
  type AdminIrlRedeemFinalizeOperationId,
} from '../shared/contracts.ts';
import {
  addFulfillmentOrderToShipStationRequestPayload,
  createFulfillmentApiClient,
  parseAddFulfillmentOrderToShipStation,
  parseFulfillmentShipStationAddressCorrectionDetails,
  parseFulfillmentStatusUpdate,
  parseGetFulfillmentShipStationLabel,
  parseGetFulfillmentShipStationRates,
  parsePurchaseFulfillmentShipStationLabel,
  parseUpdateFulfillmentAddress,
  parseVoidFulfillmentShipStationLabel,
} from '../src/api/fulfillment.ts';
import {
  createProfileApiClient,
  parseProfileAddress,
  parseProfileState,
  profileOrders,
  saveProfileAddressRequest,
} from '../src/api/profile.ts';
import {
  profileApiTimeoutMs,
  ProfileApiError,
  requestProfileApi,
  type AuthenticatedApiCall,
} from '../src/api/transport.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const DESTINATION = '11111111111111111111111111111112';
const REVEAL_SIGNATURE = bs58.encode(new Uint8Array(64).fill(5));
const RECENT_BLOCKHASH = bs58.encode(new Uint8Array(32).fill(7));
const ZERO_SIGNATURE = bs58.encode(new Uint8Array(64));
const ZERO_BLOCKHASH = bs58.encode(new Uint8Array(32));
const STRIPE_CHECKOUT_OPERATION_ID = '11111111-1111-4111-8111-111111111111';

const ADMIN_IRL_REDEEM_FINALIZE_RESPONSE = {
  processed: true,
  dropId: 'card_nft_2',
  requestId: 'AbCdEfGhIjKlMnOpQrSt',
  deliveryId: 7,
  receiptTxs: [],
  claimCodes: ['ABCDEF-1234567890'],
  boxes: [{
    boxId: 3,
    receiptAssetId: DESTINATION,
    claimCode: 'ABCDEF-1234567890',
    dudeIds: [1, 2, 3],
  }],
  cards: [],
} as const;

const ADMIN_IRL_REDEEM_FINALIZE_REQUEST = {
  requestId: ADMIN_IRL_REDEEM_FINALIZE_RESPONSE.requestId,
  dropId: ADMIN_IRL_REDEEM_FINALIZE_RESPONSE.dropId,
  transferSignature: REVEAL_SIGNATURE,
} as const;

function expectedAdminIrlRedeemOperationId(staffWallet: string): AdminIrlRedeemFinalizeOperationId {
  const hash = createHash('sha256')
    .update(JSON.stringify([
      ADMIN_IRL_REDEEM_FINALIZE_REQUEST.dropId,
      ADMIN_IRL_REDEEM_FINALIZE_REQUEST.requestId,
      ADMIN_IRL_REDEEM_FINALIZE_REQUEST.transferSignature,
      staffWallet,
    ]))
    .digest('hex');
  return `airf-v1-${hash}`;
}

const ADMIN_IRL_REDEEM_OPERATION_ID = expectedAdminIrlRedeemOperationId(OWNER);
const OTHER_ADMIN_IRL_REDEEM_OPERATION_ID = expectedAdminIrlRedeemOperationId(DESTINATION);

function adminIrlRedeemPending(operationId = ADMIN_IRL_REDEEM_OPERATION_ID) {
  return {
    accepted: true,
    operationId,
    status: 'pending',
    retryAfterMs: ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
  } as const;
}

test('Admin IRL finalization operation ids hash the exact canonical tuple', async () => {
  assert.equal(
    await createAdminIrlRedeemFinalizeOperationId([
      ADMIN_IRL_REDEEM_FINALIZE_REQUEST.dropId,
      ADMIN_IRL_REDEEM_FINALIZE_REQUEST.requestId,
      ADMIN_IRL_REDEEM_FINALIZE_REQUEST.transferSignature,
      OWNER,
    ]),
    ADMIN_IRL_REDEEM_OPERATION_ID,
  );
});

test('Stripe checkout operation ids survive one retry and rotate when inputs change', () => {
  const ids = [
    STRIPE_CHECKOUT_OPERATION_ID,
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];
  const createId = () => ids.shift() || assert.fail('unexpected operation id request');
  const first = stripeCheckoutOperationState(null, {
    dropId: 'card_nft_2',
    quantity: 1,
    returnUrl: ' https://mons.shop/drop ',
  }, 'auth-one', createId);
  const retry = stripeCheckoutOperationState(first, {
    dropId: 'card_nft_2',
    quantity: 1,
    returnUrl: 'https://mons.shop/drop',
  }, 'auth-one', createId);
  const distinct = stripeCheckoutOperationState(retry, {
    dropId: 'card_nft_2',
    quantity: 2,
    returnUrl: 'https://mons.shop/drop',
  }, 'auth-one', createId);
  const changedIdentity = stripeCheckoutOperationState(distinct, {
    dropId: 'card_nft_2',
    quantity: 2,
    returnUrl: 'https://mons.shop/drop',
  }, 'auth-two', createId);

  assert.equal(retry.operationId, first.operationId);
  assert.notEqual(distinct.operationId, first.operationId);
  assert.notEqual(changedIdentity.operationId, distinct.operationId);
});

test('Stripe checkout operation ids adopt an initially unresolved identity only once', () => {
  const ids = [
    STRIPE_CHECKOUT_OPERATION_ID,
    '22222222-2222-4222-8222-222222222222',
  ];
  const createId = () => ids.shift() || assert.fail('unexpected operation id request');
  const unresolved = stripeCheckoutOperationState(null, {
    dropId: 'card_nft_2',
    quantity: 1,
  }, null, createId);
  const resolved = stripeCheckoutOperationState(unresolved, {
    dropId: 'card_nft_2',
    quantity: 1,
  }, 'auth-one', createId);
  const changed = stripeCheckoutOperationState(resolved, {
    dropId: 'card_nft_2',
    quantity: 1,
  }, 'auth-two', createId);

  assert.equal(resolved.operationId, unresolved.operationId);
  assert.equal(resolved.authSubject, 'auth-one');
  assert.notEqual(changed.operationId, resolved.operationId);
});

test('Stripe checkout operations retain the credential that actually sent the request', () => {
  const ids = [
    STRIPE_CHECKOUT_OPERATION_ID,
    '22222222-2222-4222-8222-222222222222',
  ];
  const createId = () => ids.shift() || assert.fail('unexpected operation id request');
  const unresolved = stripeCheckoutOperationState(null, {
    dropId: 'card_nft_2',
    quantity: 1,
  }, null, createId);
  const sentByAuthOne = stripeCheckoutOperationWithCredential(unresolved, 'auth-one');
  const retryAsAuthTwo = stripeCheckoutOperationState(sentByAuthOne, {
    dropId: 'card_nft_2',
    quantity: 1,
  }, 'auth-two', createId);

  assert.equal(sentByAuthOne.operationId, unresolved.operationId);
  assert.equal(sentByAuthOne.authSubject, 'auth-one');
  assert.notEqual(retryAsAuthTwo.operationId, sentByAuthOne.operationId);
});

test('Stripe checkout observes the credential before a failed request returns', async () => {
  let observed = '';
  const commerce = createCommerceApiClient(async (_pathname, _data, _credentialCapture, options) => {
    options?.onCredential?.('auth-one');
    throw new TypeError('network failed');
  });

  await assert.rejects(
    commerce.createStripeCheckoutSession(
      { dropId: 'card_nft_2', quantity: 1 },
      STRIPE_CHECKOUT_OPERATION_ID,
      (authSubject) => { observed = authSubject; },
    ),
    /network failed/,
  );
  assert.equal(observed, 'auth-one');
});

test('Stripe checkout operation ids survive only uncertain failures', () => {
  const current = { authSubject: null, key: 'checkout', operationId: STRIPE_CHECKOUT_OPERATION_ID };
  const uncertain = new ProfileApiError({
    code: 'unavailable',
    message: 'Temporarily unavailable.',
    retrySameOperation: true,
  });
  const definitive = new ProfileApiError({
    code: 'unavailable',
    message: 'Temporarily unavailable.',
  });

  assert.equal(stripeCheckoutOperationAfterFailure(current, uncertain), current);
  assert.equal(stripeCheckoutOperationAfterFailure(current, new TypeError('network failed')), current);
  assert.equal(stripeCheckoutOperationAfterFailure(current, definitive), null);
});


test('domain clients select authenticated routes through injected transport', async () => {
  const calls: Array<{ pathname: string; data: unknown; headers?: Readonly<Record<string, string>> }> = [];
  const stop = new Error('stop after request capture');
  const call: AuthenticatedApiCall = async (pathname, data, _credential, options) => {
    calls.push({ pathname, data, headers: options?.headers });
    throw stop;
  };
  const profile = createProfileApiClient({
    callProfileApi: call,
    createProfileAddressId: () => 'AbCdEfGhIjKlMnOpQrSt',
  });
  const commerce = createCommerceApiClient(call);
  const fulfillment = createFulfillmentApiClient(call);
  const cases: Array<() => Promise<unknown>> = [
    () => profile.saveEncryptedAddress('cipher', 'Turkey', 'hint', 'owner@example.com', 'TR'),
    () => profile.solanaAuth(OWNER, 'message', new Uint8Array(64)),
    () => profile.reconcileProfileState({ mergeStripeDeliveryOrders: true }),
    () => profile.loadProfileStateFromServer(),
    () => profile.getAdminProfileView(OWNER),
    () => profile.getAnonymousStripeDeliveryHistory(),
    () => profile.listDeliveryOrderOwners({ cursor: 'next', pageSize: 10 }),
    () => commerce.createStripeCheckoutSession({
      dropId: 'card_nft_2',
      quantity: 1,
    }, STRIPE_CHECKOUT_OPERATION_ID),
    () => commerce.revealDudes(OWNER, DESTINATION, 'card_nft_2'),
    () => commerce.requestDeliveryTx(OWNER, {
      itemIds: [DESTINATION],
      addressId: 'AbCdEfGhIjKlMnOpQrSt',
    }, 'card_nft_2'),
    () => commerce.prepareReceiptTransferTx({
      owner: OWNER,
      dropId: 'card_nft_2',
      receiptAssetId: OWNER,
      destination: DESTINATION,
    }),
    () => commerce.prepareAdminIrlRedeemTx({
      owner: OWNER,
      dropId: 'card_nft_2',
      itemIds: [DESTINATION],
    }),
    () => commerce.finalizeAdminIrlRedeem({
      requestId: 'AbCdEfGhIjKlMnOpQrSt',
      dropId: 'card_nft_2',
      transferSignature: REVEAL_SIGNATURE,
    }),
    () => commerce.issueReceipts(OWNER, 17, REVEAL_SIGNATURE, 'card_nft_2'),
    () => commerce.recoverMyDeliveryOrders({ dropId: 'card_nft_2', deliveryId: 17, force: true }),
    () => commerce.requestClaimTx(OWNER, '1234567890'),
    () => commerce.claimStripeReceipt({ code: 'ABCDEF-1234567890', recipient: OWNER }),
    () => fulfillment.listFulfillmentOrders({ dropId: 'card_nft_2', limit: 10 }),
    () => fulfillment.listFulfillmentManualReviewCheckouts({ dropId: 'card_nft_2' }),
    () => fulfillment.updateFulfillmentStatus(17, 'Shipped', 'card_nft_2', 'tracking'),
    () => fulfillment.updateFulfillmentAddress(17, 'Full address', 'card_nft_2'),
    () => fulfillment.addFulfillmentOrderToShipStation(17, 'card_nft_2'),
    () => fulfillment.getFulfillmentShipStationRates(17, 'card_nft_2'),
    () => fulfillment.purchaseFulfillmentShipStationLabel({
      dropId: 'card_nft_2',
      deliveryId: 17,
      rateId: 'rate-1',
      expectedTotal: { currency: 'usd', amount: 10 },
      requestId: 'request-1',
    }),
    () => fulfillment.getFulfillmentShipStationLabel(17, 'card_nft_2'),
    () => fulfillment.voidFulfillmentShipStationLabel({
      dropId: 'card_nft_2',
      deliveryId: 17,
      labelId: 'label-1',
    }),
  ];
  for (const run of cases) {
    await assert.rejects(run, (error) => error === stop);
  }
  assert.deepEqual(calls.map(({ pathname }) => pathname), [
    '/profile/addresses',
    '/auth/solana',
    '/profile/reconcile',
    '/profile/state',
    '/admin/profile',
    '/profile/anonymous-stripe-delivery-history',
    '/admin/delivery-order-owners',
    '/checkout/session',
    '/boxes/reveal',
    '/delivery/prepare',
    '/receipts/transfer/prepare',
    '/admin/irl-redeem/prepare',
    '/admin/irl-redeem/finalize',
    '/delivery/receipts/issue',
    '/delivery/receipts/recover',
    '/claims/irl/prepare',
    '/receipts/stripe/claim',
    '/fulfillment/orders',
    '/fulfillment/manual-review-checkouts',
    '/fulfillment/order-status',
    '/fulfillment/order-address',
    '/fulfillment/shipstation-shipment',
    '/fulfillment/shipstation-rates',
    '/fulfillment/shipstation-label-purchase',
    '/fulfillment/shipstation-label',
    '/fulfillment/shipstation-label-void',
  ]);
  assert.deepEqual(calls[0]?.data, {
    id: 'AbCdEfGhIjKlMnOpQrSt',
    encrypted: 'cipher',
    country: 'Turkey',
    countryCode: 'TR',
    hint: 'hint',
    email: 'owner@example.com',
  });
  assert.deepEqual(calls[7]?.data, { dropId: 'card_nft_2', quantity: 1 });
  assert.equal(calls[7]?.headers?.[STRIPE_CHECKOUT_OPERATION_HEADER], STRIPE_CHECKOUT_OPERATION_ID);
});

test('domain client factories apply successful response contracts', async () => {
  const profileState = {
    responseMode: 'profile-state' as const,
    sessionWallet: null,
    profile: null,
    shipments: null,
  };
  const profile = createProfileApiClient({
    callProfileApi: async (pathname, data) => {
      assert.equal(pathname, '/profile/state');
      assert.deepEqual(data, {});
      return profileState;
    },
    createProfileAddressId: () => 'AbCdEfGhIjKlMnOpQrSt',
  });
  assert.deepEqual(await profile.loadProfileStateFromServer(), profileState);

  const checkoutSession = {
    id: 'cs_test_factory_123',
    url: 'https://checkout.stripe.com/c/pay/factory',
    livemode: false,
  };
  let checkoutCredential = '';
  const commerce = createCommerceApiClient(async (pathname, data, credentialCapture, options) => {
    assert.equal(pathname, '/checkout/session');
    assert.deepEqual(data, {
      dropId: 'card_nft_2',
      quantity: 1,
    });
    assert.equal(options?.headers?.[STRIPE_CHECKOUT_OPERATION_HEADER], STRIPE_CHECKOUT_OPERATION_ID);
    options?.onCredential?.('anonymous-subject');
    assert.ok(credentialCapture);
    credentialCapture.authSubject = 'anonymous-subject';
    return checkoutSession;
  });
  assert.deepEqual(
    await commerce.createStripeCheckoutSession({
      dropId: 'card_nft_2',
      quantity: 1,
    }, STRIPE_CHECKOUT_OPERATION_ID, (authSubject) => { checkoutCredential = authSubject; }),
    { ...checkoutSession, authSubject: 'anonymous-subject' },
  );
  assert.equal(checkoutCredential, 'anonymous-subject');

  const statusUpdate = {
    deliveryId: 17,
    fulfillmentStatus: 'Shipped' as const,
    fulfillmentTrackingCode: 'tracking-17',
  };
  const fulfillment = createFulfillmentApiClient(async (pathname, data) => {
    assert.equal(pathname, '/fulfillment/order-status');
    assert.deepEqual(data, {
      deliveryId: 17,
      status: 'Shipped',
      dropId: 'card_nft_2',
      trackingCode: 'tracking-17',
    });
    return statusUpdate;
  });
  assert.deepEqual(
    await fulfillment.updateFulfillmentStatus(17, 'Shipped', 'card_nft_2', 'tracking-17'),
    statusUpdate,
  );
});

test('profile API client sends bearer JSON without caching and refreshes once after 401', async () => {
  const refreshes: boolean[] = [];
  const authorizations: string[] = [];
  const signals: AbortSignal[] = [];
  const observedCredentials: string[] = [];
  let calls = 0;
  const credentialCapture: { authSubject?: string } = {};
  const payload = await requestProfileApi(
    '/profile/shipments',
    { ownerWallet: OWNER },
    {
      fetch: async (input, init) => {
        calls += 1;
        assert.equal(String(input), 'https://api.mons.shop/profile/shipments');
        assert.equal(init?.method, 'POST');
        assert.equal(init?.cache, 'no-store');
        const signal = init?.signal;
        assert.ok(signal);
        signals.push(signal);
        assert.deepEqual(JSON.parse(String(init?.body)), { ownerWallet: OWNER });
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('content-type'), 'application/json');
        assert.equal(headers.get('x-mons-csrf'), '1');
        assert.equal(init?.credentials, 'same-origin');
        authorizations.push(headers.get('authorization') || '');
        return calls === 1
          ? Response.json({ ok: false, error: { code: 'unauthenticated', message: 'Expired.' } }, { status: 401 })
          : Response.json({ responseMode: 'shipments', wallet: OWNER, orders: [] });
      },
      getCredential: async (forceRefresh) => {
        refreshes.push(forceRefresh);
        return {
          authSubject: 'subject-a',
          token: forceRefresh ? 'fresh-token' : 'cached-token',
        };
      },
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
    credentialCapture,
    { onCredential: (authSubject) => observedCredentials.push(authSubject) },
  );
  assert.deepEqual(payload, { responseMode: 'shipments', wallet: OWNER, orders: [] });
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(authorizations, ['Bearer cached-token', 'Bearer fresh-token']);
  assert.equal(signals[0], signals[1]);
  assert.equal(credentialCapture.authSubject, 'subject-a');
  assert.deepEqual(observedCredentials, ['subject-a', 'subject-a']);
});

test('profile API client never replays a request after the auth subject changes', async () => {
  let calls = 0;
  await assert.rejects(
    requestProfileApi('/auth/solana', {
      wallet: OWNER,
      message: 'signed-for-subject-a',
      signature: Array(64).fill(1),
    }, {
      fetch: async () => {
        calls += 1;
        return Response.json({
          ok: false,
          error: { code: 'unauthenticated', message: 'Expired.' },
        }, { status: 401 });
      },
      getCredential: async (forceRefresh) => ({
        authSubject: forceRefresh ? 'subject-b' : 'subject-a',
      }),
      origin: () => '/api',
      timeoutMs: 1000,
    }),
    (error) => {
      const value = error as { code?: unknown; message?: unknown };
      return value.code === 'auth-subject-changed' && value.message === 'Authentication changed. Please retry.';
    },
  );
  assert.equal(calls, 1);
});

test('profile API client uses cookie credentials without exposing an anonymous bearer', async () => {
  let authorization: string | null = 'unset';
  const payload = await requestProfileApi('/profile/state', {}, {
    fetch: async (input, init) => {
      assert.equal(String(input), '/api/profile/state');
      const headers = new Headers(init?.headers);
      authorization = headers.get('authorization');
      assert.equal(headers.get('x-mons-csrf'), '1');
      assert.equal(init?.credentials, 'same-origin');
      return Response.json({ responseMode: 'profile-state', sessionWallet: null, profile: null, shipments: null });
    },
    getCredential: async () => ({ authSubject: 'anon:123e4567-e89b-42d3-a456-426614174000' }),
    origin: () => '/api',
    timeoutMs: 1000,
  });
  assert.equal(authorization, null);
  assert.deepEqual(payload, { responseMode: 'profile-state', sessionWallet: null, profile: null, shipments: null });
});

test('profile API client caps timeout overrides and returns a stable deadline error', async () => {
  let fetchCalled = false;
  await assert.rejects(
    requestProfileApi('/fulfillment/shipstation-rates', {}, {
      fetch: async () => {
        fetchCalled = true;
        return Response.json({});
      },
      getCredential: async () => new Promise<never>(() => undefined),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 10,
    }, undefined, { timeoutMs: 1_000 }),
    (error) => {
      const value = error as { code?: unknown; message?: unknown };
      return value.code === 'deadline-exceeded' && value.message === 'Profile API request timed out.';
    },
  );
  assert.equal(fetchCalled, false);
});

test('profile API body deadlines preserve settled checkout retry guidance', async () => {
  for (const testCase of [
    { status: 400, retryHeader: false, expected: false },
    { status: 502, retryHeader: false, expected: true },
    { status: 502, retryHeader: true, expected: true },
  ]) {
    await assert.rejects(
      requestProfileApi(
        '/checkout/session',
        { dropId: 'card_nft_2' },
        {
          fetch: async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: testCase.status,
            headers: testCase.retryHeader
              ? { [STRIPE_CHECKOUT_RETRY_HEADER]: STRIPE_CHECKOUT_RETRY_SAME_OPERATION }
              : {},
          }),
          getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
          origin: () => 'https://api.mons.shop',
          timeoutMs: 10,
        },
      ),
      (error) => error instanceof ProfileApiError &&
        error.code === 'deadline-exceeded' &&
        error.retrySameOperation === testCase.expected,
    );
  }
});

test('profile API retains checkout operations only for unrecognized infrastructure failures', async () => {
  const dependencies = (response: () => Response) => ({
    fetch: async () => response(),
    getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
    origin: () => 'https://api.mons.shop',
    timeoutMs: 1000,
  });
  const cases = [
    {
      response: () => Response.json({
        ok: false,
        error: { code: 'unavailable', message: 'Stripe checkout is temporarily unavailable.' },
      }, { status: 502 }),
      retry: false,
    },
    { response: () => new Response('gateway failure', { status: 502 }), retry: true },
    { response: () => Response.json({ gateway: 'failure' }, { status: 502 }), retry: true },
  ];

  for (const testCase of cases) {
    await assert.rejects(
      requestProfileApi(
        '/checkout/session',
        { dropId: 'card_nft_2' },
        dependencies(testCase.response),
      ),
      (error) => error instanceof ProfileApiError && error.retrySameOperation === testCase.retry,
    );
  }
});

test('profile API client preserves stable error codes and rejects malformed JSON', async () => {
  await assert.rejects(
    requestProfileApi(
      '/admin/profile',
      { ownerWallet: OWNER },
      {
        fetch: async () => Response.json({
          ok: false,
          error: { code: 'permission-denied', message: 'Admin access denied.', details: { reason: 'wallet' } },
        }, { status: 403 }),
        getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    ),
    (error) => {
      const value = error as { code?: unknown; message?: unknown; details?: unknown };
      return value.code === 'permission-denied' &&
        value.message === 'Admin access denied.' &&
        JSON.stringify(value.details) === JSON.stringify({ reason: 'wallet' });
    },
  );

  await assert.rejects(
    requestProfileApi(
      '/profile/anonymous-stripe-delivery-history',
      {},
      {
        fetch: async () => new Response('not-json', { status: 200 }),
        getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    ),
    (error) => {
      const value = error as { code?: unknown; retrySameOperation?: unknown };
      return value.code === 'unavailable' && value.retrySameOperation === true;
    },
  );

  await assert.rejects(
    requestProfileApi(
      '/checkout/session',
      { dropId: 'card_nft_2' },
      {
        fetch: async () => Response.json({
          ok: false,
          error: { code: 'unavailable', message: 'Stripe checkout is temporarily unavailable.' },
        }, {
          status: 502,
          headers: { [STRIPE_CHECKOUT_RETRY_HEADER]: STRIPE_CHECKOUT_RETRY_SAME_OPERATION },
        }),
        getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    ),
    (error) => error instanceof ProfileApiError && error.retrySameOperation,
  );
});

test('profile API client summary validator accepts only exact shipment summaries', () => {
  const order = {
    dropId: 'card_nft_2',
    deliveryId: 7,
    status: 'ready_to_ship',
    items: [{ kind: 'box', refId: 3 }],
  };
  assert.deepEqual(profileOrders([order]), [order]);
  assert.equal(profileOrders([{ ...order, deliveryId: 0 }]), null);
  assert.equal(profileOrders({}), null);
});

test('profile state client sends an exact authenticated request and validates independent sections', async () => {
  const payload = await requestProfileApi(
    '/profile/state',
    {},
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/profile/state');
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), {});
        return Response.json({
          responseMode: 'profile-state',
          sessionWallet: OWNER,
          profile: { status: 'ready', value: { wallet: OWNER, email: 'owner@example.com' } },
          shipments: { status: 'error', error: { code: 'unavailable', message: 'Shipments unavailable.' } },
        });
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(parseProfileState(payload), payload);
});

test('profile API retries one 401 with a fresh token and then fails terminally', async () => {
  const refreshes: boolean[] = [];
  let calls = 0;
  await assert.rejects(
    requestProfileApi('/profile/state', {}, {
      fetch: async () => {
        calls += 1;
        return Response.json({
          ok: false,
          error: { code: 'unauthenticated', message: 'Authentication is required.' },
        }, { status: 401 });
      },
      getCredential: async (forceRefresh) => {
        refreshes.push(forceRefresh);
        return {
          authSubject: OWNER,
          token: forceRefresh ? 'fresh-token' : 'cached-token',
        };
      },
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    }),
    (error) => (error as { code?: unknown }).code === 'unauthenticated',
  );
  assert.equal(calls, 2);
  assert.deepEqual(refreshes, [false, true]);
});

test('saved address retries reuse the exact client-generated id and payload', async () => {
  const request = {
    id: 'AbCdEfGhIjKlMnOpQrSt',
    encrypted: 'cipher-text',
    country: 'United States',
    countryCode: 'US',
    hint: '100…01',
    email: 'owner@example.com',
  };
  const calls: unknown[] = [];
  const response = await saveProfileAddressRequest(
    request,
    async (pathname, payload) => {
      assert.equal(pathname, '/profile/addresses');
      calls.push(structuredClone(payload));
      if (calls.length === 1) {
        throw Object.assign(new Error('temporary failure'), { code: 'unavailable' });
      }
      return request;
    },
  );
  assert.deepEqual(response, request);
  assert.deepEqual(calls, [request, request]);
});

test('Stripe checkout uses the authenticated Cloudflare route with an exact response contract', async () => {
  const payload = await requestProfileApi(
    '/checkout/session',
    { dropId: 'card_nft_binder_devnet', quantity: 1, returnUrl: 'https://mons.shop/drop' },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/checkout/session');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        assert.equal(
          new Headers(init?.headers).get(STRIPE_CHECKOUT_OPERATION_HEADER),
          STRIPE_CHECKOUT_OPERATION_ID,
        );
        return Response.json({
          id: 'cs_test_123',
          url: 'https://checkout.stripe.com/c/pay/test',
          livemode: false,
        });
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
    undefined,
    { headers: { [STRIPE_CHECKOUT_OPERATION_HEADER]: STRIPE_CHECKOUT_OPERATION_ID } },
  );
  assert.deepEqual(parseStripeCheckoutSessionResponse(payload), payload);
  assert.equal(parseStripeCheckoutSessionResponse({ ...payload as object, extra: true }), null);
  assert.equal(parseStripeCheckoutSessionResponse({ ...payload as object, livemode: 'false' }), null);
  assert.equal(profileApiTimeoutMs('/checkout/session'), 35_000);

});

test('IRL claim preparation uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = {
    encodedTx: 'AQ==',
    blockhashContextSlot: 123,
    dropId: 'card_nft_2',
    certificates: [1, 2, 3],
    certificateId: OWNER,
    message: 'Sign and send to burn your box receipt and mint your dude receipts.',
  };
  const payload = await requestProfileApi(
    '/claims/irl/prepare',
    { owner: OWNER, code: '1234567890' },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/claims/irl/prepare');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        assert.deepEqual(JSON.parse(String(init?.body)), { owner: OWNER, code: '1234567890' });
        return Response.json(response);
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(parseIrlClaimPrepareResponse(payload), response);
  assert.equal(parseIrlClaimPrepareResponse({ ...response, extra: true }), null);
  assert.equal(parseIrlClaimPrepareResponse({ ...response, blockhashContextSlot: -1 }), null);
  assert.equal(parseIrlClaimPrepareResponse({ ...response, certificates: [1, 2] }), null);
  assert.equal(parseIrlClaimPrepareResponse({ ...response, certificateId: 'invalid' }), null);
  assert.equal(parseIrlClaimPrepareResponse({ ...response, dropId: 'unknown_drop' }), null);
  assert.equal(profileApiTimeoutMs('/claims/irl/prepare'), 65_000);

});

test('Stripe receipt claiming uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = {
    processed: true,
    dropId: 'card_nft_2',
    deliveryId: 7,
    receiptsTransferred: 1,
    receiptTxs: [REVEAL_SIGNATURE],
    receiptKind: 'box',
  } as const;
  const payload = await requestProfileApi(
    '/receipts/stripe/claim',
    { code: 'ABCDEF-1234567890', recipient: OWNER },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/receipts/stripe/claim');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          code: 'ABCDEF-1234567890',
          recipient: OWNER,
        });
        return Response.json(response);
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1_000,
    },
  );
  assert.deepEqual(parseStripeReceiptClaimResponse(payload), response);
  assert.equal(parseStripeReceiptClaimResponse({ ...response, extra: true }), null);
  assert.equal(parseStripeReceiptClaimResponse({ ...response, deliveryId: 0 }), null);
  assert.equal(parseStripeReceiptClaimResponse({ ...response, receiptTxs: ['invalid'] }), null);
  assert.equal(profileApiTimeoutMs('/receipts/stripe/claim'), 190_000);

});

test('Admin IRL preparation uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = {
    encodedTx: 'AQ==',
    requestId: 'AbCdEfGhIjKlMnOpQrSt',
    dropId: 'card_nft_2',
    adminWallet: OWNER,
    itemCount: 1,
    targetKind: 'pack',
  } as const;
  const payload = await requestProfileApi(
    '/admin/irl-redeem/prepare',
    { owner: OWNER, dropId: 'card_nft_2', itemIds: [DESTINATION] },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/admin/irl-redeem/prepare');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        return Response.json(response);
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(parseAdminIrlRedeemPrepareResponse(payload), response);
  assert.equal(parseAdminIrlRedeemPrepareResponse({ ...response, extra: true }), null);
  assert.equal(parseAdminIrlRedeemPrepareResponse({ ...response, requestId: 'invalid' }), null);
  assert.equal(parseAdminIrlRedeemPrepareResponse({ ...response, itemCount: 0 }), null);
  assert.equal(parseAdminIrlRedeemPrepareResponse({ ...response, targetKind: 'card_receipt', itemCount: 2 }), null);
  assert.equal(profileApiTimeoutMs('/admin/irl-redeem/prepare'), 65_000);

});

test('Admin IRL finalization uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = ADMIN_IRL_REDEEM_FINALIZE_RESPONSE;
  let responseStatus: number | undefined;
  const payload = await requestProfileApi(
    '/admin/irl-redeem/finalize',
    {
      requestId: response.requestId,
      dropId: response.dropId,
      transferSignature: REVEAL_SIGNATURE,
    },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/admin/irl-redeem/finalize');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        return Response.json(response);
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1_000,
    },
    undefined,
    { onResponseStatus: (status) => { responseStatus = status; } },
  );
  assert.equal(responseStatus, 200);
  assert.deepEqual(parseAdminIrlRedeemFinalizeResult(payload), response);
  assert.equal(parseAdminIrlRedeemFinalizeResult({ ...response, extra: true }), null);
  assert.equal(parseAdminIrlRedeemFinalizeResult({ ...response, processed: false }), null);
  assert.equal(parseAdminIrlRedeemFinalizeResult({ ...response, claimCodes: ['invalid'] }), null);
  assert.equal(profileApiTimeoutMs('/admin/irl-redeem/finalize'), ADMIN_IRL_REDEEM_FINALIZE_OVERALL_TIMEOUT_MS);
  assert.equal(profileApiTimeoutMs(ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH), ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS);

});

test('Admin IRL finalization accepts legacy success without polling', async () => {
  const calls: Array<{ pathname: string; timeoutMs: number | undefined }> = [];
  const commerce = createCommerceApiClient(async (pathname, _data, _credential, options) => {
    options?.onCredential?.(OWNER);
    options?.onResponseStatus?.(200);
    calls.push({ pathname, timeoutMs: options?.timeoutMs });
    return ADMIN_IRL_REDEEM_FINALIZE_RESPONSE;
  });

  assert.deepEqual(
    await commerce.finalizeAdminIrlRedeem(ADMIN_IRL_REDEEM_FINALIZE_REQUEST),
    ADMIN_IRL_REDEEM_FINALIZE_RESPONSE,
  );
  assert.deepEqual(calls, [{
    pathname: '/admin/irl-redeem/finalize',
    timeoutMs: ADMIN_IRL_REDEEM_FINALIZE_OVERALL_TIMEOUT_MS,
  }]);
});

test('Admin IRL finalization requires HTTP 200 for success and 202 for pending', async () => {
  for (const testCase of [
    { status: 200, payload: adminIrlRedeemPending() },
    { status: 202, payload: ADMIN_IRL_REDEEM_FINALIZE_RESPONSE },
  ]) {
    let requests = 0;
    const call: AuthenticatedApiCall = (pathname, data, credentialCapture, options) => requestProfileApi(
      pathname,
      data,
      {
        fetch: async () => {
          requests += 1;
          return Response.json(testCase.payload, { status: testCase.status });
        },
        getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
        origin: () => 'https://api.mons.shop',
        timeoutMs: ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
      },
      credentialCapture,
      options,
    );
    const commerce = createCommerceApiClient(call);
    await assert.rejects(
      () => commerce.finalizeAdminIrlRedeem(ADMIN_IRL_REDEEM_FINALIZE_REQUEST),
      /Invalid Admin IRL redeem finalization response/,
    );
    assert.equal(requests, 1);
  }
});

test('Admin IRL finalization polls exact pending responses with one stable operation id', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const calls: Array<{ pathname: string; data: unknown; timeoutMs: number | undefined }> = [];
  const responses = [
    { status: 202, value: adminIrlRedeemPending() },
    { status: 202, value: adminIrlRedeemPending() },
    { status: 200, value: ADMIN_IRL_REDEEM_FINALIZE_RESPONSE },
  ];
  const commerce = createCommerceApiClient(async (pathname, data, _credential, options) => {
    options?.onCredential?.(OWNER);
    calls.push({ pathname, data, timeoutMs: options?.timeoutMs });
    const response = responses.shift() || assert.fail('Unexpected Admin IRL finalization request');
    options?.onResponseStatus?.(response.status);
    return response.value;
  }, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  assert.deepEqual(
    await commerce.finalizeAdminIrlRedeem(ADMIN_IRL_REDEEM_FINALIZE_REQUEST),
    ADMIN_IRL_REDEEM_FINALIZE_RESPONSE,
  );
  assert.deepEqual(sleeps, [
    ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
    ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
  ]);
  assert.deepEqual(calls, [
    {
      pathname: '/admin/irl-redeem/finalize',
      data: ADMIN_IRL_REDEEM_FINALIZE_REQUEST,
      timeoutMs: ADMIN_IRL_REDEEM_FINALIZE_OVERALL_TIMEOUT_MS,
    },
    {
      pathname: ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
      data: { operationId: ADMIN_IRL_REDEEM_OPERATION_ID },
      timeoutMs: ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
    },
    {
      pathname: ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
      data: { operationId: ADMIN_IRL_REDEEM_OPERATION_ID },
      timeoutMs: ADMIN_IRL_REDEEM_FINALIZE_HTTP_TIMEOUT_MS,
    },
  ]);
});

test('Admin IRL finalization rejects malformed pending, output, and operation changes', async () => {
  assert.deepEqual(
    parseAdminIrlRedeemFinalizePendingResponse(adminIrlRedeemPending()),
    adminIrlRedeemPending(),
  );
  assert.equal(parseAdminIrlRedeemFinalizePendingResponse({
    ...adminIrlRedeemPending(),
    extra: true,
  }), null);
  assert.equal(parseAdminIrlRedeemFinalizePendingResponse({
    ...adminIrlRedeemPending(),
    operationId: 'airf-v1-invalid',
  }), null);
  assert.equal(parseAdminIrlRedeemFinalizePendingResponse({
    ...adminIrlRedeemPending(),
    retryAfterMs: 1,
  }), null);

  const cases: Array<Array<{ status: number; value: unknown }>> = [
    [{ status: 202, value: { ...adminIrlRedeemPending(), extra: true } }],
    [{ status: 202, value: adminIrlRedeemPending(OTHER_ADMIN_IRL_REDEEM_OPERATION_ID) }],
    [
      { status: 202, value: adminIrlRedeemPending() },
      { status: 200, value: { ...ADMIN_IRL_REDEEM_FINALIZE_RESPONSE, extra: true } },
    ],
    [
      { status: 202, value: adminIrlRedeemPending() },
      { status: 202, value: adminIrlRedeemPending(OTHER_ADMIN_IRL_REDEEM_OPERATION_ID) },
    ],
    [{
      status: 200,
      value: {
        ...ADMIN_IRL_REDEEM_FINALIZE_RESPONSE,
        requestId: 'DifferentRequestId',
      },
    }],
  ];
  for (const values of cases) {
    let now = 0;
    const commerce = createCommerceApiClient(async (_pathname, _data, _credential, options) => {
      options?.onCredential?.(OWNER);
      const response = values.shift() || assert.fail('Unexpected Admin IRL finalization request');
      options?.onResponseStatus?.(response.status);
      return response.value;
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    await assert.rejects(
      () => commerce.finalizeAdminIrlRedeem(ADMIN_IRL_REDEEM_FINALIZE_REQUEST),
      /Invalid Admin IRL redeem finalization response/,
    );
  }
});

test('Admin IRL finalization retries only raw transport failures', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const paths: string[] = [];
  let call = 0;
  const commerce = createCommerceApiClient(async (pathname, _data, _credential, options) => {
    options?.onCredential?.(OWNER);
    paths.push(pathname);
    call += 1;
    if (call === 1) throw new TypeError('fetch failed');
    if (call === 2) {
      options?.onResponseStatus?.(202);
      return adminIrlRedeemPending();
    }
    if (call === 3) {
      throw new ProfileApiError({
        code: 'deadline-exceeded',
        message: 'Profile API request timed out.',
      });
    }
    options?.onResponseStatus?.(200);
    return ADMIN_IRL_REDEEM_FINALIZE_RESPONSE;
  }, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  assert.deepEqual(
    await commerce.finalizeAdminIrlRedeem(ADMIN_IRL_REDEEM_FINALIZE_REQUEST),
    ADMIN_IRL_REDEEM_FINALIZE_RESPONSE,
  );
  assert.deepEqual(paths, [
    '/admin/irl-redeem/finalize',
    '/admin/irl-redeem/finalize',
    ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
    ADMIN_IRL_REDEEM_FINALIZE_STATUS_PATH,
  ]);
  assert.deepEqual(sleeps, [
    ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
    ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
    ADMIN_IRL_REDEEM_FINALIZE_POLL_INTERVAL_MS,
  ]);

  const structured = new ProfileApiError({
    code: 'unavailable',
    message: 'Workflow status is unavailable.',
    status: 502,
  });
  let structuredCalls = 0;
  const terminalCommerce = createCommerceApiClient(async () => {
    structuredCalls += 1;
    throw structured;
  }, { sleep: async () => assert.fail('structured errors must not retry') });
  await assert.rejects(
    () => terminalCommerce.finalizeAdminIrlRedeem(ADMIN_IRL_REDEEM_FINALIZE_REQUEST),
    (error) => error === structured,
  );
  assert.equal(structuredCalls, 1);
});

test('Admin IRL finalization rejects an authentication subject change', async () => {
  let now = 0;
  let calls = 0;
  const commerce = createCommerceApiClient(async (_pathname, _data, _credential, options) => {
    calls += 1;
    options?.onCredential?.(calls === 1 ? OWNER : DESTINATION);
    options?.onResponseStatus?.(202);
    return adminIrlRedeemPending();
  }, {
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });

  await assert.rejects(
    () => commerce.finalizeAdminIrlRedeem(ADMIN_IRL_REDEEM_FINALIZE_REQUEST),
    (error) => error instanceof ProfileApiError && error.code === 'auth-subject-changed',
  );
  assert.equal(calls, 2);
});

test('Admin IRL finalization caps calls to the remaining overall deadline', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const timeouts: Array<number | undefined> = [];
  const commerce = createCommerceApiClient(async (_pathname, _data, _credential, options) => {
    options?.onCredential?.(OWNER);
    options?.onResponseStatus?.(202);
    timeouts.push(options?.timeoutMs);
    return adminIrlRedeemPending();
  }, {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    overallTimeoutMs: 4_500,
  });

  await assert.rejects(
    () => commerce.finalizeAdminIrlRedeem(ADMIN_IRL_REDEEM_FINALIZE_REQUEST),
    (error) => error instanceof ProfileApiError &&
      error.code === 'deadline-exceeded' &&
      error.retrySameOperation,
  );
  assert.deepEqual(timeouts, [4_500, 2_500, 500]);
  assert.deepEqual(sleeps, [2_000, 2_000, 500]);
  assert.equal(now, 4_500);
  assert.equal(ADMIN_IRL_REDEEM_FINALIZE_OVERALL_TIMEOUT_MS, 550_000);
});

test('box reveal uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = { signature: REVEAL_SIGNATURE, dudeIds: [1] };
  const payload = await requestProfileApi(
    '/boxes/reveal',
    { owner: OWNER, boxAssetId: DESTINATION, dropId: 'clear_cards_devnet_v2' },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/boxes/reveal');
        assert.equal(init?.method, 'POST');
        assert.equal(init?.cache, 'no-store');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          owner: OWNER,
          boxAssetId: DESTINATION,
          dropId: 'clear_cards_devnet_v2',
        });
        return Response.json(response);
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(parseRevealDudesResponse(payload, 'clear_cards_devnet_v2'), response);
  assert.equal(parseRevealDudesResponse({ ...response, extra: true }, 'clear_cards_devnet_v2'), null);
  assert.equal(parseRevealDudesResponse({ ...response, signature: OWNER }, 'clear_cards_devnet_v2'), null);
  assert.equal(parseRevealDudesResponse({ ...response, signature: ZERO_SIGNATURE }, 'clear_cards_devnet_v2'), null);
  assert.equal(parseRevealDudesResponse({ ...response, dudeIds: [0] }, 'clear_cards_devnet_v2'), null);
  assert.equal(parseRevealDudesResponse({ ...response, dudeIds: ['1'] }, 'clear_cards_devnet_v2'), null);
  assert.equal(parseRevealDudesResponse({ ...response, dudeIds: [true] }, 'clear_cards_devnet_v2'), null);
  assert.equal(parseRevealDudesResponse({ ...response, dudeIds: [1.5] }, 'clear_cards_devnet_v2'), null);
  assert.equal(parseRevealDudesResponse({ ...response, dudeIds: [1, 2] }, 'clear_cards_devnet_v2'), null);
  assert.equal(parseRevealDudesResponse({ ...response, dudeIds: [1, 1, 3] }, 'card_nft_2'), null);
  assert.equal(parseRevealDudesResponse(response, 'unknown_drop'), null);
  assert.equal(profileApiTimeoutMs('/boxes/reveal'), 65_000);

});

test('box reveal unknown-submission details require an exact drop-specific contract', async () => {
  const details = {
    kind: 'reveal-submission-unknown',
    submission: {
      signature: REVEAL_SIGNATURE,
      recentBlockhash: RECENT_BLOCKHASH,
      dudeIds: [1, 2, 3],
    },
  };
  assert.deepEqual(
    parseRevealDudesSubmissionUnknownDetails(details, 'card_nft_2'),
    details,
  );

  const malformed = [
    { ...details, extra: true },
    { ...details, kind: 'other' },
    { ...details, submission: { ...details.submission, extra: true } },
    { ...details, submission: { ...details.submission, signature: OWNER } },
    { ...details, submission: { ...details.submission, signature: ZERO_SIGNATURE } },
    { ...details, submission: { ...details.submission, recentBlockhash: REVEAL_SIGNATURE } },
    { ...details, submission: { ...details.submission, recentBlockhash: ZERO_BLOCKHASH } },
    { ...details, submission: { ...details.submission, dudeIds: ['1', 2, 3] } },
    { ...details, submission: { ...details.submission, dudeIds: [true, 2, 3] } },
    { ...details, submission: { ...details.submission, dudeIds: [1.5, 2, 3] } },
    { ...details, submission: { ...details.submission, dudeIds: [1, 1, 3] } },
    { ...details, submission: { ...details.submission, dudeIds: [0, 2, 3] } },
  ];
  for (const value of malformed) {
    assert.equal(parseRevealDudesSubmissionUnknownDetails(value, 'card_nft_2'), null);
  }
  assert.equal(parseRevealDudesSubmissionUnknownDetails(details, 'clear_cards_devnet_v2'), null);
  assert.equal(parseRevealDudesSubmissionUnknownDetails(details, 'unknown_drop'), null);

  let profileError: unknown;
  try {
    await requestProfileApi(
      '/boxes/reveal',
      { owner: OWNER, boxAssetId: DESTINATION, dropId: 'card_nft_2' },
      {
        fetch: async () => Response.json({
          error: { code: 'unavailable', message: 'Reveal status is unknown.', details },
        }, { status: 503 }),
        getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    );
  } catch (error) {
    profileError = error;
  }
  assert.deepEqual(
    revealDudesSubmissionUnknownDetails(profileError, 'card_nft_2'),
    details,
  );
  assert.equal(
    revealDudesSubmissionUnknownDetails(new Error('unknown'), 'card_nft_2'),
    null,
  );
});

test('receipt transfer preparation uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = {
    encodedTx: 'AQ==',
    dropId: 'card_nft_2',
    certificateId: OWNER,
  };
  const payload = await requestProfileApi(
    '/receipts/transfer/prepare',
    { owner: OWNER, dropId: 'card_nft_2', receiptAssetId: OWNER, destination: DESTINATION },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/receipts/transfer/prepare');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          owner: OWNER,
          dropId: 'card_nft_2',
          receiptAssetId: OWNER,
          destination: DESTINATION,
        });
        return Response.json(response);
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(parseReceiptTransferPrepareResponse(payload), response);
  assert.equal(parseReceiptTransferPrepareResponse({ ...response, extra: true }), null);
  assert.equal(parseReceiptTransferPrepareResponse({ ...response, encodedTx: '' }), null);
  assert.equal(parseReceiptTransferPrepareResponse({ ...response, certificateId: 'invalid' }), null);
  assert.equal(parseReceiptTransferPrepareResponse({ ...response, dropId: 'unknown_drop' }), null);
  assert.equal(profileApiTimeoutMs('/receipts/transfer/prepare'), 65_000);

});

test('delivery preparation uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = {
    encodedTx: 'AQ==',
    blockhashContextSlot: 123,
    deliveryLamports: 200_000_000,
    deliveryId: 17,
  };
  const body = {
    owner: OWNER,
    dropId: 'card_nft_2',
    itemIds: [DESTINATION],
    addressId: 'AbCdEfGhIjKlMnOpQrSt',
  };
  const payload = await requestProfileApi('/delivery/prepare', body, {
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://api.mons.shop/delivery/prepare');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return Response.json(response);
    },
    getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
    origin: () => 'https://api.mons.shop',
    timeoutMs: 1000,
  });
  assert.deepEqual(parseDeliveryPrepareResponse(payload), response);
  assert.equal(parseDeliveryPrepareResponse({ ...response, extra: true }), null);
  assert.equal(parseDeliveryPrepareResponse({ ...response, blockhashContextSlot: -1 }), null);
  assert.equal(parseDeliveryPrepareResponse({ ...response, encodedTx: '' }), null);
  assert.equal(parseDeliveryPrepareResponse({ ...response, deliveryLamports: -1 }), null);
  assert.equal(parseDeliveryPrepareResponse({ ...response, deliveryId: 0 }), null);
  assert.equal(profileApiTimeoutMs('/delivery/prepare'), 65_000);

});

test('receipt issuance and recovery use authenticated Cloudflare routes with exact contracts', async () => {
  const issueResponse = {
    processed: true,
    deliveryId: 17,
    receiptsMinted: 3,
    receiptTxs: [REVEAL_SIGNATURE],
    closeDeliveryTx: null,
  };
  const issuePayload = await requestProfileApi(
    '/delivery/receipts/issue',
    { owner: OWNER, deliveryId: 17, signature: REVEAL_SIGNATURE, dropId: 'card_nft_2' },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/delivery/receipts/issue');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        return Response.json(issueResponse);
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(parseIssueReceiptsResult(issuePayload), issueResponse);
  assert.equal(parseIssueReceiptsResult({ ...issueResponse, extra: true }), null);
  assert.equal(parseIssueReceiptsResult({ ...issueResponse, processed: false }), null);
  assert.equal(parseIssueReceiptsResult({ ...issueResponse, receiptTxs: [ZERO_SIGNATURE] }), null);
  assert.equal(parseIssueReceiptsResult({ ...issueResponse, deliveryId: 0x1_0000_0000 }), null);

  const recoveryResponse = {
    attempted: 1,
    recovered: 1,
    remainingProcessing: 0,
    walletRecovery: { remainingProcessing: 0, nextCheckAt: null },
    results: [{
      dropId: 'card_nft_2',
      deliveryId: 17,
      statusBefore: 'processing',
      outcome: 'recovered',
      verification: 'delivery_pda',
      message: 'receipts issued',
    }],
  };
  const recoveryPayload = await requestProfileApi(
    '/delivery/receipts/recover',
    { dropId: 'card_nft_2', deliveryId: 17, force: true },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/delivery/receipts/recover');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        return Response.json(recoveryResponse);
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(parseRecoverDeliveryOrdersResult(recoveryPayload), recoveryResponse);
  assert.equal(parseRecoverDeliveryOrdersResult({ ...recoveryResponse, extra: true }), null);
  assert.equal(parseRecoverDeliveryOrdersResult({
    ...recoveryResponse,
    remainingProcessing: 1,
  }), null);
  assert.equal(parseRecoverDeliveryOrdersResult({
    ...recoveryResponse,
    results: [{ ...recoveryResponse.results[0], outcome: 'unknown' }],
  }), null);
  assert.equal(parseRecoverDeliveryOrdersResult({
    ...recoveryResponse,
    results: [{ ...recoveryResponse.results[0], deliveryId: 0x1_0000_0000 }],
  }), null);
  assert.equal(profileApiTimeoutMs('/delivery/receipts/issue'), 65_000);
  assert.equal(profileApiTimeoutMs('/delivery/receipts/recover'), 65_000);

});

test('wallet lifecycle clients use the authenticated Cloudflare routes', async () => {
  for (const [pathname, body] of [
    ['/auth/solana', { wallet: OWNER, message: 'signed-message', signature: Array(64).fill(1) }],
    ['/profile/reconcile', { mergeStripeDeliveryOrders: true }],
  ] as const) {
    const payload = await requestProfileApi(pathname, body, {
      fetch: async (input, init) => {
        assert.equal(String(input), `https://api.mons.shop${pathname}`);
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        assert.deepEqual(JSON.parse(String(init?.body)), body);
        return Response.json(pathname === '/auth/solana'
          ? { wallet: OWNER }
          : { mergedStripeDeliveryOrders: 1 });
      },
      getCredential: async () => ({ authSubject: OWNER, token: 'token' }),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    });
    assert.ok(payload);
  }
});

test('API write response validators accept only exact public contracts', () => {
  const shipment = {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    alreadyAdded: false,
    shipstationAddedAt: 1_755_000_000_000,
  };
  assert.deepEqual(parseAddFulfillmentOrderToShipStation(shipment), shipment);
  assert.equal(parseAddFulfillmentOrderToShipStation({ ...shipment, private: true }), null);
  assert.equal(parseAddFulfillmentOrderToShipStation({ ...shipment, alreadyAdded: 'false' }), null);

  const address = {
    id: 'AbCdEfGhIjKlMnOpQrSt',
    country: 'United States',
    countryCode: 'US',
    hint: '100…01',
    encrypted: 'cipher-text',
    email: 'owner@example.com',
  };
  assert.deepEqual(parseProfileAddress(address), address);
  assert.equal(parseProfileAddress({ ...address, private: true }), null);
  assert.equal(parseProfileAddress({ ...address, id: 'not-auto-id' }), null);

  const status = {
    deliveryId: 7,
    fulfillmentStatus: 'Shipped',
    fulfillmentTrackingCode: 'https://tracking.example/7',
  } as const;
  assert.deepEqual(parseFulfillmentStatusUpdate(status), status);
  assert.deepEqual(parseFulfillmentStatusUpdate({
    ...status,
    buyerOrderShippedEmailState: 'queued',
  }), { ...status, buyerOrderShippedEmailState: 'queued' });
  assert.deepEqual(parseFulfillmentStatusUpdate({
    deliveryId: 7,
    fulfillmentStatus: '',
  }), { deliveryId: 7, fulfillmentStatus: '' });
  assert.equal(parseFulfillmentStatusUpdate({ ...status, fulfillmentStatus: 'Delivered' }), null);
  assert.equal(parseFulfillmentStatusUpdate({
    ...status,
    buyerOrderShippedEmailState: 'sent',
  }), null);
  assert.equal(parseFulfillmentStatusUpdate({ ...status, internal: true }), null);

  const fulfillmentAddress = {
    deliveryId: 7,
    address: {
      full: 'Ivan\n100 Main St\nIstanbul, 34000\nTurkey',
      encrypted: 'cipher-text',
      hint: 'I...ey',
      label: 'Home',
      countryCode: 'TR',
    },
  };
  assert.deepEqual(parseUpdateFulfillmentAddress(fulfillmentAddress), fulfillmentAddress);
  const expandedCipherAddress = {
    ...fulfillmentAddress,
    address: { ...fulfillmentAddress.address, encrypted: 'x'.repeat(12 * 1024) },
  };
  assert.deepEqual(parseUpdateFulfillmentAddress(expandedCipherAddress), expandedCipherAddress);
  assert.equal(parseUpdateFulfillmentAddress({
    ...expandedCipherAddress,
    address: { ...expandedCipherAddress.address, encrypted: `${expandedCipherAddress.address.encrypted}x` },
  }), null);
  assert.equal(parseUpdateFulfillmentAddress({
    ...fulfillmentAddress,
    address: { ...fulfillmentAddress.address, private: true },
  }), null);

  const shipStationLabel = {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    label: {
      labelId: 'label-1',
      shipmentId: 'shipment-1',
      status: 'completed',
      trackingNumber: 'tracking-1',
      totalCost: { currency: 'usd', amount: 12.5 },
      purchasedAt: 1_776_513_600_000,
    },
    labelDownloadUrl: 'https://labels.example/label-1.pdf',
  };
  assert.deepEqual(parseGetFulfillmentShipStationLabel(shipStationLabel), shipStationLabel);
  assert.deepEqual(parseGetFulfillmentShipStationLabel({
    deliveryId: 7,
    shipmentId: 'shipment-1',
    purchaseUnknown: true,
  }), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    purchaseUnknown: true,
  });
  assert.equal(parseGetFulfillmentShipStationLabel({
    ...shipStationLabel,
    labelDownloadUrl: 'http://labels.example/label-1.pdf',
  }), null);
  assert.equal(parseGetFulfillmentShipStationLabel({
    ...shipStationLabel,
    private: true,
  }), null);
  assert.equal(parseGetFulfillmentShipStationLabel({
    ...shipStationLabel,
    label: { ...shipStationLabel.label, shipmentId: 'shipment-2' },
  }), null);

  const shipStationLabelPurchase = { ...shipStationLabel, alreadyPurchased: false };
  assert.deepEqual(
    parsePurchaseFulfillmentShipStationLabel(shipStationLabelPurchase),
    shipStationLabelPurchase,
  );
  assert.equal(parsePurchaseFulfillmentShipStationLabel({
    ...shipStationLabelPurchase,
    private: true,
  }), null);
  assert.equal(parsePurchaseFulfillmentShipStationLabel({
    ...shipStationLabelPurchase,
    label: { ...shipStationLabelPurchase.label, shipmentId: 'shipment-2' },
  }), null);
  assert.equal(parsePurchaseFulfillmentShipStationLabel({
    ...shipStationLabelPurchase,
    alreadyPurchased: 'false',
  }), null);

  const shipStationLabelVoid = {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    label: { ...shipStationLabel.label, status: 'voided' },
  };
  assert.deepEqual(
    parseVoidFulfillmentShipStationLabel(shipStationLabelVoid),
    shipStationLabelVoid,
  );
  assert.equal(parseVoidFulfillmentShipStationLabel({
    ...shipStationLabelVoid,
    label: { ...shipStationLabelVoid.label, status: 'completed' },
  }), null);
  assert.equal(parseVoidFulfillmentShipStationLabel({
    ...shipStationLabelVoid,
    label: { ...shipStationLabelVoid.label, shipmentId: 'shipment-2' },
  }), null);
  assert.equal(parseVoidFulfillmentShipStationLabel({
    ...shipStationLabelVoid,
    private: true,
  }), null);

  const shipStationRates = {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    package: { length: 10, width: 8, height: 3, weight: 8 },
    packageCount: 1,
    rates: [{
      rateId: 'rate-1',
      shipmentId: 'shipment-1',
      carrierId: 'carrier-1',
      carrierCode: 'ups',
      carrierName: 'UPS',
      serviceCode: 'ups_ground',
      serviceName: 'UPS Ground',
      shippingAmount: { currency: 'usd', amount: 10 },
      insuranceAmount: { currency: 'usd', amount: 1 },
      confirmationAmount: { currency: 'usd', amount: 0 },
      otherAmount: { currency: 'usd', amount: 0.5 },
      totalAmount: { currency: 'usd', amount: 11.5 },
      guaranteedService: false,
      warningMessages: [],
    }],
    invalidRates: [],
  };
  assert.deepEqual(parseGetFulfillmentShipStationRates(shipStationRates), shipStationRates);
  const providerPackage = { ...shipStationRates.package, weight: 1616 };
  assert.deepEqual(parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    package: providerPackage,
  }), { ...shipStationRates, package: providerPackage });
  assert.equal(parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    rates: [{ ...shipStationRates.rates[0], shipmentId: 'shipment-2' }],
  }), null);
  assert.equal(parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    package: { ...shipStationRates.package, private: true },
  }), null);
  for (const field of ['length', 'width', 'height', 'weight'] as const) {
    for (const malformedValue of [
      '10',
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -1,
    ]) {
      assert.equal(parseGetFulfillmentShipStationRates({
        ...shipStationRates,
        package: { ...shipStationRates.package, [field]: malformedValue },
      }), null, `package ${field} must reject ${String(malformedValue)}`);
    }
  }
  assert.equal(parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    rates: [{
      ...shipStationRates.rates[0],
      insuranceAmount: { currency: 'eur', amount: 1 },
    }],
  }), null);
  assert.equal(parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    private: true,
  }), null);
});

test('ShipStation address correction details and request serialization use strict public contracts', () => {
  const details = {
    kind: 'shipstation-address-correction',
    fields: ['name', 'state_province', 'country_code'],
  };
  assert.deepEqual(parseFulfillmentShipStationAddressCorrectionDetails(details), details);
  for (const malformed of [
    { ...details, private: '100 Main St' },
    { ...details, kind: 'address-correction' },
    { ...details, fields: [] },
    { ...details, fields: ['state_province', 'name'] },
    { ...details, fields: ['name', 'name'] },
    { ...details, fields: ['company_name'] },
    { ...details, fields: 'state_province' },
  ]) {
    assert.equal(parseFulfillmentShipStationAddressCorrectionDetails(malformed), null);
  }

  const parcel = { length: 10, width: 8, height: 3, weight: 8 };
  const addressPatch = { address_line2: '', state_province: 'PA', country_code: 'US' };
  assert.deepEqual(addFulfillmentOrderToShipStationRequestPayload(
    7,
    'card_nft_2',
    parcel,
    addressPatch,
  ), {
    deliveryId: 7,
    dropId: 'card_nft_2',
    package: parcel,
    addressPatch,
  });
  assert.deepEqual(addFulfillmentOrderToShipStationRequestPayload(7, 'card_nft_2'), {
    deliveryId: 7,
    dropId: 'card_nft_2',
  });
});

test('profile state validator rejects mismatches, malformed summaries, and extra data', () => {
  const valid = {
    responseMode: 'profile-state',
    sessionWallet: OWNER,
    profile: { status: 'ready', value: { wallet: OWNER } },
    shipments: { status: 'ready', value: [] },
  };
  assert.deepEqual(parseProfileState(valid), valid);
  assert.deepEqual(parseProfileState({
    responseMode: 'profile-state',
    sessionWallet: null,
    profile: null,
    shipments: null,
  }), {
    responseMode: 'profile-state',
    sessionWallet: null,
    profile: null,
    shipments: null,
  });
  assert.equal(parseProfileState({
    ...valid,
    profile: { status: 'ready', value: { wallet: 'So11111111111111111111111111111111111111112' } },
  }), null);
  assert.equal(parseProfileState({
    ...valid,
    shipments: { status: 'ready', value: [{ dropId: 'drop', deliveryId: 0, status: 'processing', items: [] }] },
  }), null);
  assert.equal(parseProfileState({
    ...valid,
    shipments: {
      status: 'ready',
      value: [{ dropId: 'drop', deliveryId: 1, status: 'processing', items: [], claimCode: 'secret' }],
    },
  }), null);
  assert.equal(parseProfileState({
    ...valid,
    profile: { status: 'ready', value: { wallet: OWNER, email: ' owner@example.com ' } },
  }), null);
  assert.equal(parseProfileState({ ...valid, private: true }), null);
  assert.equal(parseProfileState({
    responseMode: 'profile-state',
    sessionWallet: null,
    profile: { status: 'ready', value: { wallet: OWNER } },
    shipments: null,
  }), null);
});
