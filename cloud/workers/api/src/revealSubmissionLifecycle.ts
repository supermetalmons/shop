import type { RevealSubmissionRecord } from './revealSubmissionD1.js';

type RevealSubmissionOutcome = 'confirmed' | 'failed' | 'expired' | 'unknown';

export async function resolveRevealSubmission(args: {
  submission: RevealSubmissionRecord;
  reconcile: () => Promise<RevealSubmissionOutcome>;
  confirm: () => Promise<void>;
  fail?: () => Promise<'confirmed' | 'failed' | 'stale'>;
}): Promise<RevealSubmissionOutcome | 'stale'> {
  if (args.submission.status !== 'pending') return args.submission.status;
  const outcome = await args.reconcile();
  if (outcome === 'confirmed') {
    await args.confirm();
  } else if ((outcome === 'failed' || outcome === 'expired') && args.fail) {
    return args.fail();
  }
  return outcome;
}
