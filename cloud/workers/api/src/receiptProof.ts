import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { uniqueAssetGroupingCollectionMint } from '../../../../shared/dasAssetCollections.js';
import { dasAssetMetadataUri, type DasAsset } from '../../../../shared/dasAsset.js';
import { isRecord } from './dataAccess.js';
import {
  boxIdFromMetadataUri,
  dudeIdFromMetadataUri,
  metadataBaseFromMetadataUri,
  metadataBaseMatchesDrop,
  metadataKindFromUri,
  pooledReceiptBoxIdFromMetadataUri,
} from '../../../../shared/dropMetadataUri.js';

export type ReceiptMetadataReference = {
  kind: 'box' | 'figure';
  id: number;
};

export type ReceiptDropIdentity = {
  collectionMintStr: string;
  metadataBase: string;
  metadataBaseAliases?: string[];
  receiptsMerkleTree: PublicKey;
  receiptPoolId?: string;
  receiptMaxId: number;
};

export type ReceiptProofTreeDimensions = {
  maxDepth?: number;
  canopyDepth?: number;
};

export type DecodedReceiptProof = {
  merkleTree: PublicKey;
  root: Buffer;
  dataHash: Buffer;
  creatorHash: Buffer;
  assetDataHash: Buffer | null;
  flags: number | null;
  nonce: number;
  index: number;
  proofAccounts: PublicKey[];
  leafOwner: PublicKey;
  leafDelegate: PublicKey;
};

type ReceiptProofDecodeErrorReason =
  | 'missing-proof'
  | 'tree-mismatch'
  | 'invalid-nonce'
  | 'index-out-of-range'
  | 'invalid-proof-path'
  | 'proof-normalization'
  | 'owner-mismatch'
  | 'invalid-owner'
  | 'invalid-flags'
  | 'invalid-hash'
  | 'invalid-hash-length';

export class ReceiptProofDecodeError extends Error {
  constructor(
    readonly reason: ReceiptProofDecodeErrorReason,
    message: string,
    readonly details?: { receiptTree: string; receiptsTree: string },
  ) {
    super(message);
    this.name = 'ReceiptProofDecodeError';
  }
}

function bytes32(value: string, label: string): Buffer {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new ReceiptProofDecodeError('invalid-hash', `Invalid ${label}`);
  }
  if (decoded.length !== 32) throw new ReceiptProofDecodeError('invalid-hash-length', `Invalid ${label} length`);
  return Buffer.from(decoded);
}

export function decodeReceiptProof(args: {
  asset: DasAsset;
  proof: Record<string, unknown>;
  expectedTree: PublicKey;
  expectedOwner: string;
  dimensions?: ReceiptProofTreeDimensions;
  maxProofAccounts?: number;
}): DecodedReceiptProof {
  const { asset, proof, expectedTree, expectedOwner } = args;
  const compression = isRecord(asset.compression) ? asset.compression : {};
  const merkleTree = assetProofTreePublicKey(proof);
  const root = typeof proof.root === 'string' ? proof.root : '';
  if (!merkleTree || !root) {
    throw new ReceiptProofDecodeError('missing-proof', 'Unable to fetch receipt proof for transfer');
  }
  if (!merkleTree.equals(expectedTree)) {
    throw new ReceiptProofDecodeError('tree-mismatch', 'Receipt does not belong to the configured receipts tree', {
      receiptTree: merkleTree.toBase58(),
      receiptsTree: expectedTree.toBase58(),
    });
  }
  const nonce = Number(compression.leaf_id ?? compression.leafId);
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new ReceiptProofDecodeError('invalid-nonce', 'Unable to parse receipt leaf id');
  }
  if (nonce > 0xffff_ffff) {
    throw new ReceiptProofDecodeError('index-out-of-range', 'Receipt leaf index out of range');
  }
  if (args.maxProofAccounts !== undefined && (!Array.isArray(proof.proof) || proof.proof.length > args.maxProofAccounts)) {
    throw new ReceiptProofDecodeError('invalid-proof-path', 'Receipt proof path is invalid');
  }
  let proofAccounts: PublicKey[];
  try {
    proofAccounts = normalizedAssetProofAccounts(proof, args.dimensions);
  } catch (error) {
    throw new ReceiptProofDecodeError(
      'proof-normalization',
      error instanceof Error ? error.message : 'Unable to parse receipt proof path',
    );
  }
  const indexedOwner = isRecord(asset.ownership) && typeof asset.ownership.owner === 'string'
    ? asset.ownership.owner
    : '';
  if (indexedOwner !== expectedOwner) {
    throw new ReceiptProofDecodeError('owner-mismatch', 'Receipt proof owner does not match the expected wallet');
  }
  let leafOwner: PublicKey;
  let leafDelegate: PublicKey;
  try {
    leafOwner = new PublicKey(indexedOwner);
    leafDelegate = new PublicKey(
      isRecord(asset.ownership) && typeof asset.ownership.delegate === 'string'
        ? asset.ownership.delegate
        : indexedOwner,
    );
  } catch {
    throw new ReceiptProofDecodeError('invalid-owner', 'Receipt proof owner is invalid');
  }
  const flags = compression.flags == null ? null : Number(compression.flags);
  if (flags != null && (!Number.isInteger(flags) || flags < 0 || flags > 0xff)) {
    throw new ReceiptProofDecodeError('invalid-flags', 'Receipt proof flags are invalid');
  }
  return {
    merkleTree,
    root: bytes32(root, 'assetProof.root'),
    dataHash: bytes32(String(compression.data_hash ?? compression.dataHash ?? ''), 'asset.compression.data_hash'),
    creatorHash: bytes32(String(compression.creator_hash ?? compression.creatorHash ?? ''), 'asset.compression.creator_hash'),
    assetDataHash: compression.asset_data_hash || compression.assetDataHash
      ? bytes32(String(compression.asset_data_hash ?? compression.assetDataHash), 'asset.compression.asset_data_hash')
      : null,
    flags,
    nonce,
    index: nonce,
    proofAccounts,
    leafOwner,
    leafDelegate,
  };
}

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
    'collectionMintStr' | 'metadataBase' | 'metadataBaseAliases' | 'receiptPoolId' | 'receiptMaxId'
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
      !metadataBaseMatchesDrop(
        assetMetadataBase,
        drop.metadataBase,
        drop.metadataBaseAliases,
      )
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
