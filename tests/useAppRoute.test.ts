import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useAppRoute } = await import('../src/hooks/useAppRoute.ts');
const { navigate } = await import('../src/navigation.ts');

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(cleanup);
after(() => dom.window.close());

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
  assert.equal(current.preorderId, 'mi_note_cards_devnet');
  assert.equal(current.walletCluster, 'devnet');

  act(() => {
    window.history.replaceState(null, '', '/mi_note_cards_devnet?address=0x123#cards');
    window.dispatchEvent(new dom.window.PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(view.result.current, current);
});

test('custom navigation and browser back/forward update the route', async () => {
  const view = renderHook(useAppRoute);
  act(() => navigate('/mi_note_cards'));
  assert.equal(view.result.current.preorderId, 'mi_note_cards');
  assert.equal(view.result.current.walletCluster, 'mainnet-beta');
  act(() => navigate('/mi_note_cards_devnet'));
  assert.equal(view.result.current.preorderId, 'mi_note_cards_devnet');
  assert.equal(view.result.current.walletCluster, 'devnet');

  await act(async () => {
    const navigated = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.back();
    await navigated;
  });
  assert.equal(view.result.current.preorderId, 'mi_note_cards');
  assert.equal(view.result.current.walletCluster, 'mainnet-beta');

  await act(async () => {
    const navigated = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.forward();
    await navigated;
  });
  assert.equal(view.result.current.preorderId, 'mi_note_cards_devnet');
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
