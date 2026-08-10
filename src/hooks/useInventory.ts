import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { loadInventoryQuery } from '../lib/inventoryQuery';
import { shouldUseRecentExpectedInventoryAssets } from '../lib/recentExpectedInventoryAssets';
import { InventoryItem } from '../types';

export type UseInventoryOptions = {
  includeDevnet?: boolean;
  useRecentExpectedAssets?: boolean;
};

export function inventoryQueryKeyPrefix(owner?: string) {
  return ['inventory', owner] as const;
}

export function useInventory(ownerOverride?: string, options?: UseInventoryOptions) {
  const { publicKey } = useWallet();
  const owner = ownerOverride || publicKey?.toBase58();
  const walletOwner = publicKey?.toBase58();
  const includeDevnet = options?.includeDevnet === true;
  const useRecentExpectedAssets = options?.useRecentExpectedAssets === true &&
    shouldUseRecentExpectedInventoryAssets(owner, walletOwner);

  return useQuery<InventoryItem[]>({
    queryKey: [...inventoryQueryKeyPrefix(owner), includeDevnet],
    enabled: Boolean(owner),
    queryFn: ({ signal }) => loadInventoryQuery(owner!, {
      includeDevnet,
      signal,
      useRecentExpectedAssets,
    }),
    refetchInterval: 45_000,
  });
}
