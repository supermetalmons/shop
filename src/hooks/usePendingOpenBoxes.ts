import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { fetchPendingOpenBoxes, type DropFetchOptions } from '../lib/shopApi';
import type { PendingOpenBox } from '../types';

export function pendingOpenBoxesQueryKeyPrefix(owner?: string) {
  return ['pendingOpenBoxes', owner] as const;
}

export function usePendingOpenBoxes(ownerOverride?: string, options?: DropFetchOptions) {
  const { publicKey } = useWallet();
  const owner = ownerOverride || publicKey?.toBase58();
  const includeDevnet = options?.includeDevnet === true;

  return useQuery<PendingOpenBox[]>({
    queryKey: [...pendingOpenBoxesQueryKeyPrefix(owner), includeDevnet],
    enabled: Boolean(owner),
    queryFn: ({ signal }) => fetchPendingOpenBoxes(owner!, { includeDevnet, signal }),
    refetchInterval: 20_000,
  });
}
