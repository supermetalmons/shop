import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import type { FulfillmentManualReviewCheckout, FulfillmentOrder, FulfillmentOrdersCursor } from '../src/types.ts';
import { setupFrontendDom } from './helpers/frontendDom.ts';

setupFrontendDom();

const { act, cleanup, renderHook } = await import('@testing-library/react');
const { useFulfillmentOrders } = await import('../src/fulfillment/useFulfillmentOrders.ts');

type Options = Parameters<typeof useFulfillmentOrders>[0];
type Api = NonNullable<Parameters<typeof useFulfillmentOrders>[1]>;
type OrdersResponse = Awaited<ReturnType<Api['listFulfillmentOrders']>>;
type ReviewResponse = Awaited<ReturnType<Api['listFulfillmentManualReviewCheckouts']>>;

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function createApi(deferReviews = false) {
  const orderCalls: Array<{
    args: Parameters<Api['listFulfillmentOrders']>[0];
    pending: ReturnType<typeof deferred<OrdersResponse>>;
  }> = [];
  const reviewCalls: Array<{
    args: Parameters<Api['listFulfillmentManualReviewCheckouts']>[0];
    pending: ReturnType<typeof deferred<ReviewResponse>>;
  }> = [];
  const api: Api = {
    listFulfillmentOrders(args) {
      const pending = deferred<OrdersResponse>();
      orderCalls.push({ args, pending });
      return pending.promise;
    },
    listFulfillmentManualReviewCheckouts(args) {
      const pending = deferred<ReviewResponse>();
      reviewCalls.push({ args, pending });
      if (!deferReviews) pending.resolve({ checkouts: [] });
      return pending.promise;
    },
  };
  return { api, orderCalls, reviewCalls };
}

function options(overrides: Partial<Options> = {}): Options {
  return {
    walletAddress: 'wallet-a',
    enabled: true,
    dropIds: ['drop-a'],
    onReset: () => undefined,
    onOrdersLoaded: () => undefined,
    ...overrides,
  };
}

function order(dropId: string, deliveryId: number, createdAt = deliveryId): FulfillmentOrder {
  return {
    dropId,
    deliveryId,
    owner: `owner-${deliveryId}`,
    status: 'processed',
    fulfillmentStatus: 'Preparing',
    createdAt,
    address: { full: `Owner ${deliveryId}\n${deliveryId} Main Street` },
    boxes: [],
    looseDudes: [],
  };
}

function checkout(dropId: string, sessionId: string, failedAt: number): FulfillmentManualReviewCheckout {
  return { dropId, sessionId, failedAt, owner: `owner-${sessionId}`, address: {} };
}

function cursor(id: string): FulfillmentOrdersCursor {
  return { id, processedAt: { seconds: 100, nanos: 0 } };
}

function keys(orders: readonly FulfillmentOrder[]): string[] {
  return orders.map((entry) => `${entry.dropId}:${entry.deliveryId}`);
}

function mount(initialProps: Options, api: Api, strict = false) {
  return renderHook((props: Options) => useFulfillmentOrders(props, api), {
    initialProps,
    reactStrictMode: strict,
  });
}

test('initial load sorts and deduplicates every drop while manual-review failure stays optional', async (t) => {
  const { api, orderCalls, reviewCalls } = createApi(true);
  const onReset = t.mock.fn();
  const onOrdersLoaded = t.mock.fn();
  const warning = t.mock.method(console, 'warn', () => undefined);
  const { result } = mount(options({ dropIds: ['drop-b', 'drop-a', 'drop-c'], onReset, onOrdersLoaded }), api);

  assert.equal(result.current.loading, true);
  assert.equal(onReset.mock.callCount(), 1);
  assert.deepEqual(orderCalls.map(({ args }) => args.dropId), ['drop-b', 'drop-a', 'drop-c']);
  assert.ok(orderCalls.every(({ args }) => args.cursor === null));
  await act(async () => {
    orderCalls[0].pending.resolve({ orders: [order('drop-b', 1, 100), order('drop-b', 2, 400)] });
    orderCalls[1].pending.resolve({ orders: [order('drop-a', 1, 200), order('drop-a', 2, 200), order('drop-a', 1, 999)] });
    orderCalls[2].pending.resolve({ orders: [] });
    reviewCalls[0].pending.resolve({ checkouts: [checkout('drop-b', 'same-session', 200)] });
    reviewCalls[1].pending.resolve({ checkouts: [checkout('drop-a', 'same-session', 300), checkout('drop-a', 'old', 100), checkout('drop-a', 'old', 900)] });
    reviewCalls[2].pending.reject(new Error('Manual review unavailable'));
  });

  const expected = ['drop-b:2', 'drop-a:2', 'drop-a:1', 'drop-b:1'];
  assert.deepEqual(keys(result.current.orders), expected);
  assert.deepEqual(result.current.orderPageKeys, [expected]);
  assert.deepEqual(result.current.manualReviewCheckouts.map((entry) => `${entry.dropId}:${entry.sessionId}`), [
    'drop-a:same-session', 'drop-b:same-session', 'drop-a:old',
  ]);
  assert.equal(result.current.ordersError, null);
  assert.equal(result.current.loading, false);
  assert.equal(result.current.hasMore, false);
  assert.equal(onOrdersLoaded.mock.callCount(), 1);
  assert.deepEqual(keys(onOrdersLoaded.mock.calls[0].arguments[0]), expected);
  assert.equal(warning.mock.callCount(), 1);
});

test('pagination uses remaining drop cursors, prevents overlap, and preserves page boundaries and local edits', async (t) => {
  const { api, orderCalls, reviewCalls } = createApi();
  const onReset = t.mock.fn();
  const onOrdersLoaded = t.mock.fn();
  const initial = options({ dropIds: ['drop-a', 'drop-b'], onReset, onOrdersLoaded });
  const { result, rerender } = mount(initial, api);
  await act(async () => { await result.current.loadMore(); });
  assert.equal(orderCalls.length, 2);
  await act(async () => {
    orderCalls[0].pending.resolve({ orders: [order('drop-a', 1, 300)], nextCursor: cursor('a-next') });
    orderCalls[1].pending.resolve({ orders: [order('drop-b', 1, 200)], nextCursor: null });
  });
  rerender({ ...initial, dropIds: [...initial.dropIds] });
  assert.equal(onReset.mock.callCount(), 1);
  assert.equal(orderCalls.length, 2);

  let page!: Promise<void>;
  act(() => {
    const loadMore = result.current.loadMore;
    page = loadMore();
    void loadMore();
  });
  assert.equal(result.current.loadingMore, true);
  assert.equal(orderCalls.length, 3);
  assert.equal(orderCalls[2].args.dropId, 'drop-a');
  assert.deepEqual(orderCalls[2].args.cursor, cursor('a-next'));
  act(() => result.current.updateOrder('drop-a:1', (current) => ({
    ...current,
    fulfillmentStatus: 'Shipped',
    shipstationShipmentId: 'shipment-local',
    address: { ...current.address, full: 'Corrected address' },
  })));
  await act(async () => {
    orderCalls[2].pending.resolve({
      orders: [order('drop-a', 1, 300), order('drop-a', 2, 500), order('drop-a', 2, 999)],
      nextCursor: cursor('a-final'),
    });
    await page;
  });
  assert.deepEqual(keys(result.current.orders), ['drop-a:1', 'drop-b:1', 'drop-a:2']);
  assert.deepEqual(result.current.orderPageKeys, [['drop-a:1', 'drop-b:1'], ['drop-a:2']]);
  assert.equal(result.current.orders[0].fulfillmentStatus, 'Shipped');
  assert.equal(result.current.orders[0].shipstationShipmentId, 'shipment-local');
  assert.equal(result.current.orders[0].address.full, 'Corrected address');
  assert.deepEqual(keys(onOrdersLoaded.mock.calls[1].arguments[0]), ['drop-a:2']);
  assert.equal(onReset.mock.callCount(), 1);
  assert.equal(reviewCalls.length, 2);

  act(() => { page = result.current.loadMore(); });
  assert.deepEqual(orderCalls[3].args.cursor, cursor('a-final'));
  await act(async () => {
    orderCalls[3].pending.resolve({ orders: [order('drop-a', 2)], nextCursor: null });
    await page;
  });
  assert.equal(result.current.hasMore, false);
  assert.equal(result.current.loadingMore, false);
  assert.deepEqual(result.current.orderPageKeys, [['drop-a:1', 'drop-b:1'], ['drop-a:2']]);
  assert.equal(onOrdersLoaded.mock.callCount(), 2);
  await act(async () => { await result.current.loadMore(); });
  assert.equal(orderCalls.length, 4);
});

test('a failed pagination batch retains all rows and cursors for retry', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { api, orderCalls } = createApi();
  const loaded = t.mock.fn();
  const { result } = mount(options({ dropIds: ['drop-a', 'drop-b'], onOrdersLoaded: loaded }), api);
  await act(async () => {
    orderCalls[0].pending.resolve({ orders: [order('drop-a', 1)], nextCursor: cursor('a-next') });
    orderCalls[1].pending.resolve({ orders: [order('drop-b', 1)], nextCursor: cursor('b-next') });
  });
  const originalOrders = result.current.orders;
  const originalPages = result.current.orderPageKeys;
  let page!: Promise<void>;
  act(() => { page = result.current.loadMore(); });
  await act(async () => {
    orderCalls[2].pending.resolve({ orders: [order('drop-a', 2)], nextCursor: null });
    orderCalls[3].pending.reject(new Error('Orders unavailable'));
    await page;
  });
  assert.equal(result.current.orders, originalOrders);
  assert.equal(result.current.orderPageKeys, originalPages);
  assert.equal(result.current.ordersError, 'Orders unavailable');
  assert.equal(result.current.loadingMore, false);
  assert.equal(result.current.hasMore, true);
  assert.equal(loaded.mock.callCount(), 1);

  act(() => { page = result.current.loadMore(); });
  assert.equal(result.current.ordersError, null);
  assert.deepEqual(orderCalls.slice(4).map(({ args }) => [args.dropId, args.cursor]), [
    ['drop-a', cursor('a-next')], ['drop-b', cursor('b-next')],
  ]);
  await act(async () => {
    orderCalls[4].pending.resolve({ orders: [order('drop-a', 2)], nextCursor: null });
    orderCalls[5].pending.resolve({ orders: [order('drop-b', 2)], nextCursor: null });
    await page;
  });
  assert.equal(result.current.orders.length, 4);
  assert.equal(result.current.hasMore, false);
  assert.equal(result.current.ordersError, null);
});

for (const scope of ['wallet', 'drop', 'access'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    test(`${scope} changes ignore stale initial ${outcome} and completion`, async (t) => {
      t.mock.method(console, 'error', () => undefined);
      const { api, orderCalls } = createApi();
      const loaded = t.mock.fn();
      const reset = t.mock.fn();
      const initial = options({ onOrdersLoaded: loaded, onReset: reset });
      const { result, rerender } = mount(initial, api);
      const oldGuard = result.current.isCurrentScope;
      const next = {
        ...initial,
        ...(scope === 'wallet' ? { walletAddress: 'wallet-b' } : {}),
        ...(scope === 'drop' ? { dropIds: ['drop-b'] } : {}),
        ...(scope === 'access' ? { enabled: false } : {}),
      };
      rerender(next);
      assert.equal(oldGuard(), false);
      assert.equal(reset.mock.callCount(), 2);
      await act(async () => {
        if (outcome === 'success') orderCalls[0].pending.resolve({ orders: [order('drop-a', 99)], nextCursor: cursor('old') });
        else orderCalls[0].pending.reject(new Error('Old request failed'));
      });
      assert.deepEqual(result.current.orders, []);
      assert.deepEqual(result.current.orderPageKeys, []);
      assert.equal(result.current.ordersError, null);
      assert.equal(result.current.loading, scope !== 'access');
      assert.equal(loaded.mock.callCount(), 0);
      if (scope === 'access') {
        assert.equal(result.current.hasMore, false);
        assert.equal(result.current.isCurrentScope(), false);
        assert.equal(orderCalls.length, 1);
        return;
      }
      await act(async () => {
        orderCalls[1].pending.resolve({ orders: [order(next.dropIds[0], 1)], nextCursor: null });
      });
      assert.deepEqual(keys(result.current.orders), [`${next.dropIds[0]}:1`]);
      assert.equal(result.current.loading, false);
      assert.equal(loaded.mock.callCount(), 1);
    });
  }
}

test('old pagination cannot change a new scope or release its active pagination lock', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { api, orderCalls } = createApi();
  const initial = options();
  const { result, rerender } = mount(initial, api);
  await act(async () => { orderCalls[0].pending.resolve({ orders: [order('drop-a', 1)], nextCursor: cursor('old') }); });
  let oldPage!: Promise<void>;
  act(() => { oldPage = result.current.loadMore(); });
  rerender({ ...initial, walletAddress: 'wallet-b' });
  await act(async () => { orderCalls[2].pending.resolve({ orders: [order('drop-a', 2)], nextCursor: cursor('new') }); });
  let newPage!: Promise<void>;
  act(() => { newPage = result.current.loadMore(); });
  await act(async () => {
    orderCalls[1].pending.reject(new Error('Old page failed'));
    await oldPage;
  });
  assert.equal(result.current.loadingMore, true);
  assert.equal(result.current.ordersError, null);
  assert.deepEqual(keys(result.current.orders), ['drop-a:2']);
  act(() => { void result.current.loadMore(); });
  assert.equal(orderCalls.length, 4);
  await act(async () => {
    orderCalls[3].pending.resolve({ orders: [order('drop-a', 3)], nextCursor: null });
    await newPage;
  });
  assert.deepEqual(keys(result.current.orders), ['drop-a:2', 'drop-a:3']);
  assert.equal(result.current.loadingMore, false);
});

test('captured guards and setters reject old writes even when the same wallet returns', async () => {
  const { api, orderCalls } = createApi();
  const initial = options();
  const { result, rerender, unmount } = mount(initial, api);
  await act(async () => { orderCalls[0].pending.resolve({ orders: [order('drop-a', 1)] }); });
  const old = result.current;
  rerender({ ...initial, walletAddress: 'wallet-b' });
  rerender(initial);
  await act(async () => { orderCalls[2].pending.resolve({ orders: [order('drop-a', 1)] }); });
  assert.equal(old.isCurrentScope(), false);
  let staleParentWrites = 0;
  act(() => {
    old.updateOrder('drop-a:1', (current) => ({ ...current, fulfillmentStatus: 'Shipped' }));
    old.updateOrder('drop-a:1', (current) => ({ ...current, address: { full: 'Stale address' } }));
    old.updateOrder('drop-a:1', (current) => ({ ...current, shipstationShipmentId: 'stale-shipment' }));
    old.setOrdersError('Stale error');
    if (old.isCurrentScope()) staleParentWrites += 1;
  });
  assert.equal(staleParentWrites, 0);
  assert.equal(result.current.orders[0].fulfillmentStatus, 'Preparing');
  assert.equal(result.current.orders[0].address.full, 'Owner 1\n1 Main Street');
  assert.equal(result.current.orders[0].shipstationShipmentId, undefined);
  assert.equal(result.current.ordersError, null);
  act(() => {
    result.current.updateOrder('drop-a:1', (current) => ({ ...current, shipstationShipmentId: 'current-shipment' }));
    result.current.setOrdersError('Current error');
  });
  assert.equal(result.current.orders[0].shipstationShipmentId, 'current-shipment');
  assert.equal(result.current.ordersError, 'Current error');
  const currentGuard = result.current.isCurrentScope;
  unmount();
  assert.equal(currentGuard(), false);
  await act(async () => { orderCalls[1].pending.resolve({ orders: [order('drop-a', 99)] }); });
});

test('reset and loaded callbacks support parent drafts without resetting them during pagination', async () => {
  const { api, orderCalls } = createApi();
  let drafts: Record<string, string> = { 'stale:1': 'Old draft' };
  let activeEditor: string | null = 'stale:1';
  const initial = options({
    onReset() { drafts = {}; activeEditor = null; },
    onOrdersLoaded(incoming) {
      for (const entry of incoming) drafts[`${entry.dropId}:${entry.deliveryId}`] ??= entry.fulfillmentStatus || '';
    },
  });
  const { result, rerender } = mount(initial, api);
  assert.deepEqual(drafts, {});
  assert.equal(activeEditor, null);
  await act(async () => { orderCalls[0].pending.resolve({ orders: [order('drop-a', 1)], nextCursor: cursor('next') }); });
  drafts['drop-a:1'] = 'Unsaved draft';
  activeEditor = 'drop-a:1';
  let page!: Promise<void>;
  act(() => { page = result.current.loadMore(); });
  await act(async () => {
    orderCalls[1].pending.resolve({ orders: [order('drop-a', 1), order('drop-a', 2)] });
    await page;
  });
  assert.deepEqual(drafts, { 'drop-a:1': 'Unsaved draft', 'drop-a:2': 'Preparing' });
  assert.equal(activeEditor, 'drop-a:1');
  rerender({ ...initial, enabled: false });
  assert.deepEqual(drafts, {});
  assert.equal(activeEditor, null);
});

test('StrictMode cleanup invalidates its first request while the replacement stays active', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { api, orderCalls } = createApi();
  const loaded = t.mock.fn();
  const { result, unmount } = mount(options({ onOrdersLoaded: loaded }), api, true);
  assert.equal(orderCalls.length, 2);
  await act(async () => { orderCalls[0].pending.reject(new Error('Discarded StrictMode request')); });
  assert.equal(result.current.loading, true);
  assert.equal(result.current.ordersError, null);
  assert.equal(result.current.isCurrentScope(), true);
  await act(async () => { orderCalls[1].pending.resolve({ orders: [order('drop-a', 1)] }); });
  assert.deepEqual(keys(result.current.orders), ['drop-a:1']);
  assert.equal(result.current.loading, false);
  assert.equal(loaded.mock.callCount(), 1);
  const guard = result.current.isCurrentScope;
  unmount();
  assert.equal(guard(), false);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`unmount ignores late ${outcome} without notifying the parent`, async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const { api, orderCalls } = createApi();
    const loaded = t.mock.fn();
    const reset = t.mock.fn();
    const { result, unmount } = mount(options({ onOrdersLoaded: loaded, onReset: reset }), api);
    const guard = result.current.isCurrentScope;
    unmount();
    await act(async () => {
      if (outcome === 'success') orderCalls[0].pending.resolve({ orders: [order('drop-a', 1)] });
      else orderCalls[0].pending.reject(new Error('Unmounted request'));
    });
    assert.equal(guard(), false);
    assert.equal(loaded.mock.callCount(), 0);
    assert.equal(reset.mock.callCount(), 1);
  });
}
