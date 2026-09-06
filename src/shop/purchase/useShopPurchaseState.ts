import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Connection } from '@solana/web3.js';
import type { FrontendDeploymentConfig } from '../../config/deployment';
import { shouldFetchMintProgress, useMintProgress } from '../../hooks/useMintProgress';
import { getDropPackStatus, packStatusDisplayLabelsForDropId, supportsFrontendPackStatus } from '../../api/shop';
import { deriveMintSelectionAvailabilityFromConfig } from '../../lib/boxMinter';
import { applyOptimisticStripeCheckoutMintProgress, type StripeCheckoutMintProgress } from '../../lib/stripeCheckoutMarkers';
import { DISCOUNT_USED_STORAGE_PREFIX, discountUsedScope, discountUsedVersion } from '../persistedState';
import type { MintStats } from '../../types';

type PurchaseStateOptions = {
  routeDrop: FrontendDeploymentConfig | null;
  routeConnection: Connection | null;
};

export function useShopPurchaseState({ routeDrop, routeConnection }: PurchaseStateOptions) {
  const activeDiscountVersion = useMemo(
    () => (routeDrop ? discountUsedVersion(routeDrop) : 'none'),
    [routeDrop],
  );
  const activeDiscountScope = useMemo(
    () => (routeDrop ? discountUsedScope(routeDrop) : `${DISCOUNT_USED_STORAGE_PREFIX}:none`),
    [routeDrop],
  );
  const shouldFetchMintStats = shouldFetchMintProgress(routeDrop);
  const { data: mintStats, refetch: refetchStats } = useMintProgress(routeConnection, routeDrop, shouldFetchMintStats);
  const packStatusDropId = routeDrop?.dropId && supportsFrontendPackStatus(routeDrop.dropId) ? routeDrop.dropId : null;
  const packStatusDisplayLabels = packStatusDisplayLabelsForDropId(packStatusDropId || undefined);
  const { data: packStatusBreakdown } = useQuery({
    queryKey: ['drop-pack-status', packStatusDropId || 'none'],
    enabled: Boolean(packStatusDropId),
    queryFn: () => getDropPackStatus(packStatusDropId || ''),
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const activeDiscountAllowance = routeDrop ? mintStats?.discountMintsPerWallet ?? routeDrop.discountMintsPerWallet : 0;
  return {
    activeDiscountVersion, activeDiscountScope, activeDiscountAllowance,
    shouldFetchMintStats, mintStats, refetchStats,
    packStatusDropId, packStatusDisplayLabels, packStatusBreakdown,
  };
}

export function useEffectiveMintStats({
  routeDrop,
  mintStats,
  stripeCheckoutOptimisticMintProgress,
}: {
  routeDrop: FrontendDeploymentConfig | null;
  mintStats: MintStats | undefined;
  stripeCheckoutOptimisticMintProgress: StripeCheckoutMintProgress | null;
}) {
  const fallbackMintSelectionAvailability = useMemo(
    () => deriveMintSelectionAvailabilityFromConfig(routeDrop?.mintSelection),
    [routeDrop?.mintSelection],
  );
  const soldOutMintSelectionAvailability = useMemo(
    () =>
      fallbackMintSelectionAvailability
        ? Object.fromEntries(Object.keys(fallbackMintSelectionAvailability).map((key) => [key, 0]))
        : undefined,
    [fallbackMintSelectionAvailability],
  );
  const forcedSoldOutStats = useMemo(
    () => {
      if (!routeDrop) return undefined;
      return {
        minted: routeDrop.maxSupply,
        total: routeDrop.maxSupply,
        remaining: 0,
        maxPerTx: routeDrop.maxPerTx,
        ...(soldOutMintSelectionAvailability ? { mintSelectionAvailability: soldOutMintSelectionAvailability } : {}),
      };
    },
    [routeDrop, soldOutMintSelectionAvailability],
  );
  const activeMintStatsFallback = useMemo(
    () => {
      if (!routeDrop) return undefined;
      return {
        minted: 0,
        total: routeDrop.maxSupply,
        remaining: routeDrop.maxSupply,
        maxPerTx: routeDrop.maxPerTx,
        ...(fallbackMintSelectionAvailability ? { mintSelectionAvailability: fallbackMintSelectionAvailability } : {}),
      };
    },
    [routeDrop, fallbackMintSelectionAvailability],
  );
  const baseEffectiveMintStats = routeDrop
    ? routeDrop.forceSoldOut
      ? forcedSoldOutStats
      : mintStats || activeMintStatsFallback
    : undefined;
  const effectiveMintStats =
    routeDrop?.dropId === stripeCheckoutOptimisticMintProgress?.dropId
      ? applyOptimisticStripeCheckoutMintProgress(
        baseEffectiveMintStats,
        stripeCheckoutOptimisticMintProgress,
      )
      : baseEffectiveMintStats;

  return effectiveMintStats;
}
