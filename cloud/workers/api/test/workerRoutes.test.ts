import test from 'node:test';
import assert from 'node:assert/strict';
import {
  unexpectedWorkerRouteResponse,
  workerRouteRegistry,
} from '../src/workerRoutes.ts';
import { ADMIN_IRL_REDEEM_FINALIZE_RECOVERY } from '../../../../shared/contracts.ts';

type ExpectedExactRoute = readonly [
  pathname: string,
  cors: 'none' | 'public' | 'rpc' | 'profile' | 'staff-auth' | 'pack-status',
  profileOriginGate: boolean,
  staff: 'skip' | 'optional' | 'required',
  commerceMutation: boolean,
  unexpectedError: 'internal' | 'public' | 'rpc' | 'profile' | 'stripe-webhook',
  logRoute: string,
];

const EXPECTED_EXACT_ROUTES = [
  ['/health', 'none', false, 'optional', false, 'internal', '/health'],
  ['/internal/notifications/enqueue', 'none', false, 'optional', false, 'internal', '/internal/notifications/enqueue'],
  ['/checkout/session', 'profile', true, 'optional', true, 'profile', '/checkout/session'],
  ['/webhooks/stripe', 'none', false, 'optional', true, 'stripe-webhook', '/webhooks/stripe'],
  ['/claims/irl/prepare', 'profile', true, 'optional', true, 'profile', '/claims/irl/prepare'],
  ['/receipts/stripe/claim', 'profile', true, 'optional', true, 'profile', '/receipts/stripe/claim'],
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
