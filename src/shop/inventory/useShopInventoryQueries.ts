import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback, useEffect, useMemo
} from 'react';
import { inventoryQueryKeyPrefix, useInventory } from '../../hooks/useInventory';
import { usePendingOpenBoxes } from '../../hooks/usePendingOpenBoxes';
import { refetchInventoryWithLatestExpectedAssets } from '../../lib/inventoryQuery';
import { EMPTY_INVENTORY, EMPTY_PENDING_OPEN } from './stateSupport';
import { usePreorderRecoveryRecords } from '../../hooks/usePreorderRecoveryRecords';
import { mergePreorderInventory, unresolvedPreorderInventoryAssets } from '../../lib/preorderInventory';
import { startPostActionInventoryPolling } from '../postActionPolling';

export function useShopInventoryQueries(owner: string | undefined, includeDevnetInventory: boolean, isViewerMode: boolean) {
  const queryClient = useQueryClient();
  const {
    data: inventoryData,
    refetch: refetchInventory,
    isFetched: inventoryFetched,
    isFetching: inventoryFetching,
    dataUpdatedAt: inventoryDataUpdatedAt,
    acknowledgedPreorderAssetIds,
  } = useInventory(owner, {
    includeDevnet: includeDevnetInventory,
    useRecentExpectedAssets: !isViewerMode,
    usePreorderRecovery: Boolean(owner) && !isViewerMode,
  });
  const refreshInventoryAfterMint = useCallback(
    () => refetchInventoryWithLatestExpectedAssets(
      queryClient,
      [...inventoryQueryKeyPrefix(owner), includeDevnetInventory],
      () => refetchInventory(),
    ),
    [includeDevnetInventory, owner, queryClient, refetchInventory],
  );
  const {
    data: pendingOpenBoxesData,
    refetch: refetchPendingOpenBoxes,
    isSuccess: pendingOpenBoxesSuccess,
  } = usePendingOpenBoxes(owner, { includeDevnet: includeDevnetInventory });
  const preorderRecoveries = usePreorderRecoveryRecords(isViewerMode ? undefined : owner);
  const inventory = useMemo(() => mergePreorderInventory(inventoryData ?? EMPTY_INVENTORY, preorderRecoveries, acknowledgedPreorderAssetIds),
    [inventoryData, preorderRecoveries, acknowledgedPreorderAssetIds]);
  const preorderRecoveryPending = unresolvedPreorderInventoryAssets(preorderRecoveries, acknowledgedPreorderAssetIds).length > 0;
  useEffect(() => {
    if (!preorderRecoveryPending) return;
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void refetchInventory({ cancelRefetch: false });
    };
    const stop = startPostActionInventoryPolling(refresh, {
      setInterval: (run, delayMs) => window.setInterval(run, delayMs),
      clearInterval: (timer) => window.clearInterval(timer as number),
    });
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      stop();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [preorderRecoveryPending, refetchInventory]);
  const pendingOpenBoxes = pendingOpenBoxesData ?? EMPTY_PENDING_OPEN;
  return { inventory, pendingOpenBoxes, refetchInventory, inventoryFetched, inventoryFetching, inventoryDataUpdatedAt, refreshInventoryAfterMint, refetchPendingOpenBoxes, pendingOpenBoxesSuccess };
}
export type ShopInventoryQueries = ReturnType<typeof useShopInventoryQueries>;
