import { useQuery } from '@tanstack/react-query';
import type { Connection } from '@solana/web3.js';
import { fetchMintStatsFromProgram } from '../lib/boxMinter';
import { MintStats } from '../types';
import type { FrontendDeploymentConfig } from '../config/deployment';

export function useMintProgress(
  connection: Connection,
  dropConfig: Pick<FrontendDeploymentConfig, 'dropId' | 'boxMinterProgramId' | 'maxPerTx'>,
  enabled = true,
) {
  return useQuery<MintStats>({
    queryKey: ['mint-stats', dropConfig.dropId],
    queryFn: () => fetchMintStatsFromProgram(connection, dropConfig),
    refetchInterval: enabled ? 30_000 : false,
    enabled,
  });
}
