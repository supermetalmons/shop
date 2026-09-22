import type { FulfillmentManualReviewCursor } from './contracts.ts';
import { isCommerceDocumentSegment } from './commerceDocumentPath.ts';

export const DEFAULT_MANUAL_REVIEW_LIMIT = 25;
export const MAX_MANUAL_REVIEW_LIMIT = 100;

export function manualReviewSortAt(data: { failedAt?: unknown; createdAt?: unknown }): number {
  const failedAt = typeof data.failedAt === 'number' && Number.isFinite(data.failedAt) ? data.failedAt : 0;
  const createdAt = typeof data.createdAt === 'number' && Number.isFinite(data.createdAt) ? data.createdAt : 0;
  return failedAt || createdAt || 0;
}

export function isFulfillmentManualReviewCursor(value: unknown, dropId: string): value is FulfillmentManualReviewCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  const keys = ['version', 'dropId', 'sortAtMs', 'sessionId', 'documentPath'];
  const prefix = `drops/${dropId}/stripeCheckouts/`;
  return Object.keys(cursor).length === keys.length && keys.every((key) => Object.hasOwn(cursor, key)) &&
    cursor.version === 1 && cursor.dropId === dropId &&
    typeof cursor.sortAtMs === 'number' && Number.isFinite(cursor.sortAtMs) &&
    typeof cursor.sessionId === 'string' && cursor.sessionId.length > 0 &&
    typeof cursor.documentPath === 'string' && cursor.documentPath.startsWith(prefix) &&
    isCommerceDocumentSegment(cursor.documentPath.slice(prefix.length));
}

export function manualReviewDocumentCursor(
  dropId: string,
  document: { key: { documentId: string; path: string }; data: Record<string, unknown> },
): FulfillmentManualReviewCursor {
  return {
    version: 1,
    dropId,
    sortAtMs: manualReviewSortAt(document.data),
    sessionId: typeof document.data.sessionId === 'string' && document.data.sessionId.trim()
      ? document.data.sessionId.trim() : document.key.documentId,
    documentPath: document.key.path,
  };
}
