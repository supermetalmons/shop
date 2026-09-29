export async function drainNotificationCandidates<T>(args: {
  signal: AbortSignal;
  loadCandidates: () => Promise<readonly T[]>;
  processCandidate: (candidate: T) => Promise<number | 'stop'>;
  failureMessage: string;
  onFailure?: (candidate: T, error: unknown) => void;
}): Promise<number> {
  args.signal.throwIfAborted();
  const candidates = await args.loadCandidates();
  const failures: unknown[] = [];
  let processed = 0;
  for (const candidate of candidates) {
    if (args.signal.aborted) {
      failures.push(args.signal.reason);
      break;
    }
    try {
      const result = await args.processCandidate(candidate);
      if (result === 'stop') break;
      processed += result;
    } catch (error) {
      args.onFailure?.(candidate, error);
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, args.failureMessage);
  return processed;
}
