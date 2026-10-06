import assert from 'node:assert/strict';
import test, { after, afterEach, type TestContext } from 'node:test';
import { resolveAppRoute } from '../src/routes.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

const { dom } = setupFrontendDom();
const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useShopDrop } = await import('../src/shop/useShopDrop.ts');
type ShopRoute = Parameters<typeof useShopDrop>[0];

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});
after(() => dom.window.close());

function controlledViewport(t: TestContext, initialScroll: number) {
  let scrollY = initialScroll;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const descriptor = Object.getOwnPropertyDescriptor(window, 'scrollY')!;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  t.after(() => Object.defineProperty(window, 'scrollY', descriptor));
  const scrollTo = t.mock.method(window, 'scrollTo', (options: ScrollToOptions | number, y?: number) => {
    scrollY = typeof options === 'number' ? y ?? 0 : options.top ?? scrollY;
  });
  t.mock.method(window, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  t.mock.method(window, 'cancelAnimationFrame', (id: number) => frames.delete(id));
  return {
    scrollTo,
    setScrollY(value: number) {
      scrollY = value;
      act(() => window.dispatchEvent(new dom.window.Event('scroll')));
    },
    flushFrame() {
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      });
    },
  };
}

test('shop derives its drop from the supplied route snapshot independently of the browser URL', () => {
  window.history.replaceState(null, '', '/tbd');
  const resolved = resolveAppRoute({ pathname: '/clear_cards' });
  assert.ok(resolved.drop);
  const suppliedDrop = { ...resolved.drop, maxSupply: 17 };
  const route = { ...resolved, drop: suppliedDrop };
  const { result } = renderHook(() => useShopDrop(route));

  assert.equal(result.current.normalizedCurrentPath, '/clear_cards');
  assert.equal(result.current.routeDrop, suppliedDrop);
  assert.equal(result.current.requireRouteDrop('purchase'), suppliedDrop);
  assert.equal(result.current.getDropConfig(), suppliedDrop);
  assert.equal(result.current.upcomingDropRoute, null);
  assert.ok(result.current.routeConnection);
  assert.equal(window.location.pathname, '/tbd');
});

test('drop, upcoming, and home transitions discard the previous route configuration', () => {
  window.history.replaceState(null, '', '/clear_cards');
  const live = resolveAppRoute({ pathname: '/clear_cards' });
  const { result, rerender } = renderHook((route: ShopRoute) => useShopDrop(route), { initialProps: live });
  assert.equal(result.current.routeDrop, live.drop);
  assert.ok(result.current.routeConnection);
  assert.ok(result.current.mintPreviewMedia.imageSrc);

  const resolvedUpcoming = resolveAppRoute({ pathname: '/tbd' });
  assert.ok(resolvedUpcoming.upcoming);
  const upcoming = {
    ...resolvedUpcoming,
    upcoming: { ...resolvedUpcoming.upcoming, previewImageUrl: '/resolved-preview.webp' },
  };
  rerender(upcoming);
  assert.equal(result.current.normalizedCurrentPath, '/tbd');
  assert.equal(result.current.routeDrop, null);
  assert.equal(result.current.upcomingDropRoute, upcoming.upcoming);
  assert.equal(result.current.routeConnection, null);
  assert.equal(result.current.getDropConfig(), undefined);
  assert.equal(result.current.upcomingMintPreviewMedia.imageSrc, '/resolved-preview.webp');
  assert.equal(result.current.routeStripePaymentVisible, false);
  assert.deepEqual(result.current.mintPreviewMedia, { aspectRatio: 1 });
  assert.throws(() => result.current.requireRouteDrop('purchase'), /requires an explicit drop route/);

  rerender(resolveAppRoute({ pathname: '/' }));
  assert.equal(result.current.normalizedCurrentPath, '/');
  assert.equal(result.current.routeDrop, null);
  assert.equal(result.current.upcomingDropRoute, null);
  assert.equal(result.current.routeConnection, null);
  assert.equal(result.current.upcomingMintPreviewMedia.imageSrc, undefined);
  assert.equal(window.location.pathname, '/clear_cards');
});

test('Mi Note devnet uses the pack 1 image without activating purchases', () => {
  const route = resolveAppRoute({ pathname: '/mi_note_cards_devnet' });
  const { result } = renderHook(() => useShopDrop(route));

  assert.equal(result.current.upcomingDropRoute?.title, 'Mi Note Cards');
  assert.deepEqual(result.current.upcomingMintPreviewMedia, {
    imageSrc: 'https://cdn.lil.org/nft/mi_note_cards/packs/clean/1.webp',
    aspectRatio: 1050 / 1400,
  });
  assert.equal(result.current.routeDrop, null);
  assert.equal(result.current.routeConnection, null);
  assert.equal(result.current.routeStripePaymentVisible, false);
  assert.throws(() => result.current.requireRouteDrop('purchase'), /requires an explicit drop route/);
});

test('WIP routes keep home scroll semantics while their URL points at a preview', (t) => {
  const viewport = controlledViewport(t, 480);
  const home = resolveAppRoute({ pathname: '/' });
  const { result, rerender } = renderHook((route: ShopRoute) => useShopDrop(route), { initialProps: home });

  window.history.replaceState(null, '', '/clear_cards/wip');
  rerender(resolveAppRoute({ pathname: '/clear_cards/wip' }));
  assert.equal(result.current.normalizedCurrentPath, '/');
  assert.equal(result.current.routeDrop, null);
  assert.equal(result.current.upcomingDropRoute, null);
  assert.equal(window.scrollY, 480);
  assert.equal(viewport.scrollTo.mock.callCount(), 0);

  window.history.replaceState(null, '', '/');
  rerender(home);
  viewport.flushFrame();
  assert.equal(window.scrollY, 480);
  assert.equal(viewport.scrollTo.mock.callCount(), 0);
});

test('resolved shop paths preserve home scroll restoration after visiting a drop', (t) => {
  const viewport = controlledViewport(t, 600);
  const home = resolveAppRoute({ pathname: '/' });
  const { result, rerender, unmount } = renderHook((route: ShopRoute) => useShopDrop(route), { initialProps: home });
  viewport.setScrollY(730);

  rerender(resolveAppRoute({ pathname: '/clear_cards' }));
  assert.equal(window.scrollY, 0);
  viewport.setScrollY(130);
  act(() => result.current.restoreHomeOnNextNavigation());
  rerender(home);
  assert.equal(window.scrollY, 730);
  viewport.flushFrame();
  assert.equal(window.scrollY, 730);
  unmount();
});
