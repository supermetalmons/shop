import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createElement } from 'react';
import { JSDOM } from 'jsdom';
import { setupFrontendDom } from './helpers/frontendDom.ts';
import { resolveEthereum111kConfig } from '../shared/ethereum/config.ts';
import { ethereumAssetId, type EthereumInventoryItem } from '../shared/ethereum/protocol.ts';
import type { EthereumCheckoutStatusResponse } from '../shared/ethereum/checkout.ts';

let { dom } = setupFrontendDom();
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { checkoutApi } = await import('../src/checkout/api.ts');
const { checkoutReservesItems, observeCheckoutReservation, persistCheckoutReservation, rememberCheckoutReservation, useCheckoutReservations } =
  await import('../src/ethereum/checkoutReservations.ts');
dom.window.close();

const prefix = 'mons.shop.ethereum-checkout-reservation:';
const checkoutId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const owner = '0x1111111111111111111111111111111111111111';
const contract = '0x3333333333333333333333333333333333333333';
const config = resolveEthereum111kConfig({ contractAddress: contract });
const clients: InstanceType<typeof QueryClient>[] = [];
const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function item(tokenId = '111112'): EthereumInventoryItem {
  return { id: ethereumAssetId(config.chainId, contract, tokenId), chainId: config.chainId, contractAddress: contract,
    owner, tokenId, kind: 'crate', displayId: 1, name: 'Crate #1', image: 'data:image/svg+xml,%3Csvg/%3E' };
}

function checkout(overrides: Partial<EthereumCheckoutStatusResponse> = {}): EthereumCheckoutStatusResponse {
  return { checkoutId, dropId: '111k_devnet', chainId: config.chainId, contractAddress: contract, config,
    tokenIds: ['111112'], items: [item()], unavailableTokenIds: [], wallet: owner, status: 'pending', orderId: 42,
    transactionHash: null, confirmations: 0, requiredConfirmations: 3, quoteExpiresAtMs: Date.now() + 60_000,
    attempt: { attemptId, status: 'started', transactionHash: null }, ...overrides };
}

function storedKeys(): string[] {
  return Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index)!)
    .filter(key => key.startsWith(prefix)).sort();
}

function seed(value: EthereumCheckoutStatusResponse, revision?: string): string {
  const key = `${prefix}${value.checkoutId}:${value.attempt?.attemptId ?? 'unknown'}${revision ? `:${revision}` : ''}`;
  window.localStorage.setItem(key, JSON.stringify({ checkoutId: value.checkoutId, chainId: value.chainId,
    contractAddress: value.contractAddress, wallet: value.wallet, tokenIds: value.tokenIds,
    attemptId: value.attempt?.attemptId ?? null, ...(revision ? { revision } : {}) }));
  return key;
}

function inFreshWindow(check: () => void): void {
  const original = window;
  const fresh = new JSDOM('', { url: original.location.href });
  Object.defineProperty(fresh.window, 'localStorage', { value: original.localStorage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fresh.window });
  try { check(); }
  finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
    fresh.window.close();
  }
}

beforeEach(() => { ({ dom } = setupFrontendDom()); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); dom.window.close(); });

test('a reservation remains visible when another tab rotates it during a snapshot', t => {
  rememberCheckoutReservation(checkout());
  const [oldKey] = storedKeys();
  const prototype = Object.getPrototypeOf(window.localStorage);
  const get = prototype.getItem;
  let rotated = false;
  t.mock.method(prototype, 'getItem', function (this: Storage, key: string) {
    if (key === oldKey && !rotated) {
      rotated = true;
      observeCheckoutReservation(checkoutId)(checkout());
    }
    return get.call(this, key);
  });
  assert.equal(checkoutReservesItems([item()]), true);
  assert.equal(rotated, true);
  assert.equal(storedKeys().length, 1);
  assert.notEqual(storedKeys()[0], oldKey);
});

test('continuous reservation rotation fails closed and recovers when storage settles', t => {
  rememberCheckoutReservation(checkout());
  const prototype = Object.getPrototypeOf(window.localStorage);
  const get = prototype.getItem;
  let rotations = 0;
  let rotating = false;
  t.mock.method(prototype, 'getItem', function (this: Storage, key: string) {
    if (key.startsWith(prefix) && rotations < 3 && !rotating) {
      rotating = true;
      rotations++;
      observeCheckoutReservation(checkoutId)(checkout());
      rotating = false;
    }
    return get.call(this, key);
  });
  assert.equal(checkoutReservesItems([item('111113')]), true);
  assert.equal(rotations, 3);
  assert.equal(checkoutReservesItems([item('111113')]), false);
  assert.equal(checkoutReservesItems([item()]), true);
  rotations = 0;
  const next = checkout({ checkoutId: id(1000), tokenIds: ['111113'], items: [item('111113')] });
  assert.equal(rememberCheckoutReservation(next), false);
  assert.equal(rotations, 3);
  assert.equal(storedKeys().length, 1);
  assert.equal(rememberCheckoutReservation(next), true);
  assert.equal(checkoutReservesItems(next.items), true);
});

test('terminal cleanup cannot delete a pending revision written immediately before removeItem', t => {
  rememberCheckoutReservation(checkout());
  const [oldKey] = storedKeys();
  const observe = observeCheckoutReservation(checkoutId);
  const prototype = Object.getPrototypeOf(window.localStorage);
  const remove = prototype.removeItem;
  let injected = false;
  t.mock.method(prototype, 'removeItem', function (this: Storage, key: string) {
    if (key === oldKey && !injected) {
      injected = true;
      rememberCheckoutReservation(checkout(), true);
    }
    remove.call(this, key);
  });
  observe(checkout({ status: 'failed' }));
  assert.equal(injected, true);
  assert.equal(checkoutReservesItems([item()]), true);
  assert.equal(storedKeys().length, 1);
  assert.notEqual(storedKeys()[0], oldKey);
});

test('pending cleanup preserves a concurrent revision and the next observation compacts both', t => {
  rememberCheckoutReservation(checkout());
  const [oldKey] = storedKeys();
  const observe = observeCheckoutReservation(checkoutId);
  const prototype = Object.getPrototypeOf(window.localStorage);
  const remove = prototype.removeItem;
  let concurrentKey: string | undefined;
  t.mock.method(prototype, 'removeItem', function (this: Storage, key: string) {
    if (key === oldKey && !concurrentKey) {
      const before = new Set(storedKeys());
      rememberCheckoutReservation(checkout(), true);
      concurrentKey = storedKeys().find(candidate => !before.has(candidate));
    }
    remove.call(this, key);
  });
  observe(checkout());
  assert.ok(concurrentKey);
  assert.ok(window.localStorage.getItem(concurrentKey));
  assert.equal(storedKeys().length, 2);
  assert.equal(checkoutReservesItems([item()]), true);
  observeCheckoutReservation(checkoutId)(checkout());
  assert.equal(storedKeys().length, 1);
  assert.equal(window.localStorage.getItem(concurrentKey), null);
  assert.equal(checkoutReservesItems([item()]), true);
});

test('terminal responses retire only the revisions captured before their request', () => {
  rememberCheckoutReservation(checkout());
  const observe = observeCheckoutReservation(checkoutId);
  rememberCheckoutReservation(checkout(), true);
  observe(checkout({ status: 'success', confirmations: 3 }));
  assert.equal(storedKeys().length, 1);
  assert.equal(checkoutReservesItems([item()]), true);
  observeCheckoutReservation(checkoutId)(checkout({ status: 'success', confirmations: 3 }));
  assert.deepEqual(storedKeys(), []);
  assert.equal(checkoutReservesItems([item()]), false);
});

test('legacy keys remain readable and migrate without letting stale cleanup remove the new revision', () => {
  const legacyKey = seed(checkout());
  assert.equal(checkoutReservesItems([item()]), true);
  const stale = observeCheckoutReservation(checkoutId);
  observeCheckoutReservation(checkoutId)(checkout());
  assert.equal(window.localStorage.getItem(legacyKey), null);
  assert.equal(storedKeys().length, 1);
  assert.ok(storedKeys()[0].startsWith(`${legacyKey}:`));
  stale(checkout({ status: 'failed' }));
  assert.equal(checkoutReservesItems([item()]), true);
  observeCheckoutReservation(checkoutId)(checkout({ status: 'failed' }));
  assert.equal(checkoutReservesItems([item()]), false);
  seed(checkout());
  observeCheckoutReservation(checkoutId)(checkout({ status: 'failed' }));
  assert.deepEqual(storedKeys(), []);
});

test('capacity counts logical reservations while every persisted revision remains visible', () => {
  for (let revision = 0; revision < 150; revision++) seed(checkout(), id(revision));
  const last = checkout({ checkoutId: id(1000), tokenIds: ['111113'], items: [item('111113')] });
  assert.equal(rememberCheckoutReservation(last), true);
  assert.equal(checkoutReservesItems(last.items), true);
  for (let index = 0; index < 126; index++) assert.equal(rememberCheckoutReservation(checkout({ checkoutId: id(index) })), true);
  assert.equal(rememberCheckoutReservation(checkout({ checkoutId: id(1001) })), false);
  assert.equal(rememberCheckoutReservation(last, true), true);
  assert.equal(checkoutReservesItems(last.items), true);
  observeCheckoutReservation(checkoutId)(checkout());
  assert.equal(storedKeys().filter(key => key.startsWith(`${prefix}${checkoutId}:`)).length, 1);
});

test('memory fallback keeps revisions independent when storage writes and removals fail', t => {
  const prototype = Object.getPrototypeOf(window.localStorage);
  t.mock.method(prototype, 'setItem', () => { throw new Error('Storage unavailable'); });
  t.mock.method(prototype, 'removeItem', () => { throw new Error('Storage unavailable'); });
  assert.equal(rememberCheckoutReservation(checkout()), true);
  const stale = observeCheckoutReservation(checkoutId);
  observeCheckoutReservation(checkoutId)(checkout());
  stale(checkout({ status: 'failed' }));
  assert.equal(checkoutReservesItems([item()]), true);
  observeCheckoutReservation(checkoutId)(checkout({ status: 'failed' }));
  assert.equal(checkoutReservesItems([item()]), false);
});

test('a rejected retry clears older observed reservations after failed storage writes', t => {
  rememberCheckoutReservation(checkout());
  const stale = observeCheckoutReservation(checkoutId);
  const prototype = Object.getPrototypeOf(window.localStorage);
  const set = t.mock.method(prototype, 'setItem', () => { throw new Error('Storage full'); });
  const rejected = (attempt: string) => checkout({ status: 'prepared',
    attempt: { attemptId: attempt, status: 'rejected', transactionHash: null } });
  observeCheckoutReservation(checkoutId)(checkout());
  stale(rejected(attemptId));
  assert.equal(checkoutReservesItems([item()]), true);
  inFreshWindow(() => assert.equal(checkoutReservesItems([item()]), true));
  const retry = checkout({ attempt: { attemptId: id(2), status: 'started', transactionHash: null } });
  observeCheckoutReservation(checkoutId)(retry);
  assert.equal(persistCheckoutReservation(retry), false);
  observeCheckoutReservation(checkoutId)(rejected(id(2)));
  set.mock.restore();
  observeCheckoutReservation(checkoutId)(rejected(id(2)));
  assert.deepEqual(storedKeys(), []);
  assert.equal(checkoutReservesItems([item()]), false);
  inFreshWindow(() => {
    observeCheckoutReservation(checkoutId)(rejected(id(2)));
    assert.equal(checkoutReservesItems([item()]), false);
  });
});

test('a stale rejection cannot clear a newer attempt reservation', () => {
  rememberCheckoutReservation(checkout());
  const stale = observeCheckoutReservation(checkoutId);
  const retry = checkout({ attempt: { attemptId: id(2), status: 'started', transactionHash: null } });
  observeCheckoutReservation(checkoutId)(retry);
  stale(checkout({ status: 'prepared', attempt: { attemptId, status: 'rejected', transactionHash: null } }));
  assert.equal(checkoutReservesItems([item()]), true);
  assert.equal(storedKeys().length, 1);
  assert.ok(storedKeys()[0].includes(id(2)));
});

for (const failure of ['throw', 'silent', 'readback'] as const) test(`a failed replacement (${failure}) preserves the durable reservation until storage recovers`, t => {
  rememberCheckoutReservation(checkout());
  const [oldKey] = storedKeys();
  const stale = observeCheckoutReservation(checkoutId);
  const prototype = Object.getPrototypeOf(window.localStorage);
  const set = prototype.setItem;
  const get = prototype.getItem;
  let failing = true;
  let unreadable: string | null = null;
  const remove = t.mock.method(prototype, 'removeItem');
  t.mock.method(prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (failing && failure === 'throw') throw new Error('Storage full');
    if (failing && failure === 'silent') return;
    set.call(this, key, value);
    if (failing) unreadable = key;
  });
  t.mock.method(prototype, 'getItem', function (this: Storage, key: string) {
    if (key === unreadable) { unreadable = null; throw new Error('Storage read failed'); }
    return get.call(this, key);
  });
  observeCheckoutReservation(checkoutId)(checkout());
  assert.equal(remove.mock.callCount(), 0);
  assert.ok(window.localStorage.getItem(oldKey));
  assert.equal(rememberCheckoutReservation(checkout()), true);
  assert.equal(checkoutReservesItems([item()]), true);
  inFreshWindow(() => assert.equal(checkoutReservesItems([item()]), true));
  stale(checkout({ status: 'failed' }));
  assert.ok(window.localStorage.getItem(oldKey));
  inFreshWindow(() => assert.equal(checkoutReservesItems([item()]), true));
  failing = false;
  observeCheckoutReservation(checkoutId)(checkout());
  assert.equal(storedKeys().length, 1);
  assert.equal(window.localStorage.getItem(oldKey), null);
  assert.equal(checkoutReservesItems([item()]), true);
  inFreshWindow(() => assert.equal(checkoutReservesItems([item()]), true));
  observeCheckoutReservation(checkoutId)(checkout({ status: 'failed' }));
  assert.deepEqual(storedKeys(), []);
  assert.equal(checkoutReservesItems([item()]), false);
  inFreshWindow(() => assert.equal(checkoutReservesItems([item()]), false));
});

for (const durable of [false, true]) test(`100 failed pending observations keep bounded fallback state ${durable ? 'with' : 'without'} a durable revision`, async t => {
  if (durable) rememberCheckoutReservation(checkout());
  const prototype = Object.getPrototypeOf(window.localStorage);
  const set = prototype.setItem;
  let failing = true;
  t.mock.method(prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (failing) throw new Error('Storage full');
    set.call(this, key, value);
  });
  assert.equal(rememberCheckoutReservation(checkout()), true);
  const stale = observeCheckoutReservation(checkoutId);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const view = renderHook(() => useCheckoutReservations(null, 0, null), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
  const revisions = () => JSON.parse(view.result.current).values.length;
  await act(async () => {
    for (let index = 0; index < 100; index++) observeCheckoutReservation(checkoutId)(checkout());
  });
  assert.equal(revisions(), durable ? 2 : 1);
  assert.equal(persistCheckoutReservation(checkout()), durable);
  inFreshWindow(() => assert.equal(checkoutReservesItems([item()]), durable));
  await act(async () => { stale(checkout({ status: 'failed' })); });
  assert.equal(checkoutReservesItems([item()]), true);
  assert.equal(revisions(), durable ? 2 : 1);
  inFreshWindow(() => assert.equal(checkoutReservesItems([item()]), durable));
  failing = false;
  await act(async () => { observeCheckoutReservation(checkoutId)(checkout()); });
  assert.equal(revisions(), 1);
  assert.equal(storedKeys().length, 1);
  assert.equal(persistCheckoutReservation(checkout()), true);
  inFreshWindow(() => assert.equal(checkoutReservesItems([item()]), true));
  await act(async () => { observeCheckoutReservation(checkoutId)(checkout({ status: 'failed' })); });
  assert.equal(revisions(), 0);
  assert.deepEqual(storedKeys(), []);
  assert.equal(checkoutReservesItems([item()]), false);
  inFreshWindow(() => assert.equal(checkoutReservesItems([item()]), false));
});

test('multiple revisions use one stable polling query without triggering a refetch loop', async t => {
  for (let revision = 0; revision < 3; revision++) seed(checkout(), id(revision));
  const status = t.mock.method(checkoutApi, 'status', async () => checkout());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  renderHook(() => useCheckoutReservations(owner, config.chainId, contract), {
    wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
  });
  await waitFor(() => assert.equal(storedKeys().length, 1));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  assert.equal(status.mock.callCount(), 1);
  assert.deepEqual(client.getQueryCache().getAll().map(query => query.queryKey), [
    ['ethereumCheckoutReservation', checkoutId, attemptId],
  ]);
  assert.equal(client.getQueryCache().getAll()[0].getObserversCount(), 1);
  for (let index = 0; index < 2; index++) {
    await act(async () => { await client.refetchQueries({ queryKey: ['ethereumCheckoutReservation', checkoutId] }); });
    assert.equal(status.mock.callCount(), index + 2);
    assert.equal(storedKeys().length, 1);
  }
});
