import { PublicKey } from '@solana/web3.js';
import { uniqueAssetGroupingCollectionMint } from './shared/dasAssetCollections.js';
import { dasAssetMetadataUri, type DasAsset } from './shared/dasAsset.js';
import {
  boxIdFromMetadataUri,
  canonicalMetadataBase,
  dudeIdFromMetadataUri,
  metadataBaseFromMetadataUri,
  metadataKindFromUri,
  pooledReceiptBoxIdFromMetadataUri,
} from './shared/dropMetadataUri.js';

export type ReceiptMetadataReference = {
  kind: 'box' | 'figure';
  id: number;
};

export type ReceiptDropIdentity = {
  collectionMintStr: string;
  metadataBase: string;
  receiptsMerkleTree: PublicKey;
  receiptPoolId?: string;
  receiptMaxId: number;
};

export type ReceiptProofTreeDimensions = {
  maxDepth?: number;
  canopyDepth?: number;
};

export function assetProofTreePublicKey(proof: unknown): PublicKey | null {
  if (!proof || typeof proof !== 'object') return null;
  const proofRecord = proof as { tree_id?: unknown; treeId?: unknown };
  const treeId = String(proofRecord.tree_id ?? proofRecord.treeId ?? '').trim();
  if (!treeId) return null;

  try {
    return new PublicKey(treeId);
  } catch {
    return null;
  }
}

export function assetProofMatchesTree(proof: unknown, expectedTree: PublicKey): boolean {
  const tree = assetProofTreePublicKey(proof);
  return Boolean(tree && tree.equals(expectedTree));
}

export function receiptMetadataReference(asset: DasAsset | null | undefined): ReceiptMetadataReference | null {
  const metadataUri = dasAssetMetadataUri(asset);
  if (metadataKindFromUri(metadataUri) !== 'certificate') return null;

  const boxId = boxIdFromMetadataUri(metadataUri);
  if (boxId && /^\d+$/.test(boxId)) {
    const id = Number(boxId);
    if (
      Number.isSafeInteger(id) &&
      id > 0 &&
      String(id) === boxId
    ) {
      return { kind: 'box', id };
    }
  }

  const dudeId = dudeIdFromMetadataUri(metadataUri);
  if (Number.isSafeInteger(dudeId) && Number(dudeId) > 0) {
    return { kind: 'figure', id: Number(dudeId) };
  }
  return null;
}

export function assetMatchesReceiptMetadataIdentity(
  asset: DasAsset | null | undefined,
  drop: Pick<
    ReceiptDropIdentity,
    'collectionMintStr' | 'metadataBase' | 'receiptPoolId' | 'receiptMaxId'
  >,
  expected?: Partial<ReceiptMetadataReference>,
): boolean {
  if (uniqueAssetGroupingCollectionMint(asset) !== drop.collectionMintStr) return false;

  const metadataUri = dasAssetMetadataUri(asset);
  let reference: ReceiptMetadataReference | null;
  if (drop.receiptPoolId) {
    const id = pooledReceiptBoxIdFromMetadataUri(
      metadataUri,
      drop.metadataBase,
    );
    reference =
      id == null || id > drop.receiptMaxId ? null : { kind: 'box', id };
  } else {
    const assetMetadataBase = metadataBaseFromMetadataUri(metadataUri);
    if (
      !assetMetadataBase ||
      assetMetadataBase !== canonicalMetadataBase(drop.metadataBase)
    ) {
      return false;
    }
    reference = receiptMetadataReference(asset);
  }
  if (!reference) return false;
  if (expected?.kind && reference.kind !== expected.kind) return false;
  if (expected?.id != null && reference.id !== Number(expected.id)) return false;
  return true;
}

export function assetMatchesReceiptDropIdentity(
  asset: DasAsset | null | undefined,
  proof: unknown,
  drop: ReceiptDropIdentity,
  expected?: Partial<ReceiptMetadataReference>,
): boolean {
  return (
    assetMatchesReceiptMetadataIdentity(asset, drop, expected) &&
    assetProofMatchesTree(proof, drop.receiptsMerkleTree)
  );
}

export function normalizedAssetProofAccounts(
  proof: unknown,
  dimensions: ReceiptProofTreeDimensions = {},
): PublicKey[] {
  const proofRecord = proof && typeof proof === 'object'
    ? proof as { proof?: unknown }
    : {};
  if (!Array.isArray(proofRecord.proof)) throw new Error('Asset proof path is missing');

  const proofAccounts = proofRecord.proof.map((value, index) => {
    try {
      return new PublicKey(String(value || ''));
    } catch {
      throw new Error(`Asset proof path contains an invalid public key at index ${index}`);
    }
  });

  if (dimensions.maxDepth == null) return proofAccounts;
  const maxDepth = Number(dimensions.maxDepth);
  const canopyDepth = Number(dimensions.canopyDepth ?? 0);
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error('Receipt tree max depth is invalid');
  }
  if (!Number.isInteger(canopyDepth) || canopyDepth < 0 || canopyDepth >= maxDepth) {
    throw new Error('Receipt tree canopy depth is invalid');
  }

  const trimmedDepth = maxDepth - canopyDepth;
  if (proofAccounts.length === trimmedDepth) return proofAccounts;
  if (proofAccounts.length === maxDepth) return proofAccounts.slice(0, trimmedDepth);
  throw new Error(
    `Asset proof path has ${proofAccounts.length} accounts; expected ${trimmedDepth} trimmed or ${maxDepth} full`,
  );
}
