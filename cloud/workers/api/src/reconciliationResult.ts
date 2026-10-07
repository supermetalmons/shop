export type ReconciliationResult = Readonly<{
  attempted: number;
  completed: number;
  deferred: number;
  skipped: number;
  failed: number;
  inspected?: number;
  pages?: number;
  stopReason?: 'drained' | 'item-limit' | 'time-limit' | 'stopped' | 'cancelled' | 'failed';
  hasMore?: boolean | null;
  oldestDueAgeMs?: number | null;
}>;

export type ReconciliationOutcome = 'completed' | 'deferred' | 'skipped' | 'failed';
export type ReconciliationOptions = {
  onResult?: (result: ReconciliationResult) => void;
};

type ReconciliationJob = 'stripe' | 'stripeNotifications' | 'shippedNotifications' | 'packStatus' |
  'notifications' | 'receiptClaims' | 'preorders' | 'ops';

type FailureIdentity = {
  parentPath?: string;
  dropId?: string;
  deliveryId?: number;
  sessionId?: string;
  operationId?: string;
  generation?: number;
  preorderId?: string;
  orderId?: string;
  cleanup?: string;
};

const ERROR_CODES = new Set([
  'invalid-argument', 'unauthenticated', 'permission-denied', 'not-found', 'aborted',
  'failed-precondition', 'resource-exhausted', 'deadline-exceeded', 'unavailable', 'internal',
  'manual-review-required', 'invalid-order-identity', 'invalid-notification-data',
  'notification-outbox-failed', 'projection-failed', 'workflow-failed', 'preorder-failed',
]);

export function emptyReconciliationResult() {
  return { attempted: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 };
}

export function recordReconciliationOutcome(
  result: ReturnType<typeof emptyReconciliationResult>,
  outcome: ReconciliationOutcome,
): void {
  result.attempted += 1;
  result[outcome] += 1;
}

export function reportReconciliationResult(
  result: ReconciliationResult,
  onResult: ReconciliationOptions['onResult'],
): void {
  try { onResult?.({ ...result }); } catch {}
}

export function reconciliationLogger(log: (entry: Record<string, unknown>) => void) {
  return (entry: Record<string, unknown>): void => {
    try { log(entry); } catch {}
  };
}

export function reconciliationErrorSummary(error: unknown): { name: string; code?: string } {
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return {
      name: error instanceof Error ? error.name : 'UnknownError',
      ...(typeof code === 'string' && ERROR_CODES.has(code) ? { code } : {}),
    };
  } catch {
    return { name: 'UnknownError' };
  }
}

export function reportReconciliationFailure(
  job: ReconciliationJob,
  identity: FailureIdentity,
  error?: unknown,
  terminalCode?: string,
): void {
  try {
    const code = terminalCode ?? (error && typeof error === 'object' && 'code' in error ? error.code : undefined);
    console.error({
      event: 'scheduled_reconciliation_item_failed', job, ...identity,
      ...(error === undefined ? {} : { errorName: error instanceof Error ? error.name : 'UnknownError' }),
      ...(typeof code === 'string' && ERROR_CODES.has(code) ? { errorCode: code } : {}),
    });
  } catch {}
}
