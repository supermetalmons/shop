import type { NotificationOutboxFamily } from '../../../../shared/notificationOutbox.js';
import { STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR, type StripeCheckoutFulfillmentEventType } from '../../../../shared/stripeCheckoutFulfillmentJob.js';
import { STRIPE_CHECKOUT_STATUS } from '../../../../shared/stripeCheckoutSession.js';
import { commerceKeyFromPath, parseRow } from './commerceDocumentCodec.js';
import { CommerceRepositoryError, type CommerceDocumentKey, type CommerceJsonValue } from './commerceRepositoryTypes.js';
import { isObject, unavailableCommerceData } from './commerceRepositorySupport.js';

export type StripeTerminalNotificationCandidate = Readonly<{
  key: CommerceDocumentKey<'stripe_checkout'>;
}>;

export type StripeCheckoutRequeueCandidate = Readonly<{
  checkoutPath: string;
  dropId: string;
  sessionId: string;
  stripeEventId: string;
  stripeEventType: StripeCheckoutFulfillmentEventType;
}>;

export type ReadyNotificationCandidate = Readonly<{
  key: CommerceDocumentKey<'delivery_order'>;
  identityFields: { deliveryId?: CommerceJsonValue; dropId?: CommerceJsonValue };
  nextAttemptAtMs: number;
}>;

export type NotificationDueCursor = Readonly<{
  parentPath: string;
  family: NotificationOutboxFamily;
  nextAttemptAtMs: number;
}>;

export type NotificationOutboxCandidate = NotificationDueCursor;

export function validateNotificationDueCursor(value: NotificationDueCursor | undefined, family?: NotificationOutboxFamily): void {
  if (value === undefined) return;
  try {
    if (!isObject(value) || (family !== undefined && value.family !== family)) throw new Error();
    parseNotificationOutboxCandidate({ parent_path: value.parentPath, family: value.family, next_attempt_at_ms: value.nextAttemptAtMs });
  } catch {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid notification due cursor.');
  }
}

function nextAttemptAtMs(row: Record<string, unknown>): number {
  const value = row.next_attempt_at_ms;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unavailableCommerceData();
  return value;
}

function keyFromPath(value: unknown): CommerceDocumentKey {
  if (typeof value !== 'string') throw unavailableCommerceData();
  let key: CommerceDocumentKey | null;
  try {
    key = commerceKeyFromPath(value);
  } catch {
    throw unavailableCommerceData();
  }
  if (!key) throw unavailableCommerceData();
  return key;
}

function documentKey<K extends 'delivery_order' | 'stripe_checkout'>(
  row: Record<string, unknown>,
  kind: K,
): CommerceDocumentKey<K> {
  if (!isObject(row)) throw unavailableCommerceData();
  const key = keyFromPath(row.document_path);
  if (key.kind !== kind || row.document_kind !== kind ||
    key.dropId !== row.drop_id || key.documentId !== row.document_id) {
    throw unavailableCommerceData();
  }
  return { ...key, kind };
}

function optionalJson(value: unknown): CommerceJsonValue | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string') throw unavailableCommerceData();
  try {
    return JSON.parse(value) as CommerceJsonValue;
  } catch {
    throw unavailableCommerceData();
  }
}

export function parseReadyNotificationCandidate(row: Record<string, unknown>): ReadyNotificationCandidate {
  const key = documentKey(row, 'delivery_order');
  const deliveryId = optionalJson(row.delivery_id_json);
  const dropId = optionalJson(row.drop_id_json);
  return {
    key,
    nextAttemptAtMs: nextAttemptAtMs(row),
    identityFields: {
      ...(deliveryId === undefined ? {} : { deliveryId }),
      ...(dropId === undefined ? {} : { dropId }),
    },
  };
}

export function parseStripeTerminalNotificationCandidate(row: Record<string, unknown>): StripeTerminalNotificationCandidate {
  return { key: documentKey(row, 'stripe_checkout') };
}

export function parseStripeCheckoutRequeueCandidate(
  row: Record<string, unknown>,
  cutoffMs: number,
): StripeCheckoutRequeueCandidate | null {
  const document = parseRow(row);
  if (document.key.kind !== 'stripe_checkout' || !document.key.dropId) return null;
  const fields = document.data;
  if (
    (fields.status !== STRIPE_CHECKOUT_STATUS.FULFILLMENT_PENDING && fields.status !== STRIPE_CHECKOUT_STATUS.PROCESSING) ||
    fields.fulfillmentProcessor !== STRIPE_CHECKOUT_FULFILLMENT_PROCESSOR ||
    typeof fields.updatedAt !== 'number' || fields.updatedAt > cutoffMs ||
    typeof fields.lastStripeWebhookEventId !== 'string'
  ) return null;
  return {
    checkoutPath: document.key.path,
    dropId: document.key.dropId,
    sessionId: document.key.documentId,
    stripeEventId: fields.lastStripeWebhookEventId,
    stripeEventType: fields.lastStripeWebhookEventType === 'checkout.session.async_payment_succeeded'
      ? fields.lastStripeWebhookEventType : 'checkout.session.completed',
  };
}

export function parseNotificationOutboxCandidate(row: Record<string, unknown>): NotificationOutboxCandidate {
  if (!isObject(row)) throw unavailableCommerceData();
  const family = row.family;
  if (family !== 'ready' && family !== 'stripe_terminal' && family !== 'shipped') throw unavailableCommerceData();
  const key = keyFromPath(row.parent_path);
  if (key.kind !== (family === 'stripe_terminal' ? 'stripe_checkout' : 'delivery_order')) throw unavailableCommerceData();
  return { parentPath: key.path, family, nextAttemptAtMs: nextAttemptAtMs(row) };
}
