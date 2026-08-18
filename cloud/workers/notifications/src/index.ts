import type { CreateEmailOptions } from 'resend';
import {
  NOTIFICATION_EMAIL_FROM,
  isNotificationEmailJobV1,
  type NotificationEmailJobV1,
} from '../../../../functions/src/shared/notificationEmailJob.js';
import { isRetryableResendError, summarizeResendError, type ResendErrorSummary } from '../../../../functions/src/shared/resendErrors.js';

const RETRY_DELAYS_SECONDS = [30, 2 * 60, 10 * 60, 30 * 60, 2 * 60 * 60] as const;
const RESEND_EMAILS_API_URL = 'https://api.resend.com/emails';
const RESEND_RESPONSE_MAX_BYTES = 16 * 1024;
const RESEND_TIMEOUT_MS = 10_000;

type NotificationEmailSendResult = {
  data: { id?: string } | null;
  error: unknown;
};

export type NotificationEmailSend = (job: NotificationEmailJobV1, apiKey: string) => Promise<NotificationEmailSendResult>;
export type NotificationProviderFetch = typeof fetch;

type NotificationConsumerDependencies = {
  send: NotificationEmailSend;
  log: (entry: Record<string, unknown>) => void;
  warn: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
};

class RetryableNotificationDeliveryError extends Error {
  readonly providerError?: ResendErrorSummary;

  constructor(message: string, providerError?: ResendErrorSummary) {
    super(message);
    this.name = 'RetryableNotificationDeliveryError';
    this.providerError = providerError;
  }
}

function jobLogContext(job: NotificationEmailJobV1): Record<string, unknown> {
  return {
    jobId: job.jobId,
    kind: job.kind,
    recipientCount: job.recipients.length,
    ...job.context,
  };
}

async function readBoundedResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > RESEND_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('resend_response_too_large');
  }
  if (!response.body) throw new Error('resend_response_missing_body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESEND_RESPONSE_MAX_BYTES) throw new Error('resend_response_too_large');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function resendSend(
  job: NotificationEmailJobV1,
  apiKey: string,
  providerFetch: NotificationProviderFetch = fetch,
  timeoutMs = RESEND_TIMEOUT_MS,
): Promise<NotificationEmailSendResult> {
  const payload: CreateEmailOptions = {
    from: NOTIFICATION_EMAIL_FROM,
    to: job.recipients,
    subject: job.subject,
    text: job.text,
    html: job.html,
  };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Resend request timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    const response = await providerFetch(RESEND_EMAILS_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': job.idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await readBoundedResponseJson(response, controller.signal);
    if (response.ok) {
      const id = typeof body === 'object' && body && !Array.isArray(body)
        ? (body as Record<string, unknown>).id
        : undefined;
      return { data: typeof id === 'string' && id ? { id } : null, error: null };
    }
    const providerError = typeof body === 'object' && body && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    return {
      data: null,
      error: {
        name: typeof providerError.name === 'string' ? providerError.name : 'unknown_resend_error',
        message: typeof providerError.message === 'string' ? providerError.message : 'Unknown Resend error',
        statusCode: response.status,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

const defaultDependencies: NotificationConsumerDependencies = {
  send: resendSend,
  log: (entry) => console.log(entry),
  warn: (entry) => console.warn(entry),
  error: (entry) => console.error(entry),
};

export function notificationEmailRetryDelaySeconds(attempts: number): number {
  const index = Math.min(Math.max(1, Math.floor(attempts)) - 1, RETRY_DELAYS_SECONDS.length - 1);
  return RETRY_DELAYS_SECONDS[index];
}

async function deliverNotificationEmail(
  job: NotificationEmailJobV1,
  apiKey: string,
  dependencies: NotificationConsumerDependencies,
): Promise<{ status: 'sent'; messageId: string } | { status: 'failed_permanent'; providerError: ResendErrorSummary }> {
  if (!apiKey) throw new RetryableNotificationDeliveryError('resend_api_key_not_configured');
  let result: NotificationEmailSendResult;
  try {
    result = await dependencies.send(job, apiKey);
  } catch {
    throw new RetryableNotificationDeliveryError('resend_request_failed');
  }
  if (result.error) {
    const providerError = summarizeResendError(result.error);
    if (isRetryableResendError(providerError)) {
      throw new RetryableNotificationDeliveryError('resend_retryable_error', providerError);
    }
    return { status: 'failed_permanent', providerError };
  }
  const messageId = typeof result.data?.id === 'string' && result.data.id ? result.data.id : '';
  if (!messageId) throw new RetryableNotificationDeliveryError('resend_invalid_success_response');
  return { status: 'sent', messageId };
}

export async function processNotificationEmailBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  overrides: Partial<NotificationConsumerDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  for (const message of batch.messages) {
    if (!isNotificationEmailJobV1(message.body)) {
      dependencies.error({
        event: 'notification_email_invalid_job',
        queueMessageId: message.id,
        attempts: message.attempts,
      });
      message.ack();
      continue;
    }
    const job = message.body;
    try {
      const result = await deliverNotificationEmail(job, env.RESEND_API_KEY, dependencies);
      if (result.status === 'failed_permanent') {
        dependencies.error({
          event: 'notification_email_failed_permanent',
          ...jobLogContext(job),
          attempts: message.attempts,
          providerError: {
            name: result.providerError.name,
            statusCode: result.providerError.statusCode,
          },
        });
        message.ack();
        continue;
      }
      dependencies.log({
        event: 'notification_email_sent',
        ...jobLogContext(job),
        attempts: message.attempts,
        messageId: result.messageId,
      });
      message.ack();
    } catch (error) {
      const delaySeconds = notificationEmailRetryDelaySeconds(message.attempts);
      const providerError = error instanceof RetryableNotificationDeliveryError ? error.providerError : undefined;
      dependencies.warn({
        event: 'notification_email_retry',
        ...jobLogContext(job),
        attempts: message.attempts,
        delaySeconds,
        reason: error instanceof Error ? error.message : 'unknown_error',
        ...(providerError ? {
          providerError: { name: providerError.name, statusCode: providerError.statusCode },
        } : {}),
      });
      message.retry({ delaySeconds });
    }
  }
}

export default {
  queue(batch, env) {
    return processNotificationEmailBatch(batch, env);
  },
} satisfies ExportedHandler<Env, unknown>;
