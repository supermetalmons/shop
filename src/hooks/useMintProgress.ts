import { useQuery } from '@tanstack/react-query';
import type { Connection } from '@solana/web3.js';
import { fetchMintStatsFromProgram } from '../lib/boxMinter';
import { MintStats } from '../types';
import type { FrontendDeploymentConfig } from '../config/deployment';

export function useMintProgress(
  connection: Connection | null,
  dropConfig:
    | Pick<
        FrontendDeploymentConfig,
        'dropId' | 'boxMinterProgramId' | 'boxMinterConfigPda' | 'maxPerTx' | 'mintSelection'
      >
    | null,
  enabled = true,
) {
  return useQuery<MintStats>({
    queryKey: ['mint-stats', dropConfig?.dropId || 'none'],
    queryFn: () => {
      if (!connection || !dropConfig) {
        throw new Error('Mint progress requires an explicit drop');
      }
      return fetchMintStatsFromProgram(connection, dropConfig);
    },
    refetchInterval: enabled ? 30_000 : false,
    enabled: enabled && Boolean(connection && dropConfig),
  });
}
