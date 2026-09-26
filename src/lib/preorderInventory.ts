import { getPreorderConfig, preorderImageUrl } from '../../shared/preorders';
import type { InventoryItem } from '../types';
import type { PreorderRecoveryRecord } from './preorderRecovery';

function verifiedResolvedAssetIds(record: PreorderRecoveryRecord): string[] {
  return record.resolvedAssetIds.filter(id => {
    const slot = record.inventoryResolutionSlots?.[id];
    return slot === undefined ? record.order.status === 'succeeded'
      : record.order.confirmedSlot != null && slot >= record.order.confirmedSlot;
  });
}

export function unresolvedPreorderInventoryAssets(records: readonly PreorderRecoveryRecord[], acknowledgedOwnedAssetIds?: ReadonlySet<string>) {
  return records.flatMap(record => {
    const { order, ownedResolvedAssetIds } = record;
    const config = getPreorderConfig(order.preorderId);
    if (!config?.enabled || order.status !== 'succeeded' && !(order.status === 'submitted' && order.confirmedSlot != null)) return [];
    const resolved = new Set(verifiedResolvedAssetIds(record));
    const owned = new Set(ownedResolvedAssetIds);
    return order.assets.filter((asset) => !resolved.has(asset.address) || acknowledgedOwnedAssetIds &&
      (owned.has(asset.address) ? !acknowledgedOwnedAssetIds.has(asset.address) : acknowledgedOwnedAssetIds.has(asset.address)))
      .map((asset) => ({ ...asset, config }));
  });
}

export function revokedPreorderInventoryAssetIds(records: readonly PreorderRecoveryRecord[]): Set<string> {
  return new Set(records.flatMap(({ order }) => order.status === 'failed' || order.status === 'expired'
    ? order.assets.map((asset) => asset.address) : []));
}

function suppressedPreorderInventoryAssetIds(records: readonly PreorderRecoveryRecord[]): Set<string> {
  return new Set([...revokedPreorderInventoryAssetIds(records), ...records.flatMap(record =>
    record.order.status === 'succeeded' || record.order.status === 'submitted' && record.order.confirmedSlot != null
      ? verifiedResolvedAssetIds(record).filter(id => !record.ownedResolvedAssetIds?.includes(id)) : [])]);
}

export function mergePreorderInventory(
  inventory: InventoryItem[],
  records: readonly PreorderRecoveryRecord[],
  acknowledgedOwnedAssetIds?: ReadonlySet<string>,
): InventoryItem[] {
  const suppressed = suppressedPreorderInventoryAssetIds(records);
  const overlays = unresolvedPreorderInventoryAssets(records, acknowledgedOwnedAssetIds);
  if (!overlays.length && !inventory.some((item) => suppressed.has(item.id))) return inventory;
  const items = new Map(inventory.filter((item) => !suppressed.has(item.id)).map((item) => [item.id, item]));
  for (const asset of overlays) {
    if (!items.has(asset.address) && !suppressed.has(asset.address)) items.set(asset.address, {
      id: asset.address, dropId: asset.config.preorderId, name: `Preorder #${asset.id}`, kind: 'preorder',
      preorderId: asset.id, image: preorderImageUrl(asset.config, asset.id),
    });
  }
  return Array.from(items.values());
}
