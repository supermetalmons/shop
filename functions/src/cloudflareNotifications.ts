import { notificationEmailJobJson, type NotificationEmailJobV1 } from './shared/notificationEmailJob.js';
import {
  NOTIFICATION_ENQUEUE_PATH,
  NOTIFICATION_ENQUEUE_SIGNATURE_HEADER,
  NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER,
  notificationEnqueueTimestamp,
  signNotificationEnqueueRequest,
} from './shared/notificationEnqueueAuth.js';

const MONS_API_ORIGIN = 'https://api.mons.shop';
const NOTIFICATION_ENQUEUE_TIMEOUT_MS = 15_000;

export type NotificationEnqueueFetch = typeof fetch;

export async function enqueueNotificationEmailJob(args: {
  job: NotificationEmailJobV1;
  secret: string;
  fetch?: NotificationEnqueueFetch;
  nowMs?: number;
  origin?: string;
  timeoutMs?: number;
}): Promise<void> {
  if (!args.secret) throw new Error('NOTIFICATION_ENQUEUE_SECRET is not configured');
  const requestBody = notificationEmailJobJson(args.job);
  const timestamp = notificationEnqueueTimestamp(args.nowMs);
  const signature = await signNotificationEnqueueRequest({
    secret: args.secret,
    timestamp,
    body: requestBody,
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Notification enqueue timed out', 'TimeoutError')),
    args.timeoutMs ?? NOTIFICATION_ENQUEUE_TIMEOUT_MS,
  );
  try {
    const response = await (args.fetch || fetch)(`${args.origin || MONS_API_ORIGIN}${NOTIFICATION_ENQUEUE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [NOTIFICATION_ENQUEUE_TIMESTAMP_HEADER]: timestamp,
        [NOTIFICATION_ENQUEUE_SIGNATURE_HEADER]: signature,
      },
      body: requestBody,
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 202) throw new Error(`Notification enqueue failed with status ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}
