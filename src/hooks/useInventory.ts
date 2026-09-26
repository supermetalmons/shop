import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { useMemo } from 'react';
import { loadInventoryQuery } from '../lib/inventoryQuery';
import { shouldUseRecentExpectedInventoryAssets } from '../lib/recentExpectedInventoryAssets';
import { InventoryItem } from '../types';

export type UseInventoryOptions = {
  includeDevnet?: boolean;
  useRecentExpectedAssets?: boolean;
  usePreorderRecovery?: boolean;
};

export function inventoryQueryKeyPrefix(owner?: string) {
  return ['inventory', owner] as const;
}

export function useInventory(ownerOverride?: string, options?: UseInventoryOptions) {
  const queryClient = useQueryClient();
  const { publicKey } = useWallet();
  const owner = ownerOverride || publicKey?.toBase58();
  const walletOwner = publicKey?.toBase58();
  const includeDevnet = options?.includeDevnet === true;
  const useRecentExpectedAssets = options?.useRecentExpectedAssets === true &&
    shouldUseRecentExpectedInventoryAssets(owner, walletOwner);

  const queryKey = [...inventoryQueryKeyPrefix(owner), includeDevnet];
  const query = useQuery<InventoryItem[]>({
    queryKey,
    enabled: Boolean(owner),
    queryFn: ({ signal }) => loadInventoryQuery(owner!, {
      includeDevnet,
      signal,
      useRecentExpectedAssets,
      usePreorderRecovery: options?.usePreorderRecovery ?? useRecentExpectedAssets,
      acknowledgedPreorderAssetIds: new Set(queryClient.getQueryData<InventoryItem[]>(queryKey)?.map((item) => item.id)),
      commitInventory: (items) => queryClient.setQueryData(queryKey, items),
    }),
    refetchInterval: 45_000,
  });
  const acknowledgedPreorderAssetIds = useMemo(() => new Set(query.data?.map((item) => item.id)), [query.data]);
  return { ...query, acknowledgedPreorderAssetIds };
}
