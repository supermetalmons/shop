import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils';
import { encodeAbi } from './abi.ts';

export function verifyEthereumDiscountProof(address: string, proof: readonly string[], root: string): boolean {
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(root) || !Array.isArray(proof) || proof.length > 32 ||
      proof.some(value => typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))) return false;
    let hash = keccak_256(keccak_256(hexToBytes(encodeAbi(['address'], [address]).slice(2))));
    for (const sibling of proof) {
      const other = hexToBytes(sibling.slice(2));
      hash = keccak_256(bytesToHex(hash) < bytesToHex(other) ? concatBytes(hash, other) : concatBytes(other, hash));
    }
    return `0x${bytesToHex(hash)}` === root.toLowerCase();
  } catch { return false; }
}
