import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback
} from 'react';
import { inventoryQueryKeyPrefix, useInventory } from '../../hooks/useInventory';
import { usePendingOpenBoxes } from '../../hooks/usePendingOpenBoxes';
import { refetchInventoryWithLatestExpectedAssets } from '../../lib/inventoryQuery';
import { EMPTY_INVENTORY, EMPTY_PENDING_OPEN } from './stateSupport';

export function useShopInventoryQueries(owner: string | undefined, includeDevnetInventory: boolean, isViewerMode: boolean) {
  const queryClient = useQueryClient();
  const {
    data: inventoryData,
    refetch: refetchInventory,
    isFetched: inventoryFetched,
    isFetching: inventoryFetching,
    dataUpdatedAt: inventoryDataUpdatedAt,
  } = useInventory(owner, {
    includeDevnet: includeDevnetInventory,
    useRecentExpectedAssets: !isViewerMode,
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
  const inventory = inventoryData ?? EMPTY_INVENTORY;
  const pendingOpenBoxes = pendingOpenBoxesData ?? EMPTY_PENDING_OPEN;
  return { inventory, pendingOpenBoxes, refetchInventory, inventoryFetched, inventoryFetching, inventoryDataUpdatedAt, refreshInventoryAfterMint, refetchPendingOpenBoxes, pendingOpenBoxesSuccess };
}
export type ShopInventoryQueries = ReturnType<typeof useShopInventoryQueries>;
