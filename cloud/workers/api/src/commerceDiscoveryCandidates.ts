import type { NotificationOutboxFamily } from '../../../../shared/notificationOutbox.js';
import { commerceKeyFromPath } from './commerceDocumentCodec.js';
import type { CommerceDocumentKey, CommerceJsonValue } from './commerceRepositoryTypes.js';
import { isObject, unavailableCommerceData } from './commerceRepositorySupport.js';

export type StripeTerminalNotificationCandidate = Readonly<{
  key: CommerceDocumentKey<'stripe_checkout'>;
}>;

export type ReadyNotificationCandidate = Readonly<{
  key: CommerceDocumentKey<'delivery_order'>;
  identityFields: { deliveryId?: CommerceJsonValue; dropId?: CommerceJsonValue };
}>;

export type NotificationOutboxCandidate = Readonly<{
  parentPath: string;
  family: NotificationOutboxFamily;
}>;

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
    identityFields: {
      ...(deliveryId === undefined ? {} : { deliveryId }),
      ...(dropId === undefined ? {} : { dropId }),
    },
  };
}

export function parseStripeTerminalNotificationCandidate(row: Record<string, unknown>): StripeTerminalNotificationCandidate {
  return { key: documentKey(row, 'stripe_checkout') };
}

export function parseNotificationOutboxCandidate(row: Record<string, unknown>): NotificationOutboxCandidate {
  if (!isObject(row)) throw unavailableCommerceData();
  const family = row.family;
  if (family !== 'ready' && family !== 'stripe_terminal' && family !== 'shipped') throw unavailableCommerceData();
  const key = keyFromPath(row.parent_path);
  if (key.kind !== (family === 'stripe_terminal' ? 'stripe_checkout' : 'delivery_order')) throw unavailableCommerceData();
  return { parentPath: key.path, family };
}
