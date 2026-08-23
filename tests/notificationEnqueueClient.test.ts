import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueNotificationEmailJob } from '../scripts/shared/notificationEnqueueClient.ts';
import { createNotificationEmailJobV1 } from '../shared/notificationEmailJob.ts';
import {
  NOTIFICATION_ENQUEUE_PATH,
  NOTIFICATION_ENQUEUE_SIGNATURE_HEADER,
  NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER,
  verifyNotificationEnqueueRequest,
} from '../shared/notificationEnqueueAuth.ts';

const SECRET = 'test-enqueue-secret';
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const JOB = createNotificationEmailJobV1({
  jobId: JOB_ID,
  kind: 'buyer_order_received',
  idempotencyKey: 'card_nft_2:123:order_received',
  recipients: ['buyer@example.com'],
  subject: 'Subject',
  text: 'Text',
  html: '<p>HTML</p>',
  context: { dropId: 'card_nft_2', deliveryId: 123 },
});

test('notification enqueue client signs the exact body and accepts only 202', async () => {
  let calls = 0;
  await enqueueNotificationEmailJob({
    job: JOB,
    secret: SECRET,
    nowMs: NOW,
    fetch: async (input, init) => {
      calls += 1;
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      assert.equal(url.pathname, NOTIFICATION_ENQUEUE_PATH);
      assert.equal(init?.method, 'POST');
      assert.equal(JSON.parse(body).jobId, JOB_ID);
      assert.equal(await verifyNotificationEnqueueRequest({
        secret: SECRET,
        timestamp: headers.get(NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER),
        signature: headers.get(NOTIFICATION_ENQUEUE_SIGNATURE_HEADER),
        method: String(init?.method),
        pathname: url.pathname,
        body,
        nowMs: NOW,
      }), true);
      return new Response('{"queued":true}', { status: 202 });
    },
  });
  assert.equal(calls, 1);
});

test('notification enqueue client hides response bodies and retries non-202 failures', async () => {
  await assert.rejects(
    enqueueNotificationEmailJob({
      job: JOB,
      secret: SECRET,
      fetch: async () => new Response('private provider details', { status: 503 }),
    }),
    /status 503/,
  );
  await assert.rejects(enqueueNotificationEmailJob({ job: JOB, secret: '' }), /not configured/);
});
