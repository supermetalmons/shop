import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Ethereum111kConfig, EthereumInventoryResponse } from '../../shared/ethereum/api';
import { fetchEthereumInventory } from './inventoryQuery';
import { ethereumInventoryQueryKey, readEthereumInventoryExpected } from './state';
import { readEthereumConfirmedInventory } from './confirmedInventory';
import { EthereumCatalogChangedError, refreshEthereumCatalog, retainEthereumMetadata } from './catalogRevision';
import { EthereumApiError } from './api';
import { ethereumReadRefetchInterval, ethereumReadRetry, ethereumReadRetryDelay, ethereumReadRetryOptions, runEthereumRead } from './readRetry';

export function useEthereumInventory(config: Ethereum111kConfig, owner: string | null, scope: string | null) {
  const client = useQueryClient();
  const queryKey = ethereumInventoryQueryKey(scope, config);
  return useQuery({
    queryKey,
    queryFn: context => runEthereumRead(context, async signal => {
      const confirmed = readEthereumConfirmedInventory(scope!);
      const burned = new Set(confirmed.burnedTokenIds);
      const expected = [...new Set([...readEthereumInventoryExpected(scope!), ...confirmed.tokenIds])].filter(id => !burned.has(id));
      try {
        const result = await fetchEthereumInventory(config, owner!, signal, expected);
        const previous = client.getQueryData<EthereumInventoryResponse>(queryKey);
        const metadata = new Map(previous?.items.map(item => [item.id, item]));
        if ((result.catalogRevision ?? 0) > (config.catalogRevision ?? 0)) {
          void client.invalidateQueries({ queryKey: ['ethereum111k', 'config'] }, { cancelRefetch: false });
        }
        return { ...result, items: result.items.map(item => retainEthereumMetadata(metadata.get(item.id), item)) };
      }
      catch (error) { await refreshEthereumCatalog(client, error); throw error; }
    }),
    enabled: Boolean(scope && owner && config.enabled),
    ...ethereumReadRetryOptions,
    retry: (failures, error) => error instanceof EthereumCatalogChangedError ? failures < 2 : ethereumReadRetry(failures, error),
    retryDelay: (failures, error) => error instanceof EthereumCatalogChangedError ? 1_000 : ethereumReadRetryDelay(failures, error),
    refetchInterval: query => ethereumReadRefetchInterval(query,
      query.state.error instanceof EthereumApiError && query.state.error.status === 503 ? 5_000
        : query.state.data && (query.state.data.catalogRevision ?? 0) < (config.catalogRevision ?? 0) ? 1_000 : false),
    staleTime: 30_000,
  });
}
