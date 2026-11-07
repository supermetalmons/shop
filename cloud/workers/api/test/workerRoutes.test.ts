import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkerRouteCors,
  unexpectedWorkerRouteResponse,
  workerRoutePreflightResponse,
  workerRouteRegistry,
} from '../src/workerRoutes.ts';
import { ADMIN_IRL_REDEEM_FINALIZE_RECOVERY, STRIPE_CHECKOUT_RETRY_HEADER, STRIPE_CHECKOUT_RETRY_SAME_OPERATION } from '../../../../shared/contracts.ts';

type ExpectedExactRoute = readonly [
  pathname: string,
  cors: 'none' | 'public' | 'rpc' | 'profile' | 'staff-auth' | 'mi-note' | 'ethereum' | 'ethereum-checkout-status' | 'ethereum-reveal' | 'pack-status',
  profileOriginGate: boolean,
  staff: 'skip' | 'optional' | 'required',
  commerceMutation: boolean,
  unexpectedError: 'internal' | 'public' | 'rpc' | 'profile' | 'stripe-webhook',
  logRoute: string,
];

const EXPECTED_EXACT_ROUTES = [
  ['/mi-note-cards/auth/challenge', 'mi-note', true, 'skip', false, 'profile', '/mi-note-cards/auth/challenge'],
  ['/mi-note-cards/auth/verify', 'mi-note', true, 'skip', false, 'profile', '/mi-note-cards/auth/verify'],
  ['/mi-note-cards/auth/logout', 'mi-note', true, 'skip', false, 'profile', '/mi-note-cards/auth/logout'],
  ['/preorders/availability', 'mi-note', true, 'optional', false, 'profile', '/preorders/availability'],
  ['/preorders/prepare', 'mi-note', true, 'optional', true, 'profile', '/preorders/prepare'],
  ['/preorders/submit', 'mi-note', true, 'optional', true, 'profile', '/preorders/submit'],
  ['/preorders/cancel', 'mi-note', true, 'optional', true, 'profile', '/preorders/cancel'],
  ['/preorders/status', 'mi-note', true, 'optional', true, 'profile', '/preorders/status'],
  ['/health', 'none', false, 'optional', false, 'internal', '/health'],
  ['/mi-note-cards', 'mi-note', true, 'optional', false, 'profile', '/mi-note-cards'],
  ['/internal/notifications/enqueue', 'none', false, 'optional', false, 'internal', '/internal/notifications/enqueue'],
  ['/checkout/session', 'profile', true, 'optional', true, 'profile', '/checkout/session'],
  ['/webhooks/stripe', 'none', false, 'optional', true, 'stripe-webhook', '/webhooks/stripe'],
  ['/admin/stripe-chargebacks/backfill', 'profile', true, 'required', true, 'profile', '/admin/stripe-chargebacks/backfill'],
  ['/claims/irl/prepare', 'profile', true, 'optional', true, 'profile', '/claims/irl/prepare'],
  ['/receipts/stripe/claim/start', 'profile', true, 'optional', true, 'profile', '/receipts/stripe/claim/start'],
  ['/receipts/stripe/claim/status', 'profile', true, 'optional', false, 'profile', '/receipts/stripe/claim/status'],
  ['/receipts/transfer/prepare', 'profile', true, 'optional', true, 'profile', '/receipts/transfer/prepare'],
  ['/delivery/prepare', 'profile', true, 'optional', true, 'profile', '/delivery/prepare'],
  ['/delivery/receipts/issue', 'profile', true, 'optional', true, 'profile', '/delivery/receipts/issue'],
  ['/delivery/receipts/recover', 'profile', true, 'optional', true, 'profile', '/delivery/receipts/recover'],
  ['/admin/irl-redeem/prepare', 'profile', true, 'required', true, 'profile', '/admin/irl-redeem/prepare'],
  ['/admin/irl-redeem/finalize', 'profile', true, 'required', true, 'profile', '/admin/irl-redeem/finalize'],
  ['/admin/irl-redeem/finalize/status', 'profile', true, 'required', false, 'profile', '/admin/irl-redeem/finalize/status'],
  ['/boxes/reveal', 'profile', true, 'optional', true, 'profile', '/boxes/reveal'],
  ['/inventory', 'public', false, 'skip', false, 'public', '/inventory'],
  ['/pending-open-boxes', 'public', false, 'skip', false, 'public', '/pending-open-boxes'],
  ['/notifications/subscribe', 'public', false, 'skip', false, 'public', '/notifications/subscribe'],
  ['/rpc/mainnet-beta', 'rpc', false, 'skip', false, 'rpc', '/rpc/mainnet-beta'],
  ['/rpc/devnet', 'rpc', false, 'skip', false, 'rpc', '/rpc/devnet'],
  ['/auth/anonymous/session', 'profile', false, 'optional', false, 'profile', '/auth/anonymous/session'],
  ['/auth/anonymous/logout', 'profile', false, 'optional', false, 'profile', '/auth/anonymous/logout'],
  ['/staff/auth/challenge', 'staff-auth', false, 'skip', false, 'profile', '/staff/auth/challenge'],
  ['/staff/auth/session', 'staff-auth', false, 'skip', false, 'profile', '/staff/auth/session'],
  ['/staff/auth/refresh', 'staff-auth', false, 'skip', false, 'profile', '/staff/auth/refresh'],
  ['/staff/auth/logout', 'staff-auth', false, 'skip', false, 'profile', '/staff/auth/logout'],
  ['/auth/solana', 'profile', true, 'optional', false, 'profile', '/auth/solana'],
  ['/profile/reconcile', 'profile', true, 'optional', true, 'profile', '/profile/reconcile'],
  ['/profile/shipments', 'profile', true, 'optional', false, 'profile', '/profile/shipments'],
  ['/profile/state', 'profile', true, 'optional', false, 'profile', '/profile/state'],
  ['/profile/shipment-presence', 'profile', true, 'optional', false, 'profile', '/profile/shipment-presence'],
  ['/profile/anonymous-stripe-delivery-history', 'profile', true, 'optional', false, 'profile', '/profile/anonymous-stripe-delivery-history'],
  ['/admin/profile', 'profile', true, 'required', false, 'profile', '/admin/profile'],
  ['/admin/delivery-order-owners', 'profile', true, 'required', false, 'profile', '/admin/delivery-order-owners'],
  ['/fulfillment/orders', 'profile', true, 'required', false, 'profile', '/fulfillment/orders'],
  ['/fulfillment/manual-review-checkouts', 'profile', true, 'required', false, 'profile', '/fulfillment/manual-review-checkouts'],
  ['/profile/addresses', 'profile', true, 'optional', false, 'profile', '/profile/addresses'],
  ['/fulfillment/order-status', 'profile', true, 'required', true, 'profile', '/fulfillment/order-status'],
  ['/fulfillment/order-address', 'profile', true, 'required', true, 'profile', '/fulfillment/order-address'],
  ['/fulfillment/shipstation-label', 'profile', true, 'required', true, 'profile', '/fulfillment/shipstation-label'],
  ['/fulfillment/shipstation-label-purchase', 'profile', true, 'required', true, 'profile', '/fulfillment/shipstation-label-purchase'],
  ['/fulfillment/shipstation-label-void', 'profile', true, 'required', true, 'profile', '/fulfillment/shipstation-label-void'],
  ['/fulfillment/shipstation-rates', 'profile', true, 'required', true, 'profile', '/fulfillment/shipstation-rates'],
  ['/fulfillment/shipstation-shipment', 'profile', true, 'required', true, 'profile', '/fulfillment/shipstation-shipment'],
  ['/ethereum/111k/config', 'ethereum', true, 'skip', false, 'profile', '/ethereum/111k/config'],
  ['/ethereum/111k/stats', 'ethereum', true, 'skip', false, 'profile', '/ethereum/111k/stats'],
  ['/ethereum/111k/relics', 'ethereum-checkout-status', false, 'skip', false, 'profile', '/ethereum/111k/relics'],
  ['/ethereum/111k/inventory', 'ethereum', true, 'skip', false, 'profile', '/ethereum/111k/inventory'],
  ['/ethereum/111k/metadata', 'ethereum', true, 'skip', false, 'profile', '/ethereum/111k/metadata'],
  ['/ethereum/111k/reveal/transaction', 'ethereum-reveal', false, 'skip', false, 'profile', '/ethereum/111k/reveal/transaction'],
  ['/ethereum/111k/reveal/tokens', 'ethereum-reveal', false, 'skip', false, 'profile', '/ethereum/111k/reveal/tokens'],
  ['/ethereum/111k/transactions/confirm', 'ethereum', true, 'skip', false, 'profile', '/ethereum/111k/transactions/confirm'],
  ['/ethereum/auth/challenge', 'ethereum', true, 'skip', false, 'profile', '/ethereum/auth/challenge'],
  ['/ethereum/auth/verify', 'ethereum', true, 'skip', false, 'profile', '/ethereum/auth/verify'],
  ['/ethereum/auth/logout', 'ethereum', true, 'skip', false, 'profile', '/ethereum/auth/logout'],
  ['/ethereum/profile', 'ethereum', true, 'skip', false, 'profile', '/ethereum/profile'],
  ['/ethereum/addresses', 'ethereum', true, 'skip', false, 'profile', '/ethereum/addresses'],
  ['/ethereum/shipments', 'ethereum', true, 'skip', false, 'profile', '/ethereum/shipments'],
  ['/ethereum/111k/delivery/prepare', 'ethereum', true, 'skip', true, 'profile', '/ethereum/111k/delivery/prepare'],
  ['/ethereum/111k/delivery/confirm', 'ethereum', true, 'skip', true, 'profile', '/ethereum/111k/delivery/confirm'],
  ['/ethereum/111k/claims/prepare', 'ethereum', true, 'skip', true, 'profile', '/ethereum/111k/claims/prepare'],
  ['/ethereum/111k/claims/confirm', 'ethereum', true, 'skip', true, 'profile', '/ethereum/111k/claims/confirm'],
  ['/ethereum/111k/checkout/create', 'ethereum', true, 'skip', true, 'profile', '/ethereum/111k/checkout/create'],
  ['/ethereum/111k/checkout/status', 'ethereum-checkout-status', false, 'skip', false, 'profile', '/ethereum/111k/checkout/status'],
  ['/ethereum/111k/checkout/prepare', 'ethereum', true, 'skip', true, 'profile', '/ethereum/111k/checkout/prepare'],
  ['/ethereum/111k/checkout/submission', 'ethereum', true, 'skip', true, 'profile', '/ethereum/111k/checkout/submission'],
  ['/ethereum/111k/checkout/refresh', 'ethereum', true, 'skip', true, 'profile', '/ethereum/111k/checkout/refresh'],
  ['/ethereum/pre111k/access', 'ethereum', true, 'skip', false, 'profile', '/ethereum/pre111k/access'],
  ['/ethereum/pre111k/status', 'ethereum', true, 'skip', false, 'profile', '/ethereum/pre111k/status'],
  ['/ethereum/pre111k/prepare', 'ethereum', true, 'skip', true, 'profile', '/ethereum/pre111k/prepare'],
  ['/ethereum/pre111k/confirm', 'ethereum', true, 'skip', false, 'profile', '/ethereum/pre111k/confirm'],
] satisfies readonly ExpectedExactRoute[];

function routeContract(pathname: string) {
  const route = workerRouteRegistry.resolve(pathname);
  return {
    commerceMutation: route.commerceMutation,
    cors: route.cors,
    dispatchable: typeof route.dispatch === 'function',
    logRoute: route.logRoute,
    packStatusDropId: route.packStatusDropId,
    profileOriginGate: route.profileOriginGate,
    staff: route.staff,
    unexpectedError: route.unexpectedError,
  };
}

test('exact Worker routes are unique, complete, policy-stable, and dispatchable', () => {
  const expectedPaths = EXPECTED_EXACT_ROUTES.map(([pathname]) => pathname);
  const actualPaths = [...workerRouteRegistry.exactPaths];

  assert.equal(new Set(expectedPaths).size, expectedPaths.length, 'expected route table contains duplicates');
  assert.equal(new Set(actualPaths).size, actualPaths.length, 'compiled route entries contain duplicates');
  assert.deepEqual(actualPaths.toSorted(), expectedPaths.toSorted());

  for (const [
    pathname,
    cors,
    profileOriginGate,
    staff,
    commerceMutation,
    unexpectedError,
    logRoute,
  ] of EXPECTED_EXACT_ROUTES) {
    assert.deepEqual(routeContract(pathname), {
      commerceMutation,
      cors,
      dispatchable: true,
      logRoute,
      packStatusDropId: undefined,
      profileOriginGate,
      staff,
      unexpectedError,
    }, pathname);
  }
});

test('unexpected Mi Note errors retain the verification CORS policy', () => {
  for (const path of ['/mi-note-cards', '/preorders/availability', '/mi-note-cards/auth/verify']) {
    const route = workerRouteRegistry.resolve(path);
    assert.equal(route.cors, 'mi-note');
    const response = unexpectedWorkerRouteResponse(route, new Request(`https://api.mons.shop${path}`, {
      headers: { Origin: 'https://mons.shop' },
    }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://mons.shop');
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
    assert.match(response.headers.get('Access-Control-Allow-Headers') || '', /X-Mi-Note-Session/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('route CORS policies preserve preflight, response, and error headers across origins', async () => {
  const profileHeaders = 'Content-Type, Authorization, X-Mons-CSRF, X-Mons-Checkout-Operation-Id, X-Mons-Receipt-Claim-Request';
  const cases = [
    { path: '/profile/state', methods: 'POST, OPTIONS', headers: profileHeaders, partner: false },
    { path: '/staff/auth/challenge', methods: 'POST, OPTIONS', headers: profileHeaders, partner: false },
    { path: '/mi-note-cards', methods: 'GET, POST, OPTIONS', headers: `${profileHeaders}, X-Mi-Note-Session`, partner: false },
    { path: '/ethereum/111k/config', methods: 'GET, POST, OPTIONS', headers: `${profileHeaders}, X-Mons-Ethereum-Session`, partner: false },
    { path: '/ethereum/111k/checkout/status', methods: 'GET, OPTIONS', headers: 'Accept, Content-Type', partner: true },
    { path: '/ethereum/111k/reveal/tokens', methods: 'POST, OPTIONS', headers: 'Accept, Content-Type, X-Mons-CSRF', partner: true },
  ];
  for (const entry of cases) {
    const route = workerRouteRegistry.resolve(entry.path);
    for (const origin of ['https://mons.shop', 'https://vvv.so', 'https://evil.example', undefined]) {
      const headers = origin ? { Origin: origin } : undefined;
      const request = new Request(`https://api.mons.shop${entry.path}`, { headers });
      const preflight = workerRoutePreflightResponse(route, new Request(request, { method: 'OPTIONS' }));
      const response = applyWorkerRouteCors(route, request, new Response('ok', { status: 201 }));
      const error = unexpectedWorkerRouteResponse(route, request);
      const label = `${entry.path} ${origin ?? 'no origin'}`;
      assert.ok(preflight, label);
      if (origin === 'https://mons.shop' || (entry.partner && origin === 'https://vvv.so')) {
        assert.equal(preflight.status, 204, label);
        assert.equal(response.status, 201, label);
        assert.equal(error.status, 503, label);
        for (const result of [preflight, response, error]) {
          assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin, label);
          assert.equal(result.headers.get('Access-Control-Allow-Methods'), entry.methods, label);
          assert.equal(result.headers.get('Access-Control-Allow-Headers'), entry.headers, label);
          assert.equal(result.headers.get('Access-Control-Expose-Headers'), entry.partner ? 'Retry-After' : STRIPE_CHECKOUT_RETRY_HEADER, label);
          assert.equal(result.headers.get('Vary'), 'Origin', label);
        }
        assert.equal(await response.text(), 'ok', label);
      } else if (origin) {
        for (const result of [preflight, response, error]) {
          assert.equal(result.status, 403, label);
          assert.equal(result.headers.get('Access-Control-Allow-Origin'), null, label);
          assert.deepEqual(await result.json(), {
            ok: false, error: { code: 'permission-denied', message: 'Origin is not allowed.' },
          }, label);
        }
      } else {
        assert.equal(preflight.status, entry.partner ? 204 : 403, label);
        assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null, label);
        assert.equal(response.status, 201, label);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), null, label);
        assert.equal(error.status, 503, label);
        assert.equal(error.headers.get('Access-Control-Allow-Origin'), entry.partner ? null : '*', label);
      }
      assert.equal(workerRoutePreflightResponse(route, request), undefined, label);
    }
  }
});

test('public, RPC, pack-status, and internal routes retain their existing response ownership', () => {
  for (const [path, methods, errorStatus, errorOrigin] of [
    ['/inventory', 'POST, OPTIONS', 503, 'https://mons.shop'],
    ['/rpc/mainnet-beta', 'POST, OPTIONS', 500, 'https://mons.shop'],
    ['/pack-status/card_nft_2', 'GET, POST, OPTIONS', 503, '*'],
    ['/health', null, 500, null],
    ['/pack-status/not-a-drop', null, 503, '*'],
  ] as const) {
    const route = workerRouteRegistry.resolve(path);
    const request = new Request(`https://api.mons.shop${path}`, { headers: { Origin: 'https://mons.shop' } });
    const response = new Response('already decorated', { headers: { 'X-Test': 'preserved' } });
    assert.equal(applyWorkerRouteCors(route, request, response), response, path);
    const preflight = workerRoutePreflightResponse(route, new Request(request, { method: 'OPTIONS' }));
    assert.equal(preflight?.status, methods ? 204 : undefined, path);
    assert.equal(preflight?.headers.get('Access-Control-Allow-Methods'), methods ?? undefined, path);
    const error = unexpectedWorkerRouteResponse(route, request);
    assert.equal(error.status, errorStatus, path);
    assert.equal(error.headers.get('Access-Control-Allow-Origin'), errorOrigin, path);
  }
});

test('staff preflight retains stricter origins than response decoration', () => {
  const route = workerRouteRegistry.resolve('/staff/auth/challenge');
  for (const [origin, preflightStatus] of [
    ['https://candidate-mons-shop.lil-org.workers.dev', 204],
    ['https://deadbeef-mons-shop.lil-org.workers.dev', 403],
  ] as const) {
    const request = new Request('https://api.mons.shop/staff/auth/challenge', { headers: { Origin: origin } });
    assert.equal(workerRoutePreflightResponse(route, new Request(request, { method: 'OPTIONS' }))?.status, preflightStatus);
    for (const response of [
      applyWorkerRouteCors(route, request, new Response('ok')),
      unexpectedWorkerRouteResponse(route, request),
    ]) assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  }
});

test('unexpected Ethereum errors preserve wallet session CORS policy', () => {
  const route = workerRouteRegistry.resolve('/ethereum/111k/delivery/prepare');
  const response = unexpectedWorkerRouteResponse(route, new Request('https://api.mons.shop/ethereum/111k/delivery/prepare', {
    headers: { Origin: 'https://mons.shop' },
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://mons.shop');
  assert.match(response.headers.get('Access-Control-Allow-Headers') || '', /X-Mons-Ethereum-Session/);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
});

test('unexpected Ethereum reveal errors preserve the narrow partner CORS policy', async () => {
  for (const path of ['/ethereum/111k/reveal/transaction', '/ethereum/111k/reveal/tokens']) {
    const response = unexpectedWorkerRouteResponse(workerRouteRegistry.resolve(path),
      new Request(`https://api.mons.shop${path}`, { headers: { Origin: 'https://vvv.so' } }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://vvv.so');
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Accept, Content-Type, X-Mons-CSRF');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'unavailable', message: 'Reveal is temporarily unavailable.' } });
  }
});

test('pack-status route resolution distinguishes valid, invalid, and nonmatching paths', () => {
  assert.deepEqual(routeContract('/pack-status/card_nft_2'), {
    commerceMutation: false,
    cors: 'pack-status',
    dispatchable: true,
    logRoute: '/pack-status/:dropId',
    packStatusDropId: 'card_nft_2',
    profileOriginGate: false,
    staff: 'optional',
    unexpectedError: 'public',
  });
  assert.deepEqual(routeContract('/pack-status/not-a-drop'), {
    commerceMutation: false,
    cors: 'pack-status',
    dispatchable: true,
    logRoute: '/pack-status/:dropId',
    packStatusDropId: null,
    profileOriginGate: false,
    staff: 'optional',
    unexpectedError: 'public',
  });
  assert.deepEqual(routeContract('/not-pack-status/card_nft_2'), {
    commerceMutation: false,
    cors: 'none',
    dispatchable: true,
    logRoute: 'not-found',
    packStatusDropId: undefined,
    profileOriginGate: false,
    staff: 'optional',
    unexpectedError: 'internal',
  });
});

test('reserved staff namespaces resolve to authenticated not-found routes', () => {
  for (const pathname of ['/admin/not-a-route', '/fulfillment/not-a-route']) {
    assert.deepEqual(routeContract(pathname), {
      commerceMutation: false,
      cors: 'none',
      dispatchable: true,
      logRoute: 'not-found',
      packStatusDropId: undefined,
      profileOriginGate: false,
      staff: 'required',
      unexpectedError: 'profile',
    }, pathname);
  }
});

test('generic unknown paths resolve to the internal not-found route', () => {
  assert.deepEqual(routeContract('/unknown'), {
    commerceMutation: false,
    cors: 'none',
    dispatchable: true,
    logRoute: 'not-found',
    packStatusDropId: undefined,
    profileOriginGate: false,
    staff: 'optional',
    unexpectedError: 'internal',
  });
});

test('unexpected finalization failures request recovery explicitly', async () => {
  for (const pathname of ['/admin/irl-redeem/finalize', '/admin/irl-redeem/finalize/status']) {
    const response = unexpectedWorkerRouteResponse(
      workerRouteRegistry.resolve(pathname),
      new Request(`https://api.mons.shop${pathname}`, {
        headers: { Origin: 'https://mons.shop' },
      }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Service is temporarily unavailable.',
        recovery: ADMIN_IRL_REDEEM_FINALIZE_RECOVERY,
      },
    });
  }
});

test('unexpected receipt polling errors request a retry without changing other routes', () => {
  for (const [pathname, retryable] of [
    ['/receipts/stripe/claim/start', true],
    ['/receipts/stripe/claim/status', true],
    ['/profile/state', false],
  ] as const) {
    const response = unexpectedWorkerRouteResponse(workerRouteRegistry.resolve(pathname),
      new Request(`https://api.mons.shop${pathname}`, { headers: { Origin: 'https://mons.shop' } }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get(STRIPE_CHECKOUT_RETRY_HEADER), retryable ? STRIPE_CHECKOUT_RETRY_SAME_OPERATION : null);
  }
});
