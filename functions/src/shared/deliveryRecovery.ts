import type {
  RecoverDeliveryOrdersItemResult,
  RecoverDeliveryOrdersResult,
  WalletDeliveryRecoveryState,
} from './contracts.js';

export const DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS = 30_000;
export const DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS = [30_000, 2 * 60 * 1000, 10 * 60 * 1000] as const;

function toMillisMaybe(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const toMillis = (value as { toMillis?: unknown }).toMillis;
  if (typeof toMillis !== 'function') return null;
  try {
    const milliseconds = Number(toMillis.call(value));
    return Number.isFinite(milliseconds) ? milliseconds : null;
  } catch {
    return null;
  }
}

function preparedProbeCount(order: unknown): number {
  const record = order && typeof order === 'object' ? order as Record<string, unknown> : {};
  const recovery = record.receiptRecovery && typeof record.receiptRecovery === 'object'
    ? record.receiptRecovery as Record<string, unknown>
    : {};
  const raw = Number(recovery.preparedProbeCount || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function nextPreparedDeliveryRecoveryDelayMs(probeCount: number): number | null {
  return DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS[probeCount] ?? null;
}

export function preparedDeliveryRecoveryNextCheckMs(order: unknown, nowMs = Date.now()): number | null {
  const record = order && typeof order === 'object' ? order as Record<string, unknown> : {};
  const recovery = record.receiptRecovery && typeof record.receiptRecovery === 'object'
    ? record.receiptRecovery as Record<string, unknown>
    : {};
  const probeCount = preparedProbeCount(record);
  if (probeCount >= DELIVERY_RECOVERY_PREPARED_CHECK_DELAYS_MS.length) return null;
  const scheduledAt = toMillisMaybe(recovery.nextPreparedProbeAt);
  if (scheduledAt !== null && scheduledAt > 0) return scheduledAt;
  const createdAt = toMillisMaybe(record.createdAt) ?? 0;
  if (createdAt <= 0) return nowMs;
  return createdAt + (nextPreparedDeliveryRecoveryDelayMs(probeCount) ?? 0);
}

export function processingDeliveryRecoveryNextCheckMs(order: unknown, nowMs: number): number | null {
  const record = order && typeof order === 'object' ? order as Record<string, unknown> : {};
  if (record.status !== 'processing') return null;
  const recovery = record.receiptRecovery && typeof record.receiptRecovery === 'object'
    ? record.receiptRecovery as Record<string, unknown>
    : {};
  const leaseExpiresAt = toMillisMaybe(recovery.leaseExpiresAt) ?? 0;
  const lastAttemptAt = toMillisMaybe(recovery.lastAttemptAt) ?? 0;
  const retryAt = lastAttemptAt > 0 ? lastAttemptAt + DELIVERY_RECOVERY_PROCESSING_RETRY_DELAY_MS : nowMs;
  return Math.max(nowMs, retryAt, leaseExpiresAt);
}

export function buildWalletDeliveryRecoveryState(args: {
  remainingProcessing: number;
  nextCheckCandidates: readonly (number | null | undefined)[];
}): WalletDeliveryRecoveryState {
  const nextCheckAt = args.nextCheckCandidates.reduce<number | null>((earliest, candidate) => {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return earliest;
    return earliest === null || candidate < earliest ? candidate : earliest;
  }, null);
  return { remainingProcessing: args.remainingProcessing, nextCheckAt };
}

export function buildRecoverDeliveryOrdersResult(args: {
  attempted: number;
  recovered: number;
  results: RecoverDeliveryOrdersItemResult[];
  walletRecovery: WalletDeliveryRecoveryState;
}): RecoverDeliveryOrdersResult {
  return {
    attempted: args.attempted,
    recovered: args.recovered,
    remainingProcessing: args.walletRecovery.remainingProcessing,
    ...(args.walletRecovery.nextCheckAt !== null ? { nextCheckAt: args.walletRecovery.nextCheckAt } : {}),
    walletRecovery: args.walletRecovery,
    results: args.results,
  };
}
