import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFICATION_ENQUEUE_MAX_CLOCK_SKEW_MS,
  NOTIFICATION_ENQUEUE_PATH,
  notificationEnqueueTimestamp,
  signNotificationEnqueueRequest,
  verifyNotificationEnqueueRequest,
} from '../functions/src/shared/notificationEnqueueAuth.ts';

const SECRET = 'test-notification-secret';
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const BODY = '{"version":1}';

async function signed(timestamp = notificationEnqueueTimestamp(NOW), body = BODY) {
  return {
    timestamp,
    signature: await signNotificationEnqueueRequest({ secret: SECRET, timestamp, body }),
    body,
  };
}

test('notification enqueue HMAC accepts the exact canonical request', async () => {
  const request = await signed();
  assert.equal(await verifyNotificationEnqueueRequest({
    secret: SECRET,
    ...request,
    method: 'POST',
    pathname: NOTIFICATION_ENQUEUE_PATH,
    nowMs: NOW,
  }), true);
});

test('notification enqueue HMAC rejects mutations and missing headers', async () => {
  const request = await signed();
  for (const mutation of [
    { body: `${BODY} ` },
    { method: 'GET' },
    { pathname: '/internal/notifications/other' },
    { signature: `${request.signature.slice(0, -1)}0` },
    { timestamp: null },
    { signature: null },
  ]) {
    assert.equal(await verifyNotificationEnqueueRequest({
      secret: SECRET,
      ...request,
      method: 'POST',
      pathname: NOTIFICATION_ENQUEUE_PATH,
      nowMs: NOW,
      ...mutation,
    }), false);
  }
});

test('notification enqueue HMAC rejects stale and future timestamps', async () => {
  for (const timestampMs of [
    NOW - NOTIFICATION_ENQUEUE_MAX_CLOCK_SKEW_MS - 1000,
    NOW + NOTIFICATION_ENQUEUE_MAX_CLOCK_SKEW_MS + 1000,
  ]) {
    const request = await signed(notificationEnqueueTimestamp(timestampMs));
    assert.equal(await verifyNotificationEnqueueRequest({
      secret: SECRET,
      ...request,
      method: 'POST',
      pathname: NOTIFICATION_ENQUEUE_PATH,
      nowMs: NOW,
    }), false);
  }
});
