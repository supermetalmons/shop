import { z } from 'zod';
import type {
  SubscribeToNotificationsRequest,
  SubscribeToNotificationsResponse,
} from './contracts.ts';

const NOTIFICATION_EMAIL_RECIPIENT_SCHEMA = z.string().email().max(254);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

export function validateNotificationEmailRecipient(rawEmail: unknown): string | null {
  if (typeof rawEmail !== 'string') return null;
  const email = rawEmail.trim();
  if (!email || !NOTIFICATION_EMAIL_RECIPIENT_SCHEMA.safeParse(email).success) return null;
  return email;
}

export function normalizeNotificationEmailRecipient(rawEmail: unknown): string | null {
  return validateNotificationEmailRecipient(rawEmail)?.toLowerCase() || null;
}

export function isExactSubscribeToNotificationsRequest(
  value: unknown,
): value is SubscribeToNotificationsRequest {
  return isRecord(value) && hasExactKeys(value, ['email']) && typeof value.email === 'string';
}

export function isExactSubscribeToNotificationsResponse(
  value: unknown,
): value is SubscribeToNotificationsResponse {
  return isRecord(value) && hasExactKeys(value, ['subscribed']) && value.subscribed === true;
}
