import bs58 from 'bs58';
import {
  dasAssetBoxId,
  dasAssetDudeId,
  dasAssetKind,
  dasAssetLooksBurntOrClosed,
  dasAssetMetadataName,
  dasAssetMetadataUri,
  type DasAsset,
} from './dasAsset.js';
import { uniqueAssetGroupingCollectionMint } from './dasAssetCollections.js';
import { DEPLOYMENT_DROPS, type DeploymentRegistryDrop } from './deploymentRegistry.js';
import {
  canonicalMetadataBase,
  metadataBaseFromMetadataUri,
  metadataBaseMatchesDrop,
  pooledReceiptBoxIdFromMetadataUri,
} from './dropMetadataUri.js';
import {
  decodePendingOpenData,
  normalizePendingOpenDudeCount,
} from './pendingOpenCodec.js';
import type { SolanaCluster } from './deploymentCore.js';
import {
  SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES,
  SHOP_INVENTORY_NAME_MAX_UTF8_BYTES,
  SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES,
  isShopApiStringWithinUtf8Limit,
  truncateShopApiStringToUtf8Bytes,
  type ShopInventoryItem,
  type ShopPendingOpenBox,
} from './shopApi.js';

export type ShopDropRuntime = Pick<
  DeploymentRegistryDrop,
  | 'dropId'
  | 'solanaCluster'
  | 'collectionMint'
  | 'receiptsMerkleTree'
  | 'metadataBase'
  | 'metadataBaseAliases'
  | 'receiptPoolId'
  | 'maxSupply'
  | 'receiptMaxId'
  | 'boxMinterProgramId'
  | 'boxMinterConfigPda'
  | 'itemsPerBox'
>;

export type InventoryDropResolutionCandidate = Pick<
  ShopDropRuntime,
  | 'dropId'
  | 'solanaCluster'
  | 'collectionMint'
  | 'receiptsMerkleTree'
  | 'metadataBase'
  | 'metadataBaseAliases'
  | 'receiptPoolId'
  | 'maxSupply'
  | 'receiptMaxId'
>;

export type PendingOpenProgramScope = Pick<ShopDropRuntime, 'solanaCluster' | 'boxMinterProgramId'> & {
  drops: ShopDropRuntime[];
};

export type PendingOpenRecordCandidate = {
  solanaCluster: SolanaCluster;
  pendingPda: string;
  boxAssetId: string;
  dudeAssetIds: string[];
  createdSlot?: number;
  configPda?: string;
  candidateDrops: ShopDropRuntime[];
};

const NAME_POLICY = { metadataNameMode: 'string-only' } as const;
const BURN_POLICY = {
  missingAssetResult: false,
  nonBooleanFlagIsBurnt: true,
  includeAlternateFlagNames: false,
  includeOwnershipState: false,
} as const;

const SHOP_DROP_RUNTIMES: ShopDropRuntime[] = Object.values(DEPLOYMENT_DROPS)
  .map((drop) => ({
    dropId: drop.dropId,
    solanaCluster: drop.solanaCluster,
    collectionMint: drop.collectionMint,
    receiptsMerkleTree: drop.receiptsMerkleTree,
    metadataBase: drop.metadataBase,
    metadataBaseAliases: drop.metadataBaseAliases,
    receiptPoolId: drop.receiptPoolId,
    maxSupply: drop.maxSupply,
    receiptMaxId: drop.receiptMaxId,
    boxMinterProgramId: drop.boxMinterProgramId,
    boxMinterConfigPda: typeof drop.boxMinterConfigPda === 'string' ? drop.boxMinterConfigPda.trim() || undefined : undefined,
    itemsPerBox: drop.itemsPerBox,
  }))
  .sort((left, right) => left.dropId.localeCompare(right.dropId));

const DROPS_BY_ID = new Map(SHOP_DROP_RUNTIMES.map((drop) => [drop.dropId, drop]));
const DROPS_BY_COLLECTION_SCOPE = new Map<string, ShopDropRuntime[]>();
const DROPS_BY_PROGRAM_SCOPE = new Map<string, ShopDropRuntime[]>();
const DROPS_BY_CONFIG_PDA = new Map<string, ShopDropRuntime>();

function appendIndexedValue(index: Map<string, ShopDropRuntime[]>, key: string, drop: ShopDropRuntime): void {
  const existing = index.get(key);
  if (existing) existing.push(drop);
  else index.set(key, [drop]);
}

function shopCollectionScopeKey(drop: Pick<ShopDropRuntime, 'solanaCluster' | 'collectionMint'>): string {
  return `${drop.solanaCluster}:${drop.collectionMint}`;
}

function shopProgramScopeKey(drop: Pick<ShopDropRuntime, 'solanaCluster' | 'boxMinterProgramId'>): string {
  return `${drop.solanaCluster}:${drop.boxMinterProgramId}`;
}

function shopConfigPdaKey(cluster: SolanaCluster, configPda: string): string {
  return `${cluster}:${configPda}`;
}

for (const drop of SHOP_DROP_RUNTIMES) {
  appendIndexedValue(DROPS_BY_COLLECTION_SCOPE, shopCollectionScopeKey(drop), drop);
  appendIndexedValue(DROPS_BY_PROGRAM_SCOPE, shopProgramScopeKey(drop), drop);
  if (drop.boxMinterConfigPda) DROPS_BY_CONFIG_PDA.set(shopConfigPdaKey(drop.solanaCluster, drop.boxMinterConfigPda), drop);
}

function listShopDropRuntimes(includeDevnet = false): ShopDropRuntime[] {
  return includeDevnet ? [...SHOP_DROP_RUNTIMES] : SHOP_DROP_RUNTIMES.filter((drop) => drop.solanaCluster !== 'devnet');
}

export function listUniqueInventoryCollectionScopes<T extends Pick<InventoryDropResolutionCandidate, 'solanaCluster' | 'collectionMint'>>(
  candidates: readonly T[],
): T[] {
  const scopes: T[] = [];
  const seen = new Set<string>();
  for (const drop of candidates) {
    const key = shopCollectionScopeKey(drop);
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push(drop);
  }
  return scopes;
}

export function listShopCollectionQueryRuntimes(includeDevnet = false): ShopDropRuntime[] {
  return listUniqueInventoryCollectionScopes(listShopDropRuntimes(includeDevnet));
}

export function listShopPendingOpenProgramScopes(includeDevnet = false): PendingOpenProgramScope[] {
  return Array.from(DROPS_BY_PROGRAM_SCOPE.values())
    .filter((drops) => includeDevnet || drops[0]?.solanaCluster !== 'devnet')
    .map((drops) => ({
      solanaCluster: drops[0].solanaCluster,
      boxMinterProgramId: drops[0].boxMinterProgramId,
      drops: [...drops],
    }));
}

export function shopDropById(dropId: string): ShopDropRuntime | undefined {
  return DROPS_BY_ID.get(dropId);
}

function collectionDropCandidates(collectionMint: string, cluster?: SolanaCluster): ShopDropRuntime[] {
  if (cluster) return DROPS_BY_COLLECTION_SCOPE.get(shopCollectionScopeKey({ solanaCluster: cluster, collectionMint })) || [];
  return SHOP_DROP_RUNTIMES.filter((drop) => drop.collectionMint === collectionMint);
}

export function resolveInventoryAssetDropId(
  asset: DasAsset,
  candidates: readonly InventoryDropResolutionCandidate[],
  cluster?: SolanaCluster,
): string | null {
  const collectionMint = uniqueAssetGroupingCollectionMint(asset);
  if (!collectionMint) return null;
  const scopedCandidates = candidates.filter((drop) =>
    drop.collectionMint === collectionMint && (!cluster || drop.solanaCluster === cluster));
  if (!scopedCandidates.length) return null;

  const metadataUri = dasAssetMetadataUri(asset);
  const assetMetadataBase = metadataBaseFromMetadataUri(metadataUri);
  const canonicalAssetMetadataBase = assetMetadataBase ? canonicalMetadataBase(assetMetadataBase) : '';
  const assetCompressionTree = typeof asset?.compression?.tree === 'string' ? asset.compression.tree : undefined;
  const metadataMatches = scopedCandidates.filter((drop) => {
    if (drop.receiptPoolId) {
      if (assetCompressionTree !== drop.receiptsMerkleTree) return false;
      const receiptId = pooledReceiptBoxIdFromMetadataUri(metadataUri, drop.metadataBase);
      return receiptId != null && receiptId <= (drop.receiptMaxId ?? drop.maxSupply);
    }
    return Boolean(canonicalAssetMetadataBase) && metadataBaseMatchesDrop(
      canonicalAssetMetadataBase,
      drop.metadataBase,
      drop.metadataBaseAliases,
    );
  });
  if (metadataMatches.length === 1) return metadataMatches[0].dropId;
  if (scopedCandidates.some((drop) => drop.receiptPoolId)) return null;
  return scopedCandidates.length === 1 ? scopedCandidates[0].dropId : null;
}

function resolveShopAssetDropId(asset: DasAsset, cluster?: SolanaCluster): string | null {
  const collectionMint = uniqueAssetGroupingCollectionMint(asset);
  if (!collectionMint) return null;
  return resolveInventoryAssetDropId(asset, collectionDropCandidates(collectionMint, cluster), cluster);
}

export function transformShopInventoryItem(asset: DasAsset, cluster?: SolanaCluster): ShopInventoryItem | null {
  if (dasAssetLooksBurntOrClosed(asset, BURN_POLICY)) return null;
  const kind = dasAssetKind(asset, NAME_POLICY);
  if (!kind) return null;
  const dropId = resolveShopAssetDropId(asset, cluster);
  if (!dropId || typeof asset.id !== 'string' || !asset.id) return null;
  const boxId = dasAssetBoxId(asset, NAME_POLICY);
  let dudeId = dasAssetDudeId(asset);
  if (dudeId == null) {
    const match = dasAssetMetadataName(asset)?.match(/(?:figure|dude)\s*#?\s*(\d+)/i);
    const parsed = Number(match?.[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0) dudeId = parsed;
  }
  const rawImageCandidate = asset?.content?.links?.image ||
    asset?.content?.metadata?.image ||
    asset?.content?.files?.[0]?.uri ||
    asset?.content?.files?.[0]?.cdn_uri;
  const rawImage = rawImageCandidate && isShopApiStringWithinUtf8Limit(
    rawImageCandidate,
    SHOP_INVENTORY_RAW_IMAGE_MAX_UTF8_BYTES,
  ) ? rawImageCandidate : undefined;
  const retainedBoxId = boxId && isShopApiStringWithinUtf8Limit(
    boxId,
    SHOP_INVENTORY_BOX_ID_MAX_UTF8_BYTES,
  ) ? boxId : undefined;
  const name = truncateShopApiStringToUtf8Bytes(
    dasAssetMetadataName(asset) || asset.id,
    SHOP_INVENTORY_NAME_MAX_UTF8_BYTES,
  );
  return {
    id: asset.id,
    dropId,
    name,
    kind,
    ...(rawImage ? { rawImage } : {}),
    ...(retainedBoxId ? { boxId: retainedBoxId } : {}),
    ...(dudeId != null ? { dudeId } : {}),
  };
}

function pendingOpenRecordCandidateItemCounts(scope: Pick<PendingOpenProgramScope, 'drops'>): number[] {
  const counts = new Set<number>();
  for (const drop of scope.drops) {
    const count = normalizePendingOpenDudeCount(drop.itemsPerBox);
    if (count != null) counts.add(count);
  }
  return Array.from(counts).sort((left, right) => left - right);
}

export function decodePendingOpenRecordData(
  data: Uint8Array,
  scope: Pick<PendingOpenProgramScope, 'drops'>,
): { owner: string; boxAssetId: string; dudeAssetIds: string[]; createdSlot?: number; configPda?: string } | null {
  try {
    const decoded = decodePendingOpenData(Uint8Array.from(data), {
      legacyDudeCounts: pendingOpenRecordCandidateItemCounts(scope),
    });
    const createdSlot = decoded.createdSlot <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(decoded.createdSlot) : undefined;
    return {
      owner: bs58.encode(decoded.owner),
      boxAssetId: bs58.encode(decoded.boxAsset),
      dudeAssetIds: decoded.dudeAssets.map((asset) => bs58.encode(asset)),
      ...(createdSlot != null ? { createdSlot } : {}),
      ...(decoded.config ? { configPda: bs58.encode(decoded.config) } : {}),
    };
  } catch {
    return null;
  }
}

export function resolvePendingOpenDropId(entry: PendingOpenRecordCandidate, asset?: DasAsset | null): string | null {
  const dudeCount = normalizePendingOpenDudeCount(entry.dudeAssetIds.length);
  if (dudeCount == null) return null;
  if (entry.configPda) {
    const drop = DROPS_BY_CONFIG_PDA.get(shopConfigPdaKey(entry.solanaCluster, entry.configPda));
    return drop &&
      drop.itemsPerBox === dudeCount &&
      entry.candidateDrops.some((candidate) => candidate.dropId === drop.dropId)
      ? drop.dropId
      : null;
  }
  if (entry.candidateDrops.length === 1) {
    const drop = entry.candidateDrops[0];
    return drop.itemsPerBox === dudeCount ? drop.dropId : null;
  }
  const countMatches = entry.candidateDrops.filter((drop) => drop.itemsPerBox === dudeCount);
  if (countMatches.length === 1) return countMatches[0].dropId;
  if (!asset) return null;
  const dropId = resolveShopAssetDropId(asset, entry.solanaCluster);
  const drop = dropId ? entry.candidateDrops.find((candidate) => candidate.dropId === dropId) : undefined;
  return drop?.itemsPerBox === dudeCount ? dropId : null;
}

export function toShopPendingOpenBox(entry: PendingOpenRecordCandidate, dropId: string): ShopPendingOpenBox {
  return {
    dropId,
    pendingPda: entry.pendingPda,
    boxAssetId: entry.boxAssetId,
    dudeAssetIds: entry.dudeAssetIds,
    ...(entry.createdSlot != null ? { createdSlot: entry.createdSlot } : {}),
  };
}
