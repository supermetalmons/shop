import type { CreateEmailOptions } from 'resend';
import {
  NOTIFICATION_EMAIL_FROM,
  isNotificationEmailJobV1,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';
import {
  isRetryableResendError,
  summarizeResendError,
  type ResendErrorSummary,
} from '../../../../shared/resendErrors.js';
import { readBoundedResponseJson } from './boundedResponse.js';
import { createTimedAbortScope } from './boundedRequest.js';

const RETRY_DELAYS_SECONDS = [30, 2 * 60, 10 * 60, 30 * 60, 2 * 60 * 60] as const;
const RESEND_EMAILS_API_URL = 'https://api.resend.com/emails';
const RESEND_RESPONSE_MAX_BYTES = 16 * 1024;
const RESEND_TIMEOUT_MS = 10_000;

type NotificationEmailSendResult = {
  data: { id?: string } | null;
  error: unknown;
};

export type NotificationEmailSend = (
  job: NotificationEmailJobV1,
  apiKey: string,
) => Promise<NotificationEmailSendResult>;
export type NotificationProviderFetch = typeof fetch;

type NotificationConsumerDependencies = {
  send: NotificationEmailSend;
  log: (entry: Record<string, unknown>) => void;
  warn: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
};

type NotificationConsumerEnv = Pick<Env, 'RESEND_API_KEY'>;

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
  const scope = createTimedAbortScope(new AbortController().signal, {
    timeoutMs,
    timeoutMessage: 'Resend request timed out',
  });
  try {
    const response = await providerFetch(RESEND_EMAILS_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': job.idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: scope.signal,
    });
    const body = await readBoundedResponseJson(response, {
      maxBytes: RESEND_RESPONSE_MAX_BYTES,
      signal: scope.signal,
      contentType: 'ignore',
      createError: (failure, cause) => {
        if (failure !== 'too-large' && failure !== 'missing-body' && cause instanceof Error) {
          return cause;
        }
        const error = new Error(
          failure === 'too-large'
            ? 'resend_response_too_large'
            : failure === 'missing-body'
              ? 'resend_response_missing_body'
              : 'resend_response_invalid',
        );
        if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
        return error;
      },
    });
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
    scope.dispose();
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

export async function processNotificationEmailMessage(
  message: Message<unknown>,
  env: NotificationConsumerEnv,
  overrides: Partial<NotificationConsumerDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (!isNotificationEmailJobV1(message.body)) {
    dependencies.error({
      event: 'notification_email_invalid_job',
      queueMessageId: message.id,
      attempts: message.attempts,
    });
    message.ack();
    return;
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
      return;
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
