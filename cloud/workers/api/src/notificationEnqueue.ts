import {
  NOTIFICATION_EMAIL_MAX_JOB_BYTES,
  isNotificationEnqueueSmokeJobV1,
  isNotificationEmailJobV1,
  notificationEmailJobJson,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';
import {
  NOTIFICATION_ENQUEUE_PATH,
  NOTIFICATION_ENQUEUE_SIGNATURE_HEADER,
  NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER,
  notificationEnqueueTimestamp,
  signNotificationEnqueueRequest,
  verifyNotificationEnqueueRequest,
} from '../../../../shared/notificationEnqueueAuth.js';
import { isRequestCancellationError, readBoundedRequestText } from './boundedRequest.js';
import { processNotificationEmailMessage } from './notificationEmailConsumer.js';

const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

type NotificationEnqueueDependencies = {
  nowMs: () => number;
  log: (entry: Record<string, unknown>) => void;
};

const defaultDependencies: NotificationEnqueueDependencies = {
  nowMs: () => Date.now(),
  log: (entry) => console.log(entry),
};

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {}
}

export async function handleNotificationEnqueue(
  request: Request,
  env: Pick<Env, 'NOTIFICATION_EMAIL_QUEUE' | 'NOTIFICATION_ENQUEUE_SECRET'>,
  overrides: Partial<NotificationEnqueueDependencies> = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    await cancelBody(request);
    return response(405, { ok: false, error: 'method-not-allowed' });
  }
  if (String(request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    await cancelBody(request);
    return response(415, { ok: false, error: 'unsupported-media-type' });
  }
  const secret = typeof env.NOTIFICATION_ENQUEUE_SECRET === 'string' ? env.NOTIFICATION_ENQUEUE_SECRET : '';
  if (!secret) {
    await cancelBody(request);
    return response(503, { ok: false, error: 'enqueue-unavailable' });
  }
  let body: string;
  try {
    body = await readBoundedRequestText(request, {
      maxBytes: NOTIFICATION_EMAIL_MAX_JOB_BYTES,
      signal: request.signal,
      createError: (failure) => new Error(failure),
    });
  } catch (error) {
    if (isRequestCancellationError(request, error)) throw error;
    return response(400, { ok: false, error: 'invalid-request' });
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  const authenticated = await verifyNotificationEnqueueRequest({
    secret,
    timestamp: request.headers.get(NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER),
    signature: request.headers.get(NOTIFICATION_ENQUEUE_SIGNATURE_HEADER),
    method: request.method,
    pathname: new URL(request.url).pathname,
    body,
    nowMs: dependencies.nowMs(),
  });
  if (!authenticated) return response(401, { ok: false, error: 'unauthorized' });
  let job: NotificationEmailJobV1;
  try {
    const value: unknown = JSON.parse(body);
    if (!isNotificationEmailJobV1(value)) throw new Error('invalid-job');
    job = value;
  } catch {
    return response(400, { ok: false, error: 'invalid-request' });
  }
  try {
    await env.NOTIFICATION_EMAIL_QUEUE.send(job, { contentType: 'json' });
  } catch (error) {
    dependencies.log({
      event: 'notification_email_enqueue_failed',
      jobId: job.jobId,
      kind: job.kind,
      recipientCount: job.recipients.length,
      ...job.context,
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' },
    });
    return response(503, { ok: false, error: 'enqueue-unavailable' });
  }
  dependencies.log({
    event: 'notification_email_enqueued',
    jobId: job.jobId,
    kind: job.kind,
    recipientCount: job.recipients.length,
    ...job.context,
  });
  return response(202, { queued: true });
}

export async function processNotificationQueueMessage(
  message: Message<unknown>,
  env: Pick<Env, 'NOTIFICATION_EMAIL_QUEUE' | 'NOTIFICATION_ENQUEUE_SECRET' | 'RESEND_API_KEY'>,
  overrides: {
    notification?: typeof processNotificationEmailMessage;
    nowMs?: () => number;
    log?: (entry: Record<string, unknown>) => void;
  } = {},
): Promise<void> {
  if (!isNotificationEnqueueSmokeJobV1(message.body)) {
    return (overrides.notification || processNotificationEmailMessage)(message, env);
  }
  const body = notificationEmailJobJson(message.body.job);
  const timestamp = notificationEnqueueTimestamp((overrides.nowMs || Date.now)());
  const signature = await signNotificationEnqueueRequest({
    secret: env.NOTIFICATION_ENQUEUE_SECRET,
    timestamp,
    body,
  });
  const response = await handleNotificationEnqueue(new Request(
    `https://api.mons.shop${NOTIFICATION_ENQUEUE_PATH}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER]: timestamp,
        [NOTIFICATION_ENQUEUE_SIGNATURE_HEADER]: signature,
      },
      body,
    },
  ), env, { nowMs: overrides.nowMs || Date.now, log: overrides.log || console.log });
  await response.body?.cancel().catch(() => undefined);
  if (response.status !== 202) throw new Error(`notification_enqueue_smoke_failed_${response.status}`);
  (overrides.log || console.log)({
    event: 'notification_enqueue_smoke_forwarded',
    jobId: message.body.job.jobId,
  });
  message.ack();
}

export { NOTIFICATION_ENQUEUE_PATH };
