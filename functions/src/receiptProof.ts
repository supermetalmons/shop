import { PublicKey } from '@solana/web3.js';

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
