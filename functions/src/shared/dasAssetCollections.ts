type DasAssetCollectionGroup = {
  group_key?: unknown;
  group_value?: unknown;
};

type DasAssetCollectionSource = {
  grouping?: unknown;
};

export const HELIUS_COLLECTION_GROUPING_OPTIONS = {
  showUnverifiedCollections: true,
} as const;

function collectionMintFromGroup(rawGroup: unknown): string | null {
  if (!rawGroup || typeof rawGroup !== 'object') return null;
  const group = rawGroup as DasAssetCollectionGroup;
  if (group.group_key !== 'collection' || typeof group.group_value !== 'string' || !group.group_value) return null;
  return group.group_value;
}

export function assetGroupingCollectionMints(asset: DasAssetCollectionSource | null | undefined): string[] {
  const out = new Set<string>();
  const grouped = asset?.grouping;
  if (!Array.isArray(grouped)) return [];

  for (const rawGroup of grouped) {
    const collectionMint = collectionMintFromGroup(rawGroup);
    if (collectionMint) out.add(collectionMint);
  }

  return Array.from(out);
}

export function uniqueAssetGroupingCollectionMint(asset: DasAssetCollectionSource | null | undefined): string | null {
  const collectionMints = assetGroupingCollectionMints(asset);
  return collectionMints.length === 1 ? collectionMints[0] : null;
}

export function assetGroupingAllowsTreeVerifiedCollectionMatch(
  asset: DasAssetCollectionSource | null | undefined,
  expectedCollectionMint: string,
): boolean {
  const expected = String(expectedCollectionMint || '').trim();
  if (!expected) return false;

  const collectionMints = assetGroupingCollectionMints(asset);
  if (!collectionMints.length) return true;
  return collectionMints.includes(expected);
}
