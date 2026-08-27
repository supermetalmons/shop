import type { DropRevealMode } from '../config/dropsExtraContent';

export type RevealOverlayPhase = 'preparing' | 'ready' | 'revealed';
export type RevealRequestStatus = 'resolved' | 'retry';
export type RevealReconciliationOutcome = 'confirmed' | 'failed' | 'expired' | 'unknown';

export type RevealRecoveryOptions = {
  detectExpiry: false;
  timeoutMs: 75_000;
  signal: AbortSignal;
};

const REVEAL_RECOVERY_OPTIONS = {
  detectExpiry: false,
  timeoutMs: 75_000,
} as const;

export type RevealRequestWithRecoveryArgs<TResponse, TSubmission> = {
  request: () => Promise<TResponse>;
  recoveryDetails: (error: unknown) => { submission: TSubmission } | null;
  reconcile: (
    submission: TSubmission,
    options: RevealRecoveryOptions,
  ) => Promise<RevealReconciliationOutcome>;
  isCurrent: () => boolean;
  signal: AbortSignal;
};

export type RevealRequestWithRecoveryResult<TResponse> =
  | { status: 'success'; response: TResponse }
  | { status: 'stale' };

export async function requestRevealWithSubmissionRecovery<TResponse, TSubmission>(
  args: RevealRequestWithRecoveryArgs<TResponse, TSubmission>,
): Promise<RevealRequestWithRecoveryResult<TResponse>> {
  let response: TResponse;
  try {
    response = await args.request();
  } catch (error) {
    const details = args.recoveryDetails(error);
    if (!details) {
      if (!args.isCurrent()) return { status: 'stale' };
      throw error;
    }
    if (!args.isCurrent()) return { status: 'stale' };
    let outcome: RevealReconciliationOutcome;
    try {
      outcome = await args.reconcile(details.submission, {
        ...REVEAL_RECOVERY_OPTIONS,
        signal: args.signal,
      });
    } catch (recoveryError) {
      if (!args.isCurrent()) return { status: 'stale' };
      throw recoveryError;
    }
    if (!args.isCurrent()) return { status: 'stale' };
    if (outcome !== 'confirmed') throw error;
    response = await args.request();
  }
  if (!args.isCurrent()) return { status: 'stale' };
  return { status: 'success', response };
}

export type RevealRetryOverlayState = {
  id: string;
  dropId: string;
  phase: RevealOverlayPhase;
  revealedIds?: readonly number[];
  hasRevealAttempted?: boolean;
};

export function applyRevealRequestRetry<T extends RevealRetryOverlayState>(
  current: T | null,
  args: {
    status: RevealRequestStatus;
    requestSession: number;
    currentSession: number;
    boxAssetId: string;
    dropId: string;
  },
): T | null {
  if (args.status !== 'retry' || args.requestSession !== args.currentSession) return current;
  if (
    !current ||
    current.id !== args.boxAssetId ||
    current.dropId !== args.dropId ||
    current.phase !== 'ready' ||
    current.revealedIds?.length
  ) return current;
  return { ...current, hasRevealAttempted: false };
}

export function resolveRevealOverlayPhaseAfterReveal(args: {
  currentPhase: RevealOverlayPhase;
  revealMode: DropRevealMode;
  usesAssetGatedFlow: boolean;
  frame: number;
  mediaStart: number;
  hasResults: boolean;
}): RevealOverlayPhase {
  if (args.currentPhase === 'preparing') return args.currentPhase;
  if (args.revealMode === 'static') return args.hasResults ? 'revealed' : 'ready';
  if (args.usesAssetGatedFlow) return 'ready';
  return args.frame >= args.mediaStart && args.hasResults ? 'revealed' : 'ready';
}
