import {
  emptyReconciliationResult, recordReconciliationOutcome, reportReconciliationResult,
  type ReconciliationOptions, type ReconciliationOutcome, type ReconciliationResult,
} from './reconciliationResult.js';

export async function drainReconciliationCandidates<T>(args: {
  signal: AbortSignal;
  checkAbortedBeforeLoad?: boolean;
  cancellationMode?: 'aggregate' | 'throw';
  loadCandidates: () => Promise<readonly T[]>;
  processCandidate: (candidate: T) => Promise<ReconciliationOutcome | 'stop'>;
  failureMessage: string;
  onFailure?: (candidate: T, error: unknown) => void;
} & ReconciliationOptions): Promise<ReconciliationResult> {
  const result = emptyReconciliationResult();
  try {
    if (args.checkAbortedBeforeLoad !== false) args.signal.throwIfAborted();
    const candidates = await args.loadCandidates();
    const failures: unknown[] = [];
    for (const candidate of candidates) {
      if (args.signal.aborted) {
        if (args.cancellationMode === 'throw') throw args.signal.reason;
        failures.push(args.signal.reason);
        break;
      }
      try {
        const outcome = await args.processCandidate(candidate);
        if (outcome === 'stop') break;
        recordReconciliationOutcome(result, outcome);
      } catch (error) {
        recordReconciliationOutcome(result, 'failed');
        try { args.onFailure?.(candidate, error); } catch {}
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, args.failureMessage);
    return result;
  } finally {
    reportReconciliationResult(result, args.onResult);
  }
}
