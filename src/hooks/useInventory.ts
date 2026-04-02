import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { fetchInventory, type DropFetchOptions } from '../lib/api';
import { InventoryItem } from '../types';

export function useInventory(ownerOverride?: string, options?: DropFetchOptions) {
  const { publicKey } = useWallet();
  const owner = ownerOverride || publicKey?.toBase58();
  const includeDevnet = options?.includeDevnet === true;

  return useQuery<InventoryItem[]>({
    queryKey: ['inventory', owner, includeDevnet],
    enabled: Boolean(owner),
    queryFn: () => fetchInventory(owner!, { includeDevnet }),
    refetchInterval: 45_000,
  });
}
