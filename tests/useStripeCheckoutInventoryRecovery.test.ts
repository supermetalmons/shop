import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useStripeCheckoutInventoryRecovery } from '../src/hooks/useStripeCheckoutInventoryRecovery.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

const { act, cleanup, renderHook } = await import('@testing-library/react');
afterEach(() => cleanup());

type Options = Parameters<typeof useStripeCheckoutInventoryRecovery>[0];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function options(owner = 'wallet-a'): Options {
  return {
    recoveredProfile: { owner, key: `auth:${owner}:checkout` },
    owner,
    inventoryDataUpdatedAt: 100,
    inventoryFetched: true,
    inventoryFetching: false,
  };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(
    QueryClientProvider,
    { client },
    children,
  );
}

test('checkout inventory refresh is shared across StrictMode effects and settles before pending boxes', async (t) => {
  const client = new QueryClient();
  const inventory = deferred();
  const boxes = deferred();
  const invalidate = t.mock.method(client, 'invalidateQueries', (filters: { queryKey: readonly string[] }) => {
    assert.equal(filters.queryKey[1], 'wallet-a');
    return filters.queryKey[0] === 'inventory' ? inventory.promise : boxes.promise;
  });
  const initialProps = options();
  const { result, rerender } = renderHook(useStripeCheckoutInventoryRecovery, {
    initialProps,
    wrapper: wrapper(client),
    reactStrictMode: true,
  });
  assert.equal(result.current, true);
  assert.equal(invalidate.mock.callCount(), 2);

  rerender({ ...initialProps, inventoryFetching: true });
  assert.equal(invalidate.mock.callCount(), 2);
  await act(async () => inventory.resolve());
  assert.equal(result.current, false);
  await act(async () => boxes.resolve());
  assert.equal(invalidate.mock.callCount(), 2);
});

test('failed refresh keeps inventory pending until a newer matching query response arrives', async (t) => {
  const client = new QueryClient();
  const inventory = deferred();
  t.mock.method(console, 'warn', () => undefined);
  t.mock.method(client, 'invalidateQueries', (filters: { queryKey: readonly string[] }) =>
    filters.queryKey[0] === 'inventory' ? inventory.promise : Promise.resolve(),
  );
  const initialProps = options();
  const { result, rerender } = renderHook(useStripeCheckoutInventoryRecovery, {
    initialProps,
    wrapper: wrapper(client),
    reactStrictMode: true,
  });
  await act(async () => inventory.reject(new Error('Inventory temporarily unavailable')));
  assert.equal(result.current, true);

  rerender({ ...initialProps, inventoryFetching: true, inventoryDataUpdatedAt: 101 });
  assert.equal(result.current, true);
  rerender({ ...initialProps, inventoryFetched: false, inventoryDataUpdatedAt: 101 });
  assert.equal(result.current, true);
  rerender({ ...initialProps, inventoryDataUpdatedAt: 101 });
  assert.equal(result.current, false);
});

test('a late refresh for a previous wallet cannot settle the current wallet recovery', async (t) => {
  const client = new QueryClient();
  const first = deferred();
  const second = deferred();
  t.mock.method(client, 'invalidateQueries', (filters: { queryKey: readonly string[] }) => {
    if (filters.queryKey[0] !== 'inventory') return Promise.resolve();
    return filters.queryKey[1] === 'wallet-a' ? first.promise : second.promise;
  });
  const { result, rerender } = renderHook(useStripeCheckoutInventoryRecovery, {
    initialProps: options(),
    wrapper: wrapper(client),
    reactStrictMode: true,
  });
  rerender(options('wallet-b'));
  await act(async () => first.resolve());
  assert.equal(result.current, true);
  await act(async () => second.resolve());
  assert.equal(result.current, false);
});

test('unmount cancels a scheduled inventory retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new QueryClient();
  t.mock.method(console, 'warn', () => undefined);
  const invalidate = t.mock.method(client, 'invalidateQueries', (filters: { queryKey: readonly string[] }) =>
    filters.queryKey[0] === 'inventory'
      ? Promise.reject(new Error('Inventory temporarily unavailable'))
      : Promise.resolve(),
  );
  const { result, unmount } = renderHook(useStripeCheckoutInventoryRecovery, {
    initialProps: options(),
    wrapper: wrapper(client),
    reactStrictMode: true,
  });
  await act(async () => undefined);
  assert.equal(result.current, true);
  assert.equal(invalidate.mock.callCount(), 2);
  unmount();
  await act(async () => t.mock.timers.tick(5_000));
  assert.equal(invalidate.mock.callCount(), 2);
});
