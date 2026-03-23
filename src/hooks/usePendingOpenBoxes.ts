import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { fetchPendingOpenBoxes } from '../lib/api';
import type { PendingOpenBox } from '../types';

export function usePendingOpenBoxes(ownerOverride?: string) {
  const { publicKey } = useWallet();
  const owner = ownerOverride || publicKey?.toBase58();

  return useQuery<PendingOpenBox[]>({
    queryKey: ['pendingOpenBoxes', owner],
    enabled: Boolean(owner),
    queryFn: () => fetchPendingOpenBoxes(owner!),
    refetchInterval: 20_000,
  });
}

