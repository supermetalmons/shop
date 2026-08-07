import { isDropFamily } from '../config/deployment';
import type { InventoryItem } from '../types';

type SelectionItem = Pick<InventoryItem, 'id' | 'dropId' | 'kind'>;

type ToggleInventorySelectionArgs = {
  selected: Set<string>;
  itemId: string;
  inventoryIndex: ReadonlyMap<string, SelectionItem>;
  maxSelected: number;
};

function isClearCardsPack(item: SelectionItem | undefined): boolean {
  return Boolean(item?.kind === 'box' && isDropFamily(item.dropId, 'clear_cards'));
}

export function toggleInventorySelection({
  selected,
  itemId,
  inventoryIndex,
  maxSelected,
}: ToggleInventorySelectionArgs): Set<string> {
  if (selected.has(itemId)) {
    const next = new Set(selected);
    next.delete(itemId);
    return next;
  }

  const nextItem = inventoryIndex.get(itemId);
  if (!nextItem || nextItem.kind === 'certificate') return selected;

  const selectedItems = Array.from(selected)
    .map((id) => inventoryIndex.get(id))
    .filter((item): item is SelectionItem => Boolean(item));
  if (
    isDropFamily(nextItem.dropId, 'clear_cards') &&
    (nextItem.kind === 'box' || selectedItems.some(isClearCardsPack))
  ) {
    return new Set([itemId]);
  }

  if (selected.size >= maxSelected) return selected;

  const firstSelectedItem = selectedItems[0];
  if (
    firstSelectedItem?.dropId &&
    nextItem.dropId &&
    firstSelectedItem.dropId !== nextItem.dropId
  ) {
    return new Set([itemId]);
  }

  const next = new Set(selected);
  next.add(itemId);
  return next;
}
