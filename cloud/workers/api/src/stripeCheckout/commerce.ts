import type { D1CommerceRepository } from '../commerceRepository.js';
import {
  CommerceRepositoryError,
  isCommerceArrayUnion,
  isCommerceDeleteField,
  isCommerceIncrement,
  isCommerceServerTimestamp,
  isCommerceTimestamp,
  type CommerceDocumentWriteData,
  type CommerceJsonValue,
  type CommerceUpdateValue,
} from '../commerceRepositoryTypes.js';

export type StripeCheckoutCommerceContext = {
  repository: Pick<D1CommerceRepository, 'get' | 'run'>;
  nowMs: () => number;
  signal?: AbortSignal;
};

function jsonValue(value: unknown): CommerceJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonValue(entry)]),
    );
  }
  throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout document value.');
}

function updateValue(value: unknown): CommerceUpdateValue {
  if (isCommerceTimestamp(value)) {
    const { seconds, nanos } = value.value;
    const milliseconds = seconds * 1000 + nanos / 1_000_000;
    if (
      !Number.isSafeInteger(seconds) || seconds < 0 ||
      !Number.isInteger(nanos) || nanos < 0 || nanos > 999_999_999 ||
      !Number.isSafeInteger(milliseconds) || milliseconds < 0
    ) throw new CommerceRepositoryError('invalid-argument', 'Invalid Stripe checkout timestamp.');
    return value;
  }
  if (
    isCommerceServerTimestamp(value) || isCommerceDeleteField(value) ||
    isCommerceIncrement(value) || isCommerceArrayUnion(value)
  ) return value;
  return jsonValue(value);
}

export function stripeCheckoutWriteData(data: Record<string, unknown>): CommerceDocumentWriteData {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([field, value]) => [field, updateValue(value)]),
  );
}
