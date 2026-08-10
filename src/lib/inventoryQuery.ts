import type { QueryClient } from '@tanstack/react-query';
import { fetchInventory } from './shopApi';
import {
  prepareRecentExpectedInventoryAssets,
  reconcileRecentExpectedInventoryAssets,
} from './recentExpectedInventoryAssets';

export type InventoryQueryLoadOptions = {
  includeDevnet: boolean;
  signal?: AbortSignal;
  useRecentExpectedAssets: boolean;
};

type InventoryQueryDependencies = {
  fetchInventory: typeof fetchInventory;
  prepare: typeof prepareRecentExpectedInventoryAssets;
  reconcile: typeof reconcileRecentExpectedInventoryAssets;
};

const defaultDependencies: InventoryQueryDependencies = {
  fetchInventory,
  prepare: prepareRecentExpectedInventoryAssets,
  reconcile: reconcileRecentExpectedInventoryAssets,
};

export async function refetchInventoryWithLatestExpectedAssets<T>(
  queryClient: Pick<QueryClient, 'cancelQueries'>,
  queryKey: readonly unknown[],
  refetch: () => Promise<T>,
): Promise<T> {
  await queryClient.cancelQueries({ queryKey, exact: true });
  return refetch();
}

export async function loadInventoryQuery(
  owner: string,
  options: InventoryQueryLoadOptions,
  dependencies: InventoryQueryDependencies = defaultDependencies,
) {
  const selection = options.useRecentExpectedAssets
    ? dependencies.prepare(owner, options.includeDevnet)
    : undefined;
  const items = await dependencies.fetchInventory(owner, {
    includeDevnet: options.includeDevnet,
    expectedAssetIds: selection?.expectedAssetIds,
    signal: options.signal,
  });
  selection?.commit();
  if (options.useRecentExpectedAssets) {
    dependencies.reconcile(owner, items.map((item) => item.id));
  }
  return items;
}
