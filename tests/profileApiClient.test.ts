import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import bs58 from 'bs58';
import { profileApiTestHooks } from '../src/lib/api.ts';

const OWNER = 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx';
const DESTINATION = '11111111111111111111111111111112';
const REVEAL_SIGNATURE = bs58.encode(new Uint8Array(64).fill(5));
const RECENT_BLOCKHASH = bs58.encode(new Uint8Array(32).fill(7));
const ZERO_SIGNATURE = bs58.encode(new Uint8Array(64));
const ZERO_BLOCKHASH = bs58.encode(new Uint8Array(32));

test('profile API client sends bearer JSON without caching and refreshes once after 401', async () => {
  const refreshes: boolean[] = [];
  const authorizations: string[] = [];
  const signals: AbortSignal[] = [];
  let calls = 0;
  const payload = await profileApiTestHooks.requestProfileApi(
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
        authorizations.push(headers.get('authorization') || '');
        return calls === 1
          ? Response.json({ ok: false, error: { code: 'unauthenticated', message: 'Expired.' } }, { status: 401 })
          : Response.json({ responseMode: 'shipments', wallet: OWNER, orders: [] });
      },
      getToken: async (forceRefresh) => {
        refreshes.push(forceRefresh);
        return forceRefresh ? 'fresh-token' : 'cached-token';
      },
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(payload, { responseMode: 'shipments', wallet: OWNER, orders: [] });
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(authorizations, ['Bearer cached-token', 'Bearer fresh-token']);
  assert.equal(signals[0], signals[1]);
});

test('profile API client applies its deadline to token retrieval and returns a stable error', async () => {
  let fetchCalled = false;
  await assert.rejects(
    profileApiTestHooks.requestProfileApi('/fulfillment/shipstation-rates', {}, {
      fetch: async () => {
        fetchCalled = true;
        return Response.json({});
      },
      getToken: async () => new Promise<string>(() => undefined),
      origin: () => 'https://api.mons.shop',
      timeoutMs: 10,
    }),
    (error) => {
      const value = error as { code?: unknown; message?: unknown };
      return value.code === 'deadline-exceeded' && value.message === 'Profile API request timed out.';
    },
  );
  assert.equal(fetchCalled, false);
});

test('profile API client preserves stable error codes and rejects malformed JSON', async () => {
  await assert.rejects(
    profileApiTestHooks.requestProfileApi(
      '/admin/profile',
      { ownerWallet: OWNER },
      {
        fetch: async () => Response.json({
          ok: false,
          error: { code: 'permission-denied', message: 'Admin access denied.', details: { reason: 'wallet' } },
        }, { status: 403 }),
        getToken: async () => 'token',
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
    profileApiTestHooks.requestProfileApi(
      '/profile/anonymous-stripe-delivery-history',
      {},
      {
        fetch: async () => new Response('not-json', { status: 200 }),
        getToken: async () => 'token',
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    ),
    (error) => (error as { code?: unknown }).code === 'unavailable',
  );
});

test('profile API client summary validator accepts only exact shipment summaries', () => {
  const order = {
    dropId: 'card_nft_2',
    deliveryId: 7,
    status: 'ready_to_ship',
    items: [{ kind: 'box', refId: 3 }],
  };
  assert.deepEqual(profileApiTestHooks.profileOrders([order]), [order]);
  assert.equal(profileApiTestHooks.profileOrders([{ ...order, deliveryId: 0 }]), null);
  assert.equal(profileApiTestHooks.profileOrders({}), null);
});

test('profile state client sends an exact authenticated request and validates independent sections', async () => {
  const payload = await profileApiTestHooks.requestProfileApi(
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
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseProfileState(payload), payload);
});

test('profile API retries one 401 with a fresh token and then fails terminally', async () => {
  const refreshes: boolean[] = [];
  let calls = 0;
  await assert.rejects(
    profileApiTestHooks.requestProfileApi('/profile/state', {}, {
      fetch: async () => {
        calls += 1;
        return Response.json({
          ok: false,
          error: { code: 'unauthenticated', message: 'Authentication is required.' },
        }, { status: 401 });
      },
      getToken: async (forceRefresh) => {
        refreshes.push(forceRefresh);
        return forceRefresh ? 'fresh-token' : 'cached-token';
      },
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    }),
    (error) => (error as { code?: unknown }).code === 'unauthenticated',
  );
  assert.equal(calls, 2);
  assert.deepEqual(refreshes, [false, true]);
});

test('admin and fulfillment reads use authenticated Cloudflare routes without callable fallbacks', () => {
  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  for (const [exportName, pathname] of [
    ['listDeliveryOrderOwners', '/admin/delivery-order-owners'],
    ['listFulfillmentOrders', '/fulfillment/orders'],
    ['listFulfillmentManualReviewCheckouts', '/fulfillment/manual-review-checkouts'],
  ] as const) {
    const start = source.indexOf(`export async function ${exportName}`);
    const end = source.indexOf('\nexport ', start + 1);
    assert.notEqual(start, -1);
    const implementation = source.slice(start, end === -1 ? source.length : end);
    assert.match(implementation, new RegExp(pathname.replaceAll('/', '\\/')));
    assert.doesNotMatch(implementation, /callFunction|httpsCallable/);
  }
});

test('migrated fulfillment actions use authenticated Cloudflare routes without callable fallbacks', () => {
  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  for (const [exportName, pathname] of [
    ['saveEncryptedAddress', '/profile/addresses'],
    ['updateFulfillmentAddress', '/fulfillment/order-address'],
    ['updateFulfillmentStatus', '/fulfillment/order-status'],
    ['getFulfillmentShipStationLabel', '/fulfillment/shipstation-label'],
    ['purchaseFulfillmentShipStationLabel', '/fulfillment/shipstation-label-purchase'],
    ['voidFulfillmentShipStationLabel', '/fulfillment/shipstation-label-void'],
    ['getFulfillmentShipStationRates', '/fulfillment/shipstation-rates'],
    ['addFulfillmentOrderToShipStation', '/fulfillment/shipstation-shipment'],
  ] as const) {
    const start = source.indexOf(`export async function ${exportName}`);
    const end = source.indexOf('\nexport ', start + 1);
    assert.notEqual(start, -1);
    const implementation = source.slice(start, end === -1 ? source.length : end);
    assert.match(implementation, new RegExp(pathname.replaceAll('/', '\\/')));
    assert.doesNotMatch(implementation, /callFunction|httpsCallable/);
  }
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/shipstation-label'), 50_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/shipstation-label-purchase'), 65_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/shipstation-label-void'), 65_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/shipstation-rates'), 65_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/shipstation-shipment'), 65_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/profile/reconcile'), 65_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/fulfillment/order-address'), 20_000);
});

test('Stripe checkout uses the authenticated Cloudflare route with an exact response contract', async () => {
  const payload = await profileApiTestHooks.requestProfileApi(
    '/checkout/session',
    { dropId: 'card_nft_binder_devnet', quantity: 1, returnUrl: 'https://mons.shop/drop' },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/checkout/session');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        return Response.json({
          id: 'cs_test_123',
          url: 'https://checkout.stripe.com/c/pay/test',
          livemode: false,
        });
      },
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseStripeCheckoutSessionResponse(payload), payload);
  assert.equal(profileApiTestHooks.parseStripeCheckoutSessionResponse({ ...payload as object, extra: true }), null);
  assert.equal(profileApiTestHooks.parseStripeCheckoutSessionResponse({ ...payload as object, livemode: 'false' }), null);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/checkout/session'), 35_000);

  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function createStripeCheckoutSession');
  const end = source.indexOf('\nexport ', start + 1);
  const implementation = source.slice(start, end === -1 ? source.length : end);
  assert.match(implementation, /\/checkout\/session/);
  assert.doesNotMatch(implementation, /callFunction|httpsCallable|createStripeCheckoutSession['"]/);
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
  const payload = await profileApiTestHooks.requestProfileApi(
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
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseIrlClaimPrepareResponse(payload), response);
  assert.equal(profileApiTestHooks.parseIrlClaimPrepareResponse({ ...response, extra: true }), null);
  assert.equal(profileApiTestHooks.parseIrlClaimPrepareResponse({ ...response, blockhashContextSlot: -1 }), null);
  assert.equal(profileApiTestHooks.parseIrlClaimPrepareResponse({ ...response, certificates: [1, 2] }), null);
  assert.equal(profileApiTestHooks.parseIrlClaimPrepareResponse({ ...response, certificateId: 'invalid' }), null);
  assert.equal(profileApiTestHooks.parseIrlClaimPrepareResponse({ ...response, dropId: 'unknown_drop' }), null);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/claims/irl/prepare'), 65_000);

  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function requestClaimTx');
  const end = source.indexOf('\nexport ', start + 1);
  const implementation = source.slice(start, end === -1 ? source.length : end);
  assert.match(implementation, /\/claims\/irl\/prepare/);
  assert.doesNotMatch(implementation, /callFunction|httpsCallable|prepareIrlClaimTx/);
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
  const payload = await profileApiTestHooks.requestProfileApi(
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
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1_000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseStripeReceiptClaimResponse(payload), response);
  assert.equal(profileApiTestHooks.parseStripeReceiptClaimResponse({ ...response, extra: true }), null);
  assert.equal(profileApiTestHooks.parseStripeReceiptClaimResponse({ ...response, deliveryId: 0 }), null);
  assert.equal(profileApiTestHooks.parseStripeReceiptClaimResponse({ ...response, receiptTxs: ['invalid'] }), null);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/receipts/stripe/claim'), 190_000);

  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function claimStripeReceipt');
  const end = source.indexOf('\nexport ', start + 1);
  const implementation = source.slice(start, end === -1 ? source.length : end);
  assert.match(implementation, /\/receipts\/stripe\/claim/);
  assert.doesNotMatch(implementation, /callFunction|httpsCallable|firebase\/functions/);
  assert.doesNotMatch(source, /from ['"]firebase\/functions['"]/);
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
  const payload = await profileApiTestHooks.requestProfileApi(
    '/admin/irl-redeem/prepare',
    { owner: OWNER, dropId: 'card_nft_2', itemIds: [DESTINATION] },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/admin/irl-redeem/prepare');
        assert.equal(init?.method, 'POST');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        return Response.json(response);
      },
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseAdminIrlRedeemPrepareResponse(payload), response);
  assert.equal(profileApiTestHooks.parseAdminIrlRedeemPrepareResponse({ ...response, extra: true }), null);
  assert.equal(profileApiTestHooks.parseAdminIrlRedeemPrepareResponse({ ...response, requestId: 'invalid' }), null);
  assert.equal(profileApiTestHooks.parseAdminIrlRedeemPrepareResponse({ ...response, itemCount: 0 }), null);
  assert.equal(profileApiTestHooks.parseAdminIrlRedeemPrepareResponse({ ...response, targetKind: 'card_receipt', itemCount: 2 }), null);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/admin/irl-redeem/prepare'), 65_000);

  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function prepareAdminIrlRedeemTx');
  const end = source.indexOf('\nexport ', start + 1);
  const implementation = source.slice(start, end === -1 ? source.length : end);
  assert.match(implementation, /\/admin\/irl-redeem\/prepare/);
  assert.match(implementation, /const dropId = normalizeDropId\(args\.dropId\)/);
  assert.doesNotMatch(implementation, /callFunction|httpsCallable|prepareAdminIrlRedeemTx['"]/);
});

test('Admin IRL finalization uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = {
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
  const payload = await profileApiTestHooks.requestProfileApi(
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
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1_000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseAdminIrlRedeemFinalizeResult(payload), response);
  assert.equal(profileApiTestHooks.parseAdminIrlRedeemFinalizeResult({ ...response, extra: true }), null);
  assert.equal(profileApiTestHooks.parseAdminIrlRedeemFinalizeResult({ ...response, processed: false }), null);
  assert.equal(profileApiTestHooks.parseAdminIrlRedeemFinalizeResult({ ...response, claimCodes: ['invalid'] }), null);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/admin/irl-redeem/finalize'), 550_000);

  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function finalizeAdminIrlRedeem');
  const end = source.indexOf('\nexport ', start + 1);
  const implementation = source.slice(start, end === -1 ? source.length : end);
  assert.match(implementation, /\/admin\/irl-redeem\/finalize/);
  assert.doesNotMatch(implementation, /callFunction|httpsCallable|['"]finalizeAdminIrlRedeem['"]/);
});

test('box reveal uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = { signature: REVEAL_SIGNATURE, dudeIds: [1] };
  const payload = await profileApiTestHooks.requestProfileApi(
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
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseRevealDudesResponse(payload, 'clear_cards_devnet_v2'), response);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse({ ...response, extra: true }, 'clear_cards_devnet_v2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse({ ...response, signature: OWNER }, 'clear_cards_devnet_v2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse({ ...response, signature: ZERO_SIGNATURE }, 'clear_cards_devnet_v2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse({ ...response, dudeIds: [0] }, 'clear_cards_devnet_v2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse({ ...response, dudeIds: ['1'] }, 'clear_cards_devnet_v2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse({ ...response, dudeIds: [true] }, 'clear_cards_devnet_v2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse({ ...response, dudeIds: [1.5] }, 'clear_cards_devnet_v2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse({ ...response, dudeIds: [1, 2] }, 'clear_cards_devnet_v2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse({ ...response, dudeIds: [1, 1, 3] }, 'card_nft_2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesResponse(response, 'unknown_drop'), null);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/boxes/reveal'), 65_000);

  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function revealDudes');
  const end = source.indexOf('\nexport ', start + 1);
  const implementation = source.slice(start, end === -1 ? source.length : end);
  assert.match(implementation, /\/boxes\/reveal/);
  assert.doesNotMatch(implementation, /callFunction|httpsCallable|revealDudes['"]/);
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
    profileApiTestHooks.parseRevealDudesSubmissionUnknownDetails(details, 'card_nft_2'),
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
    assert.equal(profileApiTestHooks.parseRevealDudesSubmissionUnknownDetails(value, 'card_nft_2'), null);
  }
  assert.equal(profileApiTestHooks.parseRevealDudesSubmissionUnknownDetails(details, 'clear_cards_devnet_v2'), null);
  assert.equal(profileApiTestHooks.parseRevealDudesSubmissionUnknownDetails(details, 'unknown_drop'), null);

  let profileError: unknown;
  try {
    await profileApiTestHooks.requestProfileApi(
      '/boxes/reveal',
      { owner: OWNER, boxAssetId: DESTINATION, dropId: 'card_nft_2' },
      {
        fetch: async () => Response.json({
          error: { code: 'unavailable', message: 'Reveal status is unknown.', details },
        }, { status: 503 }),
        getToken: async () => 'token',
        origin: () => 'https://api.mons.shop',
        timeoutMs: 1000,
      },
    );
  } catch (error) {
    profileError = error;
  }
  assert.deepEqual(
    profileApiTestHooks.revealDudesSubmissionUnknownDetails(profileError, 'card_nft_2'),
    details,
  );
  assert.equal(
    profileApiTestHooks.revealDudesSubmissionUnknownDetails(new Error('unknown'), 'card_nft_2'),
    null,
  );
});

test('box reveal ambiguity recovery observes and acknowledges a received submission without resending it', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const handleRevealDudes = async');
  const end = source.indexOf('\n  const ensureRevealOverlayAdvanceAllowed', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const implementation = source.slice(start, end);
  assert.match(implementation, /revealDudesSubmissionUnknownDetails\(error, revealDrop\.dropId\)/);
  assert.match(implementation, /getDropConnection\(revealDrop\.dropId\)/);
  assert.match(implementation, /reconcileSubmittedTransaction/);
  assert.match(implementation, /detectExpiry: false/);
  assert.match(implementation, /timeoutMs: 75_000/);
  assert.match(implementation, /signal: reconciliationController\.signal/);
  assert.match(implementation, /outcome !== 'confirmed'\) throw error/);
  assert.doesNotMatch(implementation, /outcome !== 'confirmed'\) return 'retry'/);
  assert.match(
    implementation,
    /if \(outcome !== 'confirmed'\) throw error;\s*resp = await revealDudes\(walletAddress, boxAssetId, revealDrop\.dropId\)/,
  );
  assert.doesNotMatch(implementation, /signature: recoveryDetails\.submission\.signature/);
  assert.match(
    implementation,
    /const requestIsCurrent = \(\) =>\s*!reconciliationController\.signal\.aborted &&\s*!suspendedRef\.current &&\s*revealOverlaySessionRef\.current === requestSession &&\s*connectedWalletRef\.current === walletAddress/,
  );
  assert.match(implementation, /revealLoadingRequestIdRef\.current !== null\) return 'resolved'/);
  assert.ok(
    implementation.indexOf('revealLoadingRequestIdRef.current !== null') <
      implementation.indexOf('await revealDudes('),
  );
  assert.ok(
    implementation.indexOf('const reconciliationController = new AbortController()') <
      implementation.indexOf('await ensureSignedIn()'),
  );
  assert.ok(
    implementation.indexOf('const requestIsCurrent = () =>') <
      implementation.indexOf('await revealDudes('),
  );
  assert.equal(implementation.match(/reconciliationController\.signal\.aborted/g)?.length, 1);
  assert.equal(implementation.match(/!suspendedRef\.current/g)?.length, 1);
  assert.equal(implementation.match(/connectedWalletRef\.current === walletAddress/g)?.length, 1);
  assert.ok((implementation.match(/if \(!requestIsCurrent\(\)\) return 'resolved';/g)?.length ?? 0) >= 5);
  const resultApplication = implementation.indexOf('const clearCardId =');
  const resultGuard = implementation.lastIndexOf("if (!requestIsCurrent()) return 'resolved';", resultApplication);
  const acknowledgement = implementation.indexOf(
    'resp = await revealDudes(walletAddress, boxAssetId, revealDrop.dropId)',
    implementation.indexOf("if (outcome !== 'confirmed') throw error;"),
  );
  assert.ok(acknowledgement > implementation.indexOf("if (outcome !== 'confirmed') throw error;"));
  assert.ok(resultGuard > acknowledgement);
  const outerCatch = implementation.lastIndexOf('} catch (err) {');
  assert.notEqual(outerCatch, -1);
  assert.match(implementation.slice(outerCatch), /if \(!requestIsCurrent\(\)\) return 'resolved';/);
  assert.equal(implementation.match(/await revealDudes\(/g)?.length, 2);
  assert.doesNotMatch(implementation, /sendPreparedTransaction|sendSignedTransaction|sendAndConfirm/);
  assert.match(source, /revealSubmissionReconciliationAbortControllerRef\.current\?\.abort\(\)/);
  assert.match(source, /\(\) => \(\) => abortRevealSubmissionReconciliation\(\)/);
});

test('default box reveal lets the same overlay retry after a retry result', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const handleRevealOverlayClick = () =>');
  const end = source.indexOf('\n  const handleRevealOverlayDismiss', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const implementation = source.slice(start, end);
  assert.match(implementation, /const status = await handleRevealDudes\(boxAssetId, dropId\)/);
  assert.match(implementation, /status !== 'retry' \|\| revealOverlaySessionRef\.current !== requestSession/);
  assert.match(implementation, /prev\.id !== boxAssetId/);
  assert.match(implementation, /prev\.dropId !== dropId/);
  assert.match(implementation, /prev\.phase !== 'ready'/);
  assert.match(implementation, /prev\.revealedIds\?\.length/);
  assert.match(implementation, /hasRevealAttempted: false/);
});

test('prepared delivery and numeric claim submissions stay durable without coupling normal polling to pending UI', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const deliveryStart = source.indexOf('const handleShip = async');
  const deliveryEnd = source.indexOf('\n  const assertReceiptTransferWalletReady', deliveryStart);
  const claimStart = source.indexOf('const handleClaim = async');
  const claimEnd = source.indexOf('\n  const isOwnProfileView', claimStart);
  assert.notEqual(deliveryStart, -1);
  assert.notEqual(deliveryEnd, -1);
  assert.notEqual(claimStart, -1);
  assert.notEqual(claimEnd, -1);
  const delivery = source.slice(deliveryStart, deliveryEnd);
  const claim = source.slice(claimStart, claimEnd);

  const deliveryReservation = delivery.indexOf("phase: 'preparing'");
  const deliveryPersistence = delivery.indexOf('rememberPendingPreparedTransaction(activeDeliveryReservation)');
  const deliverySign = delivery.indexOf('const signature = await submitDelivery', deliveryReservation);
  assert.ok(deliveryReservation > 0 && deliveryPersistence > deliveryReservation && deliverySign > deliveryPersistence);
  assert.match(delivery, /withBrowserLock\(\s*`mons:pending-prepared-submission:\$\{deliveryWallet\}`,[\s\S]*?resp = await requestTx\(\);\s*return submitWithBlockhashRetry\(\)/);
  assert.match(delivery, /submitPendingPreparedTransaction\(reservation, submission\)/);
  assert.match(delivery, /onBroadcastAttempt: recordSubmittedDelivery/);
  assert.match(delivery, /onSubmitted: recordSubmittedDelivery/);
  assert.doesNotMatch(delivery, /syncPendingPreparedTransaction\(pendingSubmission\)/);
  assert.match(source, /const shipmentRefreshStopsRef = useRef<Set<\(\) => void>>\(new Set\(\)\)/);
  assert.match(source, /const shipmentRefreshStopsByTransactionKeyRef = useRef<Map<string, \(\) => void>>\(new Map\(\)\)/);
  assert.match(source, /shipmentRefreshMountedRef\.current = true;/);
  assert.match(source, /shipmentRefreshMountedRef\.current = false;[\s\S]*?shipmentRefreshStopsRef\.current\.forEach\(\(stop\) => stop\(\)\)/);
  assert.match(source, /const startShipmentRefresh = useCallback\([\s\S]*?retryTimer = window\.setTimeout\([\s\S]*?refreshDelay = Math\.min\(refreshDelay \* 2, DELIVERY_SHIPMENT_REFRESH_MAX_DELAY_MS\)[\s\S]*?deadline = window\.setTimeout\(stop, DELIVERY_SHIPMENT_REFRESH_TIMEOUT_MS\);\s*shipmentRefreshStopsRef\.current\.add\(stop\);[\s\S]*?void refresh\(\)/);
  assert.match(source, /shipmentRefreshStopsRef\.current\.forEach\(\(stop\) => stop\(\)\);\s*shipmentRefreshStopsRef\.current\.clear\(\)/);
  assert.match(delivery, /void refetchInventory\(\)\.catch\([\s\S]*?startShipmentRefresh\(deliveryWallet, deliveryDrop\.dropId, deliveryId\);[\s\S]*?const issued = await retryWithBackoff\(/);
  assert.match(delivery, /shouldRetry: isRetryableReceiptIssuanceError/);
  assert.doesNotMatch(delivery, /finally \{\s*stopShipmentRefresh\(\)/);
  assert.match(delivery, /const issued = await retryWithBackoff\([\s\S]*?await Promise\.all\(\[[\s\S]*?refetchInventory\(\)\.catch\([\s\S]*?refreshProfileState\(\)\.catch\(/);

  const existingDeliveryStart = delivery.indexOf('if (existingPending)');
  const existingDeliveryEnd = delivery.indexOf('\n    if (deliverableIds.length', existingDeliveryStart);
  const existingDelivery = delivery.slice(existingDeliveryStart, existingDeliveryEnd);
  assert.match(existingDelivery, /Another wallet transaction is already pending/);
  assert.doesNotMatch(existingDelivery, /setDeliveryOpen|setSelected|syncPendingPreparedTransaction/);

  const deliveryAmbiguityStart = delivery.indexOf('if (pendingSubmission && isPotentiallySubmittedTransactionError(err))');
  const deliveryFailureStart = delivery.indexOf('const reservation = pendingSubmission || activeDeliveryReservation', deliveryAmbiguityStart);
  const deliveryRetryEnd = delivery.indexOf('\n          }\n        }\n      };', deliveryFailureStart);
  assert.ok(deliveryAmbiguityStart > 0 && deliveryFailureStart > deliveryAmbiguityStart && deliveryRetryEnd > deliveryFailureStart);
  const deliveryAmbiguity = delivery.slice(deliveryAmbiguityStart, deliveryFailureStart);
  const deliveryDefinitiveFailure = delivery.slice(deliveryFailureStart, deliveryRetryEnd);
  assert.match(deliveryAmbiguity, /startShipmentRefresh\(\s*pendingSubmission\.wallet,\s*pendingSubmission\.dropId,\s*pendingSubmission\.deliveryId,\s*pendingSubmittedTransactionKey\(pendingSubmission\)/);
  assert.match(source, /if \(resolution === 'failed' \|\| resolution === 'expired'\) \{\s*if \(record\.kind === 'delivery'\) shipmentRefreshStopsByTransactionKeyRef\.current\.get\(key\)\?\.\(\)/);
  assert.match(deliveryAmbiguity, /reconcilePendingPreparedTransaction\(pendingSubmission\)\.catch/);
  assert.doesNotMatch(deliveryAmbiguity, /setDeliveryOpen|setSelected/);
  assert.doesNotMatch(deliveryDefinitiveFailure, /syncPendingPreparedTransaction|setDeliveryOpen|setSelected/);
  assert.match(deliveryDefinitiveFailure, /forgetPendingPreparedTransaction\(reservation\)/);

  const pendingCheck = claim.indexOf('const existingPendingClaim = pendingSubmittedClaim');
  const prepare = claim.indexOf('resp = await requestTx()');
  assert.ok(pendingCheck > 0 && prepare > pendingCheck);
  assert.match(claim, /withBrowserLock\(\s*`mons:pending-prepared-submission:\$\{claimWallet\}`/);
  const claimReservation = claim.indexOf("phase: 'preparing'", prepare);
  const claimPersistence = claim.indexOf('rememberPendingPreparedTransaction(activeClaimReservation)', claimReservation);
  const claimSign = claim.indexOf('await submitClaim', claimReservation);
  assert.ok(claimReservation > prepare && claimPersistence > claimReservation && claimSign > claimPersistence);
  assert.match(claim, /submitPendingPreparedTransaction\(reservation, submission\)/);
  assert.match(claim, /onBroadcastAttempt: recordSubmittedClaim/);
  assert.match(claim, /onSubmitted: recordSubmittedClaim/);
  assert.doesNotMatch(claim, /syncPendingPreparedTransaction\(pendingSubmission\)/);
  assert.match(claim, /reconcilePendingPreparedTransaction\(pendingSubmission/);
  assert.match(claim, /const resolution = await reconcilePendingPreparedTransaction\(existingPendingClaim/);
  assert.match(claim, /if \(resolution === 'confirmed'\) \{\s*if \(numericClaimUiIsCurrent\(\)\) \{\s*return presentConfirmedNumericClaim\(/);
  assert.match(claim, /if \(resolution === 'unknown'\) return \{ deferred: true \}/);

  assert.match(source, /const durable = persistPendingPreparedTransaction\(entry\);\s*if \(durable && connectedWalletRef\.current === entry\.wallet\) \{\s*syncPendingPreparedTransaction\(entry\)/);
  assert.match(source, /const durable = replacePendingPreparedTransaction\(preparing, submitted\);\s*if \(durable && connectedWalletRef\.current === submitted\.wallet\) \{\s*syncPendingPreparedTransaction\(submitted\)/);
  assert.match(delivery, /blockhashContextSlot: resp\.blockhashContextSlot/);
  assert.match(claim, /blockhashContextSlot: resp\.blockhashContextSlot/);
  assert.match(source, /signature: record\.signature,\s*recentBlockhash: record\.recentBlockhash,\s*blockhashContextSlot: record\.blockhashContextSlot/);
  assert.match(source, /if \(typeof navigator === 'undefined' \|\| typeof navigator\.locks\?\.request !== 'function'\) \{\s*throw new Error\('This browser cannot safely coordinate wallet transactions\. Update your browser and try again\.'\)/);
  assert.match(source, /navigator\.locks\.request\(name, \{ ifAvailable: true \}, async \(lock\) => \{\s*if \(!lock\) throw new Error\('Another wallet transaction is already in progress\. Wait for it to finish and try again\.'\)/);
  assert.doesNotMatch(source, /navigator\.locks\.request\(name, run\)/);
  assert.match(source, /if \(options\?\.onBroadcastAttempt\) \{\s*throw new Error\('This wallet cannot safely track the transaction before broadcast\. Use a wallet with transaction signing support\.'\)/);
  assert.match(source, /if \(resolution === 'confirmed'\) \{\s*if \(record\.kind === 'delivery'\) hideAssetsForWallet\(record\.wallet, record\.itemIds\);\s*await forgetPendingPreparedTransaction\(record\)/);
  assert.match(source, /if \(resolution === 'failed' \|\| resolution === 'expired'\) \{\s*if \(record\.kind === 'delivery'\) shipmentRefreshStopsByTransactionKeyRef\.current\.get\(key\)\?\.\(\);\s*await forgetPendingPreparedTransaction\(record\)/);
  assert.match(source, /const current = readPendingPreparedTransaction\(record\.wallet, false\)/);
  assert.match(source, /if \(current\?\.phase === 'submitted' && current\.signature === record\.signature\) \{\s*retryReconciliation\(current\);\s*return;\s*\}\s*if \(shipmentRefreshStopsByTransactionKeyRef\.current\.has\(key\)\) retryReconciliation\(record\)/);
  assert.match(source, /selectedItems\[0\]\?\.kind === 'box' &&\s*!pendingDeliveryItemIds\.has\(selectedItems\[0\]\.id\)/);
  assert.match(source, /if \(!deliveryOpen \|\| canShipSelected \|\| pendingDeliveryItemIds\.size\) return/);
  assert.doesNotMatch(source, /pendingDeliveryItemIds\.forEach\(\(id\) => \{\s*if \(next\.delete\(id\)\)/);
  assert.doesNotMatch(source, /!receiptOperationHiddenAssets\.has\(item\.id\) &&\s*!pendingDeliveryItemIds\.has\(item\.id\)/);
  assert.match(source, /queueOverlayAction\(\(\) => \{\s*if \(!claimPreviewIsCurrent\(\) \|\| opened\) return;[\s\S]*?\}, 'presentation'\)/);
  assert.match(source, /connectedWalletRef\.current === record\.wallet &&\s*ownerRef\.current === record\.wallet &&\s*uiIsCurrent\(\)/);
  assert.doesNotMatch(source, /claimPresented/);
  assert.match(source, /kind === 'presentation' && \(suspendedRef\.current \|\| presentationLoadingRef\.current\)/);
  assert.match(source, /actions\.filter\(\(action\) => action\.kind === 'presentation'\)/);
  assert.match(source, /if \(suspended \|\| revealOverlay \|\| revealLoading \|\| startOpenLoading\) return;\s*flushOverlayActions\(\)/);
  assert.match(source, /if \(revealOverlayRef\.current \|\| presentationLoadingRef\.current\) return false/);
});

test('receipt transfer preparation uses the authenticated Cloudflare route with an exact response contract', async () => {
  const response = {
    encodedTx: 'AQ==',
    dropId: 'card_nft_2',
    certificateId: OWNER,
  };
  const payload = await profileApiTestHooks.requestProfileApi(
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
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseReceiptTransferPrepareResponse(payload), response);
  assert.equal(profileApiTestHooks.parseReceiptTransferPrepareResponse({ ...response, extra: true }), null);
  assert.equal(profileApiTestHooks.parseReceiptTransferPrepareResponse({ ...response, encodedTx: '' }), null);
  assert.equal(profileApiTestHooks.parseReceiptTransferPrepareResponse({ ...response, certificateId: 'invalid' }), null);
  assert.equal(profileApiTestHooks.parseReceiptTransferPrepareResponse({ ...response, dropId: 'unknown_drop' }), null);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/receipts/transfer/prepare'), 65_000);

  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function prepareReceiptTransferTx');
  const end = source.indexOf('\nexport ', start + 1);
  const implementation = source.slice(start, end === -1 ? source.length : end);
  assert.match(implementation, /\/receipts\/transfer\/prepare/);
  assert.doesNotMatch(implementation, /callFunction|httpsCallable|prepareReceiptTransferTx['"]/);
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
  const payload = await profileApiTestHooks.requestProfileApi('/delivery/prepare', body, {
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://api.mons.shop/delivery/prepare');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return Response.json(response);
    },
    getToken: async () => 'token',
    origin: () => 'https://api.mons.shop',
    timeoutMs: 1000,
  });
  assert.deepEqual(profileApiTestHooks.parseDeliveryPrepareResponse(payload), response);
  assert.equal(profileApiTestHooks.parseDeliveryPrepareResponse({ ...response, extra: true }), null);
  assert.equal(profileApiTestHooks.parseDeliveryPrepareResponse({ ...response, blockhashContextSlot: -1 }), null);
  assert.equal(profileApiTestHooks.parseDeliveryPrepareResponse({ ...response, encodedTx: '' }), null);
  assert.equal(profileApiTestHooks.parseDeliveryPrepareResponse({ ...response, deliveryLamports: -1 }), null);
  assert.equal(profileApiTestHooks.parseDeliveryPrepareResponse({ ...response, deliveryId: 0 }), null);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/delivery/prepare'), 65_000);

  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function requestDeliveryTx');
  const end = source.indexOf('\nexport ', start + 1);
  const implementation = source.slice(start, end === -1 ? source.length : end);
  assert.match(implementation, /\/delivery\/prepare/);
  assert.doesNotMatch(implementation, /callFunction|httpsCallable|prepareDeliveryTx['"]/);
});

test('receipt issuance and recovery use authenticated Cloudflare routes with exact contracts', async () => {
  const issueResponse = {
    processed: true,
    deliveryId: 17,
    receiptsMinted: 3,
    receiptTxs: [REVEAL_SIGNATURE],
    closeDeliveryTx: null,
  };
  const issuePayload = await profileApiTestHooks.requestProfileApi(
    '/delivery/receipts/issue',
    { owner: OWNER, deliveryId: 17, signature: REVEAL_SIGNATURE, dropId: 'card_nft_2' },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/delivery/receipts/issue');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        return Response.json(issueResponse);
      },
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseIssueReceiptsResult(issuePayload), issueResponse);
  assert.equal(profileApiTestHooks.parseIssueReceiptsResult({ ...issueResponse, extra: true }), null);
  assert.equal(profileApiTestHooks.parseIssueReceiptsResult({ ...issueResponse, processed: false }), null);
  assert.equal(profileApiTestHooks.parseIssueReceiptsResult({ ...issueResponse, receiptTxs: [ZERO_SIGNATURE] }), null);
  assert.equal(profileApiTestHooks.parseIssueReceiptsResult({ ...issueResponse, deliveryId: 0x1_0000_0000 }), null);

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
  const recoveryPayload = await profileApiTestHooks.requestProfileApi(
    '/delivery/receipts/recover',
    { dropId: 'card_nft_2', deliveryId: 17, force: true },
    {
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.mons.shop/delivery/receipts/recover');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        return Response.json(recoveryResponse);
      },
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(profileApiTestHooks.parseRecoverDeliveryOrdersResult(recoveryPayload), recoveryResponse);
  assert.equal(profileApiTestHooks.parseRecoverDeliveryOrdersResult({ ...recoveryResponse, extra: true }), null);
  assert.equal(profileApiTestHooks.parseRecoverDeliveryOrdersResult({
    ...recoveryResponse,
    remainingProcessing: 1,
  }), null);
  assert.equal(profileApiTestHooks.parseRecoverDeliveryOrdersResult({
    ...recoveryResponse,
    results: [{ ...recoveryResponse.results[0], outcome: 'unknown' }],
  }), null);
  assert.equal(profileApiTestHooks.parseRecoverDeliveryOrdersResult({
    ...recoveryResponse,
    results: [{ ...recoveryResponse.results[0], deliveryId: 0x1_0000_0000 }],
  }), null);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/delivery/receipts/issue'), 65_000);
  assert.equal(profileApiTestHooks.profileApiTimeoutMs('/delivery/receipts/recover'), 65_000);

  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  for (const [name, pathname] of [
    ['issueReceipts', '/delivery/receipts/issue'],
    ['recoverMyDeliveryOrders', '/delivery/receipts/recover'],
  ] as const) {
    const start = source.indexOf(`export async function ${name}`);
    const end = source.indexOf('\nexport ', start + 1);
    const implementation = source.slice(start, end === -1 ? source.length : end);
    assert.match(implementation, new RegExp(pathname.replaceAll('/', '\\/')));
    assert.doesNotMatch(implementation, /callFunction|httpsCallable/);
  }
});

test('wallet lifecycle clients use the authenticated Cloudflare routes without callable fallbacks', async () => {
  for (const [pathname, body] of [
    ['/auth/solana', { wallet: OWNER, message: 'signed-message', signature: Array(64).fill(1) }],
    ['/profile/reconcile', { mergeStripeDeliveryOrders: true }],
  ] as const) {
    const payload = await profileApiTestHooks.requestProfileApi(pathname, body, {
      fetch: async (input, init) => {
        assert.equal(String(input), `https://api.mons.shop${pathname}`);
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
        assert.deepEqual(JSON.parse(String(init?.body)), body);
        return Response.json(pathname === '/auth/solana'
          ? { wallet: OWNER }
          : { mergedStripeDeliveryOrders: 1 });
      },
      getToken: async () => 'token',
      origin: () => 'https://api.mons.shop',
      timeoutMs: 1000,
    });
    assert.ok(payload);
  }
  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  for (const name of ['solanaAuth', 'reconcileProfileState']) {
    const start = source.indexOf(`export async function ${name}`);
    const end = source.indexOf('\nexport async function ', start + 1);
    const implementation = source.slice(start, end < 0 ? source.length : end);
    assert.match(implementation, /callProfileApi\(/);
    assert.doesNotMatch(implementation, /callFunction\(/);
  }
});

test('migrated write response validators accept only exact public contracts', () => {
  const shipment = {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    alreadyAdded: false,
    shipstationAddedAt: 1_755_000_000_000,
  };
  assert.deepEqual(profileApiTestHooks.parseAddFulfillmentOrderToShipStation(shipment), shipment);
  assert.equal(profileApiTestHooks.parseAddFulfillmentOrderToShipStation({ ...shipment, private: true }), null);
  assert.equal(profileApiTestHooks.parseAddFulfillmentOrderToShipStation({ ...shipment, alreadyAdded: 'false' }), null);

  const address = {
    id: 'AbCdEfGhIjKlMnOpQrSt',
    country: 'United States',
    countryCode: 'US',
    hint: '100…01',
    encrypted: 'cipher-text',
    email: 'owner@example.com',
  };
  assert.deepEqual(profileApiTestHooks.parseProfileAddress(address), address);
  assert.equal(profileApiTestHooks.parseProfileAddress({ ...address, private: true }), null);
  assert.equal(profileApiTestHooks.parseProfileAddress({ ...address, id: 'not-auto-id' }), null);

  const status = {
    deliveryId: 7,
    fulfillmentStatus: 'Shipped',
    fulfillmentTrackingCode: 'https://tracking.example/7',
  } as const;
  assert.deepEqual(profileApiTestHooks.parseFulfillmentStatusUpdate(status), status);
  assert.deepEqual(profileApiTestHooks.parseFulfillmentStatusUpdate({
    ...status,
    buyerOrderShippedEmailState: 'queued',
  }), { ...status, buyerOrderShippedEmailState: 'queued' });
  assert.deepEqual(profileApiTestHooks.parseFulfillmentStatusUpdate({
    deliveryId: 7,
    fulfillmentStatus: '',
  }), { deliveryId: 7, fulfillmentStatus: '' });
  assert.equal(profileApiTestHooks.parseFulfillmentStatusUpdate({ ...status, fulfillmentStatus: 'Delivered' }), null);
  assert.equal(profileApiTestHooks.parseFulfillmentStatusUpdate({
    ...status,
    buyerOrderShippedEmailState: 'sent',
  }), null);
  assert.equal(profileApiTestHooks.parseFulfillmentStatusUpdate({ ...status, internal: true }), null);

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
  assert.deepEqual(profileApiTestHooks.parseUpdateFulfillmentAddress(fulfillmentAddress), fulfillmentAddress);
  const expandedCipherAddress = {
    ...fulfillmentAddress,
    address: { ...fulfillmentAddress.address, encrypted: 'x'.repeat(12 * 1024) },
  };
  assert.deepEqual(profileApiTestHooks.parseUpdateFulfillmentAddress(expandedCipherAddress), expandedCipherAddress);
  assert.equal(profileApiTestHooks.parseUpdateFulfillmentAddress({
    ...expandedCipherAddress,
    address: { ...expandedCipherAddress.address, encrypted: `${expandedCipherAddress.address.encrypted}x` },
  }), null);
  assert.equal(profileApiTestHooks.parseUpdateFulfillmentAddress({
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
  assert.deepEqual(profileApiTestHooks.parseGetFulfillmentShipStationLabel(shipStationLabel), shipStationLabel);
  assert.deepEqual(profileApiTestHooks.parseGetFulfillmentShipStationLabel({
    deliveryId: 7,
    shipmentId: 'shipment-1',
    purchaseUnknown: true,
  }), {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    purchaseUnknown: true,
  });
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationLabel({
    ...shipStationLabel,
    labelDownloadUrl: 'http://labels.example/label-1.pdf',
  }), null);
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationLabel({
    ...shipStationLabel,
    private: true,
  }), null);
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationLabel({
    ...shipStationLabel,
    label: { ...shipStationLabel.label, shipmentId: 'shipment-2' },
  }), null);

  const shipStationLabelPurchase = { ...shipStationLabel, alreadyPurchased: false };
  assert.deepEqual(
    profileApiTestHooks.parsePurchaseFulfillmentShipStationLabel(shipStationLabelPurchase),
    shipStationLabelPurchase,
  );
  assert.equal(profileApiTestHooks.parsePurchaseFulfillmentShipStationLabel({
    ...shipStationLabelPurchase,
    private: true,
  }), null);
  assert.equal(profileApiTestHooks.parsePurchaseFulfillmentShipStationLabel({
    ...shipStationLabelPurchase,
    label: { ...shipStationLabelPurchase.label, shipmentId: 'shipment-2' },
  }), null);
  assert.equal(profileApiTestHooks.parsePurchaseFulfillmentShipStationLabel({
    ...shipStationLabelPurchase,
    alreadyPurchased: 'false',
  }), null);

  const shipStationLabelVoid = {
    deliveryId: 7,
    shipmentId: 'shipment-1',
    label: { ...shipStationLabel.label, status: 'voided' },
  };
  assert.deepEqual(
    profileApiTestHooks.parseVoidFulfillmentShipStationLabel(shipStationLabelVoid),
    shipStationLabelVoid,
  );
  assert.equal(profileApiTestHooks.parseVoidFulfillmentShipStationLabel({
    ...shipStationLabelVoid,
    label: { ...shipStationLabelVoid.label, status: 'completed' },
  }), null);
  assert.equal(profileApiTestHooks.parseVoidFulfillmentShipStationLabel({
    ...shipStationLabelVoid,
    label: { ...shipStationLabelVoid.label, shipmentId: 'shipment-2' },
  }), null);
  assert.equal(profileApiTestHooks.parseVoidFulfillmentShipStationLabel({
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
  assert.deepEqual(profileApiTestHooks.parseGetFulfillmentShipStationRates(shipStationRates), shipStationRates);
  const providerPackage = { ...shipStationRates.package, weight: 1616 };
  assert.deepEqual(profileApiTestHooks.parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    package: providerPackage,
  }), { ...shipStationRates, package: providerPackage });
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    rates: [{ ...shipStationRates.rates[0], shipmentId: 'shipment-2' }],
  }), null);
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
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
      assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
        ...shipStationRates,
        package: { ...shipStationRates.package, [field]: malformedValue },
      }), null, `package ${field} must reject ${String(malformedValue)}`);
    }
  }
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    rates: [{
      ...shipStationRates.rates[0],
      insuranceAmount: { currency: 'eur', amount: 1 },
    }],
  }), null);
  assert.equal(profileApiTestHooks.parseGetFulfillmentShipStationRates({
    ...shipStationRates,
    private: true,
  }), null);
});

test('ShipStation address correction details and request serialization use strict public contracts', () => {
  const details = {
    kind: 'shipstation-address-correction',
    fields: ['name', 'state_province', 'country_code'],
  };
  assert.deepEqual(profileApiTestHooks.parseFulfillmentShipStationAddressCorrectionDetails(details), details);
  for (const malformed of [
    { ...details, private: '100 Main St' },
    { ...details, kind: 'address-correction' },
    { ...details, fields: [] },
    { ...details, fields: ['state_province', 'name'] },
    { ...details, fields: ['name', 'name'] },
    { ...details, fields: ['company_name'] },
    { ...details, fields: 'state_province' },
  ]) {
    assert.equal(profileApiTestHooks.parseFulfillmentShipStationAddressCorrectionDetails(malformed), null);
  }

  const parcel = { length: 10, width: 8, height: 3, weight: 8 };
  const addressPatch = { address_line2: '', state_province: 'PA', country_code: 'US' };
  assert.deepEqual(profileApiTestHooks.addFulfillmentOrderToShipStationRequestPayload(
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
  assert.deepEqual(profileApiTestHooks.addFulfillmentOrderToShipStationRequestPayload(7, 'card_nft_2'), {
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
  assert.deepEqual(profileApiTestHooks.parseProfileState(valid), valid);
  assert.deepEqual(profileApiTestHooks.parseProfileState({
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
  assert.equal(profileApiTestHooks.parseProfileState({
    ...valid,
    profile: { status: 'ready', value: { wallet: 'So11111111111111111111111111111111111111112' } },
  }), null);
  assert.equal(profileApiTestHooks.parseProfileState({
    ...valid,
    shipments: { status: 'ready', value: [{ dropId: 'drop', deliveryId: 0, status: 'processing', items: [] }] },
  }), null);
  assert.equal(profileApiTestHooks.parseProfileState({
    ...valid,
    shipments: {
      status: 'ready',
      value: [{ dropId: 'drop', deliveryId: 1, status: 'processing', items: [], claimCode: 'secret' }],
    },
  }), null);
  assert.equal(profileApiTestHooks.parseProfileState({
    ...valid,
    profile: { status: 'ready', value: { wallet: OWNER, email: ' owner@example.com ' } },
  }), null);
  assert.equal(profileApiTestHooks.parseProfileState({ ...valid, private: true }), null);
  assert.equal(profileApiTestHooks.parseProfileState({
    responseMode: 'profile-state',
    sessionWallet: null,
    profile: { status: 'ready', value: { wallet: OWNER } },
    shipments: null,
  }), null);
});

test('migrated profile reads are absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  for (const name of ['getProfile', 'getAdminProfileView', 'getAnonymousStripeDeliveryHistory']) {
    assert.doesNotMatch(functionsSource, new RegExp(`export const ${name}\\b`));
    assert.doesNotMatch(packageJson, new RegExp(`functions:${name}(?:,|\\\")`));
  }
});

test('Stripe checkout callable is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(functionsSource, /export const createStripeCheckoutSession\b/);
  assert.doesNotMatch(packageJson.scripts['deploy:firebaseNewDrops'], /functions:createStripeCheckoutSession(?:,|$)/);
  assert.equal(packageJson.scripts['decommission:firebase-create-stripe-checkout-session'], undefined);
});

test('Stripe receipt claim callable is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(functionsSource, /export const claimStripeReceipt\b/);
  assert.doesNotMatch(packageJson.scripts['deploy:firebaseNewDrops'], /functions:claimStripeReceipt(?:,|$)/);
  assert.equal(packageJson.scripts['decommission:firebase-claim-stripe-receipt'], undefined);
});

test('wallet lifecycle callables are absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const name of ['solanaAuth', 'reconcileProfileState']) {
    assert.doesNotMatch(functionsSource, new RegExp(`export const ${name}\\b`));
    assert.doesNotMatch(packageJson.scripts['deploy:firebaseNewDrops'], new RegExp(`functions:${name}(?:,|$)`));
  }
  assert.equal(packageJson.scripts['decommission:firebase-profile-lifecycle'], undefined);
});

test('IRL claim preparation callable is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(functionsSource, /export const prepareIrlClaimTx\b/);
  assert.doesNotMatch(packageJson.scripts['deploy:firebaseNewDrops'], /functions:prepareIrlClaimTx(?:,|$)/);
  assert.equal(packageJson.scripts['decommission:firebase-prepare-irl-claim'], undefined);
});

test('receipt transfer preparation callable is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(functionsSource, /export const prepareReceiptTransferTx\b/);
  assert.doesNotMatch(packageJson.scripts['deploy:firebaseNewDrops'], /functions:prepareReceiptTransferTx(?:,|$)/);
  assert.equal(packageJson.scripts['decommission:firebase-prepare-receipt-transfer'], undefined);
});

test('delivery preparation callable is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(functionsSource, /export const prepareDeliveryTx\b/);
  assert.doesNotMatch(packageJson.scripts['deploy:firebaseNewDrops'], /functions:prepareDeliveryTx(?:,|$)/);
  assert.equal(packageJson.scripts['decommission:firebase-prepare-delivery'], undefined);
});

test('Admin IRL preparation callable is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(functionsSource, /export const prepareAdminIrlRedeemTx\b/);
  assert.doesNotMatch(packageJson.scripts['deploy:firebaseNewDrops'], /functions:prepareAdminIrlRedeemTx(?:,|$)/);
  assert.equal(packageJson.scripts['decommission:firebase-prepare-admin-irl-redeem'], undefined);
});

test('Admin IRL finalization callable is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(functionsSource, /export const finalizeAdminIrlRedeem\b/);
  assert.doesNotMatch(packageJson.scripts['deploy:firebaseNewDrops'], /functions:finalizeAdminIrlRedeem(?:,|$)/);
});

test('reveal callable is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.doesNotMatch(functionsSource, /export const revealDudes\b/);
  assert.doesNotMatch(packageJson.scripts['deploy:firebaseNewDrops'], /functions:revealDudes(?:,|$)/);
  assert.equal(packageJson.scripts['decommission:firebase-reveal-dudes'], undefined);
});

test('migrated profile writes are absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  for (const name of [
    'saveAddress',
    'updateFulfillmentStatus',
    'updateFulfillmentAddress',
    'addFulfillmentOrderToShipStation',
    'getFulfillmentShipStationLabel',
    'getFulfillmentShipStationRates',
    'purchaseFulfillmentShipStationLabel',
    'voidFulfillmentShipStationLabel',
  ]) {
    assert.doesNotMatch(functionsSource, new RegExp(`export const ${name}\\b`));
    assert.doesNotMatch(packageJson, new RegExp(`functions:${name}(?:,|\\")`));
  }
  assert.equal(scripts['decommission:firebase-fulfillment-callables'], undefined);
  assert.equal(scripts['decommission:firebase-shipstation-label-purchase'], undefined);
});

test('migrated buyer shipped notification is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  assert.doesNotMatch(functionsSource, /export const notifyBuyerOnDeliveryShipped\b/);
  assert.doesNotMatch(scripts['deploy:firebaseNewDrops'], /functions:notifyBuyerOnDeliveryShipped(?:,|$)/);
  assert.equal(scripts['decommission:firebase-buyer-shipped-notification'], undefined);
});

test('migrated ready-to-ship notification is absent from Firebase exports and deployment selection', () => {
  const functionsSource = readFileSync(new URL('../functions/src/index.ts', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;
  assert.doesNotMatch(functionsSource, /export const notifyShippersOnDeliveryReadyToShip\b/);
  assert.doesNotMatch(scripts['deploy:firebaseNewDrops'], /functions:notifyShippersOnDeliveryReadyToShip(?:,|$)/);
});

test('browser source has no direct Firestore data access', () => {
  const sourceRoot = new URL('../src/', import.meta.url);
  const files = (directory: URL): URL[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? files(child) : statSync(child).isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [child] : [];
  });
  const source = files(sourceRoot).map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /from\s+['"]firebase\/firestore['"]/);
  assert.doesNotMatch(source, /\bgetFirestore\s*\(/);
});
