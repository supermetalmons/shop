function normalizedString(value: string | null | undefined): string {
  return String(value || '').trim();
}

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

export function shouldContinueStripeCheckoutRecovery(args: {
  pendingSessionIds: readonly string[];
  retryable: boolean;
  nextAttemptAt: number;
  stopAt: number;
}): boolean {
  return args.retryable && args.pendingSessionIds.length > 0 && args.nextAttemptAt <= args.stopAt;
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
