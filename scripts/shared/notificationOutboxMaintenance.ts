import { createHash } from 'node:crypto';
import {
  LEGACY_NOTIFICATION_FIELDS,
  notificationOutboxState,
  parseNotificationOutboxRecord,
  type NotificationOutboxEntry,
  type NotificationOutboxFamily,
  type NotificationOutboxRecord,
} from '../../shared/notificationOutbox.ts';
import { isNotificationEmailJobId, isNotificationEmailJobV1 } from '../../shared/notificationEmailJob.ts';
import type { CommerceD1Document } from './commerceD1Maintenance.ts';

function integer(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid legacy notification ${label}.`);
  return Number(value);
}

function optionalTime(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : integer(value, label);
}

function error(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.length || value.length > 256) throw new Error('Invalid legacy notification error code.');
  return value;
}

function generation(parentPath: string, family: NotificationOutboxFamily): string {
  const digest = createHash('sha256').update(`${parentPath}\n${family}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function base(document: CommerceD1Document, family: NotificationOutboxFamily): NotificationOutboxRecord {
  const createdAtMs = Date.parse(document.createTime);
  const updatedAtMs = Date.parse(document.updateTime);
  return {
    parentPath: document.path, family, dropId: document.dropId || '', generation: generation(document.path, family),
    outcome: null, state: 'queued', entries: [], revision: 1, attemptCount: 0, nextAttemptAtMs: null,
    claimId: null, claimExpiresAtMs: null, retryUntilMs: 0,
    createdAtMs: integer(createdAtMs, 'creation time'), updatedAtMs: integer(updatedAtMs, 'update time'), lastErrorCode: null,
  };
}

function hasFields(data: Record<string, unknown>, prefixes: readonly string[]): boolean {
  return LEGACY_NOTIFICATION_FIELDS.some((field) => prefixes.some((prefix) => field.startsWith(prefix)) && Object.hasOwn(data, field));
}

function deliveryId(document: CommerceD1Document): number {
  const value = Number(document.documentId);
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== document.documentId ||
    (document.data.deliveryId !== undefined && Number(document.data.deliveryId) !== value)) {
    throw new Error(`Invalid legacy notification delivery identity: ${document.path}.`);
  }
  return value;
}

function legacyEntry(args: {
  document: CommerceD1Document;
  prefix: string;
  kind: NotificationOutboxEntry['kind'];
  expectedKey: string;
  allowRetry?: boolean;
}): NotificationOutboxEntry | null {
  const { data } = args.document;
  if (!hasFields(data, [args.prefix])) return null;
  const state = data[`${args.prefix}State`];
  const jobId = data[`${args.prefix}JobId`];
  const storedIdempotencyKey = data[`${args.prefix}IdempotencyKey`];
  const queuedAtMs = optionalTime(data[`${args.prefix}QueuedAt`], 'queued timestamp');
  const legacyQueuedShipment = args.kind === 'buyer_order_shipped' && state === 'queued' &&
    storedIdempotencyKey === undefined && queuedAtMs !== undefined;
  const idempotencyKey = legacyQueuedShipment ? args.expectedKey : storedIdempotencyKey;
  if (!['pending', 'queued', 'failed'].includes(String(state)) || !isNotificationEmailJobId(jobId) ||
    (idempotencyKey !== args.expectedKey && (!args.allowRetry || idempotencyKey !== `${args.expectedKey}:retry:${jobId}`))) {
    throw new Error(`Invalid legacy notification identity: ${args.document.path} ${args.prefix}.`);
  }
  const payload = data[`${args.prefix}Job`];
  if (payload !== undefined && (!isNotificationEmailJobV1(payload) || payload.jobId !== jobId ||
    payload.kind !== args.kind || payload.idempotencyKey !== idempotencyKey ||
    payload.context.dropId !== args.document.dropId || payload.context.deliveryId !== deliveryId(args.document))) {
    throw new Error(`Invalid legacy notification payload: ${args.document.path} ${args.prefix}.`);
  }
  return {
    kind: args.kind, jobId, idempotencyKey: String(idempotencyKey), state: state as NotificationOutboxEntry['state'],
    ...(isNotificationEmailJobV1(payload) && state === 'pending' ? { payload } : {}),
    ...(queuedAtMs !== undefined ? { queuedAtMs } : {}),
  };
}

function ready(document: CommerceD1Document): NotificationOutboxRecord | null {
  const data = document.data;
  if (!hasFields(data, ['buyerOrderReceivedEmail', 'shipperReadyToShipEmail', 'readyToShipNotification'])) return null;
  const id = deliveryId(document);
  const entries = [
    legacyEntry({ document, prefix: 'buyerOrderReceivedEmail', kind: 'buyer_order_received', expectedKey: `${document.dropId}:${id}:order_received` }),
    legacyEntry({ document, prefix: 'shipperReadyToShipEmail', kind: 'shipper_ready_to_ship', expectedKey: `${document.dropId}:${id}:ready_to_ship` }),
  ].filter((entry): entry is NotificationOutboxEntry => entry !== null);
  if (!entries.length) throw new Error(`Legacy ready notification has no identities: ${document.path}.`);
  const state = notificationOutboxState(entries);
  const claimId = data.readyToShipNotificationPublishClaimId ?? null;
  const claimExpiresAtMs = data.readyToShipNotificationPublishClaimExpiresAtMs ?? null;
  const attemptCount = integer(data.readyToShipNotificationPublishAttemptCount, 'attempt count', state === 'pending' ? undefined : 0);
  const retryUntilMs = integer(data.readyToShipNotificationRetryUntilMs, 'retry deadline', state === 'pending' ? undefined : 0);
  return parseNotificationOutboxRecord({
    ...base(document, 'ready'), entries, state, attemptCount, retryUntilMs, claimId, claimExpiresAtMs,
    nextAttemptAtMs: state === 'pending' ? claimExpiresAtMs ?? 0 : null,
    lastErrorCode: error(data.readyToShipNotificationLastErrorCode),
  });
}

function shipped(document: CommerceD1Document): NotificationOutboxRecord | null {
  if (!hasFields(document.data, ['buyerOrderShippedEmail'])) return null;
  const entry = legacyEntry({ document, prefix: 'buyerOrderShippedEmail', kind: 'buyer_order_shipped',
    expectedKey: `${document.dropId}:${deliveryId(document)}:order_shipped`, allowRetry: true });
  if (!entry || entry.state === 'failed') throw new Error(`Invalid legacy shipped notification state: ${document.path}.`);
  const ambiguous = entry.state === 'pending';
  return parseNotificationOutboxRecord({
    ...base(document, 'shipped'), state: ambiguous ? 'failed' : 'queued',
    entries: [{ ...entry, ...(ambiguous ? { state: 'failed', errorCode: 'legacy_shipped_delivery_unknown' } : {}) }],
    lastErrorCode: ambiguous ? 'legacy_shipped_delivery_unknown' : null,
  });
}

function stripe(document: CommerceD1Document): NotificationOutboxRecord | null {
  const data = document.data;
  if (!hasFields(data, ['stripeTerminalNotification'])) return null;
  const marker = data.stripeTerminalNotification;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw new Error(`Invalid legacy Stripe notification: ${document.path}.`);
  const outbox = marker as Record<string, unknown>;
  const state = data.stripeTerminalNotificationState;
  const outcome = outbox.outcome;
  const jobIds = outbox.jobIds;
  if (outbox.version !== 1 || !['pending', 'queued', 'failed'].includes(String(state)) ||
    !['fulfilled', 'manual_review'].includes(String(outcome)) || !jobIds || typeof jobIds !== 'object' || Array.isArray(jobIds)) {
    throw new Error(`Invalid legacy Stripe notification identity: ${document.path}.`);
  }
  const ids = jobIds as Record<string, unknown>;
  const kinds = outcome === 'fulfilled' ? ['buyer_order_received', 'shipper_ready_to_ship'] as const : ['stripe_checkout_manual_review'] as const;
  const id = outcome === 'fulfilled' ? integer(Number(data.deliveryId), 'Stripe delivery id') : null;
  if (id === 0) throw new Error(`Invalid legacy Stripe delivery identity: ${document.path}.`);
  const jobs = outbox.jobs;
  if (jobs !== undefined && (!Array.isArray(jobs) || jobs.length > kinds.length)) throw new Error('Invalid legacy Stripe notification payloads.');
  const snapshots = new Map<string, NonNullable<NotificationOutboxEntry['payload']>>();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!isNotificationEmailJobV1(job) || snapshots.has(job.kind) || !kinds.some((kind) => kind === job.kind)) throw new Error('Invalid legacy Stripe notification payload.');
    snapshots.set(job.kind, job);
  }
  const entries = kinds.map((kind): NotificationOutboxEntry => {
    const jobId = ids[kind];
    const idempotencyKey = outcome === 'manual_review' ? `${document.dropId}:${document.documentId}:stripe_manual_review`
      : `${document.dropId}:${id}:${kind === 'buyer_order_received' ? 'order_received' : 'ready_to_ship'}`;
    if (!isNotificationEmailJobId(jobId)) throw new Error(`Invalid legacy Stripe notification job identity: ${document.path}.`);
    const payload = snapshots.get(kind);
    if (payload && (payload.jobId !== jobId || payload.idempotencyKey !== idempotencyKey ||
      payload.context.dropId !== document.dropId || (outcome === 'manual_review'
        ? payload.context.sessionId !== document.documentId : payload.context.deliveryId !== id))) throw new Error('Invalid legacy Stripe notification payload identity.');
    const queuedAtMs = optionalTime(data.stripeTerminalNotificationQueuedAt, 'Stripe queued timestamp');
    return { kind, jobId, idempotencyKey, state: state as NotificationOutboxEntry['state'],
      ...(payload && state !== 'queued' ? { payload } : {}), ...(queuedAtMs !== undefined ? { queuedAtMs } : {}) };
  });
  const nextAttemptAtMs = optionalTime(data.stripeTerminalNotificationNextAttemptAtMs, 'Stripe due timestamp') ?? null;
  const record = parseNotificationOutboxRecord({
    ...base(document, 'stripe_terminal'), entries, state, outcome,
    attemptCount: integer(outbox.attemptCount, 'Stripe attempt count'), retryUntilMs: integer(outbox.retryUntilMs, 'Stripe retry deadline'),
    nextAttemptAtMs, claimId: outbox.claimId ?? null, claimExpiresAtMs: outbox.claimId ? nextAttemptAtMs : null,
    lastErrorCode: error(data.stripeTerminalNotificationLastError),
  });
  if (record.state !== 'pending' || jobs === undefined) return record;
  const frozenEntries = record.entries.map((entry) => snapshots.has(entry.kind)
    ? entry : { ...entry, state: 'queued' as const });
  const frozenState = notificationOutboxState(frozenEntries);
  return parseNotificationOutboxRecord({
    ...record, entries: frozenEntries, state: frozenState,
    ...(frozenState === 'queued' ? { nextAttemptAtMs: null, claimId: null, claimExpiresAtMs: null } : {}),
  });
}

export function planNotificationOutboxBackfill(document: CommerceD1Document): NotificationOutboxRecord[] {
  try {
    return document.kind === 'delivery_order' ? [ready(document), shipped(document)].filter((row): row is NotificationOutboxRecord => row !== null)
      : document.kind === 'stripe_checkout' ? [stripe(document)].filter((row): row is NotificationOutboxRecord => row !== null) : [];
  } catch (cause) {
    throw new Error(`Notification backfill validation failed for ${document.path}: ${cause instanceof Error ? cause.message : 'invalid marker'}`, { cause });
  }
}
