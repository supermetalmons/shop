import { sleepWithSignal } from './boundedRequest.js';

const POLL_INTERVAL_MS = 800;
const HISTORY_LOOKUP_AFTER_MS = 6_000;

export async function pollSignatureConfirmation<Result extends object>(args: {
  signal: AbortSignal;
  timeoutMs: number;
  poll: (context: { searchTransactionHistory: () => boolean }) => Promise<Result | undefined>;
  finalLookup: () => Promise<Result>;
}): Promise<Result> {
  const startedAt = Date.now();
  const context = { searchTransactionHistory: () => Date.now() - startedAt > HISTORY_LOOKUP_AFTER_MS };
  while (Date.now() - startedAt < args.timeoutMs) {
    const result = await args.poll(context);
    if (result !== undefined) return result;
    await sleepWithSignal(POLL_INTERVAL_MS, args.signal);
  }
  return args.finalLookup();
}
