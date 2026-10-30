import { MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES } from '../shared/fulfillmentAccess.ts';
import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveAppRoute, walletVisibleShopRoute } from '../src/routes.ts';
import { listFrontendDrops } from '../src/config/deployment.ts';

const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useAppRoute } = await import('../src/hooks/useAppRoute.ts');
const { navigate } = await import('../src/navigation.ts');

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(cleanup);
after(() => dom.window.close());

test('direct payment loads and remounts at its standalone route without URL replacement', () => {
  const href = 'https://mons.shop/111111/?from=direct#artwork';
  window.history.replaceState({ retained: true }, '', href);
  for (let load = 0; load < 2; load += 1) {
    const view = renderHook(useAppRoute);
    assert.equal(view.result.current.kind, 'direct-payment');
    assert.equal(view.result.current.path, '/111111');
    assert.equal(view.result.current.drop, null);
    assert.equal(view.result.current.ethereumDropId, undefined);
    assert.equal(view.result.current.replacementHref, null);
    assert.equal(window.location.href, href);
    assert.deepEqual(window.history.state, { retained: true });
    view.unmount();
  }
});

test('navigation can enter and leave the direct payment route', () => {
  const view = renderHook(useAppRoute);
  act(() => navigate('/111111'));
  assert.equal(view.result.current.kind, 'direct-payment');
  act(() => navigate('/notify_me'));
  assert.equal(view.result.current.kind, 'notify');
  act(() => {
    window.history.replaceState(null, '', '/111111');
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  assert.equal(view.result.current.kind, 'direct-payment');
  act(() => navigate('/'));
  assert.equal(view.result.current.kind, 'home');
});

test('checkout entries and sessions remain standalone and track query and history changes', () => {
  const firstId = '78f6e575-2779-43be-9829-03e8df204532';
  const secondId = 'e630e5e4-77f3-494a-abfd-6b59883e6e1c';
  window.history.replaceState(null, '', '/checkout?drop=111k_devnet&ids=1');
  const view = renderHook(useAppRoute);
  assert.equal(view.result.current.kind, 'checkout');
  assert.equal(view.result.current.checkoutSearch, '?drop=111k_devnet&ids=1');
  assert.equal(view.result.current.drop, null);
  act(() => navigate('/checkout?drop=111k_devnet&ids=2'));
  assert.equal(view.result.current.checkoutSearch, '?drop=111k_devnet&ids=2');
  act(() => navigate(`/checkout/${firstId}`, { replace: true }));
  assert.equal(view.result.current.checkoutId, firstId);
  act(() => navigate(`/checkout/${secondId}`));
  assert.equal(view.result.current.checkoutId, secondId);
  act(() => {
    window.history.replaceState(null, '', `/checkout/${firstId}`);
    window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
  });
  assert.equal(view.result.current.checkoutId, firstId);
  act(() => {
    window.history.replaceState(null, '', '/checkout?drop=invalid&ids=1');
    window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(view.result.current.kind, 'checkout');
  assert.equal(view.result.current.checkoutSearch, '?drop=invalid&ids=1');
  assert.equal(resolveAppRoute({ pathname: '/checkout/not-a-valid-id' }).kind, 'checkout');
});

test('Ethereum checkout returns track identity without trusting callback result hints', () => {
  window.history.replaceState(null, '', '/111k_devnet?checkout_id=first&result=pending');
  const view = renderHook(useAppRoute);
  assert.equal(view.result.current.ethereumCheckoutReturnId, 'first');
  const initial = view.result.current;
  act(() => navigate('/111k_devnet?checkout_id=first&result=success'));
  assert.equal(view.result.current, initial);
  act(() => navigate('/111k_devnet?checkout_id=second&result=success'));
  assert.equal(view.result.current.ethereumCheckoutReturnId, 'second');
  assert.equal(view.result.current.kind, 'ethereum-drop');
});

for (const wallet of MAINNET_ADMIN_SHIPPER_WALLET_ADDRESSES) {
  test(`mainnet-only staff cannot open copied devnet, testnet, or devnet preview routes (${wallet.slice(0, 4)})`, () => {
    const existingAdmin = 'A87Upx1f1whNV5P8xQCK2YUTwE3uMYigjoKJAF3jiNpz';
    const paths = [
      ...listFrontendDrops().filter((drop) => drop.solanaCluster === 'devnet').map((drop) => `/${drop.dropId}`),
      '/111k_devnet',
      '/mi_note_cards_devnet/wip',
    ];
    for (const pathname of paths) {
      const route = resolveAppRoute({ pathname });
      for (const [connectedWallet, staffWallet] of [[wallet, null], [null, wallet], [existingAdmin, wallet]]) {
        const visible = walletVisibleShopRoute(route, connectedWallet, staffWallet);
        assert.equal(visible.kind, 'home', pathname);
        assert.equal(visible.path, '/', pathname);
        assert.equal(visible.walletCluster, 'mainnet-beta', pathname);
      }
      assert.equal(walletVisibleShopRoute(route, existingAdmin, existingAdmin), route);
      assert.equal(walletVisibleShopRoute(route, null, null), route);
    }
    for (const pathname of ['/', '/mi_note_cards', '/card_nft_2', '/mi_note_cards/wip', '/fulfillment', '/claim', '/nfc']) {
      const route = resolveAppRoute({ pathname });
      assert.equal(walletVisibleShopRoute(route, wallet, wallet), route, pathname);
    }
  });
}

test('initial aliases preserve history state and search/hash bytes when replacing the URL', t => {
  window.history.replaceState({ retained: true }, '', '/drifella_binder/?next=%2Fclaim&code=a%2Fb#receipt-1');
  const replace = t.mock.method(window.history, 'replaceState');
  const view = renderHook(useAppRoute);

  assert.equal(view.result.current.kind, 'drop');
  assert.equal(view.result.current.path, '/card_nft_binder');
  assert.equal(view.result.current.shopPath, '/card_nft_binder');
  assert.equal(window.location.href, 'https://mons.shop/card_nft_binder?next=%2Fclaim&code=a%2Fb#receipt-1');
  assert.deepEqual(window.history.state, { retained: true });
  assert.equal(replace.mock.callCount(), 1);
});

test('navigation replaces aliases before preserving the identity of an unchanged route', t => {
  window.history.replaceState(null, '', '/fulfillment');
  const view = renderHook(useAppRoute);
  const initial = view.result.current;
  window.history.replaceState({ retained: 'alias' }, '', '/ff/?next=%2Fclaim#orders');
  const replace = t.mock.method(window.history, 'replaceState');

  act(() => window.dispatchEvent(new dom.window.PopStateEvent('popstate')));

  assert.equal(view.result.current, initial);
  assert.equal(window.location.href, 'https://mons.shop/fulfillment?next=%2Fclaim#orders');
  assert.deepEqual(window.history.state, { retained: 'alias' });
  assert.equal(replace.mock.callCount(), 1);
});

test('claim and NFC code changes update the route without changing its pathname', () => {
  for (const [path, field] of [
    ['/claim', 'claimDeepLinkCode'],
    ['/nfc', 'nfcDeepLinkCode'],
  ] as const) {
    window.history.replaceState(null, '', `${path}?code=first`);
    const view = renderHook(useAppRoute);
    const initial = view.result.current;

    act(() => {
      window.history.replaceState(null, '', `${path}?code=second%2Fcode%2Bvalue`);
      window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
    });

    assert.notEqual(view.result.current, initial);
    assert.equal(view.result.current[field], 'second/code+value');
    assert.equal(window.location.pathname, path);

    act(() => {
      window.history.replaceState(null, '', path);
      window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
    });

    assert.equal(view.result.current[field], '');
    view.unmount();
  }
});

test('pageshow restores the current route while irrelevant URL changes retain its identity', () => {
  const view = renderHook(useAppRoute);
  act(() => {
    window.history.replaceState(null, '', '/mi_note_cards_devnet');
    window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  });
  const current = view.result.current;
  assert.equal(current.kind, 'drop');
  assert.equal(current.preorderId, null);
  assert.equal(current.drop?.dropId, 'mi_note_cards_devnet');
  assert.equal(current.upcoming, null);
  assert.equal(current.walletCluster, 'devnet');

  act(() => {
    window.history.replaceState(null, '', '/mi_note_cards_devnet?address=0x123#cards');
    window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(view.result.current, current);
});

for (const [path, cluster, dropId] of [
  ['/mi_note_cards', 'mainnet-beta', 'mi_note_cards'],
  ['/mi_note_cards_devnet', 'devnet', 'mi_note_cards_devnet'],
] as const) {
  test(`${path} loads and remounts as a registered drop without replacing its URL`, () => {
    const href = `https://mons.shop${path}/?from=drop#preview`;
    window.history.replaceState({ retained: true }, '', href);
    for (let load = 0; load < 2; load += 1) {
      const view = renderHook(useAppRoute);
      assert.equal(view.result.current.kind, 'drop');
      assert.equal(view.result.current.preorderId, null);
      assert.equal(view.result.current.drop?.dropId, dropId);
      assert.equal(view.result.current.upcoming, null);
      assert.equal(view.result.current.walletCluster, cluster);
      assert.equal(window.location.href, href);
      assert.deepEqual(window.history.state, { retained: true });
      view.unmount();
    }
  });
}

test('custom navigation and browser history switch between registered mainnet and devnet drops', async () => {
  const view = renderHook(useAppRoute);
  act(() => navigate('/mi_note_cards'));
  assert.equal(view.result.current.kind, 'drop');
  assert.equal(view.result.current.preorderId, null);
  assert.equal(view.result.current.drop?.dropId, 'mi_note_cards');
  assert.equal(view.result.current.upcoming, null);
  assert.equal(view.result.current.walletCluster, 'mainnet-beta');
  act(() => navigate('/mi_note_cards_devnet'));
  assert.equal(view.result.current.kind, 'drop');
  assert.equal(view.result.current.preorderId, null);
  assert.equal(view.result.current.drop?.dropId, 'mi_note_cards_devnet');
  assert.equal(view.result.current.upcoming, null);
  assert.equal(view.result.current.walletCluster, 'devnet');

  await act(async () => {
    const navigated = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.back();
    await navigated;
  });
  assert.equal(view.result.current.kind, 'drop');
  assert.equal(view.result.current.preorderId, null);
  assert.equal(view.result.current.drop?.dropId, 'mi_note_cards');
  assert.equal(view.result.current.upcoming, null);
  assert.equal(view.result.current.walletCluster, 'mainnet-beta');

  await act(async () => {
    const navigated = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.forward();
    await navigated;
  });
  assert.equal(view.result.current.kind, 'drop');
  assert.equal(view.result.current.preorderId, null);
  assert.equal(view.result.current.drop?.dropId, 'mi_note_cards_devnet');
  assert.equal(view.result.current.upcoming, null);
  assert.equal(view.result.current.walletCluster, 'devnet');
});

test('unmount removes each navigation listener', t => {
  const add = t.mock.method(window, 'addEventListener');
  const remove = t.mock.method(window, 'removeEventListener');
  const view = renderHook(useAppRoute);
  const navigationEvents = new Set(['popstate', 'pageshow', 'mons:navigate']);
  const subscriptions = add.mock.calls.filter(call => navigationEvents.has(call.arguments[0]));
  assert.equal(subscriptions.length, navigationEvents.size);

  view.unmount();

  for (const { arguments: [event, listener] } of subscriptions) {
    assert.ok(remove.mock.calls.some(call => call.arguments[0] === event && call.arguments[1] === listener));
  }
});
