import {
  emptyReconciliationResult, recordReconciliationOutcome, reportReconciliationResult,
  type ReconciliationOptions, type ReconciliationOutcome, type ReconciliationResult,
} from './reconciliationResult.js';
import { raceWithSignal } from './boundedRequest.js';

const RECONCILIATION_PAGE_SIZE = 8;
const RECONCILIATION_INSPECTION_LIMIT = 32;
const RECONCILIATION_BUDGET_MS = 20_000;

type ReconciliationPaging<T> = {
  loadPage: (startAfter: T | undefined, limit: number) => Promise<readonly T[]>;
  candidateKey: (candidate: T) => string;
  probeBacklog: () => Promise<{ hasMore: boolean; oldestDueAgeMs: number | null }>;
  monotonicNowMs?: () => number;
};

type ReconciliationPassArgs<T> = {
  signal: AbortSignal;
  checkAbortedBeforeLoad?: boolean;
  cancellationMode?: 'aggregate' | 'throw';
  processCandidate: (candidate: T) => Promise<ReconciliationOutcome | 'stop'>;
  failureMessage: string;
  onFailure?: (candidate: T, error: unknown) => void;
} & ReconciliationOptions;

export async function drainReconciliationCandidates<T>(args: ReconciliationPassArgs<T> & (
  | { loadCandidates: () => Promise<readonly T[]>; paging?: never }
  | { loadCandidates?: never; paging: ReconciliationPaging<T> }
)): Promise<ReconciliationResult> {
  if (args.paging) return drainPagedReconciliationCandidates(args, args.paging);
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

async function drainPagedReconciliationCandidates<T>(
  args: ReconciliationPassArgs<T>,
  paging: ReconciliationPaging<T>,
): Promise<ReconciliationResult> {
  const result = {
    ...emptyReconciliationResult(), inspected: 0, pages: 0,
    stopReason: 'drained' as NonNullable<ReconciliationResult['stopReason']>,
    hasMore: null as boolean | null, oldestDueAgeMs: null as number | null,
  };
  const monotonicNowMs = paging.monotonicNowMs || (() => performance.now());
  const startedAtMs = monotonicNowMs();
  const failures: unknown[] = [];
  const seen = new Set<string>();
  let startAfter: T | undefined;
  try {
    args.signal.throwIfAborted();
    pages: while (true) {
      if (args.signal.aborted) {
        if (args.cancellationMode === 'throw') throw args.signal.reason;
        failures.push(args.signal.reason);
        break;
      }
      if (result.inspected >= RECONCILIATION_INSPECTION_LIMIT) {
        result.stopReason = 'item-limit';
        break;
      }
      if (monotonicNowMs() - startedAtMs >= RECONCILIATION_BUDGET_MS) {
        result.stopReason = 'time-limit';
        break;
      }
      const limit = Math.min(RECONCILIATION_PAGE_SIZE, RECONCILIATION_INSPECTION_LIMIT - result.inspected);
      let candidates: readonly T[];
      try {
        result.pages += 1;
        candidates = await raceWithSignal(paging.loadPage(startAfter, limit), args.signal);
      } catch (error) {
        if (failures.length) throw new AggregateError([...failures, error], args.failureMessage);
        throw error;
      }
      for (const candidate of candidates) {
        if (args.signal.aborted) {
          if (args.cancellationMode === 'throw') throw args.signal.reason;
          failures.push(args.signal.reason);
          break pages;
        }
        if (monotonicNowMs() - startedAtMs >= RECONCILIATION_BUDGET_MS) {
          result.stopReason = 'time-limit';
          break pages;
        }
        if (result.inspected >= RECONCILIATION_INSPECTION_LIMIT) {
          result.stopReason = 'item-limit';
          break pages;
        }
        result.inspected += 1;
        startAfter = candidate;
        const key = paging.candidateKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const outcome = await args.processCandidate(candidate);
          if (outcome === 'stop') {
            result.stopReason = 'stopped';
            break pages;
          }
          recordReconciliationOutcome(result, outcome);
        } catch (error) {
          recordReconciliationOutcome(result, 'failed');
          try { args.onFailure?.(candidate, error); } catch {}
          failures.push(error);
        }
      }
      if (candidates.length < limit) break;
    }
    if (failures.length) throw new AggregateError(failures, args.failureMessage);
    return result;
  } catch (error) {
    result.stopReason = args.signal.aborted ? 'cancelled' : 'failed';
    throw error;
  } finally {
    if (!args.signal.aborted) {
      try {
        const backlog = await raceWithSignal(paging.probeBacklog(), args.signal);
        result.hasMore = backlog.hasMore;
        result.oldestDueAgeMs = backlog.oldestDueAgeMs;
      } catch {}
    }
    reportReconciliationResult(result, args.onResult);
  }
}
