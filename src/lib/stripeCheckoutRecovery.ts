function normalizedString(value: string | null | undefined): string {
  return String(value || '').trim();
}

export type StripeCheckoutProfileRecoveryStatus = {
  key: string;
  phase: 'pending' | 'recovered' | 'fallback';
};

export function resolveStripeCheckoutDataOwner(
  connectedWallet: string | null | undefined,
  recoveredWallet: string | null | undefined,
): string | undefined {
  return normalizedString(connectedWallet) || normalizedString(recoveredWallet) || undefined;
}

export function mergeStripeCheckoutRecoverySessionIds(
  markerSessionIds: readonly string[],
  returnSessionId: string | null | undefined,
): string[] {
  return Array.from(
    new Set([...markerSessionIds, returnSessionId].map(normalizedString).filter(Boolean)),
  ).sort();
}

export function pendingStripeCheckoutRecoverySessionIds(
  targetSessionIds: readonly string[],
  profileSessionIds: readonly string[],
): string[] {
  const present = new Set(profileSessionIds.map(normalizedString).filter(Boolean));
  return targetSessionIds.map(normalizedString).filter((sessionId) => sessionId && !present.has(sessionId));
}

export function shouldObserveDisconnectedStripeSession(args: {
  connectedWallet: string | null | undefined;
  recoveryKey: string;
  recoveryStatus: StripeCheckoutProfileRecoveryStatus | null;
  recoveredWallet: string | null | undefined;
  hasObservedSession?: boolean;
}): boolean {
  if (normalizedString(args.connectedWallet)) return false;
  if (normalizedString(args.recoveredWallet)) return true;
  if (!args.recoveryKey) return false;
  return (
    args.recoveryStatus?.key !== args.recoveryKey ||
    args.recoveryStatus.phase === 'pending' ||
    args.hasObservedSession === true
  );
}

const STRIPE_CHECKOUT_RETRY_INTERVALS_MS = [3_000, 6_000, 12_000] as const;

export function stripeCheckoutRetryDelay(args: {
  hasPendingWork: boolean;
  retryable: boolean;
  now: number;
  stopAt: number;
  retryIndex: number;
}): number | null {
  if (!args.hasPendingWork || !args.retryable || args.now >= args.stopAt) return null;
  const normalizedIndex = Number.isSafeInteger(args.retryIndex) && args.retryIndex >= 0
    ? args.retryIndex
    : 0;
  const interval = STRIPE_CHECKOUT_RETRY_INTERVALS_MS[normalizedIndex] ?? 15_000;
  return Math.min(interval, args.stopAt - args.now);
}

export function shouldUseAnonymousStripeHistory(args: {
  connectedWallet: string | null | undefined;
  recoveredWallet: string | null | undefined;
  hasCompletedCheckout: boolean;
  recoveryFallbackReady: boolean;
}): boolean {
  return (
    !normalizedString(args.connectedWallet) &&
    !normalizedString(args.recoveredWallet) &&
    args.hasCompletedCheckout &&
    args.recoveryFallbackReady
  );
}
