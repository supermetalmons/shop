export type DiscountMerkleDatasetReference = {
  dropFamily: string;
  rootHex: string;
  source?: string;
};

export type DiscountMerkleDatasetIdentity = {
  dropFamily: string;
  rootHex: string;
  fileName: string;
  relativePath: string;
};

export type DiscountMerkleDatasetRemovalPlan = DiscountMerkleDatasetIdentity & {
  deleteCanonicalFile: boolean;
  remainingRootReferences: number;
};

const CANONICAL_DROP_FAMILY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const CANONICAL_MERKLE_ROOT_PATTERN = /^[0-9a-f]{64}$/;
const DISCOUNT_MERKLE_DATASET_DIRECTORY = 'src/drops/discountMerkles';

function referenceLabel(reference: DiscountMerkleDatasetReference, fallback: string): string {
  return reference.source ? `${fallback} (${reference.source})` : fallback;
}

export function requireDiscountMerkleDatasetIdentity(
  reference: DiscountMerkleDatasetReference,
  label = 'discount Merkle dataset reference',
): DiscountMerkleDatasetIdentity {
  const dropFamily = String(reference.dropFamily ?? '');
  const rootHex = String(reference.rootHex ?? '');
  if (!CANONICAL_DROP_FAMILY_PATTERN.test(dropFamily)) {
    throw new Error(
      `Invalid ${label} drop family: ${JSON.stringify(dropFamily)}. Expected a canonical lowercase family name.`,
    );
  }
  if (!CANONICAL_MERKLE_ROOT_PATTERN.test(rootHex)) {
    throw new Error(
      `Invalid ${label} Merkle root: ${JSON.stringify(rootHex)}. Expected exactly 64 lowercase hexadecimal characters.`,
    );
  }
  const fileName = `${dropFamily}.json`;
  return {
    dropFamily,
    rootHex,
    fileName,
    relativePath: `${DISCOUNT_MERKLE_DATASET_DIRECTORY}/${fileName}`,
  };
}

export function validateDiscountMerkleFamilyRootInvariant(
  references: readonly DiscountMerkleDatasetReference[],
): DiscountMerkleDatasetIdentity[] {
  const rootByFamily = new Map<string, { rootHex: string; label: string }>();
  const familyByRoot = new Map<string, { dropFamily: string; label: string }>();
  const identities = new Map<string, DiscountMerkleDatasetIdentity>();

  references.forEach((reference, index) => {
    const label = referenceLabel(reference, `discount Merkle reference ${index + 1}`);
    const identity = requireDiscountMerkleDatasetIdentity(reference, label);
    const existingRoot = rootByFamily.get(identity.dropFamily);
    if (existingRoot && existingRoot.rootHex !== identity.rootHex) {
      throw new Error(
        `Discount Merkle family ${identity.dropFamily} maps to conflicting roots: ` +
          `${existingRoot.rootHex} (${existingRoot.label}) and ${identity.rootHex} (${label}).`,
      );
    }
    const existingFamily = familyByRoot.get(identity.rootHex);
    if (existingFamily && existingFamily.dropFamily !== identity.dropFamily) {
      throw new Error(
        `Discount Merkle root ${identity.rootHex} maps to conflicting families: ` +
          `${existingFamily.dropFamily} (${existingFamily.label}) and ${identity.dropFamily} (${label}).`,
      );
    }
    rootByFamily.set(identity.dropFamily, { rootHex: identity.rootHex, label });
    familyByRoot.set(identity.rootHex, { dropFamily: identity.dropFamily, label });
    identities.set(`${identity.dropFamily}:${identity.rootHex}`, identity);
  });

  return Array.from(identities.values()).sort((left, right) => left.dropFamily.localeCompare(right.dropFamily));
}

export function planCanonicalDiscountMerkleDatasetRemoval(args: {
  removed?: DiscountMerkleDatasetReference;
  remaining: readonly DiscountMerkleDatasetReference[];
}): DiscountMerkleDatasetRemovalPlan | null {
  if (!args.removed) return null;
  const removedIdentity = requireDiscountMerkleDatasetIdentity(
    args.removed,
    'removed canonical registry reference',
  );
  validateDiscountMerkleFamilyRootInvariant([
    args.removed,
    ...args.remaining,
  ]);
  const remainingRootReferences = args.remaining.filter(
    (reference) => reference.rootHex === removedIdentity.rootHex,
  ).length;
  return {
    ...removedIdentity,
    deleteCanonicalFile: remainingRootReferences === 0,
    remainingRootReferences,
  };
}
