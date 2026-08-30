import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNotificationEmailJobV1 } from '../../../../shared/notificationEmailJob.ts';
import { createStripeCheckoutFulfillmentJobV1 } from '../../../../shared/stripeCheckoutFulfillmentJob.ts';
import {
  notificationEmailRetryDelaySeconds,
  processNotificationEmailMessage,
  resendSend,
  type NotificationEmailSend,
} from '../src/notificationEmailConsumer.ts';
import { processNotificationQueueMessage } from '../src/notificationEnqueue.ts';
import { loadApiWorkerIndex } from './cloudflareWorkersTestLoader.ts';

const {
  default: worker,
  processBackgroundJobBatch,
  processStripeFulfillmentMessage,
} = await loadApiWorkerIndex();

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

function batch(queue: string, ...messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    queue,
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 100 } },
    ackAll: () => undefined,
    retryAll: () => undefined,
  };
}

function env(apiKey = 'resend-test-key'): Pick<Env, 'RESEND_API_KEY'> {
  return { RESEND_API_KEY: apiKey };
}

function commerceAuthorityDb(
  state: 'paused' | 'd1',
  onRead: () => void,
): D1Database {
  const database = {} as D1Database;
  database.prepare = () => {
    onRead();
    return {
      first: async () => ({
        authority_state: state,
        revision: 1,
        documents_revision: 0,
      }),
    } as D1PreparedStatement;
  };
  return database;
}

function backgroundEnv(commerceDb: D1Database): Env {
  return {
    ...env(),
    COMMERCE_DB: commerceDb,
  } as Env;
}

test('notification consumer acknowledges successful sends with the exact job and key', async () => {
  const queued = queueMessage(JOB);
  const sent: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const send: NotificationEmailSend = async (job, apiKey) => {
    sent.push({ job, apiKey });
    return { data: { id: 'email-message-id' }, error: null };
  };
  await processNotificationEmailMessage(queued.message, env(), {
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

test('notification enqueue smoke self-signs with the Worker secret and forwards through the real handler', async () => {
  const queued = queueMessage({ version: 1, kind: 'notification_enqueue_smoke', job: JOB });
  const sent: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const queue: Queue = {
    send: async (body, options) => {
      sent.push({ body, options });
      return { metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } } };
    },
    sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  };
  await processNotificationQueueMessage(queued.message, {
    NOTIFICATION_EMAIL_QUEUE: queue,
    NOTIFICATION_ENQUEUE_SECRET: 'worker-only-secret',
    RESEND_API_KEY: 'resend-test-key',
  }, {
    nowMs: () => 1_700_000_000_000,
    log: (entry) => logs.push(entry),
  });
  assert.equal(queued.actions.acks, 1);
  assert.deepEqual(sent, [{ body: JOB, options: { contentType: 'json' } }]);
  assert.deepEqual(logs.map((entry) => entry.event), [
    'notification_email_enqueued',
    'notification_enqueue_smoke_forwarded',
  ]);
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
  const overrides: NonNullable<Parameters<typeof processNotificationEmailMessage>[2]> = {
    send,
    log: (entry) => logs.push(entry),
    warn: (entry) => logs.push(entry),
    error: (entry) => logs.push(entry),
  };
  await processNotificationEmailMessage(transport.message, env(), overrides);
  await processNotificationEmailMessage(rateLimited.message, env(), overrides);
  assert.equal(transport.actions.acks, 0);
  assert.deepEqual(transport.actions.retries, [{ delaySeconds: 30 }]);
  assert.equal(rateLimited.actions.acks, 0);
  assert.deepEqual(rateLimited.actions.retries, [{ delaySeconds: 10 * 60 }]);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('private-buyer@example.com'), false);
  assert.equal(serialized.includes('private transport error'), false);
});

test('notification consumer retries transient HTTP statuses before provider names', async () => {
  for (const statusCode of [408, 429, 503]) {
    const queued = queueMessage({ ...JOB, jobId: `423e4567-e89b-42d3-a456-426614174${statusCode}` });
    await processNotificationEmailMessage(queued.message, env(), {
      send: async () => ({
        data: null,
        error: { name: 'validation_error', message: 'recognized but transient', statusCode },
      }),
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    assert.equal(queued.actions.acks, 0, String(statusCode));
    assert.deepEqual(queued.actions.retries, [{ delaySeconds: 30 }], String(statusCode));
  }
});

test('notification consumer acknowledges permanent errors and malformed jobs', async () => {
  const permanent = queueMessage(JOB);
  const malformed = queueMessage({ ...JOB, recipients: ['not an email'] });
  let sends = 0;
  const overrides: NonNullable<Parameters<typeof processNotificationEmailMessage>[2]> = {
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
  };
  await processNotificationEmailMessage(permanent.message, env(), overrides);
  await processNotificationEmailMessage(malformed.message, env(), overrides);
  assert.equal(sends, 1);
  assert.equal(permanent.actions.acks, 1);
  assert.deepEqual(permanent.actions.retries, []);
  assert.equal(malformed.actions.acks, 1);
  assert.deepEqual(malformed.actions.retries, []);
});

test('notification consumer retries missing configuration and malformed successes', async () => {
  const missingSecret = queueMessage(JOB, 2);
  const malformedSuccess = queueMessage({ ...JOB, jobId: '323e4567-e89b-42d3-a456-426614174000' }, 5);
  await processNotificationEmailMessage(missingSecret.message, env(''), {
    send: async () => ({ data: { id: 'unused' }, error: null }),
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });
  await processNotificationEmailMessage(malformedSuccess.message, env(), {
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

test('queue batches route by exact queue name and isolate individual failures', async () => {
  const reveal = queueMessage({
    version: 1,
    kind: 'reveal_submission_reconcile',
    dropId: 'clear_cards_devnet_v2',
    boxAssetId: 'kPG2L5zuxqNkvWvJNptbkqnPhk4nGjnGp7jwDFZPQgx',
    reservationId: '123e4567-e89b-42d3-a456-426614174000',
    signature: 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx5akrrpkWp7jjhVdiSgpJVSBgV7W2QU7qDN1ZTZe3bG9R',
  });
  const notification = queueMessage(JOB);
  const revealSibling = queueMessage(JOB);
  const unknown = queueMessage(JOB);
  const fulfillment = queueMessage(createStripeCheckoutFulfillmentJobV1({
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_123',
    stripeEventId: 'evt_test_123',
    stripeEventType: 'checkout.session.completed',
    enqueuedAtMs: 1_700_000_000_000,
  }), 2);
  const routes: string[] = [];
  const errors: Record<string, unknown>[] = [];
  const overrides: NonNullable<Parameters<typeof processBackgroundJobBatch>[2]> = {
    reveal: async (message) => {
      routes.push('reveal');
      if (message === reveal.message) throw new Error('reveal failed');
      message.ack();
    },
    notification: async (message) => {
      routes.push('notification');
      message.ack();
    },
    fulfillment: async () => {
      routes.push('fulfillment');
      throw new Error('fulfillment failed');
    },
    log: () => undefined,
    error: (entry) => errors.push(entry),
  };
  await processBackgroundJobBatch(
    batch('mons-shop-reveal-reconciliation', reveal.message, revealSibling.message),
    env() as Env,
    overrides,
  );
  await processBackgroundJobBatch(
    batch('mons-shop-notification-emails', notification.message),
    env() as Env,
    overrides,
  );
  await processBackgroundJobBatch(
    batch('unexpected-queue', unknown.message),
    env() as Env,
    overrides,
  );
  await processBackgroundJobBatch(
    batch('mons-shop-stripe-fulfillment', fulfillment.message),
    env() as Env,
    overrides,
  );
  assert.deepEqual(routes, ['reveal', 'reveal', 'notification', 'fulfillment']);
  assert.equal(reveal.actions.acks, 0);
  assert.deepEqual(reveal.actions.retries, [undefined]);
  assert.equal(revealSibling.actions.acks, 1);
  assert.deepEqual(revealSibling.actions.retries, []);
  assert.equal(notification.actions.acks, 1);
  assert.deepEqual(notification.actions.retries, []);
  assert.equal(unknown.actions.acks, 0);
  assert.deepEqual(unknown.actions.retries, [undefined]);
  assert.deepEqual(fulfillment.actions.retries, [{ delaySeconds: 60 }]);
  assert.deepEqual(errors.map((entry) => entry.event), [
    'background_job_unhandled_error',
    'background_job_unknown_queue',
    'background_job_unhandled_error',
  ]);
});

test('commerce maintenance gates only commerce-dependent queue batches', async () => {
  const notification = queueMessage(JOB);
  const reveal = queueMessage(JOB);
  const fulfillment = queueMessage(JOB);
  const unknown = queueMessage(JOB);
  const routes: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  let authorityReads = 0;
  const unavailableCommerceDb = commerceAuthorityDb('paused', () => {
    assert.fail('commerce authority must not be read for this queue');
  });
  const pausedCommerceDb = commerceAuthorityDb('paused', () => {
    authorityReads += 1;
  });
  const overrides: NonNullable<Parameters<typeof processBackgroundJobBatch>[2]> = {
    notification: async (message) => {
      routes.push('notification');
      message.ack();
    },
    reveal: async () => assert.fail('reveal processing must pause during commerce maintenance'),
    fulfillment: async () => assert.fail('fulfillment processing must pause during commerce maintenance'),
    log: (entry) => logs.push(entry),
    error: (entry) => errors.push(entry),
  };

  await processBackgroundJobBatch(
    batch('mons-shop-notification-emails', notification.message),
    backgroundEnv(unavailableCommerceDb),
    overrides,
  );
  await processBackgroundJobBatch(
    batch('mons-shop-reveal-reconciliation', reveal.message),
    backgroundEnv(pausedCommerceDb),
    overrides,
  );
  await processBackgroundJobBatch(
    batch('mons-shop-stripe-fulfillment', fulfillment.message),
    backgroundEnv(pausedCommerceDb),
    overrides,
  );
  await processBackgroundJobBatch(
    batch('unexpected-queue', unknown.message),
    backgroundEnv(unavailableCommerceDb),
    overrides,
  );

  assert.deepEqual(routes, ['notification']);
  assert.equal(notification.actions.acks, 1);
  assert.deepEqual(notification.actions.retries, []);
  assert.equal(reveal.actions.acks, 0);
  assert.deepEqual(reveal.actions.retries, [undefined]);
  assert.equal(fulfillment.actions.acks, 0);
  assert.deepEqual(fulfillment.actions.retries, [undefined]);
  assert.equal(unknown.actions.acks, 0);
  assert.deepEqual(unknown.actions.retries, [undefined]);
  assert.equal(authorityReads, 2);
  assert.deepEqual(logs, [
    {
      event: 'background_job_commerce_maintenance',
      queue: 'mons-shop-reveal-reconciliation',
      messageCount: 1,
    },
    {
      event: 'background_job_commerce_maintenance',
      queue: 'mons-shop-stripe-fulfillment',
      messageCount: 1,
    },
  ]);
  assert.deepEqual(errors, [{
    event: 'background_job_unknown_queue',
    queue: 'unexpected-queue',
    messageCount: 1,
  }]);
});

test('Stripe fulfillment queue processing validates jobs and records terminal outcomes', async () => {
  const queued = queueMessage(createStripeCheckoutFulfillmentJobV1({
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_456',
    stripeEventId: 'evt_test_456',
    stripeEventType: 'checkout.session.async_payment_succeeded',
    enqueuedAtMs: Date.now(),
  }));
  const logs: Record<string, unknown>[] = [];
  await processStripeFulfillmentMessage(queued.message, env() as Env, {
    process: async (_job, _env, signal, options) => {
      assert.equal(options?.treatRetryableFailureAsTerminal, false);
      assert.notEqual(options?.persistenceSignal, signal);
      return {
        fulfillment: {
          status: 'ignored',
          dropId: 'card_nft_binder_devnet',
          sessionId: 'cs_test_456',
          reason: 'already_fulfilled',
        },
        notifications: { outcome: 'fulfilled', queuedJobs: 2 },
      };
    },
    log: (entry) => logs.push(entry),
  });
  assert.deepEqual(logs.map((entry) => entry.event), [
    'stripe_fulfillment_job_started',
    'stripe_fulfillment_job_completed',
  ]);
  assert.equal(logs[1].fulfillmentReason, 'already_fulfilled');
  await assert.rejects(
    processStripeFulfillmentMessage(queueMessage({ invalid: true }).message, env() as Env, {
      process: async () => assert.fail('invalid jobs must not be processed'),
    }),
    /Invalid Stripe checkout fulfillment queue message/,
  );
});

test('Stripe fulfillment persists retryable failures on the final Queue attempt', async () => {
  const config = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8')) as {
    queues: { consumers: Array<{ max_retries: number; queue: string }> };
  };
  const maxRetries = config.queues.consumers.find((consumer) => (
    consumer.queue === 'mons-shop-stripe-fulfillment'
  ))?.max_retries;
  assert.equal(maxRetries, 10);
  const queued = queueMessage(createStripeCheckoutFulfillmentJobV1({
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_final_attempt',
    stripeEventId: 'evt_test_final_attempt',
    stripeEventType: 'checkout.session.completed',
    enqueuedAtMs: Date.now(),
  }), Number(maxRetries) + 1);
  await processStripeFulfillmentMessage(queued.message, env() as Env, {
    log: () => undefined,
    process: async (_job, _env, _signal, options) => {
      assert.equal(options?.treatRetryableFailureAsTerminal, true);
      return {
        fulfillment: {
          status: 'failed',
          dropId: 'card_nft_binder_devnet',
          sessionId: 'cs_test_final_attempt',
          error: { code: 'unavailable' },
        },
        notifications: { outcome: 'manual_review', queuedJobs: 1 },
      };
    },
  });
});

test('Stripe fulfillment queue processing enforces its top-level deadline', async () => {
  const queued = queueMessage(createStripeCheckoutFulfillmentJobV1({
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_timeout',
    stripeEventId: 'evt_test_timeout',
    stripeEventType: 'checkout.session.completed',
    enqueuedAtMs: Date.now(),
  }));
  await assert.rejects(
    processStripeFulfillmentMessage(queued.message, env() as Env, {
      process: async (_job, _env, signal, options) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          assert.equal(options?.persistenceSignal?.aborted, false);
          reject(signal.reason);
        }, { once: true });
      }),
      log: () => undefined,
      timeoutMs: 5,
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
});

test('Stripe fulfillment logs final unhandled failures as DLQ-bound', async () => {
  const queued = queueMessage(createStripeCheckoutFulfillmentJobV1({
    dropId: 'card_nft_binder_devnet',
    sessionId: 'cs_test_dlq',
    stripeEventId: 'evt_test_dlq',
    stripeEventType: 'checkout.session.completed',
    enqueuedAtMs: Date.now(),
  }), 11);
  const logs: Record<string, unknown>[] = [];
  await processBackgroundJobBatch(
    batch('mons-shop-stripe-fulfillment', queued.message),
    env() as Env,
    {
      fulfillment: async () => {
        throw new Error('persistence failed');
      },
      log: (entry) => logs.push(entry),
      error: () => undefined,
    },
  );
  assert.deepEqual(logs, [{
    event: 'stripe_fulfillment_job_dlq_bound',
    queueMessageId: 'queue-message-11',
    queueAttempts: 11,
  }]);
  assert.deepEqual(queued.actions.retries, [{ delaySeconds: 60 }]);
});

test('API Worker exposes the queue handler and uses the reviewed queue policy', () => {
  const config = JSON.parse(readFileSync('cloud/workers/api/wrangler.jsonc', 'utf8'));
  assert.equal(typeof worker.queue, 'function');
  assert.equal(typeof worker.scheduled, 'function');
  assert.equal(config.name, 'mons-shop-api');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, true);
  assert.deepEqual(config.routes, [{ pattern: 'api.mons.shop', custom_domain: true }]);
  assert.equal(config.secrets.required.includes('RESEND_API_KEY'), true);
  assert.deepEqual(config.queues.consumers, [
    {
      queue: 'mons-shop-notification-emails',
      max_batch_size: 5,
      max_batch_timeout: 5,
      max_retries: 5,
      max_concurrency: 1,
      dead_letter_queue: 'mons-shop-notification-emails-dlq',
    },
    {
      queue: 'mons-shop-reveal-reconciliation',
      max_batch_size: 1,
      max_batch_timeout: 1,
      max_retries: 10,
      max_concurrency: 1,
      dead_letter_queue: 'mons-shop-reveal-reconciliation-dlq',
    },
    {
      queue: 'mons-shop-stripe-fulfillment',
      max_batch_size: 1,
      max_batch_timeout: 1,
      max_retries: 10,
      max_concurrency: 1,
      retry_delay: 60,
      dead_letter_queue: 'mons-shop-stripe-fulfillment-dlq',
    },
  ]);
  assert.deepEqual(config.queues.producers, [
    { binding: 'NOTIFICATION_EMAIL_QUEUE', queue: 'mons-shop-notification-emails' },
    { binding: 'REVEAL_BACKGROUND_QUEUE', queue: 'mons-shop-reveal-reconciliation' },
    { binding: 'STRIPE_FULFILLMENT_QUEUE', queue: 'mons-shop-stripe-fulfillment' },
  ]);
  assert.equal(config.observability.logs.head_sampling_rate, 1);
  assert.equal(config.observability.logs.invocation_logs, false);
});
