import {
  NOTIFICATION_EMAIL_MAX_JOB_BYTES,
  isNotificationEmailJobV1,
  type NotificationEmailJobV1,
} from '../../../../shared/notificationEmailJob.js';
import {
  NOTIFICATION_ENQUEUE_PATH,
  NOTIFICATION_ENQUEUE_SIGNATURE_HEADER,
  NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER,
  verifyNotificationEnqueueRequest,
} from '../../../../shared/notificationEnqueueAuth.js';

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

async function readBoundedBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > NOTIFICATION_EMAIL_MAX_JOB_BYTES) {
    await cancelBody(request);
    throw new Error('request-too-large');
  }
  if (!request.body) throw new Error('missing-body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > NOTIFICATION_EMAIL_MAX_JOB_BYTES) throw new Error('request-too-large');
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
}

export async function handleNotificationEnqueue(
  request: Request,
  env: Env,
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
    body = await readBoundedBody(request);
  } catch {
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

export { NOTIFICATION_ENQUEUE_PATH };
