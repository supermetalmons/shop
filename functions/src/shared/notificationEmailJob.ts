import { validateNotificationEmailRecipient } from './notificationSubscription.js';

export const NOTIFICATION_EMAIL_JOB_VERSION = 1 as const;
export const NOTIFICATION_EMAIL_FROM = 'notifications@support.mons.shop';
export const NOTIFICATION_EMAIL_MAX_RECIPIENTS = 16;
export const NOTIFICATION_EMAIL_MAX_SUBJECT_CHARACTERS = 512;
export const NOTIFICATION_EMAIL_MAX_TEXT_BYTES = 32 * 1024;
export const NOTIFICATION_EMAIL_MAX_HTML_BYTES = 64 * 1024;
export const NOTIFICATION_EMAIL_MAX_JOB_BYTES = 96 * 1024;

export const NOTIFICATION_EMAIL_KINDS = [
  'buyer_order_received',
  'buyer_order_shipped',
  'shipper_ready_to_ship',
  'stripe_checkout_manual_review',
] as const;

export type NotificationEmailKind = (typeof NOTIFICATION_EMAIL_KINDS)[number];

export type NotificationEmailJobContext = {
  dropId: string;
  deliveryId?: number;
  sessionId?: string;
};

export type NotificationEmailJobV1 = {
  version: typeof NOTIFICATION_EMAIL_JOB_VERSION;
  jobId: string;
  kind: NotificationEmailKind;
  idempotencyKey: string;
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  context: NotificationEmailJobContext;
};

const JOB_KEYS = [
  'version',
  'jobId',
  'kind',
  'idempotencyKey',
  'recipients',
  'subject',
  'text',
  'html',
  'context',
] as const;
const CONTEXT_KEYS = ['dropId', 'deliveryId', 'sessionId'] as const;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/;
const DROP_ID_PATTERN = /^[a-z0-9_]{1,64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_]{1,255}$/;
const UTF8 = new TextEncoder();
const NOTIFICATION_EMAIL_KIND_SET = new Set<string>(NOTIFICATION_EMAIL_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function utf8Length(value: string): number {
  return UTF8.encode(value).byteLength;
}

function isNotificationEmailKind(value: unknown): value is NotificationEmailKind {
  return typeof value === 'string' && NOTIFICATION_EMAIL_KIND_SET.has(value);
}

function isNotificationEmailContext(value: unknown, kind: NotificationEmailKind): value is NotificationEmailJobContext {
  if (!isRecord(value) || !hasOnlyKeys(value, CONTEXT_KEYS) || typeof value.dropId !== 'string') return false;
  if (!DROP_ID_PATTERN.test(value.dropId)) return false;
  const deliveryIdValid = Number.isSafeInteger(value.deliveryId) && Number(value.deliveryId) > 0;
  const sessionIdValid = typeof value.sessionId === 'string' && SESSION_ID_PATTERN.test(value.sessionId);
  if (kind === 'stripe_checkout_manual_review') {
    return sessionIdValid && value.deliveryId === undefined;
  }
  return deliveryIdValid && value.sessionId === undefined;
}

export function notificationEmailJobJson(job: NotificationEmailJobV1): string {
  return JSON.stringify(job);
}

export function notificationEmailJobByteLength(job: NotificationEmailJobV1): number {
  return utf8Length(notificationEmailJobJson(job));
}

export function isNotificationEmailJobV1(value: unknown): value is NotificationEmailJobV1 {
  if (!isRecord(value) || !hasExactKeys(value, JOB_KEYS)) return false;
  if (value.version !== NOTIFICATION_EMAIL_JOB_VERSION || !JOB_ID_PATTERN.test(String(value.jobId || ''))) return false;
  if (!isNotificationEmailKind(value.kind) || !IDEMPOTENCY_KEY_PATTERN.test(String(value.idempotencyKey || ''))) return false;
  if (!Array.isArray(value.recipients) || value.recipients.length < 1 || value.recipients.length > NOTIFICATION_EMAIL_MAX_RECIPIENTS) {
    return false;
  }
  if (!value.recipients.every((recipient) => (
    typeof recipient === 'string' &&
    validateNotificationEmailRecipient(recipient) === recipient
  ))) return false;
  if (new Set(value.recipients.map((recipient) => recipient.toLowerCase())).size !== value.recipients.length) return false;
  if (typeof value.subject !== 'string' || !value.subject || value.subject.length > NOTIFICATION_EMAIL_MAX_SUBJECT_CHARACTERS) {
    return false;
  }
  if (typeof value.text !== 'string' || !value.text || utf8Length(value.text) > NOTIFICATION_EMAIL_MAX_TEXT_BYTES) return false;
  if (typeof value.html !== 'string' || !value.html || utf8Length(value.html) > NOTIFICATION_EMAIL_MAX_HTML_BYTES) return false;
  if (!isNotificationEmailContext(value.context, value.kind)) return false;
  return utf8Length(JSON.stringify(value)) <= NOTIFICATION_EMAIL_MAX_JOB_BYTES;
}

function requireNotificationEmailJobV1(value: unknown): NotificationEmailJobV1 {
  if (!isNotificationEmailJobV1(value)) throw new Error('Invalid notification email job');
  return value;
}

export function createNotificationEmailJobV1(
  value: Omit<NotificationEmailJobV1, 'version' | 'jobId'> & { jobId?: string },
  createJobId: () => string = () => crypto.randomUUID(),
): NotificationEmailJobV1 {
  const job: NotificationEmailJobV1 = {
    version: NOTIFICATION_EMAIL_JOB_VERSION,
    jobId: value.jobId || createJobId(),
    kind: value.kind,
    idempotencyKey: value.idempotencyKey,
    recipients: [...value.recipients],
    subject: value.subject,
    text: value.text,
    html: value.html,
    context: { ...value.context },
  };
  return requireNotificationEmailJobV1(job);
}
