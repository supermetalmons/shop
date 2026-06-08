import { isDropFamily, normalizeDropId } from '../config/deployment';
import type { InventoryItem } from '../types';

const CARD_NFT_2_UNRESOLVED_LOCAL_MINT_GRACE_MS = 120_000;
const CARD_NFT_2_LOCAL_MINT_MAX_PENDING_MS = 10 * 60 * 1000;

export type LocalMintedBoxMatch =
  | {
      kind: 'asset';
      expectedAssetId: string;
    }
  | {
      kind: 'baseline';
      baselineAssetIds: readonly string[];
    }
  | {
      kind: 'count';
      expectedInventoryCount?: number;
    };

export type LocalMintedBox = {
  id: string;
  dropId: string;
  createdAt: number;
  match: LocalMintedBoxMatch;
  unresolvedMatchedAt?: number;
};

function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  map.set(key, new Set([value]));
}

function addToArrayMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(key, [value]);
}

export function isUnresolvedCardNft2Box(item: Pick<InventoryItem, 'kind' | 'dropId' | 'boxId'>): boolean {
  return item.kind === 'box' && isDropFamily(item.dropId, 'card_nft_2') && !item.boxId;
}

export function isCardNft2LocalMintedBox(entry: LocalMintedBox): boolean {
  return isDropFamily(entry.dropId, 'card_nft_2');
}

function baselineAssetIdSetForLocalMint(
  entry: LocalMintedBox,
  baselineAssetIdSets: WeakMap<readonly string[], ReadonlySet<string>>,
): ReadonlySet<string> | null {
  if (entry.match.kind !== 'baseline') return null;
  const cached = baselineAssetIdSets.get(entry.match.baselineAssetIds);
  if (cached) return cached;
  const next = new Set(entry.match.baselineAssetIds);
  baselineAssetIdSets.set(entry.match.baselineAssetIds, next);
  return next;
}

function localMintedBoxCanMatchUnresolvedItem(
  entry: LocalMintedBox,
  item: InventoryItem,
  baselineAssetIdSets: WeakMap<readonly string[], ReadonlySet<string>>,
): boolean {
  if (entry.dropId !== normalizeDropId(item.dropId)) return false;
  if (!isCardNft2LocalMintedBox(entry)) return false;
  if (entry.match.kind === 'asset') return entry.match.expectedAssetId === item.id;
  const baselineIds = baselineAssetIdSetForLocalMint(entry, baselineAssetIdSets);
  return !baselineIds || !baselineIds.has(item.id);
}

function findLocalMintedBoxMatchIndexForUnresolvedItem(
  entries: readonly LocalMintedBox[],
  usedIndexes: ReadonlySet<number>,
  item: InventoryItem,
  baselineAssetIdSets: WeakMap<readonly string[], ReadonlySet<string>>,
): number {
  let fallbackIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (usedIndexes.has(index)) continue;
    if (!localMintedBoxCanMatchUnresolvedItem(entry, item, baselineAssetIdSets)) continue;
    if (entry.match.kind === 'asset') return index;
    if (fallbackIndex === -1) fallbackIndex = index;
  }
  return fallbackIndex;
}

export function withoutLocallyMintedUnresolvedCardNft2Boxes(
  items: readonly InventoryItem[],
  pendingCardNft2Boxes: readonly LocalMintedBox[],
): readonly InventoryItem[] {
  if (!pendingCardNft2Boxes.length) return items;

  const usedPendingIndexes = new Set<number>();
  const baselineAssetIdSets = new WeakMap<readonly string[], ReadonlySet<string>>();
  return items.filter((item) => {
    if (!isUnresolvedCardNft2Box(item)) return true;
    const matchIndex = findLocalMintedBoxMatchIndexForUnresolvedItem(
      pendingCardNft2Boxes,
      usedPendingIndexes,
      item,
      baselineAssetIdSets,
    );
    if (matchIndex === -1) return true;
    usedPendingIndexes.add(matchIndex);
    return false;
  });
}

function claimCardNft2MatchForLocalMint(
  entry: LocalMintedBox,
  currentBoxIdsByDrop: ReadonlyMap<string, ReadonlySet<string>>,
  usedBoxIdsByDrop: Map<string, Set<string>>,
  baselineAssetIdSets: WeakMap<readonly string[], ReadonlySet<string>>,
): string | null {
  if (!isCardNft2LocalMintedBox(entry)) return null;
  const currentBoxIds = currentBoxIdsByDrop.get(entry.dropId);
  if (!currentBoxIds?.size) return null;
  const usedIds = usedBoxIdsByDrop.get(entry.dropId);
  if (entry.match.kind === 'asset') {
    if (!currentBoxIds.has(entry.match.expectedAssetId) || usedIds?.has(entry.match.expectedAssetId)) return null;
    addToSetMap(usedBoxIdsByDrop, entry.dropId, entry.match.expectedAssetId);
    return entry.match.expectedAssetId;
  }
  const baselineIds = baselineAssetIdSetForLocalMint(entry, baselineAssetIdSets);
  if (!baselineIds) return null;
  for (const id of currentBoxIds) {
    if (baselineIds.has(id) || usedIds?.has(id)) continue;
    addToSetMap(usedBoxIdsByDrop, entry.dropId, id);
    return id;
  }
  return null;
}

export function localMintedBoxExpiresAt(entry: LocalMintedBox): number | null {
  if (!isCardNft2LocalMintedBox(entry)) return null;
  if (entry.unresolvedMatchedAt != null) {
    return entry.unresolvedMatchedAt + CARD_NFT_2_UNRESOLVED_LOCAL_MINT_GRACE_MS;
  }
  if (entry.match.kind === 'count') return null;
  return entry.createdAt + CARD_NFT_2_LOCAL_MINT_MAX_PENDING_MS;
}

function isPastLocalMintedBoxExpiry(entry: LocalMintedBox, now: number): boolean {
  const expiresAt = localMintedBoxExpiresAt(entry);
  return expiresAt != null && expiresAt <= now;
}

export function pruneExpiredLocalMintedBoxes(entries: LocalMintedBox[], now: number): LocalMintedBox[] {
  const next = entries.filter((entry) => !isPastLocalMintedBoxExpiry(entry, now));
  return next.length === entries.length ? entries : next;
}

type BoxIdSetsByDrop = Map<string, Set<string>>;

export type CurrentBoxIdIndexes = {
  allByDrop: BoxIdSetsByDrop;
  resolvedByDrop: BoxIdSetsByDrop;
  unresolvedByDrop: BoxIdSetsByDrop;
};

export function buildCurrentBoxIdIndexes(items: readonly InventoryItem[]): CurrentBoxIdIndexes {
  const allByDrop: BoxIdSetsByDrop = new Map();
  const resolvedByDrop: BoxIdSetsByDrop = new Map();
  const unresolvedByDrop: BoxIdSetsByDrop = new Map();

  items.forEach((item) => {
    if (item.kind !== 'box') return;
    const dropId = normalizeDropId(item.dropId);
    if (!dropId) return;
    addToSetMap(allByDrop, dropId, item.id);
    if (isUnresolvedCardNft2Box(item)) {
      addToSetMap(unresolvedByDrop, dropId, item.id);
      return;
    }
    addToSetMap(resolvedByDrop, dropId, item.id);
  });

  return { allByDrop, resolvedByDrop, unresolvedByDrop };
}

function newResolvedBoxCountByDrop(
  currentResolvedBoxIdsByDrop: ReadonlyMap<string, ReadonlySet<string>>,
  previousAllBoxIdsByDrop: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
  const out = new Map<string, number>();
  currentResolvedBoxIdsByDrop.forEach((ids, dropId) => {
    const prevIds = previousAllBoxIdsByDrop.get(dropId);
    if (!prevIds) return;
    let newCount = 0;
    ids.forEach((id) => {
      if (!prevIds.has(id)) newCount += 1;
    });
    if (newCount > 0) out.set(dropId, newCount);
  });
  return out;
}

export function reconcileLocalMintedBoxes(
  prev: LocalMintedBox[],
  currentBoxIds: CurrentBoxIdIndexes,
  previousAllBoxIdsByDrop: ReadonlyMap<string, ReadonlySet<string>>,
  now: number,
): LocalMintedBox[] {
  if (!prev.length) return prev;

  const next = [...prev];
  let changed = false;
  const removeIndexes = new Set<number>();
  const remainingIndexesByDrop = new Map<string, number[]>();
  const usedResolvedBoxIdsByDrop = new Map<string, Set<string>>();
  const usedUnresolvedBoxIdsByDrop = new Map<string, Set<string>>();
  const baselineAssetIdSets = new WeakMap<readonly string[], ReadonlySet<string>>();
  const newBoxCountByDrop = newResolvedBoxCountByDrop(currentBoxIds.resolvedByDrop, previousAllBoxIdsByDrop);

  prev.forEach((entry, index) => {
    if (isPastLocalMintedBoxExpiry(entry, now)) {
      removeIndexes.add(index);
      return;
    }

    const isCardNft2LocalMint = isCardNft2LocalMintedBox(entry);
    if (claimCardNft2MatchForLocalMint(entry, currentBoxIds.resolvedByDrop, usedResolvedBoxIdsByDrop, baselineAssetIdSets)) {
      removeIndexes.add(index);
      return;
    }

    if (isCardNft2LocalMint) {
      const unresolvedMatch = claimCardNft2MatchForLocalMint(
        entry,
        currentBoxIds.unresolvedByDrop,
        usedUnresolvedBoxIdsByDrop,
        baselineAssetIdSets,
      );
      if (unresolvedMatch) {
        const unresolvedMatchedAt = entry.unresolvedMatchedAt ?? now;
        if (now - unresolvedMatchedAt >= CARD_NFT_2_UNRESOLVED_LOCAL_MINT_GRACE_MS) {
          removeIndexes.add(index);
          return;
        }
        if (entry.unresolvedMatchedAt !== unresolvedMatchedAt) {
          next[index] = { ...entry, unresolvedMatchedAt };
          changed = true;
        }
        return;
      }
      if (entry.unresolvedMatchedAt != null) {
        const resetEntry: LocalMintedBox = { ...entry };
        delete resetEntry.unresolvedMatchedAt;
        next[index] = resetEntry;
        changed = true;
      }
      if (entry.match.kind !== 'count') return;
    }

    if (entry.match.kind === 'count') {
      const currentCount = currentBoxIds.resolvedByDrop.get(entry.dropId)?.size || 0;
      if (entry.match.expectedInventoryCount != null && currentCount >= entry.match.expectedInventoryCount) {
        removeIndexes.add(index);
        return;
      }
    }

    addToArrayMap(remainingIndexesByDrop, entry.dropId, index);
  });

  remainingIndexesByDrop.forEach((indexes, dropId) => {
    let remainingToRemove = newBoxCountByDrop.get(dropId) || 0;
    if (!remainingToRemove) return;
    indexes
      .sort((leftIdx, rightIdx) => prev[leftIdx].createdAt - prev[rightIdx].createdAt)
      .forEach((index) => {
        if (remainingToRemove <= 0) return;
        removeIndexes.add(index);
        remainingToRemove -= 1;
      });
  });

  if (!removeIndexes.size) return changed ? next : prev;
  return next.filter((_, index) => !removeIndexes.has(index));
}

export function refreshLocalMintedBoxCountExpectations(
  entries: LocalMintedBox[],
  resolvedBoxIdsByDrop: ReadonlyMap<string, ReadonlySet<string>>,
): LocalMintedBox[] {
  if (!entries.length) return entries;

  const indexesByDrop = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    if (entry.match.kind === 'count') addToArrayMap(indexesByDrop, entry.dropId, index);
  });
  if (!indexesByDrop.size) return entries;

  let next: LocalMintedBox[] | null = null;
  indexesByDrop.forEach((indexes, dropId) => {
    const knownCount = resolvedBoxIdsByDrop.get(dropId)?.size || 0;
    indexes
      .sort((leftIdx, rightIdx) => entries[leftIdx].createdAt - entries[rightIdx].createdAt)
      .forEach((index, offset) => {
        const entry = entries[index];
        if (entry.match.kind !== 'count') return;
        const expectedInventoryCount = knownCount + offset + 1;
        if (entry.match.expectedInventoryCount === expectedInventoryCount) return;
        if (!next) next = [...entries];
        next[index] = {
          ...entry,
          match: {
            ...entry.match,
            expectedInventoryCount,
          },
        };
      });
  });

  return next ?? entries;
}
