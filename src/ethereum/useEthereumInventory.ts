import { useQuery } from '@tanstack/react-query';
import type { Ethereum111kConfig } from '../../shared/ethereum/api';
import { fetchEthereumInventory } from './inventoryQuery';
import { ethereumInventoryQueryKey, readEthereumInventoryExpected } from './state';
import { readEthereumConfirmedInventory } from './confirmedInventory';

export function useEthereumInventory(config: Ethereum111kConfig, owner: string | null, scope: string | null) {
  return useQuery({
    queryKey: ethereumInventoryQueryKey(scope),
    queryFn: ({ signal }) => {
      const confirmed = readEthereumConfirmedInventory(scope!);
      const burned = new Set(confirmed.burnedTokenIds);
      const expected = [...new Set([...readEthereumInventoryExpected(scope!), ...confirmed.tokenIds])].filter(id => !burned.has(id));
      return fetchEthereumInventory(config, owner!, signal, expected);
    },
    enabled: Boolean(scope && owner && config.enabled),
    retry: false,
    staleTime: 30_000,
  });
}
