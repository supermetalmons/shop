import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isExactSubscribeToNotificationsRequest } from '../shared/notificationSubscription.ts';
import { listFrontendDrops } from '../src/config/deployment.ts';
import { listUpcomingDropRoutes } from '../src/lib/dropConfig.ts';
import { subscribeToNotifications } from '../src/lib/notificationSubscriptions.ts';

test('every storefront notification family has its own configured Resend segment', () => {
  const config = JSON.parse(readFileSync(
    new URL('../cloud/workers/api/wrangler.jsonc', import.meta.url), 'utf8',
  )) as { vars: { RESEND_DROP_SEGMENT_IDS?: Record<string, string> } };
  const segments = config.vars.RESEND_DROP_SEGMENT_IDS;
  assert.ok(segments, 'API Worker must configure drop notification segments');
  const families = new Set([
    ...listFrontendDrops(),
    ...listUpcomingDropRoutes(),
  ].map(drop => drop.dropFamily).filter(family => family !== 'default'));
  const assignedIds = new Set<string>();
  for (const family of families) {
    const id = segments[family];
    assert.match(id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      `${family} must have a Resend segment UUID`);
    assert.equal(assignedIds.has(id), false, `${family} must have a distinct Resend segment`);
    assignedIds.add(id);
  }
});

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


test('notification subscription contract accepts only canonical optional drop families', () => {
  for (const dropFamily of ['111k', 'clear_cards', 'mi_note_cards', 'little_swag_boxes']) {
    assert.equal(isExactSubscribeToNotificationsRequest({ email: 'buyer@example.com', dropFamily }), true);
  }
  for (const dropFamily of ['default', 'unknown', '', '111K', ' 111k ', '111k_devnet', undefined, null, 1]) {
    assert.equal(isExactSubscribeToNotificationsRequest({ email: 'buyer@example.com', dropFamily }), false);
  }
  assert.equal(isExactSubscribeToNotificationsRequest({ email: 'buyer@example.com' }), true);
  assert.equal(isExactSubscribeToNotificationsRequest({ email: 'buyer@example.com', dropFamily: '111k', segmentId: 'injected' }), false);
});

test('notification subscription client includes drop family when provided', async () => {
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ subscribed: true });
  };
  try {
    await subscribeToNotifications({ email: 'buyer@example.com', dropFamily: '111k' });
    assert.deepEqual(requests, [{ email: 'buyer@example.com', dropFamily: '111k' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
