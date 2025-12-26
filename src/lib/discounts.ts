import discountMerkle from '../config/discountMerkle.json';

type DiscountMerkleJson = {
  root: string;
  proofs: Record<string, string[]>;
};

const { root, proofs } = discountMerkle as DiscountMerkleJson;

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

export const DISCOUNT_MERKLE_ROOT_HEX = root;

export function isDiscountListed(address: string): boolean {
  return Boolean(proofs[address]);
}

export function getDiscountProof(address: string): Uint8Array[] | null {
  const proof = proofs[address];
  if (!proof) return null;
  return proof.map(hexToBytes);
}
