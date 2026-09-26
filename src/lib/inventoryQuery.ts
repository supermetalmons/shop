import type { QueryClient } from '@tanstack/react-query';
import { SHOP_EXPECTED_ASSET_IDS_MAX, type ShopExpectedAssetIds, type ShopPreorderAssetResolution } from '../../shared/shopApi';
import type { InventoryItem } from '../types';
import { fetchInventory } from './shopApi';
import { listPreorderRecoveries, resolvePreorderInventoryAssets } from './preorderRecovery';
import { revokedPreorderInventoryAssetIds, unresolvedPreorderInventoryAssets } from './preorderInventory';
import {
  prepareRecentExpectedInventoryAssets,
  reconcileRecentExpectedInventoryAssets,
} from './recentExpectedInventoryAssets';

export type InventoryQueryLoadOptions = {
  includeDevnet: boolean;
  signal?: AbortSignal;
  useRecentExpectedAssets: boolean;
  usePreorderRecovery?: boolean;
  acknowledgedPreorderAssetIds?: ReadonlySet<string>;
  commitInventory?: (items: InventoryItem[]) => void;
};

type InventoryQueryDependencies = {
  fetchInventory: typeof fetchInventory;
  prepare: typeof prepareRecentExpectedInventoryAssets;
  reconcile: typeof reconcileRecentExpectedInventoryAssets;
  listPreorders?: typeof listPreorderRecoveries;
  resolvePreorders?: (...args: Parameters<typeof resolvePreorderInventoryAssets>) => void | Promise<void>;
};

const defaultDependencies: InventoryQueryDependencies = {
  fetchInventory,
  prepare: prepareRecentExpectedInventoryAssets,
  reconcile: reconcileRecentExpectedInventoryAssets,
  listPreorders: listPreorderRecoveries,
  resolvePreorders: resolvePreorderInventoryAssets,
};

const preorderExpectedCursors = new Map<string, number>();

function preorderExpectedAssets(owner: string, records: ReturnType<typeof listPreorderRecoveries>, recent?: ShopExpectedAssetIds,
  acknowledgedAssetIds?: ReadonlySet<string>) {
  const assets = unresolvedPreorderInventoryAssets(records, acknowledgedAssetIds);
  const expected: ShopExpectedAssetIds = {};
  const seen = new Set<string>();
  const add = (cluster: keyof ShopExpectedAssetIds, id: string) => {
    if (seen.size >= SHOP_EXPECTED_ASSET_IDS_MAX || seen.has(id)) return;
    (expected[cluster] ??= []).push(id);
    seen.add(id);
  };
  for (const cluster of ['mainnet-beta', 'devnet'] as const) for (const id of recent?.[cluster] ?? []) add(cluster, id);
  const cursor = (preorderExpectedCursors.get(owner) ?? 0) % Math.max(1, assets.length);
  let count = 0;
  while (count < assets.length && seen.size < SHOP_EXPECTED_ASSET_IDS_MAX) {
    const asset = assets[(cursor + count) % assets.length];
    if (asset.config.cluster === 'mainnet-beta' || asset.config.cluster === 'devnet') add(asset.config.cluster, asset.address);
    count += 1;
  }
  return {
    expectedAssetIds: seen.size ? expected : undefined,
    commit: () => preorderExpectedCursors.set(owner, assets.length ? (cursor + count) % assets.length : 0),
  };
}

export async function revokePreorderInventoryAssets(queryClient: QueryClient, owner: string, assetIds: readonly string[]): Promise<void> {
  const ids = new Set(assetIds);
  const queryKey = ['inventory', owner] as const;
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueriesData<InventoryItem[]>({ queryKey }, (items) => items?.filter((item) => !ids.has(item.id)));
  reconcileRecentExpectedInventoryAssets(owner, ids);
  await queryClient.invalidateQueries({ queryKey });
}

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
  const recoverPreorders = options.usePreorderRecovery ?? options.useRecentExpectedAssets;
  const preorders = recoverPreorders ? dependencies.listPreorders?.(owner) ?? [] : [];
  const preorderCount = unresolvedPreorderInventoryAssets(preorders, options.acknowledgedPreorderAssetIds).length;
  const recentLimit = Math.max(Math.floor(SHOP_EXPECTED_ASSET_IDS_MAX / 2), SHOP_EXPECTED_ASSET_IDS_MAX - preorderCount);
  const selection = options.useRecentExpectedAssets
    ? dependencies.prepare(owner, options.includeDevnet, { maxEntries: recentLimit })
    : undefined;
  const expected = preorderExpectedAssets(owner, preorders, selection?.expectedAssetIds, options.acknowledgedPreorderAssetIds);
  const selectedIds = new Set(Object.values(expected.expectedAssetIds ?? {}).flat());
  const preorderMinContextSlots = Object.fromEntries(preorders.flatMap(record => record.order.assets.flatMap(({ address }) => {
    const slot = record.inventoryResolutionSlots?.[address];
    return selectedIds.has(address) && slot !== undefined ? [[address, slot]] : [];
  })));
  let preorderProofs: readonly ShopPreorderAssetResolution[] = [];
  const items = await dependencies.fetchInventory(owner, {
    includeDevnet: options.includeDevnet,
    expectedAssetIds: expected.expectedAssetIds,
    signal: options.signal,
    ...(recoverPreorders && dependencies.resolvePreorders ? {
      ...(Object.keys(preorderMinContextSlots).length ? { preorderMinContextSlots } : {}),
      onPreorderAssetResolutions: (proofs: readonly ShopPreorderAssetResolution[]) => { preorderProofs = proofs; },
    } : {}),
  });
  options.signal?.throwIfAborted();
  selection?.commit();
  expected.commit();
  const revoked = revokedPreorderInventoryAssetIds(recoverPreorders ? dependencies.listPreorders?.(owner) ?? [] : []);
  let inventory = revoked.size ? items.filter((item) => !revoked.has(item.id)) : items;
  if (options.useRecentExpectedAssets) dependencies.reconcile(owner, inventory.map((item) => item.id));
  if (recoverPreorders && preorderProofs.length) {
    options.commitInventory?.(inventory);
    await dependencies.resolvePreorders?.(owner, preorderProofs.map(proof => proof.id), inventory.map((item) => item.id), preorders, options.signal, preorderProofs);
    options.signal?.throwIfAborted();
    const latestRevoked = revokedPreorderInventoryAssetIds(dependencies.listPreorders?.(owner) ?? []);
    if (latestRevoked.size) inventory = inventory.filter(item => !latestRevoked.has(item.id));
  }
  return inventory;
}
