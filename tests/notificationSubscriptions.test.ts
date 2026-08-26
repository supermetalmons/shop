import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeToNotifications } from '../src/lib/notificationSubscriptions.ts';

test('notification subscription client posts exact JSON to the shop API without Auth authentication', async () => {
  const originalFetch = globalThis.fetch;
  let receivedUrl = '';
  let receivedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    receivedUrl = String(input);
    receivedInit = init;
    return Response.json({ subscribed: true });
  };
  try {
    const result = await subscribeToNotifications({ email: 'buyer@example.com' });
    assert.deepEqual(result, { subscribed: true });
    assert.equal(receivedUrl, 'https://api.mons.shop/notifications/subscribe');
    assert.equal(receivedInit?.method, 'POST');
    assert.equal(new Headers(receivedInit?.headers).get('content-type'), 'application/json');
    assert.equal(new Headers(receivedInit?.headers).has('authorization'), false);
    assert.equal(receivedInit?.cache, 'no-store');
    assert.deepEqual(JSON.parse(String(receivedInit?.body)), { email: 'buyer@example.com' });
    assert.ok(receivedInit?.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('notification subscription client rejects HTTP and malformed success responses', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json(
      { ok: false, error: 'provider-unavailable' },
      { status: 502 },
    );
    await assert.rejects(
      subscribeToNotifications({ email: 'buyer@example.com' }),
      /Notification API request failed: http-502/,
    );

    globalThis.fetch = async () => Response.json({ subscribed: false });
    await assert.rejects(
      subscribeToNotifications({ email: 'buyer@example.com' }),
      /invalid subscription response/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('notification subscription client enforces its request timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return reject(new Error('missing signal'));
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    await assert.rejects(
      subscribeToNotifications({ email: 'buyer@example.com' }, { timeoutMs: 1 }),
      (error) => error instanceof DOMException && error.name === 'TimeoutError',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
