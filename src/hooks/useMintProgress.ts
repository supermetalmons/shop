import { useQuery } from '@tanstack/react-query';
import { useConnection } from '@solana/wallet-adapter-react';
import { fetchMintStatsFromProgram } from '../lib/boxMinter';
import { MintStats } from '../types';

export function useMintProgress() {
  const { connection } = useConnection();
  return useQuery<MintStats>({
    queryKey: ['mint-stats'],
    queryFn: () => fetchMintStatsFromProgram(connection),
    refetchInterval: 30_000,
  });
}
