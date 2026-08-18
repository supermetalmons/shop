import {
  isExactSubscribeToNotificationsResponse,
} from '../../functions/src/shared/notificationSubscription.ts';
import type {
  SubscribeToNotificationsRequest,
  SubscribeToNotificationsResponse,
} from '../types';
import { monsApiOrigin } from './monsApiOrigin';

const NOTIFICATION_SUBSCRIPTION_TIMEOUT_MS = 15_000;

type NotificationSubscriptionOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function subscribeToNotifications(
  args: SubscribeToNotificationsRequest,
  options: NotificationSubscriptionOptions = {},
): Promise<SubscribeToNotificationsResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
    options.timeoutMs ?? NOTIFICATION_SUBSCRIPTION_TIMEOUT_MS,
  );
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const response = await fetch(`${monsApiOrigin()}/notifications/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      cache: 'no-store',
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new Error('Notification API returned malformed JSON', { cause: error });
    }
    if (!response.ok) throw new Error(`Notification API request failed: http-${response.status}`);
    if (!isExactSubscribeToNotificationsResponse(payload)) {
      throw new Error('Notification API returned an invalid subscription response');
    }
    return payload;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
