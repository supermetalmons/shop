import type {
  RecoverDeliveryOrdersItemResult,
  RecoverDeliveryOrdersResult,
  WalletDeliveryRecoveryState,
} from './shared/contracts.js';

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
    ...(args.walletRecovery.nextCheckAt !== null
      ? { nextCheckAt: args.walletRecovery.nextCheckAt }
      : {}),
    walletRecovery: args.walletRecovery,
    results: args.results,
  };
}
