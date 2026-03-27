type DiscountMerkleJson = {
  root: string;
  proofs: Record<string, string[]>;
};

const discountMerkleModules = import.meta.glob<{ default: DiscountMerkleJson }>(
  '../drops/discountMerkles/*.json',
  { eager: true },
);

const discountMerkleByDropId: Record<string, DiscountMerkleJson> = {};
for (const [modulePath, moduleData] of Object.entries(discountMerkleModules)) {
  const match = modulePath.match(/\/([^/]+)\.json$/);
  if (!match) continue;
  discountMerkleByDropId[normalizeDropId(match[1])] = moduleData.default;
}

const warnedDropIds = new Set<string>();

function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

function warnDiscountMerkleIssue(dropId: string, message: string): void {
  const normalizedDropId = normalizeDropId(dropId);
  if (warnedDropIds.has(normalizedDropId)) return;
  warnedDropIds.add(normalizedDropId);
  console.warn(`[mons] ${message}`);
}

function resolveDiscountMerkle(dropId: string): DiscountMerkleJson | null {
  const normalizedDropId = normalizeDropId(dropId);
  if (!normalizedDropId) {
    warnDiscountMerkleIssue(dropId, 'Discount merkle lookup skipped: dropId is empty');
    return null;
  }
  const merkle = discountMerkleByDropId[normalizedDropId];
  if (!merkle) {
    warnDiscountMerkleIssue(dropId, `Missing discount merkle data for dropId: ${normalizedDropId}`);
    return null;
  }
  return merkle;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (!clean || clean.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

export function getDiscountMerkleRootHex(dropId: string): string | null {
  return resolveDiscountMerkle(dropId)?.root ?? null;
}

export function isDiscountListed(dropId: string, address: string): boolean {
  const proofs = resolveDiscountMerkle(dropId)?.proofs;
  if (!proofs) return false;
  return Boolean(proofs[address]);
}

export function getDiscountProof(dropId: string, address: string): Uint8Array[] | null {
  const proofs = resolveDiscountMerkle(dropId)?.proofs;
  if (!proofs) return null;
  const proof = proofs[address];
  if (!proof) return null;
  try {
    return proof.map(hexToBytes);
  } catch (err) {
    warnDiscountMerkleIssue(
      dropId,
      `Invalid discount proof encoding for address ${address}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
