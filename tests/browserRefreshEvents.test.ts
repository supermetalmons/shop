import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { subscribeBrowserRefreshEvents } from '../src/lib/browserRefreshEvents.ts';

function browser(t: TestContext, visibilityState = 'visible') {
  const browserWindow = new EventTarget();
  const browserDocument = Object.assign(new EventTarget(), { visibilityState });
  for (const [name, value] of [['window', browserWindow], ['document', browserDocument]] as const) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return { browserWindow, browserDocument };
}

test('refresh subscriptions forward focus and visibility events without an initial call or online events', t => {
  const { browserWindow, browserDocument } = browser(t);
  let calls = 0;
  const unsubscribe = subscribeBrowserRefreshEvents(() => { calls++; });
  assert.equal(calls, 0);
  browserWindow.dispatchEvent(new Event('focus'));
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 2);
  browserWindow.dispatchEvent(new Event('online'));
  browserWindow.dispatchEvent(new Event('visibilitychange'));
  browserDocument.dispatchEvent(new Event('focus'));
  assert.equal(calls, 2);
  unsubscribe();
  browserWindow.dispatchEvent(new Event('focus'));
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 2);
});

test('hidden events are forwarded and online events require an explicit subscription', t => {
  const { browserWindow, browserDocument } = browser(t, 'hidden');
  let calls = 0;
  const unsubscribe = subscribeBrowserRefreshEvents(() => { calls++; }, { online: true });
  browserWindow.dispatchEvent(new Event('focus'));
  browserWindow.dispatchEvent(new Event('online'));
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 3);
  unsubscribe();
  unsubscribe();
  browserWindow.dispatchEvent(new Event('focus'));
  browserWindow.dispatchEvent(new Event('online'));
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 3);
});

test('cleanup removes only its own listener and remounting does not duplicate callbacks', t => {
  const { browserWindow } = browser(t);
  let firstCalls = 0;
  let secondCalls = 0;
  const first = () => { firstCalls++; };
  subscribeBrowserRefreshEvents(first)();
  const unsubscribeFirst = subscribeBrowserRefreshEvents(first);
  const unsubscribeSecond = subscribeBrowserRefreshEvents(() => { secondCalls++; });
  browserWindow.dispatchEvent(new Event('focus'));
  assert.deepEqual([firstCalls, secondCalls], [1, 1]);
  unsubscribeFirst();
  browserWindow.dispatchEvent(new Event('focus'));
  assert.deepEqual([firstCalls, secondCalls], [1, 2]);
  unsubscribeSecond();
});

test('refresh subscriptions are inert when either browser global is unavailable', t => {
  browser(t);
  for (const name of ['window', 'document'] as const) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name)!;
    Reflect.deleteProperty(globalThis, name);
    const unsubscribe = subscribeBrowserRefreshEvents(() => assert.fail('Unexpected refresh'), { online: true });
    assert.doesNotThrow(unsubscribe);
    Object.defineProperty(globalThis, name, original);
  }
});
