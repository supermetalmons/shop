import { isPreorderCardId } from '../../shared/preorders.ts';

export type PendingPreorder = {
  requestId: string | null;
  cardIds: number[];
  orderId?: string;
  submittedAttempt?: boolean;
  ethereumAddress?: string | null;
};

function pendingRecord(value: unknown): PendingPreorder | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pending = value as Partial<PendingPreorder>;
  if ((pending.requestId !== null && typeof pending.requestId !== 'string') ||
    !Array.isArray(pending.cardIds) || pending.cardIds.length < 1 || pending.cardIds.length > 3 ||
    !pending.cardIds.every(isPreorderCardId) ||
    (pending.orderId !== undefined && typeof pending.orderId !== 'string') ||
    (pending.ethereumAddress !== undefined && pending.ethereumAddress !== null && typeof pending.ethereumAddress !== 'string') ||
    (pending.submittedAttempt !== undefined && typeof pending.submittedAttempt !== 'boolean')) return null;
  return pending as PendingPreorder;
}

export function isRetiredPendingPreorder(value: unknown): boolean {
  const pending = pendingRecord(value);
  return Boolean(pending && !pending.ethereumAddress && !pending.orderId && !pending.submittedAttempt);
}

export function parsePendingPreorder(value: unknown): PendingPreorder | null {
  const pending = pendingRecord(value);
  return pending && (pending.ethereumAddress || pending.orderId || pending.submittedAttempt) ? pending : null;
}
