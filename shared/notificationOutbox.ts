import {
  isNotificationEmailIdempotencyKey,
  isNotificationEmailJobId,
  isNotificationEmailJobV1,
  type NotificationEmailJobV1,
  type NotificationEmailKind,
} from './notificationEmailJob.ts';

export type NotificationOutboxFamily = 'ready' | 'stripe_terminal' | 'shipped';
export type NotificationOutboxState = 'pending' | 'queued' | 'failed' | 'cancelled';
export type NotificationOutboxEntry = {
  kind: NotificationEmailKind;
  jobId: string;
  idempotencyKey: string;
  state: 'pending' | 'queued' | 'failed';
  payload?: NotificationEmailJobV1;
  queuedAtMs?: number;
  errorCode?: string;
};

export type NotificationOutboxRecord = {
  parentPath: string;
  family: NotificationOutboxFamily;
  dropId: string;
  generation: string;
  outcome: 'fulfilled' | 'manual_review' | null;
  state: NotificationOutboxState;
  entries: NotificationOutboxEntry[];
  revision: number;
  attemptCount: number;
  nextAttemptAtMs: number | null;
  claimId: string | null;
  claimExpiresAtMs: number | null;
  retryUntilMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  lastErrorCode: string | null;
};

export type NotificationOutboxCreate = Pick<NotificationOutboxRecord,
  'parentPath' | 'family' | 'dropId' | 'generation' | 'entries' | 'retryUntilMs'> & {
  outcome?: NotificationOutboxRecord['outcome'];
};

export type NotificationOutboxMutation = Partial<Pick<NotificationOutboxRecord,
  'state' | 'entries' | 'attemptCount' | 'nextAttemptAtMs' | 'claimId' |
  'claimExpiresAtMs' | 'retryUntilMs' | 'lastErrorCode'>>;

const NOTIFICATION_OUTBOX_MAX_ENTRIES_BYTES = 200 * 1024;

export const LEGACY_NOTIFICATION_FIELDS = [
  'buyerOrderReceivedEmailState', 'buyerOrderReceivedEmailJobId', 'buyerOrderReceivedEmailJob',
  'buyerOrderReceivedEmailIdempotencyKey', 'buyerOrderReceivedEmailQueuedAt',
  'shipperReadyToShipEmailState', 'shipperReadyToShipEmailJobId', 'shipperReadyToShipEmailJob',
  'shipperReadyToShipEmailIdempotencyKey', 'shipperReadyToShipEmailQueuedAt',
  'readyToShipNotificationRetryUntilMs', 'readyToShipNotificationPublishAttemptCount',
  'readyToShipNotificationPublishClaimId', 'readyToShipNotificationPublishClaimExpiresAtMs',
  'readyToShipNotificationFailedAt', 'readyToShipNotificationLastErrorCode',
  'stripeTerminalNotification', 'stripeTerminalNotificationState',
  'stripeTerminalNotificationNextAttemptAtMs', 'stripeTerminalNotificationQueuedAt',
  'stripeTerminalNotificationLastError', 'buyerOrderShippedEmailState',
  'buyerOrderShippedEmailJobId', 'buyerOrderShippedEmailIdempotencyKey', 'buyerOrderShippedEmailQueuedAt',
] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableTime = (value: unknown): value is number | null => value === null || time(value);
const errorCode = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

export function notificationOutboxState(entries: readonly NotificationOutboxEntry[]): Exclude<NotificationOutboxState, 'cancelled'> {
  if (entries.some((entry) => entry.state === 'pending')) return 'pending';
  return entries.some((entry) => entry.state === 'failed') ? 'failed' : 'queued';
}

export function parseNotificationOutboxRecord(value: unknown): NotificationOutboxRecord {
  if (!record(value) || typeof value.parentPath !== 'string' || value.parentPath.length > 1500 ||
    !['ready', 'stripe_terminal', 'shipped'].includes(String(value.family)) ||
    typeof value.dropId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.dropId) ||
    !isNotificationEmailJobId(value.generation) || !['pending', 'queued', 'failed', 'cancelled'].includes(String(value.state)) ||
    !time(value.revision) || value.revision < 1 || !time(value.attemptCount) ||
    !nullableTime(value.nextAttemptAtMs) || !nullableTime(value.claimExpiresAtMs) ||
    !(value.claimId === null || isNotificationEmailJobId(value.claimId)) ||
    (value.state !== 'failed' && (value.claimId === null) !== (value.claimExpiresAtMs === null)) ||
    (value.claimId === null && value.claimExpiresAtMs !== null) ||
    !time(value.retryUntilMs) || !time(value.createdAtMs) || !time(value.updatedAtMs) ||
    value.updatedAtMs < value.createdAtMs || !(value.lastErrorCode === null || errorCode(value.lastErrorCode)) ||
    !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 2 ||
    new TextEncoder().encode(JSON.stringify(value.entries)).byteLength > NOTIFICATION_OUTBOX_MAX_ENTRIES_BYTES) {
    throw new Error('Invalid notification outbox record.');
  }
  const parentPrefix = value.family === 'stripe_terminal' ? 'stripeCheckouts' : 'deliveryOrders';
  if (!value.parentPath.startsWith(`drops/${value.dropId}/${parentPrefix}/`) ||
    value.parentPath.slice(`drops/${value.dropId}/${parentPrefix}/`.length).includes('/') ||
    !value.parentPath.slice(`drops/${value.dropId}/${parentPrefix}/`.length)) {
    throw new Error('Invalid notification outbox parent.');
  }
  if ((value.family === 'stripe_terminal' && value.outcome !== 'fulfilled' && value.outcome !== 'manual_review') ||
    (value.family !== 'stripe_terminal' && value.outcome !== null)) throw new Error('Invalid notification outbox outcome.');
  const allowed = value.family === 'shipped' ? ['buyer_order_shipped'] : value.outcome === 'manual_review'
    ? ['stripe_checkout_manual_review'] : ['buyer_order_received', 'shipper_ready_to_ship'];
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry) || !allowed.includes(String(entry.kind)) || seen.has(String(entry.kind)) ||
      !Object.keys(entry).every((key) => ['kind', 'jobId', 'idempotencyKey', 'state', 'payload', 'queuedAtMs', 'errorCode'].includes(key)) ||
      !isNotificationEmailJobId(entry.jobId) || !isNotificationEmailIdempotencyKey(entry.idempotencyKey) ||
      !['pending', 'queued', 'failed'].includes(String(entry.state)) ||
      (entry.queuedAtMs !== undefined && !time(entry.queuedAtMs)) ||
      (entry.errorCode !== undefined && !errorCode(entry.errorCode)) ||
      (entry.payload !== undefined && (!isNotificationEmailJobV1(entry.payload) ||
        entry.payload.jobId !== entry.jobId || entry.payload.kind !== entry.kind ||
        entry.payload.idempotencyKey !== entry.idempotencyKey || entry.payload.context.dropId !== value.dropId)) ||
      ((entry.state === 'queued' || value.state === 'cancelled') && entry.payload !== undefined)) {
      throw new Error('Invalid notification outbox entry.');
    }
    seen.add(String(entry.kind));
  }
  if ((value.state !== 'cancelled' && value.state !== notificationOutboxState(value.entries as NotificationOutboxEntry[])) ||
    (value.state === 'pending') !== (value.nextAttemptAtMs !== null) ||
    ((value.state === 'queued' || value.state === 'cancelled') && value.claimId !== null) ||
    (value.state === 'pending' && value.claimExpiresAtMs !== null && value.nextAttemptAtMs !== value.claimExpiresAtMs)) {
    throw new Error('Invalid notification outbox lifecycle.');
  }
  return JSON.parse(JSON.stringify(value)) as NotificationOutboxRecord;
}

export function parseNotificationOutboxRow(row: Record<string, unknown>): NotificationOutboxRecord {
  return parseNotificationOutboxRecord({
    parentPath: row.parent_path, family: row.family, dropId: row.drop_id, generation: row.generation,
    outcome: row.outcome, state: row.state, entries: JSON.parse(String(row.entries_json)), revision: row.revision,
    attemptCount: row.attempt_count, nextAttemptAtMs: row.next_attempt_at_ms, claimId: row.claim_id,
    claimExpiresAtMs: row.claim_expires_at_ms, retryUntilMs: row.retry_until_ms,
    createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, lastErrorCode: row.last_error_code,
  });
}

export function shippedNotificationState(outbox: NotificationOutboxRecord | null | undefined): 'pending' | 'queued' | undefined {
  if (outbox?.family !== 'shipped' || outbox.state === 'cancelled') return undefined;
  return outbox.state === 'queued' ? 'queued' : 'pending';
}
