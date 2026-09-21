import {
  CommerceRepositoryError,
  isCommerceArrayUnion,
  isCommerceDeleteField,
  isCommerceIncrement,
  isCommerceServerTimestamp,
  isCommerceTimestamp,
  type CommerceDocumentData,
  type CommerceDocumentKey,
  type CommerceDocumentKind,
  type CommerceDocumentRecord,
  type CommerceDocumentWriteData,
  type CommerceJsonValue,
  type CommerceTimestamp,
  type CommerceUpdateValue,
} from './commerceRepositoryTypes.js';
import { isCommerceDocumentSegment } from '../../../../shared/commerceDocumentPath.js';
import { isObject, unavailableCommerceData } from './commerceRepositorySupport.js';

export type StoredDocument = {
  createTime: string;
  data: CommerceDocumentData;
  key: CommerceDocumentKey;
  processedAt: CommerceTimestamp | null;
  updateTime: string;
  version: number;
};

const COLLECTIONS: Readonly<Record<Exclude<CommerceDocumentKind, 'claim_code' | 'dude_pool'>, string>> = Object.freeze({
  admin_irl_redeem_pack_marker: 'adminIrlRedeemPackMarkers',
  admin_irl_redeem_receipt_marker: 'adminIrlRedeemReceiptMarkers',
  admin_irl_redeem_request: 'adminIrlRedeemRequests',
  box_assignment: 'boxAssignments',
  delivery_order: 'deliveryOrders',
  dude_assignment: 'dudeAssignments',
  offchain_order: 'offchainOrders',
  stripe_checkout: 'stripeCheckouts',
});

function documentKey<K extends CommerceDocumentKind>(
  kind: K,
  dropId: string | null,
  documentId: string,
): CommerceDocumentKey<K> {
  if (!isCommerceDocumentSegment(documentId) ||
    (kind !== 'claim_code' && !isCommerceDocumentSegment(dropId))) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document key.');
  }
  const path = kind === 'claim_code'
    ? `claimCodes/${documentId}`
    : kind === 'dude_pool'
      ? `drops/${dropId}/meta/dudePool`
      : `drops/${dropId}/${COLLECTIONS[kind as keyof typeof COLLECTIONS]}/${documentId}`;
  return Object.freeze({ documentId, dropId, kind, path });
}

export function commerceKeyFromPath(path: string): CommerceDocumentKey | null {
  const claim = /^claimCodes\/([^/]+)$/.exec(path);
  if (claim) return documentKey('claim_code', null, claim[1]);
  const nested = /^drops\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!nested) return null;
  const [, dropId, collection, documentId] = nested;
  if (collection === 'meta' && documentId === 'dudePool') return documentKey('dude_pool', dropId, documentId);
  const kind = new Map<string, Exclude<CommerceDocumentKind, 'claim_code' | 'dude_pool'>>([
    ['adminIrlRedeemPackMarkers', 'admin_irl_redeem_pack_marker'],
    ['adminIrlRedeemReceiptMarkers', 'admin_irl_redeem_receipt_marker'],
    ['adminIrlRedeemRequests', 'admin_irl_redeem_request'],
    ['boxAssignments', 'box_assignment'],
    ['deliveryOrders', 'delivery_order'],
    ['dudeAssignments', 'dude_assignment'],
    ['offchainOrders', 'offchain_order'],
    ['stripeCheckouts', 'stripe_checkout'],
  ]).get(collection);
  return kind ? documentKey(kind, dropId, documentId) : null;
}

export const commerceKeys = Object.freeze({
  adminIrlRedeemPackMarker: (dropId: string, documentId: string) =>
    documentKey('admin_irl_redeem_pack_marker', dropId, documentId),
  adminIrlRedeemReceiptMarker: (dropId: string, documentId: string) =>
    documentKey('admin_irl_redeem_receipt_marker', dropId, documentId),
  adminIrlRedeemRequest: (dropId: string, documentId: string) =>
    documentKey('admin_irl_redeem_request', dropId, documentId),
  boxAssignment: (dropId: string, documentId: string) => documentKey('box_assignment', dropId, documentId),
  claimCode: (documentId: string) => documentKey('claim_code', null, documentId),
  deliveryOrder: (dropId: string, documentId: string) => documentKey('delivery_order', dropId, documentId),
  dudeAssignment: (dropId: string, documentId: string) => documentKey('dude_assignment', dropId, documentId),
  dudePool: (dropId: string) => documentKey('dude_pool', dropId, 'dudePool'),
  offchainOrder: (dropId: string, documentId: string) => documentKey('offchain_order', dropId, documentId),
  stripeCheckout: (dropId: string, documentId: string) => documentKey('stripe_checkout', dropId, documentId),
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

export function cloneData<T>(value: T): T {
  return structuredClone(value);
}

function validatedJsonValue(value: unknown): CommerceJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document value.');
  }
  if (Array.isArray(value)) return value.map(validatedJsonValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, validatedJsonValue(entry)]));
  }
  throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document value.');
}

function validTimestamp(value: CommerceTimestamp): boolean {
  return Number.isSafeInteger(value.seconds) && value.seconds >= 0 &&
    Number.isInteger(value.nanos) && value.nanos >= 0 && value.nanos <= 999_999_999;
}

export function timestampFromMilliseconds(milliseconds: number): CommerceTimestamp {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce timestamp.');
  }
  const seconds = Math.floor(milliseconds / 1000);
  return { seconds, nanos: (milliseconds - seconds * 1000) * 1_000_000 };
}

export function timestampString(value: CommerceTimestamp): string {
  if (!validTimestamp(value)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce timestamp.');
  const base = new Date(value.seconds * 1000).toISOString().slice(0, 19);
  return `${base}.${String(value.nanos).padStart(9, '0')}Z`;
}

export function timestampMilliseconds(value: CommerceTimestamp): number {
  return value.seconds * 1000 + Math.floor(value.nanos / 1_000_000);
}

export function compareTimestamps(left: CommerceTimestamp, right: CommerceTimestamp): number {
  return left.seconds - right.seconds || left.nanos - right.nanos;
}

export function nextTimestamp(value: CommerceTimestamp): CommerceTimestamp {
  return value.nanos < 999_000_000
    ? { seconds: value.seconds, nanos: (Math.floor(value.nanos / 1_000_000) + 1) * 1_000_000 }
    : { seconds: value.seconds + 1, nanos: 0 };
}

export function dataField(data: CommerceDocumentData, fieldPath: string): unknown {
  let current: unknown = data;
  for (const part of fieldPath.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function setDataField(data: CommerceDocumentData, fieldPath: string, value: CommerceJsonValue | undefined): void {
  const parts = fieldPath.split('.');
  let current: Record<string, CommerceJsonValue> = data;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const existing = current[parts[index]];
    if (!isObject(existing)) current[parts[index]] = {};
    current = current[parts[index]] as Record<string, CommerceJsonValue>;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete current[last];
  else current[last] = value;
}

export function materializeUpdate(
  current: CommerceJsonValue | undefined,
  update: CommerceUpdateValue,
  now: CommerceTimestamp,
): CommerceJsonValue | undefined {
  if (isCommerceDeleteField(update)) return undefined;
  if (isCommerceServerTimestamp(update)) {
    return timestampMilliseconds(now);
  }
  if (isCommerceTimestamp(update)) {
    if (!validTimestamp(update.value)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce timestamp.');
    return timestampMilliseconds(update.value);
  }
  if (isCommerceIncrement(update)) {
    if (!Number.isFinite(update.amount)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce increment.');
    const existing = typeof current === 'number' ? current : 0;
    const value = existing + update.amount;
    if (!Number.isFinite(value)) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce increment.');
    return value;
  }
  if (isCommerceArrayUnion(update)) {
    const values = Array.isArray(current) ? cloneData(current) : [];
    for (const entry of update.values) {
      const validated = validatedJsonValue(entry);
      if (!values.some((existing) => canonicalJson(existing) === canonicalJson(validated))) values.push(validated);
    }
    return values;
  }
  return validatedJsonValue(update);
}

export function processedTimestampForUpdate(
  currentTimestamp: CommerceTimestamp | null,
  currentValue: CommerceJsonValue | undefined,
  update: CommerceUpdateValue,
  value: CommerceJsonValue | undefined,
  now: CommerceTimestamp,
): CommerceTimestamp | null {
  if (isCommerceDeleteField(update)) return null;
  if (isCommerceServerTimestamp(update)) return now;
  if (isCommerceTimestamp(update)) return update.value;
  if (typeof value !== 'number') return null;
  if (currentTimestamp && value === currentValue) return currentTimestamp;
  return timestampFromMilliseconds(value);
}

export function parseTimestampString(value: string): CommerceTimestamp | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}Z`) / 1000;
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return { seconds, nanos: Number((match[2] || '').padEnd(9, '0')) };
}

export function parseRow(value: unknown): StoredDocument {
  if (!isObject(value)) throw unavailableCommerceData();
  const row = value;
  const documentPath = row.document_path;
  const documentId = row.document_id;
  const dropId = row.drop_id;
  const version = row.version;
  const createTime = row.create_time;
  const updateTime = row.update_time;
  const processedAtSeconds = row.processed_at_seconds;
  const processedAtNanos = row.processed_at_nanos;
  if (
    typeof documentPath !== 'string' ||
    typeof documentId !== 'string' ||
    (dropId !== null && typeof dropId !== 'string') ||
    typeof row.document_json !== 'string' ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof createTime !== 'string' ||
    typeof updateTime !== 'string' ||
    (processedAtSeconds !== null && (
      typeof processedAtSeconds !== 'number' || !Number.isSafeInteger(processedAtSeconds)
    )) ||
    (processedAtNanos !== null && (
      typeof processedAtNanos !== 'number' || !Number.isInteger(processedAtNanos)
    ))
  ) throw unavailableCommerceData();
  let data: unknown;
  try {
    data = JSON.parse(row.document_json);
  } catch {
    throw unavailableCommerceData();
  }
  let key: CommerceDocumentKey | null;
  try {
    key = commerceKeyFromPath(documentPath);
  } catch {
    throw unavailableCommerceData();
  }
  if (!isObject(data) || !key || key.kind !== row.document_kind || key.dropId !== dropId || key.documentId !== documentId) {
    throw unavailableCommerceData();
  }
  const projectedProcessedAt = processedAtSeconds === null && processedAtNanos === null
    ? null
    : { seconds: processedAtSeconds, nanos: processedAtNanos };
  const processedAt = projectedProcessedAt;
  if (processedAt && !validTimestamp(processedAt as CommerceTimestamp)) {
    throw unavailableCommerceData();
  }
  return {
    createTime,
    data: data as CommerceDocumentData,
    key,
    processedAt: processedAt as CommerceTimestamp | null,
    updateTime,
    version,
  };
}

export function publicRecord<T extends CommerceDocumentData>(document: StoredDocument): CommerceDocumentRecord<T> {
  return Object.freeze({
    createTime: document.createTime,
    data: cloneData(document.data) as T,
    key: document.key,
    processedAt: document.processedAt ? { ...document.processedAt } : null,
    updateTime: document.updateTime,
    version: document.version,
  });
}

export function assertDocumentIdentity(key: CommerceDocumentKey, expected: CommerceDocumentKey): void {
  if (
    key.path !== expected.path || key.kind !== expected.kind ||
    key.dropId !== expected.dropId || key.documentId !== expected.documentId
  ) throw new CommerceRepositoryError('internal', 'Commerce document identity mismatch.');
}

export function isTimestampLike(value: unknown): value is CommerceTimestamp {
  return isObject(value) && validTimestamp(value as CommerceTimestamp);
}

export function materializeDocument(
  data: CommerceDocumentWriteData,
  now: CommerceTimestamp,
): { data: CommerceDocumentData; processedAt: CommerceTimestamp | null } {
  const materialized: CommerceDocumentData = {};
  let processedAt: CommerceTimestamp | null = null;
  for (const [field, value] of Object.entries(data)) {
    const result = materializeUpdate(undefined, value, now);
    if (result === undefined) throw new CommerceRepositoryError('invalid-argument', 'Invalid commerce document value.');
    materialized[field] = result;
    if (field === 'processedAt') {
      processedAt = processedTimestampForUpdate(null, undefined, value, result, now);
    }
  }
  return { data: materialized, processedAt };
}
