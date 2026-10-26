import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { discardLegacyBrowserState } from '../src/lib/discardLegacyBrowserState.ts';
import { parsePendingPreorder } from '../src/lib/preorderPending.ts';

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function fixture(context: TestContext) {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const browser = { localStorage, sessionStorage };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return browser;
}

const checkoutId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const revision = '33333333-3333-4333-8333-333333333333';
const reservation = `mons.shop.ethereum-checkout-reservation:${checkoutId}:${attemptId}`;
const pendingKey = 'mons:preorder:v1:devnet:collection:buyer';
const request = { requestId: 'request', cardIds: [1] };

test('startup discards only retired browser records from both storage areas', context => {
  const browser = fixture(context);
  for (const storage of Object.values(browser)) {
    const retired = [
      ...[1, 2, 3].map(version => [`mons:preorder-recovery:v${version}:scope`, '{historical bytes}']),
      [reservation, '{historical bytes}'],
      [`mons.shop.ethereum-checkout-reservation:${checkoutId}:unknown`, '{historical bytes}'],
      [pendingKey, JSON.stringify(request)],
      [`${pendingKey}:null`, JSON.stringify({ ...request, ethereumAddress: null, submittedAttempt: false })],
    ];
    const retained = [
      ['mons:preorder-recovery:v4:scope', '{current bytes}'],
      [`${reservation}:${revision}`, '{current bytes}'],
      [`mons.shop.ethereum-checkout-reservation:${checkoutId}:unknown:${revision}`, '{current bytes}'],
      ['unrelated', '{unrelated bytes}'],
      [`${pendingKey}:malformed`, '{'],
      [`${pendingKey}:invalid`, JSON.stringify({ ...request, cardIds: ['1'] })],
      [`${pendingKey}:invalid-submission`, JSON.stringify({ ...request, submittedAttempt: 0 })],
      [`${pendingKey}:wallet`, JSON.stringify({ ...request, ethereumAddress: '0x0000000000000000000000000000000000000001' })],
      [`${pendingKey}:order`, JSON.stringify({ ...request, orderId: 'known-order', ethereumAddress: null })],
      [`${pendingKey}:submission`, JSON.stringify({ ...request, submittedAttempt: true })],
    ];
    for (const [key, value] of [...retired, ...retained]) storage.setItem(key, value);
    discardLegacyBrowserState();
    for (const [key] of retired) assert.equal(storage.getItem(key), null, key);
    assert.deepEqual([...storage.values], retained);
    discardLegacyBrowserState();
    assert.deepEqual([...storage.values], retained);
  }
});

test('pending reads preserve every current identity and reject identity-less records', () => {
  for (const value of [request, { ...request, ethereumAddress: null }, { ...request, submittedAttempt: false }]) {
    assert.equal(parsePendingPreorder(value), null);
  }
  for (const value of [
    { ...request, ethereumAddress: '0x0000000000000000000000000000000000000001' },
    { ...request, orderId: 'known-order', ethereumAddress: null },
    { ...request, submittedAttempt: true },
  ]) assert.deepEqual(parsePendingPreorder(value), value);
});

test('failed removals do not prevent other retired records from being discarded', context => {
  const browser = fixture(context);
  browser.localStorage.setItem(reservation, '{}');
  browser.localStorage.setItem(pendingKey, JSON.stringify(request));
  browser.sessionStorage.setItem(pendingKey, JSON.stringify(request));
  const remove = browser.localStorage.removeItem.bind(browser.localStorage);
  context.mock.method(browser.localStorage, 'removeItem', key => {
    if (key === reservation) throw new Error('Storage unavailable');
    remove(key);
  });
  assert.doesNotThrow(discardLegacyBrowserState);
  assert.equal(browser.localStorage.getItem(reservation), '{}');
  assert.equal(browser.localStorage.getItem(pendingKey), null);
  assert.equal(browser.sessionStorage.getItem(pendingKey), null);
});

test('blocked shared storage does not prevent tab storage cleanup', context => {
  const browser = fixture(context);
  browser.sessionStorage.setItem(pendingKey, JSON.stringify(request));
  Object.defineProperty(browser, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  assert.doesNotThrow(discardLegacyBrowserState);
  assert.equal(browser.sessionStorage.getItem(pendingKey), null);
});

test('cleanup preserves a current pending request written after the retired value was read', context => {
  const browser = fixture(context);
  browser.localStorage.setItem(pendingKey, JSON.stringify(request));
  const current = JSON.stringify({ ...request, orderId: 'new-order' });
  const get = browser.localStorage.getItem.bind(browser.localStorage);
  let reads = 0;
  context.mock.method(browser.localStorage, 'getItem', key => {
    if (key === pendingKey && ++reads === 2) browser.localStorage.setItem(key, current);
    return get(key);
  });
  discardLegacyBrowserState();
  assert.equal(browser.localStorage.getItem(pendingKey), current);
});
