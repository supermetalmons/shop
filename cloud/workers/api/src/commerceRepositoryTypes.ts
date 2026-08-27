import { ProfileReadError } from './dataAccess.js';

export type CommerceDocumentKind =
  | 'delivery_order'
  | 'stripe_checkout'
  | 'claim_code'
  | 'box_assignment'
  | 'dude_assignment'
  | 'dude_pool'
  | 'offchain_order'
  | 'admin_irl_redeem_request'
  | 'admin_irl_redeem_pack_marker'
  | 'admin_irl_redeem_receipt_marker';

export type CommerceJsonValue =
  | null
  | boolean
  | number
  | string
  | CommerceJsonValue[]
  | { [key: string]: CommerceJsonValue };

export type CommerceDocumentData = { [key: string]: CommerceJsonValue };

export type CommerceDocumentKey<K extends CommerceDocumentKind = CommerceDocumentKind> = Readonly<{
  documentId: string;
  dropId: string | null;
  kind: K;
  path: string;
}>;

export type CommerceTimestamp = Readonly<{
  nanos: number;
  seconds: number;
}>;

export type CommerceDocumentRecord<
  T extends CommerceDocumentData = CommerceDocumentData,
  K extends CommerceDocumentKind = CommerceDocumentKind,
> = Readonly<{
  createTime: string;
  data: T;
  key: CommerceDocumentKey<K>;
  processedAt: CommerceTimestamp | null;
  updateTime: string;
  version: number;
}>;

export type CommerceIndexedField =
  | 'buyerOrderReceivedEmailState'
  | 'fulfillmentProcessor'
  | 'fulfillmentStatus'
  | 'irlClaimCode'
  | 'manualRefundReviewRequired'
  | 'owner'
  | 'packStatusProjectionNextAttemptAtMs'
  | 'packStatusProjectionState'
  | 'shipperReadyToShipEmailState'
  | 'source'
  | 'status';

export type CommerceOrderField = CommerceIndexedField | 'documentPath' | 'processedAt';

export type CommerceFilterValue = string | number | boolean;

export type CommerceQuery = Readonly<{
  dropId?: string | null;
  filters?: readonly Readonly<{
    field: CommerceIndexedField;
    op: 'equal' | 'in';
    value: CommerceFilterValue | readonly CommerceFilterValue[];
  }>[];
  kind: CommerceDocumentKind;
  limit?: number;
  orderBy?: readonly Readonly<{
    direction: 'asc' | 'desc';
    field: CommerceOrderField;
  }>[];
  startAfter?: readonly (CommerceFilterValue | CommerceTimestamp)[];
}>;

export type CommerceWriteConflictCode = 'aborted' | 'already-exists' | 'failed-precondition';

export class CommerceWriteConflict extends Error {
  constructor(readonly code: CommerceWriteConflictCode = 'aborted') {
    super('Commerce document changed during the write.');
    this.name = 'CommerceWriteConflict';
  }
}

export class CommerceRepositoryError extends ProfileReadError {
  constructor(
    code: 'invalid-argument' | 'unavailable' | 'internal',
    message: string,
  ) {
    super(code, code === 'invalid-argument' ? 400 : code === 'unavailable' ? 503 : 500, message);
    this.name = 'CommerceRepositoryError';
  }
}

class ServerTimestampValue {
  readonly kind = 'server-timestamp';
}

class DeleteFieldValue {
  readonly kind = 'delete-field';
}

class IncrementValue {
  readonly kind = 'increment';

  constructor(readonly amount: number) {}
}

class TimestampValue {
  readonly kind = 'timestamp';

  constructor(readonly value: CommerceTimestamp) {}
}

class ArrayUnionValue {
  readonly kind = 'array-union';

  constructor(readonly values: readonly CommerceJsonValue[]) {}
}

export type CommerceUpdateValue =
  | CommerceJsonValue
  | ServerTimestampValue
  | DeleteFieldValue
  | IncrementValue
  | TimestampValue
  | ArrayUnionValue;

export type CommerceDocumentWriteData = { [key: string]: CommerceUpdateValue };

export const commerceFieldValue = Object.freeze({
  arrayUnion: (...values: CommerceJsonValue[]): CommerceUpdateValue =>
    Object.freeze(new ArrayUnionValue(Object.freeze([...values]))),
  delete: (): CommerceUpdateValue => Object.freeze(new DeleteFieldValue()),
  increment: (amount: number): CommerceUpdateValue => Object.freeze(new IncrementValue(amount)),
  serverTimestamp: (): CommerceUpdateValue => Object.freeze(new ServerTimestampValue()),
  timestamp: (seconds: number, nanos = 0): CommerceUpdateValue =>
    Object.freeze(new TimestampValue(Object.freeze({ seconds, nanos }))),
});

export function isCommerceServerTimestamp(value: unknown): value is ServerTimestampValue {
  return value instanceof ServerTimestampValue;
}

export function isCommerceDeleteField(value: unknown): value is DeleteFieldValue {
  return value instanceof DeleteFieldValue;
}

export function isCommerceIncrement(value: unknown): value is IncrementValue {
  return value instanceof IncrementValue;
}

export function isCommerceTimestamp(value: unknown): value is TimestampValue {
  return value instanceof TimestampValue;
}

export function isCommerceArrayUnion(value: unknown): value is ArrayUnionValue {
  return value instanceof ArrayUnionValue;
}
