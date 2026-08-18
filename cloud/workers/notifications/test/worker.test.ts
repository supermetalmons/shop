import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNotificationEmailJobV1 } from '../../../../functions/src/shared/notificationEmailJob.ts';
import {
  notificationEmailRetryDelaySeconds,
  processNotificationEmailBatch,
  resendSend,
  type NotificationEmailSend,
} from '../src/index.ts';

const JOB = createNotificationEmailJobV1({
  jobId: '123e4567-e89b-42d3-a456-426614174000',
  kind: 'buyer_order_received',
  idempotencyKey: 'card_nft_2:123:order_received',
  recipients: ['private-buyer@example.com'],
  subject: 'Private subject',
  text: 'Private text',
  html: '<p>Private HTML</p>',
  context: { dropId: 'card_nft_2', deliveryId: 123 },
});

type MessageActions = {
  acks: number;
  retries: Array<QueueRetryOptions | undefined>;
};

function queueMessage(body: unknown, attempts = 1): { message: Message<unknown>; actions: MessageActions } {
  const actions: MessageActions = { acks: 0, retries: [] };
  return {
    message: {
      id: `queue-message-${attempts}`,
      timestamp: new Date('2026-08-18T12:00:00.000Z'),
      body,
      attempts,
      ack: () => {
        actions.acks += 1;
      },
      retry: (options) => {
        actions.retries.push(options);
      },
    },
    actions,
  };
}

function batch(...messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    queue: 'mons-shop-notification-emails',
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 100 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  };
}

function env(apiKey = 'resend-test-key'): Env {
  return { RESEND_API_KEY: apiKey };
}

test('notification consumer acknowledges successful sends with the exact job and key', async () => {
  const queued = queueMessage(JOB);
  const sent: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const send: NotificationEmailSend = async (job, apiKey) => {
    sent.push({ job, apiKey });
    return { data: { id: 'email-message-id' }, error: null };
  };
  await processNotificationEmailBatch(batch(queued.message), env(), {
    send,
    log: (entry) => logs.push(entry),
    warn: (entry) => logs.push(entry),
    error: (entry) => logs.push(entry),
  });
  assert.deepEqual(sent, [{ job: JOB, apiKey: 'resend-test-key' }]);
  assert.equal(queued.actions.acks, 1);
  assert.deepEqual(queued.actions.retries, []);
  assert.deepEqual(logs, [{
    event: 'notification_email_sent',
    jobId: JOB.jobId,
    kind: JOB.kind,
    recipientCount: 1,
    dropId: 'card_nft_2',
    deliveryId: 123,
    attempts: 1,
    messageId: 'email-message-id',
  }]);
  const serialized = JSON.stringify(logs);
  for (const privateValue of [JOB.recipients[0], JOB.subject, JOB.text, JOB.html, JOB.idempotencyKey]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('Resend transport sends the exact bounded HTTP request', async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const result = await resendSend(JOB, 'resend-test-key', async (input, init) => {
    request = { input: String(input), init };
    return Response.json({ id: 'email-message-id' });
  });
  assert.deepEqual(result, { data: { id: 'email-message-id' }, error: null });
  assert.equal(request?.input, 'https://api.resend.com/emails');
  assert.equal(request?.init?.method, 'POST');
  const headers = new Headers(request?.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer resend-test-key');
  assert.equal(headers.get('idempotency-key'), JOB.idempotencyKey);
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    from: 'notifications@support.mons.shop',
    to: JOB.recipients,
    subject: JOB.subject,
    text: JOB.text,
    html: JOB.html,
  });
});

test('Resend transport bounds declared and streamed provider responses', async () => {
  await assert.rejects(
    resendSend(JOB, 'resend-test-key', async () => new Response('{}', {
      headers: { 'Content-Length': String(16 * 1024 + 1) },
    })),
    /too_large/,
  );
  await assert.rejects(
    resendSend(JOB, 'resend-test-key', async () => new Response(JSON.stringify({
      id: 'email-message-id',
      padding: 'x'.repeat(16 * 1024),
    }))),
    /too_large/,
  );
});

test('notification consumer retries transient provider and transport failures per message', async () => {
  const transport = queueMessage(JOB, 1);
  const rateLimited = queueMessage({ ...JOB, jobId: '223e4567-e89b-42d3-a456-426614174000' }, 3);
  let calls = 0;
  const send: NotificationEmailSend = async () => {
    calls += 1;
    if (calls === 1) throw new Error('private transport error');
    return {
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'private-buyer@example.com', statusCode: 429 },
    };
  };
  const logs: Record<string, unknown>[] = [];
  await processNotificationEmailBatch(batch(transport.message, rateLimited.message), env(), {
    send,
    log: (entry) => logs.push(entry),
    warn: (entry) => logs.push(entry),
    error: (entry) => logs.push(entry),
  });
  assert.equal(transport.actions.acks, 0);
  assert.deepEqual(transport.actions.retries, [{ delaySeconds: 30 }]);
  assert.equal(rateLimited.actions.acks, 0);
  assert.deepEqual(rateLimited.actions.retries, [{ delaySeconds: 10 * 60 }]);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('private-buyer@example.com'), false);
  assert.equal(serialized.includes('private transport error'), false);
});

test('notification consumer acknowledges permanent errors and malformed jobs', async () => {
  const permanent = queueMessage(JOB);
  const malformed = queueMessage({ ...JOB, recipients: ['not an email'] });
  let sends = 0;
  await processNotificationEmailBatch(batch(permanent.message, malformed.message), env(), {
    send: async () => {
      sends += 1;
      return {
        data: null,
        error: { name: 'validation_error', message: 'private provider detail', statusCode: 422 },
      };
    },
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  assert.equal(sends, 1);
  assert.equal(permanent.actions.acks, 1);
  assert.deepEqual(permanent.actions.retries, []);
  assert.equal(malformed.actions.acks, 1);
  assert.deepEqual(malformed.actions.retries, []);
});

test('notification consumer retries missing configuration and malformed successes', async () => {
  const missingSecret = queueMessage(JOB, 2);
  const malformedSuccess = queueMessage({ ...JOB, jobId: '323e4567-e89b-42d3-a456-426614174000' }, 5);
  await processNotificationEmailBatch(batch(missingSecret.message), env(''), {
    send: async () => ({ data: { id: 'unused' }, error: null }),
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  await processNotificationEmailBatch(batch(malformedSuccess.message), env(), {
    send: async () => ({ data: {}, error: null }),
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  assert.deepEqual(missingSecret.actions.retries, [{ delaySeconds: 2 * 60 }]);
  assert.deepEqual(malformedSuccess.actions.retries, [{ delaySeconds: 2 * 60 * 60 }]);
});

test('notification retry delays are bounded to the approved schedule', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 20].map(notificationEmailRetryDelaySeconds),
    [30, 30, 2 * 60, 10 * 60, 30 * 60, 2 * 60 * 60, 2 * 60 * 60],
  );
});

test('notification Worker config is isolated and uses the reviewed queue policy', () => {
  const config = JSON.parse(readFileSync('cloud/workers/notifications/wrangler.jsonc', 'utf8'));
  assert.equal(config.name, 'mons-shop-notifications');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.routes, undefined);
  assert.deepEqual(config.secrets.required, ['RESEND_API_KEY']);
  assert.deepEqual(config.queues.consumers, [{
    queue: 'mons-shop-notification-emails',
    max_batch_size: 5,
    max_batch_timeout: 5,
    max_retries: 5,
    max_concurrency: 1,
    dead_letter_queue: 'mons-shop-notification-emails-dlq',
  }]);
  assert.equal(config.observability.logs.head_sampling_rate, 1);
  assert.equal(config.observability.logs.invocation_logs, false);
});
