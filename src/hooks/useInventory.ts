import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { fetchInventory } from '../lib/api';
import { InventoryItem } from '../types';

export function useInventory() {
  const { publicKey } = useWallet();
  const owner = publicKey?.toBase58();

  return useQuery<InventoryItem[]>({
    queryKey: ['inventory', owner],
    enabled: Boolean(owner),
    queryFn: () => fetchInventory(owner!),
    refetchInterval: 45_000,
  });
}
