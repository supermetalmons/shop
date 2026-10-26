import {
  emptyReconciliationResult, recordReconciliationOutcome, reportReconciliationResult,
  type ReconciliationOptions, type ReconciliationOutcome, type ReconciliationResult,
} from './reconciliationResult.js';
import { raceWithSignal } from './boundedRequest.js';

const RECONCILIATION_PAGE_SIZE = 8;
const RECONCILIATION_INSPECTION_LIMIT = 32;
const RECONCILIATION_BUDGET_MS = 20_000;

export type ReconciliationPage<T> = Readonly<{ candidates: readonly T[]; hasMore: boolean }>;

type ReconciliationPaging<T> = {
  loadPage: (startAfter: T | undefined, limit: number) => Promise<readonly T[] | ReconciliationPage<T>>;
  candidateKey: (candidate: T) => string;
  probeBacklog: () => Promise<{ hasMore: boolean; oldestDueAgeMs: number | null }>;
  monotonicNowMs?: () => number;
  inspectionLimit?: number;
  budgetMs?: number | null;
  awaitInitialLoad?: boolean;
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
  const inspectionLimit = paging.inspectionLimit ?? RECONCILIATION_INSPECTION_LIMIT;
  const budgetMs = paging.budgetMs === null ? Infinity : paging.budgetMs ?? RECONCILIATION_BUDGET_MS;
  const startedAtMs = monotonicNowMs();
  const failures: unknown[] = [];
  const seen = new Set<string>();
  let startAfter: T | undefined;
  try {
    if (!Number.isSafeInteger(inspectionLimit) || inspectionLimit < 1 || !(budgetMs > 0)) {
      throw new RangeError('Invalid reconciliation pass limits');
    }
    if (args.checkAbortedBeforeLoad !== false) args.signal.throwIfAborted();
    pages: while (true) {
      if (args.signal.aborted && (result.pages > 0 || args.checkAbortedBeforeLoad !== false)) {
        if (args.cancellationMode === 'throw') throw args.signal.reason;
        failures.push(args.signal.reason);
        break;
      }
      if (result.inspected >= inspectionLimit) {
        result.stopReason = 'item-limit';
        break;
      }
      if (monotonicNowMs() - startedAtMs >= budgetMs) {
        result.stopReason = 'time-limit';
        break;
      }
      const limit = Math.min(RECONCILIATION_PAGE_SIZE, inspectionLimit - result.inspected);
      let candidates: readonly T[];
      let explicitPage: ReconciliationPage<T> | undefined;
      try {
        const awaitInitialLoad = result.pages === 0 && (paging.awaitInitialLoad || args.checkAbortedBeforeLoad === false);
        result.pages += 1;
        const page = awaitInitialLoad
          ? await paging.loadPage(startAfter, limit)
          : await raceWithSignal(paging.loadPage(startAfter, limit), args.signal);
        if ('candidates' in page) {
          explicitPage = page;
          candidates = page.candidates;
        } else {
          candidates = page;
        }
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
        if (monotonicNowMs() - startedAtMs >= budgetMs) {
          result.stopReason = 'time-limit';
          break pages;
        }
        if (result.inspected >= inspectionLimit) {
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
      if (explicitPage) {
        if (!explicitPage.hasMore) break;
        if (result.inspected >= inspectionLimit) {
          result.stopReason = 'item-limit';
          break;
        }
      } else if (candidates.length < limit) break;
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
