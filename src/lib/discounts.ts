type DiscountMerkleJson = {
  root: string;
  proofs: Record<string, string[]>;
};

const discountMerkleModules = import.meta.glob<{ default: DiscountMerkleJson }>('../drops/discountMerkles/*.json');

const discountMerkleByDropId = new Map<string, DiscountMerkleJson>();
const discountMerkleLoadersByDropId = new Map<string, () => Promise<{ default: DiscountMerkleJson }>>();
for (const [modulePath, moduleLoader] of Object.entries(discountMerkleModules)) {
  const match = modulePath.match(/\/([^/]+)\.json$/);
  if (!match) continue;
  discountMerkleLoadersByDropId.set(normalizeDropId(match[1]), moduleLoader);
}

const warnedDropIds = new Set<string>();
const loadByDropId = new Map<string, Promise<DiscountMerkleJson | null>>();

function normalizeDropId(dropId: string): string {
  return String(dropId || '').trim().toLowerCase();
}

function warnDiscountMerkleIssue(dropId: string, message: string): void {
  const normalizedDropId = normalizeDropId(dropId);
  if (warnedDropIds.has(normalizedDropId)) return;
  warnedDropIds.add(normalizedDropId);
  console.warn(`[mons] ${message}`);
}

async function resolveDiscountMerkle(dropId: string): Promise<DiscountMerkleJson | null> {
  const normalizedDropId = normalizeDropId(dropId);
  if (!normalizedDropId) {
    warnDiscountMerkleIssue(dropId, 'Discount merkle lookup skipped: dropId is empty');
    return null;
  }
  const cached = discountMerkleByDropId.get(normalizedDropId);
  if (cached) return cached;

  const pending = loadByDropId.get(normalizedDropId);
  if (pending) return pending;

  const loader = discountMerkleLoadersByDropId.get(normalizedDropId);
  if (!loader) {
    warnDiscountMerkleIssue(dropId, `Missing discount merkle data for dropId: ${normalizedDropId}`);
    return null;
  }
  const merklePromise = loader()
    .then((moduleData) => {
      discountMerkleByDropId.set(normalizedDropId, moduleData.default);
      return moduleData.default;
    })
    .catch((err) => {
      warnDiscountMerkleIssue(
        dropId,
        `Failed to load discount merkle data for dropId ${normalizedDropId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    })
    .finally(() => {
      loadByDropId.delete(normalizedDropId);
    });
  loadByDropId.set(normalizedDropId, merklePromise);
  const merkle = await merklePromise;
  if (!merkle) {
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

export async function getDiscountMerkleRootHex(dropId: string): Promise<string | null> {
  return (await resolveDiscountMerkle(dropId))?.root ?? null;
}

export async function isDiscountListed(dropId: string, address: string): Promise<boolean> {
  const proofs = (await resolveDiscountMerkle(dropId))?.proofs;
  if (!proofs) return false;
  return Boolean(proofs[address]);
}

export async function getDiscountProof(dropId: string, address: string): Promise<Uint8Array[] | null> {
  const proofs = (await resolveDiscountMerkle(dropId))?.proofs;
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
