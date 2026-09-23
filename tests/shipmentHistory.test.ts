import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createElement, type PropsWithChildren } from 'react';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import type { ShipmentHistoryCursor, ShipmentHistoryPage } from '../shared/shipmentHistory.ts';

setupFrontendDom();
const { act, cleanup, renderHook, render, fireEvent, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { useShipmentHistory } = await import('../src/hooks/useShipmentHistory.ts');
const { ShipmentHistoryContinuation } = await import('../src/shop/ui/ShipmentHistoryContinuation.tsx');
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  Reflect.deleteProperty(globalThis, 'IntersectionObserver');
});

function cursor(id: number, owner = 'wallet-a'): ShipmentHistoryCursor {
  return { version: 1, owner, sortAtMs: id, documentPath: `drops/drop/deliveryOrders/${id}` };
}

function page(ids: number[], next: number | null = null): ShipmentHistoryPage {
  return {
    orders: ids.map((deliveryId) => ({ dropId: 'drop', deliveryId, status: 'processing', items: [], createdAt: deliveryId })),
    nextCursor: next === null ? null : cursor(next),
  };
}

function harness(initialPage: ShipmentHistoryPage | null = page([100], 100), reactStrictMode = false) {
  const calls: Array<{ cursor: ShipmentHistoryCursor | null; pending: ReturnType<typeof Promise.withResolvers<ShipmentHistoryPage>> }> = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const runtime: NonNullable<Parameters<typeof useShipmentHistory>[1]> = {
    loadPage: async (_identity, request) => {
      assert.equal(request.limit, 50);
      const pending = Promise.withResolvers<ShipmentHistoryPage>();
      calls.push({ cursor: request.cursor ?? null, pending });
      return pending.promise;
    },
  };
  const options: Parameters<typeof useShipmentHistory>[0] = {
    identity: { authSubject: 'subject-a', sessionWallet: 'wallet-a', scope: 'wallet', owner: 'wallet-a' },
    initialPage: initialPage ?? undefined,
    revision: 1,
  };
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children);
  return { ...renderHook((props: typeof options) => useShipmentHistory(props, runtime), { initialProps: options, wrapper, reactStrictMode }), calls, options, client };
}

test('StrictMode history seeds the first page, serializes continuation requests and deduplicates deliveries', async () => {
  const h = harness(page([100], 100), true);
  await act(async () => {});
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [100]);
  let next!: Promise<void>;
  act(() => { next = h.result.current.fetchMore(); void h.result.current.fetchMore(); });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].cursor, cursor(100));
  await act(async () => { h.calls[0].pending.resolve(page([100, 99], 99)); await next; });
  await waitFor(() => assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [100, 99]));
});

for (const firstPagePending of [false, true]) {
  test(`a delayed initial seed displays immediately ${firstPagePending ? 'despite a pending first-page fetch' : 'without another fetch'}`, async () => {
    const h = harness(null);
    await act(async () => {});
    assert.deepEqual(h.result.current.orders, []);
    assert.equal(h.calls.length, 0);
    let retry: Promise<void> | undefined;
    if (firstPagePending) {
      act(() => { retry = h.result.current.retry(); });
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].cursor, null);
    }

    h.rerender({ ...h.options, initialPage: page([100], 100), revision: 2 });
    await waitFor(() => assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [100]));
    assert.equal(h.calls.length, Number(firstPagePending));
    assert.equal(h.result.current.fetching, false);
    assert.equal(h.result.current.hasMore, true);

    if (firstPagePending) {
      await act(async () => { h.calls[0].pending.resolve(page([50])); await retry; });
    }
    assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [100]);
    assert.equal(h.result.current.hasMore, true);
    assert.equal(h.result.current.error, null);
    assert.equal(h.calls.length, Number(firstPagePending));
  });
}

test('refresh rebuilds retained pages sequentially with fresh cursors', async () => {
  const h = harness();
  await act(async () => {});
  let next!: Promise<void>;
  act(() => { next = h.result.current.fetchMore(); });
  await act(async () => { h.calls[0].pending.resolve(page([99], 99)); await next; });
  await waitFor(() => assert.equal(h.result.current.orders.length, 2));
  h.rerender({ ...h.options, revision: 2, initialPage: page([101], 101) });
  await waitFor(() => assert.equal(h.calls.length, 2));
  assert.equal(h.calls[1].cursor, null);
  assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [100, 99]);
  await act(async () => { h.calls[1].pending.resolve(page([101], 101)); });
  await waitFor(() => assert.equal(h.calls.length, 3));
  assert.deepEqual(h.calls[2].cursor, cursor(101));
  await act(async () => { h.calls[2].pending.resolve(page([100], 100)); });
  await waitFor(() => assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [101, 100]));
});

async function retainSecondPage(h: ReturnType<typeof harness>): Promise<void> {
  await act(async () => {});
  let next!: Promise<void>;
  act(() => { next = h.result.current.fetchMore(); });
  await act(async () => { h.calls[0].pending.resolve(page([99], 99)); await next; });
  await waitFor(() => assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [100, 99]));
}

test('overlapping revisions publish the active refresh before one trailing refresh', async () => {
  const h = harness();
  await retainSecondPage(h);
  h.rerender({ ...h.options, revision: 2, initialPage: page([101], 101) });
  await waitFor(() => assert.equal(h.calls.length, 2));
  assert.equal(h.calls[1].cursor, null);
  await act(async () => { h.calls[1].pending.resolve(page([101], 101)); });
  await waitFor(() => assert.equal(h.calls.length, 3));
  assert.deepEqual(h.calls[2].cursor, cursor(101));

  await act(async () => {
    h.rerender({ ...h.options, revision: 3, initialPage: page([102], 102) });
  });
  await act(async () => {
    h.rerender({ ...h.options, revision: 4, initialPage: page([103], 103) });
  });
  assert.equal(h.calls.length, 3);
  await act(async () => { h.calls[2].pending.resolve(page([100], 100)); });
  await waitFor(() => assert.equal(h.calls.length, 4));
  assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [101, 100]);
  assert.equal(h.calls[3].cursor, null);

  await act(async () => { h.calls[3].pending.resolve(page([103], 103)); });
  await waitFor(() => assert.equal(h.calls.length, 5));
  assert.deepEqual(h.calls[4].cursor, cursor(103));
  await act(async () => { h.calls[4].pending.resolve(page([102], 102)); });
  await waitFor(() => assert.equal(h.result.current.fetching, false));
  assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [103, 102]);
  assert.equal(h.calls.length, 5);
  assert.equal(h.result.current.error, null);
});

test('a revision waits for active continuation before rebuilding the retained pages', async () => {
  const h = harness();
  await act(async () => {});
  let next!: Promise<void>;
  act(() => { next = h.result.current.fetchMore(); });
  assert.equal(h.calls.length, 1);
  await act(async () => {
    h.rerender({ ...h.options, revision: 2, initialPage: page([101], 101) });
  });
  await act(async () => {
    h.rerender({ ...h.options, revision: 3, initialPage: page([102], 102) });
  });
  assert.equal(h.calls.length, 1);
  await act(async () => { h.calls[0].pending.resolve(page([99], 99)); await next; });
  await waitFor(() => assert.equal(h.calls.length, 2));
  assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [100, 99]);
  assert.equal(h.calls[1].cursor, null);
  await act(async () => { h.calls[1].pending.resolve(page([102], 102)); });
  await waitFor(() => assert.equal(h.calls.length, 3));
  assert.deepEqual(h.calls[2].cursor, cursor(102));
  await act(async () => { h.calls[2].pending.resolve(page([101], 101)); });
  await waitFor(() => assert.equal(h.result.current.fetching, false));
  assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [102, 101]);
  assert.equal(h.calls.length, 3);
});

for (const boundary of ['identity change', 'unmount'] as const) {
  test(`${boundary} discards a queued trailing refresh`, async () => {
    const h = harness();
    await retainSecondPage(h);
    h.rerender({ ...h.options, revision: 2, initialPage: page([101], 101) });
    await waitFor(() => assert.equal(h.calls.length, 2));
    await act(async () => {
      h.rerender({ ...h.options, revision: 3, initialPage: page([102], 102) });
    });
    assert.equal(h.calls.length, 2);
    if (boundary === 'identity change') {
      h.rerender({ ...h.options,
        identity: { authSubject: 'subject-b', sessionWallet: 'wallet-b', scope: 'wallet', owner: 'wallet-b' },
        initialPage: page([200]),
      });
    } else {
      h.unmount();
    }
    await act(async () => { h.calls[1].pending.resolve(page([101], 101)); });
    assert.equal(h.calls.length, 2);
    if (boundary === 'identity change') {
      await waitFor(() => assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [200]));
      assert.equal(h.client.getQueryCache().findAll({ queryKey: ['shipmentHistory'] }).length, 1);
    } else {
      assert.equal(h.client.getQueryCache().findAll({ queryKey: ['shipmentHistory'] }).length, 0);
    }
  });
}

test('a failed retained-page refresh settles and can retry without losing earlier data', async () => {
  const h = harness();
  await retainSecondPage(h);
  h.rerender({ ...h.options, revision: 2, initialPage: page([101], 101) });
  await waitFor(() => assert.equal(h.calls.length, 2));
  await act(async () => { h.calls[1].pending.resolve(page([101], 101)); });
  await waitFor(() => assert.equal(h.calls.length, 3));
  await act(async () => { h.calls[2].pending.reject(new Error('older history unavailable')); });
  await waitFor(() => assert.equal(h.result.current.fetching, false));
  assert.match(h.result.current.error?.message ?? '', /older history unavailable/);
  assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [100, 99]);

  let retry!: Promise<void>;
  act(() => { retry = h.result.current.retry(); });
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls[3].cursor, null);
  await act(async () => { h.calls[3].pending.resolve(page([102], 102)); });
  await waitFor(() => assert.equal(h.calls.length, 5));
  assert.deepEqual(h.calls[4].cursor, cursor(102));
  await act(async () => { h.calls[4].pending.resolve(page([101], 101)); await retry; });
  await waitFor(() => assert.equal(h.result.current.fetching, false));
  assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [102, 101]);
  assert.equal(h.result.current.error, null);
  assert.equal(h.calls.length, 5);
});

test('continuation failures retain data and retry the failed page', async () => {
  const h = harness();
  await act(async () => {});
  let next!: Promise<void>;
  act(() => { next = h.result.current.fetchMore(); });
  await act(async () => { h.calls[0].pending.reject(new Error('temporarily unavailable')); await next; });
  await waitFor(() => assert.ok(h.result.current.error));
  assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [100]);
  act(() => { next = h.result.current.retry(); });
  assert.deepEqual(h.calls[1].cursor, cursor(100));
  await act(async () => { h.calls[1].pending.resolve(page([99])); await next; });
  await waitFor(() => assert.equal(h.result.current.hasMore, false));
  assert.equal(h.result.current.error, null);
});

test('identity changes clear prior pages and ignore stale responses', async () => {
  const h = harness();
  await act(async () => {});
  let old!: Promise<void>;
  act(() => { old = h.result.current.fetchMore(); });
  h.rerender({
    ...h.options,
    identity: { authSubject: 'subject-b', sessionWallet: 'wallet-b', scope: 'wallet', owner: 'wallet-b' },
    initialPage: page([200]),
  });
  await act(async () => { h.calls[0].pending.resolve(page([99])); await old; });
  await waitFor(() => assert.deepEqual(h.result.current.orders.map((order) => order.deliveryId), [200]));
  assert.equal(h.client.getQueryCache().findAll({ queryKey: ['shipmentHistory'] }).length, 1);
  h.rerender({ ...h.options, identity: null, initialPage: undefined });
  assert.deepEqual(h.result.current.orders, []);
});

test('empty filtered pages remain pageable and repeated cursors stop loading', async () => {
  const h = harness(page([], 100));
  await act(async () => {});
  assert.equal(h.result.current.hasMore, true);
  let next!: Promise<void>;
  act(() => { next = h.result.current.fetchMore(); });
  await act(async () => { h.calls[0].pending.resolve(page([], 99)); await next; });
  await waitFor(() => assert.equal(h.result.current.fetching, false));
  act(() => { next = h.result.current.fetchMore(); });
  await act(async () => { h.calls[1].pending.resolve(page([], 99)); await next; });
  await waitFor(() => assert.match(h.result.current.error?.message ?? '', /did not advance/));
});

test('scroll sentinel loads automatically, pauses on errors and offers retry', async () => {
  let intersect: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
  let disconnected = 0;
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(callback: typeof intersect, options: { rootMargin: string }) {
      intersect = callback;
      assert.equal(options.rootMargin, '400px');
    }
    observe() {}
    disconnect() { disconnected += 1; }
  } });
  let more = 0;
  let retried = 0;
  const props = {
    hasMore: true, fetching: false, loadingMore: false, error: null as Error | null,
    fetchMore: async () => { more += 1; }, retry: async () => { retried += 1; },
  };
  const view = render(createElement(ShipmentHistoryContinuation, props));
  await act(async () => { intersect?.([{ isIntersecting: true }]); });
  assert.equal(more, 1);
  view.rerender(createElement(ShipmentHistoryContinuation, { ...props, error: new Error('offline') }));
  assert.equal(disconnected, 1);
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Retry' })); });
  assert.equal(retried, 1);
  view.rerender(createElement(ShipmentHistoryContinuation, { ...props, hasMore: false }));
  assert.equal(view.container.textContent, '');
});
