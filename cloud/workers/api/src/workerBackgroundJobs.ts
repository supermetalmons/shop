import { isExactStripeCheckoutFulfillmentJobV1 } from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import { loadCommerceAuthorityControl } from './commerceRepository.js';
import { processNotificationQueueMessage } from './notificationEnqueue.js';
import { processRevealBackgroundJobMessage } from './revealDudes.js';
import { processStripeCheckoutFulfillmentJob } from './stripeCheckoutFulfillment.js';

const NOTIFICATION_EMAIL_QUEUE_NAME = 'mons-shop-notification-emails';
const REVEAL_BACKGROUND_QUEUE_NAME = 'mons-shop-reveal-reconciliation';
const STRIPE_FULFILLMENT_QUEUE_NAME = 'mons-shop-stripe-fulfillment';
const STRIPE_FULFILLMENT_TIMEOUT_MS = 180_000;
const STRIPE_FULFILLMENT_CLEANUP_GRACE_MS = 60_000;
const STRIPE_FULFILLMENT_MAX_RETRIES = 10;
const STRIPE_FULFILLMENT_TERMINAL_ATTEMPT = STRIPE_FULFILLMENT_MAX_RETRIES + 1;
const STRIPE_FULFILLMENT_RETRY_DELAY_SECONDS = 60;

export type BackgroundJobProcessors = {
  notification: typeof processNotificationQueueMessage;
  reveal: typeof processRevealBackgroundJobMessage;
  fulfillment: typeof processStripeFulfillmentMessage;
  log: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
};

type BackgroundJobProcessor = (message: Message<unknown>, env: Env) => Promise<void>;

type BackgroundJobRoute = Readonly<{
  processor: BackgroundJobProcessor;
  requiresCommerce: boolean;
}>;

export async function processStripeFulfillmentMessage(
  message: Message<unknown>,
  env: Env,
  overrides: {
    process?: typeof processStripeCheckoutFulfillmentJob;
    log?: (entry: Record<string, unknown>) => void;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const process = overrides.process || processStripeCheckoutFulfillmentJob;
  const log = overrides.log || ((entry: Record<string, unknown>) => console.log(entry));
  if (!isExactStripeCheckoutFulfillmentJobV1(message.body)) {
    throw new Error('Invalid Stripe checkout fulfillment queue message');
  }
  const job = message.body;
  const timeoutMs = overrides.timeoutMs ?? STRIPE_FULFILLMENT_TIMEOUT_MS;
  const controller = new AbortController();
  const persistenceController = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Stripe checkout fulfillment timed out', 'TimeoutError')),
    timeoutMs,
  );
  const persistenceTimeout = setTimeout(
    () => persistenceController.abort(new DOMException('Stripe checkout fulfillment persistence timed out', 'TimeoutError')),
    timeoutMs + STRIPE_FULFILLMENT_CLEANUP_GRACE_MS,
  );
  log({
    event: 'stripe_fulfillment_job_started',
    queueMessageId: message.id,
    queueAttempts: message.attempts,
    dropId: job.dropId,
    sessionId: job.sessionId,
    stripeEventId: job.stripeEventId,
    stripeEventType: job.stripeEventType,
    queueAgeMs: Math.max(0, Date.now() - job.enqueuedAtMs),
  });
  try {
    const result = await process(job, env, controller.signal, {
      persistenceSignal: persistenceController.signal,
      treatRetryableFailureAsTerminal: message.attempts >= STRIPE_FULFILLMENT_TERMINAL_ATTEMPT,
    });
    log({
      event: 'stripe_fulfillment_job_completed',
      queueMessageId: message.id,
      queueAttempts: message.attempts,
      dropId: job.dropId,
      sessionId: job.sessionId,
      fulfillmentStatus: result.fulfillment.status,
      ...(result.fulfillment.status === 'ignored' ? { fulfillmentReason: result.fulfillment.reason } : {}),
      notificationOutcome: result.notifications.outcome,
      notificationPublication: result.notifications.publication,
      notificationQueuedJobs: result.notifications.queuedJobs,
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(persistenceTimeout);
  }
}

const defaultBackgroundJobProcessors: BackgroundJobProcessors = {
  notification: processNotificationQueueMessage,
  reveal: processRevealBackgroundJobMessage,
  fulfillment: processStripeFulfillmentMessage,
  log: (entry) => console.log(entry),
  error: (entry) => console.error(entry),
};

function backgroundJobRoute(
  queue: string,
  processors: BackgroundJobProcessors,
): BackgroundJobRoute | null {
  if (queue === NOTIFICATION_EMAIL_QUEUE_NAME) {
    return { processor: processors.notification, requiresCommerce: false };
  }
  if (queue === REVEAL_BACKGROUND_QUEUE_NAME) {
    return { processor: processors.reveal, requiresCommerce: true };
  }
  if (queue === STRIPE_FULFILLMENT_QUEUE_NAME) {
    return { processor: processors.fulfillment, requiresCommerce: true };
  }
  return null;
}

export async function processBackgroundJobBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  overrides: Partial<BackgroundJobProcessors> = {},
): Promise<void> {
  const processors = { ...defaultBackgroundJobProcessors, ...overrides };
  const route = backgroundJobRoute(batch.queue, processors);
  if (!route) {
    processors.error({
      event: 'background_job_unknown_queue',
      queue: batch.queue,
      messageCount: batch.messages.length,
    });
    for (const message of batch.messages) message.retry();
    return;
  }
  if (
    route.requiresCommerce &&
    env.COMMERCE_DB &&
    (await loadCommerceAuthorityControl(env.COMMERCE_DB)).state === 'paused'
  ) {
    processors.log({
      event: 'background_job_commerce_maintenance',
      queue: batch.queue,
      messageCount: batch.messages.length,
    });
    for (const message of batch.messages) message.retry();
    return;
  }
  for (const message of batch.messages) {
    try {
      await route.processor(message, env);
    } catch (error) {
      processors.error({
        event: 'background_job_unhandled_error',
        queue: batch.queue,
        queueMessageId: message.id,
        attempts: message.attempts,
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
      });
      if (batch.queue === STRIPE_FULFILLMENT_QUEUE_NAME) {
        const finalAttempt = message.attempts >= STRIPE_FULFILLMENT_TERMINAL_ATTEMPT;
        processors.log({
          event: finalAttempt ? 'stripe_fulfillment_job_dlq_bound' : 'stripe_fulfillment_job_retry',
          queueMessageId: message.id,
          queueAttempts: message.attempts,
          ...(finalAttempt ? {} : { delaySeconds: STRIPE_FULFILLMENT_RETRY_DELAY_SECONDS }),
        });
        message.retry({ delaySeconds: STRIPE_FULFILLMENT_RETRY_DELAY_SECONDS });
      } else {
        message.retry();
      }
    }
  }
}
