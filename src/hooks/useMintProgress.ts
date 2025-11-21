import { useQuery } from '@tanstack/react-query';
import { fetchMintStats } from '../lib/api';
import { MintStats } from '../types';

export function useMintProgress() {
  return useQuery<MintStats>({
    queryKey: ['mint-stats'],
    queryFn: fetchMintStats,
    refetchInterval: 30_000,
  });
}
