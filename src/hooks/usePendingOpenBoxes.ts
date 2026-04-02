import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { fetchPendingOpenBoxes, type DropFetchOptions } from '../lib/api';
import type { PendingOpenBox } from '../types';

export function usePendingOpenBoxes(ownerOverride?: string, options?: DropFetchOptions) {
  const { publicKey } = useWallet();
  const owner = ownerOverride || publicKey?.toBase58();
  const includeDevnet = options?.includeDevnet === true;

  return useQuery<PendingOpenBox[]>({
    queryKey: ['pendingOpenBoxes', owner, includeDevnet],
    enabled: Boolean(owner),
    queryFn: () => fetchPendingOpenBoxes(owner!, { includeDevnet }),
    refetchInterval: 20_000,
  });
}
