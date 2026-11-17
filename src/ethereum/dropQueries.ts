import type { QueryFunctionContext } from '@tanstack/react-query';
import type { Ethereum111kConfig } from '../../shared/ethereum/config';
import { ethereumApi } from './api';
import { runEthereumRead } from './readRetry';

export function ethereumStatsQuery(config: Ethereum111kConfig, owner: string | null, operationSignal?: AbortSignal) {
  const queryKey = ['ethereum111k', 'stats', config.chainId, config.contractAddress, owner] as const;
  return {
    queryKey,
    queryFn: (context: QueryFunctionContext<typeof queryKey>) =>
      runEthereumRead(context, signal => ethereumApi.stats(config, owner, signal), operationSignal),
  };
}

export function ethereumRelicsQuery(config: Ethereum111kConfig, owner: string | null, operationSignal?: AbortSignal) {
  const queryKey = ['ethereum111k', 'relics', config.chainId, config.contractAddress, owner] as const;
  return {
    queryKey,
    queryFn: (context: QueryFunctionContext<typeof queryKey>) =>
      runEthereumRead(context, signal => ethereumApi.relics(config, owner, signal), operationSignal),
  };
}
